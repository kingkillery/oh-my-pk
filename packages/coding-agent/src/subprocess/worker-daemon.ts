import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import { isBunTestRuntime, logger } from "@pk-nerdsaver-ai/pi-utils";
import type { Socket, UnixSocketListener } from "bun";
import { DAEMON_HEARTBEAT_TYPE, NdjsonLineBuffer } from "./shared-worker-client";
import { type DaemonLifecyclePolicy, resolveDaemonLifecyclePolicy, spawnLockPath } from "./shared-worker-config";

/**
 * Daemon side of the shared inference worker. One process per worker kind
 * hosts the exact `start(transport)` function the IPC subprocess ran, but in
 * front of a Unix socket that multiplexes many ompk instances:
 *
 * - request ids are rewritten to `${clientSeq}:${originalId}` on the way in
 *   and restored on the way out, so each client's independent id counter
 *   never collides with another's;
 * - `log` messages (no id) are broadcast to every connected client;
 * - responses for a client that has since disconnected are dropped;
 * - with zero clients the process SIGKILLs itself after `idleMs` (hard kill on
 *   purpose: onnxruntime-node's NAPI finalizer must never run — see cli.ts).
 */
export const TINY_DAEMON_ARG = "__omp_daemon_tiny_inference";
export const MNEMOPI_EMBED_DAEMON_ARG = "__omp_daemon_mnemopi_embed";

/** Transport a worker `start` function drives; identical to the IPC worker contract in cli.ts. */
export interface WorkerTransport<In, Out> {
	send(message: Out): void;
	onMessage(handler: (message: In) => void): () => void;
}

export type WorkerStart<In, Out> = (transport: WorkerTransport<In, Out>) => void;

type Identified = { type: string; id?: unknown };

/** Split a daemon-internal id back into its client sequence and the client's original id. */
export function splitDaemonId(id: string): { clientSeq: number; originalId: string } | undefined {
	const colon = id.indexOf(":");
	if (colon <= 0) return undefined;
	const clientSeq = Number.parseInt(id.slice(0, colon), 10);
	if (!Number.isFinite(clientSeq)) return undefined;
	return { clientSeq, originalId: id.slice(colon + 1) };
}

export type DaemonExitReason = "idle" | "lease-expired" | "max-age" | "request-timeout" | "memory-limit";

export interface DaemonScheduler {
	now(): number;
	setTimeout(callback: () => void, ms: number): Timer;
	clearTimeout(timer: Timer | undefined): void;
	setInterval(callback: () => void, ms: number): Timer;
	clearInterval(timer: Timer | undefined): void;
}

const platformScheduler: DaemonScheduler = {
	now: () => performance.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: timer => clearTimeout(timer),
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: timer => clearInterval(timer),
};

export interface SocketDaemonOptions {
	/** Test seam: replace the SIGKILL-on-idle with an observable callback. */
	onIdleExit?: () => void;
	onExit?: (reason: DaemonExitReason) => void;
	scheduler?: DaemonScheduler;
	policy?: Partial<DaemonLifecyclePolicy>;
	privateBytes?: () => number | undefined;
}

const HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;

function windowsPrivateBytes(): number | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		const kernel32 = dlopen("kernel32.dll", {
			GetCurrentProcess: { args: [], returns: FFIType.ptr },
			K32GetProcessMemoryInfo: {
				args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
				returns: FFIType.bool,
			},
		});
		try {
			const counters = new Uint8Array(80);
			const view = new DataView(counters.buffer);
			view.setUint32(0, counters.byteLength, true);
			const ok = kernel32.symbols.K32GetProcessMemoryInfo(
				kernel32.symbols.GetCurrentProcess(),
				ptr(counters),
				counters.byteLength,
			);
			return ok ? Number(view.getBigUint64(72, true)) : undefined;
		} finally {
			kernel32.close();
		}
	} catch {
		return undefined;
	}
}

/**
 * Bind `socketPath`, host `start`, and never return. Exits 0 immediately when
 * the bind fails (another daemon won the spawn race — the spawner's connect
 * loop finds the winner).
 */
