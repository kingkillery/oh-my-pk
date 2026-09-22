import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import {
	DAEMON_HEARTBEAT_TYPE,
	NdjsonLineBuffer,
} from "@pk-nerdsaver-ai/pi-coding-agent/subprocess/shared-worker-client";
import {
	type DaemonExitReason,
	type DaemonScheduler,
	runSocketDaemonWorker,
	splitDaemonId,
	type WorkerTransport,
} from "@pk-nerdsaver-ai/pi-coding-agent/subprocess/worker-daemon";
import type { Socket } from "bun";

type In =
	| { type: "ping"; id: string }
	| { type: "complete"; id: string; text: string }
	| { type: "nudge" }
	| { type: typeof DAEMON_HEARTBEAT_TYPE };
type Out =
	| { type: "pong"; id: string }
	| { type: "completion"; id: string; text: string }
	| { type: "progress"; id: string; note: string }
	| { type: "log"; msg: string };

function tmpSocketPath(tag: string): string {
	return path.join(os.tmpdir(), `ompk-wd-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

/** Fake worker: echoes with the id it was handed so the test can prove remapping. */
function fakeWorker(transport: WorkerTransport<In, Out>): void {
	transport.onMessage(msg => {
		if (msg.type === "ping") transport.send({ type: "pong", id: msg.id });
		else if (msg.type === "complete") transport.send({ type: "completion", id: msg.id, text: `ok:${msg.id}` });
		else if (msg.type === "nudge") transport.send({ type: "log", msg: "broadcast" });
	});
}

interface TestClient {
	socket: Socket;
	received: Out[];
	closed: Promise<void>;
	next(): Promise<Out>;
	send(msg: In): void;
}

async function connectClient(socketPath: string): Promise<TestClient> {
	const received: Out[] = [];
	const waiters: Array<(m: Out) => void> = [];
	const closed = Promise.withResolvers<void>();
	const lines = new NdjsonLineBuffer();
	const socket = await Bun.connect({
		unix: socketPath,
		socket: {
			data(_s, chunk) {
				for (const line of lines.push(chunk)) {
					const msg = JSON.parse(line) as Out;
					const waiter = waiters.shift();
					if (waiter) waiter(msg);
					else received.push(msg);
				}
			},
			close() {
				closed.resolve();
			},
		},
	});
	return {
		socket,
		received,
		closed: closed.promise,
		next() {
			const queued = received.shift();
			if (queued) return Promise.resolve(queued);
			const { promise, resolve } = Promise.withResolvers<Out>();
			waiters.push(resolve);
			return promise;
		},
		send(msg) {
			socket.write(`${JSON.stringify(msg)}\n`);
		},
	};
}

class FakeScheduler implements DaemonScheduler {
	#now = 0;
	#nextTimerId = 0;
	#timeouts = new Map<number, { at: number; callback: () => void }>();
	#intervals = new Map<number, { callback: () => void }>();

	now(): number {
		return this.#now;
	}
	setTimeout(callback: () => void, ms: number): Timer {
		const id = ++this.#nextTimerId;
		this.#timeouts.set(id, { at: this.#now + ms, callback });
		return id as unknown as Timer;
	}
	clearTimeout(timer: Timer | undefined): void {
		this.#timeouts.delete(timer as unknown as number);
	}
	setInterval(callback: () => void, _ms: number): Timer {
		const id = ++this.#nextTimerId;
		this.#intervals.set(id, { callback });
		return id as unknown as Timer;
	}
	clearInterval(timer: Timer | undefined): void {
		this.#intervals.delete(timer as unknown as number);
	}
	advance(ms: number): void {
		const target = this.#now + ms;
		while (true) {
			let dueId: number | undefined;
			let dueAt = Number.POSITIVE_INFINITY;
			for (const [id, timeout] of this.#timeouts) {
				if (timeout.at <= target && timeout.at < dueAt) {
					dueId = id;
					dueAt = timeout.at;
				}
			}
			if (dueId === undefined) break;
			const due = this.#timeouts.get(dueId);
			this.#timeouts.delete(dueId);
			this.#now = dueAt;
			due?.callback();
		}
		this.#now = target;
	}
	tick(): void {
		for (const interval of [...this.#intervals.values()]) interval.callback();
	}
}

const TEST_POLICY = {
	heartbeatMs: 50,
	leaseMs: 100,
	healthIntervalMs: 50,
	maxAgeMs: 500,
	requestTimeoutMs: 300,
	maxPrivateBytes: 0,
} as const;

const openClients: Socket[] = [];
afterEach(() => {
	for (const s of openClients.splice(0)) s.end();
});

describe("splitDaemonId", () => {
	it("separates the client sequence from the original id, keeping later colons", () => {
		expect(splitDaemonId("7:abc:def")).toEqual({ clientSeq: 7, originalId: "abc:def" });
		expect(splitDaemonId("nocolon")).toBeUndefined();
		expect(splitDaemonId(":1")).toBeUndefined();
	});
});

describe("runSocketDaemonWorker", () => {
	it("routes replies to the originating client with the client's own id and broadcasts logs", async () => {
		const socketPath = tmpSocketPath("route");
		// Never resolves by design; the daemon serves until the process exits.
		void runSocketDaemonWorker<In, Out>(socketPath, fakeWorker, 60_000, { onIdleExit() {} });

		const a = await connectClient(socketPath);
		const b = await connectClient(socketPath);
		openClients.push(a.socket, b.socket);

		// Both clients use id "1" — only remapping keeps their replies apart.
		a.send({ type: "complete", id: "1", text: "from-a" });
		b.send({ type: "complete", id: "1", text: "from-b" });

		const [ra, rb] = await Promise.all([a.next(), b.next()]);
		expect(ra).toEqual({ type: "completion", id: "1", text: "ok:1:1" });
		expect(rb).toEqual({ type: "completion", id: "1", text: "ok:2:1" });

		a.send({ type: "nudge" });
		const [la, lb] = await Promise.all([a.next(), b.next()]);
		expect(la).toEqual({ type: "log", msg: "broadcast" });
		expect(lb).toEqual({ type: "log", msg: "broadcast" });
	});

	it("drops replies for a client that disconnected before the worker answered", async () => {
		const socketPath = tmpSocketPath("drop");
		let capturedTransport: WorkerTransport<In, Out> | undefined;
		void runSocketDaemonWorker<In, Out>(
			socketPath,
			transport => {
				capturedTransport = transport;
				transport.onMessage(() => {});
			},
			60_000,
			{ onIdleExit() {} },
		);

		const gone = await connectClient(socketPath);
		const stays = await connectClient(socketPath);
		openClients.push(stays.socket);
		gone.socket.end();

		// Reply addressed to the departed client 1 must be dropped; the surviving
		// client 2 must still receive its own reply afterwards.
		capturedTransport?.send({ type: "pong", id: "1:late" });
		capturedTransport?.send({ type: "pong", id: "2:mine" });
		expect(await stays.next()).toEqual({ type: "pong", id: "mine" });
		expect(stays.received).toEqual([]);
	});
});

describe("runSocketDaemonWorker lifecycle", () => {
	const leasePolicy = { ...TEST_POLICY, heartbeatMs: 10, leaseMs: 100, maxAgeMs: 60_000, requestTimeoutMs: 30_000 };

	it("renews the client lease on heartbeat and traffic frames without dispatching heartbeats to the worker", async () => {
		const socketPath = tmpSocketPath("lease");
		const scheduler = new FakeScheduler();
		const exits: DaemonExitReason[] = [];
		const dispatched: In[] = [];
		void runSocketDaemonWorker<In, Out>(
			socketPath,
			transport => {
				transport.onMessage(message => dispatched.push(message));
			},
			100,
			{ scheduler, onExit: reason => exits.push(reason), policy: leasePolicy },
		);

		const client = await connectClient(socketPath);
		openClients.push(client.socket);

		scheduler.advance(90);
		client.send({ type: DAEMON_HEARTBEAT_TYPE });
		await Bun.sleep(30);
		scheduler.advance(60);
		client.send({ type: "nudge" });
		await Bun.sleep(30);
		scheduler.advance(60);
		scheduler.tick();

		expect(exits).toEqual([]);
		expect(dispatched).toEqual([{ type: "nudge" }]);

		scheduler.advance(60);
		scheduler.tick();
		await client.closed;
		scheduler.advance(100);
		expect(exits).toEqual(["idle"]);
	});

	it("expires a represented socket that never sends another frame, then exits idle after the grace", async () => {
		const socketPath = tmpSocketPath("expire");
		const scheduler = new FakeScheduler();
		const exits: DaemonExitReason[] = [];
		void runSocketDaemonWorker<In, Out>(socketPath, fakeWorker, 100, {
			scheduler,
			onExit: reason => exits.push(reason),
			policy: leasePolicy,
		});

		const client = await connectClient(socketPath);
		openClients.push(client.socket);

		scheduler.advance(150);
		scheduler.tick();
		await client.closed;
		expect(exits).toEqual([]);

		scheduler.advance(100);
		expect(exits).toEqual(["idle"]);

		scheduler.advance(1000);
		scheduler.tick();
		expect(exits).toEqual(["idle"]);
	});

	it("exits max-age at the rotation deadline despite a lease-healthy client", async () => {
		const socketPath = tmpSocketPath("rotate");
		const scheduler = new FakeScheduler();
		const exits: DaemonExitReason[] = [];
		void runSocketDaemonWorker<In, Out>(socketPath, fakeWorker, 100, {
			scheduler,
			onExit: reason => exits.push(reason),
			policy: TEST_POLICY,
		});

		const client = await connectClient(socketPath);
		openClients.push(client.socket);

		scheduler.advance(450);
		client.send({ type: DAEMON_HEARTBEAT_TYPE });
		await Bun.sleep(30);
		scheduler.advance(60);
		scheduler.tick();

		expect(exits).toEqual(["max-age"]);
	});

	it("exits request-timeout when one forwarded request is never answered", async () => {
		const socketPath = tmpSocketPath("timeout");
		const scheduler = new FakeScheduler();
		const exits: DaemonExitReason[] = [];
		void runSocketDaemonWorker<In, Out>(
			socketPath,
			transport => {
				transport.onMessage(() => {});
			},
			100,
			{ scheduler, onExit: reason => exits.push(reason), policy: TEST_POLICY },
		);

		const client = await connectClient(socketPath);
		openClients.push(client.socket);
		client.send({ type: "complete", id: "stuck", text: "never answered" });
		await Bun.sleep(30);

		scheduler.advance(300);
		scheduler.tick();
		expect(exits).toEqual(["request-timeout"]);
	});

	it("exits memory-limit at the private-commit ceiling even with work in flight", async () => {
		const socketPath = tmpSocketPath("memory");
		const scheduler = new FakeScheduler();
		const exits: DaemonExitReason[] = [];
		void runSocketDaemonWorker<In, Out>(
			socketPath,
			transport => {
				transport.onMessage(() => {});
			},
			100,
			{
				scheduler,
				onExit: reason => exits.push(reason),
				policy: { ...TEST_POLICY, maxPrivateBytes: 1024 },
				privateBytes: () => 2048,
			},
		);

		const client = await connectClient(socketPath);
		openClients.push(client.socket);
		client.send({ type: "complete", id: "big", text: "still running" });
		await Bun.sleep(30);

		scheduler.tick();
		expect(exits).toEqual(["memory-limit"]);
	});

	it("keeps a request in flight through progress frames until a terminal response", async () => {
		const socketPath = tmpSocketPath("terminal");
		const scheduler = new FakeScheduler();
		const exits: DaemonExitReason[] = [];
		let capturedTransport: WorkerTransport<In, Out> | undefined;
		void runSocketDaemonWorker<In, Out>(
			socketPath,
			transport => {
				capturedTransport = transport;
				transport.onMessage(() => {});
			},
			100,
			{ scheduler, onExit: reason => exits.push(reason), policy: TEST_POLICY },
		);

		const client = await connectClient(socketPath);
		openClients.push(client.socket);
		client.send({ type: "complete", id: "g1", text: "long work" });
		await Bun.sleep(30);

		capturedTransport?.send({ type: "progress", id: "1:g1", note: "half" });
		expect(await client.next()).toEqual({ type: "progress", id: "g1", note: "half" });
		scheduler.advance(300);
		scheduler.tick();
		expect(exits).toEqual(["request-timeout"]);
	});

	it("settles in-flight state on the terminal response so max-age exits cleanly", async () => {
		const socketPath = tmpSocketPath("settle");
		const scheduler = new FakeScheduler();
		const exits: DaemonExitReason[] = [];
		let capturedTransport: WorkerTransport<In, Out> | undefined;
		void runSocketDaemonWorker<In, Out>(
			socketPath,
			transport => {
				capturedTransport = transport;
				transport.onMessage(() => {});
			},
			100,
			{ scheduler, onExit: reason => exits.push(reason), policy: { ...TEST_POLICY, leaseMs: 1000 } },
		);

		const client = await connectClient(socketPath);
		openClients.push(client.socket);
		client.send({ type: "complete", id: "g1", text: "work" });
		await Bun.sleep(30);
		capturedTransport?.send({ type: "pong", id: "1:g1" });
		expect(await client.next()).toEqual({ type: "pong", id: "g1" });

		scheduler.advance(400);
		scheduler.tick();
		expect(exits).toEqual([]);

		scheduler.advance(150);
		scheduler.tick();
		expect(exits).toEqual(["max-age"]);
	});
});
