/**
 * Fast local replay/regression harness for `oh-my-pk` Self-Improvement Memory (SIM).
 *
 * Exercises 16 deterministic failure cases directly against live `oh-my-pk`
 * parsers, retry policies, truncation bounds, approval/rule/prompt hooks, and
 * `pi-catalog` compat fixups — zero network calls, zero mocks.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context } from "../../packages/ai/src/types";
import { withEmptyCompletionRetry } from "../../packages/ai/src/utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../../packages/ai/src/utils/event-stream";
import { parseJsonWithRepair } from "../../packages/ai/src/utils/json-parse";
import { formatErrorMessageWithRetryAfter, getRetryAfterMsFromHeaders } from "../../packages/ai/src/utils/retry-after";
import { buildOpenAICompat } from "../../packages/catalog/src/compat/openai";
import type { ModelSpec } from "../../packages/catalog/src/types";
import { bucketRules } from "../../packages/coding-agent/src/capability/rule-buckets";
import { parseApplyPatch } from "../../packages/coding-agent/src/edit/apply-patch/parser";
import { TtsrManager } from "../../packages/coding-agent/src/export/ttsr";
import { truncateHead, truncateTail } from "../../packages/coding-agent/src/session/streaming-output";
import { buildSystemPrompt } from "../../packages/coding-agent/src/system-prompt";
import {
	formatApprovalPrompt,
	requiresApproval,
	resolveApproval,
	truncateForPrompt,
} from "../../packages/coding-agent/src/tools/approval";
import { parsePatch } from "../../packages/hashline/src/parser";
import { evaluateReplayDiff, type SimReplayCaseResult, type SimReplayReport } from "./schema";

export interface SimReplayCase {
	id: string;
	category: SimReplayCaseResult["category"];
	description: string;
	run: () => void | Promise<void>;
}

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function makeOpenAISpec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...overrides,
	};
}

export const SIM_REPLAY_CASES: readonly SimReplayCase[] = [
	// ── Parsers (4) ──────────────────────────────────────────────────────────
	{
		id: "parser-json-unescaped-controls",
		category: "parser",
		description: "Repairs raw unescaped newlines and tabs emitted inside JSON tool-call string fields",
		run: () => {
			const malformed = '{"command": "echo line1\n\techo line2", "cwd": "/repo"}';
			const parsed = parseJsonWithRepair<{ command: string; cwd: string }>(malformed);
			assert.equal(parsed.command, "echo line1\n\techo line2");
			assert.equal(parsed.cwd, "/repo");
		},
	},
	{
		id: "parser-json-invalid-escapes",
		category: "parser",
		description: "Repairs invalid backslash escapes such as Windows paths and regex classes inside JSON strings",
		run: () => {
			const malformed = '{"path": "C:\\Users\\dev\\app.ts", "pattern": "\\d+\\w*"}';
			const parsed = parseJsonWithRepair<{ path: string; pattern: string }>(malformed);
			assert.equal(parsed.path, "C:\\Users\\dev\\app.ts");
			assert.equal(parsed.pattern, "\\d+\\w*");
		},
	},
	{
		id: "parser-apply-patch-heredoc",
		category: "parser",
		description: "Strips lenient shell heredoc wrappers around Codex apply_patch envelopes",
		run: () => {
			const heredocPatch = [
				"<<'EOF'",
				"*** Begin Patch",
				"*** Add File: src/hello.ts",
				"+export const hello = 1;",
				"*** Delete File: src/obsolete.ts",
				"*** End Patch",
				"EOF",
			].join("\n");
			const hunks = parseApplyPatch(heredocPatch);
			assert.equal(hunks.length, 2);
			assert.equal(hunks[0]?.op, "create");
			assert.equal(hunks[0]?.path, "src/hello.ts");
			assert.equal(hunks[1]?.op, "delete");
			assert.equal(hunks[1]?.path, "src/obsolete.ts");
		},
	},
	{
		id: "parser-hashline-contamination",
		category: "parser",
		description:
			"Rejects apply_patch sentinels and unified-diff @@ headers inside hashline edits with actionable errors",
		run: () => {
			assert.throws(
				() => parsePatch("*** Update File: src/app.ts\n+const x = 1;"),
				/apply_patch sentinel .* not valid in hashline/i,
			);
			assert.throws(
				() => parsePatch("@@ -10,3 +10,4 @@\n+const x = 1;"),
				/unified-diff hunk header .* not valid in hashline/i,
			);
		},
	},

	// ── Retry Policies (3) ───────────────────────────────────────────────────
	{
		id: "retry-empty-completion-recovers",
		category: "retry",
		description: "Retries a zero-output-token empty terminal stop and delivers the recovered assistant text",
		run: async () => {
			const context: Context = { messages: [] };
			let calls = 0;
			const stream = withEmptyCompletionRetry({ id: "test" }, context, { providerRetryWait: async () => {} }, () => {
				calls += 1;
				const inner = new AssistantMessageEventStream();
				queueMicrotask(() => {
					if (calls === 1) {
						const empty = makeAssistantMessage({
							content: [],
							usage: { ...makeAssistantMessage().usage, output: 0 },
						});
						inner.push({ type: "start", partial: empty });
						inner.push({ type: "done", reason: "stop", message: empty });
						return;
					}
					const recovered = makeAssistantMessage({
						content: [{ type: "text", text: "Recovered response" }],
						usage: { ...makeAssistantMessage().usage, output: 12 },
					});
					inner.push({ type: "start", partial: recovered });
					inner.push({ type: "text_delta", contentIndex: 0, delta: "Recovered response", partial: recovered });
					inner.push({ type: "done", reason: "stop", message: recovered });
				});
				return inner;
			});
			const result = await stream.result();
			assert.equal(calls, 2);
			const first = result.content[0];
			assert.equal(first?.type, "text");
			if (first?.type === "text") {
				assert.equal(first.text, "Recovered response");
			}
		},
	},
	{
		id: "retry-empty-completion-preserves-billed-thinking",
		category: "retry",
		description:
			"Does not retry empty visible text when output tokens were billed (prevents duplicate thinking loops)",
		run: async () => {
			const context: Context = { messages: [] };
			let calls = 0;
			const stream = withEmptyCompletionRetry({ id: "test" }, context, { providerRetryWait: async () => {} }, () => {
				calls += 1;
				const inner = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const billed = makeAssistantMessage({
						content: [],
						usage: { ...makeAssistantMessage().usage, output: 240, totalTokens: 340 },
					});
					inner.push({ type: "start", partial: billed });
					inner.push({ type: "done", reason: "stop", message: billed });
				});
				return inner;
			});
			await stream.result();
			assert.equal(calls, 1);
		},
	},
	{
		id: "retry-after-header-precedence",
		category: "retry",
		description: "Selects max safe delay across retry-after and x-ratelimit-reset-ms without duplicating hint suffix",
		run: () => {
			const headers = new Headers({
				"retry-after": "2",
				"x-ratelimit-reset-ms": "3500",
			});
			assert.equal(getRetryAfterMsFromHeaders(headers), 3500);
			const formatted = formatErrorMessageWithRetryAfter(new Error("429 Too Many Requests"), headers);
			assert.equal(formatted, "429 Too Many Requests retry-after-ms=3500");
			const idempotent = formatErrorMessageWithRetryAfter(new Error(formatted), headers);
			assert.equal(idempotent, formatted);
		},
	},

	// ── Truncation & Context Bounds (3) ──────────────────────────────────────
	{
		id: "truncation-head-byte-and-first-line",
		category: "truncation",
		description: "Flags firstLineExceedsLimit without emitting partial UTF-8 bytes when line 1 exceeds maxBytes",
		run: () => {
			const oversizedFirstLine = `${"🚀".repeat(20)}\nline2`;
			const result = truncateHead(oversizedFirstLine, { maxLines: 10, maxBytes: 16 });
			assert.equal(result.truncated, true);
			assert.equal(result.truncatedBy, "bytes");
			assert.equal(result.firstLineExceedsLimit, true);
			assert.equal(result.outputLines, 0);
			assert.equal(result.content, "");
		},
	},
	{
		id: "truncation-tail-preserves-end-error",
		category: "truncation",
		description: "Preserves final crash/assertion lines under tight line and byte budgets in truncateTail",
		run: () => {
			const logLines = Array.from({ length: 40 }, (_, i) => `step ${i + 1}: ok`);
			logLines.push("FAIL: AssertionError: expected 200, received 404");
			const result = truncateTail(logLines.join("\n"), { maxLines: 3, maxBytes: 1024 });
			assert.equal(result.truncated, true);
			assert.equal(result.outputLines, 3);
			assert.ok(result.content.includes("FAIL: AssertionError: expected 200, received 404"));
		},
	},
	{
		id: "truncation-approval-prompt-cap",
		category: "truncation",
		description: "Caps oversized tool arguments in approval prompts with explicit elision marker",
		run: () => {
			const huge = "x".repeat(500);
			const capped = truncateForPrompt(huge, 40);
			assert.ok(capped.startsWith("x".repeat(40)));
			assert.ok(capped.includes("460ch elided"));
			const body = formatApprovalPrompt(
				{ name: "mcp__deploy", formatApprovalDetails: () => capped },
				{},
				"External mutation",
			);
			assert.ok(body.includes("Origin: MCP server tool"));
			assert.ok(body.includes("Reason: External mutation"));
			assert.ok(body.includes("460ch elided"));
		},
	},

	// ── Completion, Approval, Rule & Prompt Hooks (3) ────────────────────────
	{
		id: "approval-mode-tier-gating",
		category: "hooks",
		description:
			"Enforces read/write/exec tier gating per mode and keeps explicit user deny authoritative in yolo mode",
		run: () => {
			const writeTool = { name: "edit", approval: () => ({ tier: "write" as const }) };
			const execTool = { name: "bash", approval: () => ({ tier: "exec" as const }) };

			assert.equal(resolveApproval(writeTool, {}, "always-ask").policy, "prompt");
			assert.equal(resolveApproval(writeTool, {}, "write").policy, "allow");
			assert.equal(resolveApproval(execTool, {}, "write").policy, "prompt");
			assert.equal(resolveApproval(execTool, {}, "yolo", { bash: "deny" }).policy, "deny");
			assert.throws(() => requiresApproval(execTool, {}, "yolo", { bash: "deny" }), /blocked by user policy/i);
		},
	},
	{
		id: "hook-ttsr-glob-scoping",
		category: "hooks",
		description: "Triggers glob-scoped TTSR rules only on matching harness paths and ignores unrelated files",
		run: () => {
			const manager = new TtsrManager({
				enabled: true,
				contextMode: "discard",
				interruptMode: "always",
				repeatMode: "once",
				repeatGap: 10,
			});
			const { rulebookRules } = bucketRules(
				[
					{
						name: "compat-guard",
						path: ".agents/rules/compat-guard.md",
						content: "Verify model provenance before editing compat.",
						condition: ["buildOpenAICompat"],
						globs: ["packages/catalog/src/compat/**/*.ts"],
						_source: {
							provider: "agents",
							providerName: "Agents",
							path: ".agents/rules/compat-guard.md",
							level: "project",
						},
					},
				],
				manager,
			);
			assert.equal(rulebookRules.length, 0);
			const unrelated = manager.checkDelta("buildOpenAICompat(", {
				source: "tool",
				toolName: "edit",
				filePaths: ["packages/utils/src/foo.ts"],
			});
			assert.equal(unrelated.length, 0);
			const matching = manager.checkDelta("buildOpenAICompat(", {
				source: "tool",
				toolName: "edit",
				filePaths: ["packages/catalog/src/compat/openai.ts"],
			});
			assert.equal(matching.length, 1);
			assert.equal(matching[0]?.name, "compat-guard");
		},
	},
	{
		id: "system-prompt-sim-and-prefix-stability",
		category: "hooks",
		description: "Injects full sim.json verbatim while keeping block 0 byte-stable and Fusion policies terminal",
		run: async () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sim-replay-"));
			try {
				const simDir = path.join(tempDir, ".omp");
				fs.mkdirSync(simDir, { recursive: true });
				const sampleLedger = JSON.stringify({
					next_id: 2,
					aliases: {},
					problems: [
						{
							id: "P1",
							name: "sample replay hypothesis",
							opened_round: 1,
							attempts: [],
						},
					],
				});
				fs.writeFileSync(path.join(simDir, "sim.json"), sampleLedger, "utf-8");

				const baseOpts = {
					cwd: tempDir,
					contextFiles: [],
					skills: [],
					rules: [],
					toolNames: ["read", "task"],
					workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
				};
				const withoutSim = await buildSystemPrompt({ ...baseOpts, simLedger: null });
				const withSim = await buildSystemPrompt(baseOpts);
				const withSimAndFusion = await buildSystemPrompt({
					...baseOpts,
					fusionSidekick: true,
					sidekickModel: "pi/smol",
				});

				// Block 0 (static system instructions) must stay byte-identical for prompt caching.
				assert.equal(withSim.systemPrompt[0], withoutSim.systemPrompt[0]);
				assert.equal(withSimAndFusion.systemPrompt[0], withoutSim.systemPrompt[0]);

				const joined = withSim.systemPrompt.join("\n\n");
				assert.ok(joined.includes("<self-improvement-memory"));
				assert.ok(joined.includes("sample replay hypothesis"));

				// Fusion policy remains strictly terminal even when SIM block is present.
				assert.match(
					withSimAndFusion.systemPrompt.at(-1)?.trim() ?? "",
					/^<fusion-sidekick>[\s\S]*<\/fusion-sidekick>$/,
				);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		},
	},

	// ── pi-catalog Model Compat Fixups (3) ───────────────────────────────────
	{
		id: "compat-ollama-reasoning-effort-map",
		category: "compat",
		description:
			"Maps unsupported minimal/xhigh reasoning effort levels on local ollama while keeping explicit overrides",
		run: () => {
			const defaulted = buildOpenAICompat(
				makeOpenAISpec({
					id: "qwen3:32b",
					provider: "ollama",
					baseUrl: "http://127.0.0.1:11434/v1",
					reasoning: true,
				}),
			);
			assert.equal(defaulted.reasoningEffortMap?.minimal, "low");
			assert.equal(defaulted.reasoningEffortMap?.xhigh, "max");

			const overridden = buildOpenAICompat(
				makeOpenAISpec({
					id: "qwen3:32b",
					provider: "ollama",
					baseUrl: "http://127.0.0.1:11434/v1",
					reasoning: true,
					compat: { reasoningEffortMap: { xhigh: "high" } },
				}),
			);
			assert.equal(overridden.reasoningEffortMap?.minimal, "low");
			assert.equal(overridden.reasoningEffortMap?.xhigh, "high");
		},
	},
	{
		id: "compat-opencode-thinking-replay-gating",
		category: "compat",
		description:
			"Keeps reasoning_content replay off when thinking is disabled on opencode gateways and enables it in whenThinking",
		run: () => {
			const compat = buildOpenAICompat(
				makeOpenAISpec({
					id: "kimi-k2.5",
					provider: "opencode-go",
					baseUrl: "https://opencode.ai/go/v1",
					reasoning: true,
				}),
			);
			assert.equal(compat.requiresReasoningContentForToolCalls, false);
			assert.ok(compat.whenThinking !== undefined);
			assert.equal(compat.whenThinking?.requiresReasoningContentForToolCalls, true);
			assert.equal(compat.whenThinking?.allowsSyntheticReasoningContentForToolCalls, false);
			assert.equal(compat.whenThinking?.reasoningContentField, "reasoning_content");
		},
	},
	{
		id: "compat-stream-markup-healing-routing",
		category: "compat",
		description: "Routes stream markup healing per model family without leaking across unrelated providers",
		run: () => {
			const minimax = buildOpenAICompat(makeOpenAISpec({ id: "minimax-m2.5", provider: "openrouter" }));
			const kimi = buildOpenAICompat(makeOpenAISpec({ id: "kimi-k2-thinking", provider: "moonshot" }));
			const deepseek = buildOpenAICompat(makeOpenAISpec({ id: "deepseek-r1", provider: "deepseek" }));
			const gptOss = buildOpenAICompat(makeOpenAISpec({ id: "openai/gpt-oss-120b", provider: "fireworks" }));
			const plain = buildOpenAICompat(makeOpenAISpec({ id: "gpt-4o", provider: "openai" }));

			assert.equal(minimax.streamMarkupHealingPattern, "thinking");
			assert.equal(kimi.streamMarkupHealingPattern, "kimi");
			assert.equal(deepseek.streamMarkupHealingPattern, "dsml");
			assert.equal(gptOss.streamMarkupHealingPattern, "harmony");
			assert.equal(plain.streamMarkupHealingPattern, undefined);
		},
	},
];

