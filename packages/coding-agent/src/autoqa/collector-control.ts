/**
 * Issue collector control plane.
 *
 * Reports are ALWAYS recorded locally by `report_tool_issue`. The collector is
 * the optional service that ingests, deduplicates, ranks, and files GitHub
 * issues. Three modes (`dev.autoqa.collector.mode`):
 *
 * - `off`    — nothing runs; reports accumulate in `autoqa.db`.
 * - `local`  — the `ompk-collector` binary runs as an OMPK extension on
 *              loopback, supervised across sessions.
 * - `remote` — reports POST to a collector the user hosts (pair with
 *              `omp collector pair <url> <token>`).
 *
 * All heavy lifting (storage, grouping, GitHub publishing) happens in the
 * collector, never in the OMPK session loop.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAutoQaCollectorDir, getAutoQaDbDir, logger } from "@pk-nerdsaver-ai/pi-utils";
import type { Settings } from "../config/settings";

export type CollectorMode = "off" | "local" | "remote";

const COLLECTOR_EXE = process.platform === "win32" ? "ompk-collector.exe" : "ompk-collector";

/** Loopback URL the local collector extension serves on. */
export const localCollectorUrl = (port: number) => `http://127.0.0.1:${port}/v1/grievances`;

/**
 * Resolve the effective collector mode, honouring the env override used by
 * tests and advanced setups.
 */
export function resolveCollectorMode(settings: Settings | undefined): CollectorMode {
	// `$flag` is a boolean predicate — the mode override rides on a plain env
	// read so `PI_AUTO_QA_COLLECTOR_MODE=local` is expressible.
	const override = process.env.PI_AUTO_QA_COLLECTOR_MODE?.trim();
	if (override === "off" || override === "local" || override === "remote") return override;
	const mode = settings?.get("dev.autoqa.collector.mode");
	return mode === "local" || mode === "remote" ? mode : "off";
}
/**
 * Locate the collector sidecar bundled with this build: the helper sitting
 * beside the N-API addon in the natives package (workspace/monorepo layout).
 * Returns null when this install has no bundled sidecar.
 */
