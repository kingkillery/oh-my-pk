#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
/**
 * The operator surface: serve the gateway, or drive it from the terminal.
 *
 *   ompk-fleet-gateway serve [--config PATH]     run the gateway
 *   ompk-fleet-gateway init                      write a starter config
 *   ompk-fleet-gateway pair [--label L]          mint a one-time approval code
 *   ompk-fleet-gateway token --name N --access read|operate [--hosts a,b|all] [--ttl SEC]
 *   ompk-fleet-gateway clients                   list enrolled clients
 *   ompk-fleet-gateway clients revoke <id>
 *   ompk-fleet-gateway hosts                     reachability + task count per host
 *   ompk-fleet-gateway jobs [--state S]          open jobs from the ledger
 *   ompk-fleet-gateway doctor                    config + host + ledger check
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { defaultConfigPath, defaultDataDir, GatewayConfigError, loadConfig } from "./config";
import { Store } from "./db/store";
import { ConnectorClient } from "./host/client";
import { GatewayHttpServer } from "./http/server";
import { type EngineHost, JobEngine } from "./jobs/engine";
import { JobService } from "./jobs/service";
import { hmac, newApprovalCode } from "./oauth/crypto";
import { OAuthServer } from "./oauth/server";
import { loadOrCreateSigningKey } from "./oauth/signing-key";
import type { GatewayConfig, HostClient, ResolvedHost } from "./types";
import { SERVER_NAME, VERSION } from "./version";

function arg(args: string[], name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
}

function fail(message: string): never {
	console.error(`${SERVER_NAME}: ${message}`);
	process.exit(1);
}

/** Resolve each host's bearer token (static or minted by tokenCommand). */
function resolveHosts(config: GatewayConfig): ResolvedHost[] {
	return config.hosts.map(host => {
		if (host.token) return { ...host, token: host.token };
		if (host.tokenCommand) {
			const [cmd, ...argv] = host.tokenCommand;
			try {
				const out = execFileSync(cmd, argv, {
					encoding: "utf8",
					timeout: 15_000,
					stdio: ["ignore", "pipe", "inherit"],
				}).trim();
				return { ...host, token: out };
			} catch (error) {
				throw new Error(
					`tokenCommand for host ${host.id} failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		throw new Error(`host ${host.id} has neither token nor tokenCommand`);
	});
}

function clientFor(host: ResolvedHost): HostClient {
	return new ConnectorClient(host.connectorUrl, host.token ?? "");
}

function engineHosts(resolved: ResolvedHost[]): EngineHost[] {
	return resolved.map(h => ({
		id: h.id,
		maxConcurrentJobs: h.maxConcurrentJobs,
		defaultWorkspace: h.defaultWorkspace,
		client: clientFor(h),
	}));
}

function openStore(): Store {
	const dir = defaultDataDir();
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return new Store(path.join(dir, "fleet-gateway.sqlite"));
}

async function cmdServe(args: string[]): Promise<void> {
	const config = loadConfig(arg(args, "config")).config;
	const store = openStore();
	const resolved = resolveHosts(config);
	const engine = new JobEngine({
		store,
		config,
		hosts: engineHosts(resolved),
		log: (event, detail) => console.log(`[engine] ${event}`, detail),
	});
	const service = new JobService({ store, config, engine });
	const http = new GatewayHttpServer({ store, config, service, signingKey: loadOrCreateSigningKey(defaultDataDir()) });
	const bound = await http.listen();
	const watcher = setInterval(
		() => void engine.tick().catch(e => console.error("[watcher]", e)),
		config.watcher.pollSeconds * 1000,
	);
	console.log(`${SERVER_NAME} ${VERSION}`);
	console.log(`listening   http://${bound.host}:${bound.port}  (public: ${config.publicUrl})`);
	console.log(`hosts       ${resolved.map(h => h.id).join(", ") || "(none configured)"}`);
	const shutdown = () => {
		clearInterval(watcher);
		void http.close().finally(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	await engine.tick();
}

function cmdInit(): void {
	const file = defaultConfigPath();
	if (existsSync(file)) fail(`config already exists: ${file}`);
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const starter = {
		publicUrl: "http://127.0.0.1:3880",
		listen: { host: "127.0.0.1", port: 3880 },
		hosts: [
			{
				id: "this-machine",
				label: "This machine",
				connectorUrl: "http://127.0.0.1:3939",
				tokenCommand: ["ompk-chatgpt", "token"],
				maxConcurrentJobs: 2,
			},
		],
		workspaces: [
			{
				alias: "oh-my-pk",
				description: "oh-my-pk monorepo",
				host: "this-machine",
				workspace: "oh-my-pk",
				allowStart: true,
			},
		],
	};
	writeFileSync(file, `${JSON.stringify(starter, null, 2)}\n`, { mode: 0o600 });
	console.log(`wrote ${file}`);
	console.log("Edit hosts[] and workspaces[] for your fleet, then `ompk-fleet-gateway serve`.");
}

function cmdPair(args: string[]): void {
	const store = openStore();
	const { display, code } = newApprovalCode();
	// The code is bound to this server's signing key + labelled, then hashed —
	// a leaked database row redeems nothing.
	store.insertApprovalCode({
		hash: hmac(loadOrCreateSigningKey(defaultDataDir()), `approval:${code}`),
		label: arg(args, "label"),
		expiresAt: Date.now() + 15 * 60_000,
	});
	store.resetGlobalApprovalFailures();
	console.log(`approval code: ${display}   (one use, 15 minutes)`);
	store.close();
}

function cmdToken(args: string[]): void {
	const config = loadConfig(arg(args, "config")).config;
	const name = arg(args, "name");
	const access = arg(args, "access");
	const hosts = arg(args, "hosts") ?? "all";
	const ttl = arg(args, "ttl");
	if (!name) fail("--name is required");
	if (access !== "read" && access !== "operate") fail("--access must be read or operate");
	const store = openStore();
	const oauth = new OAuthServer({ store, config });
	const minted = oauth.mintBearerToken({
		name,
		access,
		hosts: hosts === "all" ? "all" : hosts.split(",").map(s => s.trim()),
		ttlSeconds: ttl ? Number(ttl) : undefined,
	});
	console.log(`client ${minted.clientId}`);
	console.log(`token  ${minted.token}`);
	if (minted.expiresAt) console.log(`expires ${new Date(minted.expiresAt).toISOString()}`);
	store.close();
}

function cmdClients(args: string[]): void {
	const store = openStore();
	if (args[0] === "revoke") {
		const id = args[1];
		if (!id) fail("clients revoke needs a client id");
		store.revokeClient(id);
		console.log(`revoked ${id}`);
		store.close();
		return;
	}
	for (const c of store.listClients()) {
		const state = c.revokedAt ? `revoked ${new Date(c.revokedAt).toISOString()}` : "active";
		console.log(`${c.id}  ${c.kind}  ${state}  ${c.name}`);
	}
	store.close();
}

async function cmdHosts(args: string[]): Promise<void> {
	const config = loadConfig(arg(args, "config")).config;
	const resolved = resolveHosts(config);
	for (const host of resolved) {
		try {
			const client = clientFor(host);
			const [{ workspaces }, { tasks }] = await Promise.all([client.listWorkspaces(), client.listTasks()]);
			const live = tasks.filter(t => t.state === "queued" || t.state === "running").length;
			console.log(`${host.id}  ok    ${workspaces.length} workspace(s), ${live} live task(s)  ${host.connectorUrl}`);
		} catch (error) {
			console.log(`${host.id}  DOWN  ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function cmdJobs(args: string[]): void {
	const store = openStore();
	const states = arg(args, "state") ? [arg(args, "state")!] : undefined;
	const jobs = store.listJobs({ states: states as never, limit: 50 });
	for (const j of jobs) {
		console.log(`${j.id}  ${j.state.padEnd(16)} ${j.host}/${j.workspaceAlias ?? j.workspace}  ${j.title}`);
	}
	store.close();
}

async function cmdDoctor(args: string[]): Promise<void> {
	console.log(`${SERVER_NAME} ${VERSION}`);
	let config: GatewayConfig;
	try {
		config = loadConfig(arg(args, "config")).config;
		console.log(`config      ok  ${defaultConfigPath()}`);
	} catch (error) {
		if (error instanceof GatewayConfigError) fail(error.message);
		throw error;
	}
	const resolved = resolveHosts(config);
	for (const host of resolved) {
		try {
			const client = clientFor(host);
			const { workspaces } = await client.listWorkspaces();
			console.log(
				`host ${host.id.padEnd(16)} ok    connector answers; workspaces: ${workspaces.map(w => w.id).join(", ")}`,
			);
		} catch (error) {
			console.log(`host ${host.id.padEnd(16)} FAIL  ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (const w of config.workspaces) {
		const hostOk = resolved.some(h => h.id === w.host);
		console.log(
			`alias ${w.alias.padEnd(16)} ${hostOk ? "ok  " : "FAIL"} host=${w.host} workspace=${w.workspace}${w.allowStart === false ? " (read-only)" : ""}`,
		);
	}
	const store = openStore();
	const open = store.openJobs();
	console.log(`ledger      ${open.length} open job(s)`);
	store.close();
}

async function main(): Promise<void> {
	const [cmd, ...args] = process.argv.slice(2);
	switch (cmd) {
		case "serve":
			return cmdServe(args);
		case "init":
			return cmdInit();
		case "pair":
			return cmdPair(args);
		case "token":
			return cmdToken(args);
		case "clients":
			return cmdClients(args);
		case "hosts":
			return cmdHosts(args);
		case "jobs":
			return cmdJobs(args);
		case "doctor":
			return cmdDoctor(args);
		case "--version":
		case "-v":
			console.log(VERSION);
			return;
		case undefined:
		case "help":
		case "--help":
			console.log(`${SERVER_NAME} ${VERSION}\n\n  serve | init | pair | token | clients | hosts | jobs | doctor`);
			return;
		default:
			fail(`unknown command: ${cmd}`);
	}
}

await main();
