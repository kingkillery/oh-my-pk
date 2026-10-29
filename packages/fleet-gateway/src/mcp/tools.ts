/**
 * The eleven fleet tools. Each handler validates its arguments, applies the
 * caller's scope through {@link JobService}, and returns a `text` payload an
 * agent can act on — errors land as `isError` tool results, never JSON-RPC
 * errors, so agents see the code and can retry sensibly.
 */

import { permits, permittedHosts } from "../auth/scopes";
import { GatewayError, HostToolError, HostTransportError } from "../errors";
import type { Caller, JobService } from "../jobs/service";
import type { GatewayConfig, Job } from "../types";
import type { ToolListEntry, ToolResult } from "./server";

function text(s: string, structured?: Record<string, unknown>): ToolResult {
	const result: ToolResult = { content: [{ type: "text", text: s }] };
	if (structured) result.structuredContent = structured;
	return result;
}

function fail(error: unknown): ToolResult {
	if (error instanceof GatewayError) {
		return {
			content: [{ type: "text", text: `${error.code}: ${error.message}` }],
			isError: true,
			structuredContent: { error: error.code, message: error.message, details: error.details },
		};
	}
	if (error instanceof HostToolError) {
		return {
			content: [{ type: "text", text: `host_error ${error.code}: ${error.message}` }],
			isError: true,
			structuredContent: { error: "host_error", code: error.code, message: error.message },
		};
	}
	if (error instanceof HostTransportError) {
		return {
			content: [{ type: "text", text: `host_unreachable: ${error.message} (delivery: ${error.delivery})` }],
			isError: true,
			structuredContent: { error: "host_unreachable", delivery: error.delivery, message: error.message },
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: `internal_error: ${message}` }],
		isError: true,
		structuredContent: { error: "internal_error", message },
	};
}

function str(args: Record<string, unknown>, key: string, required = true): string | undefined {
	const v = args[key];
	if (v === undefined || v === null) {
		if (required) throw new GatewayError("invalid_request", `${key} is required`);
		return undefined;
	}
	if (typeof v !== "string") throw new GatewayError("invalid_request", `${key} must be a string`);
	return v;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
	const v = args[key];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "number" || !Number.isFinite(v))
		throw new GatewayError("invalid_request", `${key} must be a number`);
	return v;
}

function jobView(job: Job): Record<string, unknown> {
	return {
		jobId: job.id,
		state: job.state,
		host: job.host,
		workspace: job.workspaceAlias ?? job.workspace,
		title: job.title,
		taskId: job.taskId,
		progress: job.progressText,
		error: job.lastError,
		createdAt: new Date(job.createdAt).toISOString(),
		finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
	};
}

const JOB_ID = /^[0-9a-z]{10}$/;

