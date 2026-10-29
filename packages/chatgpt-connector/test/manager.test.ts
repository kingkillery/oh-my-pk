/**
 * TaskManager lifecycle tests against a scripted FakeRunner: launch → settle,
 * queue/concurrency, wall-clock timeout, cancel, follow-up, idle disposal,
 * eviction, and the abort-grace fallback for runners that ignore the signal.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isConnectorError } from "../src/errors";
import { TaskManager } from "../src/tasks/manager";
import type { SessionRunner } from "../src/types";
import { FakeRunner, testConfig, waitUntil } from "./helpers";

const managers: TaskManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.shutdown();
});

function makeManager(runner: SessionRunner, configOverrides?: Parameters<typeof testConfig>[0]) {
	const config = testConfig(configOverrides ?? {});
	const manager = new TaskManager({ config, createRunner: () => runner });
	managers.push(manager);
	return { manager, config };
}

describe("launch and settle", () => {
	test("completes a run and stores the result", async () => {
		const runner = new FakeRunner();
		const { manager } = makeManager(runner);
		const { task, settled } = await manager.launch({ prompt: "ship it", waitSeconds: 0 });
		expect(settled).toBe(false);
		expect(task.state).toBe("running");
		await waitUntil(() => manager.status(task.id)?.state === "completed");
		const record = manager.result(task.id);
		expect(record?.result?.text).toContain("ship it");
		expect(record?.result?.usage?.totalTokens).toBe(3);
	});

	test("rejects an unknown workspace", async () => {
		const { manager } = makeManager(new FakeRunner());
		try {
			await manager.launch({ prompt: "x", workspace: "nope" });
			expect.unreachable();
		} catch (error) {
			expect(isConnectorError(error) && error.code).toBe("unknown_workspace");
		}
	});

	test("rejects an empty prompt", async () => {
		const { manager } = makeManager(new FakeRunner());
		try {
			await manager.launch({ prompt: "   " });
			expect.unreachable();
		} catch (error) {
			expect(isConnectorError(error) && error.code).toBe("invalid_request");
		}
	});

	test("waitFor resolves on settle and times out politely", async () => {
		const runner = new FakeRunner();
		runner.steps = [{ delayMs: 200 }];
		const { manager } = makeManager(runner);
		const { task } = await manager.launch({ prompt: "slow", waitSeconds: 0 });
		const early = await manager.waitFor(task.id, 30);
		expect(early?.state).toBe("running");
		const later = await manager.waitFor(task.id, 2000);
		expect(later?.state).toBe("completed");
	});

	test("waitFor on unknown task resolves undefined", async () => {
		const { manager } = makeManager(new FakeRunner());
		expect(await manager.waitFor("task_nope", 10)).toBeUndefined();
	});
});

describe("concurrency and queueing", () => {
	test("second launch queues behind maxConcurrentTasks=1", async () => {
		const runner = new FakeRunner();
		// First run hangs until abort; second resolves immediately.
		runner.steps = [{ hang: true }, {}];
		const { manager } = makeManager(runner, { limits: { maxConcurrentTasks: 1 } });
		const first = await manager.launch({ prompt: "one", waitSeconds: 0 });
		const second = await manager.launch({ prompt: "two", waitSeconds: 0 });
		expect(second.task.state).toBe("queued");
		await manager.cancel(first.task.id);
		await waitUntil(() => manager.status(second.task.id)?.state === "completed", 3000);
	});
});

describe("timeout and cancel", () => {
	test("wall-clock timeout transitions to timed_out", async () => {
		const runner = new FakeRunner();
		runner.steps = [{ hang: true }];
		const { manager } = makeManager(runner, { limits: { taskTimeoutMs: 100 } });
		const { task } = await manager.launch({ prompt: "slow", waitSeconds: 0 });
		await waitUntil(() => manager.status(task.id)?.state === "timed_out", 3000);
	});

	test("a runner that ignores abort is force-finalized by the grace timer", async () => {
		const runner = new FakeRunner();
		runner.steps = [{ ignoreAbort: true }];
		const { manager } = makeManager(runner, { limits: { taskTimeoutMs: 80, abortGraceMs: 150 } });
		const { task } = await manager.launch({ prompt: "stuck", waitSeconds: 0 });
		// timeout (80ms) + grace (150ms) → forced settle ≈ 250ms
		await waitUntil(() => manager.status(task.id)?.state === "timed_out", 4000);
		const record = manager.record(task.id);
		expect(record?.events.some(event => event.type === "finalize_forced")).toBe(true);
	});

	test("cancel on a running task aborts the runner", async () => {
		const runner = new FakeRunner();
		runner.steps = [{ hang: true }];
		const { manager } = makeManager(runner);
		const { task } = await manager.launch({ prompt: "work", waitSeconds: 0 });
		const summary = await manager.cancel(task.id, "user asked");
		// cancel() returns the summary at interrupt time; settle is async.
		expect(summary?.state).toBe("running");
		await waitUntil(() => manager.status(task.id)?.state === "cancelled");
	});

	test("cancel on a queued task never starts it", async () => {
		const runner = new FakeRunner();
		runner.steps = [{ hang: true }, {}];
		const { manager } = makeManager(runner, { limits: { maxConcurrentTasks: 1 } });
		const first = await manager.launch({ prompt: "one", waitSeconds: 0 });
		const second = await manager.launch({ prompt: "two", waitSeconds: 0 });
		expect(second.task.state).toBe("queued");
		await manager.cancel(second.task.id);
		expect(manager.status(second.task.id)?.state).toBe("cancelled");
		await manager.cancel(first.task.id);
	});

	test("cancel on a settled task is a no-op returning its state", async () => {
		const runner = new FakeRunner();
		const { manager } = makeManager(runner);
		const { task } = await manager.launch({ prompt: "quick", waitSeconds: 0 });
		await waitUntil(() => manager.status(task.id)?.state === "completed");
		const summary = await manager.cancel(task.id);
		expect(summary?.state).toBe("completed");
	});
});

describe("follow-up and lifecycle", () => {
	test("follow_up continues the settled task on the same runner", async () => {
		const runner = new FakeRunner();
		runner.steps = [{ outcome: { text: "first answer" } }, { outcome: { text: "second answer" } }];
		const { manager } = makeManager(runner);
		const { task } = await manager.launch({ prompt: "first", waitSeconds: 0 });
		await waitUntil(() => manager.status(task.id)?.state === "completed");
		const follow = await manager.followup(task.id, "now do more", 0);
		expect(follow).toBeDefined();
		await waitUntil(() => manager.record(task.id)?.turns === 2, 3000);
		await waitUntil(() => manager.status(task.id)?.state === "completed");
		expect(manager.record(task.id)?.result?.text).toContain("second answer");
	});

	test("followup on unknown task is undefined; on a running task it is task_busy", async () => {
		const runner = new FakeRunner();
		runner.steps = [{ hang: true }];
		const { manager } = makeManager(runner);
		expect(await manager.followup("task_nope", "x", 0)).toBeUndefined();
		const { task } = await manager.launch({ prompt: "busy", waitSeconds: 0 });
		try {
			await manager.followup(task.id, "x", 0);
			expect.unreachable();
		} catch (error) {
			expect(isConnectorError(error) && error.code).toBe("task_busy");
		}
		await manager.cancel(task.id);
	});

	test("idle settled runner is disposed after idleTtlMs", async () => {
		const runner = new FakeRunner();
		const { manager } = makeManager(runner, { limits: { idleTtlMs: 80 } });
		const { task } = await manager.launch({ prompt: "x", waitSeconds: 0 });
		await waitUntil(() => manager.status(task.id)?.state === "completed");
		await waitUntil(() => runner.disposed === 1, 2000);
		// A follow-up after disposal must rebuild the runner.
		runner.steps = [{}];
		const follow = await manager.followup(task.id, "again", 0);
		expect(follow).toBeDefined();
	});

	test("evicting old settled tasks under maxTasks drops the oldest", async () => {
		const runner = new FakeRunner();
		const { manager } = makeManager(runner, { limits: { maxTasks: 2 } });
		const first = await manager.launch({ prompt: "a", waitSeconds: 0 });
		const second = await manager.launch({ prompt: "b", waitSeconds: 0 });
		await waitUntil(() => [first.task.id, second.task.id].every(id => manager.status(id)?.state === "completed"));
		// Third launch overflows capacity; the oldest settled record is evicted.
		await manager.launch({ prompt: "c", waitSeconds: 0 });
		await waitUntil(() => manager.list().every(task => task.state === "completed"), 3000);
		expect(manager.status(first.task.id)).toBeUndefined();
		expect(manager.list().length).toBeLessThanOrEqual(2);
	});
});

describe("shutdown", () => {
	test("rejects new launches after shutdown", async () => {
		const { manager } = makeManager(new FakeRunner());
		await manager.shutdown();
		try {
			await manager.launch({ prompt: "x" });
			expect.unreachable();
		} catch (error) {
			expect(isConnectorError(error) && error.code).toBe("internal_error");
		}
	});
});
