/**
 * Tool surface exposed to the remote model.
 *
 * Every tool delegates to the TaskService interface so protocol tests can run
 * without a model or a filesystem. Tool text is written for a model reader:
 * short labelled lines, ids first, no ANSI.
 *
 * Model-facing output never carries absolute host paths: workspace entries show
 * ids/labels only and `sessionFile` stays on the local API surface (a remote
 * model cannot act on it anyway). ChatGPT reads tool `annotations` for its
 * confirmation UX and `outputSchema` for structured results, so both are
 * populated per tool.
 */
import type { ConnectorConfig } from "../config";
import { ConnectorError } from "../errors";
import type { TaskRecord, TaskService, TaskSummary } from "../types";

export interface ToolCallResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/** MCP tool safety metadata ChatGPT uses for confirmation behavior. */
export interface ToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface ToolDefinition {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: ToolAnnotations;
}

export interface ToolContext {
	service: TaskService;
	config: ConnectorConfig;
}

interface Tool {
	definition: ToolDefinition;
	run(args: Record<string, unknown>, context: ToolContext): Promise<ToolCallResult>;
}

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false } as const;

const READ_ONLY: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};

const LAUNCH_HINTS: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
};

const taskSummarySchema = {
	type: "object",
	properties: {
		id: { type: "string" },
		title: { type: "string" },
		state: { type: "string", enum: ["queued", "running", "completed", "failed", "cancelled", "timed_out"] },
		workspace: { type: "string" },
		createdAt: { type: "number" },
		startedAt: { type: "number" },
		finishedAt: { type: "number" },
		durationMs: { type: "number" },
		turns: { type: "number" },
		progress: {
			type: "object",
			properties: {
				lastTool: { type: "string" },
				lastText: { type: "string" },
				toolCalls: { type: "number" },
			},
			required: ["toolCalls"],
		},
		error: { type: "string" },
		preview: { type: "string" },
	},
	required: ["id", "state", "workspace", "turns"],
} as const;

const taskResultSchema = {
	type: "object",
	properties: {
		text: { type: "string" },
		stopReason: { type: "string" },
		truncated: { type: "boolean" },
		usage: {
			type: "object",
			properties: {
				inputTokens: { type: "number" },
				outputTokens: { type: "number" },
				totalTokens: { type: "number" },
				requests: { type: "number" },
			},
		},
	},
	required: ["text", "truncated"],
} as const;

/**
 * Model-facing projection of a task summary: identical to `TaskSummary` minus
 * `sessionFile`, which is a host path only a local user can use.
 */
function publicTask(summary: TaskSummary | undefined): Record<string, unknown> | undefined {
	if (!summary) return undefined;
	const { sessionFile: _sessionFile, ...rest } = summary;
	return rest;
}

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new ConnectorError("invalid_request", `${key} must be a non-empty string`);
	}
	return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new ConnectorError("invalid_request", `${key} must be a string`);
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ConnectorError("invalid_request", `${key} must be a number`);
	}
	return Math.min(max, Math.max(min, value));
}

function textResult(text: string, structuredContent?: Record<string, unknown>): ToolCallResult {
	return { content: [{ type: "text", text }], structuredContent };
}

function formatDuration(summary: TaskSummary): string {
	if (summary.durationMs === undefined) return "";
	const seconds = Math.max(0, summary.durationMs) / 1000;
	return seconds < 1 ? " (<1s)" : ` (${seconds.toFixed(1)}s)`;
}

function formatSummary(summary: TaskSummary): string {
	const lines = [
		`id: ${summary.id}`,
		`state: ${summary.state}`,
		`workspace: ${summary.workspace}`,
		`title: ${summary.title}`,
		`turns: ${summary.turns}${formatDuration(summary)}`,
	];
	if (summary.error) lines.push(`error: ${summary.error}`);
	if (summary.preview) lines.push(`preview: ${summary.preview}`);
	return lines.join("\n");
}

function formatRecord(record: TaskRecord, maxChars: number): string {
	const summary: TaskSummary = {
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
		progress: record.progress,
		error: record.error,
	};
	const lines = [formatSummary(summary)];
	if (record.result?.text) {
		const text = record.result.text.length > maxChars ? record.result.text.slice(0, maxChars) : record.result.text;
		lines.push("", "result:", text);
		if (record.result.truncated || text.length < record.result.text.length) {
			lines.push("", "(result truncated; raise max_chars for more)");
		}
	}
	if (record.events.length > 0) {
		lines.push("", "timeline:");
		for (const event of record.events.slice(-12)) lines.push(`- [${event.type}] ${event.summary}`);
	}
	return lines.join("\n");
}

