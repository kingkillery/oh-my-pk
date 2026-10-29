/**
 * Shared types for the ChatGPT connector.
 *
 * The connector is a remote MCP server (and a mirroring REST surface) that lets
 * ChatGPT launch ompk tasks in an allowlisted workspace and read their results.
 * Nothing here imports the coding agent: the session runner lives in its own
 * module so the protocol layer stays cheap to load and easy to test.
 */

/** Lifecycle state of a launched task. */
export type TaskState = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

/** Token/usage counters reported by the underlying agent turn. */
export interface TaskUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	requests: number;
}

/** One condensed timeline entry. Large payloads are truncated at capture time. */
export interface TaskEvent {
	/** Milliseconds since epoch. */
	at: number;
	/** Agent event type, or a connector-local type (`launch`, `followup`, ...). */
	type: string;
	/** Human-readable one-liner safe to surface to a model. */
	summary: string;
}

/** Final output of a task. */
export interface TaskResult {
	/** Assistant text, capped by the manager's output cap. */
	text: string;
	/** Provider stop reason when known (`end_turn`, `aborted`, `error`, ...). */
	stopReason?: string;
	/** True when `text` was truncated for transport. */
	truncated: boolean;
	/** Usage accumulated across the task's turns. */
	usage?: TaskUsage;
}

/** A launched task as observed by the connector. */
export interface TaskRecord {
	id: string;
	title: string;
	state: TaskState;
	/** Allowlisted workspace id the task runs in. */
	workspace: string;
	/** Absolute path of the workspace. */
	cwd: string;
	/** The original assignment text. */
	prompt: string;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Number of prompts accepted so far (launch + follow-ups). */
	turns: number;
	/** Bounded timeline of condensed events. */
	events: TaskEvent[];
	/** Rolling progress summary kept in sync with `events`. */
	progress: {
		lastTool?: string;
		lastText?: string;
		toolCalls: number;
	};
	result?: TaskResult;
	/** Failure/cancellation reason. */
	error?: string;
	/** `git status`/`diff --stat` snapshot captured when the task finished. */
	diff?: string;
	/** Model selector requested at launch, when any. */
	model?: string;
	/**
	 * ompk session file backing this task, when the runner persists one. ChatGPT
	 * cannot read it, but the user can resume the same conversation locally with
	 * `ompk --resume <path>`.
	 */
	sessionFile?: string;
}

/** Public projection returned by list/status tools (drops the full prompt text). */
export interface TaskSummary {
	id: string;
	title: string;
	state: TaskState;
	workspace: string;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	durationMs?: number;
	turns: number;
	progress: TaskRecord["progress"];
	error?: string;
	/** Short preview of the final answer. */
	preview?: string;
	/** Session file the user can resume locally. */
	sessionFile?: string;
}

/** A launch request accepted by the manager. */
export interface LaunchTaskInput {
	/** Allowlisted workspace id. Defaults to the connector's configured default. */
	workspace?: string;
	/** The work to perform. */
	prompt: string;
	/** UI label; defaults to a truncated prompt. */
	title?: string;
	/** Model selector passed to the session. */
	model?: string;
	/** Hard wall-clock limit; defaults to `limits.taskTimeoutMs`. */
	timeoutMs?: number;
	/**
	 * Block up to this long for the task to settle before returning. The MCP
	 * layer maps its `wait_seconds` argument onto this field so short tasks can
	 * answer in one round trip.
	 */
	waitSeconds?: number;
}

/** Outcome of `TaskManager.launch`. */
export interface LaunchTaskResult {
	task: TaskSummary;
	/** True when the caller asked to wait and the task settled within the window. */
	settled: boolean;
}

/** Interface the MCP tool layer depends on. Implemented by `TaskManager`, faked in tests. */
export interface TaskService {
	launch(input: LaunchTaskInput): Promise<LaunchTaskResult>;
	list(): TaskSummary[];
	status(taskId: string): TaskSummary | undefined;
	/** Full retained record, including the bounded timeline. */
	record?(taskId: string): TaskRecord | undefined;
	result(taskId: string, maxChars?: number): TaskRecord | undefined;
	diff(taskId: string, maxChars?: number): Promise<{ task: TaskSummary; diff: string } | undefined>;
	followup(taskId: string, message: string, waitSeconds?: number): Promise<LaunchTaskResult | undefined>;
	cancel(taskId: string, reason?: string): Promise<TaskSummary | undefined>;
	/** Resolves once the task leaves `queued`/`running`, or after `timeoutMs`. */
	waitFor(taskId: string, timeoutMs: number): Promise<TaskSummary | undefined>;
	/** Waits for shutdown to drain running tasks. */
	shutdown(): Promise<void>;
}

/** Result of running one assignment against an ompk session. */
export interface RunOutcome {
	text: string;
	stopReason?: string;
	usage?: TaskUsage;
	error?: string;
	aborted?: boolean;
}

/** Callbacks a session runner uses to report progress. */
export interface RunHooks {
	/** Progress events without a timestamp; the manager stamps them. */
	onEvent(event: Omit<TaskEvent, "at">): void;
	/** Registered by the runner so the manager can interrupt the task. */
	onAbortHandler(handler: (reason?: string) => Promise<void>): void;
	/** Reported once the backing session exists, so the record can expose its file. */
	onSession?(sessionFile: string | undefined): void;
}

/** A runner capable of executing one task assignment in a workspace. */
export interface SessionRunner {
	run(input: {
		cwd: string;
		prompt: string;
		model?: string;
		signal: AbortSignal;
		hooks: RunHooks;
	}): Promise<RunOutcome>;
	/** Optional per-task teardown; called on settle, cancel, and timeout. */
	dispose?(): Promise<void>;
}
