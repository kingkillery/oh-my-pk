#!/usr/bin/env bun
/**
 * Relay for the ompk Linear agent.
 *
 * Long-polls the Cloudflare Worker for queued jobs, runs each one through the
 * local `omp` CLI in headless mode (`--print --yolo --model <combo>`), and
 * posts the result back so the Worker can comment on the Linear issue.
 *
 * Concurrency model
 * -----------------
 * Up to MAX_CONCURRENT_JOBS (default 2) jobs execute in parallel. A per-repo
 * mutex serializes jobs that target the same GitHub repository so no two
 * attempts race on the same workspace or mirror cache. Linear-sourced jobs
 * are keyed by issueId and effectively serialize per issue.
 *
 * GitHub workspace isolation
 * --------------------------
 * Each GitHub job gets a private clone in GITHUB_WORKSPACE_ROOT/<job-id>/,
 * deleted on completion. A bare mirror cache under .mirrors/ speeds up clones
 * and is lock-protected per mirror path.
 *
 * Container isolation
 * -------------------
 * When OMPK_RELAY_CONTAINER_IMAGE is set, each job phase runs inside a
 * per-phase podman container. The agent phase uses a Git credential broker
 * (loopback HTTP server, one per job) so the GitHub installation token never
 * enters the container environment or logs. The broker also enforces
 * push-to-ompk/*-branches-only; the pre-push hook reads OMPK_BROKER_URL and
 * validates remote refs before any push is allowed.
 *
 * NOTE: Per-job podman network + CONNECT proxy (egress allow-listing by phase)
 * are tracked in issue #41 as a follow-up. Currently containers run with
 * --network=host; the broker limits token exposure but outbound egress is still
 * unrestricted. The acceptance criterion "agent phase cannot reach arbitrary
 * hosts" requires the follow-up proxy implementation.
 *
 * Just-in-time publish token
 * --------------------------
 * Instead of carrying the lease-time installation token all the way to push
 * time, a relay-shipped git credential helper fetches a fresh token at push
 * time. In bare mode the helper calls the Worker /github-token endpoint
 * directly. In container mode the helper calls the local credential broker,
 * which in turn calls the Worker, so the real token never enters the container.
 *
 * Security invariants
 * -------------------
 * - Children are spawned WITHOUT a shell.
 * - Only allowlisted models are dispatched.
 * - Completions are fenced (attemptId + leaseToken).
 * - The relay bearer token NEVER crosses the child process boundary; only
 *   the unguessable fence triple is exposed to the untrusted runner env.
 * - In container mode: GH_TOKEN never enters the container env or job output;
 *   git credentials are brokered via a per-job loopback service.
 * - Bare (non-container) mode keeps the current GH_TOKEN behaviour and is
 *   documented as unfenced with respect to network egress.
 *
 * Usage:
 *   WORKER_URL=https://ompk-linear-agent.pkkidking.workers.dev \
 *   RELAY_TOKEN=<the RELAY_TOKEN secret> \
 *   OMPK_RELAY_MODELS=qwen3.5plus,minimax-m3 \
 *   bun relay.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_URL = process.env.WORKER_URL ?? "https://ompk-linear-agent.pkkidking.workers.dev";
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const RELAY_NAME = process.env.RELAY_NAME ?? hostname();
const WORKSPACE_DIR = process.env.OMPK_RELAY_WORKSPACE ?? process.cwd();
const GITHUB_WORKSPACE_ROOT =
	process.env.OMPK_RELAY_GITHUB_ROOT ?? join(WORKSPACE_DIR, "github-workspaces");
const POLL_INTERVAL_MS = Number(process.env.OMPK_RELAY_POLL_MS ?? 5000);
/**
 * Per-job execution timeout. With JIT token refresh enabled (credential
 * helper + /github-token), this can safely be raised to 45–50 min without
 * risking push failures due to expired installation tokens.
 */
const JOB_TIMEOUT_MS = Number(process.env.OMPK_RELAY_JOB_TIMEOUT_MS ?? 30 * 60 * 1000);
/**
 * Executable dispatched for each job. Resolved from PATH by execvp without
 * any shell; override with an absolute path when `omp` is installed behind a
 * .cmd shim that direct spawn cannot resolve.
 */
const OMP_BIN = process.env.OMPK_RELAY_OMP_BIN ?? "omp";
/**
 * Maximum concurrent jobs. Two slots, never the same repo simultaneously.
 * Raise only when the host has matching CPU/memory headroom.
 */
const MAX_CONCURRENT_JOBS = Number(process.env.OMPK_RELAY_MAX_JOBS ?? 2);

// ─── Container configuration ──────────────────────────────────────────────────

/**
 * When set, the agent and setup phases each run inside a per-phase podman
 * container of this image. Absent → bare mode (unfenced egress).
 */
const CONTAINER_IMAGE = process.env.OMPK_RELAY_CONTAINER_IMAGE?.trim();
const CONTAINER_BIN = process.env.OMPK_RELAY_CONTAINER_BIN ?? "podman";
const CONTAINER_MEMORY = process.env.OMPK_RELAY_CONTAINER_MEMORY ?? "4g";
const CONTAINER_PIDS_LIMIT = 2048;
/** Timeout for the repo-declared .ompk/setup.sh phase. */
const SETUP_TIMEOUT_MS = Number(process.env.OMPK_RELAY_SETUP_TIMEOUT_MS ?? 10 * 60 * 1000);
const CONTAINER_HOME = "/tmp/ompk-home";
const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** Path inside the container where the host git-hooks directory is bind-mounted. */
const CONTAINER_GIT_HOOKS_DIR = "/opt/ompk/git-hooks";

export interface Job {
	id: string;
	/** Origin system: "linear" (default) or "github" PR/issue. */
	source?: "linear" | "github";
	issueId: string;
	issueIdentifier: string;
	model: string;
	prompt: string;
	status: string;
	createdAt: string;
	attemptId: string;
	leaseToken: string;
	/** GitHub repository context for GitHub-sourced jobs. */
	github?: {
		owner: string;
		repo: string;
		number: number;
		headRef?: string;
		defaultBranch: string;
		/** GitHub App installation ID — avoids an API round-trip at JIT-token time. */
		installationId: number;
	};
	/** Ephemeral installation token returned only in the poll response. */
	githubToken?: string;
	/** Heartbeat cadence the Worker expects; two missed beats park the job. */
	heartbeatMs?: number;
}

