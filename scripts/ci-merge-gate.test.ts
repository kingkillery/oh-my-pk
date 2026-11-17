// The merge-facing CI status is the job display name `check`, not the lint job
// id. A native/unit failure or skip must make that status fail without
// rerunning tests or pulling natives into the lint job.

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { YAML } from "bun";

const WORKFLOW_PATH = path.resolve(import.meta.dir, "..", ".github", "workflows", "ci.yml");

type Job = {
	name?: string;
	needs?: string | string[];
	if?: string;
	steps?: Array<{ name?: string; uses?: string; run?: string }>;
};

type Workflow = {
	jobs: Record<string, Job>;
};

const workflow = YAML.parse(await Bun.file(WORKFLOW_PATH).text()) as Workflow;

function needsOf(job: Job): string[] {
	if (job.needs === undefined) return [];
	return Array.isArray(job.needs) ? job.needs : [job.needs];
}

describe("ci.yml merge gate", () => {
	const jobs = workflow.jobs;
	const namedCheck = Object.entries(jobs).filter(([, job]) => job.name === "check");

	it("parses and exposes exactly one job displayed as check", () => {
		expect(namedCheck.map(([id]) => id)).toEqual(["gate"]);
	});

	it("requires the native-free lint job and coding-agent native/unit", () => {
		const gate = jobs.gate;
		expect(gate).toBeDefined();
		expect(needsOf(gate!)).toEqual(["check", "test_coding_agent_native"]);
		expect(gate!.if).toContain("always()");
		expect(gate!.if).toContain("!cancelled()");
		expect(gate!.steps?.map((step) => step.name)).toEqual(["Require lint and coding-agent native/unit"]);
		const script = gate!.steps?.[0]?.run ?? "";
		expect(script).toContain('test "$lint" = "success"');
		expect(script).toContain('test "$native" = "success"');
		expect(script).not.toContain("bun ");
		expect(script).not.toContain("download-artifact");
	});

	it("keeps the lint job native-free and release gated on both successes", () => {
		const lint = jobs.check;
		expect(lint?.name).toBe("Lint, type check & web build");
		expect(needsOf(lint!)).toEqual([]);
		const uses = (lint?.steps ?? []).map((step) => step.uses ?? "");
		expect(uses.some((use) => use.includes("download-artifact"))).toBe(false);
		expect(uses.some((use) => use.includes("natives"))).toBe(false);

		const release = jobs.release_binary;
		expect(release?.if).toContain("needs.test_coding_agent_native.result == 'success'");
		expect(release?.if).toContain("needs.check.result == 'success'");
		expect(needsOf(release!)).toContain("check");
		expect(needsOf(release!)).toContain("test_coding_agent_native");
	});

	it("fails the gate script unless lint and native/unit both succeeded", () => {
		const script = jobs.gate?.steps?.[0]?.run ?? "";
		const cases: Array<[string, string, boolean]> = [
			["success", "success", true],
			["success", "failure", false],
			["success", "skipped", false],
			["success", "cancelled", false],
			["failure", "success", false],
			["skipped", "success", false],
			["cancelled", "success", false],
			["failure", "skipped", false],
		];
		for (const [lint, native, accepted] of cases) {
			const body = script
				.replace("${{ needs.check.result }}", lint)
				.replace("${{ needs.test_coding_agent_native.result }}", native);
			const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-s"], { stdin: Buffer.from(body) });
			expect(result.exitCode === 0).toBe(accepted);
		}
	});
});
