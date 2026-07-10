import { describe, expect, it } from "bun:test";

import { type CaptureOptions, CaptureService } from "../src/context";
import { isAllowedWebSocketOrigin, isLoopbackHostname, TagGatewayServer } from "../src/gateway";
import type { AgentEvent, AgentWorker, ApprovalDecision, ContextPacket, SessionHandle, TaskInput } from "../src/types";

class FixedCaptureService extends CaptureService {
	override async capture(options: CaptureOptions): Promise<ContextPacket> {
		return {
			captureId: crypto.randomUUID(),
			timestamp: new Date().toISOString(),
			userRequest: options.userRequest,
			captureMode: options.mode,
			visual: { displayScale: 1, annotations: [] },
			foregroundApp: {},
			browser: {},
			selection: {},
			availableCapabilities: [],
		};
	}
}

class RecordingWorker implements AgentWorker {
	readonly sessions: string[] = [];
	readonly cancellations: string[] = [];
	readonly #subscriptionClosers = new Map<string, () => void>();
	readonly #cancelled = new Set<string>();
	readonly #sessionWaiters: Array<(sessionId: string) => void> = [];
	readonly #cancellationWaiters: Array<(sessionId: string) => void> = [];

	async createSession(taskId: string, _input: TaskInput): Promise<SessionHandle> {
		this.sessions.push(taskId);
		this.#sessionWaiters.shift()?.(taskId);
		return { sessionId: taskId };
	}

	nextSession(): Promise<string> {
		const next = Promise.withResolvers<string>();
		this.#sessionWaiters.push(next.resolve);
		return next.promise;
	}

	nextCancellation(): Promise<string> {
		const next = Promise.withResolvers<string>();
		this.#cancellationWaiters.push(next.resolve);
		return next.promise;
	}

	async sendMessage(_sessionId: string, _message: string): Promise<void> {}

	async approve(_sessionId: string, _actionId: string, _decision: ApprovalDecision): Promise<void> {}

	async cancel(sessionId: string): Promise<void> {
		if (this.#cancelled.has(sessionId)) return;
		this.#cancelled.add(sessionId);
		this.cancellations.push(sessionId);
		this.#cancellationWaiters.shift()?.(sessionId);
		this.#subscriptionClosers.get(sessionId)?.();
		this.#subscriptionClosers.delete(sessionId);
	}

	subscribe(sessionId: string): AsyncIterable<AgentEvent> {
		const closed = Promise.withResolvers<void>();
		this.#subscriptionClosers.set(sessionId, closed.resolve);
		return {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<AgentEvent>> {
						await closed.promise;
						return { done: true, value: undefined };
					},
				};
			},
		};
	}
}

async function connect(url: string): Promise<WebSocket> {
	const opened = Promise.withResolvers<void>();
	const ws = new WebSocket(`${url.replace("http:", "ws:")}/ws`);
	ws.addEventListener("open", () => opened.resolve(), { once: true });
	ws.addEventListener("error", () => opened.reject(new Error("WebSocket connection failed")), { once: true });
	await opened.promise;
	return ws;
}

describe("gateway network security", () => {
	it("accepts only explicit loopback bind hosts", () => {
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("LOCALHOST")).toBe(true);
		expect(isLoopbackHostname("::1")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("0.0.0.0")).toBe(false);
		expect(isLoopbackHostname("192.168.1.10")).toBe(false);

		const gateway = new TagGatewayServer({ port: 0, hostname: "0.0.0.0" });
		expect(() => gateway.start()).toThrow("must bind to a loopback host");
	});

	it("allows native clients and only the gateway's HTTP loopback origin", () => {
		expect(isAllowedWebSocketOrigin(null, 18087)).toBe(true);
		expect(isAllowedWebSocketOrigin("http://localhost:18087", 18087)).toBe(true);
		expect(isAllowedWebSocketOrigin("http://127.0.0.1:18087", 18087)).toBe(true);
		expect(isAllowedWebSocketOrigin("http://[::1]:18087", 18087)).toBe(true);
		expect(isAllowedWebSocketOrigin("https://localhost:18087", 18087)).toBe(false);
		expect(isAllowedWebSocketOrigin("http://localhost:18088", 18087)).toBe(false);
		expect(isAllowedWebSocketOrigin("http://localhost:18087/not-an-origin", 18087)).toBe(false);
		expect(isAllowedWebSocketOrigin("https://attacker.example", 18087)).toBe(false);
		expect(isAllowedWebSocketOrigin("not an origin", 18087)).toBe(false);
	});

	it("rejects cross-site WebSocket and capture requests", async () => {
		const gateway = new TagGatewayServer({ port: 0 });
		gateway.start();
		try {
			const headers = { Origin: "https://attacker.example" };
			const websocketResponse = await fetch(`${gateway.url}/ws`, { headers });
			expect(websocketResponse.status).toBe(403);
			const captureResponse = await fetch(`${gateway.url}/api/capture`, {
				method: "POST",
				headers,
				body: JSON.stringify({ mode: "screen", userRequest: "capture the victim's screen" }),
			});
			expect(captureResponse.status).toBe(403);
		} finally {
			gateway.stop();
		}
	});
});

describe("gateway task lifecycle", () => {
	it("cancels replaced and disconnected tasks", async () => {
		const worker = new RecordingWorker();
		const gateway = new TagGatewayServer({ port: 0, captureService: new FixedCaptureService(), worker });
		gateway.start();
		const ws = await connect(gateway.url);

		try {
			const firstSession = worker.nextSession();
			ws.send(JSON.stringify({ type: "capture", mode: "screen", userRequest: "explain first" }));
			const firstTaskId = await firstSession;

			const replacedTask = worker.nextCancellation();
			const secondSession = worker.nextSession();
			ws.send(JSON.stringify({ type: "capture", mode: "screen", userRequest: "explain second" }));
			const [replacedTaskId, secondTaskId] = await Promise.all([replacedTask, secondSession]);
			expect(replacedTaskId).toBe(firstTaskId);

			const disconnectedTask = worker.nextCancellation();
			ws.close();
			expect(await disconnectedTask).toBe(secondTaskId);
			expect(worker.cancellations.filter(taskId => taskId === firstTaskId)).toHaveLength(1);
			expect(worker.cancellations.filter(taskId => taskId === secondTaskId)).toHaveLength(1);
		} finally {
			ws.close();
			gateway.stop();
		}
	});

	it("renders approval content only through text nodes", async () => {
		const html = await Bun.file(new URL("../src/overlay.html", import.meta.url)).text();
		expect(html).not.toContain("innerHTML");
		expect(html).toContain("tool.textContent = String(req.toolName");
		expect(html).toContain("effects.textContent = String(req.effects");
		expect(html).toContain("argumentsEl.textContent = JSON.stringify(req.arguments");
	});
});
