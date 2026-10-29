/**
 * Config tests: defaults, env overrides, workspace allowlist normalization and
 * validation. Writes real config files and real workspace dirs to temp space.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorConfigError, createConfig, loadChatGptClientConfig, loadConfig } from "../src/config";
import { tempWorkspace } from "./helpers";

const cleanup: string[] = [];
afterEach(() => {
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ompk-cfg-"));
	cleanup.push(dir);
	return dir;
}

function writeConfig(dir: string, value: unknown): string {
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(value), "utf8");
	return path;
}
describe("defaults and env", () => {
	test("sensible defaults when the file only names a workspace", () => {
		const ws = tempWorkspace();
		const config = loadConfig({
			env: { OMPK_CHATGPT_TOKEN: "test-token-0123456789" },
			configPath: writeConfig(tempDir(), { workspaces: [ws] }),
		});
		expect(config.server.host).toBe("127.0.0.1");
		expect(config.server.port).toBe(8787);
		expect(config.auth.mode).toBe("bearer");
		expect(config.workspaces).toHaveLength(1);
		expect(config.workspaces[0].id).toBeTruthy();
		expect(config.defaults.workspace).toBeUndefined();
	});

	test("env overrides file values", () => {
		const ws = tempWorkspace();
		const dir = tempDir();
		const config = loadConfig({
			configPath: writeConfig(dir, {
				server: { port: 1000 },
				auth: { tokens: ["file-token-0123456789"] },
				workspaces: [{ path: ws }],
			}),
			env: { OMPK_CHATGPT_PORT: "9999", OMPK_CHATGPT_TOKEN: "env-token-0123456789" },
		});
		expect(config.server.port).toBe(9999);
		expect(config.auth.tokens).toEqual(["env-token-0123456789"]);
	});

	test("env workspace list defines the allowlist", () => {
		const ws1 = tempWorkspace();
		const ws2 = tempWorkspace();
		const config = loadConfig({
			env: { OMPK_CHATGPT_WORKSPACES: `${ws1},${ws2}`, OMPK_CHATGPT_TOKEN: "test-token-0123456789" },
			skipFile: true,
		});
		expect(config.workspaces).toHaveLength(2);
		expect(config.defaults.workspace).toBeUndefined();
	});

	test("chatgpt client block merges env overrides", () => {
		const client = loadChatGptClientConfig({
			skipFile: true,
			env: { OMPK_CHATGPT_API_MODEL: "gpt-5", OMPK_CHATGPT_API_KEY: "sk-test" },
		});
		expect(client.model).toBe("gpt-5");
		expect(client.apiKey).toBe("sk-test");
		expect(client.baseUrl).toBe("https://api.openai.com/v1");
	});
});

describe("workspace normalization", () => {
	test("rejects derived duplicate ids from same-named dirs", () => {
		const parent = tempDir();
		const a = join(parent, "repo");
		const b = join(parent, "copy", "repo");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });
		expect(() => createConfig({ workspaces: [a, b] })).toThrow(/duplicate workspace id/);
	});

	test("explicit distinct ids for same-named dirs are accepted", () => {
		const parent = tempDir();
		const a = join(parent, "repo");
		const b = join(parent, "copy", "repo");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });
		const config = createConfig({
			auth: { mode: "none" },
			workspaces: [
				{ id: "main", path: a },
				{ id: "fork", path: b },
			],
		});
		expect(config.workspaces.map(workspace => workspace.id)).toEqual(["main", "fork"]);
	});
	test("rejects nonexistent and non-directory paths", () => {
		expect(() => createConfig({ workspaces: [join(tempDir(), "nope")] })).toThrow(ConnectorConfigError);
		const file = join(tempDir(), "file.txt");
		writeFileSync(file, "x");
		expect(() => createConfig({ workspaces: [file] })).toThrow(ConnectorConfigError);
	});

	test("rejects an empty allowlist", () => {
		expect(() => createConfig({ workspaces: [] })).toThrow(ConnectorConfigError);
	});

	test("defaults.workspace must be a member of the allowlist", () => {
		const ws = tempWorkspace();
		expect(() => createConfig({ workspaces: [{ id: "ws", path: ws }], defaults: { workspace: "other" } })).toThrow(
			/not in the workspace allowlist/,
		);
	});
});

describe("auth validation", () => {
	test("bearer mode rejects short tokens and empty lists", () => {
		const ws = tempWorkspace();
		expect(() => createConfig({ workspaces: [ws], auth: { mode: "bearer", tokens: ["short"] } })).toThrow(
			/at least 16/,
		);
		expect(() => createConfig({ workspaces: [ws], auth: { mode: "bearer", tokens: [] } })).toThrow(
			/no tokens are configured/,
		);
	});

	test("oauth mode requires jwksUri, issuer, audience, and servers", () => {
		const ws = tempWorkspace();
		const oauth = {
			resource: "https://conn.example.com/mcp",
			authorizationServers: ["https://idp.example.com"],
			jwksUri: "https://idp.example.com/jwks.json",
		};
		expect(() =>
			createConfig({ workspaces: [ws], server: { allowInsecure: true }, auth: { mode: "oauth", oauth } }),
		).not.toThrow();
		expect(() =>
			createConfig({
				workspaces: [ws],
				server: { allowInsecure: true },
				auth: { mode: "oauth", oauth: { ...oauth, jwksUri: undefined } },
			}),
		).toThrow(/jwksUri/);
		expect(() =>
			createConfig({
				workspaces: [ws],
				server: { allowInsecure: true },
				auth: { mode: "oauth", oauth: { ...oauth, authorizationServers: [] } },
			}),
		).toThrow(/issuer/);
	});

	test("oauth resource must be https outside loopback", () => {
		const ws = tempWorkspace();
		expect(() =>
			createConfig({
				workspaces: [ws],
				auth: {
					mode: "oauth",
					oauth: {
						resource: "http://conn.example.com/mcp",
						issuer: ["https://idp.example.com"],
						audience: ["https://conn.example.com/mcp"],
						authorizationServers: ["https://idp.example.com"],
						jwksUri: "https://idp.example.com/jwks",
					},
				},
			}),
		).toThrow(/HTTPS/);
	});
});
