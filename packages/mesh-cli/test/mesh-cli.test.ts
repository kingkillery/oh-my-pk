import { describe, expect, test } from "bun:test";
import {
	MeshCliApiError,
	createMeshCliService,
	runMeshCli,
	type MeshCliApi,
	type MeshCliEnvelope,
} from "../src/index";

async function collect(api: MeshCliApi, argv: readonly string[]): Promise<readonly MeshCliEnvelope[]> {
	const envelopes: MeshCliEnvelope[] = [];
	for await (const envelope of createMeshCliService(api).dispatch(argv)) envelopes.push(envelope);
	return envelopes;
}

describe("MeshCliService", () => {
	test("writes stable JSONL envelopes with JSON-safe data", async () => {
		const lines: string[] = [];
		const exitCode = await runMeshCli(
			["status", "task-json-safe", "--request-id", "request-json-safe", "--json"],
			{
				async status() {
					return { later: new Date("2026-08-31T00:00:00.000Z"), count: 1n, invalid: Number.NaN };
				},
			},
			{ write: line => lines.push(line) },
		);

		expect(exitCode).toBe(0);
		expect(lines).toHaveLength(1);
		const envelope = JSON.parse(lines[0] ?? "{}") as MeshCliEnvelope;
		expect(envelope).toMatchObject({
			schemaVersion: "ompk.mesh-cli/v1",
			ok: true,
			command: "status",
			requestId: "request-json-safe",
			type: "result",
			data: { count: "1", invalid: null, later: "2026-08-31T00:00:00.000Z" },
		});
	});

	test("dispatches every mesh command through the injected API and preserves idempotency keys", async () => {
		const calls: Array<{ readonly name: string; readonly request: unknown }> = [];
		const api: MeshCliApi = {
			async submit(request) {
				calls.push({ name: "submit", request });
				return { taskId: "task-1" };
			},
			async status(request) {
				calls.push({ name: "status", request });
				return { state: "queued" };
			},
			async follow(request) {
				calls.push({ name: "follow", request });
				return (async function* (): AsyncGenerator<{ readonly state: string }, void, void> {
					yield { state: "leased" };
				})();
			},
			async cancel(request) {
				calls.push({ name: "cancel", request });
				return { state: "cancelled" };
			},
			async artifacts(request) {
				calls.push({ name: "artifacts", request });
				return { items: [] };
			},
			async trace(request) {
				calls.push({ name: "trace", request });
				return { events: [] };
			},
		};

		await collect(api, ["submit", "--request", '{"goal":"hello","idempotencyKey":"submit-key"}', "--request-id", "r-submit"]);
		await collect(api, ["status", "task-1", "--cursor", "c1", "--request-id", "r-status"]);
		const follow = await collect(api, ["follow", "task-1", "--limit", "2", "--request-id", "r-follow"]);
		await collect(api, ["cancel", "task-1", "--idempotency-key", "cancel-key", "--request-id", "r-cancel"]);
		await collect(api, ["artifacts", "task-1", "--request-id", "r-artifacts"]);
		await collect(api, ["trace", "task-1", "--request-id", "r-trace"]);

		expect(calls.map(call => call.name)).toEqual(["submit", "status", "follow", "cancel", "artifacts", "trace"]);
		expect(calls[0]?.request).toMatchObject({ idempotencyKey: "submit-key", payload: { goal: "hello", idempotencyKey: "submit-key" } });
		expect(calls[3]?.request).toMatchObject({ taskId: "task-1", idempotencyKey: "cancel-key" });
		expect(follow.map(envelope => envelope.type)).toEqual(["event", "complete"]);
	});

	test("requires explicit effect idempotency keys", async () => {
		let submitted = false;
		const result = await collect(
			{
				async submit() {
					submitted = true;
					return { taskId: "never" };
				},
			},
			["submit", "--request", '{"goal":"must not duplicate"}', "--request-id", "r-key"],
		);

		expect(submitted).toBe(false);
		expect(result[0]).toMatchObject({ ok: false, error: { code: "idempotency_key_required" } });
	});

	test("reports an unavailable action instead of pretending a local backend exists", async () => {
		const result = await collect({}, ["trace", "task-missing", "--request-id", "r-unavailable"]);

		expect(result).toEqual([
			expect.objectContaining({
				ok: false,
				command: "trace",
				error: expect.objectContaining({ code: "action_unavailable", unavailable: true, retryable: false }),
			}),
		]);
	});

	test("redacts credential-shaped adapter errors", async () => {
		const secret = "top-secret-token-value";
		const result = await collect(
			{
				async status() {
					throw new MeshCliApiError("adapter_failed", `Authorization: Bearer ${secret}`, { retryable: true });
				},
			},
			["status", "task-safe", "--request-id", "r-redact"],
		);

		const message = result[0]?.error?.message ?? "";
		expect(message).toContain("[REDACTED]");
		expect(message).not.toContain(secret);
	});
});