export interface JobRunResult {
	success: boolean;
	output: string;
	error?: string;
	/**
	 * Retry taxonomy: `transient` failures (timeout, spawn error, model not
	 * runnable on THIS relay) may be requeued with backoff by the queue;
	 * `permanent` (non-zero omp exit — deterministic by default) is terminal.
	 * Successes carry no class.
	 */
	failureClass?: "transient" | "permanent";
}

/** Parse the operator's model allowlist; empty/missing means "allow nothing". */
export function parseAllowedModels(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map(entry => entry.trim())
		.filter(entry => entry.length > 0);
}

/**
 * Argv for one job. The `--` separator makes the prompt a positional even if
 * it begins with `-`; nothing here is ever interpreted by a shell.
 */
export function buildOmpArgs(model: string, prompt: string): string[] {
	return ["--print", "--yolo", "--model", model, "--", prompt];
}

export type SpawnFn = (
	command: string,
	args: readonly string[],
	options: { cwd: string; shell?: false; env?: NodeJS.ProcessEnv; detached?: boolean },
) => ChildProcess;

export interface RunHooks {
	onSpawn?: (child: ChildProcess) => void;
	/** Full child environment (replaces, not merges; spread process.env in). */
	env?: NodeJS.ProcessEnv;
	/** Working directory override. Defaults to WORKSPACE_DIR. */
	cwd?: string;
	/** Command override — used to replace OMP_BIN with the container runtime. */
	command?: string;
	/** Argv override — used to replace buildOmpArgs output with container args. */
	args?: readonly string[];
	/** Non-zero exit failure class. Container runtime exits are transient. */
	nonZeroFailureClass?: "transient" | "permanent";
	/** Async cleanup called on timeout before resolving; replaces the default kill(). */
	onTimeout?: () => Promise<void>;
	/** Detach the child into its own process group (for clean SIGKILL of trees). */
	detached?: boolean;
}

/** Runs the job's prompt through `omp` headlessly — argv only, no shell. */
export function runOmp(
	model: string,
	prompt: string,
	spawnImpl: SpawnFn = spawn,
	timeoutMs: number = JOB_TIMEOUT_MS,
	hooks: RunHooks = {},
): Promise<JobRunResult> {
	const { promise, resolve } = Promise.withResolvers<JobRunResult>();
	const child = spawnImpl(hooks.command ?? OMP_BIN, hooks.args ?? buildOmpArgs(model, prompt), {
		cwd: hooks.cwd ?? WORKSPACE_DIR,
		...(hooks.env ? { env: hooks.env } : {}),
		...(hooks.detached !== undefined ? { detached: hooks.detached } : {}),
	});
	hooks.onSpawn?.(child);

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	const timeoutResult = (): JobRunResult => ({
		success: false,
		output: stdout,
		error: `timed out after ${timeoutMs}ms`,
		failureClass: "transient",
	});
	const timer = setTimeout(() => {
		timedOut = true;
		if (hooks.onTimeout) {
			void hooks
				.onTimeout()
				.catch(() => undefined)
				.then(() => resolve(timeoutResult()));
			return;
		}
		child.kill();
		resolve(timeoutResult());
	}, timeoutMs);

	child.stdout?.on("data", (d: Buffer) => {
		stdout += d.toString();
	});
	child.stderr?.on("data", (d: Buffer) => {
		stderr += d.toString();
	});
	child.on("error", (err: Error) => {
		clearTimeout(timer);
		if (timedOut && hooks.onTimeout) return;
		resolve({ success: false, output: stdout, error: err.message, failureClass: "transient" });
	});
	child.on("close", (code: number | null) => {
		clearTimeout(timer);
		if (timedOut && hooks.onTimeout) return;
		if (code === 0) {
			resolve({ success: true, output: stdout });
			return;
		}
		// A clean non-zero exit is deterministic until proven otherwise:
		// retrying a failing contract burns tokens without new information.
		resolve({
			success: false,
			output: stdout,
			error: stderr || `exit code ${code}`,
			failureClass: hooks.nonZeroFailureClass ?? "permanent",
		});
	});
	return promise;
}

/**
 * Execute one job: allowlist gate first, then a shell-free spawn. A rejected
 * model never spawns a process and reports a non-sensitive failure.
 */
export async function executeJob(
	job: Pick<Job, "model" | "prompt">,
	allowedModels: readonly string[],
	spawnImpl: SpawnFn = spawn,
	timeoutMs: number = JOB_TIMEOUT_MS,
	hooks: RunHooks = {},
): Promise<JobRunResult> {
	if (!allowedModels.includes(job.model)) {
		// Capacity/config mismatch, not a property of the work: another
		// relay (or this one, reconfigured) may run it after backoff.
		return {
			success: false,
			output: "",
			error: "model is not on this relay's allowlist (OMPK_RELAY_MODELS)",
			failureClass: "transient",
		};
	}
	return runOmp(job.model, job.prompt, spawnImpl, timeoutMs, hooks);
}

// ─── Network helpers ──────────────────────────────────────────────────────────

