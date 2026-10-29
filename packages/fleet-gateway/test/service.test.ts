/**
 * JobService's contract: scope enforcement on every read and write,
 * request-id idempotency on start/continue, workspace resolution, and the
 * per-job feed — the parts tools rely on, asserted without HTTP.
 */
import { describe, expect, test } from "bun:test";
import { parseScopes } from "../src/auth/scopes";
import { Store } from "../src/db/store";
import { JobEngine } from "../src/jobs/engine";
import { type Caller, JobService } from "../src/jobs/service";
import type { GatewayConfig } from "../src/types";
import { FakeHost } from "./fakes";

function config(): GatewayConfig {
	return {
		publicUrl: "http://127.0.0.1:3880",
		listen: { host: "127.0.0.1", port: 3880 },
		hosts: [
			{ id: "h1", connectorUrl: "http://fake1", maxConcurrentJobs: 2, defaultWorkspace: "repo" },
			{ id: "h2", connectorUrl: "http://fake2", maxConcurrentJobs: 2 },
		],
		workspaces: [
			{ alias: "repo", host: "h1", workspace: "repo", allowStart: true },
			{ alias: "locked", host: "h2", workspace: "locked", allowStart: false },
		],
		tokens: { accessTtlSeconds: 43200, refreshIdleTtlDays: 90 },
		watcher: { pollSeconds: 10, hostBackoffSeconds: 60 },
		limits: { taskChars: 20_000, jobsPerClient: 200, feedWindow: 500 },
	};
}

function make() {
	const store = new Store(":memory:");
	const fake = new FakeHost();
	const engine = new JobEngine({
		store,
		config: config(),
		hosts: [
			{ id: "h1", maxConcurrentJobs: 2, defaultWorkspace: "repo", client: fake },
			{ id: "h2", maxConcurrentJobs: 2, client: new FakeHost() },
		],
	});
	return { store, fake, service: new JobService({ store, config: config(), engine }) };
}

const fleetOperate: Caller = { clientId: "c1", scopes: parseScopes("fleet:operate")! };
const fleetRead: Caller = { clientId: "c2", scopes: parseScopes("fleet:read")! };
const hostReadOnly: Caller = { clientId: "c3", scopes: parseScopes("host:h1:read")! };
const hostOperate: Caller = { clientId: "c4", scopes: parseScopes("host:h1:operate")! };

describe("job service", () => {
	test("startWork rejects a caller without operate on the host", () => {
		const { service } = make();
		expect(() => service.startWork(fleetRead, { requestId: "r1", task: "do", workspace: "repo" })).toThrow(
			/requires operate/,
		);
		expect(() => service.startWork(hostReadOnly, { requestId: "r1", task: "do", workspace: "repo" })).toThrow(
			/requires operate/,
		);
	});

	test("startWork targets the host default workspace when given only a host", () => {
		const { service } = make();
		const job = service.startWork(hostOperate, { requestId: "r1", task: "do", target: { host: "h1" } });
		expect(job.host).toBe("h1");
		expect(job.workspace).toBe("repo");
		expect(job.workspaceAlias).toBe("repo");
	});

	test("startWork honours a read-only workspace's allowStart", () => {
		const { service } = make();
		const opOnH2: Caller = { clientId: "c5", scopes: parseScopes("host:h2:operate")! };
		expect(() => service.startWork(opOnH2, { requestId: "r1", task: "do", workspace: "locked" })).toThrow(/disabled/);
	});

	test("the same requestId replays the same job, a different body conflicts", () => {
		const { service } = make();
		const first = service.startWork(fleetOperate, { requestId: "r-same", task: "do", workspace: "repo" });
		const second = service.startWork(fleetOperate, { requestId: "r-same", task: "do", workspace: "repo" });
		expect(second.id).toBe(first.id);
		expect(() =>
			service.startWork(fleetOperate, { requestId: "r-same", task: "DIFFERENT", workspace: "repo" }),
		).toThrow(/requestId/);
	});

	test("a job on a host the caller cannot read is not_found, never 'denied'", () => {
		const { service } = make();
		const job = service.startWork(fleetOperate, { requestId: "r1", task: "do", workspace: "repo" });
		const outsider: Caller = { clientId: "c6", scopes: parseScopes("host:h2:operate")! };
		expect(() => service.getJob(outsider, job.id)).toThrow(/Unknown job/);
	});

	test("cancel requires operate but a reader can watch the same job", () => {
		const { service } = make();
		const job = service.startWork(fleetOperate, { requestId: "r1", task: "do", workspace: "repo" });
		expect(service.getJob(fleetRead, job.id).id).toBe(job.id);
		return service.cancelWork(fleetRead, { jobId: job.id }).then(
			() => {
				throw new Error("expected insufficient_scope");
			},
			(e: Error) => expect(e.message).toMatch(/requires operate/),
		);
	});

	test("work_feed returns only jobs on hosts the caller may read", () => {
		const { service, store } = make();
		service.startWork(fleetOperate, { requestId: "r1", task: "do", workspace: "repo" });
		// A job on h2 the caller has no scope for: the feed must not leak it.
		store.insertJob(
			{
				id: "jobonh2000",
				clientId: "c9",
				state: "running",
				host: "h2",
				workspace: "x",
				title: "h2 work",
				task: "t",
				createdAt: Date.now(),
			},
			{ reason: "test" },
		);
		const feed = service.feed(hostReadOnly, 0, 100);
		expect(feed.events.length).toBeGreaterThan(0);
		expect(feed.events.every(e => e.jobId !== "jobonh2000")).toBe(true);
		const listed = service.listJobs(hostReadOnly, {});
		expect(listed.every(j => j.host === "h1")).toBe(true);
	});

	test("listJobs for a host-scoped caller never leaks other hosts' jobs", () => {
		const { service } = make();
		service.startWork(fleetOperate, { requestId: "r1", task: "do", workspace: "repo" });
		const outsider: Caller = { clientId: "c7", scopes: parseScopes("host:h2:read")! };
		expect(service.listJobs(outsider, {})).toEqual([]);
	});

	test("feedForJob paginates the ledger and honors the cursor", () => {
		const { service } = make();
		const job = service.startWork(fleetOperate, { requestId: "r1", task: "do", workspace: "repo" });
		const first = service.feedForJob(fleetOperate, job.id, 0);
		expect(first.events[0].type).toBe("created");
		const second = service.feedForJob(fleetOperate, job.id, first.next);
		expect(second.events).toEqual([]);
	});
});
