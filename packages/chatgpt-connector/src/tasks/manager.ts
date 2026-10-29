/**
 * In-memory task registry backing every connector surface.
 *
 * Responsibilities are deliberately narrow:
 * - admit work only inside the configured workspace allowlist,
 * - bound concurrency, wall-clock runtime, retained records, and event volume,
 * - keep a task's underlying session alive briefly so ChatGPT can follow up,
 * - expose polling-friendly snapshots instead of push sockets.
 *
 * The manager never touches the coding agent directly; it drives a
 * {@link SessionRunner} supplied by the caller, which keeps this file testable
 * with a fake runner and free of provider/session boot cost.
 */
import { randomUUID } from "node:crypto";
import type { ConnectorConfig, WorkspaceConfig } from "../config";
import { ConnectorError } from "../errors";
import type {
	LaunchTaskInput,
	LaunchTaskResult,
	RunOutcome,
	SessionRunner,
	TaskEvent,
	TaskRecord,
	TaskService,
	TaskState,
	TaskSummary,
} from "../types";
import { captureGitSnapshot, truncateText } from "./git";

export interface TaskManagerOptions {
	config: ConnectorConfig;
	/** Builds the session-backed runner for one task. Called at most once per task. */
	createRunner: (input: { workspace: WorkspaceConfig; model?: string }) => SessionRunner | Promise<SessionRunner>;
	/** Injectable clock for deterministic tests. */
	now?: () => number;
	/** Notification hook fired after a task settles. */
	onSettled?: (task: TaskSummary) => void;
}

/** Terminal states never transition again. */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled", "timed_out"]);

export function isTerminalState(state: TaskState): boolean {
	return TERMINAL_STATES.has(state);
}

const PREVIEW_CHARS = 280;

/** Project a full record onto the polling-friendly summary. */
export function summarizeTask(record: TaskRecord): TaskSummary {
	const finishedAt = record.finishedAt;
	const durationMs =
		record.startedAt === undefined ? undefined : Math.max(0, (finishedAt ?? Date.now()) - record.startedAt);
	const text = record.result?.text ?? "";
	return {
		id: record.id,
		title: record.title,
		state: record.state,
		workspace: record.workspace,
		createdAt: record.createdAt,
		startedAt: record.startedAt,
		finishedAt,
		durationMs,
		turns: record.turns,
		progress: { ...record.progress },
		error: record.error,
		preview: text.length > 0 ? truncateText(text, PREVIEW_CHARS).text : undefined,
		sessionFile: record.sessionFile,
	};
}

/**
 * Grace period after an abort/timeout interrupt. A runner that ignores its abort
 * signal remains running after this window; its slot is retained until the
 * runner actually settles.
 */
export const ABORT_GRACE_MS = 15_000;
interface ActiveTask {
	record: TaskRecord;
	queuedPrompt: string;
	/** Replaced per turn so a follow-up after an abort is not pre-aborted. */
	controller: AbortController;
	runner?: SessionRunner;
	abortHandler?: (reason?: string) => Promise<void>;
	timeout?: ReturnType<typeof setTimeout>;
	/** Forced-finalize timer armed by `#interrupt` for non-aborting runners. */
	abortGrace?: ReturnType<typeof setTimeout>;
	idle?: ReturnType<typeof setTimeout>;
	waiters: Array<() => void>;
	/** True while this task occupies a concurrency slot. */
	counted: boolean;
	cancelled: boolean;
	timedOut: boolean;
	/** Wall-clock limit captured at launch. */
	timeoutMs: number;
	/** True once the idle TTL tore the runner down; the next turn starts fresh. */
	runnerDisposed: boolean;
	diffPromise?: Promise<string>;
}

function errMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class TaskManager implements TaskService {
	readonly #config: ConnectorConfig;
	readonly #createRunner: TaskManagerOptions["createRunner"];
	readonly #now: () => number;
	readonly #onSettled: ((task: TaskSummary) => void) | undefined;
	readonly #tasks = new Map<string, ActiveTask>();
	readonly #queue: string[] = [];
	#running = 0;
	#shuttingDown = false;

	constructor(options: TaskManagerOptions) {
		this.#config = options.config;
		this.#createRunner = options.createRunner;
		this.#now = options.now ?? Date.now;
		this.#onSettled = options.onSettled;
	}

	async launch(input: LaunchTaskInput): Promise<LaunchTaskResult> {
		const prompt = input.prompt?.trim() ?? "";
		if (prompt.length === 0) throw new ConnectorError("invalid_request", "prompt must not be empty");
		if (this.#shuttingDown) throw new ConnectorError("internal_error", "connector is shutting down");
		this.#assertCapacity();

		const workspace = this.#resolveWorkspace(input.workspace);
		const now = this.#now();
		const record: TaskRecord = {
			id: `task_${randomUUID()}`,
			title: input.title?.trim() || truncateText(prompt, 72).text,
			state: "queued",
			workspace: workspace.id,
			cwd: workspace.path,
			prompt,
			createdAt: now,
			turns: 0,
			events: [{ at: now, type: "launch", summary: `Queued in ${workspace.id}` }],
			progress: { toolCalls: 0 },
			model: input.model?.trim() || this.#config.defaults.model,
		};

		const task: ActiveTask = {
			record,
			queuedPrompt: prompt,
			controller: new AbortController(),
			waiters: [],
			counted: false,
			cancelled: false,
			timedOut: false,
			timeoutMs: Math.max(1_000, input.timeoutMs ?? this.#config.limits.taskTimeoutMs),
			runnerDisposed: false,
		};
		this.#tasks.set(record.id, task);
		this.#queue.push(record.id);
		this.#pump();

		const waitMs = Math.max(0, (input.waitSeconds ?? 0) * 1000);
		const settled = waitMs > 0 ? await this.#waitForSettle(task, waitMs) : isTerminalState(record.state);
		return { task: summarizeTask(record), settled };
	}

	async followup(taskId: string, message: string, waitSeconds?: number): Promise<LaunchTaskResult | undefined> {
		const task = this.#tasks.get(taskId);
		if (!task) return undefined;
		const text = message.trim();
		if (text.length === 0) throw new ConnectorError("invalid_request", "message must not be empty");

		const state = task.record.state;
		if (state === "queued" || state === "running") {
			throw new ConnectorError(
				"task_busy",
				`Task ${taskId} is still ${state}; wait for it to settle before following up.`,
				{
					state,
				},
			);
		}
		if (this.#shuttingDown) throw new ConnectorError("internal_error", "connector is shutting down");
		this.#cancelIdle(task);
		if (task.runnerDisposed) {
			this.#pushEvent(task, {
				type: "session_expired",
				summary: "Idle session was released; follow-up starts a fresh session",
			});
		}

		this.#pushEvent(task, { type: "followup", summary: truncateText(text, 160).text });
		// Rewind the settled state so #runTurn does not bail on the terminal guard
		// and the new turn's outcome (not the old error) decides the result.
		task.record.state = "queued";
		task.record.finishedAt = undefined;
		task.record.error = undefined;
		task.record.result = undefined;
		task.record.diff = undefined;
		task.cancelled = false;
		task.timedOut = false;
		task.controller = new AbortController();
		task.queuedPrompt = text;
		this.#queue.push(task.record.id);
		this.#pump();

		const waitMs = Math.max(0, (waitSeconds ?? 0) * 1000);
		const settled = waitMs > 0 ? await this.#waitForSettle(task, waitMs) : false;
		return { task: summarizeTask(task.record), settled };
	}

	list(): TaskSummary[] {
		return [...this.#tasks.values()]
			.map(task => summarizeTask(task.record))
			.sort((left, right) => right.createdAt - left.createdAt);
	}

	status(taskId: string): TaskSummary | undefined {
		const task = this.#tasks.get(taskId);
		return task ? summarizeTask(task.record) : undefined;
	}

	/** Full record (bounded by retained events and the result cap). */
	record(taskId: string): TaskRecord | undefined {
		return this.#tasks.get(taskId)?.record;
	}

	result(taskId: string, maxChars?: number): TaskRecord | undefined {
		const task = this.#tasks.get(taskId);
		if (!task) return undefined;
		const record = task.record;
		if (maxChars === undefined || !record.result) return record;
		const capped = truncateText(record.result.text, maxChars);
		return { ...record, result: { ...record.result, text: capped.text, truncated: capped.truncated } };
	}

	async diff(taskId: string, maxChars?: number): Promise<{ task: TaskSummary; diff: string } | undefined> {
		const task = this.#tasks.get(taskId);
		if (!task) return undefined;
		const diff = await this.#ensureDiff(task);
		return {
			task: summarizeTask(task.record),
			diff: maxChars === undefined ? diff : truncateText(diff, maxChars).text,
		};
	}

	async cancel(taskId: string, reason?: string): Promise<TaskSummary | undefined> {
		const task = this.#tasks.get(taskId);
		if (!task) return undefined;
		if (isTerminalState(task.record.state)) return summarizeTask(task.record);
		this.#interrupt(task, reason?.trim() || "cancelled");
		return summarizeTask(task.record);
	}

	async waitFor(taskId: string, timeoutMs: number): Promise<TaskSummary | undefined> {
		const task = this.#tasks.get(taskId);
		if (!task) return undefined;
		await this.#waitForSettle(task, Math.max(0, timeoutMs));
		return summarizeTask(task.record);
	}

	async shutdown(): Promise<void> {
		this.#shuttingDown = true;
		const tasks = [...this.#tasks.values()];
		for (const task of tasks) {
			if (!isTerminalState(task.record.state)) this.#interrupt(task, "shutdown");
		}
		const deadline = Date.now() + 5_000;
		await Promise.all(
			tasks.map(async task => {
				const remaining = Math.max(0, deadline - Date.now());
				if (remaining === 0) return;
				await this.#waitForSettle(task, remaining);
			}),
		);
		for (const task of tasks) {
			this.#cancelIdle(task);
			await this.#disposeRunner(task);
		}
	}

	#assertCapacity(): void {
		const settled = [...this.#tasks.values()].filter(task => isTerminalState(task.record.state)).length;
		const live = this.#tasks.size - settled;
		const limit = this.#config.limits.maxTasks;
		if (live >= limit) {
			throw new ConnectorError(
				"task_busy",
				`Connector already holds ${live} live tasks (limit ${limit}). Cancel one first.`,
			);
		}
	}

	#resolveWorkspace(requested: string | undefined): WorkspaceConfig {
		const explicit = requested?.trim();
		if (explicit) {
			const found = this.#config.workspaces.find(workspace => workspace.id === explicit);
			if (!found) {
				throw new ConnectorError("unknown_workspace", `Unknown workspace "${explicit}".`, {
					available: this.#config.workspaces.map(workspace => workspace.id),
				});
			}
			return found;
		}
		const fallbackId = this.#config.defaults.workspace;
		if (fallbackId) {
			const found = this.#config.workspaces.find(workspace => workspace.id === fallbackId);
			if (found) return found;
		}
		const first = this.#config.workspaces[0];
		if (!first) throw new ConnectorError("not_configured", "No workspaces are configured.");
		return first;
	}

	#pump(): void {
		if (this.#shuttingDown) return;
		while (this.#running < this.#config.limits.maxConcurrentTasks && this.#queue.length > 0) {
			const id = this.#queue.shift();
			if (!id) break;
			const task = this.#tasks.get(id);
			if (!task || task.record.state !== "queued") continue;
			void this.#runTurn(task, task.queuedPrompt);
		}
	}

	async #runTurn(task: ActiveTask, prompt: string): Promise<void> {
		const { record } = task;
		if (isTerminalState(record.state)) return;
		record.state = "running";
		record.startedAt ??= this.#now();
		task.cancelled = false;
		task.timedOut = false;
		task.counted = true;
		this.#running += 1;
		this.#pushEvent(task, { type: "turn_start", summary: `Turn ${record.turns + 1} started` });

		const timeoutMs = task.timeoutMs;
		task.timeout = setTimeout(() => {
			task.timedOut = true;
			this.#pushEvent(task, {
				type: "timeout",
				summary: `Wall-clock limit of ${Math.round(timeoutMs / 1000)}s reached`,
			});
			this.#interrupt(task, "timeout");
		}, timeoutMs);
		task.timeout.unref?.();

		const workspace = this.#config.workspaces.find(entry => entry.id === record.workspace);
		try {
			if (!task.runner) {
				if (!workspace)
					throw new ConnectorError("unknown_workspace", `Workspace "${record.workspace}" disappeared.`);
				task.runner = await this.#createRunner({ workspace, model: record.model });
			}
			if (task.controller.signal.aborted) {
				this.#finalize(task, { text: "", aborted: true });
				return;
			}
			record.turns += 1;
			const outcome = await task.runner.run({
				cwd: record.cwd,
				prompt,
				model: record.model,
				signal: task.controller.signal,
				hooks: {
					onEvent: event => this.#pushEvent(task, event),
					onAbortHandler: handler => {
						task.abortHandler = handler;
					},
					onSession: sessionFile => {
						record.sessionFile = sessionFile;
					},
				},
			});
			this.#finalize(task, outcome);
		} catch (error) {
			this.#finalize(task, { text: "", error: errMessage(error) });
		}
	}

	#interrupt(task: ActiveTask, reason: string): void {
		const { record } = task;
		if (isTerminalState(record.state)) return;
		if (record.state === "queued") {
			record.state = reason === "timeout" ? "timed_out" : "cancelled";
			record.error = reason === "cancelled" ? undefined : reason;
			record.finishedAt = this.#now();
			this.#pushEvent(task, { type: "settled", summary: `Task ${record.state}` });
			this.#settleWaiters(task);
			this.#onSettled?.(summarizeTask(record));
			return;
		}
		task.cancelled = reason !== "timeout";
		record.error = reason;
		task.controller.abort(reason);
		void task.abortHandler?.(reason).catch(() => undefined);
		if (!task.abortGrace) {
			const graceMs = this.#config.limits.abortGraceMs ?? ABORT_GRACE_MS;
			task.abortGrace = setTimeout(() => {
				task.abortGrace = undefined;
				if (isTerminalState(task.record.state)) return;
				this.#pushEvent(task, {
					type: "abort_unconfirmed",
					summary: `Runner did not settle within ${Math.round(graceMs / 1000)}s of ${reason}`,
				});
			}, graceMs);
			task.abortGrace.unref?.();
		}
	}

	#finalize(task: ActiveTask, outcome: RunOutcome): void {
		const { record } = task;
		if (isTerminalState(record.state)) return;
		if (task.timeout) {
			clearTimeout(task.timeout);
			task.timeout = undefined;
		}
		if (task.abortGrace) {
			clearTimeout(task.abortGrace);
			task.abortGrace = undefined;
		}
		if (task.counted) {
			task.counted = false;
			this.#running = Math.max(0, this.#running - 1);
		}

		record.state = task.timedOut
			? "timed_out"
			: task.cancelled || outcome.aborted
				? "cancelled"
				: outcome.error
					? "failed"
					: "completed";
		record.finishedAt = this.#now();
		if (record.state === "failed") record.error = outcome.error ?? "task failed";
		else record.error = record.error ?? outcome.error;

		const capped = truncateText(outcome.text ?? "", this.#config.limits.maxResultChars);
		record.result = {
			text: capped.text,
			truncated: capped.truncated,
			stopReason: outcome.stopReason,
			usage: outcome.usage,
		};
		if (capped.text.length > 0) {
			record.progress.lastText = truncateText(capped.text, 200).text;
		}
		this.#pushEvent(task, { type: "settled", summary: `Task ${record.state}` });
		this.#scheduleIdle(task);
		this.#evict();
		this.#settleWaiters(task);
		this.#onSettled?.(summarizeTask(record));
		void this.#ensureDiff(task);
		this.#pump();
	}

	#pushEvent(task: ActiveTask, event: Omit<TaskEvent, "at">): void {
		const { record } = task;
		record.events.push({ at: this.#now(), type: event.type, summary: truncateText(event.summary, 400).text });
		const limit = this.#config.limits.maxEventsPerTask;
		// Keep the first event (the launch marker) and drop the oldest interior ones.
		while (record.events.length > limit && limit > 1) record.events.splice(1, 1);
		if (event.type === "tool_execution_start") {
			record.progress.lastTool = event.summary;
			record.progress.toolCalls += 1;
		}
	}

	#settleWaiters(task: ActiveTask): void {
		const waiters = task.waiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	#waitForSettle(task: ActiveTask, timeoutMs: number): Promise<boolean> {
		if (isTerminalState(task.record.state)) return Promise.resolve(true);
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let done = false;
		const waiter = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(true);
		};
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			const index = task.waiters.indexOf(waiter);
			if (index >= 0) task.waiters.splice(index, 1);
			resolve(false);
		}, timeoutMs);
		timer.unref?.();
		task.waiters.push(waiter);
		return promise;
	}

	#scheduleIdle(task: ActiveTask): void {
		this.#cancelIdle(task);
		task.idle = setTimeout(() => {
			task.idle = undefined;
			void this.#disposeRunner(task);
		}, this.#config.limits.idleTtlMs);
		task.idle.unref?.();
	}

	#cancelIdle(task: ActiveTask): void {
		if (task.idle) {
			clearTimeout(task.idle);
			task.idle = undefined;
		}
	}

	async #disposeRunner(task: ActiveTask): Promise<void> {
		const runner = task.runner;
		task.runner = undefined;
		task.abortHandler = undefined;
		task.runnerDisposed = true;
		if (!runner?.dispose) return;
		try {
			await runner.dispose();
		} catch {
			// Teardown failures must not corrupt task state.
		}
	}

	#ensureDiff(task: ActiveTask): Promise<string> {
		if (task.record.diff !== undefined) return Promise.resolve(task.record.diff);
		if (!task.diffPromise) {
			task.diffPromise = captureGitSnapshot(task.record.cwd, this.#config.limits.maxDiffChars).then(diff => {
				task.record.diff = diff;
				return diff;
			});
		}
		return task.diffPromise;
	}

	#evict(): void {
		const overflow = this.#tasks.size - this.#config.limits.maxTasks;
		if (overflow <= 0) return;
		const settled = [...this.#tasks.values()]
			.filter(task => isTerminalState(task.record.state))
			.sort((left, right) => left.record.createdAt - right.record.createdAt);
		for (const task of settled.slice(0, overflow)) {
			this.#cancelIdle(task);
			void this.#disposeRunner(task);
			this.#tasks.delete(task.record.id);
		}
	}
}