function authHeaders(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

async function pollJob(token: string): Promise<Job | null> {
	const res = await fetch(`${WORKER_URL}/poll?relay=${encodeURIComponent(RELAY_NAME)}`, {
		headers: authHeaders(token),
	});
	if (res.status === 204) return null;
	if (!res.ok) throw new Error(`poll failed: ${res.status} ${await res.text()}`);
	return (await res.json()) as Job;
}

async function submitResult(token: string, job: Job, result: JobRunResult): Promise<void> {
	const res = await fetch(`${WORKER_URL}/result`, {
		method: "POST",
		headers: { ...authHeaders(token), "Content-Type": "application/json" },
		body: JSON.stringify({
			jobId: job.id,
			attemptId: job.attemptId,
			leaseToken: job.leaseToken,
			...result,
		}),
	});
	if (!res.ok) throw new Error(`result submit failed: ${res.status} ${await res.text()}`);
}

const HEARTBEAT_FALLBACK_MS = 10 * 60_000;

/**
 * Fenced heartbeat. Returns false when the Worker rejects the fence (409):
 * the lease was reassigned or resolved, so this attempt must stop burning
 * tokens — the caller kills the child and skips the result submit.
 */
async function sendHeartbeat(token: string, job: Job): Promise<boolean> {
	const res = await fetch(`${WORKER_URL}/heartbeat`, {
		method: "POST",
		headers: { ...authHeaders(token), "Content-Type": "application/json" },
		body: JSON.stringify({ jobId: job.id, attemptId: job.attemptId, leaseToken: job.leaseToken }),
	});
	if (res.status === 409) return false;
	if (!res.ok) {
		// Network or Worker hiccup: keep running; the next beat may recover
		// and a reconcile-parked job is restored by any later fenced beat.
		console.error(`[${new Date().toISOString()}] heartbeat for ${job.id} failed: ${res.status}`);
	}
	return true;
}

/**
 * Startup attestation: this relay has no live children, so every job it
 * left parked in reconcile can be requeued (or dead-lettered on budget
 * exhaustion). Tolerates older Workers without the endpoint.
 */
async function announceStartup(token: string): Promise<void> {
	try {
		const res = await fetch(`${WORKER_URL}/reconcile`, {
			method: "POST",
			headers: { ...authHeaders(token), "Content-Type": "application/json" },
			body: JSON.stringify({ runner: RELAY_NAME, startupSweep: true }),
		});
		if (!res.ok) {
			console.error(`startup reconcile sweep skipped: ${res.status} ${await res.text()}`);
			return;
		}
		const summary = (await res.json()) as {
			resolved?: number;
			requeued?: number;
			deadLettered?: number;
		};
		if (summary.resolved) {
			console.log(
				`startup reconcile sweep: ${summary.resolved} job(s) resolved (${summary.requeued ?? 0} requeued, ${summary.deadLettered ?? 0} dead-lettered)`,
			);
		}
	} catch (err) {
		console.error("startup reconcile sweep failed:", err instanceof Error ? err.message : err);
	}
}

// ─── Git hooks and credential helper paths ────────────────────────────────────

/** Hooks directory shipped next to the relay; contains the pre-push fence guard and credential helper. */
const GIT_HOOKS_DIR = fileURLToPath(new URL("git-hooks/", import.meta.url)).replace(/[\\/]+$/, "");

/**
 * Relay-shipped git credential helper. Called by git when it needs credentials
 * for github.com; in bare mode it fetches a JIT token from the Worker, in
 * container mode it calls the local credential broker instead.
 */
const CREDENTIAL_HELPER = join(GIT_HOOKS_DIR, "ompk-git-credential");

// ─── Mutex primitives ─────────────────────────────────────────────────────────

/**
 * Map keyed by resource identifier to the Promise that resolves when the
 * resource is free. Each key tracks the last registered waiter; callers
 * form an implicit chain without a queue data structure.
 */
export type MutexMap = Map<string, Promise<void>>;

/**
 * Serialize access to a named resource. Concurrent callers with the same key
 * wait in FIFO order; a throwing `fn` does not block later callers (the lock
 * is released in `finally`).
 *
 * @param map  Shared map that tracks in-flight operations per key.
 * @param key  Resource identifier (e.g. "owner/repo" or an absolute path).
 * @param fn   Work to perform while holding the lock.
 */
export function withLock<T>(map: MutexMap, key: string, fn: () => Promise<T>): Promise<T> {
	const prior = map.get(key) ?? Promise.resolve();
	let unlock!: () => void;
	const gate = new Promise<void>(r => {
		unlock = r;
	});
	map.set(key, gate);
	return (async () => {
		await prior;
		try {
			return await fn();
		} finally {
			// Only the last registered caller owns the map slot; earlier callers
			// have already been superseded and must not delete a later entry.
			if (map.get(key) === gate) map.delete(key);
			unlock();
		}
	})();
}

/**
 * Per-repo mutex: serializes jobs targeting the same GitHub repository so
 * their workspaces and mirror cache never overlap.
 */
const repoLocks: MutexMap = new Map();

/**
 * Per-mirror-path mutex: serializes mirror fetch/update operations for the
 * same bare clone. Belt-and-suspenders: the per-repo mutex already prevents
 * same-repo jobs from overlapping, but the explicit per-mirror lock makes the
 * invariant visible at the call site and guards against future refactors.
 */
const mirrorLocks: MutexMap = new Map();

// ─── Container support ────────────────────────────────────────────────────────

/**
 * Env keys from the fence environment that are forwarded into the agent
 * container. GH_TOKEN is intentionally absent: the credential broker serves
 * github.com credentials so the real token never enters the container env.
 */
const CONTAINER_AGENT_ENV_KEYS = [
	"OMPK_FENCE_URL",
	"OMPK_FENCE_JOB",
	"OMPK_FENCE_ATTEMPT",
	"OMPK_FENCE_TOKEN",
	"GIT_CONFIG_KEY_0",   // always "core.hooksPath"
	"GIT_CONFIG_VALUE_0", // host path — overridden to CONTAINER_GIT_HOOKS_DIR below
] as const;

/**
 * Host env keys forwarded into the setup-hook container. These are system
 * basics only; no tokens or relay secrets cross this boundary.
 */
const SETUP_ENV_KEYS = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"SHELL",
	"USER",
	"USERNAME",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
] as const;

export interface ContainerRunOptions {
	image: string;
	memory?: string;
	pidsLimit?: number;
	path?: string;
	home?: string;
	gitHooksDir?: string;
	name?: string;
}

function appendContainerEnv(args: string[], env: NodeJS.ProcessEnv): void {
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) args.push("--env", `${key}=${value}`);
	}
}

function buildContainerBaseArgs(
	workspace: string,
	env: NodeJS.ProcessEnv,
	options: ContainerRunOptions,
	mountGitHooks: boolean,
): string[] {
	const home = options.home ?? CONTAINER_HOME;
	const args = [
		"run",
		"--rm",
		"--volume",
		`${workspace}:/workspace:Z`,
		"--workdir",
		"/workspace",
		"--tmpfs",
		`${home}:rw,mode=700`,
		// TODO(#41 follow-up): Replace --network=host with a per-job podman
		// network routed through the CONNECT proxy so the agent phase can only
		// reach the Anthropic API and the local credential broker.
		"--network=host",
		"--http-proxy=false",
		"--memory",
		options.memory ?? CONTAINER_MEMORY,
		"--pids-limit",
		String(options.pidsLimit ?? CONTAINER_PIDS_LIMIT),
	];
	if (options.name) args.push("--name", options.name);
	if (mountGitHooks) {
		args.push("--volume", `${options.gitHooksDir ?? GIT_HOOKS_DIR}:${CONTAINER_GIT_HOOKS_DIR}:ro,z`);
	}
	appendContainerEnv(args, env);
	args.push(options.image);
	return args;
}

