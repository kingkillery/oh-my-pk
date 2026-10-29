import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession } from "../../src/session/agent-session";
import { createSubagentRunMonitor } from "../../src/task/executor";
import { arbitrateHealth } from "../../src/watchdog/arbitrator";
import { createWatchdogCaseCollector } from "../../src/watchdog/case-collector";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function folder() {
	const dir = await mkdtemp(path.join(tmpdir(), "ompk-case-test-"));
	dirs.push(dir);
	return dir;
}

describe("watchdog opt-in case collection", () => {
	test("is off without an absolute directory", () => {
		expect(createWatchdogCaseCollector(undefined)).toBeUndefined();
		expect(createWatchdogCaseCollector("relative")).toBeUndefined();
	});
	test("records actual evaluated actions, policy and linked terminal status without credentials", async () => {
		const dir = await folder();
		const collector = createWatchdogCaseCollector(dir)!;
		const config = { apiKey: "secret-sentinel", hintSeverityThreshold: 1.6 };
		for (const severity of [0.1, 1.7, 2.8]) {
			const evaluation = {
				stallSeverity: severity,
				isThrashing: 0.1,
				blockerType: "none",
				confidence: 0.8,
				latencyMs: 12,
			};
			collector.decision(
				"Goal: test\nRecent Tool Actions: read [OK]",
				"2026-10-01T00:00:00.000Z",
				evaluation,
				arbitrateHealth(evaluation, config),
				config,
				"requested",
			);
		}
		collector.outcome({ exitCode: 0, aborted: false, isError: false });
		await collector.flush();
		const names = await readdir(dir);
		expect(names).toHaveLength(1);
		const text = await readFile(path.join(dir, names[0]!), "utf8");
		expect(text).not.toContain("secret-sentinel");
		const rows = text
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(rows.map(row => row.action ?? row.kind)).toEqual(["pass", "inject_hint", "tripwire_abort", "run_outcome"]);
		expect(new Set(rows.map(row => row.groupId)).size).toBe(1);
		expect(new Set(rows.slice(0, 3).map(row => row.caseId)).size).toBe(3);
		expect(rows[1].policy.hintSeverityThreshold).toBe(1.6);
		expect(rows[0].state).toContain("Goal: test");
		expect(rows[3].note).toContain("unknown");
	});
	test("bounds capture and does not throw on a missing directory", async () => {
		const dir = await folder();
		const collector = createWatchdogCaseCollector(dir)!;
		for (let i = 0; i < 105; i++)
			collector.decision(
				"x".repeat(8193),
				new Date().toISOString(),
				undefined,
				undefined,
				undefined,
				"evaluation_unavailable",
			);
		collector.outcome({ exitCode: 1, aborted: true, isError: false });
		await collector.flush();
		const rows = (await readFile(path.join(dir, (await readdir(dir))[0]!), "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(rows).toHaveLength(101);
		expect(rows[0].state).toBeNull();
		expect(rows[0].stateOmitted).toBe("too_long");
		const broken = createWatchdogCaseCollector(path.join(dir, "missing"))!;
		broken.decision("x", new Date().toISOString(), undefined, undefined, undefined, "evaluation_unavailable");
		await expect(broken.flush()).resolves.toBeUndefined();
	});
	test("monitor captures an actual watchdog evaluation and linked outcome", async () => {
		const dir = await folder();
		const previous = process.env.OMP_WATCHDOG_CASE_DIR;
		process.env.OMP_WATCHDOG_CASE_DIR = dir;
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				answers: {
					is_thrashing: { noul: 0.95 },
					stall_severity: { score: 2.8, confidence: 0.9 },
					blocker_type: { choice: "command_failure_loop" },
				},
			}),
		);
		const monitor = createSubagentRunMonitor({
			index: 0,
			id: "test",
			agent: { name: "test", description: "test", systemPrompt: "test", source: "bundled" },
			task: "public task",
			softRequestBudget: 0,
			maxRuntimeMs: 0,
			watchdogConfig: { baseUrl: "http://localhost.invalid", apiKey: "sentinel" },
		});
		if (previous === undefined) delete process.env.OMP_WATCHDOG_CASE_DIR;
		else process.env.OMP_WATCHDOG_CASE_DIR = previous;
		const { promise: aborted, resolve } = Promise.withResolvers<void>();
		let listener: (event: unknown) => void = () => {};
		const session = {
			subscribe(fn: (event: unknown) => void) {
				listener = fn;
				return () => {};
			},
			abort() {
				resolve();
				return Promise.resolve();
			},
			agent: { steer() {} },
		} as unknown as AgentSession;
		monitor.attach(session);
		monitor.setActiveSession(session);
		try {
			for (let i = 0; i < 2; i++) {
				listener({ type: "tool_execution_start", toolName: "bash", toolArgs: { command: "demo" } });
				listener({
					type: "tool_execution_end",
					toolName: "bash",
					args: { command: "demo" },
					isError: true,
					result: "failed",
				});
			}
			await aborted;
			monitor.finish();
			monitor.recordWatchdogOutcome({ exitCode: 1, aborted: true, isError: false });
			let rows: Array<Record<string, unknown>> = [];
			for (let i = 0; i < 100; i++) {
				const names = await readdir(dir);
				if (names.length) {
					const content = await readFile(path.join(dir, names[0]!), "utf8");
					try {
						rows = content
							.trim()
							.split("\n")
							.filter(Boolean)
							.map(line => JSON.parse(line));
					} catch {
						/* partial write */
					}
					if (rows.length === 2) break;
				}
				await Bun.sleep(10);
			}
			expect(rows).toHaveLength(2);
			expect(rows[0]!.action).toBe("tripwire_abort");
			expect(rows[0]!.state).toContain("public task");
			expect(rows[1]!.groupId).toBe(rows[0]!.groupId);
		} finally {
			monitor.finish();
			fetchSpy.mockRestore();
		}
	});
});
