/**
 * The gateway's own OAuth 2.1 authorization server.
 *
 * Agents sign in through a browser approval page; the operator gates each
 * grant with a one-time approval code minted by `ompk-fleet-gateway pair` and
 * chooses Read/Operate over All/Selected machines. Access + rotating refresh
 * tokens follow, hashed at rest.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatScopes, parseScopes, type Scope } from "../auth/scopes";
import type { Store } from "../db/store";
import type { GatewayConfig } from "../types";
import { hash, hmac, newId, newToken, normalizeApprovalCode, pkceMatches } from "./crypto";

const REGISTRATIONS_PER_HOUR = 30;
const FAILURES_PER_REQUEST = 5;
const FAILURES_PER_HOUR = 20;
const AUTH_CODE_TTL_MS = 60_000;
const REFRESH_GRACE_MS = 120_000;

export interface ClientIdentity {
	clientId: string;
	scopes: readonly Scope[];
	grantId: string;
}

function json(res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		...headers,
	});
	res.end(text);
}

function html(res: ServerResponse, body: string, status = 200): void {
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"content-security-policy":
			"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
		"x-frame-options": "DENY",
	});
	res.end(body);
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isHttpsOrLoopback(uri: string): boolean {
	try {
		const url = new URL(uri);
		if (url.protocol === "https:") return true;
		if (url.protocol === "http:") {
			const h = url.hostname.toLowerCase();
			return h === "localhost" || h === "::1" || h.startsWith("127.");
		}
		return false;
	} catch {
		return false;
	}
}

async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > 65_536) throw new Error("body too large");
		chunks.push(buf);
	}
	return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

interface AuthorizeParams {
	clientId: string;
	redirectUri: string;
	state?: string;
	codeChallenge: string;
	scope: string;
	resource?: string;
}

export class OAuthServer {
	#store: Store;
	#config: GatewayConfig;
	#serverKey: string;

	constructor(deps: { store: Store; config: GatewayConfig; serverKey?: string }) {
		this.#store = deps.store;
		this.#config = deps.config;
		// The form-signing key lives only in this process: a rendered approval
		// form cannot outlive the server, which is the property the HMAC buys.
		this.#serverKey = deps.serverKey ?? newToken();
	}

	get resource(): string {
		return `${this.#config.publicUrl}/mcp`;
	}

	metadataJson() {
		return {
			resource: this.resource,
			authorization_servers: [this.#config.publicUrl],
			scopes_supported: ["fleet:read", "fleet:operate"],
			bearer_methods_supported: ["header"],
		};
	}

	asMetadataJson() {
		return {
			issuer: this.#config.publicUrl,
			authorization_endpoint: `${this.#config.publicUrl}/oauth/authorize`,
			token_endpoint: `${this.#config.publicUrl}/oauth/token`,
			registration_endpoint: `${this.#config.publicUrl}/oauth/register`,
			code_challenge_methods_supported: ["S256"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			token_endpoint_auth_methods_supported: ["none"],
			scopes_supported: ["fleet:read", "fleet:operate"],
		};
	}

	/* --------------------------- registration ---------------------------- */

	register(body: Record<string, unknown>): { status: number; json: unknown } {
		const since = Date.now() - 3_600_000;
		if (this.#store.countRegistrations(since) >= REGISTRATIONS_PER_HOUR) {
			return {
				status: 429,
				json: { error: "too_many_requests", error_description: "Registration is limited to 30 clients per hour." },
			};
		}
		const name = typeof body.client_name === "string" ? body.client_name.slice(0, 200) : "agent";
		const redirectUris = Array.isArray(body.redirect_uris)
			? body.redirect_uris.filter((u): u is string => typeof u === "string")
			: [];
		if (redirectUris.length === 0 || redirectUris.length > 5) {
			return {
				status: 400,
				json: { error: "invalid_client_metadata", error_description: "redirect_uris must list 1–5 URIs." },
			};
		}
		for (const uri of redirectUris) {
			if (!isHttpsOrLoopback(uri) || uri.includes("#")) {
				return {
					status: 400,
					json: {
						error: "invalid_redirect_uri",
						error_description: `redirect_uri must be https or loopback http: ${uri}`,
					},
				};
			}
		}
		const id = newId();
		this.#store.insertClient({ id, name, redirectUris, kind: "oauth" });
		return {
			status: 201,
			json: {
				client_id: id,
				client_name: name,
				redirect_uris: redirectUris,
				token_endpoint_auth_method: "none",
			},
		};
	}

	/* ---------------------------- authorize ------------------------------ */

	#signedRequest(params: AuthorizeParams): string {
		return hmac(this.#serverKey, JSON.stringify(params));
	}

	#renderApproval(
		params: AuthorizeParams,
		signature: string,
		error?: string,
		choice?: { level?: string; hosts?: string[]; all?: boolean },
	): string {
		const client = this.#store.getClient(params.clientId);
		const hosts = this.#config.hosts;
		const hostBoxes = hosts
			.map(h => {
				const checked = choice?.hosts?.includes(h.id) ? " checked" : "";
				return `<label class="host"><input type="checkbox" name="host" value="${escapeHtml(h.id)}"${checked}> ${escapeHtml(h.label ?? h.id)} <code>${escapeHtml(h.id)}</code></label>`;
			})
			.join("\n");
		return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Approve ${escapeHtml(client?.name ?? "an agent")} — ompk fleet gateway</title>
<style>
body{font:15px/1.5 system-ui;max-width:32em;margin:4em auto;padding:0 1em;color:#1a1a1a}
h1{font-size:1.4em}code{background:#f0f0f0;padding:.1em .3em;border-radius:3px}
fieldset{border:1px solid #ccc;border-radius:6px;margin:1em 0;padding:.8em 1em}
label{display:block;margin:.4em 0}label.host{font-size:.95em}
button{font-size:1em;padding:.5em 1.4em;border:0;border-radius:6px;background:#16161e;color:#fff;cursor:pointer}
input[type=text]{font:1em/1.4 monospace;padding:.5em;width:14em;border:1px solid #bbb;border-radius:4px;letter-spacing:.1em}
.err{background:#fde8e8;border:1px solid #f3b6b6;border-radius:6px;padding:.6em .8em;margin:1em 0}
.mut{color:#666;font-size:.9em}
</style>
<h1>Approve <strong>${escapeHtml(client?.name ?? params.clientId)}</strong>?</h1>
<p class="mut">It will be returned to <code>${escapeHtml(params.redirectUri)}</code> with a code.</p>
${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/oauth/authorize">
<input type="hidden" name="sig" value="${escapeHtml(signature)}">
${Object.entries(params)
	.map(([k, v]) => (v === undefined ? "" : `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`))
	.join("\n")}
<fieldset><legend>Access level</legend>
<label><input type="radio" name="level" value="read"${choice?.level === "read" || !choice?.level ? " checked" : ""}> <strong>Read</strong> — follow work: status, feeds, results.</label>
<label><input type="radio" name="level" value="operate"${choice?.level === "operate" ? " checked" : ""}> <strong>Operate</strong> — read, plus start, continue and cancel jobs.</label>
</fieldset>
<fieldset><legend>Machines</legend>
<label><input type="radio" name="hosts_mode" value="all"${choice?.all !== false ? " checked" : ""}> <strong>All machines</strong> — including hosts added later.</label>
<label><input type="radio" name="hosts_mode" value="selected"${choice?.all === false ? " checked" : ""}> <strong>Selected machines</strong> — only the ones ticked:</label>
${hostBoxes}
</fieldset>
<fieldset><legend>Approval code</legend>
<p class="mut">One-time code from <code>ompk-fleet-gateway pair</code>.</p>
<input type="text" name="approval_code" autocomplete="off" placeholder="XXXXX-XXXXX" required>
</fieldset>
<button type="submit">Approve</button>
</form>`;
	}

	#parseAuthorize(url: URL): AuthorizeParams | { error: string } {
		const p = url.searchParams;
		const clientId = p.get("client_id");
		const redirectUri = p.get("redirect_uri");
		const codeChallenge = p.get("code_challenge");
		const challengeMethod = p.get("code_challenge_method") ?? "S256";
		if (!clientId || !redirectUri || !codeChallenge)
			return { error: "client_id, redirect_uri and code_challenge are required" };
		if (challengeMethod !== "S256") return { error: "code_challenge_method must be S256" };
		const scope = p.get("scope") ?? "fleet:read";
		const resource = p.get("resource") ?? undefined;
		if (resource && resource !== this.resource) return { error: "resource does not name this gateway" };
		return {
			clientId,
			redirectUri,
			state: p.get("state") ?? undefined,
			codeChallenge,
			scope,
			resource,
		};
	}

	async authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		if (req.method === "GET") {
			const params = this.#parseAuthorize(url);
			if ("error" in params) {
				html(res, `<h1>Cannot approve</h1><p>${escapeHtml(params.error)}</p>`, 400);
				return;
			}
			const client = this.#store.getClient(params.clientId);
			if (!client || client.revokedAt || !client.redirectUris.includes(params.redirectUri)) {
				html(res, `<h1>Cannot approve</h1><p>This client or redirect URI is not registered.</p>`, 400);
				return;
			}
			const sig = this.#signedRequest(params);
			html(res, this.#renderApproval(params, sig));
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405).end();
			return;
		}
		const form = await readBody(req);
		const get = (k: string) => form.get(k) ?? undefined;
		const params: AuthorizeParams = {
			clientId: get("clientId") ?? "",
			redirectUri: get("redirectUri") ?? "",
			state: get("state"),
			codeChallenge: get("codeChallenge") ?? "",
			scope: get("scope") ?? "fleet:read",
			resource: get("resource"),
		};
		const sig = get("sig") ?? "";
		if (sig !== this.#signedRequest(params)) {
			html(res, `<h1>Cannot approve</h1><p>The form was altered or expired. Start the sign-in again.</p>`, 400);
			return;
		}
		const client = this.#store.getClient(params.clientId);
		if (!client || client.revokedAt) {
			html(res, `<h1>Cannot approve</h1><p>This client is not registered.</p>`, 400);
			return;
		}

		// Choice validation runs before the approval code is checked, so a form
		// mistake never burns a code.
		const level = get("level") === "operate" ? "operate" : "read";
		const hostsMode = get("hosts_mode");
		const ticked = form.getAll("host").map(String);
		const hostIds = new Set(this.#config.hosts.map(h => h.id));
		let scopes: Scope[];
		if (hostsMode === "all") {
			if (ticked.length) {
				html(
					res,
					this.#renderApproval(params, sig, "All machines was chosen and hosts were ticked.", { level }),
					400,
				);
				return;
			}
			scopes = level === "operate" ? [{ kind: "fleet", level: "operate" }] : [{ kind: "fleet", level: "read" }];
		} else if (hostsMode === "selected") {
			if (ticked.length === 0) {
				html(
					res,
					this.#renderApproval(params, sig, "Tick at least one machine, or choose All machines.", {
						level,
						all: false,
					}),
					400,
				);
				return;
			}
			if (ticked.some(h => !hostIds.has(h))) {
				html(
					res,
					this.#renderApproval(params, sig, "A selected machine is not configured.", { level, all: false }),
					400,
				);
				return;
			}
			scopes = ticked.flatMap((h): Scope[] =>
				level === "operate"
					? [
							{ kind: "host", host: h, level: "operate" },
							{ kind: "host", host: h, level: "read" },
						]
					: [{ kind: "host", host: h, level: "read" }],
			);
		} else {
			html(res, this.#renderApproval(params, sig, "Choose All machines or Selected machines.", { level }), 400);
			return;
		}

		// Throttling: per-request and global.
		const requestKey = `${params.clientId}:${params.redirectUri}`;
		if (this.#store.approvalFailures(requestKey, Date.now() - 3_600_000) >= FAILURES_PER_REQUEST) {
			html(
				res,
				this.#renderApproval(
					params,
					sig,
					"This sign-in is locked after too many wrong codes. Start the sign-in again.",
				),
				400,
			);
			return;
		}
		if (this.#store.globalApprovalFailures(Date.now() - 3_600_000) >= FAILURES_PER_HOUR) {
			html(
				res,
				this.#renderApproval(
					params,
					sig,
					"Too many wrong codes this hour. Mint a fresh one with `ompk-fleet-gateway pair` — that also lifts this lock.",
				),
				400,
			);
			return;
		}
		const code = normalizeApprovalCode(get("approval_code") ?? "");
		const outcome = code ? this.#store.redeemApprovalCode(hmac(this.#serverKey, `approval:${code}`)) : "unknown";
		if (outcome !== "ok") {
			this.#store.recordApprovalFailure(requestKey);
			const why = !code
				? "That is not a valid code shape."
				: outcome === "used"
					? "That code was already used."
					: outcome === "expired"
						? "That code has expired."
						: "That code is not recognised.";
			html(
				res,
				this.#renderApproval(params, sig, `${why} Mint a fresh one with \`ompk-fleet-gateway pair\`.`, {
					level,
					hosts: ticked,
					all: hostsMode === "all",
				}),
				400,
			);
			return;
		}

		const grantId = newId();
		this.#store.insertGrant({ id: grantId, clientId: params.clientId, scopes: formatScopes(scopes) });
		const codeValue = newToken();
		this.#store.insertAuthCode({
			hash: hash(codeValue),
			clientId: params.clientId,
			grantId,
			redirectUri: params.redirectUri,
			codeChallenge: params.codeChallenge,
			resource: this.resource,
			expiresAt: Date.now() + AUTH_CODE_TTL_MS,
		});
		const redirect = new URL(params.redirectUri);
		redirect.searchParams.set("code", codeValue);
		if (params.state) redirect.searchParams.set("state", params.state);
		// Meta-refresh return page: the browser lands on the client without the
		// gateway ever issuing a redirect to an unvetted URI shape mid-form.
		html(
			res,
			`<!doctype html><meta http-equiv="refresh" content="0;url=${escapeHtml(redirect.toString())}">
<title>Approved</title><p>Approved. <a href="${escapeHtml(redirect.toString())}">Continue back to ${escapeHtml(client.name)}</a>.</p>`,
		);
	}

	/* ------------------------------ token --------------------------------- */

	#issuePair(
		grantId: string,
		clientId: string,
		scopes: string,
		parentRefreshHash?: string,
	): { access_token: string; token_type: string; expires_in: number; refresh_token: string; scope: string } {
		const access = newToken();
		const refresh = newToken();
		const expiresIn = this.#config.tokens.accessTtlSeconds;
		this.#store.insertAccessToken({
			hash: hash(access),
			grantId,
			clientId,
			scopes,
			expiresAt: Date.now() + expiresIn * 1000,
		});
		this.#store.insertRefreshToken({
			hash: hash(refresh),
			grantId,
			parentHash: parentRefreshHash,
			accessHash: hash(access),
			scopes,
		});
		return {
			access_token: access,
			token_type: "bearer",
			expires_in: expiresIn,
			refresh_token: refresh,
			scope: scopes,
		};
	}

	async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const form = await readBody(req);
		const grantType = form.get("grant_type");
		if (grantType === "authorization_code") {
			const code = form.get("code") ?? "";
			const verifier = form.get("code_verifier") ?? "";
			const clientId = form.get("client_id") ?? "";
			const redirectUri = form.get("redirect_uri") ?? "";
			const record = this.#store.getAuthCode(hash(code));
			if (!record || record.usedAt || record.expiresAt < Date.now()) {
				json(res, { error: "invalid_grant" }, 400);
				return;
			}
			if (
				record.clientId !== clientId ||
				record.redirectUri !== redirectUri ||
				!pkceMatches(verifier, record.codeChallenge)
			) {
				json(res, { error: "invalid_grant" }, 400);
				return;
			}
			this.#store.useAuthCode(hash(code));
			const grant = this.#store.getGrant(record.grantId);
			if (!grant) {
				json(res, { error: "invalid_grant" }, 400);
				return;
			}
			json(res, this.#issuePair(grant.id, grant.clientId, grant.scopes));
			return;
		}
		if (grantType === "refresh_token") {
			const presented = form.get("refresh_token") ?? "";
			const record = this.#store.getRefreshToken(hash(presented));
			if (!record) {
				json(res, { error: "invalid_grant" }, 400);
				return;
			}
			const grant = this.#store.getGrant(record.grantId);
			const client = grant ? this.#store.getClient(grant.clientId) : undefined;
			if (!grant || !client || client.revokedAt) {
				json(res, { error: "invalid_grant" }, 400);
				return;
			}
			const now = Date.now();
			if (record.revokedAt) {
				json(res, { error: "invalid_grant" }, 400);
				return;
			}
			if (record.rotatedAt) {
				// A rotated token may be retried inside the grace window (lost
				// response); outside it, replay revokes the whole family.
				if (now - record.rotatedAt <= REFRESH_GRACE_MS) {
					json(
						res,
						this.#issuePair(
							grant.id,
							grant.clientId,
							record.scopes,
							record.grantId && presented ? hash(presented) : undefined,
						),
					);
					return;
				}
				this.#store.revokeTokenFamily(grant.id);
				json(res, { error: "invalid_grant" }, 400);
				return;
			}
			if (now - record.createdAt > this.#config.tokens.refreshIdleTtlDays * 86_400_000) {
				json(res, { error: "invalid_grant" }, 400);
				return;
			}
			const pair = this.#issuePair(grant.id, grant.clientId, record.scopes, hash(presented));
			this.#store.rotateRefreshToken(hash(presented), {
				hash: hash(pair.refresh_token),
				accessHash: hash(pair.access_token),
			});
			json(res, pair);
			return;
		}
		json(res, { error: "unsupported_grant_type" }, 400);
	}

	/* --------------------------- bearer check ----------------------------- */

	/** Verify `Authorization: Bearer <token>`; null when not a usable grant. */
	authenticate(authorization: string | undefined): ClientIdentity | null {
		if (!authorization?.startsWith("Bearer ")) return null;
		const digest = hash(authorization.slice(7));
		const token = this.#store.getAccessToken(digest);
		if (!token || token.revokedAt || token.expiresAt < Date.now()) return null;
		const grant = this.#store.getGrant(token.grantId);
		if (!grant || grant.revokedAt) return null;
		const client = this.#store.getClient(grant.clientId);
		if (!client || client.revokedAt) return null;
		const scopes = parseScopes(token.scopes);
		if (!scopes || scopes.length === 0) return null;
		return { clientId: grant.clientId, scopes, grantId: grant.id };
	}

	/** Mint a standalone bearer client (header-only clients, minted by the CLI). */
	mintBearerToken(input: { name: string; access: "read" | "operate"; hosts: string[] | "all"; ttlSeconds?: number }): {
		clientId: string;
		token: string;
		expiresAt: number | null;
	} {
		const id = newId();
		this.#store.insertClient({ id, name: input.name.slice(0, 200), redirectUris: [], kind: "bearer" });
		const hostIds = new Set(this.#config.hosts.map(h => h.id));
		let scopes: Scope[];
		if (input.hosts === "all") {
			scopes =
				input.access === "operate" ? [{ kind: "fleet", level: "operate" }] : [{ kind: "fleet", level: "read" }];
		} else {
			for (const h of input.hosts) if (!hostIds.has(h)) throw new Error(`host is not configured: ${h}`);
			scopes = input.hosts.flatMap((h): Scope[] =>
				input.access === "operate"
					? [
							{ kind: "host", host: h, level: "operate" },
							{ kind: "host", host: h, level: "read" },
						]
					: [{ kind: "host", host: h, level: "read" }],
			);
		}
		const scopeText = formatScopes(scopes);
		const grantId = newId();
		this.#store.insertGrant({ id: grantId, clientId: id, scopes: scopeText });
		const token = newToken();
		const expiresAt = input.ttlSeconds === undefined ? null : Date.now() + input.ttlSeconds * 1000;
		this.#store.insertAccessToken({
			hash: hash(token),
			grantId,
			clientId: id,
			scopes: scopeText,
			expiresAt: expiresAt ?? Number.MAX_SAFE_INTEGER,
		});
		return { clientId: id, token, expiresAt };
	}
}
