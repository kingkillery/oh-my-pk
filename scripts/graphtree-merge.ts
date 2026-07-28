#!/usr/bin/env bun
/**
 * graphtree-merge — consolidate parallel worktree lanes into a single commit.
 *
 * A "turn" fans work out across N worktree lanes (branches `work/graphtree-<turn>-*`).
 * Once every lane AGREES — clean working trees, each carrying committed work, and
 * mutually mergeable — their changes are squash-merged into ONE commit on the primary
 * output branch, pushed to the remote, and the lane worktrees + branches are removed.
 *
 * "Agreement" gate (all must hold, else the run refuses to mutate):
 *   1. Every lane working tree is clean (all lane work is committed).
 *   2. Every lane has >=1 commit ahead of the base.
 *   3. The lanes merge into the base with no conflicts (`git merge-tree --write-tree`).
 *   4. The base branch is checked out in some worktree and that worktree is clean.
 *
 * Safety: without `--apply` (or `--push`, which implies it) the tool prints a plan and
 * exits non-zero when the lanes do not agree — nothing is committed, pushed, or removed.
 *
 * Usage:
 *   bun scripts/graphtree-merge.ts <turn> [options]
 *
 *     <turn>                lane prefix; matches branches work/graphtree-<turn>-*
 *   --base <branch>         primary output branch (default: main)
 *   --remote <name>         push target (default: <base>'s upstream remote, else origin)
 *   --lanes <p1,p2,p3>      explicit lane suffixes (default: auto-discover)
 *   --message <text>        override the single-commit message
 *   --apply                 perform the merge + cleanup (default: plan only)
 *   --push                  push the single commit to <remote> (implies --apply)
 *   --keep-worktrees        do not remove lane worktrees after the merge
 *   --keep-branches         do not delete lane branches after the merge
 *   --force                 allow removing worktrees that still hold uncommitted state
 *   -h, --help              show this help
 *
 * Examples:
 *   bun scripts/graphtree-merge.ts parity                 # plan only (dry-run)
 *   bun scripts/graphtree-merge.ts parity --apply         # merge + cleanup, no push
 *   bun scripts/graphtree-merge.ts parity --push          # merge + cleanup + push
 *   bun scripts/graphtree-merge.ts parity --lanes p2,p3   # merge a subset of lanes
 */

import { parseArgs } from "node:util";

interface Worktree {
	path: string;
	branch: string | null; // null when detached
	head: string;
}

interface Lane {
	/** Full branch name, e.g. `work/graphtree-parity-p2`. */
	branch: string;
	/** Filesystem path of the worktree that has this branch checked out, if any. */
	worktree: string | null;
	/** Lane suffix after the turn prefix, e.g. `p2`. */
	suffix: string;
	/** Subject of the lane's HEAD commit. */
	subject: string;
	/** Commits on the lane not reachable from base. */
	ahead: number;
	/** `git status --porcelain` output of the lane worktree ("" when clean). */
	dirty: string;
}

interface GitResult {
	ok: boolean;
	code: number;
	stdout: string;
	stderr: string;
}

const HELP = `graphtree-merge — consolidate parallel worktree lanes into one commit.

usage:
  bun scripts/graphtree-merge.ts <turn> [options]

options:
  --base <branch>         primary output branch (default: main)
  --remote <name>         push target (default: <base> upstream remote, else origin)
  --lanes <p1,p2,p3>      explicit lane suffixes (default: auto-discover)
  --message <text>        override the single-commit message
  --apply                 perform merge + cleanup (default: plan only)
  --push                  push the single commit to <remote> (implies --apply)
  --keep-worktrees        skip lane worktree removal after merge
  --keep-branches         skip lane branch deletion after merge
  --force                 remove worktrees even if they still hold uncommitted state
  -h, --help              show this help`;

async function git(args: string[], opts: { cwd?: string; stdin?: string } = {}): Promise<GitResult> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: opts.stdin !== undefined ? "pipe" : "ignore",
	});
	if (opts.stdin !== undefined && proc.stdin) {
		proc.stdin.write(opts.stdin);
		await proc.stdin.end();
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { ok: code === 0, code, stdout, stderr };
}

