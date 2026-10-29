/**
 * Shared types for the ompk fleet gateway.
 *
 * A "job" is a task the gateway follows on one enrolled host: the ledger row
 * plus its host connector's task id once launched. Job states are the
 * gateway's own vocabulary; the host's task states map onto them in the
 * watcher (docs/DESIGN.md#jobs).
 */

/** Gateway-side lifecycle of a job. */
export type JobState =
	| "queued"
	| "dispatching"
	| "running"
	| "idle"
	| "cancel_requested"
	| "cancelled"
	| "failed"
	| "released"
	| "unknown";

/** Connector-side task state, as reported by `get_task`/`list_tasks`. */
export type HostTaskState = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set(["cancelled", "failed", "released"]);

/** Slot-holding states against a host's maxConcurrentJobs. */
export const SLOT_STATES: ReadonlySet<JobState> = new Set(["dispatching", "running", "cancel_requested", "unknown"]);

/** One configured machine. */
export interface HostConfig {
	/** Stable short id used in scopes, aliases and output. */
	id: string;
	label?: string;
	/** Base URL of the host's ompk-chatgpt connector (http only on loopback). */
	connectorUrl: string;
	/** Static bearer credential, or minted at startup by tokenCommand. */
	token?: string;
	/** argv (no shell) run once per process to mint the host credential. */
	tokenCommand?: string[];
	/** Concurrent running jobs; extra launches stay queued. */
	maxConcurrentJobs: number;
	/** Workspace alias used when a job names this host and no workspace. */
	defaultWorkspace?: string;
}

/** A named destination agents use. */
export interface WorkspaceAlias {
	/** What agents pass as `project`/`workspace`. */
	alias: string;
	description?: string;
	/** Host id this alias lives on. */
	host: string;
	/** The connector's own workspace id on that host. */
	workspace: string;
	/** Model selector forwarded to `launch_task`, if configured. */
	model?: string;
	/** False: agents may not launch here (read/follow only). */
	allowStart: boolean;
	/** Preferred alias when several share a host. */
	default?: boolean;
}

export interface GatewayConfig {
	publicUrl: string;
	listen: { host: string; port: number };
	hosts: HostConfig[];
	workspaces: WorkspaceAlias[];
	tokens: { accessTtlSeconds: number; refreshIdleTtlDays: number };
	watcher: { pollSeconds: number; hostBackoffSeconds: number };
	limits: { taskChars: number; jobsPerClient: number; feedWindow: number };
}

/** A ledger row for one job. */
export interface Job {
	id: string;
	clientId: string;
	state: JobState;
	host: string;
	workspace: string;
	workspaceAlias?: string;
	title: string;
	task: string;
	model?: string;
	timeoutSeconds?: number;
	/** The host connector's task id, once launched. */
	taskId?: string;
	progressText?: string;
	progressAt?: number;
	lastError?: { code: string; message: string; at: number };
	createdAt: number;
	dispatchedAt?: number;
	finishedAt?: number;
}

/** One append-only feed entry. */
export interface JobEvent {
	id: number;
	jobId: string;
	at: number;
	type: string;
	/** state transitions carry from/to; other types carry a reason. */
	detail?: Record<string, unknown>;
}

/** Credentials a host client call needs, resolved at startup. */
export interface ResolvedHost extends HostConfig {
	token?: string;
}

/** Result of a host connector `tools/call`. */
export interface HostCallResult {
	text: string;
	structured?: Record<string, unknown>;
	isError: boolean;
}

/** The downstream surface the job engine speaks. Faked in tests. */
export interface HostClient {
	listWorkspaces(): Promise<{
		workspaces: Array<{ id: string; label?: string; allowWrite: boolean; default: boolean }>;
		defaultWorkspace?: string;
	}>;
	launchTask(input: {
		prompt: string;
		workspace: string;
		title: string;
		model?: string;
		timeoutSeconds?: number;
	}): Promise<{ task: { id: string; state: HostTaskState; workspace: string; title: string } }>;
	getTask(taskId: string): Promise<{
		task: {
			id: string;
			state: HostTaskState;
			workspace: string;
			title: string;
			turns: number;
			progress?: { lastTool?: string; lastText?: string; toolCalls: number };
			error?: string;
			preview?: string;
		};
	}>;
	listTasks(): Promise<{ tasks: Array<{ id: string; state: HostTaskState; workspace: string; title: string }> }>;
	getTaskResult(
		taskId: string,
	): Promise<{ settled: boolean; result?: { text: string; truncated: boolean }; diff?: string }>;
	followUp(taskId: string, message: string): Promise<{ task: { id: string; state: HostTaskState } }>;
	cancelTask(taskId: string, reason?: string): Promise<{ task: { id: string; state: HostTaskState } }>;
	/** Base URL of the host this client dials (for diagnostics only). */
	readonly url: string;
}