export function deriveContainerName(jobId: string, attemptId: string, phase: "setup" | "agent"): string {
	const safe = `${jobId}-${attemptId}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
	return `ompk-${safe}-${phase}`;
}

/**
 * Build a podman-compatible container argv for the untrusted agent phase.
 *
 * Security: GH_TOKEN is never placed in the container env. When a broker URL
 * is provided, the container's git credential helper is pointed at the local
 * broker instead, which issues JIT tokens without the container ever seeing
 * the underlying installation token.
 */
export function buildContainerArgs(
	job: Pick<Job, "model" | "prompt" | "source">,
	workspace: string,
	env: NodeJS.ProcessEnv,
	options: ContainerRunOptions,
	brokerUrl?: string,
): string[] {
	const containerEnv: NodeJS.ProcessEnv = {
		PATH: options.path ?? CONTAINER_PATH,
		HOME: options.home ?? CONTAINER_HOME,
	};

	// Copy fence vars and the core.hooksPath git config key from the host env.
	for (const key of CONTAINER_AGENT_ENV_KEYS) {
		const value = env[key];
		if (value !== undefined) containerEnv[key] = value;
	}

	// core.hooksPath must point to the container-internal hooks directory, not
	// the host path that fenceEnv() emits.
	if (containerEnv.GIT_CONFIG_VALUE_0 !== undefined) {
		containerEnv.GIT_CONFIG_VALUE_0 = CONTAINER_GIT_HOOKS_DIR;
	}

	if (job.source === "github" && brokerUrl) {
		// Broker mode: the credential helper inside the container calls the
		// local broker instead of the Worker directly. The real token stays on
		// the host. GH_TOKEN is never set in the container env.
		containerEnv.OMPK_BROKER_URL = brokerUrl;
		containerEnv.GIT_CONFIG_COUNT = "2";
		containerEnv.GIT_CONFIG_KEY_1 = "credential.helper";
		containerEnv.GIT_CONFIG_VALUE_1 = `${CONTAINER_GIT_HOOKS_DIR}/ompk-git-credential`;
	} else {
		containerEnv.GIT_CONFIG_COUNT = "1";
	}

	return [
		...buildContainerBaseArgs(workspace, containerEnv, options, true),
		"omp",
		...buildOmpArgs(job.model, job.prompt),
	];
}

/** Environment for the repo-declared setup hook: system basics, never tokens. */
export function buildSetupHookEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of SETUP_ENV_KEYS) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function buildContainerSetupArgs(
	workspace: string,
	env: NodeJS.ProcessEnv,
	options: ContainerRunOptions,
): string[] {
	const containerEnv: NodeJS.ProcessEnv = {
		...env,
		PATH: options.path ?? CONTAINER_PATH,
		HOME: options.home ?? CONTAINER_HOME,
	};
	// Setup hooks run without git-hooks (no fence guard needed; no pushes).
	return [...buildContainerBaseArgs(workspace, containerEnv, options, false), "bash", ".ompk/setup.sh"];
}

export type HookExistsFn = (path: string) => Promise<boolean>;

export interface SetupHookRunOptions {
	spawn?: SpawnFn;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	hookExists?: HookExistsFn;
	onSpawn?: (child: ChildProcess) => void;
	command?: string;
	args?: readonly string[];
	redactionToken?: string;
	nonZeroFailureClass?: "transient" | "permanent";
	onTimeout?: () => Promise<void>;
}

const SETUP_OUTPUT_LIMIT = 4096;

function setupFailureOutput(captured: string, wasTruncated: boolean): string {
	return wasTruncated ? `${captured}\n...[truncated]` : captured;
}

function forceKillChildTree(child: ChildProcess): void {
	if (process.platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// Fall through when the child exited before its process group was set.
		}
	}
	child.kill("SIGKILL");
}

/**
 * Run a repo-declared setup hook when present. Success or missing hook
 * returns undefined; failures return a ready-to-submit job result.
 */
export async function runSetupHook(
	workspace: string,
	options: SetupHookRunOptions = {},
): Promise<JobRunResult | undefined> {
	const hookPath = join(workspace, ".ompk", "setup.sh");
	const hookExists = options.hookExists ?? (path => Bun.file(path).exists());
	if (!(await hookExists(hookPath))) return undefined;

	const spawnImpl = options.spawn ?? spawn;
	const timeoutMs = options.timeoutMs ?? SETUP_TIMEOUT_MS;
	const command = options.command ?? "bash";
	const args = options.args ?? [".ompk/setup.sh"];

	let child: ChildProcess;
	try {
		child = spawnImpl(command, args, {
			cwd: workspace,
			env: options.env ?? buildSetupHookEnv(),
			detached: process.platform !== "win32",
		});
	} catch (err) {
		return {
			success: false,
			output: "",
			error: `setup hook .ompk/setup.sh failed to start: ${err instanceof Error ? err.message : String(err)}`,
			failureClass: "transient",
		};
	}
	options.onSpawn?.(child);

	const { promise, resolve } = Promise.withResolvers<JobRunResult | undefined>();
	let captured = "";
	let pending = "";
	let outputTruncated = false;
	let timedOut = false;

	const appendCaptured = (text: string): void => {
		const remaining = SETUP_OUTPUT_LIMIT - captured.length;
		if (remaining <= 0) {
			if (text.length > 0) outputTruncated = true;
			return;
		}
		captured += text.slice(0, remaining);
		if (text.length > remaining) outputTruncated = true;
	};
	const capture = (data: unknown): void => {
		pending += String(data);
		const secret = options.redactionToken;
		if (!secret) {
			appendCaptured(pending);
			pending = "";
			return;
		}
		for (;;) {
			const secretIndex = pending.indexOf(secret);
			if (secretIndex >= 0) {
				appendCaptured(pending.slice(0, secretIndex));
				appendCaptured("[redacted]");
				pending = pending.slice(secretIndex + secret.length);
				continue;
			}
			const safeLength = Math.max(0, pending.length - (secret.length - 1));
			appendCaptured(pending.slice(0, safeLength));
			pending = pending.slice(safeLength);
			return;
		}
	};
	const flushPending = (): void => {
		const secret = options.redactionToken;
		if (secret && pending.length > 0) {
			let prefixLength = Math.min(secret.length - 1, pending.length);
			while (prefixLength > 0 && !secret.startsWith(pending.slice(-prefixLength))) prefixLength -= 1;
			appendCaptured(pending.slice(0, pending.length - prefixLength));
			if (prefixLength > 0) appendCaptured("[redacted]");
		} else {
			appendCaptured(pending);
		}
		pending = "";
	};
	const failureOutput = (): string => {
		flushPending();
		return setupFailureOutput(captured, outputTruncated);
	};
	const timeoutResult = (): JobRunResult => ({
		success: false,
		output: failureOutput(),
		error: `setup hook .ompk/setup.sh timed out after ${timeoutMs}ms`,
		failureClass: "transient",
	});

	const timer = setTimeout(() => {
		timedOut = true;
		if (options.onTimeout) {
			void options
				.onTimeout()
				.catch(() => undefined)
				.then(() => resolve(timeoutResult()));
			return;
		}
		forceKillChildTree(child);
	}, timeoutMs);

	child.stdout?.on("data", capture);
	child.stderr?.on("data", capture);
	child.on("error", (err: Error) => {
		clearTimeout(timer);
		if (timedOut) {
			if (!options.onTimeout) resolve(timeoutResult());
			return;
		}
		resolve({
			success: false,
			output: failureOutput(),
			error: `setup hook .ompk/setup.sh failed to start: ${err.message}`,
			failureClass: "transient",
		});
	});
	child.on("close", (code: number | null) => {
		clearTimeout(timer);
		if (timedOut) {
			if (!options.onTimeout) resolve(timeoutResult());
			return;
		}
		if (code === 0) {
			resolve(undefined);
			return;
		}
		resolve({
			success: false,
			output: failureOutput(),
			error: `setup hook .ompk/setup.sh failed with exit code ${code}`,
			failureClass: options.nonZeroFailureClass ?? "permanent",
		});
	});
	return promise;
}

async function forceRemoveContainer(name: string): Promise<void> {
	const subprocess = Bun.spawn([CONTAINER_BIN, "rm", "--force", name], {
		env: process.env,
		stdout: "ignore",
		stderr: "pipe",
	});
	const exitCode = await subprocess.exited;
	if (exitCode !== 0) {
		const errorText = subprocess.stderr ? await new Response(subprocess.stderr).text() : "";
		throw new Error(`container cleanup failed: ${errorText.trim() || `exit code ${exitCode}`}`);
	}
}

async function stopNamedContainer(name: string, runtimeChild: ChildProcess | undefined): Promise<void> {
	if (runtimeChild) forceKillChildTree(runtimeChild);
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await forceRemoveContainer(name);
			return;
		} catch (err) {
			lastError = err;
			if (attempt === 0) await Bun.sleep(100);
		}
	}
	throw lastError instanceof Error ? lastError : new Error("container cleanup failed");
}

// ─── Git credential broker ────────────────────────────────────────────────────

/**
 * Handle returned by startGitBroker. The url is a loopback address reachable
 * from containers running with --network=host.
 */
export interface GitBrokerHandle {
	/** http://127.0.0.1:<port> — set as OMPK_BROKER_URL in the container env. */
	url: string;
	/** Shut down the broker server. Call in the job's finally block. */
	stop: () => Promise<void>;
}

/** Options for startGitBroker. fetchImpl is injected by tests. */
export interface GitBrokerOptions {
	jobId: string;
	attemptId: string;
	leaseToken: string;
	/** Worker /github-token endpoint for JIT token issuance. */
	workerTokenUrl: string;
	/** Fetch implementation override; defaults to the global fetch. */
	fetchImpl?: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Start a per-job Git credential broker on a random loopback port.
 *
 * The broker holds the fence triple (never the installation token directly)
 * and fetches a JIT token from the Worker on demand. This decouples the
 * container from the real token: git inside the container calls the broker's
 * /credential endpoint via the ompk-git-credential helper, and the broker
 * returns fresh credentials without the token ever entering the container env.
 *
 * The broker additionally enforces branch naming via POST /push-check: the
 * pre-push hook sends the target refs and the broker rejects anything outside
 * the refs/heads/ompk/* namespace.
 *
 * Lifecycle: start before the agent container, stop in the job's finally block.
 */
export async function startGitBroker(options: GitBrokerOptions): Promise<GitBrokerHandle> {
	const { jobId, attemptId, leaseToken, workerTokenUrl, fetchImpl = fetch } = options;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0, // OS picks a free port; available as server.port immediately.
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);

			// GET /credential?host=<host>
			// Called by the ompk-git-credential helper inside the container.
			if (req.method === "GET" && url.pathname === "/credential") {
				const host = url.searchParams.get("host") ?? "";
				if (host !== "github.com") {
					// Refuse credentials for any host other than github.com.
					// This is defence-in-depth: the CONNECT proxy (follow-up) will
					// provide network-level enforcement; the broker enforces at the
					// credential-issuance layer.
					return new Response(
						`refused: credential broker only serves github.com (got: ${host})\n`,
						{ status: 403 },
					);
				}
				// Fetch a JIT token from the Worker using the fence triple.
				let jitRes: Response;
				try {
					jitRes = await fetchImpl(workerTokenUrl, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ jobId, attemptId, leaseToken }),
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return new Response(`JIT token fetch error: ${msg}\n`, { status: 502 });
				}
				if (!jitRes.ok) {
					const body = await jitRes.text().catch(() => "");
					return new Response(`JIT token fetch failed: ${jitRes.status} ${body}\n`, { status: 502 });
				}
				// Parse the token from the Worker response without using `any`.
				const rawData: unknown = await jitRes.json().catch(() => null);
				if (
					rawData === null ||
					typeof rawData !== "object" ||
					!("token" in rawData) ||
					typeof (rawData as Record<string, unknown>)["token"] !== "string" ||
					(rawData as Record<string, unknown>)["token"] === ""
				) {
					return new Response("JIT token response has invalid or missing token\n", { status: 502 });
				}
				const jitToken = (rawData as Record<string, unknown>)["token"] as string;
				return new Response(`username=x-access-token\npassword=${jitToken}\n`);
			}

			// POST /push-check
			// Called by the pre-push hook inside the container before any push.
			// Body: { refs: string[] } — the remote refs being pushed to.
			if (req.method === "POST" && url.pathname === "/push-check") {
				const rawBody: unknown = await req.json().catch(() => null);
				const refs: string[] = [];
				if (
					rawBody !== null &&
					typeof rawBody === "object" &&
					"refs" in rawBody &&
					Array.isArray((rawBody as Record<string, unknown>)["refs"])
				) {
					const rawRefs = (rawBody as Record<string, unknown[]>)["refs"];
					for (const r of rawRefs) {
						if (typeof r === "string") refs.push(r);
					}
				}
				const rejected = refs.filter(ref => !/^refs\/heads\/ompk\//.test(ref));
				if (rejected.length > 0) {
					return new Response(
						`push rejected: the following refs are outside the ompk/* namespace: ${rejected.join(", ")}\n`,
						{ status: 403 },
					);
				}
				return new Response("ok\n");
			}

			return new Response("not found\n", { status: 404 });
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		stop: async () => {
			server.stop();
		},
	};
}

// ─── GitHub workspace and mirror helpers ──────────────────────────────────────

export type RunGitFn = (
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	redactionToken?: string,
) => Promise<void>;

export interface MirrorDependencies {
	runGit?: RunGitFn;
	mirrorExists?: (path: string) => Promise<boolean>;
	makeDir?: (path: string) => Promise<void>;
	warn?: (message: string) => void;
}

/** Stable, filesystem-safe bare mirror location for one GitHub repository. */
export function deriveMirrorPath(root: string, owner: string, repo: string): string {
	const name = `${owner}-${repo}.git`.replace(/[^A-Za-z0-9._-]/g, "_");
	return join(root, ".mirrors", name);
}

/**
 * Refresh/create a bare mirror, degrading to a full clone when any cache
 * operation fails. A mirror is only an optimization, never a job dependency.
 * Callers must hold the per-mirror lock before calling.
 */
export async function tryPrepareRepoMirror(
	mirror: string,
	cloneUrl: string,
	env: NodeJS.ProcessEnv,
	redactionToken: string | undefined,
	dependencies: MirrorDependencies = {},
): Promise<string | undefined> {
	const runGitImpl = dependencies.runGit ?? runGit;
	const mirrorExists = dependencies.mirrorExists ?? (path => Bun.file(join(path, "HEAD")).exists());
	const makeDir =
		dependencies.makeDir ??
		(async path => {
			await mkdir(path, { recursive: true });
		});
	const warn = dependencies.warn ?? (message => console.error(message));
	try {
		await makeDir(dirname(mirror));
		if (await mirrorExists(mirror)) {
			await runGitImpl(["remote", "update", "--prune"], mirror, env, redactionToken);
		} else {
			await runGitImpl(["clone", "--mirror", cloneUrl, mirror], dirname(mirror), env, redactionToken);
		}
		return mirror;
	} catch (err) {
		const rawMessage = err instanceof Error ? err.message : String(err);
		const message = redactionToken ? rawMessage.replaceAll(redactionToken, "[redacted]") : rawMessage;
		warn(`[${new Date().toISOString()}] GitHub mirror cache unavailable; using full clone: ${message}`);
		return undefined;
	}
}

/** Workspace clones detach from the mirror so later pruning cannot break them. */
export function buildWorkspaceCloneArgs(
	cloneUrl: string,
	workspace: string,
	mirror: string | undefined,
): string[] {
	return [
		"clone",
		"--origin",
		"origin",
		...(mirror ? ["--reference-if-able", mirror, "--dissociate"] : []),
		cloneUrl,
		workspace,
	];
}

export interface CloneFallbackDependencies {
	runGit?: RunGitFn;
	removeWorkspace?: (path: string) => Promise<void>;
	warn?: (message: string) => void;
}

/** Retry without the cache when a referenced clone exposes mirror damage. */
export async function cloneWorkspaceWithMirrorFallback(
	cloneUrl: string,
	workspace: string,
	mirror: string | undefined,
	cwd: string,
	env: NodeJS.ProcessEnv,
	redactionToken: string | undefined,
	dependencies: CloneFallbackDependencies = {},
): Promise<void> {
	const runGitImpl = dependencies.runGit ?? runGit;
	const removeWorkspace =
		dependencies.removeWorkspace ??
		(async path => {
			await rm(path, { recursive: true, force: true });
		});
	const warn = dependencies.warn ?? (message => console.error(message));
	if (!mirror) {
		await runGitImpl(buildWorkspaceCloneArgs(cloneUrl, workspace, undefined), cwd, env, redactionToken);
		return;
	}
	try {
		await runGitImpl(buildWorkspaceCloneArgs(cloneUrl, workspace, mirror), cwd, env, redactionToken);
	} catch (err) {
		const rawMessage = err instanceof Error ? err.message : String(err);
		const message = redactionToken ? rawMessage.replaceAll(redactionToken, "[redacted]") : rawMessage;
		warn(`[${new Date().toISOString()}] GitHub reference clone failed; retrying full clone: ${message}`);
		await removeWorkspace(workspace);
		await runGitImpl(buildWorkspaceCloneArgs(cloneUrl, workspace, undefined), cwd, env, redactionToken);
	}
}

async function runGit(
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	redactionToken?: string,
): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const rawError = proc.stderr ? await new Response(proc.stderr).text() : "";
		const error = redactionToken ? rawError.replaceAll(redactionToken, "[redacted]") : rawError;
		throw new Error(`git ${args[0] ?? "command"} failed: ${error.trim() || `exit code ${exitCode}`}`);
	}
}

