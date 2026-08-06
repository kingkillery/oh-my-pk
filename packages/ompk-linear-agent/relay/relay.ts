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
 * per-phase podman container backed by a per-job isolated podman network.
 * A stage-scoped CONNECT proxy enforces egress policy:
 *   setup phase  → package registries + github.com
 *   agent phase  → Anthropic API only; GitHub access is mediated by the broker
 * The agent phase uses a Git credential broker (loopback HTTP server, one per
 * job) so the GitHub installation token never enters the container environment
 * or logs. The broker also enforces push-to-ompk/*-branches-only; the
 * pre-push hook calls OMPK_BROKER_URL and validates remote refs before any
 * push is allowed. Fence checks and git operations are routed through the
 * broker so the container needs no direct Worker or github.com connectivity.
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
import { createConnection, createServer, type AddressInfo } from "node:net";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Stage-scoped egress policy ───────────────────────────────────────────────

/**
 * CONNECT proxy allowlist for the repo setup phase.
 * Grants outbound access to package registries and GitHub (for dependency
 * sources), but nothing else. All entries are "host:port" strings.
 */
export const SETUP_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
	"github.com:443",
	"api.github.com:443",
	"codeload.github.com:443",
	"objects.githubusercontent.com:443",
	"raw.githubusercontent.com:443",
	// npm / yarn / pnpm
	"registry.npmjs.org:443",
	"registry.npmjs.org:80",
	"registry.yarnpkg.com:443",
	// PyPI
	"pypi.org:443",
	"files.pythonhosted.org:443",
	// Rust / crates.io
	"crates.io:443",
	"static.crates.io:443",
]);

/**
 * CONNECT proxy allowlist for the agent execution phase.
 * Only the Anthropic API is reachable directly; GitHub access is mediated
 * exclusively through the per-job credential broker (/gh/ proxy routes),
 * so the real installation token never enters the container environment.
 */
export const AGENT_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
	"api.anthropic.com:443",
]);

/** Handle returned by startEgressProxy. */
export interface EgressProxyHandle {
	/** Port the proxy is listening on. */
	readonly port: number;
	/** Stop the proxy server and release the port. */
	stop(): void;
}

/**
 * Start a per-job HTTP CONNECT proxy on a random port.
 *
 * Only CONNECT-method tunnels are handled; plain HTTP forwarding is
 * intentionally unsupported (the container should use NO_PROXY for any
 * HTTP-only traffic to the gateway/broker).
 *
 * Phase controls the allowlist:
 *   setup  → SETUP_ALLOWED_HOSTS  (registries + github.com)
 *   agent  → AGENT_ALLOWED_HOSTS  (Anthropic API only; git goes via broker)
 *
 * Blocked destinations receive 403; unreachable allowed destinations 502.
 * Fail-closed: malformed CONNECT requests get 400 and the socket is destroyed.
 *
 * @param phase       "setup" or "agent"
 * @param bindAddress Address to listen on; defaults to "0.0.0.0" so the
 *                    proxy is reachable from inside a per-job podman network
 *                    via the bridge gateway address.
 */
