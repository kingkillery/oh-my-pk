/**
 * The job engine: one loop that reconciles, watches and dispatches per host.
 *
 * Ticks never overlap. Every host with open jobs gets, in order:
 *   1. reconciliation — dispatching/unknown jobs probed for their marker,
 *   2. watching — get_task on every live job, mapping host states onto job
 *      states and appending feed events on change,
 *   3. dispatch — queued launches while the host has a free slot.
 *
 * The engine never touches HTTP, config files or MCP: hosts come in as
 * {@link HostClient}s, so tests drive the whole lifecycle with fakes.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Store } from "../db/store";
import { HostToolError, HostTransportError } from "../errors";
import { type GatewayConfig, type HostClient, type Job, SLOT_STATES } from "../types";

export interface EngineHost {
	id: string;
	maxConcurrentJobs: number;
	defaultWorkspace?: string;
	client: HostClient;
}

const MARKER = /\[job:([0-9a-z]{10})\]/i;
const SETTLED_HOST_STATES = new Set(["completed", "failed", "cancelled", "timed_out"]);

export function newJobId(): string {
	// 10 lowercase Crockford base32 chars — safe in titles, searches and ids.
	const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
	const bytes = randomBytes(10);
	let id = "";
	for (const b of bytes) id += alphabet[b & 31];
	return id;
}

export function jobTitle(input: { title?: string; task: string; jobId: string }): string {
	const raw = (input.title ?? input.task.split("\n").find(l => l.trim()) ?? "job").replace(MARKER, "").trim();
	const base = raw.length > 60 ? `${raw.slice(0, 59)}…` : raw;
	return `${base} [job:${input.jobId}]`;
}

export function launchMessage(job: { id: string; task: string; workspace: string }): string {
	return `${job.task}\n\n—\nLaunched through ompk-fleet-gateway as job ${job.id} in workspace ${job.workspace}. Reply in this session; follow-ups continue the same conversation.`;
}

export interface TickHooks {
	now?: () => number;
	log?: (event: string, detail: Record<string, unknown>) => void;
}

export class JobEngine {
	#store: Store;
	#config: GatewayConfig;
	#hosts: Map<string, EngineHost>;
	#clients: Map<string, HostClient>;
	#backoffUntil = new Map<string, number>();
	#ticking = false;
	#now: () => number;
	#log: (event: string, detail: Record<string, unknown>) => void;

	constructor(deps: { store: Store; config: GatewayConfig; hosts: EngineHost[] } & TickHooks) {
		this.#store = deps.store;
		this.#config = deps.config;
		this.#hosts = new Map(deps.hosts.map(h => [h.id, h]));
		this.#clients = new Map(deps.hosts.map(h => [h.id, h.client]));
		this.#now = deps.now ?? (() => Date.now());
		this.#log = deps.log ?? (() => {});
	}

	hosts(): EngineHost[] {
		return [...this.#hosts.values()];
	}

	clientFor(hostId: string): HostClient | undefined {
		return this.#clients.get(hostId);
	}

	#hostBackedOff(hostId: string): boolean {
		return (this.#backoffUntil.get(hostId) ?? 0) > this.#now();
	}

	#backOff(hostId: string): void {
		const until = this.#now() + this.#config.watcher.hostBackoffSeconds * 1000;
		this.#backoffUntil.set(hostId, until);
		this.#log("host.backoff", { host: hostId, until });
	}

	hostUnreachableSince(hostId: string): number | undefined {
		const until = this.#backoffUntil.get(hostId);
		return until && until > this.#now() ? until : undefined;
	}

	/* ----------------------------- watching ------------------------------ */

	/** Map one host task state onto the ledger, emitting feed events. */
	async #watch(job: Job, client: HostClient): Promise<void> {
		let task: Awaited<ReturnType<HostClient["getTask"]>>["task"];
		try {
			({ task } = await client.getTask(job.taskId!));
		} catch (error) {
			if (error instanceof HostToolError && error.code === "unknown_task") {
				// The connector keeps tasks in memory: a restart retires them all.
				this.#store.updateJob(
					job.id,
					{
						state: "failed",
						lastError: {
							code: "task_lost",
							message: "The host no longer knows this task (connector restarted or evicted it).",
							at: this.#now(),
						},
						finishedAt: this.#now(),
					},
					{ type: "state_changed", detail: { from: job.state, to: "failed", reason: "task_lost" } },
				);
				return;
			}
			throw error;
		}
		const progressText = task.progress?.lastText ?? task.preview;
		if (SETTLED_HOST_STATES.has(task.state)) {
			if (job.state !== "idle") {
				this.#store.updateJob(
					job.id,
					{
						state: "idle",
						progressText,
						progressAt: this.#now(),
						lastError:
							task.state === "failed" || task.state === "timed_out"
								? {
										code: task.state === "timed_out" ? "task_timed_out" : "task_failed",
										message: task.error ?? `the host task ${task.state}`,
										at: this.#now(),
									}
								: job.lastError,
						finishedAt: this.#now(),
					},
					{ type: "state_changed", detail: { from: job.state, to: "idle", reason: task.state } },
				);
			} else if (progressText && progressText !== job.progressText) {
				this.#store.updateJob(job.id, { progressText, progressAt: this.#now() }, undefined);
			}
			return;
		}
		// Still live on the host.
		if (job.state === "cancel_requested") {
			this.#store.updateJob(job.id, { progressText, progressAt: this.#now() }, undefined);
			return;
		}
		if (job.state !== "running") {
			this.#store.updateJob(
				job.id,
				{
					state: "running",
					progressText,
					progressAt: this.#now(),
				},
				{ type: "state_changed", detail: { from: job.state, to: "running", reason: "watching" } },
			);
		} else if (progressText !== undefined && progressText !== job.progressText) {
			this.#store.updateJob(job.id, { progressText, progressAt: this.#now() }, undefined);
		}
	}

	/* --------------------------- reconciliation --------------------------- */

	/** Find a launched task by its [job:<id>] marker; returns the task id or null. */
	async #findMarker(job: Job, client: HostClient): Promise<string | null> {
		const { tasks } = await client.listTasks();
		const marker = `[job:${job.id}]`;
		const hit = tasks.find(t => t.title.includes(marker));
		return hit ? hit.id : null;
	}

	async #reconcile(job: Job, client: HostClient): Promise<void> {
		const markerHit = job.taskId ? job.taskId : await this.#findMarker(job, client);
		if (markerHit) {
			this.#store.updateJob(
				job.id,
				{ state: "running", taskId: markerHit, dispatchedAt: job.dispatchedAt ?? this.#now() },
				{
					type: "state_changed",
					detail: { from: job.state, to: "running", reason: "reconciled" },
				},
			);
			return;
		}
		const windowMs = this.#config.watcher.pollSeconds * 6_000;
		if (this.#now() - job.createdAt > Math.max(windowMs, 60_000)) {
			this.#store.updateJob(
				job.id,
				{
					state: "failed",
					lastError: {
						code: "launch_not_confirmed",
						message: "The host shows no task carrying this job's marker.",
						at: this.#now(),
					},
					finishedAt: this.#now(),
				},
				{ type: "state_changed", detail: { from: job.state, to: "failed", reason: "launch_not_confirmed" } },
			);
		}
	}

	/* ----------------------------- dispatch ------------------------------ */

	/** Launch one queued job on its host, classifying every outcome. */
	async #dispatch(job: Job, host: EngineHost): Promise<void> {
		this.#store.updateJob(
			job.id,
			{ state: "dispatching", dispatchedAt: this.#now() },
			{
				type: "state_changed",
				detail: { from: "queued", to: "dispatching", reason: "dispatch" },
			},
		);
		const title = job.title.includes(`[job:${job.id}]`) ? job.title : `${job.title} [job:${job.id}]`;
		try {
			const { task } = await host.client.launchTask({
				prompt: launchMessage({ id: job.id, task: job.task, workspace: job.workspace }),
				workspace: job.workspace,
				title,
				model: job.model,
				timeoutSeconds: job.timeoutSeconds,
			});
			this.#store.updateJob(
				job.id,
				{ state: "running", taskId: task.id },
				{
					type: "state_changed",
					detail: { from: "dispatching", to: "running", reason: "launched", taskId: task.id },
				},
			);
		} catch (error) {
			if (error instanceof HostToolError) {
				const code = error.code === "unknown_workspace" ? "not_found" : error.code;
				this.#store.updateJob(
					job.id,
					{
						state: "failed",
						lastError: { code, message: error.message, at: this.#now() },
						finishedAt: this.#now(),
					},
					{
						type: "state_changed",
						detail: { from: "dispatching", to: "failed", reason: "launch_rejected", code: error.code },
					},
				);
				return;
			}
			if (error instanceof HostTransportError) {
				if (error.delivery === "not_delivered") {
					this.#store.updateJob(
						job.id,
						{ state: "queued", dispatchedAt: undefined },
						{
							type: "state_changed",
							detail: { from: "dispatching", to: "queued", reason: "host_unreachable" },
						},
					);
					this.#backOff(job.host);
					return;
				}
				// The launch may have landed: mark unknown, reconcile later.
				this.#store.updateJob(
					job.id,
					{ state: "unknown" },
					{
						type: "state_changed",
						detail: { from: "dispatching", to: "unknown", reason: "launch_uncertain" },
					},
				);
				if (error.delivery === "unknown") this.#backOff(job.host);
				return;
			}
			throw error;
		}
	}

	/** One full pass over every host with open jobs. Never re-entrant. */
	async tick(): Promise<void> {
		if (this.#ticking) return;
		this.#ticking = true;
		try {
			await this.#pass();
		} finally {
			this.#ticking = false;
		}
	}

	/** Ask the engine for a pass soon; callers that mutate jobs use this. */
	requestTick(): void {
		if (this.#ticking) return;
		this.#ticking = true;
		queueMicrotask(() => {
			void this.#pass().finally(() => {
				this.#ticking = false;
			});
		});
	}

	async #pass(): Promise<void> {
		const open = this.#store.openJobs();
		const byHost = new Map<string, Job[]>();
		for (const job of open) {
			const list = byHost.get(job.host) ?? [];
			list.push(job);
			byHost.set(job.host, list);
		}
		await Promise.all([...byHost.entries()].map(([hostId, jobs]) => this.#tickHost(hostId, jobs)));
	}

	async #tickHost(hostId: string, jobs: Job[]): Promise<void> {
		const host = this.#hosts.get(hostId);
		if (!host) return;
		if (this.#hostBackedOff(hostId)) return;

		// 1. Reconcile ambiguous jobs first.
		for (const job of jobs.filter(j => j.state === "dispatching" || j.state === "unknown")) {
			try {
				await this.#reconcile(job, host.client);
			} catch (error) {
				if (error instanceof HostTransportError) this.#backOff(hostId);
				this.#log("reconcile.error", {
					job: job.id,
					host: hostId,
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			}
		}

		// 2. Watch live jobs.
		for (const job of jobs.filter(
			j => j.state === "running" || j.state === "cancel_requested" || j.state === "idle",
		)) {
			if (!job.taskId) continue;
			try {
				await this.#watch(job, host.client);
			} catch (error) {
				if (error instanceof HostTransportError) {
					this.#backOff(hostId);
					return;
				}
				this.#log("watch.error", {
					job: job.id,
					host: hostId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// 3. Dispatch queued jobs while slots are free — re-read the store each
		// pass: a job the watcher just settled frees its slot in the same tick.
		for (const job of jobs.filter(j => j.state === "queued").sort((a, b) => a.createdAt - b.createdAt)) {
			const used = this.#store.countJobsByState(hostId, [...SLOT_STATES]);
			if (used >= host.maxConcurrentJobs) break;
			await this.#dispatch(job, host);
		}
	}

	/* --------------------------- mutating tools --------------------------- */

	/** Cancel a job: local for queued, cancel_task otherwise. */
	async cancel(job: Job, reason?: string): Promise<Job> {
		if (job.state === "queued") {
			this.#store.updateJob(
				job.id,
				{ state: "cancelled", finishedAt: this.#now() },
				{
					type: "state_changed",
					detail: { from: "queued", to: "cancelled", reason: "cancelled_before_launch" },
				},
			);
			return this.#store.getJob(job.id)!;
		}
		if (job.state === "idle") {
			this.#store.updateJob(
				job.id,
				{ state: "cancelled", finishedAt: this.#now() },
				{
					type: "state_changed",
					detail: { from: "idle", to: "cancelled", reason: "cancelled" },
				},
			);
			return this.#store.getJob(job.id)!;
		}
		const host = this.#hosts.get(job.host);
		if (!host || !job.taskId) {
			this.#store.updateJob(
				job.id,
				{ state: "cancelled", finishedAt: this.#now() },
				{
					type: "state_changed",
					detail: { from: job.state, to: "cancelled", reason: "cancelled" },
				},
			);
			return this.#store.getJob(job.id)!;
		}
		this.#store.updateJob(
			job.id,
			{ state: "cancel_requested" },
			{
				type: "state_changed",
				detail: { from: job.state, to: "cancel_requested", reason: "cancel_requested" },
			},
		);
		try {
			const { task } = await host.client.cancelTask(job.taskId, reason);
			if (SETTLED_HOST_STATES.has(task.state)) {
				this.#store.updateJob(
					job.id,
					{ state: "cancelled", finishedAt: this.#now() },
					{
						type: "state_changed",
						detail: { from: "cancel_requested", to: "cancelled", reason: "cancel_confirmed" },
					},
				);
			}
		} catch (error) {
			if (error instanceof HostTransportError) this.#backOff(job.host);
			throw error;
		}
		return this.#store.getJob(job.id)!;
	}

	/** Continue a settled (idle) job: follow_up_task resumes the session. */
	async continueJob(job: Job, message: string): Promise<Job> {
		if (job.state !== "idle" || !job.taskId) {
			return job;
		}
		const host = this.#hosts.get(job.host);
		if (!host) return job;
		try {
			await host.client.followUp(job.taskId, message);
			this.#store.updateJob(
				job.id,
				{ state: "running", finishedAt: undefined },
				{
					type: "state_changed",
					detail: { from: "idle", to: "running", reason: "followup" },
				},
			);
			this.#store.appendEvent(job.id, "followup_sent", { chars: message.length });
		} catch (error) {
			if (error instanceof HostTransportError) this.#backOff(job.host);
			throw error;
		}
		return this.#store.getJob(job.id)!;
	}
}

/** Stable input hash for request-id replay checks. */
export function requestInputHash(input: Record<string, unknown>): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(input)))
		.digest("hex");
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v !== undefined) out[key] = canonical(v);
		}
		return out;
	}
	return value;
}
