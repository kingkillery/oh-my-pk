/**
 * Test scaffolding: temp workspaces, a fake TaskService for the MCP layer, and
 * a controllable SessionRunner for the manager tests. Nothing here touches the
 * network, a provider, or a real ompk session.
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectorConfig, createConfig } from "../src/config";
import type {
	LaunchTaskInput,
	LaunchTaskResult,
	RunHooks,
	RunOutcome,
	SessionRunner,
	TaskRecord,
	TaskService,
	TaskState,
	TaskSummary,
} from "../src/types";

/** Real, existing temp dir usable as an allowlisted workspace. */
export function tempWorkspace(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "chatgpt-connector-")));
}

/** Valid connector config: one bearer token, one temp workspace. */
export function testConfig(overrides: {
	server?: Partial<ConnectorConfig["server"]>;
	auth?: Partial<ConnectorConfig["auth"]>;
	workspaces?: Array<{ id?: string; path: string; label?: string; allowWrite?: boolean } | string>;
	limits?: Partial<ConnectorConfig["limits"]>;
	defaults?: Partial<ConnectorConfig["defaults"]>;
	chatgpt?: Partial<ConnectorConfig["chatgpt"]>;
}): ConnectorConfig {
	return createConfig({
		server: { host: "127.0.0.1", port: 0, ...overrides.server },
		auth: { mode: "bearer", tokens: ["test-token-value-0123456789"], ...overrides.auth },
		workspaces: (overrides.workspaces ?? [{ id: "ws", path: tempWorkspace() }]).map(workspace =>
			typeof workspace === "string" ? workspace : { id: "", ...workspace },
		),
		limits: { abortGraceMs: 200, ...overrides.limits },
		defaults: overrides.defaults,
		chatgpt: overrides.chatgpt,
	});
}

function summaryFrom(record: TaskRecord): TaskSummary {
	return {
		id: record.id,
		title: record.title,
		state: record.state,
		workspace: record.workspace,
		createdAt: record.createdAt,
		startedAt: record.startedAt,
		finishedAt: record.finishedAt,
		durationMs:
			record.startedAt === undefined ? undefined : Math.max(0, (record.finishedAt ?? Date.now()) - record.startedAt),
		turns: record.turns,
		progress: { ...record.progress },
		error: record.error,
		preview: record.result?.text.slice(0, 120),
		sessionFile: record.sessionFile,
	};
}

export class FakeTaskService implements TaskService {
	records = new Map<string, TaskRecord>();
	launchCalls: LaunchTaskInput[] = [];
	nextId = 1;
	/** Hook a test can override to control the launched record's outcome. */
	launchImpl?: (input: LaunchTaskInput) => Partial<TaskRecord>;

	launch(input: LaunchTaskInput): Promise<LaunchTaskResult> {
		this.launchCalls.push(input);
		const now = Date.now();
		const record: TaskRecord = {
			id: `task_fake_${this.nextId++}`,
			title: input.title ?? input.prompt.slice(0, 40),
			state: "running",
			workspace: input.workspace ?? "ws",
			cwd: "/tmp/ws",
			prompt: input.prompt,
			createdAt: now,
			startedAt: now,
			turns: 1,
			events: [{ at: now, type: "launch", summary: "queued" }],
			progress: { toolCalls: 0 },
			sessionFile: "/tmp/ws/.ompk/session.jsonl",
			...this.launchImpl?.(input),
		} as TaskRecord;
		this.records.set(record.id, record);
		const settled = record.state !== "running" && record.state !== "queued";
		return Promise.resolve({ task: summaryFrom(record), settled });
	}

	list(): TaskSummary[] {
		return [...this.records.values()].map(summaryFrom);
	}

	status(taskId: string): TaskSummary | undefined {
		const record = this.records.get(taskId);
		return record ? summaryFrom(record) : undefined;
	}

	record(taskId: string): TaskRecord | undefined {
		return this.records.get(taskId);
	}

	result(taskId: string, maxChars?: number): TaskRecord | undefined {
		const record = this.records.get(taskId);
		if (!record) return undefined;
		if (maxChars === undefined || !record.result) return record;
		const text = record.result.text.length > maxChars ? record.result.text.slice(0, maxChars) : record.result.text;
		return { ...record, result: { ...record.result, text, truncated: text.length < record.result.text.length } };
	}

	diff(taskId: string): Promise<{ task: TaskSummary; diff: string } | undefined> {
		const record = this.records.get(taskId);
		if (!record) return Promise.resolve(undefined);
		return Promise.resolve({ task: summaryFrom(record), diff: record.diff ?? "" });
	}