function fail(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

/** Parse `git worktree list --porcelain` into structured worktrees. */
async function worktrees(cwd: string): Promise<Worktree[]> {
	const res = await git(["worktree", "list", "--porcelain"], { cwd });
	if (!res.ok) fail(`could not list worktrees: ${res.stderr.trim()}`);
	const out: Worktree[] = [];
	let cur: Partial<Worktree> = {};
	for (const line of res.stdout.split("\n")) {
		if (line === "") {
			if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? "" });
			cur = {};
			continue;
		}
		const [key, ...rest] = line.split(" ");
		const val = rest.join(" ");
		if (key === "worktree") cur.path = val;
		else if (key === "HEAD") cur.head = val;
		else if (key === "branch") cur.branch = val.replace(/^refs\/heads\//, "");
	}
	return out;
}

/** Resolve the upstream "<remote>/<branch>" for a local branch, or null. */
async function upstream(branch: string, cwd: string): Promise<string | null> {
	const res = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], { cwd });
	return res.ok ? res.stdout.trim() : null;
}

/** Discover lanes for a turn from branches `work/graphtree-<turn>-*`, joined to worktrees. */
async function discoverLanes(turn: string, base: string, cwd: string, explicit?: string[]): Promise<Lane[]> {
	const wts = await worktrees(cwd);
	const branchToWorktree = new Map<string, string>();
	for (const w of wts) if (w.branch) branchToWorktree.set(w.branch, w.path);

	// Resolve to full branch names: work/graphtree-<turn>-<suffix>
	const prefix = `work/graphtree-${turn}-`;
	const branches: string[] =
		explicit && explicit.length > 0
			? explicit.map(s => (s.startsWith(prefix) ? s : `${prefix}${s}`))
			: (await git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}*`], { cwd })).stdout
					.split("\n")
					.map(l => l.trim())
					.filter(Boolean);

	if (branches.length === 0) fail(`no lanes found for turn "${turn}" (looked for ${prefix}*)`);

	const lanes: Lane[] = [];
	for (const b of branches) {
		const suffix = b.startsWith(prefix) ? b.slice(prefix.length) : b;
		const worktree = branchToWorktree.get(b) ?? null;
		const subjectRes = await git(["log", "-1", "--format=%s", b], { cwd });
		const aheadRes = await git(["rev-list", "--count", `${base}..${b}`], { cwd });
		const dirtyRes = worktree
			? await git(["status", "--porcelain"], { cwd: worktree })
			: { stdout: "", ok: true, code: 0, stderr: "" };
		lanes.push({
			branch: b,
			worktree,
			suffix,
			subject: subjectRes.ok ? subjectRes.stdout.trim() : "(no commits)",
			ahead: aheadRes.ok ? Number(aheadRes.stdout.trim()) : 0,
			dirty: dirtyRes.stdout,
		});
	}
	return lanes;
}

/**
 * Verify the lanes agree on a clean union WITHOUT mutating anything. A lane "agrees" when:
 *  (a) it merges into <base> with no conflict (`git merge-tree --write-tree`, base kept as a
 *      commit so merge-base history stays intact — this git rejects N-way merges), and
 *  (b) no two lanes touch the same file (overlap = manual resolution needed).
 * The apply step performs the real sequential `git merge --squash` of these same lanes;
 * these two checks are sufficient for that to yield one clean linear commit.
 * Returns human-readable conflict strings (empty when the lanes agree).
 */
async function mergeCheck(base: string, lanes: Lane[], cwd: string): Promise<string[]> {
	const conflicts: string[] = [];
	const touched = new Map<string, string>(); // file -> first lane that changed it
	for (const lane of lanes) {
		// (a) does this lane merge cleanly into base?
		const res = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", base, lane.branch], { cwd });
		if (res.code === 1) {
			const files = res.stdout
				.split("\n")
				.map(l => l.trim())
				.filter(l => l && !/^[0-9a-f]{40}$/.test(l));
			for (const f of files.length > 0 ? files : ["<unresolved conflict>"])
				conflicts.push(`${lane.branch} conflicts with ${base}: ${f}`);
		} else if (res.code !== 0) {
			conflicts.push(`${lane.branch}: merge-tree error (exit ${res.code}): ${res.stderr.trim()}`);
		}
		// (b) overlap with another lane? Use the lane's OWN changes (merge-base..lane), not the
		// symmetric diff, so a lane that fell behind base doesn't drag in base's own files.
		const mbRes = await git(["merge-base", base, lane.branch], { cwd });
		const mb = mbRes.ok ? mbRes.stdout.trim() : base;
		const changed = (await git(["diff", "--name-only", `${mb}..${lane.branch}`], { cwd })).stdout
			.split("\n")
			.map(l => l.trim())
			.filter(Boolean);
		for (const f of changed) {
			const prev = touched.get(f);
			if (prev) conflicts.push(`${lane.branch} overlaps ${prev} on: ${f}`);
			else touched.set(f, lane.branch);
		}
	}
	return conflicts;
}

function composeMessage(turn: string, lanes: Lane[], override?: string): string {
	if (override) return override;
	const breakdown = lanes.map(l => `  - ${l.branch}: ${l.subject}`).join("\n");
	return `feat(graphtree): merge ${turn} lanes (${lanes.map(l => l.suffix).join(", ")})

Squashed from parallel worktree lanes once they agreed:
${breakdown}

Generated by scripts/graphtree-merge.ts`;
}

interface Opts {
	turn: string;
	base: string;
	remote: string;
	lanes?: string[];
	message?: string;
	apply: boolean;
	push: boolean;
	keepWorktrees: boolean;
	keepBranches: boolean;
	force: boolean;
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		options: {
			base: { type: "string", default: "main" },
			remote: { type: "string" },
			lanes: { type: "string" },
			message: { type: "string" },
			apply: { type: "boolean", default: false },
			push: { type: "boolean", default: false },
			"keep-worktrees": { type: "boolean", default: false },
			"keep-branches": { type: "boolean", default: false },
			force: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	if (values.help) {
		console.log(HELP);
		return;
	}
	if (positionals.length === 0) fail('missing <turn> argument (e.g. "parity"). See --help.');

	const cwd = process.cwd();
	const top = (await git(["rev-parse", "--show-toplevel"], { cwd })).stdout.trim();
	const base = values.base as string;
	const turn = positionals[0] as string;

	// Default remote: base's upstream, else origin.
	let remote = values.remote as string | undefined;
	if (!remote) {
		const up = await upstream(base, top);
		remote = up?.split("/")[0] ?? "origin";
	}

	const opts: Opts = {
		turn,
		base,
		remote,
		lanes: values.lanes
			? (values.lanes as string)
					.split(",")
					.map(s => s.trim())
					.filter(Boolean)
			: undefined,
		message: values.message as string | undefined,
		apply: (values.apply as boolean) || (values.push as boolean), // --push implies --apply
		push: values.push as boolean,
		keepWorktrees: values["keep-worktrees"] as boolean,
		keepBranches: values["keep-branches"] as boolean,
		force: values.force as boolean,
	};

	const lanes = await discoverLanes(turn, base, top, opts.lanes);

	// --- Agreement gate ---
	const violations: string[] = [];
	for (const lane of lanes) {
		if (!lane.worktree) violations.push(`${lane.branch}: no worktree checked out (lane was not fanned out)`);
		else if (lane.dirty)
			violations.push(`${lane.branch}: uncommitted changes in ${lane.worktree} — commit before merging`);
		if (lane.ahead === 0) violations.push(`${lane.branch}: 0 commits ahead of ${base} (no work to merge)`);
	}

	// Base must be checked out somewhere and clean.
	const baseWts = (await worktrees(top)).filter(w => w.branch === base);
	const baseWt = baseWts[0]?.path;
	if (!baseWt) {
		violations.push(`${base}: not checked out in any worktree (cannot merge into it)`);
	} else {
		const baseDirty = (await git(["status", "--porcelain"], { cwd: baseWt })).stdout;
		if (baseDirty) violations.push(`${base}: worktree ${baseWt} is dirty (commit or stash first)`);
	}

	const conflicts = await mergeCheck(base, lanes, top);
	for (const c of conflicts) violations.push(c);

	const agree = violations.length === 0;

	// --- Plan (always printed) ---
	console.log(`turn:    ${turn}`);
	console.log(`base:    ${base}  (worktree: ${baseWt ?? "<none>"})`);
	console.log(`remote:  ${opts.remote}${opts.push ? "  [will push]" : ""}`);
	console.log(`lanes:   ${lanes.length}`);
	for (const lane of lanes) {
		const flags = [`${lane.ahead} ahead`, lane.dirty ? "DIRTY" : "clean", lane.worktree ?? "no-worktree"].join(", ");
		console.log(`  ${lane.branch.padEnd(34)} ${flags}\n    ↳ ${lane.subject}`);
	}
	console.log(`agree:   ${agree ? "yes" : "NO"}`);
	if (!agree) {
		console.log("\nlane disagreements:");
		for (const v of violations) console.log(`  - ${v}`);
		console.log(`\nplan:    REFUSED (lanes do not agree)${opts.apply ? " — fix the above before --apply" : ""}`);
		process.exit(1);
	}

	const message = composeMessage(turn, lanes, opts.message);
	console.log("\ncommit message:");
	console.log(
		message
			.split("\n")
			.map(l => `  ${l}`)
			.join("\n"),
	);
	if (!opts.keepWorktrees || !opts.keepBranches) {
		console.log("\ncleanup:");
		if (!opts.keepWorktrees) for (const lane of lanes) console.log(`  worktree remove ${lane.worktree}`);
		if (!opts.keepBranches) for (const lane of lanes) console.log(`  branch -D ${lane.branch}`);
	}

	if (!opts.apply) {
		console.log("\nplan:    dry-run (no changes). Pass --apply to merge + cleanup, --push to also push.");
		return;
	}

	// --- Apply: squash every lane into ONE commit on base, then cleanup ---
	if (!baseWt) fail("internal: base worktree vanished");
	const origHead = (await git(["rev-parse", "HEAD"], { cwd: baseWt })).stdout.trim();

	console.log("\nmerging...");
	// Sequential `git merge --squash` accumulates each (disjoint) lane's changes into the
	// index without moving HEAD; a single `git commit` then produces one linear commit.
	for (const lane of lanes) {
		const res = await git(["merge", "--squash", lane.branch], { cwd: baseWt });
		if (!res.ok) {
			await git(["merge", "--abort"], { cwd: baseWt }).catch(() => {});
			await git(["reset", "--hard", origHead], { cwd: baseWt });
			fail(`squash-merge of ${lane.branch} conflicted — rolled back ${base} to ${origHead.slice(0, 10)}`);
		}
	}
	const commit = await git(["commit", "-F", "-"], { cwd: baseWt, stdin: message });
	if (!commit.ok) {
		await git(["reset", "--hard", origHead], { cwd: baseWt });
		fail(`commit failed — rolled back ${base}: ${commit.stderr.trim()}`);
	}
	const newSha = (await git(["rev-parse", "HEAD"], { cwd: baseWt })).stdout.trim();
	console.log(`committed: ${newSha.slice(0, 10)}  (single commit on ${base})`);

	if (opts.push) {
		const pushRes = await git(["push", opts.remote, base], { cwd: baseWt });
		if (!pushRes.ok) fail(`push to ${opts.remote}/${base} failed: ${pushRes.stderr.trim()}`);
		console.log(`pushed:    ${opts.remote}/${base}`);
	}

	if (!opts.keepWorktrees) {
		for (const lane of lanes) {
			if (!lane.worktree) continue;
			const rm = await git(["worktree", "remove", ...(opts.force ? ["--force"] : []), lane.worktree], { cwd: top });
			if (!rm.ok) console.warn(`warn: could not remove worktree ${lane.worktree}: ${rm.stderr.trim()}`);
			else console.log(`removed worktree: ${lane.worktree}`);
		}
	}
	if (!opts.keepBranches) {
		for (const lane of lanes) {
			const br = await git(["branch", "-D", lane.branch], { cwd: top });
			if (!br.ok) console.warn(`warn: could not delete branch ${lane.branch}: ${br.stderr.trim()}`);
			else console.log(`deleted branch: ${lane.branch}`);
		}
	}

	console.log(`\ndone: turn "${turn}" merged into ${base} as one commit.`);
}

await main();