export function buildToolList(): ToolListEntry[] {
	const obj = (props: Record<string, unknown>, required: string[] = []) => ({
		type: "object",
		properties: props,
		required,
		additionalProperties: false,
	});
	return [
		{
			name: "fleet_status",
			description:
				"Read the fleet: every configured host and workspace alias, whether each host answers right now, the caller's own scopes, and open jobs. Call this first to learn aliases and host names.",
			inputSchema: obj({}),
			annotations: { readOnlyHint: true },
		},
		{
			name: "fleet_workspaces",
			description:
				"List workspace aliases with their host, allow_start flag and configured model. Aliases are the only way work_start addresses a machine directory.",
			inputSchema: obj({}),
			annotations: { readOnlyHint: true },
		},
		{
			name: "work_list",
			description:
				"List jobs. Filter by workspace alias, host id, or states (queued|dispatching|running|idle|cancel_requested|cancelled|failed|released|unknown). Newest first, limit 50.",
			inputSchema: obj({
				workspace: { type: "string" },
				host: { type: "string" },
				states: { type: "array", items: { type: "string" } },
				limit: { type: "number" },
			}),
			annotations: { readOnlyHint: true },
		},
		{
			name: "work_status",
			description: "One job's state, progress and last error. Follow with work_result when it reaches idle.",
			inputSchema: obj({ jobId: { type: "string", description: "10-char job id" } }, ["jobId"]),
			annotations: { readOnlyHint: true },
		},
		{
			name: "work_result",
			description:
				"The finished job's outcome text from the host, with files changed when the host reports them. Only meaningful once the job is idle.",
			inputSchema: obj({ jobId: { type: "string" } }, ["jobId"]),
			annotations: { readOnlyHint: true },
		},
		{
			name: "work_diff",
			description:
				"The job's git diff (or the workspace's live diff while running), as reported by the host connector.",
			inputSchema: obj({ jobId: { type: "string" } }, ["jobId"]),
			annotations: { readOnlyHint: true },
		},
		{
			name: "work_feed",
			description:
				"One cursor over every job you may see. Pass `cursor` (0 first), get events since then, a `next` cursor, and the open jobs needing attention. Poll between long waits.",
			inputSchema: obj({ cursor: { type: "number" }, limit: { type: "number" } }),
			annotations: { readOnlyHint: true },
		},
		{
			name: "work_messages",
			description:
				"A job's ledger events: launches, state changes, progress lines and errors — the history behind work_status.",
			inputSchema: obj({ jobId: { type: "string" }, cursor: { type: "number" } }, ["jobId"]),
			annotations: { readOnlyHint: true },
		},
		{
			name: "work_start",
			description:
				"Launch a task on a workspace. Give `workspace` (an alias) or `target.host` (uses the host's default workspace). Returns a job you watch via work_status/work_feed; the job settles to idle, then work_result. `requestId` makes retries safe: reuse it on network failure.",
			inputSchema: obj(
				{
					requestId: { type: "string", description: "Caller-chosen idempotency key" },
					task: { type: "string", description: "The instruction for the coding agent" },
					workspace: { type: "string", description: "Workspace alias" },
					target: { type: "object", properties: { host: { type: "string" } }, additionalProperties: false },
					title: { type: "string" },
					model: { type: "string" },
					timeoutSeconds: { type: "number" },
				},
				["requestId", "task"],
			),
		},
		{
			name: "work_continue",
			description:
				"Send a follow-up message to an idle job — same host session, full history. `requestId` idempotency as in work_start.",
			inputSchema: obj({ requestId: { type: "string" }, jobId: { type: "string" }, message: { type: "string" } }, [
				"requestId",
				"jobId",
				"message",
			]),
		},
		{
			name: "work_cancel",
			description:
				"Cancel a running job (interrupts the agent turn; the job lands idle). Queued jobs cancel without touching the host.",
			inputSchema: obj({ jobId: { type: "string" }, reason: { type: "string" } }, ["jobId"]),
		},
	];
}

export interface ToolDeps {
	service: JobService;
	config: GatewayConfig;
	callerFor: () => Caller;
}

