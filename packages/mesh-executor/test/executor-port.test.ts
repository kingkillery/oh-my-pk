import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	parseAssignmentLease,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";
import type { MeshNodeExecutionContext } from "@pk-nerdsaver-ai/mesh-node";
import {
	canonicalExecutorToolPermission,
	ExecutorHttpCodeGateway,
	ExecutorHttpGatewayError,
	ExecutorMeshExecutionError,
	ExecutorMeshExecutionPort,
	FetchExecutorHttpTransport,
	type ExecutorHttpTransport,
	type ExecutorHttpTransportRequest,
	type ExecutorHttpTransportResponse,
	type ExecutorMcpGateway,
	type ExecutorMcpGatewayRequest,
} from "../src";

const NODE_ID = "node_executor-001";
const NODE_PUBKEY = "n".repeat(64);
const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const ENDPOINT_ID = "localExecutor";
const CATALOG_FINGERPRINT = "c".repeat(64);
const TOOL_PATH = ["github", "issues", "create"] as const;

function makeTask(overrides: Record<string, unknown> = {}): TaskContractV1 {
	const args = { repo: "oh-my-pk", owner: "kingkillery", title: "Safe request" };
	const invocation = {
		protocol: "executor-mcp-v1",
		endpointId: ENDPOINT_ID,
		toolPath: TOOL_PATH,
		args,
		inputDigest: sha256CanonicalJson(args),
		catalogFingerprint: CATALOG_FINGERPRINT,
	};
	const unsigned = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_executor-001",
		createdAt: "2026-08-31T11:59:00.000Z",
		requester: { pubkey: "r".repeat(64), role: "human" },
		goal: "This text must never reach the Executor gateway.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "criterion-1", description: "Call the exact permitted tool.", level: "required" }],
		permissions: {
			tools: [canonicalExecutorToolPermission(ENDPOINT_ID, TOOL_PATH)],
			externalSideEffects: "approval_required",
		},
		execution: { profileId: "executor-mcp-v1", timeoutSeconds: 30 },
		executorInvocation: invocation,
		routing: { trustZoneMin: "private", activeMachineAllowed: false },
		artifactPolicy: {},
		idempotencyKey: "executor-task-key",
		digestAlgorithm: "sha256",
		...overrides,
	};
	return parseTaskContract({ ...unsigned, digest: sha256CanonicalJson(unsigned) });
}

function makeAssignment(task: TaskContractV1, overrides: Record<string, unknown> = {}): AssignmentLeaseV1 {
	return parseAssignmentLease({
		schemaVersion: MESH_SCHEMA.assignment,
		assignmentId: "asg_executor-001",
		taskId: task.taskId,
		taskDigest: task.digest,
		scheduler: { pubkey: "s".repeat(64), role: "scheduler" },
		schedulerEpoch: 9,
		fencingToken: 17,
		workerNodeId: NODE_ID,
		executorPubkey: NODE_PUBKEY,
		executionProfileId: "executor-mcp-v1",
		issuedAt: "2026-08-31T11:59:00.000Z",
		leaseExpiresAt: "2026-08-31T12:05:00.000Z",
		renewAfterSeconds: 15,
		permissionsDigest: sha256CanonicalJson(task.permissions),
		placementReason: { source: "test" },
		idempotencyKey: "executor-assignment-key",
		...overrides,
	});
}

function makeContext(task: TaskContractV1, assignment = makeAssignment(task)): MeshNodeExecutionContext {
	return {
		assignmentId: assignment.assignmentId,
		taskId: task.taskId,
		taskDigest: task.digest,
		nodeId: NODE_ID,
		executorPubkey: NODE_PUBKEY,
		schedulerEpoch: assignment.schedulerEpoch,
		fencingToken: assignment.fencingToken,
		executionProfileId: assignment.executionProfileId,
		bounds: { timeoutSeconds: 30 },
		task,
		assignment,
	};
}

function makePort(gateway: ExecutorMcpGateway, catalogFingerprint = CATALOG_FINGERPRINT, now: () => number = () => NOW): ExecutorMeshExecutionPort {
	return new ExecutorMeshExecutionPort({
		gateway,
		trustedEndpoints: [{ endpointId: ENDPOINT_ID, catalogFingerprint }],
		now,
	});
}

function httpResponse(value: unknown, options: { readonly ok?: boolean; readonly status?: number } = {}): ExecutorHttpTransportResponse {
	return Object.freeze({
		ok: options.ok ?? true,
		status: options.status ?? 200,
		json: async () => value,
	});
}