const workspaceSchema = {
	type: "string",
	description: "Workspace id from list_workspaces. Defaults to the connector's configured default.",
} as const;

const waitSchema = {
	type: "number",
	description: "Seconds to block waiting for the task to settle (0 returns immediately).",
	minimum: 0,
	maximum: 300,
} as const;

const workspaceListSchema = {
	type: "object",
	properties: {
		workspaces: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					label: { type: "string" },
					allowWrite: { type: "boolean" },
					default: { type: "boolean" },
				},
				required: ["id", "allowWrite", "default"],
			},
		},
		defaultWorkspace: { type: "string" },
	},
	required: ["workspaces"],
} as const;

const launchedSchema = {
	type: "object",
	properties: { task: taskSummarySchema, settled: { type: "boolean" } },
	required: ["task", "settled"],
} as const;

const taskOnlySchema = {
	type: "object",
	properties: { task: taskSummarySchema },
	required: ["task"],
} as const;

const taskResultOutputSchema = {
	type: "object",
	properties: {
		task: taskSummarySchema,
		settled: { type: "boolean" },
		result: taskResultSchema,
		diff: { type: "string" },
	},
	required: ["settled"],
} as const;

const diffOutputSchema = {
	type: "object",
	properties: { task: taskSummarySchema, diff: { type: "string" } },
	required: ["task", "diff"],
} as const;

const taskListSchema = {
	type: "object",
	properties: { tasks: { type: "array", items: taskSummarySchema } },
	required: ["tasks"],
} as const;

