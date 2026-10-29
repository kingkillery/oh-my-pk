/** Opt-in local v2 pilot. The caller owns the criterion definitions and commands. */
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { type CompletionGateEvaluation, evaluateCompletionGate } from "./completion-gate";
import type { ActiveTaskContractSnapshot } from "./task-contract";

export type PilotCheck =
	| { readonly criterionId: string; readonly kind: "test"; readonly command: readonly string[] }
	| {
			readonly criterionId: string;
			readonly kind: "artifact";
			readonly path: string;
			readonly sha256: string;
			readonly deliverable?: string;
	  };

export interface CompletionPilotInput {
	readonly contract: ActiveTaskContractSnapshot;
	readonly cwd: string;
	/** Full commit ID for a clean candidate; dirty trees are not accepted. */
	readonly revision: string;
	readonly checks: readonly PilotCheck[];
	readonly unresolvedBlockers?: readonly string[];
	readonly timeoutMs?: number;
}

export interface CompletionPilotResult {
	readonly version: "ompk.completion-pilot/v2";
	readonly revision: string;
	readonly contract: ActiveTaskContractSnapshot;
	readonly workspace: string;
	readonly observedAt: string;
	readonly checks: readonly {
		criterionId: string;
		check: PilotCheck;
		status: "pass" | "fail" | "unproven";
		detail: string;
	}[];
	readonly evaluation: CompletionGateEvaluation;
}

async function run(
	command: readonly string[],
	cwd: string,
	timeoutMs: number,
): Promise<{ code: number; output: string }> {
	const process = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => process.kill(), timeoutMs);
	try {
		const [output, , code] = await Promise.all([
			new Response(process.stdout).text(),
			new Response(process.stderr).text(),
			process.exited,
		]);
		return { code, output: output.trim() };
	} finally {
		clearTimeout(timer);
	}
}

async function candidateMatches(cwd: string, revision: string, timeoutMs: number): Promise<boolean> {
	if (!/^[0-9a-f]{40}$/.test(revision)) return false;
	try {
		const head = await run(["git", "rev-parse", "--verify", "HEAD"], cwd, timeoutMs);
		const status = await run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd, timeoutMs);
		return head.code === 0 && head.output === revision && status.code === 0 && status.output === "";
	} catch {
		return false;
	}
}

/** Runs explicit checks against a clean commit and invalidates results if it changes. */
export async function runCompletionPilot(input: CompletionPilotInput): Promise<CompletionPilotResult> {
	const timeoutMs = input.timeoutMs ?? 30_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("Invalid pilot timeout");
	const root = await realpath(input.cwd);
	const criteria = new Set(input.contract.completionCriteria.map(c => c.id));
	if (criteria.size !== input.contract.completionCriteria.length) throw new Error("Duplicate criterion ID");
	const checks = input.checks;
	for (const check of checks) {
		if (!criteria.has(check.criterionId)) throw new Error(`Unknown criterion: ${check.criterionId}`);
		if (check.kind === "test" && (check.command.length === 0 || check.command.some(s => !s.trim())))
			throw new Error("Invalid test command");
		if (
			check.kind === "artifact" &&
			(!/^[0-9a-f]{64}$/.test(check.sha256) ||
				(check.deliverable && !input.contract.deliverables.includes(check.deliverable)))
		)
			throw new Error("Invalid artifact check");
	}
	const initial = await candidateMatches(root, input.revision, timeoutMs);
	const results: { criterionId: string; check: PilotCheck; status: "pass" | "fail" | "unproven"; detail: string }[] =
		[];
	const present = new Set<string>();
	for (const check of checks) {
		let status: "pass" | "fail" | "unproven" = "unproven";
		let detail = "Candidate revision is unavailable or dirty";
		if (initial) {
			try {
				if (check.kind === "test") {
					const result = await run(check.command, root, timeoutMs);
					status = result.code === 0 ? "pass" : "fail";
					detail = `Test exited ${result.code}`;
				} else {
					const path = await realpath(resolve(root, check.path));
					const rel = relative(root, path);
					if (
						!rel ||
						rel === ".." ||
						rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
						isAbsolute(rel)
					)
						throw new Error("Artifact outside candidate");
					const tracked = await run(["git", "ls-files", "--error-unmatch", "--", rel], root, timeoutMs);
					if (tracked.code !== 0) throw new Error("Artifact is not tracked");
					const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
					status = digest === check.sha256 ? "pass" : "fail";
					detail = status === "pass" ? "Artifact digest matched" : "Artifact digest mismatch";
					if (status === "pass" && check.deliverable) present.add(check.deliverable);
				}
			} catch {
				status = "unproven";
				detail = "Check could not be completed";
			}
		}
		results.push({ criterionId: check.criterionId, check, status, detail });
	}
	const final = initial && (await candidateMatches(root, input.revision, timeoutMs));
	if (!final) {
		present.clear();
		for (const result of results) {
			result.status = "unproven";
			result.detail = "Candidate changed or is unavailable";
		}
	}
	const evidence: Record<string, "pass" | "fail" | "unproven"> = {};
	for (const id of criteria) {
		const matching = results.filter(r => r.criterionId === id);
		evidence[id] = matching.some(r => r.status === "fail")
			? "fail"
			: matching.length > 0 && matching.every(r => r.status === "pass")
				? "pass"
				: "unproven";
	}
	const evaluation = evaluateCompletionGate({
		policyVersion: "v2",
		contract: input.contract,
		deliverablesPresent: [...present],
		criteriaEvidence: evidence,
		triggeredNonSolutions: [],
		requiredEvidencePresent: checks.length > 0 && final,
		unresolvedBlockers: [
			...(input.unresolvedBlockers ?? []),
			...(input.contract.nonSolutions.length > 0 ? ["Pilot cannot independently verify non-solutions"] : []),
		],
		scopeValid: true,
	});
	return {
		version: "ompk.completion-pilot/v2",
		revision: input.revision,
		contract: input.contract,
		workspace: root,
		observedAt: new Date().toISOString(),
		checks: results,
		evaluation,
	};
}