	followup(taskId: string, _message: string, _waitSeconds?: number): Promise<LaunchTaskResult | undefined> {
		const record = this.records.get(taskId);
		if (!record) return Promise.resolve(undefined);
		record.turns += 1;
		return Promise.resolve({ task: summaryFrom(record), settled: false });
	}

	cancel(taskId: string, reason?: string): Promise<TaskSummary | undefined> {
		const record = this.records.get(taskId);
		if (!record) return Promise.resolve(undefined);
		record.state = "cancelled";
		record.finishedAt = Date.now();
		record.error = reason;
		return Promise.resolve(summaryFrom(record));
	}

	waitFor(taskId: string, _timeoutMs: number): Promise<TaskSummary | undefined> {
		const record = this.records.get(taskId);
		return Promise.resolve(record ? summaryFrom(record) : undefined);
	}

	shutdown(): Promise<void> {
		return Promise.resolve();
	}

	/** Helper: mark a record settled with a result. */
	settle(taskId: string, state: TaskState, text = "done"): void {
		const record = this.records.get(taskId);
		if (!record) return;
		record.state = state;
		record.finishedAt = Date.now();
		record.result = { text, truncated: false };
	}
}

export interface FakeRunStep {
	/** Resolve with this outcome (default: echo the prompt). */
	outcome?: RunOutcome;
	/** Reject with this error instead. */
	error?: Error;
	/** Milliseconds before the step resolves (default 0). */
	delayMs?: number;
	/** If true, `run` never resolves on its own — it settles only via abort. */
	hang?: boolean;
	/** If true, `run` ignores the abort signal too (never resolves). */
	ignoreAbort?: boolean;
	events?: string[];
}

/** Runner that replays scripted steps per `run` call. */
export class FakeRunner implements SessionRunner {
	steps: FakeRunStep[] = [];
	runs: Array<{ cwd: string; prompt: string; model?: string }> = [];
	abortHandlers: Array<(reason?: string) => Promise<void>> = [];
	disposed = 0;
	/** Fires inside run() right before awaiting the step outcome. */
	onStart?: () => void;
	/** Registered per run; resolve to make a hanging step settle. */
	pending: Array<{ resolve: (outcome: RunOutcome) => void; signal: AbortSignal }> = [];

	async run(input: {
		cwd: string;
		prompt: string;
		model?: string;
		signal: AbortSignal;
		hooks: RunHooks;
	}): Promise<RunOutcome> {
		this.runs.push({ cwd: input.cwd, prompt: input.prompt, model: input.model });
		const step = this.steps.shift() ?? {};
		for (const type of step.events ?? []) input.hooks.onEvent({ type, summary: type });
		const abortHandler = async (reason?: string) => {
			input.hooks.onEvent({ type: "aborted", summary: reason ?? "aborted" });
		};
		this.abortHandlers.push(abortHandler);
		input.hooks.onAbortHandler(abortHandler);
		input.hooks.onSession?.("/tmp/fake-session.jsonl");
		this.onStart?.();

		if (step.ignoreAbort) {
			// Never settles: simulates a runner that dropped the abort signal.
			const { promise } = Promise.withResolvers<RunOutcome>();
			return promise;
		}
		if (step.hang) {
			const { promise, resolve } = Promise.withResolvers<RunOutcome>();
			this.pending.push({ resolve, signal: input.signal });
			input.signal.addEventListener(
				"abort",
				() => resolve({ text: "", aborted: true, stopReason: "aborted", ...step.outcome }),
				{ once: true },
			);
			return promise;
		}
		if (step.error) throw step.error;
		if (step.delayMs) await Bun.sleep(step.delayMs);
		if (input.signal.aborted) return { text: "", aborted: true };
		return {
			text: `ok: ${input.prompt}`,
			stopReason: "end_turn",
			usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, requests: 1 },
			...step.outcome,
		};
	}

	async dispose(): Promise<void> {
		this.disposed += 1;
	}
}

/** Wait until `predicate` is true; throws after `timeoutMs`. */
export async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	throw new Error("waitUntil timed out");
}

/** Narrow a JSON-RPC response to its success payload (returns undefined on error). */
export function resultOf<T = Record<string, unknown>>(
	res: { result?: unknown } | { error?: unknown } | undefined,
): T | undefined {
	if (!res || !("result" in res) || res.result === undefined) return undefined;
	return res.result as T;
}

/** Narrow a JSON-RPC response to its failure object (returns undefined on success). */
export function errorOf(
	res: { result?: unknown } | { error?: { code: number; message: string } | undefined } | undefined,
): { code: number; message: string } | undefined {
	return res && "error" in res ? res.error : undefined;
}
