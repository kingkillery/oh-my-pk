import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import { resolveSubagentModelRouting } from "../../src/orchestration/subagent-model-routing";
import type { CreateAgentSessionResult } from "../../src/sdk";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "../../src/session/agent-session";
import { ArtifactManager } from "../../src/session/artifacts";
import { ORCHESTRATOR_RECEIPT_MAX_BYTES, projectOrchestratorTaskReceipt } from "../../src/task/delegated-output";
import { runSubprocess } from "../../src/task/executor";
import type { RecoveryAttempt } from "../../src/task/recovery-policy";
import { createSpawnPlan, type SpawnRouteCandidate } from "../../src/task/spawn-plan";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import { YieldTool } from "../../src/tools/yield";
import { EventBus } from "../../src/utils/event-bus";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

function makeCandidate(selector: string, tier: SpawnRouteCandidate["tier"], provider: string): SpawnRouteCandidate {
	return {
		selector,
		tier,
		provider,
		modelId: selector.split("/")[1],
		maxRequests: 8,
		maxRuntimeMs: 30_000,
	};
}

function makeMockModelRegistry(models: Array<{ provider: string; id: string; name?: string }>): ModelRegistry {
	return {
		authStorage: undefined,
		refresh: async () => {},
		getAvailable: () =>
			models.map(m => ({
				provider: m.provider,
				id: m.id,
				name: m.name ?? m.id,
				contextWindow: 128_000,
			})),
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;
}

function makeYieldingSession(mode: "escalate" | "success", payload: string): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		model: undefined,
		sessionId: `session-${mode}`,
		sessionFile: undefined,
		extensionRunner: undefined,
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"], messages: [] } },
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		setActiveTaskContract: () => {},
		subscribe: (fn: (event: AgentSessionEvent) => void) => {
			listeners.push(fn);
			return () => {
				const idx = listeners.indexOf(fn);
				if (idx >= 0) listeners.splice(idx, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			if (mode === "escalate") {
				emit({
					type: "tool_execution_end",
					toolCallId: "yield-1",
					toolName: "yield",
					isError: false,
					result: {
						content: [{ type: "text", text: `Escalation requested: ${payload}` }],
						details: { data: undefined, status: "escalate", error: payload },
					},
				} as AgentSessionEvent);
			} else {
				emit({
					type: "tool_execution_end",
					toolCallId: "yield-2",
					toolName: "yield",
					isError: false,
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { data: payload, status: "success" },
					},
				} as AgentSessionEvent);
			}
			return true;
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

function wrapCreatedSession(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		modelFallbackMessage: undefined,
		eventBus: new EventBus(),
	};
}

describe("Fusion orchestrator subagent routing", () => {
	it("maps explore -> Tier 5, oracle/plan -> Tier 1, and task -> [Tier 4, Tier 3, Tier 2, Tier 1]", () => {
		const settings = Settings.isolated({
			"fusion.enabled": true,
			"fusion.mode": "orchestrator",
			"fusion.modelPool": [
				"1=openai/tier1",
				"2=anthropic/tier2",
				"3=google/tier3",
				"4=deepseek/tier4",
				"5=groq/tier5",
			],
		});
		const modelRegistry = makeMockModelRegistry([
			{ provider: "openai", id: "tier1" },
			{ provider: "anthropic", id: "tier2" },
			{ provider: "google", id: "tier3" },
			{ provider: "deepseek", id: "tier4" },
			{ provider: "groq", id: "tier5" },
		]);

		const exploreRoute = resolveSubagentModelRouting({
			agentName: "explore",
			settings,
			modelRegistry,
		});
		expect(exploreRoute.ok).toBe(true);
		if (!exploreRoute.ok) throw new Error("expected explore route");
		expect(exploreRoute.decision.source).toBe("fusion-orchestrator");
		expect(exploreRoute.decision.candidateSelectors).toEqual(["groq/tier5"]);

		const oracleRoute = resolveSubagentModelRouting({
			agentName: "oracle",
			settings,
			modelRegistry,
		});
		expect(oracleRoute.ok).toBe(true);
		if (!oracleRoute.ok) throw new Error("expected oracle route");
		expect(oracleRoute.decision.candidateSelectors).toEqual(["openai/tier1"]);

		const planRoute = resolveSubagentModelRouting({
			agentName: "plan",
			settings,
			modelRegistry,
		});
		expect(planRoute.ok).toBe(true);
		if (!planRoute.ok) throw new Error("expected plan route");
		expect(planRoute.decision.candidateSelectors).toEqual(["openai/tier1"]);

		const taskRoute = resolveSubagentModelRouting({
			agentName: "task",
			settings,
			modelRegistry,
		});
		expect(taskRoute.ok).toBe(true);
		if (!taskRoute.ok) throw new Error("expected task route");
		expect(taskRoute.decision.source).toBe("fusion-orchestrator");
		expect(taskRoute.decision.candidateSelectors).toEqual([
			"deepseek/tier4",
			"google/tier3",
			"anthropic/tier2",
			"openai/tier1",
		]);
	});
});

describe("YieldTool escalate signal and 1-failure orchestrator worker climb", () => {
	it("accepts { result: { escalate } } and promotes ESCALATE-prefixed errors", async () => {
		const tool = new YieldTool({} as never);
		const direct = await tool.execute("call-1", {
			result: { escalate: "typecheck failed on generic constraint" },
		});
		expect(direct.details?.status).toBe("escalate");
		expect(direct.details?.error).toBe("typecheck failed on generic constraint");
		expect(direct.content[0]).toEqual({
			type: "text",
			text: "Escalation requested: typecheck failed on generic constraint",
		});

		const promoted = await tool.execute("call-2", {
			result: { error: "ESCALATE: circular dependency in module graph" },
		});
		expect(promoted.details?.status).toBe("escalate");
		expect(promoted.details?.error).toBe("circular dependency in module graph");
	});

	it("climbs 1 tier immediately on escalate yield without requiring assignmentContract", async () => {
		const settings = Settings.isolated({
			"fusion.enabled": true,
			"fusion.mode": "orchestrator",
			"fusion.modelPool": ["1=openai/tier1", "3=google/tier3", "4=deepseek/tier4"],
		});
		const planned = createSpawnPlan({
			correlationId: "orch-climb-test",
			agentName: "task",
			assignment: "Fix generic constraint and run lint check.",
			modelRouting: {
				source: "fusion-orchestrator",
				candidateSelectors: ["deepseek/tier4", "google/tier3", "openai/tier1"],
			},
			eligible: [
				makeCandidate("deepseek/tier4", "light", "deepseek"),
				makeCandidate("google/tier3", "mid", "google"),
				makeCandidate("openai/tier1", "frontier", "openai"),
			],
		});
		if (!planned.ok) throw new Error("expected valid spawn plan");

		const escalateSession = makeYieldingSession("escalate", "lint check failed");
		const successSession = makeYieldingSession("success", "lint check passed on tier 3");
		const createSessionSpy = vi
			.spyOn(sdkModule, "createAgentSession")
			.mockResolvedValueOnce(wrapCreatedSession(escalateSession))
			.mockResolvedValueOnce(wrapCreatedSession(successSession));

		const modelRegistry = makeMockModelRegistry([
			{ provider: "deepseek", id: "tier4" },
			{ provider: "google", id: "tier3" },
			{ provider: "openai", id: "tier1" },
		]);
		const agent: AgentDefinition = {
			name: "task",
			description: "Worker agent",
			systemPrompt: "Execute task.",
			source: "bundled",
		};
		const allocateRecoveryId = vi.fn(async (attempt: RecoveryAttempt) => {
			expect(attempt.selector).toBe("google/tier3");
			expect(attempt.attempt).toBe(2);
			return "orch-climb-child-2";
		});

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "Fix generic constraint",
			assignment: "Fix generic constraint and run lint check.",
			index: 0,
			id: "orch-climb-child-1",
			settings,
			modelRegistry,
			enableLsp: false,
			modelOverride: ["deepseek/tier4"],
			spawnPlan: planned.plan,
			allocateRecoveryId,
		});

		expect(createSessionSpy).toHaveBeenCalledTimes(2);
		expect(createSessionSpy.mock.calls.map(call => call.at(0)?.model?.id)).toEqual(["tier4", "tier3"]);
		expect(allocateRecoveryId).toHaveBeenCalledTimes(1);
		expect(result.id).toBe("orch-climb-child-2");
		expect(result.exitCode).toBe(0);
		expect(result.recoveryAttempt).toBe(2);
	});
});