class RecordingHttpTransport implements ExecutorHttpTransport {
	readonly requests: ExecutorHttpTransportRequest[] = [];
	readonly #responses: readonly ExecutorHttpTransportResponse[];
	#nextResponse = 0;

	constructor(responses: readonly ExecutorHttpTransportResponse[]) {
		this.#responses = responses;
	}

	async send(request: ExecutorHttpTransportRequest): Promise<ExecutorHttpTransportResponse> {
		this.requests.push(request);
		const response = this.#responses[this.#nextResponse];
		this.#nextResponse += 1;
		if (response === undefined) throw new Error("missing_test_response");
		return response;
	}
}

class HangingHttpTransport implements ExecutorHttpTransport {
	readonly requests: ExecutorHttpTransportRequest[] = [];

	async send(request: ExecutorHttpTransportRequest): Promise<ExecutorHttpTransportResponse> {
		this.requests.push(request);
		const pending = Promise.withResolvers<ExecutorHttpTransportResponse>();
		request.signal.addEventListener("abort", () => pending.reject(new Error("test_transport_aborted")), { once: true });
		return pending.promise;
	}
}

function makeHttpGateway(transport: ExecutorHttpTransport, now: () => number = () => NOW): ExecutorHttpCodeGateway {
	return new ExecutorHttpCodeGateway({
		endpoints: [{ endpointId: ENDPOINT_ID, origin: "http://127.0.0.1:4788", authorization: "Bearer host-only-token" }],
		transport,
		now,
	});
}

