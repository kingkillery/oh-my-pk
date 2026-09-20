import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { OperationalStore } from "../../src/operational/store";
import { createSpawnPlan } from "../../src/task/spawn-plan";
import { captureBaseline, captureDeltaPatch } from "../../src/task/worktree";

async function runGit(repo: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

describe("Phase0 entrypaths — baseline routes", () => {
	it("keeps new-run defaults off/legacy and plans without allocation", () => {
		const settings = Settings.isolated({});
		expect(settings.get("task.lifecycle.enabled")).toBe(false);
		expect(settings.get("task.topology")).toBe("legacy");

		let allocated = false;
		const result = createSpawnPlan({
			correlationId: "phase0-entrypaths-1",
			agentName: "phase0-probe",
			assignment: "Prove allocation-free planning",
			eligible: [{ selector: "test-light", tier: "light", maxRequests: 2, maxRuntimeMs: 5000 }],
			onAllocateId: () => {
				allocated = true;
			},
			onAllocateJob: () => {
				allocated = true;
			},
			onAllocateWorktree: () => {
				allocated = true;
			},
			onAllocateSession: () => {
				allocated = true;
			},
		});
		expect(result.ok).toBe(true);
		expect(allocated).toBe(false);
	});

	it("drives a durable job from queue to terminal with checkpoint resume", () => {
		const dbPath = path.join(
			os.tmpdir(),
			`phase0-entrypaths-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
		);
		const store = OperationalStore.open({ dbPath });
		try {
			const created = store.createJob({ type: "phase0-probe", payload: { step: 1 } });
			expect(created.status).toBe("queued");

			const claimed = store.claimJobById(created.id, "phase0-owner", 60_000);
			expect(claimed?.status).toBe("running");
			expect(claimed?.id).toBe(created.id);

			const checkpoint = store.setCheckpoint(created.id, { progress: "half" });
			expect(checkpoint.jobId).toBe(created.id);

			const reread = store.getCheckpoint(created.id);
			expect(reread?.data).toEqual({ progress: "half" });

			const done = store.transitionJob(created.id, { to: "completed", leaseOwner: "phase0-owner" });
			expect(done.status).toBe("completed");

			let invalidFailed = false;
			try {
				store.transitionJob(created.id, { to: "running", leaseOwner: "phase0-owner" });
			} catch {
				invalidFailed = true;
			}
			expect(invalidFailed).toBe(true);
		} finally {
			store.close();
		}

		const reopened = OperationalStore.open({ dbPath });
		try {
			const jobs = reopened.listJobs({ type: "phase0-probe" });
			expect(jobs.length).toBe(1);
			expect(jobs[0]?.status).toBe("completed");
			expect(reopened.getCheckpoint(jobs[0]?.id ?? "")?.data).toEqual({ progress: "half" });
		} finally {
			reopened.close();
		}
	});

	it("captures a real git baseline and delta patch", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "phase0-entrypaths-repo-"));
		try {
			await runGit(repo, ["init"]);
			await runGit(repo, ["config", "user.email", "phase0@example.com"]);
			await runGit(repo, ["config", "user.name", "Phase0"]);
			await fs.writeFile(path.join(repo, "base.txt"), "base\n");
			await runGit(repo, ["add", "."]);
			await runGit(repo, ["commit", "-m", "base"]);

			const baseline = await captureBaseline(repo);
			await fs.writeFile(path.join(repo, "base.txt"), "base changed\n");
			await fs.writeFile(path.join(repo, "new-untracked.txt"), "new\n");

			const delta = await captureDeltaPatch(repo, baseline);
			expect(delta.rootTouchedFiles.includes("base.txt")).toBe(true);
			expect(delta.rootPatch.includes("base changed")).toBe(true);
		} finally {
			await fs.rm(repo, { recursive: true, force: true });
		}
	});
});
