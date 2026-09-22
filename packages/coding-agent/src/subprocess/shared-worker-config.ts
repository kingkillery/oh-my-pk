import * as os from "node:os";
import * as path from "node:path";
import { getWorkerSocketDir, isBunTestRuntime, VERSION } from "@pk-nerdsaver-ai/pi-utils";

/** `"0"`/`"false"` forces one subprocess per instance; default on, except under `bun test`. */
export const SHARED_WORKERS_ENV = "OMP_SHARED_WORKERS";
/** Daemon exits after this long with zero connected clients. */
export const DAEMON_IDLE_ENV = "OMP_WORKER_DAEMON_IDLE_MS";
export const DAEMON_HEARTBEAT_ENV = "OMP_WORKER_DAEMON_HEARTBEAT_MS";
export const DAEMON_LEASE_ENV = "OMP_WORKER_DAEMON_LEASE_MS";
export const DAEMON_HEALTH_INTERVAL_ENV = "OMP_WORKER_DAEMON_HEALTH_INTERVAL_MS";
export const DAEMON_MAX_AGE_ENV = "OMP_WORKER_DAEMON_MAX_AGE_MS";
export const DAEMON_REQUEST_TIMEOUT_ENV = "OMP_WORKER_DAEMON_REQUEST_TIMEOUT_MS";
export const DAEMON_MAX_PRIVATE_MB_ENV = "OMP_WORKER_DAEMON_MAX_PRIVATE_MB";
/** Cold-start budget for the compiled binary to bind its socket. */
export const DAEMON_CONNECT_TIMEOUT_MS = 20_000;
export const DEFAULT_DAEMON_IDLE_MS = 10 * 60 * 1000;
export const DEFAULT_DAEMON_HEARTBEAT_MS = 30_000;
export const DEFAULT_DAEMON_LEASE_MS = 2 * 60 * 1000;
export const DEFAULT_DAEMON_HEALTH_INTERVAL_MS = 10_000;
export const DEFAULT_DAEMON_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_DAEMON_MAX_PRIVATE_BYTES = 4 * 1024 * 1024 * 1024;
/** Linux `sun_path` is 108 bytes; keep a margin for the NUL and platform quirks. */
const MAX_SOCKET_PATH_LEN = 100;

export type SharedWorkerKind = "tiny" | "embed";

export function sharedWorkersEnabled(): boolean {
	const raw = Bun.env[SHARED_WORKERS_ENV]?.trim().toLowerCase();
	if (raw === "0" || raw === "false") return false;
	if (raw === "1" || raw === "true") return true;
	return !isBunTestRuntime();
}

export function resolveDaemonIdleMs(): number {
	const raw = Bun.env[DAEMON_IDLE_ENV];
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return DEFAULT_DAEMON_IDLE_MS;
}

export interface DaemonLifecyclePolicy {
	heartbeatMs: number;
	leaseMs: number;
	healthIntervalMs: number;
	maxAgeMs: number;
	requestTimeoutMs: number;
	maxPrivateBytes: number;
}

function positiveEnvMs(envName: string): number | undefined {
	const raw = Bun.env[envName];
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveDaemonLifecyclePolicy(): DaemonLifecyclePolicy {
	const heartbeatMs = positiveEnvMs(DAEMON_HEARTBEAT_ENV) ?? DEFAULT_DAEMON_HEARTBEAT_MS;
	const leaseMs = positiveEnvMs(DAEMON_LEASE_ENV) ?? DEFAULT_DAEMON_LEASE_MS;
	let maxPrivateBytes = DEFAULT_DAEMON_MAX_PRIVATE_BYTES;
	const maxPrivateRaw = Bun.env[DAEMON_MAX_PRIVATE_MB_ENV];
	if (maxPrivateRaw !== undefined) {
		const parsed = Number.parseInt(maxPrivateRaw, 10);
		if (Number.isFinite(parsed) && parsed >= 0) maxPrivateBytes = parsed * 1024 * 1024;
	}
	return {
		heartbeatMs,
		leaseMs: Math.max(leaseMs, heartbeatMs * 2),
		healthIntervalMs: positiveEnvMs(DAEMON_HEALTH_INTERVAL_ENV) ?? DEFAULT_DAEMON_HEALTH_INTERVAL_MS,
		maxAgeMs: positiveEnvMs(DAEMON_MAX_AGE_ENV) ?? DEFAULT_DAEMON_MAX_AGE_MS,
		requestTimeoutMs: positiveEnvMs(DAEMON_REQUEST_TIMEOUT_ENV) ?? DEFAULT_DAEMON_REQUEST_TIMEOUT_MS,
		maxPrivateBytes,
	};
}

/**
 * Socket path for a worker kind + config fingerprint. VERSION is folded in so a
 * binary upgrade never talks to a stale daemon (the stale one exits on idle).
 * Falls back to os.tmpdir() when the config-root path would exceed sun_path.
 */
export function workerSocketPath(kind: SharedWorkerKind, fingerprint: string): string {
	const safeFingerprint = fingerprint.replace(/[^A-Za-z0-9._-]+/g, "_");
	const name = `${kind}-${VERSION}-${safeFingerprint}.sock`;
	const preferred = path.join(getWorkerSocketDir(), name);
	return preferred.length <= MAX_SOCKET_PATH_LEN ? preferred : path.join(os.tmpdir(), `ompk-${name}`);
}

/**
 * Sidecar claimed (`wx`) by the one client allowed to spawn the daemon for a
 * socket; the daemon deletes it once bound. Shared by client and daemon so the
 * two sides never disagree on the path.
 */
export function spawnLockPath(socketPath: string): string {
	return `${socketPath}.spawning`;
}
