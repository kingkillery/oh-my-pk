/**
 * The enrollment contract: registration → authorize → approval code → grant
 * → bearer. Asserted against the OAuthServer + Store with no HTTP layer.
 */
import { describe, expect, test } from "bun:test";
import { formatScopes, parseScopes } from "../src/auth/scopes";
import { Store } from "../src/db/store";
import { hmac, newApprovalCode } from "../src/oauth/crypto";
import { OAuthServer } from "../src/oauth/server";
import type { GatewayConfig } from "../src/types";

function config(): GatewayConfig {
	return {
		publicUrl: "http://127.0.0.1:3880",
		listen: { host: "127.0.0.1", port: 3880 },
		hosts: [{ id: "h1", connectorUrl: "http://fake", maxConcurrentJobs: 2 }],
		workspaces: [{ alias: "repo", host: "h1", workspace: "repo", allowStart: true }],
		tokens: { accessTtlSeconds: 60, refreshIdleTtlDays: 90 },
		watcher: { pollSeconds: 10, hostBackoffSeconds: 60 },
		limits: { taskChars: 20_000, jobsPerClient: 200, feedWindow: 500 },
	};
}

const KEY = "test-signing-key";

describe("oauth enrollment", () => {
	test("a minted bearer token authenticates and carries its scopes", () => {
		const store = new Store(":memory:");
		const oauth = new OAuthServer({ store, config: config(), serverKey: KEY });
		const minted = oauth.mintBearerToken({ name: "tester", access: "operate", hosts: "all" });
		const identity = oauth.authenticate(`Bearer ${minted.token}`);
		expect(identity?.clientId).toBe(minted.clientId);
		expect(identity?.scopes.some(s => s.kind === "fleet" && s.level === "operate")).toBe(true);
		// Garbage never authenticates.
		expect(oauth.authenticate("Bearer not-a-token")).toBeNull();
		expect(oauth.authenticate(undefined)).toBeNull();
		store.close();
	});

	test("a revoked client's token stops authenticating", () => {
		const store = new Store(":memory:");
		const oauth = new OAuthServer({ store, config: config(), serverKey: KEY });
		const minted = oauth.mintBearerToken({ name: "tester", access: "read", hosts: "all" });
		expect(oauth.authenticate(`Bearer ${minted.token}`)).not.toBeNull();
		store.revokeClient(minted.clientId);
		expect(oauth.authenticate(`Bearer ${minted.token}`)).toBeNull();
		store.close();
	});

	test("an approval code redeems exactly once", () => {
		const store = new Store(":memory:");
		const { code } = newApprovalCode();
		const digest = hmac(KEY, `approval:${code}`);
		store.insertApprovalCode({ hash: digest, expiresAt: Date.now() + 60_000 });
		expect(store.redeemApprovalCode(digest)).toBe("ok");
		expect(store.redeemApprovalCode(digest)).toBe("used");
		expect(store.redeemApprovalCode(hmac(KEY, "approval:0000000000"))).toBe("unknown");
		store.close();
	});

	test("registration refuses a non-https, non-loopback redirect", () => {
		const store = new Store(":memory:");
		const oauth = new OAuthServer({ store, config: config(), serverKey: KEY });
		const bad = oauth.register({ client_name: "x", redirect_uris: ["http://evil.example.com/cb"] });
		expect(bad.status).toBe(400);
		const good = oauth.register({ client_name: "x", redirect_uris: ["http://127.0.0.1:9999/cb"] });
		expect(good.status).toBe(201);
		store.close();
	});

	test("stored scopes round-trip through the formatter", () => {
		const scopes = parseScopes("host:h1:operate host:h2:read")!;
		expect(scopes).toEqual([
			{ kind: "host", host: "h1", level: "operate" },
			{ kind: "host", host: "h2", level: "read" },
		]);
		expect(parseScopes(formatScopes(scopes))).toEqual(scopes);
		// A malformed scope in storage grants nothing.
		expect(parseScopes("host:h1:read garbage")).toBeNull();
	});
});
