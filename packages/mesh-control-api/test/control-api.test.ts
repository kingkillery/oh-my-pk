import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	contractDigest,
	parseTaskContract,
	type JsonRecord,
	type TaskContractV1,
} from "../../mesh-contracts/src/index";
import {
	signTaskContract,
	type MeshEnvelopeSigner,
	type MeshEnvelopeVerifier,
} from "../../mesh-auth/src/index";
import type { MeshCliApi, MeshCliJsonObject, MeshCliSubmitRequest } from "../../mesh-cli/src/index";
import { InMemoryMeshRuntimeRepository, MeshOrchestrator } from "../../mesh-orchestrator/src/index";
import { MeshControlApi, type MeshControlAuthorizationRequest, type MeshControlAuthorizer } from "../src/index";

const T0 = Date.parse("2026-08-31T12:00:00.000Z");
const TASK_AUTHOR_PUBKEY = "h".repeat(64);
const TEST_ALGORITHM = "control-api-deterministic-v1";
const TASK_KEY_ID = "control-api-human-key";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function deterministicSignature(payload: Uint8Array): Uint8Array {
	return encoder.encode(`${TEST_ALGORITHM}:${TASK_KEY_ID}:${decoder.decode(payload).split("").reverse().join("")}`);
}

const taskEnvelopeSigner: MeshEnvelopeSigner = Object.freeze({
	algorithm: TEST_ALGORITHM,
	keyId: TASK_KEY_ID,
	actorPubkey: TASK_AUTHOR_PUBKEY,
	role: "human",
	sign: deterministicSignature,
});

const taskEnvelopeVerifier: MeshEnvelopeVerifier = Object.freeze({
	algorithm: TEST_ALGORITHM,
	keyId: TASK_KEY_ID,
	actorPubkey: TASK_AUTHOR_PUBKEY,
	role: "human",
	verify(payload, signature) {
		return bytesEqual(signature, deterministicSignature(payload));
	},
});

function signedTask(taskId: string, idempotencyKey: string): TaskContractV1 {
	const body = {
		schemaVersion: MESH_SCHEMA.task,
		taskId,
		createdAt: new Date(T0).toISOString(),
		requester: { pubkey: TASK_AUTHOR_PUBKEY, role: "human" as const },
		goal: "Run a harmless control API fixture.",
		mode: "general_tool" as const,
		acceptanceCriteria: [{ id: "fixture-output", description: "A fixture result is recorded.", level: "required" as const }],
		permissions: { tools: ["fixture.run"], externalSideEffects: "none" as const },
		execution: { profileId: "linux-test-v1", timeoutSeconds: 60 },
		routing: { trustZoneMin: "private" as const, activeMachineAllowed: false },
		artifactPolicy: { encryptionRequired: true, retentionClass: "ephemeral" },
		idempotencyKey,
		digestAlgorithm: "sha256" as const,
	};
	return parseTaskContract({ ...body, digest: contractDigest(body as unknown as JsonRecord, "digest") });
}

async function submitRequest(task: TaskContractV1): Promise<MeshCliSubmitRequest> {
	const envelope = await signTaskContract(task, taskEnvelopeSigner, { signedAt: new Date(T0).toISOString() });
	return {
		requestId: `request-${task.taskId}`,
		idempotencyKey: task.idempotencyKey,
		payload: envelope as unknown as MeshCliJsonObject,
	};
}

function allowAuthorizer(calls: MeshControlAuthorizationRequest[] = []): MeshControlAuthorizer {
	return {
		async authorize(request) {
			calls.push(request);
			return { outcome: "allow" };
		},
	};
}

function controlApi(authorizer: MeshControlAuthorizer, repository = new InMemoryMeshRuntimeRepository()): {
	readonly api: MeshControlApi;
	readonly repository: InMemoryMeshRuntimeRepository;
	readonly runtime: MeshOrchestrator;
} {
	const runtime = new MeshOrchestrator(repository);
	return {
		api: new MeshControlApi({ orchestrator: runtime, taskEnvelopeVerifier, authorizer, clock: { nowEpochMs: () => T0 } }),
		repository,
		runtime,
	};
}