export function resolveBundledCollectorPath(): string | null {
	// packages/coding-agent/src/autoqa → packages/natives/native
	const candidate = join(import.meta.dirname, "..", "..", "..", "..", "natives", "native", COLLECTOR_EXE);
	try {
		return existsSync(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

/**
 * Locate the collector binary: bundled sidecar → sibling of the running
 * `omp` binary → PATH (bare name, verified by spawn failure rather than a
 * filesystem probe). Returns null when the helper isn't installed.
 */
export function findCollectorBinary(explicit?: string): string | null {
	if (explicit && existsSync(explicit)) return explicit;
	const bundled = resolveBundledCollectorPath();
	if (bundled) return bundled;
	if (process.execPath) {
		const sibling = join(dirname(process.execPath), COLLECTOR_EXE);
		if (existsSync(sibling)) return sibling;
	}
	// Bare name — defer to PATH resolution at spawn time, verified by spawn
	// failure rather than a filesystem probe.
	return COLLECTOR_EXE;
}

/** Read the bearer token written by the collector on first start, if any. */
export function ensureLocalCollectorToken(): string | null {
	try {
		const text = readFileSync(join(getAutoQaCollectorDir(), "collector-token"), "utf8").trim();
		return text || null;
	} catch {
		return null;
	}
}

/** Read a numeric field from a parsed JSON object without asserting a shape. */
function numberField(value: unknown, key: string): number {
	if (value && typeof value === "object" && key in value) {
		const raw = (value as Record<string, unknown>)[key];
		if (typeof raw === "number") return raw;
	}
	return 0;
}

async function portResponds(port: number, timeoutMs = 700): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return false;
		const body: unknown = await res.json();
		if (body && typeof body === "object" && "ok" in body) return body.ok === true;
		return false;
	} catch {
		return false;
	}
}

let localHandle: { stop(): void } | null = null;
let localStarting: Promise<boolean> | null = null;
let activeLocalPort: number | null = null;

/** Port currently serving the local collector, or null when not running. */
export function activeLocalCollectorPort(): number | null {
	return activeLocalPort;
}

/**
 * Start the local collector extension if it isn't already serving. Idempotent
 * and single-flight; returns whether loopback is answering. Never throws.
 */
export async function ensureLocalCollector(settings: Settings | undefined): Promise<boolean> {
	const port = settings?.get("dev.autoqa.collector.localPort") ?? 8791;
	if (await portResponds(port)) {
		activeLocalPort = port;
		return true;
	}
	if (localStarting) return localStarting;
	const starting = (async () => {
		try {
			const binary = findCollectorBinary(settings?.get("dev.autoqa.collector.binaryPath"));
			if (!binary) {
				logger.warn("ompk-collector binary not found; local collector unavailable");
				return false;
			}
			const args: string[] = [
				binary,
				"--dir",
				getAutoQaCollectorDir(),
				"serve",
				"--bind",
				"127.0.0.1",
				"--port",
				String(port),
				"--advertise",
				"127.0.0.1",
			];
			let proc: Bun.Subprocess;
			try {
				proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
			} catch (error) {
				logger.warn("ompk-collector not installed; local collector unavailable", { error: String(error) });
				return false;
			}
			localHandle = { stop: () => proc.kill() };
			// Poll for readiness rather than blocking on a fixed sleep.
			for (let i = 0; i < 20; i++) {
				if (await portResponds(port)) {
					activeLocalPort = port;
					logger.info("autoqa local collector listening", { port });
					return true;
				}
				await Bun.sleep(100);
			}
			logger.warn("autoqa local collector did not become ready", { port });
			return false;
		} catch (error) {
			logger.debug("autoqa local collector start failed", { error: String(error) });
			return false;
		}
	})();
	localStarting = starting;
	try {
		return await starting;
	} finally {
		localStarting = null;
	}
}

/** Stop the local collector if this session started it. */
export function stopLocalCollector(): void {
	localHandle?.stop();
	localHandle = null;
	activeLocalPort = null;
}

export interface CollectorTarget {
	url: string;
	token: string;
}

/**
 * Resolve where reports should be pushed for the current mode, or null when
 * the collector is off / not yet usable. `local` starts the extension on
 * demand; `remote` reads the paired URL + token.
 */
export async function resolveCollectorTarget(settings: Settings | undefined): Promise<CollectorTarget | null> {
	const mode = resolveCollectorMode(settings);
	if (mode === "off") return null;
	if (mode === "remote") {
		const url = settings?.get("dev.autoqa.collector.remoteUrl")?.trim();
		const token = settings?.get("dev.autoqa.collector.remoteToken")?.trim();
		if (!url || !token) return null;
		return { url, token };
	}
	const port = settings?.get("dev.autoqa.collector.localPort") ?? 8791;
	if (!(await ensureLocalCollector(settings))) return null;
	const token = ensureLocalCollectorToken();
	if (!token) return null;
	return { url: localCollectorUrl(port), token };
}

/** Probe a collector's /status endpoint for the pair command and settings UI. */
export async function probeRemoteCollector(
	url: string,
	token: string,
	timeoutMs = 5000,
): Promise<{ ok: true; reports: number; groups: number } | { ok: false; error: string }> {
	try {
		const base = url.replace(/\/v1\/grievances\/?$/, "").replace(/\/$/, "");
		const res = await fetch(`${base}/status`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.status === 401) return { ok: false, error: "unauthorized — token rejected by the collector" };
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
		const body: unknown = await res.json();
		return { ok: true, reports: numberField(body, "reports"), groups: numberField(body, "groups") };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
}

/** Count locally recorded reports still awaiting a successful push. */
export function countUnpushedReports(dbPath = getAutoQaDbDir()): number {
	try {
		const db = new Database(dbPath);
		try {
			const row: unknown = db.query("SELECT COUNT(*) AS c FROM grievances WHERE pushed = 0").get();
			if (row && typeof row === "object" && "c" in row && typeof row.c === "number") return row.c;
			return 0;
		} finally {
			db.close();
		}
	} catch {
		return 0;
	}
}
