import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CompletionPilotInput, runCompletionPilot } from "../../src/orchestration/completion-pilot";

const paths: string[] = [];
afterAll(async () => {
	for (const path of paths) await rm(path, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const p = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Pilot",
			GIT_AUTHOR_EMAIL: "pilot@example.invalid",
			GIT_COMMITTER_NAME: "Pilot",
			GIT_COMMITTER_EMAIL: "pilot@example.invalid",
		},
	});
	const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	if (code !== 0) throw new Error(err);
	return out.trim();
}

async function fixture(): Promise<CompletionPilotInput> {
	const cwd = await mkdtemp(join(tmpdir(), "ompk-pilot-"));
	paths.push(cwd);
	await git(cwd, "init");
	await Bun.write(join(cwd, "artifact.txt"), "verified artifact\n");
	await git(cwd, "add", "artifact.txt");
	await git(cwd, "commit", "-m", "fixture");
	const revision = await git(cwd, "rev-parse", "HEAD");
	const sha256 = new Bun.CryptoHasher("sha256").update("verified artifact\n").digest("hex");
	return {
		cwd,
		revision,
		contract: {
			objective: "deliver",
			completionCriteria: [
				{ id: "test", description: "test passes" },
				{ id: "artifact", description: "artifact checked" },
			],
			deliverables: ["artifact"],
			nonSolutions: [],
			knownFailureModes: [],
		},
		checks: [
			{ criterionId: "test", kind: "test", command: [process.execPath, "-e", "process.exit(0)"] },
			{ criterionId: "artifact", kind: "artifact", path: "artifact.txt", sha256, deliverable: "artifact" },
		],
	};
}

describe("opt-in completion pilot", () => {
	it("runs through the explicit pilot entry point and produces a versioned result", async () => {
		const input = await fixture();
		const manifestDir = await mkdtemp(join(tmpdir(), "ompk-manifest-"));
		paths.push(manifestDir);
		const manifest = join(manifestDir, "pilot.json");
		await Bun.write(manifest, JSON.stringify(input));
		const cli = join(import.meta.dir, "../../src/orchestration/completion-pilot-cli.ts");
		const child = Bun.spawn([process.execPath, cli, manifest], { stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(err).toBe("");
		expect(code).toBe(0);
		expect(JSON.parse(out).version).toBe("ompk.completion-pilot/v2");
		expect(JSON.parse(out).evaluation.outcome).toBe("pass");
	}, 30_000);
	it("checks each criterion and artifact against a clean exact revision", async () => {
		const input = await fixture();
		const result = await runCompletionPilot(input);
		expect(result.revision).toBe(input.revision);
		expect(result.checks.map(c => c.status)).toEqual(["pass", "pass"]);
		expect(result.evaluation.outcome).toBe("pass");
	}, 30_000);
	it("does not reuse checks for a different or dirty revision", async () => {
		const input = await fixture();
		expect((await runCompletionPilot({ ...input, revision: "0".repeat(40) })).evaluation.outcome).toBe("recoverable");
		await Bun.write(join(input.cwd, "artifact.txt"), "changed");
		expect((await runCompletionPilot(input)).checks.every(c => c.status === "unproven")).toBe(true);
	}, 30_000);
	it("requires each deliverable and keeps unresolved blockers blocked", async () => {
		const input = await fixture();
		const missing = { ...input, contract: { ...input.contract, deliverables: ["artifact", "second"] } };
		expect((await runCompletionPilot(missing)).evaluation.outcome).toBe("recoverable");
		expect((await runCompletionPilot({ ...input, unresolvedBlockers: ["access required"] })).evaluation.outcome).toBe(
			"blocked",
		);
	}, 30_000);
	it("rejects mismatched artifact evidence and failing tests", async () => {
		const input = await fixture();
		const checks: CompletionPilotInput["checks"] = [
			{ criterionId: "test", kind: "test", command: [process.execPath, "-e", "process.exit(1)"] },
			{
				criterionId: "artifact",
				kind: "artifact",
				path: "artifact.txt",
				sha256: "0".repeat(64),
				deliverable: "artifact",
			},
		];
		const result = await runCompletionPilot({ ...input, checks });
		expect(result.checks.map(c => c.status)).toEqual(["fail", "fail"]);
		expect(result.evaluation.outcome).toBe("recoverable");
	}, 30_000);
	it("invalidates earlier results when a check changes the candidate", async () => {
		const input = await fixture();
		const checks: CompletionPilotInput["checks"] = [
			...input.checks,
			{
				criterionId: "test",
				kind: "test",
				command: [process.execPath, "-e", "require('fs').writeFileSync('artifact.txt', 'changed')"],
			},
		];
		const result = await runCompletionPilot({ ...input, checks });
		expect(result.checks.every(c => c.status === "unproven")).toBe(true);
		expect(result.evaluation.outcome).toBe("recoverable");
	}, 30_000);
});
