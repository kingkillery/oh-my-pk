import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import { createApiKeyLogin } from "./api-key-login";
import { validateApiKeyAgainstModelsEndpoint } from "./api-key-validation";
import { pollOAuthDeviceCodeFlow } from "./oauth/device-flow";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const META_MODELS_URL = "https://api.meta.ai/v1/models";
const META_DEVICE_CLIENT_ID = "1031625952748946";

/**
 * Local Muse CLI auth.json locations, highest priority first. Import reads them
 * in this order and the sign-in mirror writes the first, so a fresh key is
 * never shadowed by a stale file.
 */
function localMuseAuthPaths(): string[] {
	const paths: string[] = [];
	if (process.env.XDG_CONFIG_HOME) paths.push(path.join(process.env.XDG_CONFIG_HOME, "muse", "auth.json"));
	if (process.env.HOME) paths.push(path.join(process.env.HOME, ".config", "muse", "auth.json"));
	if (process.env.USERPROFILE) paths.push(path.join(process.env.USERPROFILE, ".config", "muse", "auth.json"));
	return paths;
}

/** Muse CLI auth.json files inside the current Windows user's WSL Ubuntu distro. */
function wslMuseAuthPaths(): string[] {
	if (process.platform !== "win32") return [];
	const paths: string[] = [];
	for (const prefix of ["//wsl.localhost/Ubuntu", "//wsl$/Ubuntu"]) {
		try {
			const homeDir = path.join(prefix, "home");
			if (!fs.existsSync(homeDir)) continue;
			for (const user of fs.readdirSync(homeDir)) {
				paths.push(path.join(homeDir, user, ".config", "muse", "auth.json"));
			}
		} catch {
			// Ignore permission / unreachable WSL UNC paths
		}
	}
	return paths;
}

/**
 * Resolve an active Muse Code subscription API key from the Muse CLI config:
 * $XDG_CONFIG_HOME, ~/.config, %USERPROFILE%/.config, then WSL Ubuntu homes so
 * OMPK on Windows discovers credentials from `wsl muse login`.
 *
 * Only a real subscription `api_key` is returned. The OAuth `access_token`, or
 * an `api_key` that merely copies it (written by older sign-ins), is never an
 * API key and would fail every request.
 */
export function resolveMuseCliAuthKey(): string | undefined {
	for (const candidate of [...localMuseAuthPaths(), ...wslMuseAuthPaths()]) {
		try {
			if (!fs.existsSync(candidate)) continue;
			const meta = JSON.parse(fs.readFileSync(candidate, "utf8"))?.providers?.meta;
			const apiKey = typeof meta?.api_key === "string" ? meta.api_key.trim() : "";
			const accessToken = typeof meta?.access_token === "string" ? meta.access_token.trim() : "";
			if (apiKey && apiKey !== accessToken) return apiKey;
		} catch {
			// Ignore unreadable or malformed files
		}
	}

	return undefined;
}

/**
 * Resolved Meta API key fallback for OMPK:
 * 1. Explicit environment variable (META_API_KEY, MODEL_API_KEY, META_MODEL_API_KEY)
 * 2. Active Muse Code CLI session from Windows or WSL (~/.config/muse/auth.json)
 */
export function resolveMetaApiKey(): string | undefined {
	return (
		process.env.META_API_KEY || process.env.MODEL_API_KEY || process.env.META_MODEL_API_KEY || resolveMuseCliAuthKey()
	);
}
const defaultApiKeyLogin = createApiKeyLogin({
	providerLabel: "Meta AI",
	authUrl: "https://ai.developer.meta.com/docs/muse-code/auth",
	instructions: "Create or copy your API key from the Model API dashboard (API keys → Create API key)",
	promptMessage: "Paste your Meta AI API key",
	placeholder: "LLM|...",
	validation: {
		kind: "models-endpoint",
		provider: "Meta AI",
		modelsUrl: META_MODELS_URL,
	},
});

function validateMuseKey(apiKey: string, callbacks: OAuthLoginCallbacks): Promise<void> {
	return validateApiKeyAgainstModelsEndpoint({
		provider: "Meta Muse Code",
		apiKey,
		modelsUrl: META_MODELS_URL,
		fetch: callbacks.fetch,
		signal: callbacks.signal,
	});
}

