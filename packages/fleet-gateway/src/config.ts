/**
 * Gateway configuration: file + environment, validated once at startup.
 *
 * Nothing machine-specific lives in the repository. The config file is the one
 * place hosts, tokens and workspace aliases are named, so it is validated hard
 * before the server accepts a single request — the same rule the connector
 * applies to its workspace allowlist.
 */
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GatewayConfig, HostConfig, WorkspaceAlias } from "./types";

export class GatewayConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GatewayConfigError";
	}
}

const HOST_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ALIAS = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function defaultConfigPath(): string {
	return path.join(os.homedir(), ".ompk", "fleet-gateway.json");
}

export function defaultDataDir(): string {
	return path.join(os.homedir(), ".ompk", "fleet-gateway");
}

function isLoopbackHost(host: string): boolean {
	const h = host.toLowerCase();
	return h === "localhost" || h === "::1" || h.startsWith("127.") || h === "[::1]";
}

function requireUrl(value: unknown, field: string, { loopbackHttpOnly }: { loopbackHttpOnly: boolean }): string {
	if (typeof value !== "string" || value.length === 0) throw new GatewayConfigError(`${field} must be a URL string`);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new GatewayConfigError(`${field} is not a URL: ${value}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new GatewayConfigError(`${field} must be http or https: ${value}`);
	if (url.protocol === "http:" && loopbackHttpOnly && !isLoopbackHost(url.hostname)) {
		throw new GatewayConfigError(`${field} may use http only on a loopback host: ${value}`);
	}
	return url.toString().replace(/\/$/, "");
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown, field: string, min: number, max: number): number {
	if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
		throw new GatewayConfigError(`${field} must be a number between ${min} and ${max}`);
	}
	return v;
}

function parseHost(raw: unknown, index: number): HostConfig {
	if (typeof raw !== "object" || raw === null) throw new GatewayConfigError(`hosts[${index}] must be an object`);
	const h = raw as Record<string, unknown>;
	const id = str(h.id);
	if (!id || !HOST_ID.test(id))
		throw new GatewayConfigError(`hosts[${index}].id must be lowercase letters, digits and hyphens (≤32)`);
	const connectorUrl = requireUrl(h.connectorUrl, `hosts[${id}].connectorUrl`, { loopbackHttpOnly: true });
	const token = str(h.token);
	const tokenCommand = Array.isArray(h.tokenCommand) ? h.tokenCommand.map(String) : undefined;
	if (tokenCommand && (tokenCommand.length === 0 || !tokenCommand.every(a => a.length > 0))) {
		throw new GatewayConfigError(`hosts[${id}].tokenCommand must be a non-empty argv array`);
	}
	if (!token && !tokenCommand) throw new GatewayConfigError(`hosts[${id}] needs a token or a tokenCommand`);
	if (token && tokenCommand) throw new GatewayConfigError(`hosts[${id}] takes token or tokenCommand, not both`);
	return {
		id,
		label: str(h.label),
		connectorUrl,
		token,
		tokenCommand,
		maxConcurrentJobs: num(h.maxConcurrentJobs ?? 2, `hosts[${id}].maxConcurrentJobs`, 1, 64),
		defaultWorkspace: str(h.defaultWorkspace),
	};
}

function parseWorkspace(raw: unknown, index: number, hostIds: Set<string>): WorkspaceAlias {
	if (typeof raw !== "object" || raw === null) throw new GatewayConfigError(`workspaces[${index}] must be an object`);
	const w = raw as Record<string, unknown>;
	const alias = str(w.alias);
	if (!alias || !ALIAS.test(alias))
		throw new GatewayConfigError(`workspaces[${index}].alias must be lowercase letters, digits and hyphens (≤64)`);
	const host = str(w.host);
	if (!host || !hostIds.has(host))
		throw new GatewayConfigError(`workspaces[${alias}].host is not a configured host: ${host}`);
	const workspace = str(w.workspace);
	if (!workspace) throw new GatewayConfigError(`workspaces[${alias}].workspace is required`);
	return {
		alias,
		description: str(w.description),
		host,
		workspace,
		model: str(w.model),
		allowStart: w.allowStart !== false,
		default: w.default === true,
	};
}

export function parseConfig(raw: unknown): GatewayConfig {
	if (typeof raw !== "object" || raw === null) throw new GatewayConfigError("config must be a JSON object");
	const c = raw as Record<string, unknown>;
	const publicUrl = requireUrl(c.publicUrl, "publicUrl", { loopbackHttpOnly: false });
	const listen = (c.listen ?? {}) as Record<string, unknown>;
	const listenHost = str(listen.host) ?? "127.0.0.1";
	if (!isLoopbackHost(listenHost)) throw new GatewayConfigError("listen.host must be a loopback address");
	const listenPort = num(listen.port ?? 3880, "listen.port", 1, 65535);

	const hostRaw = Array.isArray(c.hosts) ? c.hosts : [];
	if (hostRaw.length === 0) throw new GatewayConfigError("at least one host is required");
	const hosts = hostRaw.map(parseHost);
	const hostIds = new Set(hosts.map(h => h.id));
	if (hostIds.size !== hosts.length) throw new GatewayConfigError("host ids must be unique");

	const wsRaw = Array.isArray(c.workspaces) ? c.workspaces : [];
	const workspaces = wsRaw.map((w, i) => parseWorkspace(w, i, hostIds));
	const aliases = new Set<string>();
	for (const w of workspaces) {
		if (aliases.has(w.alias)) throw new GatewayConfigError(`workspace alias must be unique: ${w.alias}`);
		aliases.add(w.alias);
	}
	for (const h of hosts) {
		if (h.defaultWorkspace && !workspaces.some(w => w.host === h.id && w.alias === h.defaultWorkspace)) {
			throw new GatewayConfigError(
				`hosts[${h.id}].defaultWorkspace is not a workspace alias on that host: ${h.defaultWorkspace}`,
			);
		}
	}

	const tokens = (c.tokens ?? {}) as Record<string, unknown>;
	const watcher = (c.watcher ?? {}) as Record<string, unknown>;
	const limits = (c.limits ?? {}) as Record<string, unknown>;
	return {
		publicUrl,
		listen: { host: listenHost, port: listenPort },
		hosts,
		workspaces,
		tokens: {
			accessTtlSeconds: num(tokens.accessTtlSeconds ?? 43_200, "tokens.accessTtlSeconds", 60, 604_800),
			refreshIdleTtlDays: num(tokens.refreshIdleTtlDays ?? 90, "tokens.refreshIdleTtlDays", 1, 3650),
		},
		watcher: {
			pollSeconds: num(watcher.pollSeconds ?? 10, "watcher.pollSeconds", 2, 600),
			hostBackoffSeconds: num(watcher.hostBackoffSeconds ?? 60, "watcher.hostBackoffSeconds", 5, 3600),
		},
		limits: {
			taskChars: num(limits.taskChars ?? 20_000, "limits.taskChars", 200, 100_000),
			jobsPerClient: num(limits.jobsPerClient ?? 200, "limits.jobsPerClient", 1, 10_000),
			feedWindow: num(limits.feedWindow ?? 500, "limits.feedWindow", 10, 5_000),
		},
	};
}

/** Load config from `$OMPK_FG_CONFIG`, an explicit path, or the default location. */
export function loadConfig(explicitPath?: string): { config: GatewayConfig; path: string } {
	const file = explicitPath ?? process.env.OMPK_FG_CONFIG ?? defaultConfigPath();
	if (!existsSync(file))
		throw new GatewayConfigError(`config file not found: ${file} (run \`ompk-fleet-gateway init\` to write one)`);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new GatewayConfigError(
			`config file is not valid JSON: ${file} (${error instanceof Error ? error.message : error})`,
		);
	}
	return { config: parseConfig(raw), path: file };
}