describe("projectOrchestratorTaskReceipt", () => {
	it("spills 12 KB output + 30-line code fence to artifact:// and caps parent receipt <= 1,200B while preserving result.output", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-orch-receipt-"));
		tempDirs.push(dir);
		const artifactManager = new ArtifactManager(path.join(dir, "session.jsonl"));

		const longFence = ["```ts", ...Array.from({ length: 30 }, (_, i) => `const line${i} = ${i};`), "```"].join("\n");
		const filler = "Summary detail line with context and file references. ".repeat(220);
		const rawDump = `${longFence}\n\n${filler}`.slice(0, 12_000);
		expect(rawDump.length).toBe(12_000);

		const result: SingleResult = {
			index: 0,
			id: "worker-receipt-1",
			agent: "task",
			agentSource: "bundled",
			task: "refactor module",
			assignment: "refactor module",
			exitCode: 0,
			output: rawDump,
			stderr: "",
			truncated: false,
			durationMs: 120,
			tokens: 500,
			requests: 2,
			resolvedModel: "google/tier3",
			changesApplied: true,
		};

		const projected = await projectOrchestratorTaskReceipt({
			result,
			artifactsDir: dir,
			artifactManager,
			mergeSummary: "Applied 2 files cleanly.",
		});

		expect(projected.truncated).toBe(true);
		expect(Buffer.byteLength(projected.text, "utf8")).toBeLessThanOrEqual(ORCHESTRATOR_RECEIPT_MAX_BYTES);
		expect(projected.text).toContain("artifact://");
		expect(projected.text).toContain("[fenced block elided -> artifact://");
		expect(result.transcriptArtifact).toMatch(/^artifact:\/\//);
		// Full output stays intact for TUI rendering.
		expect(result.output.length).toBe(12_000);
	});
});
