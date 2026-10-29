/**
 * Downstream client: one enrolled host's ompk-chatgpt connector over MCP.
 *
 * The connector speaks the same stateless JSON-RPC shape the gateway serves on
 * its own /mcp: initialize once per client, then `tools/call` per request.
 * Delivery is classified so the job engine can tell "the host never saw this"
 * from "the answer was lost" — the distinction that decides between re-queueing
 * a launch and reconciling for a task that may exist.
 */
import { HostToolError, HostTransportError } from "../errors";
import type { HostCallResult, HostClient, HostTaskState } from "../types";

const REQUEST_TIMEOUT_MS = 30_000;

interface JsonRpcError {
	code: number;
	message: string;
}

function toolErrorCode(message: string): string {
	const match = /^([a-z_]+):/i.exec(message.trim());
	return match ? match[1].toLowerCase() : "internal_error";
}

export class ConnectorClient implements HostClient {
	readonly url: string;
	#token: string;
	#nextId = 1;
	#sessionReady: Promise<void> | undefined;

	constructor(url: string, token: string) {
		this.url = url;
		this.#token = token;
	}

	/** One MCP initialize handshake, retried transparently by callers that reset it. */
	#ensureSession(): Promise<void> {
		this.#sessionReady ??= this.#rpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "ompk-fleet-gateway", version: "0.1.0" },
		}).then(() => undefined);
		return this.#sessionReady;
	}

	async #rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = this.#nextId++;
		let response: Response;
		try {
			response = await fetch(`${this.url}/mcp`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${this.#token}`,
				},
				body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (/timeout|timed out/i.test(message))
				throw new HostTransportError("unknown", `host request timed out: ${message}`);
			throw new HostTransportError("not_delivered", `host unreachable: ${message}`);
		}
		if (response.status === 401 || response.status === 403) {
			throw new HostTransportError("not_delivered", `host rejected the gateway credential (${response.status})`);
		}
		if (response.status === 404) {
			// Connector may have forgotten nothing (it is stateless) — a 404 here
			// means the URL is wrong, not the session. Treat as unreachable.
			throw new HostTransportError(
				"not_delivered",
				`host answered 404 on /mcp — is that connector's /mcp URL right?`,
			);
		}
		if (response.status >= 500)
			throw new HostTransportError("unknown", `host answered ${response.status} — the request may have landed`);
		if (response.status !== 200) throw new HostTransportError("not_delivered", `host answered ${response.status}`);
		let body: { error?: JsonRpcError; result?: unknown };
		try {
			body = (await response.json()) as { error?: JsonRpcError; result?: unknown };
		} catch {
			throw new HostTransportError(
				"unknown",
				"host returned a body that is not JSON-RPC — the request may have landed",
			);
		}
		if (body.error) throw new HostToolError(toolErrorCode(body.error.message), body.error.message);
		return body.result;
	}

	async #call(name: string, args: Record<string, unknown>): Promise<HostCallResult> {
		await this.#ensureSession();
		const result = (await this.#rpc("tools/call", { name, arguments: args })) as {
			content?: Array<{ type: string; text?: string }>;
			structuredContent?: Record<string, unknown>;
			isError?: boolean;
		};
		const text = (result?.content ?? [])
			.filter(c => c?.type === "text")
			.map(c => c.text ?? "")
			.join("\n");
		const out = { text, structured: result?.structuredContent, isError: result?.isError === true };
		if (out.isError) throw new HostToolError(toolErrorCode(text), text || `host tool error on ${name}`);
		return out;
	}

	async listWorkspaces() {
		const out = await this.#call("list_workspaces", {});
		const structured = out.structured as
			| {
					workspaces?: Array<{ id: string; label?: string; allowWrite?: boolean; default?: boolean }>;
					defaultWorkspace?: string;
			  }
			| undefined;
		const workspaces = (structured?.workspaces ?? []).map(w => ({
			id: String(w.id),
			label: w.label,
			allowWrite: w.allowWrite !== false,
			default: w.default === true,
		}));
		return { workspaces, defaultWorkspace: structured?.defaultWorkspace };
	}

	async launchTask(input: {
		prompt: string;
		workspace: string;
		title: string;
		model?: string;
		timeoutSeconds?: number;
	}) {
		const out = await this.#call("launch_task", {
			prompt: input.prompt,
			workspace: input.workspace,
			title: input.title,
			...(input.model ? { model: input.model } : {}),
			...(input.timeoutSeconds ? { timeout_seconds: input.timeoutSeconds } : {}),
			wait_seconds: 0,
		});
		const task = (out.structured as { task?: Record<string, unknown> } | undefined)?.task;
		if (!task || typeof task.id !== "string") {
			throw new HostTransportError("unknown", "host launch returned no task id — the task may exist");
		}
		return {
			task: {
				id: task.id,
				state: task.state as HostTaskState,
				workspace: String(task.workspace ?? input.workspace),
				title: String(task.title ?? input.title),
			},
		};
	}

	async getTask(taskId: string) {
		const out = await this.#call("get_task", { task_id: taskId });
		const task = (out.structured as { task?: Record<string, unknown> } | undefined)?.task;
		if (!task || typeof task.id !== "string") throw new HostTransportError("unknown", "host returned no task record");
		return {
			task: {
				id: task.id,
				state: task.state as HostTaskState,
				workspace: String(task.workspace ?? ""),
				title: String(task.title ?? ""),
				turns: typeof task.turns === "number" ? task.turns : 1,
				progress: task.progress as { lastTool?: string; lastText?: string; toolCalls: number } | undefined,
				error: typeof task.error === "string" ? task.error : undefined,
				preview: typeof task.preview === "string" ? task.preview : undefined,
			},
		};
	}

	async listTasks() {
		const out = await this.#call("list_tasks", {});
		const tasks = ((out.structured as { tasks?: Array<Record<string, unknown>> } | undefined)?.tasks ?? []).map(
			t => ({
				id: String(t.id),
				state: t.state as HostTaskState,
				workspace: String(t.workspace ?? ""),
				title: String(t.title ?? ""),
			}),
		);
		return { tasks };
	}

	async getTaskResult(taskId: string) {
		const out = await this.#call("get_task_result", { task_id: taskId });
		const s = out.structured as
			| { settled?: boolean; result?: { text?: string; truncated?: boolean }; diff?: string }
			| undefined;
		return {
			settled: s?.settled === true,
			result: s?.result ? { text: String(s.result.text ?? ""), truncated: s.result.truncated === true } : undefined,
			diff: typeof s?.diff === "string" ? s.diff : undefined,
		};
	}

	async followUp(taskId: string, message: string) {
		const out = await this.#call("follow_up_task", { task_id: taskId, message, wait_seconds: 0 });
		const task = (out.structured as { task?: Record<string, unknown> } | undefined)?.task;
		return { task: { id: String(task?.id ?? taskId), state: (task?.state ?? "running") as HostTaskState } };
	}

	async cancelTask(taskId: string, reason?: string) {
		const out = await this.#call("cancel_task", { task_id: taskId, ...(reason ? { reason } : {}) });
		const task = (out.structured as { task?: Record<string, unknown> } | undefined)?.task;
		return { task: { id: String(task?.id ?? taskId), state: (task?.state ?? "cancelled") as HostTaskState } };
	}
}
