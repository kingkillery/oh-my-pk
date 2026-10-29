#!/usr/bin/env bun

/**
 * `ompk-chatgpt` command line.
 *
 * Commands:
 *   serve (default)  Start the MCP listener. SIGINT/SIGTERM drain cleanly.
 *   init [dir…]      Write a config template (optionally seeded with workspace
 *                    dirs); never overwrites an existing file.
 *   token            Print a strong random bearer token.
 *   doctor           Validate the config, workspace allowlist, and auth mode.
 *
 * Flags: `--config <path>`, `--host`, `--port`, `--public-url`, `--model`,
 * `--version`, `--help`.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { redactToken } from "./auth";
import { type ConnectorConfig, ConnectorConfigError, DEFAULT_CONFIG_PATH, loadConfig } from "./config";
import { createConnector } from "./index";
import { VERSION } from "./version";

/** URL-safe strong token (43 chars ≈ 256 bits). */
export function generateToken(): string {
	return randomBytes(32).toString("base64url");
}

interface ParsedArgs {
	command: string;
	flags: Record<string, string>;
	positional: string[];
	help: boolean;
	version: boolean;
}

const KNOWN_FLAGS: Record<string, true> = {
	config: true,
	host: true,
	port: true,
	"public-url": true,
	model: true,
	force: true,
};

function parseArgs(argv: string[]): ParsedArgs {
	const parsed: ParsedArgs = { command: "", flags: {}, positional: [], help: false, version: false };
	let index = 0;
	if (argv[0] && !argv[0].startsWith("-") && ["serve", "init", "token", "doctor"].includes(argv[0])) {
		parsed.command = argv[0];
		index = 1;
	}
	for (; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") parsed.help = true;
		else if (arg === "--version" || arg === "-v") parsed.version = true;
		else if (arg === "--force") parsed.flags.force = "1";
		else if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
			if (!KNOWN_FLAGS[name]) throw new ConnectorConfigError(`Unknown flag: ${arg}`);
			parsed.flags[name] =
				eq > 0 ? arg.slice(eq + 1) : argv[index + 1]?.startsWith("--") ? "" : (argv[++index] ?? "");
		} else {
			parsed.positional.push(arg);
		}
	}
	return parsed;
}

/** Env overlay so CLI flags flow through the same config pipeline. */
function envOverrides(flags: Record<string, string>): Record<string, string> {
	const env: Record<string, string> = {};
	if (flags.host) env.OMPK_CHATGPT_HOST = flags.host;
	if (flags.port) env.OMPK_CHATGPT_PORT = flags.port;
	if (flags["public-url"]) env.OMPK_CHATGPT_PUBLIC_URL = flags["public-url"];
	if (flags.model) env.OMPK_CHATGPT_MODEL = flags.model;
	return env;
}

function mergeEnv(overrides: Record<string, string>): Record<string, string | undefined> {
	return { ...process.env, ...overrides };
}

function usage(): string {
	return `ompk-chatgpt ${VERSION}

Usage:
  ompk-chatgpt [serve] [--config path] [--host 127.0.0.1] [--port 8787] [--public-url https://…]
  ompk-chatgpt init [workspace-dir …] [--config path] [--force]
  ompk-chatgpt token
  ompk-chatgpt doctor [--config path]

Environment: OMPK_CHATGPT_CONFIG, _HOST, _PORT, _TOKEN, _AUTH=none|oauth,
_WORKSPACES, _WORKSPACE, _MODEL, _PUBLIC_URL, _OAUTH_* — see README.`;
}

async function cmdServe(parsed: ParsedArgs): Promise<number> {
	const env = mergeEnv(envOverrides(parsed.flags));
	const connector = createConnector({
		configPath: parsed.flags.config,
		env,
		version: VERSION,
	});
	const { config, server } = connector;
	console.error(`ompk-chatgpt ${VERSION} listening: ${server.url}`);
	console.error(
		`  auth: ${config.auth.mode}${config.auth.mode === "bearer" ? ` (${config.auth.tokens.length} token${config.auth.tokens.length === 1 ? "" : "s"})` : ""}`,
	);
	for (const workspace of config.workspaces) {
		console.error(
			`  workspace ${workspace.id}: ${workspace.path}${workspace.allowWrite === false ? " (read-only)" : ""}${workspace.id === config.defaults.workspace ? " (default)" : ""}`,
		);
	}
	if (config.auth.mode === "none") {
		console.error("  WARNING: auth.mode=none — safe only behind a Secure MCP Tunnel or trusted front door.");
	}
	if (config.auth.mode === "bearer" && config.auth.allowQueryToken) {
		console.error("  note: ?token= query auth is enabled; prefer header auth when the client supports it.");
	}

	let stopping = false;
	const shutdown = () => {
		if (stopping) return;
		stopping = true;
		console.error("shutting down…");
		void connector.stop().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	return 0;
}

function cmdInit(parsed: ParsedArgs): number {
	const configPath = parsed.flags.config ?? process.env.OMPK_CHATGPT_CONFIG ?? DEFAULT_CONFIG_PATH;
	if (existsSync(configPath) && parsed.flags.force !== "1") {
		console.error(`Config already exists: ${configPath} (use --force to overwrite)`);
		return 1;
	}
	const token = generateToken();
	const workspaces = parsed.positional.map(dir => {
		const absolute = resolve(dir);
		return { id: "", path: existsSync(absolute) ? realpathSync(absolute) : absolute };
	});
	const template = {
		server: { host: "127.0.0.1", port: 8787 },
		auth: { mode: "bearer", tokens: [token] },
		workspaces,
		defaults: { waitSeconds: 20 },
		chatgpt: { model: "gpt-5.1" },
	};
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(template, null, "\t")}\n`, "utf8");
	console.error(`Wrote ${configPath}`);
	console.error(`  bearer token: ${redactToken(token)} (stored in the file; run \`ompk-chatgpt token\` for more)`);
	if (workspaces.length === 0) {
		console.error("  add at least one entry to `workspaces` before serving, or pass dirs: ompk-chatgpt init <dir>");
	}
	if (parsed.flags.force === "1") console.error("  (--force overwrote the previous file)");
	return 0;
}