/**
 * Mirror the sign-in to the highest-priority local Muse auth.json for CLI parity.
 * Other providers' entries are kept. The file is replaced atomically (temp file +
 * rename) so a failed write cannot truncate it, and the new file is owner-only.
 */
async function writeMuseAuthMirror(accessToken: string, apiKey: string): Promise<void> {
	const authPath = localMuseAuthPaths()[0];
	if (!authPath) return;
	const tempPath = `${authPath}.${process.pid}.tmp`;
	try {
		const authFile = Bun.file(authPath);
		const previous: unknown = (await authFile.exists()) ? await authFile.json() : {};
		const existing = previous && typeof previous === "object" ? (previous as Record<string, unknown>) : {};
		const providers =
			existing.providers && typeof existing.providers === "object"
				? (existing.providers as Record<string, unknown>)
				: {};
		const mirror = {
			...existing,
			schema_version: 1,
			providers: {
				...providers,
				meta: {
					access_token: accessToken,
					api_key: apiKey,
					api_base_url: "https://api.meta.ai/v1",
					mechanism: "oauth",
					obtained_via: "device_code",
				},
			},
		};
		await fs.promises.mkdir(path.dirname(authPath), { recursive: true });
		await Bun.write(tempPath, JSON.stringify(mirror, null, 2), { mode: 0o600 });
		await fs.promises.rename(tempPath, authPath);
	} catch (error) {
		await fs.promises.rm(tempPath, { force: true }).catch(() => {});
		// The sign-in itself succeeded; only the Muse CLI mirror is stale.
		logger.warn("Meta Muse Code: could not update the Muse CLI auth.json mirror", {
			path: authPath,
			error: String(error),
		});
	}
}

/**
 * Meta Device Code OAuth flow for Muse Code subscriptions.
 * Initiates the device authorization against https://auth.meta.com/oidc/device/authorization/,
 * waits for the user to approve in the browser, exchanges for an access_token,
 * and mints the subscription-tied API key via https://api.meta.ai/muse-code/key.
 */
export async function loginMetaDeviceCode(callbacks: OAuthLoginCallbacks): Promise<string> {
	const fetchImpl = callbacks.fetch ?? fetch;
	callbacks.onProgress?.("Requesting device login from Meta…");
	const initRes = await fetchImpl("https://auth.meta.com/oidc/device/authorization/", {
		method: "POST",
		signal: callbacks.signal,
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			client_id: META_DEVICE_CLIENT_ID,
		}).toString(),
	});

	if (!initRes.ok) {
		const text = await initRes.text().catch(() => "");
		throw new Error(`Meta device authorization failed (${initRes.status}): ${text}`);
	}

	const initData = (await initRes.json()) as {
		device_code: string;
		user_code: string;
		verification_uri: string;
		verification_uri_complete?: string;
		expires_in?: number;
		interval?: number;
	};

	const authUrl = initData.verification_uri_complete || `${initData.verification_uri}?code=${initData.user_code}`;
	callbacks.onAuth({
		url: authUrl,
		instructions: `Open ${authUrl} and confirm code matches: ${initData.user_code}`,
	});

	callbacks.onProgress?.(`Waiting for browser sign-in approval (${initData.user_code})…`);

	const accessToken = await pollOAuthDeviceCodeFlow<string>({
		intervalSeconds: initData.interval,
		expiresInSeconds: initData.expires_in ?? 600,
		signal: callbacks.signal,
		poll: async () => {
			const tokenRes = await fetchImpl("https://auth.meta.com/oidc/device/token/", {
				method: "POST",
				signal: callbacks.signal,
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: new URLSearchParams({
					client_id: META_DEVICE_CLIENT_ID,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					device_code: initData.device_code,
				}).toString(),
			});
			if (tokenRes.ok) {
				const tokenData = (await tokenRes.json()) as { access_token?: unknown };
				const token = typeof tokenData.access_token === "string" ? tokenData.access_token.trim() : "";
				return token
					? { status: "complete", value: token }
					: {
							status: "failed",
							message: "Meta device authorization returned no access token. Sign-in was not saved.",
						};
			}
			const errBody = (await tokenRes.json().catch(() => ({}))) as { error?: string };
			if (errBody.error === "authorization_pending") return { status: "pending" };
			if (errBody.error === "slow_down") return { status: "slow_down" };
			return {
				status: "failed",
				message: `Meta device authorization failed: ${errBody.error ?? tokenRes.statusText}`,
			};
		},
	});

	callbacks.onProgress?.("Sign-in approved. Fetching Muse Code subscription credential…");
	const keyRes = await fetchImpl("https://api.meta.ai/muse-code/key", {
		method: "POST",
		signal: callbacks.signal,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({}),
	});
	if (!keyRes.ok) {
		throw new Error(`Meta Muse Code credential exchange failed (${keyRes.status}). Sign-in was not saved.`);
	}
	const keyData = (await keyRes.json()) as {
		api_key?: unknown;
		is_subs_active?: boolean;
		require_payment?: boolean;
	};
	if (keyData.is_subs_active === false || keyData.require_payment === true) {
		throw new Error("An active Muse Code subscription is required. Sign-in was not saved.");
	}
	const apiKey = typeof keyData.api_key === "string" ? keyData.api_key.trim() : "";
	if (!apiKey || apiKey === accessToken) {
		throw new Error("Meta Muse Code returned no usable subscription API key. Sign-in was not saved.");
	}
	await validateMuseKey(apiKey, { ...callbacks, fetch: fetchImpl });
	await writeMuseAuthMirror(accessToken, apiKey);
	return apiKey;
}