/** The dispatcher behind tools/call. */
export async function callTool(deps: ToolDeps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
	const { service, config } = deps;
	const caller = deps.callerFor();
	try {
		switch (name) {
			case "fleet_status": {
				const allowed = permittedHosts(caller.scopes, "read");
				const hosts = config.hosts
					.filter(h => !allowed || allowed.includes(h.id))
					.map(h => ({
						id: h.id,
						label: h.label,
						connector: h.connectorUrl,
						defaultWorkspace: h.defaultWorkspace,
						maxConcurrentJobs: h.maxConcurrentJobs,
						reachable: service.engine.hostUnreachableSince(h.id) === undefined,
						access: permits(caller.scopes, "operate", h.id) ? "operate" : "read",
					}));
				const workspaces = config.workspaces
					.filter(w => !allowed || allowed.includes(w.host))
					.map(w => ({
						alias: w.alias,
						host: w.host,
						description: w.description,
						allowStart: w.allowStart !== false,
					}));
				const open = service
					.listJobs(caller, {
						states: ["queued", "dispatching", "running", "cancel_requested", "unknown"],
						limit: 50,
					})
					.map(j => jobView(j));
				return text(
					JSON.stringify({ hosts, workspaces, openJobs: open, callerScopes: caller.scopes.map(String) }, null, 2),
					{ hosts, workspaces, openJobs: open },
				);
			}
			case "fleet_workspaces": {
				const allowed = permittedHosts(caller.scopes, "read");
				const rows = config.workspaces
					.filter(w => !allowed || allowed.includes(w.host))
					.map(w => ({
						alias: w.alias,
						host: w.host,
						description: w.description,
						allowStart: w.allowStart !== false,
						model: w.model,
					}));
				return text(JSON.stringify({ workspaces: rows }, null, 2), { workspaces: rows });
			}
			case "work_list": {
				const states = Array.isArray(args.states)
					? args.states.filter((s): s is Job["state"] => typeof s === "string")
					: undefined;
				const limit = Math.min(num(args, "limit") ?? 50, 100);
				const jobs = service
					.listJobs(caller, {
						workspace: str(args, "workspace", false),
						host: str(args, "host", false),
						states,
						limit,
					})
					.map(j => jobView(j));
				return text(JSON.stringify({ jobs }, null, 2), { jobs });
			}
			case "work_status": {
				const jobId = str(args, "jobId")!;
				if (!JOB_ID.test(jobId))
					throw new GatewayError("invalid_request", `jobId must be the 10-char id, got ${jobId}`);
				return text(
					JSON.stringify(jobView(service.getJob(caller, jobId)), null, 2),
					jobView(service.getJob(caller, jobId)),
				);
			}
			case "work_result": {
				const job = service.getJob(caller, str(args, "jobId")!);
				if (job.state !== "idle") {
					return text(
						`Job ${job.id} is ${job.state}, not idle — work_status shows progress; work_result matters once the run settles.`,
						{ jobId: job.id, state: job.state },
					);
				}
				const client = service.hostClient(job.host);
				if (!client || !job.taskId) {
					return text(
						`Job ${job.id} finished on the host, but its session record is no longer reachable; the ledger shows: ${job.lastError?.message ?? job.progressText ?? "(no detail)"}`,
						jobView(job),
					);
				}
				const { settled, result, diff } = await client.getTaskResult(job.taskId);
				const out = {
					jobId: job.id,
					state: job.state,
					settled,
					text: result?.text,
					truncated: result?.truncated,
					diff,
				};
				return text(result?.text ?? JSON.stringify(out, null, 2), out);
			}
			case "work_diff": {
				const job = service.getJob(caller, str(args, "jobId")!);
				const client = service.hostClient(job.host);
				if (!client || !job.taskId) {
					return text(`Job ${job.id} has no host task to diff.`, { jobId: job.id, state: job.state });
				}
				const { diff } = await client.getTaskResult(job.taskId);
				return text(diff || "(no diff)", { jobId: job.id, diff });
			}
			case "work_feed": {
				const cursor = num(args, "cursor") ?? 0;
				const limit = num(args, "limit") ?? 200;
				const feed = service.feed(caller, cursor, limit);
				return text(JSON.stringify(feed, null, 2), feed);
			}
			case "work_messages": {
				const job = service.getJob(caller, str(args, "jobId")!);
				const cursor = num(args, "cursor") ?? 0;
				const { events, next } = service.feedForJob(caller, job.id, cursor);
				return text(JSON.stringify({ jobId: job.id, events, next }, null, 2), { jobId: job.id, events, next });
			}
			case "work_start": {
				const target =
					typeof args.target === "object" &&
					args.target !== null &&
					"host" in args.target &&
					typeof args.target.host === "string"
						? { host: args.target.host }
						: undefined;
				const job = service.startWork(caller, {
					requestId: str(args, "requestId")!,
					task: str(args, "task")!,
					workspace: str(args, "workspace", false),
					target,
					title: str(args, "title", false),
					model: str(args, "model", false),
					timeoutSeconds: num(args, "timeoutSeconds"),
				});
				service.engine.requestTick();
				return text(
					`Job ${job.id} queued on ${job.host} (${job.workspaceAlias ?? job.workspace}). Watch it with work_status or work_feed; it settles to idle, then work_result.`,
					jobView(job),
				);
			}
			case "work_continue": {
				const job = await service.continueWork(caller, {
					requestId: str(args, "requestId")!,
					jobId: str(args, "jobId")!,
					message: str(args, "message")!,
				});
				service.engine.requestTick();
				return text(`Job ${job.id} is ${job.state}.`, jobView(job));
			}
			case "work_cancel": {
				const job = await service.cancelWork(caller, {
					jobId: str(args, "jobId")!,
					reason: str(args, "reason", false),
				});
				return text(`Job ${job.id} is ${job.state}.`, jobView(job));
			}
			default:
				return {
					content: [{ type: "text", text: `unknown tool: ${name}` }],
					isError: true,
					structuredContent: { error: "unknown_tool" },
				};
		}
	} catch (error) {
		return fail(error);
	}
}
