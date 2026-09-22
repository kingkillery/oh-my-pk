import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSession } from "../../src/session/agent-session";
import { createSubagentRunMonitor } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";

describe("SubagentRunMonitor Watchdog Integration", () => {
	const originalEnv = { ...process.env };
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		process.env = { ...originalEnv };
		globalThis.fetch = originalFetch;
	});

	const mockAgent: AgentDefinition = {
		name: "test-worker",
		description: "Test agent",
		systemPrompt: "You are a test agent",
		source: "bundled",
	};

	function createMockSession() {
		const listeners: Array<(event: unknown) => void> = [];
		const steeredMessages: unknown[] = [];
		let aborted = false;

		const session = {
			subscribe(fn: (event: unknown) => void) {
				listeners.push(fn);
				return () => {
					const idx = listeners.indexOf(fn);
					if (idx >= 0) listeners.splice(idx, 1);
				};
			},
			agent: {
				steer(msg: unknown) {
					steeredMessages.push(msg);
				},
			},
			abort() {
				aborted = true;
				return Promise.resolve();
			},
			getLastAssistantMessage() {
				return undefined;
			},
		} as unknown as AgentSession;

		return {
			session,
			steeredMessages,
			emit(event: unknown) {
				for (const listener of listeners) {
					listener(event);
				}
			},
			isSessionAborted: () => aborted,
		};
	}

	test("operates unhindered when unconfigured (zero breakage)", async () => {
		delete process.env.TYPESAFE_API_KEY;
		delete process.env.OPENROUTER_API_KEY;
		delete process.env.AI_GATEWAY_API_KEY;

		const monitor = createSubagentRunMonitor({
			index: 0,
			id: "sub-1",
			agent: mockAgent,
			task: "Refactor auth module",
			assignment: "Fix auth token refresh",
			softRequestBudget: 10,
			maxRuntimeMs: 0,
		});

		const mock = createMockSession();
		monitor.attach(mock.session);

		// Emit 3 consecutive failed edit tool executions
		for (let i = 0; i < 3; i++) {
			mock.emit({
				type: "tool_execution_start",
				toolName: "edit",
				toolArgs: { path: "src/auth.ts" },
			});
			mock.emit({
				type: "tool_execution_end",
				toolName: "edit",
				args: { path: "src/auth.ts" },
				isError: true,
				result: "Tag mismatch #1A2B",
			});
		}

		// Await pending microtasks
		await Promise.resolve();

		// Telemetry tap recorded actions
		expect(monitor.telemetryTap.recentActions.length).toBe(3);
		expect(monitor.telemetryTap.consecutiveErrors).toBe(3);

		// Watchdog did NOT abort or disrupt the run because no API key/endpoint is configured
		expect(monitor.isWatchdogAborted()).toBe(false);
		expect(monitor.abortSignal.aborted).toBe(false);
		expect(mock.isSessionAborted()).toBe(false);

		monitor.finish();
	});

	test("trips circuit breaker and aborts subagent when fatal wedged condition is detected", async () => {
		process.env.TYPESAFE_API_KEY = "test-sentinel-key";

		const mockJevResponse = {
			model: "jev-latest",
			provider: "TypeSafe",
			answers: {
				is_thrashing: { type: "noul", noul: 0.95 },
				stall_severity: { type: "score", score: 2.8, confidence: 0.95 },
				blocker_type: { type: "choice", choice: "syntax_or_tag_mismatch", confidence: 0.9 },
			},
		};

		const { promise: evalResolved, resolve: markEvalDone } = Promise.withResolvers<void>();

		globalThis.fetch = (() => {
			markEvalDone();
			return Promise.resolve(
				new Response(JSON.stringify(mockJevResponse), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const monitor = createSubagentRunMonitor({
			index: 0,
			id: "sub-2",
			agent: mockAgent,
			task: "Fix auth",
			assignment: "Fix auth",
			softRequestBudget: 10,
			maxRuntimeMs: 0,
		});

		const mock = createMockSession();
		monitor.attach(mock.session);
		monitor.setActiveSession(mock.session);

		// Emit 2 failed edits to trigger consecutiveErrors >= 2
		for (let i = 0; i < 2; i++) {
			mock.emit({
				type: "tool_execution_start",
				toolName: "edit",
				toolArgs: { path: "src/auth.ts" },
			});
			mock.emit({
				type: "tool_execution_end",
				toolName: "edit",
				args: { path: "src/auth.ts" },
				isError: true,
				result: "Tag mismatch #1A2B",
			});
		}

		// Await the evaluator call and reaction
		await evalResolved;
		// Await microtasks for arbitrator response
		await Promise.resolve();
		await Promise.resolve();

		expect(monitor.isWatchdogAborted()).toBe(true);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.resolveAbortReasonText()).toContain("System 1 Watchdog: Agent wedged");
		expect(monitor.resolveAbortReasonText()).toContain("syntax_or_tag_mismatch");
		expect(mock.isSessionAborted()).toBe(true);

		monitor.finish();
	});
});
