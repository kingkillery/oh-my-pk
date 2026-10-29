/**
 * The tool-facing job layer: scope enforcement, request-id idempotency, and
 * workspace resolution sit here so `mcp/tools` stays thin.
 *
 * Per-host grants are applied to every read and write: a job on a host the
 * caller cannot read is `not_found`, and one it can read but not operate is
 * `insufficient_scope` — the same split the t3 gateway makes.
 */

import { permits, permittedHosts, type Scope } from "../auth/scopes";
import type { Store } from "../db/store";
import { GatewayError } from "../errors";
import type { GatewayConfig, HostClient, Job, JobState, WorkspaceAlias } from "../types";
import { type JobEngine, newJobId, requestInputHash } from "./engine";

export interface Caller {
	clientId: string;
	scopes: readonly Scope[];
	grantId?: string;
}

export interface JobView extends Job {
	link?: string;
}

const ALIAS = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class JobService {
	#store: Store;
	#config: GatewayConfig;
	#engine: JobEngine;

	constructor(deps: { store: Store; config: GatewayConfig; engine: JobEngine }) {
		this.#store = deps.store;
		this.#config = deps.config;
		this.#engine = deps.engine;
	}

	get engine(): JobEngine {
		return this.#engine;
	}

	hostClient(hostId: string): HostClient | undefined {
		return this.#engine.clientFor(hostId);
	}

	#requireLevel(caller: Caller, level: "read" | "operate", host: string, what: string): void {
		if (!permits(caller.scopes, level, host)) {
			throw new GatewayError(
				"insufficient_scope",
				`${what} requires ${level} access on host ${host}. Reconnect this agent with that level on the approval page.`,
				{ host, level },
			);
		}
	}

	/** A job the caller cannot see is an unknown id, never "exists but denied". */
	#requireJob(caller: Caller, jobId: string, level: "read" | "operate"): Job {
		const job = this.#store.getJob(jobId);
		if (!job) throw new GatewayError("not_found", `Unknown job: ${jobId}`);
		if (!permits(caller.scopes, "read", job.host)) throw new GatewayError("not_found", `Unknown job: ${jobId}`);
		this.#requireLevel(caller, level, job.host, `This operation`);
		return job;
	}

	/* ------------------------------ reads -------------------------------- */

	listJobs(caller: Caller, filter: { workspace?: string; host?: string; states?: JobState[]; limit?: number }): Job[] {
		const allowed = permittedHosts(caller.scopes, "read");
		if (allowed && allowed.length === 0) return [];
		const jobs = this.#store.listJobs(filter);
		return jobs.filter(j => !allowed || allowed.includes(j.host));
	}

	getJob(caller: Caller, jobId: string): Job {
		return this.#requireJob(caller, jobId, "read");
	}

	feed(
		caller: Caller,
		cursor: number,
		limit: number,
	): {
		events: Array<{ id: number; jobId: string; at: number; type: string; detail?: Record<string, unknown> }>;
		next: number;
		attention: Job[];
	} {
		const allowed = permittedHosts(caller.scopes, "read");
		const { events, next } = this.#store.eventsSince(cursor, Math.min(limit, this.#config.limits.feedWindow));
		const visible = allowed
			? events.filter(e => {
					const job = this.#store.getJob(e.jobId);
					return job ? allowed.includes(job.host) : false;
				})
			: events;
		const attention = this.#store
			.openJobs()
			.filter(j => j.state === "running" || j.state === "cancel_requested")
			.filter(j => !allowed || allowed.includes(j.host));
		return { events: visible, next, attention };
	}

	/** One job's ledger events after a cursor; caller must already see the job. */
	feedForJob(
		caller: Caller,
		jobId: string,
		cursor: number,
	): {
		events: Array<{ id: number; jobId: string; at: number; type: string; detail?: Record<string, unknown> }>;
		next: number;
	} {
		this.#requireJob(caller, jobId, "read");
		const { events, next } = this.#store.eventsSince(cursor, this.#config.limits.feedWindow, jobId);
		return { events, next };
	}

	/* ------------------------------ writes ------------------------------- */

	#resolveWorkspace(
		caller: Caller,
		input: { workspace?: string; target?: { host: string } },
	): { host: string; workspace: string; alias?: WorkspaceAlias } {
		if (input.workspace) {
			if (!ALIAS.test(input.workspace))
				throw new GatewayError("invalid_request", `workspace must be an alias: ${input.workspace}`);
			const alias = this.#config.workspaces.find(w => w.alias === input.workspace);
			if (!alias)
				throw new GatewayError(
					"not_found",
					`Unknown workspace alias: ${input.workspace}. fleet_status lists what is configured.`,
				);
			this.#requireLevel(caller, "operate", alias.host, "work_start");
			if (!alias.allowStart)
				throw new GatewayError("start_disabled", `work_start is disabled for workspace ${alias.alias}.`);
			return { host: alias.host, workspace: alias.workspace, alias };
		}
		if (input.target?.host) {
			const host = this.#config.hosts.find(h => h.id === input.target!.host);
			if (!host) throw new GatewayError("not_found", `Unknown host: ${input.target.host}`);
			this.#requireLevel(caller, "operate", host.id, "work_start");
			if (!host.defaultWorkspace)
				throw new GatewayError(
					"not_found",
					`Host ${host.id} has no defaultWorkspace for work with no named workspace.`,
				);
			const alias = this.#config.workspaces.find(w => w.host === host.id && w.alias === host.defaultWorkspace);
			if (!alias)
				throw new GatewayError("not_found", `Host ${host.id}'s defaultWorkspace names no configured alias.`);
			if (!alias.allowStart)
				throw new GatewayError("start_disabled", `work_start is disabled for workspace ${alias.alias}.`);
			return { host: host.id, workspace: alias.workspace, alias };
		}
		throw new GatewayError("invalid_request", "work_start needs `workspace` (an alias) or `target.host`.");
	}

	startWork(
		caller: Caller,
		input: {
			requestId: string;
			task: string;
			workspace?: string;
			target?: { host: string };
			title?: string;
			model?: string;
			timeoutSeconds?: number;
		},
	): Job {
		if (!input.requestId)
			throw new GatewayError("invalid_request", "work_start needs a requestId for idempotent retries.");
		if (!input.task?.trim()) throw new GatewayError("invalid_request", "work_start needs a task.");
		if (input.task.length > this.#config.limits.taskChars) {
			throw new GatewayError(
				"invalid_request",
				`task is ${input.task.length} chars; the limit is ${this.#config.limits.taskChars}.`,
			);
		}
		const inputHash = requestInputHash({
			task: input.task,
			workspace: input.workspace,
			target: input.target,
			title: input.title,
			model: input.model,
			timeoutSeconds: input.timeoutSeconds,
		});
		const prior = this.#store.lookupRequest(caller.clientId, "work_start", input.requestId);
		if (prior) {
			if (prior.inputHash !== inputHash) {
				throw new GatewayError(
					"request_id_conflict",
					`requestId ${input.requestId} was used for a different work_start. Use a new requestId.`,
				);
			}
			const existing = prior.jobId ? this.#store.getJob(prior.jobId) : undefined;
			if (existing) return existing;
		}
		const { host, workspace, alias } = this.#resolveWorkspace(caller, input);
		const jobCount = this.#store
			.listJobs({ limit: this.#config.limits.jobsPerClient + 1 })
			.filter(j => j.clientId === caller.clientId).length;
		if (jobCount >= this.#config.limits.jobsPerClient) {
			throw new GatewayError("invalid_request", `This client already holds ${jobCount} jobs; release some first.`);
		}
		const id = newJobId();
		const title =
			input.title?.trim() ||
			input.task
				.split("\n")
				.find(l => l.trim())
				?.slice(0, 60) ||
			"job";
		const job: Job = {
			id,
			clientId: caller.clientId,
			state: "queued",
			host,
			workspace,
			workspaceAlias: alias?.alias,
			title,
			task: input.task,
			model: input.model ?? alias?.model,
			timeoutSeconds: input.timeoutSeconds,
			createdAt: Date.now(),
		};
		this.#store.insertJob(job, { workspace: alias?.alias, host, reason: "work_start" });
		this.#store.recordRequest(caller.clientId, "work_start", input.requestId, inputHash, id);
		return this.#store.getJob(id)!;
	}

	async continueWork(caller: Caller, input: { requestId: string; jobId: string; message: string }): Promise<Job> {
		if (!input.requestId)
			throw new GatewayError("invalid_request", "work_continue needs a requestId for idempotent retries.");
		const job = this.#requireJob(caller, input.jobId, "operate");
		const inputHash = requestInputHash({ jobId: input.jobId, message: input.message });
		const prior = this.#store.lookupRequest(caller.clientId, "work_continue", input.requestId);
		if (prior) {
			if (prior.inputHash !== inputHash) {
				throw new GatewayError(
					"request_id_conflict",
					`requestId ${input.requestId} was used for a different work_continue. Use a new requestId.`,
				);
			}
			return job;
		}
		if (job.state !== "idle") {
			throw new GatewayError(
				"job_state_conflict",
				`Job ${job.id} is ${job.state}; only an idle job can be continued.`,
			);
		}
		const updated = await this.#engine.continueJob(job, input.message);
		this.#store.recordRequest(caller.clientId, "work_continue", input.requestId, inputHash, job.id);
		return updated;
	}

	async cancelWork(caller: Caller, input: { jobId: string; reason?: string }): Promise<Job> {
		const job = this.#requireJob(caller, input.jobId, "operate");
		if (["cancelled", "failed", "released"].includes(job.state)) return job;
		return this.#engine.cancel(job, input.reason);
	}

	releaseWork(caller: Caller, input: { jobId: string }): Job {
		const job = this.#requireJob(caller, input.jobId, "operate");
		this.#store.updateJob(
			job.id,
			{ state: "released", finishedAt: Date.now() },
			{
				type: "state_changed",
				detail: { from: job.state, to: "released", reason: "released" },
			},
		);
		return this.#store.getJob(job.id)!;
	}
}
