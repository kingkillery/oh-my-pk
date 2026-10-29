/**
 * The engine's contract: queued → dispatching → running → idle, with
 * reconciliation, slot limits, per-host backoff and idempotent cancellation —
 * all against a fake connector, no network, no timers.
 */
import { describe, expect, test } from "bun:test";
import { Store } from "../src/db/store";
import { JobEngine } from "../src/jobs/engine";
import type { GatewayConfig } from "../src/types";
import { FakeHost } from "./fakes";

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
	return {
		publicUrl: "http://127.0.0.1:3880",
		listen: { host: "127.0.0.1", port: 3880 },
		hosts: [{ id: "h1", connectorUrl: "http://fake", maxConcurrentJobs: 2 }],
		workspaces: [{ alias: "repo", host: "h1", workspace: "repo", allowStart: true }],
		tokens: { accessTtlSeconds: 43200, refreshIdleTtlDays: 90 },
		watcher: { pollSeconds: 10, hostBackoffSeconds: 60 },
		limits: { taskChars: 20_000, jobsPerClient: 200, feedWindow: 500 },
		...overrides,
	};
}

function seed(store: Store, job: Parameters<Store["insertJob"]>[0]) {
	store.insertJob(job, { reason: "test" });
}

function engineFor(store: Store, fake: FakeHost, opts: { max?: number; now?: () => number } = {}) {
	return new JobEngine({
		store,
		config: config({ hosts: [{ id: "h1", connectorUrl: "http://fake", maxConcurrentJobs: opts.max ?? 2 }] }),
		hosts: [{ id: "h1", maxConcurrentJobs: opts.max ?? 2, client: fake }],
		now: opts.now,
	});
}

function job(
	id: string,
	host: string,
): {
	id: string;
	clientId: string;
	state: "queued";
	host: string;
	workspace: string;
	title: string;
	task: string;
	createdAt: number;
} {
	return {
		id,
		clientId: "client",
		state: "queued",
		host,
		workspace: "repo",
		title: `job ${id}`,
		task: "do the thing",
		createdAt: Date.now(),
	};
}

describe("job engine", () => {
	test("a queued job launches and settles to idle", async () => {
		const store = new Store(":memory:");
		const fake = new FakeHost();
		const engine = engineFor(store, fake);
		seed(store, job("job-aaaaaa", "h1"));

		await engine.tick();
		const running = store.getJob("job-aaaaaa")!;
		expect(running.state).toBe("running");
		expect(running.taskId).toBeDefined();
		const taskTitle = fake.tasks.get(running.taskId!)!.title;
		expect(taskTitle).toContain("[job:job-aaaaaa]");

		fake.settle(running.taskId!, "completed", "all done");
		await engine.tick();
		expect(store.getJob("job-aaaaaa")!.state).toBe("idle");
		store.close();
	});

	test("a second queued job waits while the host's slot is taken", async () => {
		const store = new Store(":memory:");
		const fake = new FakeHost();
		const engine = engineFor(store, fake, { max: 1 });
		seed(store, job("job-111111", "h1"));
		seed(store, job("job-222222", "h1"));

		await engine.tick();
		expect(store.getJob("job-111111")!.state).toBe("running");
		expect(store.getJob("job-222222")!.state).toBe("queued");

		const first = store.getJob("job-111111")!;
		fake.settle(first.taskId!, "completed");
		await engine.tick();
		// First settles to idle; the second now claims the slot on the next tick.
		expect(store.getJob("job-222222")!.state).toBe("running");
		store.close();
	});

	test("a lost launch answer reconciles by marker instead of relaunching", async () => {
		const store = new Store(":memory:");
		const fake = new FakeHost();
		const clock = { t: 1_000_000 };
		const engine = engineFor(store, fake, { now: () => clock.t });
		seed(store, job("job-marker1", "h1"));

		// The launch lands but the response never arrives.
		fake.launchesFail = "unknown";
		await engine.tick();
		expect(store.getJob("job-marker1")!.state).toBe("unknown");
		expect(fake.tasks.size).toBe(1);

		// The reconciler finds the marker and links the job instead of a second
		// launch — once backoff for the lost answer has expired.
		const launches = fake.calls.filter(c => c === "launch_task").length;
		clock.t += 120_000;
		await engine.tick();
		expect(store.getJob("job-marker1")!.state).toBe("running");
		expect(fake.calls.filter(c => c === "launch_task").length).toBe(launches);
		store.close();
	});

	test("a stale unknown job with no marker fails as launch_not_confirmed", async () => {
		const store = new Store(":memory:");
		const fake = new FakeHost();
		const engine = engineFor(store, fake);
		// An old job left `unknown` (a launch answer was lost, then restarts)
		// with no task carrying its marker anywhere on the host.
		seed(store, { ...job("job-ghost1", "h1"), state: "queued", createdAt: Date.now() - 300_000 });
		store.updateJob("job-ghost1", { state: "unknown" }, undefined);
		// Nothing on the host carries the marker.
		await engine.tick();
		const j = store.getJob("job-ghost1")!;
		expect(j.state).toBe("failed");
		expect(j.lastError?.code).toBe("launch_not_confirmed");
		store.close();
	});

	test("an unreachable host backs off and requeues without losing the job", async () => {
		const store = new Store(":memory:");
		const fake = new FakeHost();
		const engine = engineFor(store, fake);
		seed(store, job("job-backoff", "h1"));

		fake.launchesFail = "not_delivered";
		await engine.tick();
		expect(store.getJob("job-backoff")!.state).toBe("queued");
		expect(engine.hostUnreachableSince("h1")).toBeDefined();

		// While backing off, another tick is a no-op for this host.
		await engine.tick();
		expect(store.getJob("job-backoff")!.state).toBe("queued");
		expect(fake.calls.filter(c => c === "launch_task").length).toBe(1);

		// Time past the backoff window: the job launches.
		fake.unreachable = false;
		const later = engineFor(store, fake);
		// Force backoff expiry by rebuilding with no backoff state.
		await later.tick();
		expect(store.getJob("job-backoff")!.state).toBe("running");
		store.close();
	});

	test("a task the host forgets lands the job as failed task_lost", async () => {
		const store = new Store(":memory:");
		const fake = new FakeHost();
		const engine = engineFor(store, fake);
		seed(store, job("job-lost01", "h1"));
		await engine.tick();
		const running = store.getJob("job-lost01")!;
		fake.evict(running.taskId!);

		await engine.tick();
		const j = store.getJob("job-lost01")!;
		expect(j.state).toBe("failed");
		expect(j.lastError?.code).toBe("task_lost");
		store.close();
	});

	test("cancel interrupts a running job", async () => {
		const store = new Store(":memory:");
		const fake = new FakeHost();
		const engine = engineFor(store, fake);
		seed(store, job("job-cancel", "h1"));
		await engine.tick();
		const running = store.getJob("job-cancel")!;

		const cancelled = await engine.cancel(running);
		expect(cancelled.state).toBe("cancelled");
		expect(fake.tasks.get(running.taskId!)!.state).toBe("cancelled");
		store.close();
	});

	test("cancel of a queued job never touches the host", async () => {
		const store = new Store(":memory:");
		const fake = new FakeHost();
		const engine = engineFor(store, fake);
		seed(store, job("job-queue-c", "h1"));
		const j = store.getJob("job-queue-c")!;
		const cancelled = await engine.cancel(j);
		expect(cancelled.state).toBe("cancelled");
		expect(fake.calls.length).toBe(0);
		store.close();
	});
});