describe("ExecutorMeshExecutionPort", () => {
	test("creates one injection-resistant canonical tool call and binds gateway provenance", async () => {
		const calls: ExecutorMcpGatewayRequest[] = [];
		const gateway: ExecutorMcpGateway = {
			async invoke(request) {
				calls.push(request);
				return { status: "succeeded", exitCode: 0 };
			},
		};
		const task = makeTask();
		const context = makeContext(task);
		const port = makePort(gateway);

		await port.start(context);
		await expect(port.run(context)).resolves.toEqual({ outcome: "succeeded", exitCode: 0 });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({
			endpointId: ENDPOINT_ID,
			code: 'return await tools.github.issues.create({"owner":"kingkillery","repo":"oh-my-pk","title":"Safe request"});',
			timeoutSeconds: 30,
			deadlineEpochMs: Date.parse(context.assignment.leaseExpiresAt),
			metadata: {
				taskId: task.taskId,
				taskDigest: task.digest,
				assignmentId: context.assignmentId,
				schedulerEpoch: 9,
				fencingToken: 17,
				inputDigest: task.executorInvocation?.inputDigest,
				catalogFingerprint: CATALOG_FINGERPRINT,
				toolPermission: canonicalExecutorToolPermission(ENDPOINT_ID, TOOL_PATH),
			},
		});
		expect(JSON.stringify(calls[0])).not.toContain(task.goal);

		const malicious = {
			...task,
			executorInvocation: { ...task.executorInvocation, toolPath: ["github", "issues;process.exit()"] },
		} as TaskContractV1;
		await expect(port.start(makeContext(malicious))).rejects.toMatchObject({ code: "invocation_invalid" });
		expect(calls).toHaveLength(1);
	});

	test("refuses a direct Executor invocation without the full remaining assignment window", async () => {
		const task = makeTask();
		const deadlineEpochMs = NOW + 30_000;
		const context = makeContext(task, makeAssignment(task, { leaseExpiresAt: new Date(deadlineEpochMs).toISOString() }));
		let gatewayCalls = 0;
		const gateway: ExecutorMcpGateway = {
			async invoke() {
				gatewayCalls += 1;
				return { status: "succeeded" };
			},
		};

		await expect(makePort(gateway, CATALOG_FINGERPRINT, () => NOW).run(context)).rejects.toEqual(new ExecutorMeshExecutionError("assignment_lease_insufficient"));
		expect(gatewayCalls).toBe(0);
	});

	test("quarantines a direct Executor result that arrives after its assignment deadline", async () => {
		let now = NOW;
		const task = makeTask();
		const deadlineEpochMs = NOW + 60_000;
		const context = makeContext(task, makeAssignment(task, { leaseExpiresAt: new Date(deadlineEpochMs).toISOString() }));
		const gateway: ExecutorMcpGateway = {
			async invoke() {
				now = deadlineEpochMs;
				return { status: "succeeded" };
			},
		};

		await expect(makePort(gateway, CATALOG_FINGERPRINT, () => now).run(context)).rejects.toEqual(new ExecutorMeshExecutionError("assignment_lease_expired"));
	});

	test("rejects missing exact permission, stale args, and untrusted catalog before the gateway", async () => {
		let callCount = 0;
		const gateway: ExecutorMcpGateway = {
			async invoke() {
				callCount += 1;
				return { status: "succeeded" };
			},
		};
		const noPermission = makeTask({
			permissions: { tools: ["executor:localExecutor:tools.github.issues.*"], externalSideEffects: "approval_required" },
		});
		await expect(makePort(gateway).start(makeContext(noPermission))).rejects.toMatchObject({ code: "tool_permission_denied" });

		const validTask = makeTask();
		const staleArgs = {
			...validTask,
			executorInvocation: { ...validTask.executorInvocation, args: { changed: true } },
		} as TaskContractV1;
		await expect(makePort(gateway).start(makeContext(staleArgs))).rejects.toMatchObject({ code: "invocation_invalid" });

		await expect(makePort(gateway, "d".repeat(64)).start(makeContext(validTask))).rejects.toMatchObject({ code: "catalog_fingerprint_mismatch" });
		expect(callCount).toBe(0);
	});

	test("posts only canonical code to the configured Executor endpoint and never opts into auto-approval", async () => {
		const transport = new RecordingHttpTransport([httpResponse({ status: "completed", text: "completed", structured: {}, isError: false })]);
		const task = makeTask();
		const port = makePort(makeHttpGateway(transport));

		await expect(port.run(makeContext(task))).resolves.toEqual({ outcome: "succeeded" });
		expect(transport.requests).toHaveLength(1);
		expect(transport.requests[0]).toMatchObject({
			method: "POST",
			url: "http://127.0.0.1:4788/api/executions",
			redirect: "error",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				authorization: "Bearer host-only-token",
			},
		});
		const body = JSON.parse(transport.requests[0]?.body ?? "") as { readonly code?: unknown; readonly autoApprove?: unknown };
		expect(body).toEqual({ code: 'return await tools.github.issues.create({"owner":"kingkillery","repo":"oh-my-pk","title":"Safe request"});' });
		expect(body.autoApprove).toBeUndefined();
		expect(transport.requests[0]?.body).not.toContain(task.goal);
		expect(transport.requests[0]?.signal.aborted).toBeFalse();
	});

	test("rejects a redirect instead of forwarding canonical code beyond the registered Executor origin", async () => {
		let redirectedRequestCount = 0;
		const redirected = Bun.serve({
			port: 0,
			fetch() {
				redirectedRequestCount += 1;
				return Response.json({ status: "completed", text: "forged", structured: {}, isError: false });
			},
		});
		const executor = Bun.serve({
			port: 0,
			fetch() {
				return Response.redirect(redirected.url, 307);
			},
		});
		try {
			const port = makePort(
				new ExecutorHttpCodeGateway({
					endpoints: [{ endpointId: ENDPOINT_ID, origin: executor.url.origin }],
					transport: new FetchExecutorHttpTransport(),
					now: () => NOW,
				}),
			);
			await expect(port.run(makeContext(makeTask()))).rejects.toEqual(new ExecutorHttpGatewayError("transport_unavailable"));
			expect(redirectedRequestCount).toBe(0);
		} finally {
			executor.stop(true);
			redirected.stop(true);
		}
	});

	test("aborts a stalled Executor request at the validated task timeout", async () => {
		const transport = new HangingHttpTransport();
		const context = makeContext(makeTask());
		const timeoutBoundContext: MeshNodeExecutionContext = {
			...context,
			bounds: Object.freeze({ ...context.bounds, timeoutSeconds: 1 }),
		};

		await expect(makePort(makeHttpGateway(transport)).run(timeoutBoundContext)).rejects.toEqual(new ExecutorHttpGatewayError("transport_timed_out"));
		expect(transport.requests).toHaveLength(1);
		expect(transport.requests[0]?.signal.aborted).toBeTrue();
	});

	test("caps the HTTP request at the absolute assignment deadline", async () => {
		const transport = new HangingHttpTransport();
		const gateway = makeHttpGateway(transport, () => NOW);
		const request: ExecutorMcpGatewayRequest = {
			endpointId: ENDPOINT_ID,
			code: "return await tools.github.issues.create({});",
			timeoutSeconds: 30,
			deadlineEpochMs: NOW + 10,
			metadata: {
				taskId: "task_executor-deadline",
				taskDigest: "a".repeat(64),
				assignmentId: "asg_executor-deadline",
				schedulerEpoch: 1,
				fencingToken: 1,
				inputDigest: "b".repeat(64),
				catalogFingerprint: CATALOG_FINGERPRINT,
				toolPermission: canonicalExecutorToolPermission(ENDPOINT_ID, TOOL_PATH),
			},
		};

		await expect(gateway.invoke(request)).rejects.toEqual(new ExecutorHttpGatewayError("transport_timed_out"));
		expect(transport.requests).toHaveLength(1);
		expect(transport.requests[0]?.signal.aborted).toBeTrue();
	});

	test("does not return a direct HTTP gateway success when JSON resolves at the assignment deadline", async () => {
		let now = NOW;
		const deadlineEpochMs = NOW + 10;
		const transport = new RecordingHttpTransport([
			Object.freeze({
				ok: true,
				status: 200,
				async json() {
					now = deadlineEpochMs;
					return { status: "completed", text: "late", structured: {}, isError: false };
				},
			}),
		]);
		const gateway = makeHttpGateway(transport, () => now);
		const request: ExecutorMcpGatewayRequest = {
			endpointId: ENDPOINT_ID,
			code: "return await tools.github.issues.create({});",
			timeoutSeconds: 30,
			deadlineEpochMs,
			metadata: {
				taskId: "task_executor-deadline",
				taskDigest: "a".repeat(64),
				assignmentId: "asg_executor-deadline",
				schedulerEpoch: 1,
				fencingToken: 1,
				inputDigest: "b".repeat(64),
				catalogFingerprint: CATALOG_FINGERPRINT,
				toolPermission: canonicalExecutorToolPermission(ENDPOINT_ID, TOOL_PATH),
			},
		};

		await expect(gateway.invoke(request)).rejects.toEqual(new ExecutorHttpGatewayError("transport_timed_out"));
		expect(transport.requests).toHaveLength(1);
	});

	test("keeps an explicit Executor failure separate from ambiguous gateway outcomes", async () => {
		const task = makeTask();
		const context = makeContext(task);
		const missingEndpointTransport = new RecordingHttpTransport([]);
		const missingEndpointGateway = new ExecutorHttpCodeGateway({
			endpoints: [{ endpointId: "differentEndpoint", origin: "http://127.0.0.1:4788" }],
			transport: missingEndpointTransport,
			now: () => NOW,
		});
		await expect(makePort(missingEndpointGateway).run(context)).rejects.toEqual(new ExecutorHttpGatewayError("endpoint_not_registered"));
		expect(missingEndpointTransport.requests).toHaveLength(0);

		const knownFailedTransport = new RecordingHttpTransport([httpResponse({ status: "completed", text: "rejected", structured: {}, isError: true })]);
		await expect(makePort(makeHttpGateway(knownFailedTransport)).run(context)).resolves.toEqual({ outcome: "failed" });
		expect(knownFailedTransport.requests).toHaveLength(1);

		const unavailableTransport = new RecordingHttpTransport([]);
		await expect(makePort(makeHttpGateway(unavailableTransport)).run(context)).rejects.toEqual(new ExecutorHttpGatewayError("transport_unavailable"));
		expect(unavailableTransport.requests).toHaveLength(1);

		for (const [response, code] of [
			[httpResponse({ status: "completed", text: "unavailable", structured: {}, isError: false }, { ok: false, status: 503 }), "transport_unavailable"],
			[httpResponse({ status: "completed" }), "response_invalid"],
			[httpResponse({ status: "paused" }), "response_invalid"],
		] as const) {
			const transport = new RecordingHttpTransport([response]);
			await expect(makePort(makeHttpGateway(transport)).run(context)).rejects.toEqual(new ExecutorHttpGatewayError(code));
			expect(transport.requests).toHaveLength(1);
		}

		expect(
			() =>
				new ExecutorHttpCodeGateway({
					endpoints: [{ endpointId: ENDPOINT_ID, origin: "https://executor.invalid/path" }],
				}),
		).toThrow(new ExecutorHttpGatewayError("endpoint_configuration_invalid"));
	});

	test("never resumes approvals and reports cancellation as uncertain", async () => {
		const transport = new RecordingHttpTransport([httpResponse({ status: "paused", text: "approval required", structured: { executionId: "execution-paused" } })]);
		const context = makeContext(makeTask());
		const port = makePort(makeHttpGateway(transport));

		await expect(port.run(context)).rejects.toEqual(new ExecutorMeshExecutionError("approval_required"));
		await expect(port.cancel(context)).rejects.toEqual(new ExecutorMeshExecutionError("cancellation_uncertain"));
		expect(transport.requests).toHaveLength(1);
		expect(transport.requests[0]?.body).not.toContain("autoApprove");
		expect(transport.requests[0]?.body).not.toContain("execution-paused");
	});
});