export function startEgressProxy(
	phase: "setup" | "agent",
	bindAddress = "0.0.0.0",
): Promise<EgressProxyHandle> {
	const allowed = phase === "setup" ? SETUP_ALLOWED_HOSTS : AGENT_ALLOWED_HOSTS;
	return new Promise<EgressProxyHandle>((resolve, reject) => {
		const server = createServer(clientSocket => {
			let buf = "";
			clientSocket.on("error", () => {});
			clientSocket.on("data", function onData(chunk: Buffer) {
				buf += chunk.toString("binary");
				const headEnd = buf.indexOf("\r\n\r\n");
				if (headEnd === -1) return;
				clientSocket.removeListener("data", onData);

				const firstLine = buf.slice(0, buf.indexOf("\r\n"));
				const m = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/.exec(firstLine);
				if (!m) {
					clientSocket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
					clientSocket.destroy();
					return;
				}
				const host = m[1]!;
				const port = parseInt(m[2]!, 10);
				const target = `${host}:${port}`;

				if (!allowed.has(target)) {
					const msg = `CONNECT to ${target} denied by ompk egress policy (${phase} phase)`;
					clientSocket.write(
						`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${msg.length}\r\n\r\n${msg}`,
					);
					clientSocket.destroy();
					return;
				}

				const upstream = createConnection({ host, port }, () => {
					clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					// Flush any bytes already received after the CONNECT headers.
					const tail = buf.slice(headEnd + 4);
					if (tail.length > 0) upstream.write(Buffer.from(tail, "binary"));
					upstream.pipe(clientSocket);
					clientSocket.pipe(upstream);
				});
				upstream.on("error", () => {
					if (!clientSocket.destroyed) {
						clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
						clientSocket.destroy();
					}
				});
				clientSocket.on("error", () => upstream.destroy());
			});
		});

		server.on("error", reject);
		server.listen(0, bindAddress, () => {
			const { port } = server.address() as AddressInfo;
			resolve({ port, stop: () => server.close() });
		});
	});
}

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
	/**
	 * Per-job podman network name. When set, containers join this network
	 * instead of the host network. Callers must create the network before
	 * launching containers and remove it in the job's finally block.
	 * Defaults to "host" (bare host network, the previous behaviour).
	 */
	network?: string;
	/**
	 * HTTP_PROXY / HTTPS_PROXY value injected into the container environment
	 * so all internet-bound traffic is routed through the stage-scoped egress
	 * proxy. When absent no proxy vars are injected.
	 */
	egressProxyUrl?: string;
	/**
	 * NO_PROXY value injected into the container environment. Typically the
	 * podman network gateway address so the credential broker is reachable
	 * without being routed through the CONNECT proxy.
	 */
	noProxyHosts?: string;
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
		// Use the per-job isolated network when provided; fall back to host
		// network for backwards compat (bare mode / no podman network).
		`--network=${options.network ?? "host"}`,
		// Suppress podman's automatic HTTP_PROXY injection; we inject our own
		// stage-scoped proxy URL via the container environment explicitly.
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
 * Security invariants:
 *   - GH_TOKEN never enters the container env. Git credentials are brokered.
 *   - When a broker URL is provided, OMPK_FENCE_URL is redirected to the
 *     broker's /fence-check endpoint so fence validation does not require
 *     direct Worker connectivity from the container.
 *   - The insteadOf rewrite redirects all github.com git traffic through the
 *     broker's /gh/ proxy so the agent phase needs no direct github.com access.
 *   - When options.egressProxyUrl is set, HTTP_PROXY / HTTPS_PROXY / NO_PROXY
 *     are injected so all internet traffic flows through the stage-scoped proxy.
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
		// Broker mode: route all github.com git traffic and fence checks through
		// the per-job credential broker so the agent container needs no direct
		// connectivity to github.com or the Cloudflare Worker.
		//
		// git config layout (index 0 is always core.hooksPath):
		//   1: credential.helper → ompk-git-credential (fetches JIT token from broker)
		//   2: url.${brokerUrl}/gh/.insteadOf → https://github.com/
		//      Rewrites all github.com HTTPS URLs to the broker's /gh/ HTTP proxy
		//      so git never makes a direct TLS connection to github.com.
		containerEnv.OMPK_BROKER_URL = brokerUrl;
		// Route fence checks through the broker so the container doesn't need
		// direct connectivity to the Cloudflare Worker.
		containerEnv.OMPK_FENCE_URL = `${brokerUrl}/fence-check`;
		containerEnv.GIT_CONFIG_COUNT = "3";
		containerEnv.GIT_CONFIG_KEY_1 = "credential.helper";
		containerEnv.GIT_CONFIG_VALUE_1 = `${CONTAINER_GIT_HOOKS_DIR}/ompk-git-credential`;
		containerEnv.GIT_CONFIG_KEY_2 = `url.${brokerUrl}/gh/.insteadOf`;
		containerEnv.GIT_CONFIG_VALUE_2 = "https://github.com/";
	} else {
		containerEnv.GIT_CONFIG_COUNT = "1";
	}

	// Inject the stage-scoped egress proxy when the container runs on an
	// isolated per-job network. NO_PROXY must exclude the gateway/broker so
	// HTTP calls to the broker bypass the CONNECT proxy.
	if (options.egressProxyUrl) {
		containerEnv.HTTP_PROXY = options.egressProxyUrl;
		containerEnv.HTTPS_PROXY = options.egressProxyUrl;
		if (options.noProxyHosts) containerEnv.NO_PROXY = options.noProxyHosts;
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
	// Inject the stage-scoped egress proxy when running on a per-job network.
	// egressProxyUrl takes precedence over whatever HTTP_PROXY is in env.
	if (options.egressProxyUrl) {
		containerEnv.HTTP_PROXY = options.egressProxyUrl;
		containerEnv.HTTPS_PROXY = options.egressProxyUrl;
		if (options.noProxyHosts) containerEnv.NO_PROXY = options.noProxyHosts;
	}
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

// ─── Per-job podman network ───────────────────────────────────────────────────

export interface JobNetworkHandle {
	/** The podman network name (ompk-<safe-job-attempt>). */
	name: string;
	/** The gateway IP of the network (host side); bind the proxy and broker here. */
	gatewayIp: string;
	/** Remove the network. Call in the job's finally block. */
	remove: () => Promise<void>;
}

/**
 * Create a per-job isolated podman network and return its gateway IP.
 *
 * The `--internal` flag prevents outbound routing; all internet traffic from
 * containers on this network must pass through the stage-scoped CONNECT proxy
 * that is bound to the gateway address.
 *
 * The network is created synchronously and inspected to discover the gateway.
 * Callers must call `handle.remove()` in the job's finally block.
 */
export async function createJobNetwork(jobId: string, attemptId: string): Promise<JobNetworkHandle> {
	const safeSuffix = `${jobId}-${attemptId}`.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
	const name = `ompk-${safeSuffix}`;

	const createProc = Bun.spawn([CONTAINER_BIN, "network", "create", "--internal", name], {
		env: process.env,
		stdout: "ignore",
		stderr: "pipe",
	});
	const createExit = await createProc.exited;
	if (createExit !== 0) {
		const errText = createProc.stderr ? await new Response(createProc.stderr).text() : "";
		throw new Error(
			`failed to create podman network ${name}: ${errText.trim() || `exit code ${createExit}`}`,
		);
	}

	// Inspect to get the gateway address. podman outputs a JSON array.
	const inspectProc = Bun.spawn([CONTAINER_BIN, "network", "inspect", name], {
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const inspectExit = await inspectProc.exited;
	if (inspectExit !== 0) {
		const errText = inspectProc.stderr ? await new Response(inspectProc.stderr).text() : "";
		// Best-effort cleanup before throwing.
		await Bun.spawn([CONTAINER_BIN, "network", "rm", "--force", name], {
			env: process.env,
			stdout: "ignore",
			stderr: "ignore",
		}).exited.catch(() => undefined);
		throw new Error(
			`failed to inspect podman network ${name}: ${errText.trim() || `exit code ${inspectExit}`}`,
		);
	}

	const inspectText = inspectProc.stdout ? await new Response(inspectProc.stdout).text() : "";
	let gatewayIp: string | undefined;
	try {
		// podman network inspect returns [{..., "subnets": [{"subnet": "...", "gateway": "..."}], ...}]
		const parsed: unknown = JSON.parse(inspectText);
		if (Array.isArray(parsed) && parsed.length > 0) {
			const net = parsed[0] as Record<string, unknown>;
			const subnets = net["subnets"] ?? net["Subnets"];
			if (Array.isArray(subnets) && subnets.length > 0) {
				const first = subnets[0] as Record<string, unknown>;
				const gw = first["gateway"] ?? first["Gateway"];
				if (typeof gw === "string" && gw.length > 0) gatewayIp = gw;
			}
		}
	} catch {
		// JSON parse failure: fall through to the error below.
	}
	if (!gatewayIp) {
		await Bun.spawn([CONTAINER_BIN, "network", "rm", "--force", name], {
			env: process.env,
			stdout: "ignore",
			stderr: "ignore",
		}).exited.catch(() => undefined);
		throw new Error(`podman network ${name} has no gateway in inspect output`);
	}

	return {
		name,
		gatewayIp,
		remove: async () => {
			await Bun.spawn([CONTAINER_BIN, "network", "rm", "--force", name], {
				env: process.env,
				stdout: "ignore",
				stderr: "ignore",
			}).exited;
		},
	};
}

// ─── Git credential broker ────────────────────────────────────────────────────

/**
 * Handle returned by startGitBroker.
 *
 * `url` is the address of the broker — either `http://127.0.0.1:<port>` in
 * legacy host-network mode or `http://<gatewayIp>:<port>` when running with
 * a per-job isolated podman network.
 */
export interface GitBrokerHandle {
	/** http://<host>:<port> — set as OMPK_BROKER_URL in the container env. */
	url: string;
	/** Shut down the broker server. Call in the job's finally block. */
	stop: () => Promise<void>;
}

/** Options for startGitBroker. Injectables (fetchImpl) are used by tests. */
export interface GitBrokerOptions {
	jobId: string;
	attemptId: string;
	leaseToken: string;
	/** Worker /github-token endpoint for JIT token issuance. */
	workerTokenUrl: string;
	/**
	 * Worker /fence-check endpoint. When set, POST /fence-check on the broker
	 * is proxied to this URL so the container does not need direct Worker
	 * connectivity. Required when running with a per-job isolated network.
	 */
	workerFenceUrl?: string;
	/** Fetch implementation override; defaults to the global fetch. */
	fetchImpl?: (url: string | URL, init?: RequestInit) => Promise<Response>;
	/**
	 * Address to bind the broker server to.
	 * Defaults to "127.0.0.1" (loopback, for --network=host containers).
	 * Set to the podman network gateway IP when using a per-job network so the
	 * broker is reachable from inside the isolated container.
	 */
	bindAddress?: string;
}

/**
 * Start a per-job Git credential + operations broker on a random port.
 *
 * Endpoints
 * ---------
 * GET /credential?host=<host>
 *   Called by the ompk-git-credential helper in the container. Fetches a
 *   JIT token from the Worker (fence-authenticated) and returns it in the
 *   git credential protocol format (username= / password= lines).
 *   Only github.com is served; all other hosts receive 403.
 *
 * POST /push-check
 *   Body: { refs: string[] } — the remote refs being pushed to.
 *   Rejects any ref outside the refs/heads/ompk/* namespace (403).
 *   Returns 200 "ok" when all refs are permitted.
 *
 * POST /fence-check
 *   Proxies the fence-check body to the Worker /fence-check URL and mirrors
 *   the response. Allows the pre-push hook to validate its lease without a
 *   direct connection to the Cloudflare Worker. Only active when
 *   options.workerFenceUrl is set.
 *
 * GET|POST /gh/<path>
 *   Git smart-HTTP proxy for github.com. Fetches a JIT token and forwards
 *   the request to https://github.com/<path> with Authorization injected.
 *   The insteadOf git config in buildContainerArgs rewrites github.com URLs
 *   to /gh/ so git never opens a direct TLS connection to github.com.
 *
 * Lifecycle: start before the agent container, stop in the job's finally block.
 */
export async function startGitBroker(options: GitBrokerOptions): Promise<GitBrokerHandle> {
	const {
		jobId,
		attemptId,
		leaseToken,
		workerTokenUrl,
		workerFenceUrl,
		fetchImpl = fetch,
		bindAddress = "127.0.0.1",
	} = options;

	/** Fetch a fresh JIT token from the Worker. Throws on error. */
	const fetchJitToken = async (): Promise<string> => {
		let jitRes: Response;
		try {
			jitRes = await fetchImpl(workerTokenUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jobId, attemptId, leaseToken }),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`JIT token fetch error: ${msg}`);
		}
		if (!jitRes.ok) {
			const body = await jitRes.text().catch(() => "");
			throw new Error(`JIT token fetch failed: ${jitRes.status} ${body}`);
		}
		const rawData: unknown = await jitRes.json().catch(() => null);
		if (
			rawData === null ||
			typeof rawData !== "object" ||
			!("token" in rawData) ||
			typeof (rawData as Record<string, unknown>)["token"] !== "string" ||
			(rawData as Record<string, unknown>)["token"] === ""
		) {
			throw new Error("JIT token response has invalid or missing token");
		}
		return (rawData as Record<string, unknown>)["token"] as string;
	};

	const server = Bun.serve({
		hostname: bindAddress,
		port: 0, // OS picks a free port; available as server.port immediately.
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);

			// GET /credential?host=<host>
			// Called by the ompk-git-credential helper inside the container.
			if (req.method === "GET" && url.pathname === "/credential") {
				const host = url.searchParams.get("host") ?? "";
				if (host !== "github.com") {
					// Refuse credentials for any host other than github.com.
					return new Response(
						`refused: credential broker only serves github.com (got: ${host})\n`,
						{ status: 403 },
					);
				}
				let jitToken: string;
				try {
					jitToken = await fetchJitToken();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return new Response(`${msg}\n`, { status: 502 });
				}
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

			// POST /fence-check
			// Proxies fence validation to the Worker so the container doesn't need
			// direct connectivity to the Cloudflare Worker URL.
			if (req.method === "POST" && url.pathname === "/fence-check") {
				if (!workerFenceUrl) {
					return new Response("fence-check proxy not configured\n", { status: 503 });
				}
				let fenceRes: Response;
				try {
					fenceRes = await fetchImpl(workerFenceUrl, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: await req.text(),
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return new Response(`fence-check proxy error: ${msg}\n`, { status: 502 });
				}
				return new Response(fenceRes.body, {
					status: fenceRes.status,
					headers: { "content-type": fenceRes.headers.get("content-type") ?? "text/plain" },
				});
			}

			// GET|POST /gh/<path>
			// Git smart-HTTP proxy for github.com. Forwards the request to GitHub
			// with a fresh JIT token injected as Authorization. The git insteadOf
			// rewrite in buildContainerArgs redirects all github.com URLs here so
			// the agent container has no direct github.com network access.
			if (url.pathname.startsWith("/gh/")) {
				const ghPath = url.pathname.slice("/gh".length); // "/owner/repo.git/..."
				const ghUrl = `https://github.com${ghPath}${url.search}`;
				let jitToken: string;
				try {
					jitToken = await fetchJitToken();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return new Response(`git proxy error: ${msg}\n`, { status: 502 });
				}
				const upstreamHeaders: Record<string, string> = {
					Authorization: `Basic ${btoa(`x-access-token:${jitToken}`)}`,
					"User-Agent": "git/ompk-relay",
				};
				// Forward Content-Type and Git-Protocol headers from the client.
				const ct = req.headers.get("content-type");
				if (ct) upstreamHeaders["Content-Type"] = ct;
				const gp = req.headers.get("git-protocol");
				if (gp) upstreamHeaders["Git-Protocol"] = gp;
				let ghRes: Response;
				try {
					ghRes = await fetchImpl(ghUrl, {
						method: req.method,
						headers: upstreamHeaders,
						// Pass the body for POST (upload-pack / receive-pack) unchanged.
						body: req.method === "GET" ? undefined : req.body,
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return new Response(`git proxy upstream error: ${msg}\n`, { status: 502 });
				}
				// Mirror the response headers that git cares about.
				const respHeaders: Record<string, string> = {};
				const ghCt = ghRes.headers.get("content-type");
				if (ghCt) respHeaders["Content-Type"] = ghCt;
				const ghCacheControl = ghRes.headers.get("cache-control");
				if (ghCacheControl) respHeaders["Cache-Control"] = ghCacheControl;
				return new Response(ghRes.body, { status: ghRes.status, headers: respHeaders });
			}

			return new Response("not found\n", { status: 404 });
		},
	});

	return {
		url: `http://${bindAddress}:${server.port}`,
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
 * Core job runner: workspace preparation, per-job network + proxy setup,
 * broker start, heartbeat, setup hook, agent execution, and result submit.
 * Assumes the per-repo mutex is already held by the caller (runJob).
 */
async function runJobCore(token: string, allowedModels: readonly string[], job: Job): Promise<void> {
	console.log(`[${ts()}] running job ${job.id} (${job.issueIdentifier}, model=${job.model})`);
	let child: ChildProcess | undefined;
	let fenceLost = false;
	let workspace: string | undefined;
	let broker: GitBrokerHandle | undefined;
	let jobNetwork: JobNetworkHandle | undefined;
	let setupProxy: EgressProxyHandle | undefined;
	let agentProxy: EgressProxyHandle | undefined;
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
			let containerOptions: ContainerRunOptions | undefined = CONTAINER_IMAGE
				? {
						image: CONTAINER_IMAGE,
						memory: CONTAINER_MEMORY,
						pidsLimit: CONTAINER_PIDS_LIMIT,
						gitHooksDir: GIT_HOOKS_DIR,
					}
				: undefined;

			if (containerOptions) {
				// Create a per-job isolated network. The network's gateway IP is
				// used to bind the proxy and broker so the container can reach them.
				try {
					jobNetwork = await createJobNetwork(job.id, job.attemptId);
					console.log(
						`[${ts()}] job ${job.id}: network ${jobNetwork.name} (gateway ${jobNetwork.gatewayIp})`,
					);

					// Start stage-scoped egress proxies bound to the gateway address.
					// The setup proxy allows registries; the agent proxy allows only
					// the Anthropic API (git traffic goes through the broker's /gh/).
					[setupProxy, agentProxy] = await Promise.all([
						startEgressProxy("setup", jobNetwork.gatewayIp),
						startEgressProxy("agent", jobNetwork.gatewayIp),
					]);

					// Wire the per-job network and proxy into the container options.
					// NO_PROXY must exclude the gateway so broker/fence-check HTTP
					// calls bypass the CONNECT proxy.
					containerOptions = {
						...containerOptions,
						network: jobNetwork.name,
						noProxyHosts: jobNetwork.gatewayIp,
					};
				} catch (err) {
					// Network or proxy startup failure is transient infrastructure: log
					// and degrade to host networking rather than failing the whole job.
					console.error(
						`[${ts()}] job ${job.id}: network/proxy setup failed, falling back to host network: ${err instanceof Error ? err.message : err}`,
					);
				}
			}

			// Start the per-job credential broker. In isolated-network mode it
			// binds to the gateway IP so the container can reach it; in host-
			// network mode (fallback or bare) it binds to loopback.
			if (containerOptions && job.source === "github" && job.githubToken) {
				broker = await startGitBroker({
					jobId: job.id,
					attemptId: job.attemptId,
					leaseToken: job.leaseToken,
					workerTokenUrl: `${WORKER_URL}/github-token`,
					workerFenceUrl: `${WORKER_URL}/fence-check`,
					bindAddress: jobNetwork?.gatewayIp ?? "127.0.0.1",
				});
				// Now that the broker URL is known, wire the agent-phase egress proxy
				// URL into the container options.
				if (agentProxy && jobNetwork) {
					const agentProxyUrl = `http://${jobNetwork.gatewayIp}:${agentProxy.port}`;
					containerOptions = { ...containerOptions, egressProxyUrl: agentProxyUrl };
				}
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
				// The setup phase gets its own proxy allowlist (registries + github.com).
				const setupEnv = buildSetupHookEnv();
				if (setupProxy && jobNetwork) {
					setupEnv.HTTP_PROXY = `http://${jobNetwork.gatewayIp}:${setupProxy.port}`;
					setupEnv.HTTPS_PROXY = `http://${jobNetwork.gatewayIp}:${setupProxy.port}`;
					setupEnv.NO_PROXY = jobNetwork.gatewayIp;
				}
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
									// Setup phase uses the setup proxy, not the agent proxy.
									egressProxyUrl: setupProxy && jobNetwork
										? `http://${jobNetwork.gatewayIp}:${setupProxy.port}`
										: undefined,
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
									args: buildContainerArgs(
										job,
										executionWorkspace,
										agentEnv,
										{ ...containerOptions, name: agentContainerName },
										broker?.url,
									),
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
		setupProxy?.stop();
		agentProxy?.stop();
		await jobNetwork
			?.remove()
			.catch(err =>
				console.error(
					`[${ts()}] network ${jobNetwork!.name} remove failed: ${err instanceof Error ? err.message : err}`,
				),
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