/**
 * Clone the repo into a fresh per-job workspace. Uses the lease-time token
 * for the clone (performed immediately after poll, within the 1-hour window).
 * Subsequent git operations in the agent use the JIT credential helper.
 */
async function prepareGitHubWorkspace(job: Job): Promise<string> {
	if (!job.github || !job.githubToken) throw new Error("GitHub job is missing repository credentials");
	const workspace = join(
		GITHUB_WORKSPACE_ROOT,
		`${job.github.owner}-${job.github.repo}-${job.id}`.replace(/[^A-Za-z0-9._-]/g, "_"),
	);
	await mkdir(GITHUB_WORKSPACE_ROOT, { recursive: true });
	await rm(workspace, { recursive: true, force: true });

	// The clone uses the lease-time token via insteadOf URL rewriting.
	// The agent's subsequent git operations use the JIT credential helper instead.
	const gitEnv = {
		...process.env,
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `url.https://x-access-token:${job.githubToken}@github.com/.insteadOf`,
		GIT_CONFIG_VALUE_0: "https://github.com/",
	};
	const cloneUrl = `https://github.com/${job.github.owner}/${job.github.repo}.git`;
	const mirrorPath = deriveMirrorPath(GITHUB_WORKSPACE_ROOT, job.github.owner, job.github.repo);

	// Mirror operations serialize per path; the per-repo job mutex already
	// prevents same-repo jobs from overlapping, but the explicit lock makes
	// the invariant visible and guards against future refactors.
	const mirror = await withLock(mirrorLocks, mirrorPath, () =>
		tryPrepareRepoMirror(mirrorPath, cloneUrl, gitEnv, job.githubToken),
	);

	await cloneWorkspaceWithMirrorFallback(
		cloneUrl,
		workspace,
		mirror,
		GITHUB_WORKSPACE_ROOT,
		gitEnv,
		job.githubToken,
	);

	if (job.github.headRef) {
		await runGit(
			["checkout", "-B", job.github.headRef, `origin/${job.github.headRef}`],
			workspace,
			gitEnv,
			job.githubToken,
		);
	} else {
		const branch = `ompk/issue-${job.github.number}-${job.id.slice(0, 8)}`;
		await runGit(
			["checkout", "-B", branch, `origin/${job.github.defaultBranch}`],
			workspace,
			gitEnv,
			job.githubToken,
		);
	}
	return workspace;
}