export interface RunReplayOptions {
	caseIds?: readonly string[];
	predicted?: readonly string[];
	baseline?: Pick<SimReplayReport, "passed_ids" | "failed_ids">;
}

export async function runSimReplay(options: RunReplayOptions = {}): Promise<SimReplayReport> {
	const filter = options.caseIds && options.caseIds.length > 0 ? new Set(options.caseIds) : undefined;
	const selected = filter ? SIM_REPLAY_CASES.filter(item => filter.has(item.id)) : SIM_REPLAY_CASES;

	if (filter) {
		const known = new Set(SIM_REPLAY_CASES.map(item => item.id));
		const unknown = [...filter].filter(id => !known.has(id));
		if (unknown.length > 0) {
			throw new Error(`Unknown replay case ID(s): ${unknown.join(", ")}`);
		}
	}

	const results: SimReplayCaseResult[] = [];
	const passedIds: string[] = [];
	const failedIds: string[] = [];

	for (const testCase of selected) {
		const start = performance.now();
		try {
			await testCase.run();
			const durationMs = Math.round((performance.now() - start) * 100) / 100;
			results.push({
				id: testCase.id,
				category: testCase.category,
				description: testCase.description,
				passed: true,
				durationMs,
			});
			passedIds.push(testCase.id);
		} catch (error) {
			const durationMs = Math.round((performance.now() - start) * 100) / 100;
			results.push({
				id: testCase.id,
				category: testCase.category,
				description: testCase.description,
				passed: false,
				durationMs,
				error: error instanceof Error ? error.message : String(error),
			});
			failedIds.push(testCase.id);
		}
	}

	const report: SimReplayReport = {
		passed: passedIds.length,
		total: results.length,
		passed_ids: passedIds,
		failed_ids: failedIds,
		results,
	};

	if ((options.predicted && options.predicted.length > 0) || options.baseline) {
		report.diff = evaluateReplayDiff(report, options.predicted ?? [], options.baseline);
	}

	return report;
}

if (import.meta.main) {
	const json = process.argv.includes("--json");
	const report = await runSimReplay();
	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		for (const item of report.results) {
			const mark = item.passed ? "PASS" : "FAIL";
			process.stdout.write(`[${mark}] ${item.id} (${item.category}, ${item.durationMs}ms)\n`);
			if (!item.passed && item.error) {
				process.stdout.write(`       ${item.error}\n`);
			}
		}
		process.stdout.write(`\nReplay summary: ${report.passed}/${report.total} passed\n`);
	}
	process.exit(report.failed_ids.length === 0 ? 0 : 1);
}
