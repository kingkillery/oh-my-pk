import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { clearDecisionEndpointCache } from "../../src/lib/decision-endpoint-discovery";
import type { AgentSession } from "../../src/session/agent-session";
import { createSubagentRunMonitor, type SubagentRunMonitor } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";

const ENV_KEYS = [
	"TYPESAFE_API_KEY",
	"TYPESAFE_BASE_URL",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OMP_DECISION_DISCOVERY",
	"OMP_DECISION_ENDPOINT",
	"OMP_DECISION_MODEL",
] as const;

describe("SubagentRunMonitor Watchdog Integration", () => {
	let monitor: SubagentRunMonitor | undefined;
	let savedEnv: Record<string, string | undefined>;
	let fetchSpy: Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		process.env.OMP_DECISION_DISCOVERY = "off";
		clearDecisionEndpointCache();
		fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected watchdog request"));
	});

	afterEach(() => {
		monitor?.finish();
		monitor = undefined;
		fetchSpy.mockRestore();
		clearDecisionEndpointCache();
		// Preserve the environment object captured by the shared SystemOne client.
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
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
		const { promise: whenAborted, resolve: markAborted } = Promise.withResolvers<void>();

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
				markAborted();
				return Promise.resolve();
			},
			getLastAssistantMessage() {
				return undefined;
			},
		} as unknown as AgentSession;

		return {
			session,
			whenAborted,
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
		monitor = createSubagentRunMonitor({
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

		const { promise: requested, resolve: markRequested } = Promise.withResolvers<void>();
		const { promise: response, resolve: respond } = Promise.withResolvers<Response>();

		fetchSpy.mockImplementation(() => {
			markRequested();
			return response;
		});

		monitor = createSubagentRunMonitor({
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

		await requested;
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy.mock.calls[0][0]).toBe("https://api.typesafe.ai/v1/systemone");
		expect(monitor.isWatchdogAborted()).toBe(false);
		expect(mock.isSessionAborted()).toBe(false);

		respond(Response.json(mockJevResponse));
		// Observe the lifecycle transition, not the number of internal await hops.
		await mock.whenAborted;

		expect(monitor.isWatchdogAborted()).toBe(true);
		expect(monitor.abortSignal.aborted).toBe(true);
		expect(monitor.resolveAbortReasonText()).toContain("System 1 Watchdog: Agent wedged");
		expect(monitor.resolveAbortReasonText()).toContain("syntax_or_tag_mismatch");
		expect(mock.isSessionAborted()).toBe(true);

		monitor.finish();
	});
});