// ─── Fence environment ────────────────────────────────────────────────────────

/**
 * Child environment for one attempt: the fence triple (the pre-push guard's
 * credential — never the relay bearer token) plus a `core.hooksPath` override
 * so every git invocation in the child tree runs the fence guard.
 *
 * GitHub jobs additionally receive:
 *   GH_TOKEN          — lease-time token for `gh` CLI calls (≤1 h window).
 *   OMPK_TOKEN_URL    — Worker /github-token endpoint for JIT refresh.
 *   credential.helper — relay-shipped script that fetches a fresh token at
 *                       the exact moment git needs credentials for push.
 *
 * In bare (non-container) mode this env is passed directly to the child. In
 * container mode buildContainerArgs() uses the fence vars from this env but
 * replaces the GH_TOKEN path with the credential broker (OMPK_BROKER_URL).
 *
 * Bare mode is documented as unfenced with respect to network egress.
 */
export function fenceEnv(job: Job): NodeJS.ProcessEnv {
	const githubAuth =
		job.source === "github" && job.githubToken
			? {
					GH_TOKEN: job.githubToken,
					OMPK_TOKEN_URL: `${WORKER_URL}/github-token`,
					GIT_CONFIG_COUNT: "2",
					GIT_CONFIG_KEY_1: "credential.helper",
					GIT_CONFIG_VALUE_1: CREDENTIAL_HELPER,
				}
			: { GIT_CONFIG_COUNT: "1" };
	return {
		...process.env,
		OMPK_FENCE_URL: `${WORKER_URL}/fence-check`,
		OMPK_FENCE_JOB: job.id,
		OMPK_FENCE_ATTEMPT: job.attemptId,
		OMPK_FENCE_TOKEN: job.leaseToken,
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: GIT_HOOKS_DIR,
		...githubAuth,
	};
}

