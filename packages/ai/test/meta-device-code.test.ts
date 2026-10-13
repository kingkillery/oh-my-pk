import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai/auth-storage";
import { loginMeta, loginMetaDeviceCode } from "@pk-nerdsaver-ai/pi-ai/registry/meta";
import type { OAuthLoginCallbacks } from "@pk-nerdsaver-ai/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";

const accessToken = "synthetic-oauth-access-token";
const subscriptionKey = "synthetic-subscription-api-key";
const environmentKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME"] as const;

type ExchangeOptions = {
	keyStatus?: number;
	keyBody?: unknown;
	validationStatus?: number;
	tokenBody?: unknown;
	failExchange?: boolean;
};

function createExchange(options: ExchangeOptions = {}) {
	const requests: { url: string; init?: RequestInit }[] = [];
	const fetchImpl: FetchImpl = async (input, init) => {
		const url = input instanceof Request ? input.url : input.toString();
		requests.push({ url, init });
		switch (url) {
			case "https://auth.meta.com/oidc/device/authorization/":
				return Response.json({
					device_code: "synthetic-device-code",
					user_code: "TEST-CODE",
					verification_uri: "https://auth.meta.com/device",
					expires_in: 30,
					interval: 0,
				});
			case "https://auth.meta.com/oidc/device/token/":
				return Response.json(options.tokenBody ?? { access_token: accessToken });
			case "https://api.meta.ai/muse-code/key":
				if (options.failExchange) throw new Error("Synthetic network failure");
				return Response.json(
					options.keyBody ?? { api_key: subscriptionKey, is_subs_active: true, require_payment: false },
					{ status: options.keyStatus ?? 200 },
				);
			case "https://api.meta.ai/v1/models":
				return Response.json({ data: [] }, { status: options.validationStatus ?? 200 });
			default:
				throw new Error(`Unexpected test request: ${url}`);
		}
	};
	const callbacks: OAuthLoginCallbacks = {
		onAuth: () => {},
		onPrompt: async () => "1",
		fetch: fetchImpl,
	};
	return { callbacks, requests };
}

describe("Meta subscription OAuth credential exchange", () => {
	let tempDir: string;
	let authPath: string;
	let previousEnvironment: Partial<Record<(typeof environmentKeys)[number], string | undefined>>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "meta-device-code-"));
		previousEnvironment = {};
		for (const name of environmentKeys) {
			previousEnvironment[name] = process.env[name];
			process.env[name] = tempDir;
		}
		authPath = path.join(tempDir, ".config", "muse", "auth.json");
		await fs.mkdir(path.dirname(authPath), { recursive: true });
		await fs.writeFile(
			authPath,
			JSON.stringify({
				schema_version: 1,
				marker: "preserved",
				providers: { other: { key: "other-provider-key" } },
			}),
		);
	});

	afterEach(async () => {
		for (const name of environmentKeys) {
			const previous = previousEnvironment[name];
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("posts the OAuth token, validates the distinct API key, and preserves other providers", async () => {
		const { callbacks, requests } = createExchange();
		expect(await loginMetaDeviceCode(callbacks)).toBe(subscriptionKey);
		const exchange = requests.find(request => request.url.endsWith("/muse-code/key"));
		expect(exchange?.init?.method).toBe("POST");
		expect(exchange?.init?.headers).toMatchObject({
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		});
		expect(exchange?.init?.body).toBe("{}");
		const validation = requests.find(request => request.url.endsWith("/v1/models"));
		expect(validation?.init?.headers).toMatchObject({ Authorization: `Bearer ${subscriptionKey}` });
		const mirror = JSON.parse(await fs.readFile(authPath, "utf8"));
		expect(mirror.providers.meta.api_key).toBe(subscriptionKey);
		expect(mirror.providers.meta.access_token).toBe(accessToken);
		expect(mirror.providers.other).toEqual({ key: "other-provider-key" });
		expect(mirror.marker).toBe("preserved");
	});

	test("does not replace stored credentials or the mirror when the exchange returns 405", async () => {
		const before = await fs.readFile(authPath, "utf8");
		const { callbacks } = createExchange({ keyStatus: 405, keyBody: { detail: accessToken } });
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			store.saveApiKey("meta-muse-code", "previous-working-key");
			const storage = new AuthStorage(store);
			await storage.reload();
			await expect(storage.login("meta-muse-code", callbacks)).rejects.toThrow(
				"Meta Muse Code credential exchange failed (405). Sign-in was not saved.",
			);
			expect(store.getApiKey("meta-muse-code")).toBe("previous-working-key");
			expect(await fs.readFile(authPath, "utf8")).toBe(before);
		} finally {
			store.close();
		}
	});

	test.each([
		["missing key", {}],
		["blank key", { api_key: "   " }],
		["non-string key", { api_key: 123 }],
		["OAuth token instead of key", { api_key: accessToken }],
	])("rejects %s without modifying the mirror", async (_name, keyBody) => {
		const before = await fs.readFile(authPath, "utf8");
		const { callbacks, requests } = createExchange({ keyBody });
		await expect(loginMetaDeviceCode(callbacks)).rejects.toThrow("no usable subscription API key");
		expect(await fs.readFile(authPath, "utf8")).toBe(before);
		expect(requests.some(request => request.url.endsWith("/v1/models"))).toBe(false);
	});

	test("does not silently fall back after a network failure", async () => {
		const before = await fs.readFile(authPath, "utf8");
		const { callbacks } = createExchange({ failExchange: true });
		await expect(loginMetaDeviceCode(callbacks)).rejects.toThrow("Synthetic network failure");
		expect(await fs.readFile(authPath, "utf8")).toBe(before);
	});

	test("rejects an invalid exchanged key before writing it", async () => {
		const before = await fs.readFile(authPath, "utf8");
		const { callbacks } = createExchange({ validationStatus: 401 });
		await expect(loginMetaDeviceCode(callbacks)).rejects.toThrow("Meta Muse Code API key validation failed (401)");
		expect(await fs.readFile(authPath, "utf8")).toBe(before);
	});

	test("does not turn subscription login into pay-as-you-go access", async () => {
		const before = await fs.readFile(authPath, "utf8");
		const { callbacks } = createExchange({
			keyBody: { api_key: subscriptionKey, is_subs_active: false, require_payment: true },
		});
		await expect(loginMetaDeviceCode(callbacks)).rejects.toThrow("An active Muse Code subscription is required");
		expect(await fs.readFile(authPath, "utf8")).toBe(before);
	});

	test("rejects a missing OAuth token before requesting a subscription key", async () => {
		const { callbacks, requests } = createExchange({ tokenBody: {} });
		await expect(loginMetaDeviceCode(callbacks)).rejects.toThrow("returned no access token");
		expect(requests.some(request => request.url.endsWith("/muse-code/key"))).toBe(false);
	});

	test("validates imported credentials instead of accepting a stale browser token", async () => {
		const xdgMirror = path.join(tempDir, "muse", "auth.json");
		await fs.mkdir(path.dirname(xdgMirror), { recursive: true });
		await fs.writeFile(xdgMirror, JSON.stringify({ providers: { meta: { api_key: accessToken } } }));
		const { callbacks } = createExchange({ validationStatus: 401 });
		await expect(
			loginMeta({ ...callbacks, onPrompt: async prompt => (prompt.message.includes("Use it?") ? "Y" : "1") }),
		).rejects.toThrow("Meta Muse Code API key validation failed (401)");
	});
});