export async function runSocketDaemonWorker<In extends Identified, Out extends Identified>(
	socketPath: string,
	start: WorkerStart<In, Out>,
	idleMs: number,
	options: SocketDaemonOptions = {},
): Promise<never> {
	fs.mkdirSync(path.dirname(socketPath), { recursive: true });

	const scheduler = options.scheduler ?? platformScheduler;
	const policy: DaemonLifecyclePolicy = { ...resolveDaemonLifecyclePolicy(), ...options.policy };
	policy.leaseMs = Math.max(policy.leaseMs, policy.heartbeatMs * 2);
	const probePrivateBytes = options.privateBytes ?? windowsPrivateBytes;

	const clients = new Map<number, { socket: Socket<number>; lines: NdjsonLineBuffer; lastSeenAt: number }>();
	const inFlight = new Map<string, number>();
	const inboundHandlers = new Set<(message: In) => void>();
	const startedAt = scheduler.now();
	let nextClientSeq = 0;
	let requestCount = 0;
	let lastHealthLogAt = startedAt;
	let draining = false;
	let exiting = false;
	let listener: UnixSocketListener<number> | undefined;
	let idleTimer: Timer | undefined;
	let healthTimer: Timer | undefined;
	let keepalive: Timer | undefined;

	const removeSocketFile = (): void => {
		try {
			fs.rmSync(socketPath, { force: true });
		} catch {
			// Still bound on some platforms; the next spawner's stale-file cleanup handles it.
		}
	};

	function handleSignal(): void {
		removeSocketFile();
		process.exit(0);
	}

	const endClient = (client: { socket: Socket<number> }): void => {
		try {
			client.socket.end();
		} catch {}
	};

	const metrics = (): Record<string, unknown> => {
		const memory = process.memoryUsage();
		return {
			pid: process.pid,
			ageMs: Math.round(scheduler.now() - startedAt),
			clients: clients.size,
			inFlight: inFlight.size,
			requests: requestCount,
			heapUsed: memory.heapUsed,
			external: memory.external,
			arrayBuffers: memory.arrayBuffers,
			rss: memory.rss,
			privateBytes: probePrivateBytes(),
		};
	};

	const exit = (reason: DaemonExitReason): void => {
		if (exiting) return;
		exiting = true;
		const snapshot = reason === "idle" ? undefined : metrics();
		scheduler.clearTimeout(idleTimer);
		idleTimer = undefined;
		scheduler.clearInterval(healthTimer);
		healthTimer = undefined;
		if (keepalive !== undefined) {
			clearInterval(keepalive);
			keepalive = undefined;
		}
		removeSocketFile();
		try {
			listener?.stop(true);
		} catch {}
		for (const client of clients.values()) endClient(client);
		clients.clear();
		process.off("SIGTERM", handleSignal);
		process.off("SIGINT", handleSignal);
		if (reason === "idle") {
			logger.debug("worker-daemon: idle exit", { socketPath, idleMs });
		} else {
			logger.warn("worker-daemon: recycling daemon", { socketPath, reason, ...snapshot });
		}
		if (options.onExit) {
			options.onExit(reason);
			return;
		}
		if (reason === "idle" && options.onIdleExit) {
			options.onIdleExit();
			return;
		}
		process.kill(process.pid, "SIGKILL");
	};

	const armIdle = (): void => {
		if (exiting || draining) return;
		scheduler.clearTimeout(idleTimer);
		idleTimer = scheduler.setTimeout(() => {
			idleTimer = undefined;
			exit("idle");
		}, idleMs);
		if (isBunTestRuntime() && typeof idleTimer.unref === "function") idleTimer.unref();
	};
	const disarmIdle = (): void => {
		scheduler.clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	const writeTo = (socket: Socket<number>, message: unknown): void => {
		try {
			socket.write(`${JSON.stringify(message)}\n`);
		} catch {
			// The peer is gone; its close handler will drop it from the map.
		}
	};

	const transport: WorkerTransport<In, Out> = {
		send(message) {
			if (typeof message.id !== "string") {
				for (const client of clients.values()) writeTo(client.socket, message);
				return;
			}
			if (message.type !== "progress" && message.type !== "log") {
				if (inFlight.delete(message.id) && draining && inFlight.size === 0) exit("max-age");
			}
			const target = splitDaemonId(message.id);
			if (!target) return;
			const client = clients.get(target.clientSeq);
			if (!client) return;
			writeTo(client.socket, { ...message, id: target.originalId });
		},
		onMessage(handler) {
			inboundHandlers.add(handler);
			return () => inboundHandlers.delete(handler);
		},
	};

	const removeClient = (socket: Socket<number>): void => {
		for (const [seq, client] of clients) {
			if (client.socket === socket) {
				clients.delete(seq);
				break;
			}
		}
		if (clients.size === 0) armIdle();
	};

	const healthTick = (): void => {
		if (exiting) return;
		const now = scheduler.now();

		let expiredAny = false;
		for (const [seq, client] of clients) {
			if (now - client.lastSeenAt >= policy.leaseMs) {
				expiredAny = true;
				endClient(client);
				clients.delete(seq);
			}
		}
		if (expiredAny && clients.size === 0) armIdle();

		let oldest: number | undefined;
		for (const started of inFlight.values()) {
			if (oldest === undefined || started < oldest) oldest = started;
		}
		if (oldest !== undefined && now - oldest >= policy.requestTimeoutMs) {
			exit("request-timeout");
			return;
		}

		if (!draining && now - startedAt >= policy.maxAgeMs) {
			draining = true;
			for (const client of clients.values()) endClient(client);
			clients.clear();
		}
		if (draining && inFlight.size === 0) {
			exit("max-age");
			return;
		}

		const privateBytes = probePrivateBytes();
		if (policy.maxPrivateBytes > 0 && privateBytes !== undefined && privateBytes >= policy.maxPrivateBytes) {
			exit("memory-limit");
			return;
		}

		if (now - lastHealthLogAt >= HEALTH_LOG_INTERVAL_MS) {
			lastHealthLogAt = now;
			logger.debug("worker-daemon: health", { socketPath, ...metrics() });
		}
	};

	try {
		listener = Bun.listen<number>({
			unix: socketPath,
			socket: {
				open(socket) {
					if (draining || exiting) {
						socket.end();
						return;
					}
					disarmIdle();
					const seq = ++nextClientSeq;
					clients.set(seq, { socket, lines: new NdjsonLineBuffer(), lastSeenAt: scheduler.now() });
					socket.data = seq;
					logger.debug("worker-daemon: client connected", { socketPath, clientSeq: seq, clients: clients.size });
				},
				data(socket, chunk) {
					const seq = socket.data;
					const client = clients.get(seq);
					if (!client) return;
					for (const line of client.lines.push(chunk)) {
						client.lastSeenAt = scheduler.now();
						let message: In;
						try {
							message = JSON.parse(line) as In;
						} catch {
							continue;
						}
						if (message.type === DAEMON_HEARTBEAT_TYPE) continue;
						if (draining || exiting) continue;
						if (typeof message.id === "string") {
							const rewrittenId = `${seq}:${message.id}`;
							message = { ...message, id: rewrittenId };
							inFlight.set(rewrittenId, scheduler.now());
							requestCount += 1;
						}
						for (const handler of inboundHandlers) handler(message);
					}
				},
				close(socket) {
					removeClient(socket);
				},
				error(socket) {
					removeClient(socket);
				},
			},
		});
	} catch (err) {
		// Lost the bind race (or a live daemon already serves this path).
		logger.debug("worker-daemon: bind failed, yielding", {
			socketPath,
			error: err instanceof Error ? err.message : String(err),
		});
		process.exit(0);
	}

	// Bound: the spawner's claim is fulfilled, let future clients skip the spawn.
	fs.rmSync(spawnLockPath(socketPath), { force: true });
	logger.debug("worker-daemon: listening", { socketPath, idleMs });
	start(transport);

	// A spawner that dies before ever connecting must not leave an orphan.
	armIdle();

	healthTimer = scheduler.setInterval(healthTick, policy.healthIntervalMs);
	if (isBunTestRuntime() && typeof healthTimer.unref === "function") healthTimer.unref();

	process.on("SIGTERM", handleSignal);
	process.on("SIGINT", handleSignal);

	keepalive = setInterval(() => {}, 2 ** 30);
	if (isBunTestRuntime() && typeof keepalive.unref === "function") keepalive.unref();
	const { promise: forever } = Promise.withResolvers<never>();
	return forever;
}