const tools: Tool[] = [
	{
		definition: {
			name: "list_workspaces",
			title: "List workspaces",
			description:
				"List the allowlisted workspaces ompk may run tasks in. Call this first when you do not know which workspace id to use.",
			inputSchema: NO_ARGS,
			outputSchema: workspaceListSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async run(_args, { config }) {
			const workspaces = config.workspaces.map(workspace => ({
				id: workspace.id,
				label: workspace.label,
				allowWrite: workspace.allowWrite !== false,
				default: workspace.id === config.defaults.workspace,
			}));
			const text = workspaces
				.map(
					workspace =>
						`${workspace.id}${workspace.default ? " (default)" : ""} — ${workspace.label ?? "workspace"}${workspace.allowWrite ? "" : " [read-only]"}`,
				)
				.join("\n");
			return textResult(text, { workspaces, defaultWorkspace: config.defaults.workspace });
		},
	},
	{
		definition: {
			name: "launch_task",
			title: "Launch an ompk task",
			description:
				"Start an autonomous ompk coding task in an allowlisted workspace. Returns a task id. Long work keeps running after this call; poll with get_task or wait_task, then read the answer with get_task_result.",
			inputSchema: {
				type: "object",
				properties: {
					prompt: {
						type: "string",
						description:
							"The assignment. Be specific: goal, constraints, files to touch, and how to verify. The task runs without further questions.",
					},
					workspace: workspaceSchema,
					title: { type: "string", description: "Short label shown in task lists." },
					model: {
						type: "string",
						description: "Model selector override, e.g. `anthropic/claude-sonnet-4-5` or a configured role.",
					},
					timeout_seconds: {
						type: "number",
						description: "Hard wall-clock limit for this task in seconds.",
						minimum: 1,
						maximum: 86_400,
					},
					wait_seconds: waitSchema,
				},
				required: ["prompt"],
				additionalProperties: false,
			},
			outputSchema: launchedSchema,
			annotations: LAUNCH_HINTS,
		},
		async run(args, { service, config }) {
			const waitSeconds = optionalNumber(args, "wait_seconds", 0, 300) ?? config.defaults.waitSeconds;
			const timeoutSeconds = optionalNumber(args, "timeout_seconds", 1, 86_400);
			const launched = await service.launch({
				prompt: requireString(args, "prompt"),
				workspace: optionalString(args, "workspace"),
				title: optionalString(args, "title"),
				model: optionalString(args, "model"),
				timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
				waitSeconds,
			});
			const settled = launched.settled;
			let text = `Task launched.\n${formatSummary(launched.task)}`;
			if (settled && launched.task.state !== "running" && launched.task.state !== "queued") {
				const record = service.result(launched.task.id, config.limits.maxResultChars);
				if (record?.result?.text) text += `\n\nresult:\n${record.result.text}`;
			} else if (!settled) {
				text += `\n\nThe task is still running. Use wait_task or get_task with this id.`;
			}
			return textResult(text, { task: publicTask(launched.task), settled });
		},
	},
	{
		definition: {
			name: "get_task",
			title: "Get task status",
			description: "Read one task's current state, progress, and recent timeline without waiting.",
			inputSchema: {
				type: "object",
				properties: { task_id: { type: "string", description: "Task id returned by launch_task." } },
				required: ["task_id"],
				additionalProperties: false,
			},
			outputSchema: taskOnlySchema,
			annotations: READ_ONLY,
		},
		async run(args, { service }) {
			const taskId = requireString(args, "task_id");
			const summary = service.status(taskId);
			if (!summary) throw new ConnectorError("unknown_task", `Unknown task: ${taskId}`);
			const record = service.record?.(taskId);
			const text = record ? formatRecord(record, 2_000) : formatSummary(summary);
			return textResult(text, { task: publicTask(summary) });
		},
	},
	{
		definition: {
			name: "wait_task",
			title: "Wait for a task",
			description:
				"Block until a task settles or the timeout elapses. Use a short timeout for interactive replies; call again if it is still running.",
			inputSchema: {
				type: "object",
				properties: {
					task_id: { type: "string", description: "Task id returned by launch_task." },
					timeout_seconds: {
						type: "number",
						description: "Maximum seconds to wait (default 60, max 300).",
						minimum: 0,
						maximum: 300,
					},
				},
				required: ["task_id"],
				additionalProperties: false,
			},
			outputSchema: launchedSchema,
			annotations: READ_ONLY,
		},
		async run(args, { service }) {
			const taskId = requireString(args, "task_id");
			const timeoutSeconds = optionalNumber(args, "timeout_seconds", 0, 300) ?? 60;
			const summary = await service.waitFor(taskId, timeoutSeconds * 1000);
			if (!summary) throw new ConnectorError("unknown_task", `Unknown task: ${taskId}`);
			const settled = summary.state !== "running" && summary.state !== "queued";
			const text = `${settled ? "Task settled." : "Task still running."}\n${formatSummary(summary)}`;
			return textResult(text, { task: publicTask(summary), settled });
		},
	},
	{
		definition: {
			name: "get_task_result",
			title: "Read a task's answer",
			description:
				"Return the final answer text for a settled task. For a running task it returns progress instead and asks you to wait.",
			inputSchema: {
				type: "object",
				properties: {
					task_id: { type: "string", description: "Task id returned by launch_task." },
					max_chars: {
						type: "number",
						description: "Cap on returned characters (defaults to the connector limit).",
						minimum: 500,
						maximum: 100_000,
					},
				},
				required: ["task_id"],
				additionalProperties: false,
			},
			outputSchema: taskResultOutputSchema,
			annotations: READ_ONLY,
		},
		async run(args, { service, config }) {
			const taskId = requireString(args, "task_id");
			const maxChars = optionalNumber(args, "max_chars", 500, 100_000) ?? config.limits.maxResultChars;
			const record = service.result(taskId, maxChars);
			if (!record) throw new ConnectorError("unknown_task", `Unknown task: ${taskId}`);
			const summary = service.status(taskId);
			const settled = summary ? summary.state !== "running" && summary.state !== "queued" : false;
			const text = formatRecord(record, maxChars);
			return textResult(text, {
				task: publicTask(summary),
				settled,
				result: record.result,
				diff: record.diff,
			});
		},
	},
	{
		definition: {
			name: "get_task_diff",
			title: "Read a task's git diff",
			description: "Return the workspace git status/diff captured for a task (computed on first request).",
			inputSchema: {
				type: "object",
				properties: {
					task_id: { type: "string", description: "Task id returned by launch_task." },
					max_chars: { type: "number", description: "Cap on returned characters.", minimum: 200, maximum: 50_000 },
				},
				required: ["task_id"],
				additionalProperties: false,
			},
			outputSchema: diffOutputSchema,
			annotations: READ_ONLY,
		},
		async run(args, { service, config }) {
			const taskId = requireString(args, "task_id");
			const maxChars = optionalNumber(args, "max_chars", 200, 50_000) ?? config.limits.maxDiffChars;
			const result = await service.diff(taskId, maxChars);
			if (!result) throw new ConnectorError("unknown_task", `Unknown task: ${taskId}`);
			return textResult(result.diff.length > 0 ? result.diff : "(no changes)", {
				task: publicTask(result.task),
				diff: result.diff,
			});
		},
	},
	{
		definition: {
			name: "follow_up_task",
			title: "Follow up on a task",
			description:
				"Send another instruction to a settled task, continuing its session context. Fails while the task is still running.",
			inputSchema: {
				type: "object",
				properties: {
					task_id: { type: "string", description: "Task id returned by launch_task." },
					message: { type: "string", description: "The follow-up instruction." },
					wait_seconds: waitSchema,
				},
				required: ["task_id", "message"],
				additionalProperties: false,
			},
			outputSchema: launchedSchema,
			annotations: LAUNCH_HINTS,
		},
		async run(args, { service, config }) {
			const taskId = requireString(args, "task_id");
			const message = requireString(args, "message");
			const waitSeconds = optionalNumber(args, "wait_seconds", 0, 300) ?? config.defaults.waitSeconds;
			const launched = await service.followup(taskId, message, waitSeconds);
			if (!launched) throw new ConnectorError("unknown_task", `Unknown task: ${taskId}`);
			let text = `Follow-up accepted.\n${formatSummary(launched.task)}`;
			if (launched.settled && launched.task.state !== "running" && launched.task.state !== "queued") {
				const record = service.result(launched.task.id, config.limits.maxResultChars);
				if (record?.result?.text) text += `\n\nresult:\n${record.result.text}`;
			}
			return textResult(text, { task: publicTask(launched.task), settled: launched.settled });
		},
	},
	{
		definition: {
			name: "cancel_task",
			title: "Cancel a task",
			description: "Interrupt a queued or running task. Settled tasks are returned unchanged.",
			inputSchema: {
				type: "object",
				properties: {
					task_id: { type: "string", description: "Task id returned by launch_task." },
					reason: { type: "string", description: "Optional cancellation reason for the audit trail." },
				},
				required: ["task_id"],
				additionalProperties: false,
			},
			outputSchema: taskOnlySchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async run(args, { service }) {
			const taskId = requireString(args, "task_id");
			const summary = await service.cancel(taskId, optionalString(args, "reason"));
			if (!summary) throw new ConnectorError("unknown_task", `Unknown task: ${taskId}`);
			return textResult(`Task ${summary.state}.\n${formatSummary(summary)}`, { task: publicTask(summary) });
		},
	},
	{
		definition: {
			name: "list_tasks",
			title: "List tasks",
			description: "List tasks launched by this connector, newest first, with state and a short preview.",
			inputSchema: NO_ARGS,
			outputSchema: taskListSchema,
			annotations: READ_ONLY,
		},
		async run(_args, { service }) {
			const tasks = service.list();
			if (tasks.length === 0) return textResult("No tasks have been launched.", { tasks: [] });
			const text = tasks
				.map(
					task =>
						`${task.id} — ${task.state} — ${task.workspace} — ${task.title}${task.preview ? `\n  ${task.preview}` : ""}`,
				)
				.join("\n");
			return textResult(text, { tasks: tasks.map(task => publicTask(task)) });
		},
	},
];

const byName = new Map(tools.map(tool => [tool.definition.name, tool]));

/** Tool descriptors for `tools/list`. */
export function listToolDefinitions(): ToolDefinition[] {
	return tools.map(tool => tool.definition);
}

/** Dispatch one `tools/call`, converting connector errors into tool errors. */
export async function callTool(
	name: string,
	args: Record<string, unknown> | undefined,
	context: ToolContext,
): Promise<ToolCallResult> {
	const tool = byName.get(name);
	if (!tool) {
		return {
			content: [{ type: "text", text: `Unknown tool: ${name}. Available: ${[...byName.keys()].join(", ")}` }],
			isError: true,
		};
	}
	try {
		return await tool.run(args ?? {}, context);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = error instanceof ConnectorError ? error.code : "internal_error";
		return {
			content: [{ type: "text", text: `[${code}] ${message}` }],
			isError: true,
			structuredContent: { error: { code, message } },
		};
	}
}
