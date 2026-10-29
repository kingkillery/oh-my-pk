/**
 * A HostClient fake: an in-memory connector task table with scripted failure
 * modes, so engine tests can walk launch, watch, cancel and reconcile without
 * touching the network.
 */
import { HostToolError, HostTransportError } from "../src/errors";
import type { HostClient, HostTaskState } from "../src/types";

interface FakeTask {
	id: string;
	state: HostTaskState;
	workspace: string;
	title: string;
	prompt: string;
	turns: number;
	error?: string;
	preview?: string;
	messages: string[];
}

export class FakeHost implements HostClient {
	readonly url = "http://fake-connector.test";
	#seq = 0;
	tasks = new Map<string, FakeTask>();
	/** Failure modes the next calls trip on. */
	launchesFail: "none" | "tool_error" | "not_delivered" | "unknown" = "none";
	unreachable = false;
	calls: string[] = [];

	#failIfUnreachable(): void {
		if (this.unreachable) throw new HostTransportError("not_delivered", `${this.url}: connection refused`);
	}

	launchTask(input: {
		prompt: string;
		workspace: string;
		title: string;
		model?: string;
		timeoutSeconds?: number;
	}): Promise<{ task: { id: string; state: HostTaskState; workspace: string; title: string } }> {
		this.calls.push("launch_task");
		if (this.launchesFail === "not_delivered") {
			this.launchesFail = "none";
			throw new HostTransportError("not_delivered", "connection refused");
		}
		if (this.launchesFail === "unknown") {
			this.launchesFail = "none";
			// The task actually lands; the answer is just lost.
			this.#create(input);
			throw new HostTransportError("unknown", "timed out waiting for the answer");
		}
		if (this.launchesFail === "tool_error") {
			this.launchesFail = "none";
			throw new HostToolError("invalid_request", "workspace is read-only");
		}
		const task = this.#create(input);
		return Promise.resolve({
			task: { id: task.id, state: task.state, workspace: task.workspace, title: task.title },
		});
	}

	#create(input: { prompt: string; workspace: string; title: string }): FakeTask {
		const id = `task-${++this.#seq}`;
		const task: FakeTask = {
			id,
			state: "running",
			workspace: input.workspace,
			title: input.title,
			prompt: input.prompt,
			turns: 1,
			messages: [input.prompt],
		};
		this.tasks.set(id, task);
		return task;
	}

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
	}> {
		this.calls.push("get_task");
		this.#failIfUnreachable();
		const task = this.tasks.get(taskId);
		if (!task) throw new HostToolError("unknown_task", `No task ${taskId}`);
		return Promise.resolve({
			task: {
				id: task.id,
				state: task.state,
				workspace: task.workspace,
				title: task.title,
				turns: task.turns,
				progress: { lastText: task.preview ?? "", toolCalls: task.turns },
				error: task.error,
				preview: task.preview,
			},
		});
	}

	listTasks(): Promise<{ tasks: Array<{ id: string; state: HostTaskState; workspace: string; title: string }> }> {
		this.calls.push("list_tasks");
		this.#failIfUnreachable();
		return Promise.resolve({
			tasks: [...this.tasks.values()].map(t => ({
				id: t.id,
				state: t.state,
				workspace: t.workspace,
				title: t.title,
			})),
		});
	}

	getTaskResult(
		taskId: string,
	): Promise<{ settled: boolean; result?: { text: string; truncated: boolean }; diff?: string }> {
		this.calls.push("get_task_result");
		this.#failIfUnreachable();
		const task = this.tasks.get(taskId);
		if (!task) throw new HostToolError("unknown_task", `No task ${taskId}`);
		const settled = task.state !== "queued" && task.state !== "running";
		return Promise.resolve({
			settled,
			result: settled ? { text: `done: ${task.title}`, truncated: false } : undefined,
			diff: settled ? `diff --git a/x b/x\n+work on ${task.id}` : undefined,
		});
	}

	followUp(taskId: string, message: string): Promise<{ task: { id: string; state: HostTaskState } }> {
		this.calls.push("follow_up_task");
		this.#failIfUnreachable();
		const task = this.tasks.get(taskId);
		if (!task) throw new HostToolError("unknown_task", `No task ${taskId}`);
		task.turns += 1;
		task.state = "running";
		task.messages.push(message);
		return Promise.resolve({ task: { id: task.id, state: task.state } });
	}

	cancelTask(taskId: string, _reason?: string): Promise<{ task: { id: string; state: HostTaskState } }> {
		this.calls.push("cancel_task");
		this.#failIfUnreachable();
		const task = this.tasks.get(taskId);
		if (!task) throw new HostToolError("unknown_task", `No task ${taskId}`);
		task.state = "cancelled";
		return Promise.resolve({ task: { id: task.id, state: task.state } });
	}

	listWorkspaces(): Promise<{
		workspaces: Array<{ id: string; label?: string; allowWrite: boolean; default: boolean }>;
		defaultWorkspace?: string;
	}> {
		return Promise.resolve({
			workspaces: [{ id: "repo", allowWrite: true, default: true }],
			defaultWorkspace: "repo",
		});
	}

	/** Test controls: flip a task to a host-side state. */
	settle(taskId: string, state: HostTaskState, preview?: string): void {
		const task = this.tasks.get(taskId);
		if (!task) throw new Error(`no fake task ${taskId}`);
		task.state = state;
		if (preview !== undefined) task.preview = preview;
	}

	evict(taskId: string): void {
		this.tasks.delete(taskId);
	}
}