/** Remove the ephemeral installation token from any relay-reported text. */
export function scrubJobResult(result: JobRunResult, secret: string | undefined): JobRunResult {
	if (!secret) return result;
	return {
		...result,
		output: result.output.replaceAll(secret, "[redacted]"),
		...(result.error !== undefined ? { error: result.error.replaceAll(secret, "[redacted]") } : {}),
	};
}

// ─── Job execution ────────────────────────────────────────────────────────────

/** ISO timestamp string for log lines. */
function ts(): string {
	return new Date().toISOString();
}

/**
 * Core job runner: workspace preparation, broker start, heartbeat, setup hook,
 * agent execution, and result submit. Assumes the per-repo mutex is already
 * held by the caller (runJob).
 */
async function runJobCore(token: string, allowedModels: readonly string[], job: Job): Promise<void> {
	console.log(`[${ts()}] running job ${job.id} (${job.issueIdentifier}, model=${job.model})`);
	let child: ChildProcess | undefined;
	let fenceLost = false;
	let workspace: string | undefined;
	let broker: GitBrokerHandle | undefined;
	let activeContainerName: string | undefined;
	let containerStop: Promise<void> | undefined;

	// Cleanly terminate the active child: uses podman rm --force for named
	// containers, SIGKILL on the process group for bare-mode children.
	const stopActiveContainer = (): Promise<void> => {
		if (activeContainerName) {
			containerStop ??= stopNamedContainer(activeContainerName, child).catch(err => {
				console.error(
					`[${ts()}] failed to remove container ${activeContainerName}: ${err instanceof Error ? err.message : err}`,
				);
			});
			return containerStop;
		}
		if (child) forceKillChildTree(child);
		return Promise.resolve();
	};

	// Register the spawned child so stopActiveContainer / fence-kill know where
	// to aim. In container mode, also records the container name.
	const registerChild =
		(containerName?: string) =>
		(spawned: ChildProcess): void => {
			child = spawned;
			activeContainerName = containerName;
			containerStop = undefined;
			// If the fence was already lost by the time spawn returned, kill
			// immediately rather than letting the container run orphaned.
			if (fenceLost) void stopActiveContainer();
		};

	const cadence = job.heartbeatMs ?? HEARTBEAT_FALLBACK_MS;
	const beat = setInterval(() => {
		void sendHeartbeat(token, job).then(live => {
			if (live || fenceLost) return;
			fenceLost = true;
			console.error(`[${ts()}] lease for job ${job.id} was fenced off; killing runner`);
			void stopActiveContainer();
		});
	}, cadence);

	try {
		try {
			workspace = job.source === "github" ? await prepareGitHubWorkspace(job) : undefined;
			if (fenceLost) {
				console.error(`[${ts()}] job ${job.id} discarded: lease no longer held`);
				return;
			}
			const executionWorkspace = workspace ?? WORKSPACE_DIR;
			const agentEnv = fenceEnv(job);
			const containerOptions: ContainerRunOptions | undefined = CONTAINER_IMAGE
				? {
						image: CONTAINER_IMAGE,
						memory: CONTAINER_MEMORY,
						pidsLimit: CONTAINER_PIDS_LIMIT,
						gitHooksDir: GIT_HOOKS_DIR,
					}
				: undefined;

			// Start the per-job credential broker when running in container mode
			// for a GitHub job. The broker's URL is passed into the container via
			// OMPK_BROKER_URL so git credentials are never part of the container env.
			if (containerOptions && job.source === "github" && job.githubToken) {
				broker = await startGitBroker({
					jobId: job.id,
					attemptId: job.attemptId,
					leaseToken: job.leaseToken,
					workerTokenUrl: `${WORKER_URL}/github-token`,
				});
			}

			const setupContainerName = containerOptions
				? deriveContainerName(job.id, job.attemptId, "setup")
				: undefined;
			const agentContainerName = containerOptions
				? deriveContainerName(job.id, job.attemptId, "agent")
				: undefined;

			let result: JobRunResult;

			if (!allowedModels.includes(job.model)) {
				result = {
					success: false,
					output: "",
					error: "model is not on this relay's allowlist (OMPK_RELAY_MODELS)",
					failureClass: "transient",
				};
			} else {
				if (fenceLost) {
					console.error(`[${ts()}] job ${job.id} discarded: lease no longer held`);
					return;
				}

				// Run the repo-declared .ompk/setup.sh hook when present.
				const setupEnv = buildSetupHookEnv();
				const setupResult = await runSetupHook(executionWorkspace, {
					spawn,
					timeoutMs: SETUP_TIMEOUT_MS,
					env: setupEnv,
					redactionToken: job.githubToken,
					onSpawn: registerChild(setupContainerName),
					...(containerOptions && setupContainerName
						? {
								command: CONTAINER_BIN,
								args: buildContainerSetupArgs(executionWorkspace, setupEnv, {
									...containerOptions,
									name: setupContainerName,
								}),
								nonZeroFailureClass: "transient" as const,
								onTimeout: () => stopNamedContainer(setupContainerName, child),
							}
						: {}),
				});

				if (fenceLost) {
					console.error(`[${ts()}] job ${job.id} discarded: lease no longer held`);
					return;
				}

				if (setupResult !== undefined) {
					result = setupResult;
				} else {
					result = await executeJob(job, allowedModels, spawn, JOB_TIMEOUT_MS, {
						onSpawn: registerChild(agentContainerName),
						...(containerOptions && agentContainerName
							? {
									command: CONTAINER_BIN,
									args: buildContainerArgs(job, executionWorkspace, agentEnv, {
										...containerOptions,
										name: agentContainerName,
									}, broker?.url),
									cwd: WORKSPACE_DIR,
									nonZeroFailureClass: "transient" as const,
									onTimeout: () => stopNamedContainer(agentContainerName, child),
									detached: process.platform !== "win32",
								}
							: {
									env: agentEnv,
									cwd: executionWorkspace,
								}),
					});
				}
			}

			if (fenceLost) {
				console.error(`[${ts()}] job ${job.id} discarded: lease no longer held`);
				return;
			}
			await submitResult(token, job, scrubJobResult(result, job.githubToken));
			console.log(`[${ts()}] job ${job.id} ${result.success ? "succeeded" : "failed"}`);
		} catch (err) {
			const result: JobRunResult = {
				success: false,
				output: "",
				error: err instanceof Error ? err.message : "workspace preparation failed",
				failureClass: "transient",
			};
			if (!fenceLost) await submitResult(token, job, scrubJobResult(result, job.githubToken));
		}
	} finally {
		clearInterval(beat);
		if (containerStop) await containerStop;
		await broker
			?.stop()
			.catch(err =>
				console.error(`[${ts()}] broker stop failed: ${err instanceof Error ? err.message : err}`),
			);
		if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * Acquire the per-repo mutex then run the job. Same-repo jobs serialize;
 * jobs for different repos (or different Linear issues) run concurrently up
 * to MAX_CONCURRENT_JOBS.
 */
async function runJob(token: string, allowedModels: readonly string[], job: Job): Promise<void> {
	const repoKey =
		job.source === "github" && job.github
			? `github:${job.github.owner}/${job.github.repo}`
			: `linear:${job.issueId}`;
	return withLock(repoLocks, repoKey, () => runJobCore(token, allowedModels, job));
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	if (!RELAY_TOKEN) {
		console.error("RELAY_TOKEN is required (matches the Worker's RELAY_TOKEN secret)");
		process.exit(1);
	}
	const allowedModels = parseAllowedModels(process.env.OMPK_RELAY_MODELS);
	if (allowedModels.length === 0) {
		console.error("OMPK_RELAY_MODELS is required (comma-separated allowlist of model combo ids)");
		process.exit(1);
	}
	console.log(
		`ompk relay "${RELAY_NAME}" starting — polling ${WORKER_URL} every ${POLL_INTERVAL_MS}ms, ` +
			`${allowedModels.length} allowed model(s), max ${MAX_CONCURRENT_JOBS} concurrent job(s)` +
			(CONTAINER_IMAGE ? `, container image: ${CONTAINER_IMAGE}` : ", bare mode (unfenced egress)"),
	);
	await announceStartup(RELAY_TOKEN);

	// Slot counter: tracks polled-but-not-yet-finished jobs (including those
	// waiting for the per-repo mutex). Capped at MAX_CONCURRENT_JOBS before
	// each poll so we never hold more leases than we can service.
	let activeCount = 0;

	for (;;) {
		if (activeCount >= MAX_CONCURRENT_JOBS) {
			await Bun.sleep(POLL_INTERVAL_MS);
			continue;
		}
		let job: Job | null;
		try {
			job = await pollJob(RELAY_TOKEN);
		} catch (err) {
			console.error(`[${ts()}] poll error:`, err instanceof Error ? err.message : err);
			await Bun.sleep(POLL_INTERVAL_MS);
			continue;
		}
		if (!job) {
			await Bun.sleep(POLL_INTERVAL_MS);
			continue;
		}
		activeCount++;
		void runJob(RELAY_TOKEN, allowedModels, job)
			.catch(err => {
				console.error(
					`[${ts()}] uncaught error in job ${job!.id}:`,
					err instanceof Error ? err.message : err,
				);
			})
			.finally(() => {
				activeCount--;
			});
		// No sleep: immediately attempt to fill the next concurrent slot.
	}
}

if (import.meta.main) {
	void main();
}