function cmdToken(): number {
	console.log(generateToken());
	return 0;
}

async function cmdDoctor(parsed: ParsedArgs): Promise<number> {
	const env = mergeEnv(envOverrides(parsed.flags));
	const problems: string[] = [];
	let config: ConnectorConfig;
	try {
		config = loadConfig({ configPath: parsed.flags.config, env });
	} catch (error) {
		console.error(`FAIL config: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	console.log(`config: ${parsed.flags.config ?? env.OMPK_CHATGPT_CONFIG ?? DEFAULT_CONFIG_PATH} (loaded)`);
	console.log(
		`server: http://${config.server.host}:${config.server.port}${config.server.publicUrl ? ` → ${config.server.publicUrl}` : ""}`,
	);

	if (config.auth.mode === "bearer") {
		console.log(
			`auth: bearer, ${config.auth.tokens.length} token(s)${config.auth.allowQueryToken ? ", ?token= allowed" : ""}`,
		);
	} else if (config.auth.mode === "oauth") {
		const oauth = config.auth.oauth;
		console.log(
			`auth: oauth — resource=${oauth?.resource ?? "(none)"} issuer=${oauth?.issuer?.join(",") ?? "(none)"} jwks=${oauth?.jwksUri ?? "(none)"}`,
		);
		if (!oauth?.jwksUri) problems.push("auth.oauth.jwksUri is missing");
	} else {
		console.log(`auth: none${config.server.allowInsecure ? " (allowInsecure set)" : ""} — only safe behind a tunnel`);
		if (!config.server.allowInsecure && !["127.", "localhost", "::1"].some(p => config.server.host.startsWith(p))) {
			problems.push("auth.mode=none on a non-loopback host");
		}
	}

	for (const workspace of config.workspaces) {
		const real = existsSync(workspace.path) ? "ok" : "MISSING";
		console.log(
			`workspace ${workspace.id}: ${workspace.path} [${real}]${workspace.allowWrite === false ? " (read-only)" : ""}`,
		);
		if (real !== "ok") problems.push(`workspace ${workspace.id} path does not exist`);
	}
	if (config.workspaces.length === 0) problems.push("no workspaces configured");
	if (config.defaults.workspace && !config.workspaces.some(w => w.id === config.defaults.workspace)) {
		problems.push(`defaults.workspace "${config.defaults.workspace}" not in allowlist`);
	}
	const key = config.chatgpt.apiKey ?? process.env.OPENAI_API_KEY;
	console.log(
		`chatgpt client: ${config.chatgpt.model} @ ${config.chatgpt.baseUrl}${key ? " (api key set)" : " (NO API KEY — ask_chatgpt will fail)"}`,
	);
	if (!key) problems.push("chatgpt.apiKey / OPENAI_API_KEY not set");

	if (problems.length > 0) {
		for (const problem of problems) console.error(`WARN: ${problem}`);
		return 1;
	}
	console.log("doctor: ok");
	return 0;
}

async function main(): Promise<number> {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.version) {
		console.log(VERSION);
		return 0;
	}
	if (parsed.help) {
		console.log(usage());
		return 0;
	}
	switch (parsed.command || "serve") {
		case "serve":
			return cmdServe(parsed);
		case "init":
			return cmdInit(parsed);
		case "token":
			return cmdToken();
		case "doctor":
			return cmdDoctor(parsed);
		default:
			console.error(`Unknown command: ${parsed.command}\n`);
			console.log(usage());
			return 1;
	}
}

if (import.meta.main) {
	try {
		const code = await main();
		if (code !== 0) process.exit(code);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