describe("MeshControlApi", () => {
	test("fails closed when local authorization denies a signed task", async () => {
		const { api, runtime } = controlApi({
			async authorize() {
				return { outcome: "deny", reasonCode: "policy_denied" };
			},
		});
		const task = signedTask("task_control-api-denied", "control-api-denied");

		await expect(api.submit(await submitRequest(task))).rejects.toMatchObject({ code: "policy_denied" });
		expect(await runtime.getTask(task.taskId)).toBeUndefined();
	});

	test("accepts a complete locally verified task and preserves CLI idempotency", async () => {
		const calls: MeshControlAuthorizationRequest[] = [];
		const { api, repository } = controlApi(allowAuthorizer(calls));
		const task = signedTask("task_control-api-submit", "control-api-submit");
		const request = await submitRequest(task);

		const first = await api.submit(request);
		const replay = await api.submit({ ...request, requestId: "request-control-api-replay" });

		expect(first).toEqual(replay);
		expect(first).toMatchObject({
			schemaVersion: "ompk.mesh-control-api/v1",
			kind: "task_submission",
			task: {
				taskId: task.taskId,
				taskDigest: task.digest,
				idempotencyKey: "control-api-submit",
				state: "queued",
			},
		});
		expect(calls).toHaveLength(2);
		expect(calls[0]).toMatchObject({
			action: "task.submit",
			taskId: task.taskId,
			idempotencyKey: "control-api-submit",
			evaluatedAt: "2026-08-31T12:00:00.000Z",
		});
		expect(await repository.read(snapshot => Object.keys(snapshot.outbox))).toHaveLength(1);
	});

	test("rejects unsigned or altered tasks before local authorization", async () => {
		const calls: MeshControlAuthorizationRequest[] = [];
		const { api, runtime } = controlApi(allowAuthorizer(calls));
		const task = signedTask("task_control-api-signature", "control-api-signature");
		const rawRequest: MeshCliSubmitRequest = {
			requestId: "request-control-api-raw",
			idempotencyKey: task.idempotencyKey,
			payload: task as unknown as MeshCliJsonObject,
		};

		await expect(api.submit(rawRequest)).rejects.toMatchObject({ code: "signature_unverified" });
		const request = await submitRequest(task);
		const { digest: ignoredDigest, ...taskWithoutDigest } = task;
		const alteredTask = parseTaskContract({
			...taskWithoutDigest,
			goal: "A payload changed after the signer approved it.",
			digest: contractDigest({ ...taskWithoutDigest, goal: "A payload changed after the signer approved it." } as JsonRecord, "digest"),
		});
		void ignoredDigest;
		await expect(api.submit({ ...request, payload: { ...(request.payload as object), payload: alteredTask } as MeshCliJsonObject })).rejects.toMatchObject({
			code: "signature_unverified",
		});
		expect(calls).toHaveLength(0);
		expect(await runtime.getTask(task.taskId)).toBeUndefined();
	});

	test("rejects a mismatched outer idempotency key before local authorization", async () => {
		const calls: MeshControlAuthorizationRequest[] = [];
		const { api, runtime } = controlApi(allowAuthorizer(calls));
		const task = signedTask("task_control-api-key", "control-api-key");

		await expect(api.submit({ ...(await submitRequest(task)), idempotencyKey: "a-different-key" })).rejects.toMatchObject({ code: "idempotency_key_mismatch" });
		expect(calls).toHaveLength(0);
		expect(await runtime.getTask(task.taskId)).toBeUndefined();
	});

	test("returns canonical task projections for authorized status and trace reads", async () => {
		const calls: MeshControlAuthorizationRequest[] = [];
		const { api } = controlApi(allowAuthorizer(calls));
		const task = signedTask("task_control-api-trace", "control-api-trace");
		await api.submit(await submitRequest(task));

		const status = await api.status({ requestId: "request-control-api-status", taskId: task.taskId });
		const trace = await api.trace({ requestId: "request-control-api-trace", taskId: task.taskId });

		expect(status).toMatchObject({
			kind: "task_status",
			task: { taskId: task.taskId, state: "queued", goal: "Run a harmless control API fixture." },
		});
		expect(trace).toMatchObject({
			kind: "task_trace",
			task: { taskId: task.taskId, taskDigest: task.digest, idempotencyKey: task.idempotencyKey },
			trace: { source: "mesh-orchestrator/runtime-task-record", eventHistory: "unavailable" },
		});
		expect(calls.map(call => call.action)).toEqual(["task.submit", "task.status", "task.trace"]);
	});

	test("honestly reports actions without durable implementations as unsupported", async () => {
		const { api } = controlApi(allowAuthorizer());
		const compatibleApi: MeshCliApi = api;
		const taskId = "task_control-api-unsupported";

		expect(await compatibleApi.cancel?.({ requestId: "request-control-api-cancel", taskId, idempotencyKey: "control-api-cancel" })).toMatchObject({
			status: "unsupported",
			code: "durable_cancellation_unsupported",
			retryable: false,
		});
		expect(await compatibleApi.artifacts?.({ requestId: "request-control-api-artifacts", taskId })).toMatchObject({
			status: "unsupported",
			code: "durable_artifacts_unsupported",
			retryable: false,
		});
		expect(await compatibleApi.follow?.({ requestId: "request-control-api-follow", taskId })).toMatchObject({
			status: "unsupported",
			code: "durable_follow_unsupported",
			retryable: false,
		});
	});
});
