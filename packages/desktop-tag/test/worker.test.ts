import { describe, expect, it, mock } from "bun:test";

import type { CreateAgentSessionResult } from "@pk-nerdsaver-ai/pi-coding-agent";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import type { ClientBridge } from "@pk-nerdsaver-ai/pi-coding-agent/session/client-bridge";

import type { TaskInput } from "../src/types";
import { PiWorker } from "../src/worker";

class FakeAgentSession {
	readonly promptResult = Promise.withResolvers<boolean>();
	readonly abort = mock(async () => {
		this.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
	});
	readonly dispose = mock(async () => {
		this.promptResult.resolve(false);
	});
	readonly steer = mock(async () => {});
	readonly followUp = mock(async () => {});
	readonly newSession = mock(async () => true);
	readonly sessionManager = { getCwd: () => "/test" };
	readonly sessionFile = undefined;
	readonly sessionId = "fake-session";
	readonly thinkingLevel = undefined;
	readonly model = undefined;
	isStreaming = true;
	bridge: ClientBridge | undefined;
	readonly #listeners: AgentSessionEventListener[] = [];

	prompt(): Promise<boolean> {
		return this.promptResult.promise;
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#listeners.push(listener);
		return () => {
			const index = this.#listeners.indexOf(listener);
			if (index >= 0) this.#listeners.splice(index, 1);
		};
	}

	setClientBridge(bridge: ClientBridge): void {
		this.bridge = bridge;
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.#listeners]) listener(event);
	}
}

const taskInput: TaskInput = {
	contextPacket: {
		captureId: "capture-1",
		timestamp: "2026-07-10T00:00:00.000Z",
		userRequest: "Inspect the screen",
		captureMode: "screen",
		visual: { displayScale: 1, annotations: [] },
		foregroundApp: {},
		browser: {},
		selection: {},
		availableCapabilities: [],
	},
	routing: {
		executorId: "pi-agent",
		tools: [],
		requiredApprovalLevel: 0,
		message: "Use pi-agent",
	},
};

function createWorker(): { worker: PiWorker; session: FakeAgentSession } {
	const session = new FakeAgentSession();
	const worker = new PiWorker(async () => ({ session }) as unknown as CreateAgentSessionResult);
	return { worker, session };
}

describe("PiWorker lifecycle", () => {
	it("waits for agent_end instead of completing on an assistant message", async () => {
		const { worker, session } = createWorker();
		const handle = await worker.createSession("task-final", taskInput);
		const events = worker.subscribe(handle.sessionId)[Symbol.asyncIterator]();

		session.emit({ type: "agent_start" } as AgentSessionEvent);
		expect(await events.next()).toEqual({ done: false, value: { type: "task.started", taskId: "task-final" } });

		session.emit({
			type: "message_end",
			message: { role: "assistant", stopReason: "toolUse" },
		} as unknown as AgentSessionEvent);
		session.emit({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "read",
			args: {},
		} as unknown as AgentSessionEvent);
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "tool.started", callId: "call-1", toolName: "read" },
		});

		session.emit({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: undefined,
			isError: false,
		} as unknown as AgentSessionEvent);
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "tool.completed", callId: "call-1", result: null, isError: false },
		});

		session.isStreaming = false;
		session.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "task.completed", taskId: "task-final", summary: "" },
		});
		expect(await events.next()).toEqual({ done: true, value: undefined });
		expect(() => worker.subscribe(handle.sessionId)).toThrow("Session task-final not found");
	});

	it("keeps approval replies available until final agent settlement", async () => {
		const { worker, session } = createWorker();
		const handle = await worker.createSession("task-approval", taskInput);
		const events = worker.subscribe(handle.sessionId)[Symbol.asyncIterator]();
		const approval = session.bridge?.requestPermission?.(
			{ toolCallId: "approval-live", toolName: "write", title: "Write file", rawInput: { path: "result.txt" } },
			[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		);
		if (!approval) throw new Error("Permission bridge was not installed");
		expect(await events.next()).toMatchObject({ done: false, value: { type: "approval.requested" } });

		await worker.approve(handle.sessionId, "approval-live", { allowed: true, scope: "once" });
		expect(await approval).toEqual({ outcome: "selected", optionId: "allow_once" });
		expect(worker.subscribe(handle.sessionId)).toBeDefined();

		session.emit({ type: "agent_end", messages: [] } as AgentSessionEvent);
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "task.completed", taskId: "task-approval", summary: "" },
		});
	});

	it("cancels active execution, settles once, and releases the session", async () => {
		const { worker, session } = createWorker();
		const handle = await worker.createSession("task-cancel", taskInput);
		const events = worker.subscribe(handle.sessionId)[Symbol.asyncIterator]();
		const approval = session.bridge?.requestPermission?.(
			{ toolCallId: "approval-1", toolName: "bash", title: "Run command", rawInput: { command: "sleep" } },
			[{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }],
		);
		if (!approval) throw new Error("Permission bridge was not installed");
		expect(await events.next()).toEqual({
			done: false,
			value: {
				type: "approval.requested",
				request: {
					actionId: "approval-1",
					stepId: "approval-1",
					toolName: "bash",
					arguments: { command: "sleep" },
					effects: "Run command",
					level: 1,
					scope: "once",
				},
			},
		});

		await worker.cancel(handle.sessionId);
		expect(await approval).toEqual({ outcome: "cancelled" });
		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(session.dispose).toHaveBeenCalledTimes(1);
		expect(await events.next()).toEqual({
			done: false,
			value: { type: "task.failed", taskId: "task-cancel", error: "Task cancelled." },
		});
		expect(await events.next()).toEqual({ done: true, value: undefined });

		await worker.cancel(handle.sessionId);
		expect(session.abort).toHaveBeenCalledTimes(1);
		expect(session.dispose).toHaveBeenCalledTimes(1);
		expect(() => worker.subscribe(handle.sessionId)).toThrow("Session task-cancel not found");
	});
});
