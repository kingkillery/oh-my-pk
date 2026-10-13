import * as fs from "node:fs";
import * as path from "node:path";
import { createApiKeyLogin } from "./api-key-login";
import { validateApiKeyAgainstModelsEndpoint } from "./api-key-validation";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * Resolve an active Muse Code credential from the Muse CLI config directory.
 * Checks:
 * 1. $XDG_CONFIG_HOME/muse/auth.json or ~/.config/muse/auth.json (Linux / macOS / current platform)
 * 2. %USERPROFILE%/.config/muse/auth.json (Windows local)
 * 3. WSL Ubuntu mounts (\\wsl.localhost\Ubuntu\home\<user>\.config\muse\auth.json)
 *    so OMPK running on Windows automatically discovers Muse subscription credentials
 *    obtained via `wsl muse login`.
 */
export function resolveMuseCliAuthKey(): string | undefined {
	const candidates: string[] = [];

	if (process.env.XDG_CONFIG_HOME) {
		candidates.push(path.join(process.env.XDG_CONFIG_HOME, "muse", "auth.json"));
	}
	if (process.env.HOME) {
		candidates.push(path.join(process.env.HOME, ".config", "muse", "auth.json"));
	}
	if (process.env.USERPROFILE) {
		candidates.push(path.join(process.env.USERPROFILE, ".config", "muse", "auth.json"));
	}

	if (process.platform === "win32") {
		const wslPrefixes = ["//wsl.localhost/Ubuntu", "//wsl$/Ubuntu"];
		for (const prefix of wslPrefixes) {
			candidates.push(path.join(prefix, "home", "prest", ".config", "muse", "auth.json"));
			try {
				const homeDir = path.join(prefix, "home");
				if (fs.existsSync(homeDir)) {
					for (const u of fs.readdirSync(homeDir)) {
						if (u !== "prest") {
							candidates.push(path.join(homeDir, u, ".config", "muse", "auth.json"));
						}
					}
				}
			} catch {
				// Ignore permission / unreachable WSL UNC paths
			}
		}
	}

	for (const candidate of candidates) {
		try {
			if (!fs.existsSync(candidate)) continue;
			const content = JSON.parse(fs.readFileSync(candidate, "utf8"));
			const meta = content?.providers?.meta;
			if (!meta) continue;
			if (typeof meta.api_key === "string" && meta.api_key.trim()) {
				return meta.api_key.trim();
			}
			if (typeof meta.access_token === "string" && meta.access_token.trim()) {
				return meta.access_token.trim();
			}
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
		modelsUrl: "https://api.meta.ai/v1/models",
	},
});

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
			client_id: "1031625952748946",
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

	const intervalMs = Math.max(2000, (initData.interval ?? 5) * 1000);
	const expiresAt = Date.now() + (initData.expires_in ?? 600) * 1000;

	callbacks.onProgress?.(`Waiting for browser sign-in approval (${initData.user_code})…`);

	while (Date.now() < expiresAt) {
		await new Promise(resolve => setTimeout(resolve, intervalMs));

		const tokenRes = await fetchImpl("https://auth.meta.com/oidc/device/token/", {
			method: "POST",
			signal: callbacks.signal,
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams({
				client_id: "1031625952748946",
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: initData.device_code,
			}).toString(),
		});

		if (tokenRes.ok) {
			const tokenData = (await tokenRes.json()) as { access_token: string; expires_in?: number };
			const accessToken = tokenData.access_token;
			if (typeof accessToken !== "string" || !accessToken.trim()) {
				throw new Error("Meta device authorization returned no access token. Sign-in was not saved.");
			}
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
			if (typeof keyData.api_key !== "string" || !keyData.api_key.trim() || keyData.api_key.trim() === accessToken) {
				throw new Error("Meta Muse Code returned no usable subscription API key. Sign-in was not saved.");
			}
			const finalKey = keyData.api_key.trim();
			await validateApiKeyAgainstModelsEndpoint({
				provider: "Meta Muse Code",
				apiKey: finalKey,
				modelsUrl: "https://api.meta.ai/v1/models",
				fetch: fetchImpl,
				signal: callbacks.signal,
			});

			// Mirror to local .config/muse/auth.json for CLI parity
			try {
				const targetDir = process.env.USERPROFILE
					? path.join(process.env.USERPROFILE, ".config", "muse")
					: path.join(process.env.HOME ?? "", ".config", "muse");
				await fs.promises.mkdir(targetDir, { recursive: true });
				const authPath = path.join(targetDir, "auth.json");
				const authFile = Bun.file(authPath);
				const previous: unknown = (await authFile.exists()) ? await authFile.json() : {};
				const existing = previous && typeof previous === "object" ? (previous as Record<string, unknown>) : {};
				const providers =
					existing.providers && typeof existing.providers === "object"
						? (existing.providers as Record<string, unknown>)
						: {};
				await Bun.write(
					authPath,
					JSON.stringify(
						{
							...existing,
							schema_version: 1,
							providers: {
								...providers,
								meta: {
									access_token: accessToken,
									api_key: finalKey,
									api_base_url: "https://api.meta.ai/v1",
									mechanism: "oauth",
									obtained_via: "device_code",
								},
							},
						},
						null,
						2,
					),
					{ mode: 0o600 },
				);
			} catch {
				// Ignore filesystem persistence error
			}

			return finalKey;
		}

		const errBody = (await tokenRes.json().catch(() => ({}))) as { error?: string };
		if (errBody.error === "authorization_pending" || errBody.error === "slow_down") {
			continue;
		}

		throw new Error(`Meta device authorization failed: ${errBody.error ?? tokenRes.statusText}`);
	}

	throw new Error("Meta device authorization timed out. Please try logging in again.");
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
			await validateApiKeyAgainstModelsEndpoint({
				provider: "Meta Muse Code",
				apiKey: detected,
				modelsUrl: "https://api.meta.ai/v1/models",
				fetch: callbacks.fetch,
				signal: callbacks.signal,
			});
			return detected;
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