/**
 * Meta AI login:
 * Presents a decision tree between:
 *  1. Meta Muse Code Subscription (sign in with Meta account / auto-import from WSL or local Muse CLI)
 *  2. Meta Model API Key (pay-as-you-go developer key)
 */
export async function loginMeta(callbacks: OAuthLoginCallbacks): Promise<string> {
	const choice = await callbacks.onPrompt({
		message:
			"Choose authentication method for Meta AI:\n" +
			"  1. Meta Muse Code Subscription (sign in with Meta account / auto-import from Muse CLI)\n" +
			"  2. Meta Model API Key (pay-as-you-go developer key)\n" +
			"Enter 1 or 2 [default: 1]:",
		placeholder: "1",
		allowEmpty: true,
	});

	const trimmedChoice = choice?.trim() ?? "";
	if (trimmedChoice === "2" || trimmedChoice.startsWith("LLM_") || trimmedChoice.startsWith("LLM|")) {
		if (trimmedChoice.startsWith("LLM_") || trimmedChoice.startsWith("LLM|")) {
			return defaultApiKeyLogin({
				...callbacks,
				onPrompt: async () => trimmedChoice,
			});
		}
		return defaultApiKeyLogin(callbacks);
	}
	const detected = resolveMuseCliAuthKey();
	if (detected) {
		const useExisting = await callbacks.onPrompt({
			message:
				"Found active Muse Code subscription credential in WSL/local (~/.config/muse/auth.json). Use it? [Y/n]:",
			placeholder: "Y",
			allowEmpty: true,
		});
		if (!useExisting || useExisting.trim().toLowerCase().startsWith("y")) {
			try {
				await validateMuseKey(detected, callbacks);
				return detected;
			} catch (error) {
				if (callbacks.signal?.aborted) throw error;
				// A stale saved credential must not block sign-in; get a fresh one.
				callbacks.onProgress?.(
					`The saved Muse Code credential was rejected (${error instanceof Error ? error.message : String(error)}). Signing in again…`,
				);
			}
		}
	}

	return loginMetaDeviceCode(callbacks);
}

export const metaProvider = {
	id: "meta",
	name: "Meta AI",
	envKeys: resolveMetaApiKey,
	login: (cb: OAuthLoginCallbacks) => loginMeta(cb),
} as const satisfies ProviderDefinition;

export const metaMuseCodeProvider = {
	id: "meta-muse-code",
	name: "Meta Muse Code",
	envKeys: resolveMetaApiKey,
	login: (cb: OAuthLoginCallbacks) => loginMeta(cb),
} as const satisfies ProviderDefinition;
