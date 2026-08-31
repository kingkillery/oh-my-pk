import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	parseAssignmentLease,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type MeshRole,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";

import {
	MAX_MESH_SIGNATURE_BYTES,
	MESH_ENVELOPE_SIGNING_PAYLOAD_SCHEMA,
	MeshEnvelopeError,
	signAssignmentLease,
	signTaskContract,
	verifySignedAssignmentLease,
	verifySignedTaskContract,
	type MeshEnvelopeSigner,
	type MeshEnvelopeVerifier,
} from "../src";

const TASK_KEY_ID = "task-author-key-alpha";
const SCHEDULER_KEY_ID = "scheduler-key-alpha";
const TASK_PUBKEY = "r".repeat(64);
const SCHEDULER_PUBKEY = "s".repeat(64);
const TEST_ALGORITHM = "test-deterministic-v1";
const SIGNED_AT = "2026-08-31T12:00:00.000Z";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/** Deterministic test-only adapter: it is intentionally not cryptography. */
function deterministicSignature(payload: Uint8Array, algorithm: string, keyId: string, role: MeshRole): Uint8Array {
	return encoder.encode(`${algorithm}:${keyId}:${role}:${decoder.decode(payload).split("").reverse().join("")}`);
}

function signer(
	role: MeshRole,
	keyId: string,
	actorPubkey: string,
	algorithm = TEST_ALGORITHM,
	onSign?: () => void,
): MeshEnvelopeSigner {
	return {
		algorithm,
		keyId,
		actorPubkey,
		role,
		sign(payload) {
			onSign?.();
			return deterministicSignature(payload, algorithm, keyId, role);
		},
	};
}

function verifier(
	role: MeshRole,
	keyId: string,
	actorPubkey: string,
	algorithm = TEST_ALGORITHM,
	onVerify?: () => void,
): MeshEnvelopeVerifier {
	return {
		algorithm,
		keyId,
		actorPubkey,
		role,
		verify(payload, signature) {
			onVerify?.();
			return bytesEqual(signature, deterministicSignature(payload, algorithm, keyId, role));
		},
	};
}

function task(overrides: Readonly<Record<string, unknown>> = {}): TaskContractV1 {
	const body = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_auth-envelope-001",
		createdAt: "2026-08-31T11:59:00.000Z",
		requester: { pubkey: TASK_PUBKEY, role: "human" },
		goal: "Prove the signed authority envelope boundary.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "signed", description: "A validated task has an origin signature.", level: "required" }],
		permissions: { tools: ["safe.tool"], externalSideEffects: "none" },
		execution: { timeoutSeconds: 30 },
		routing: { trustZoneMin: "private", activeMachineAllowed: false },
		artifactPolicy: {},
		idempotencyKey: "auth-envelope-task-001",
		digestAlgorithm: "sha256",
		...overrides,
	};
	return parseTaskContract({ ...body, digest: sha256CanonicalJson(body) });
}

function assignment(parentTask: TaskContractV1, overrides: Readonly<Record<string, unknown>> = {}): AssignmentLeaseV1 {
	return parseAssignmentLease({
		schemaVersion: MESH_SCHEMA.assignment,
		assignmentId: "asg_auth-envelope-001",
		taskId: parentTask.taskId,
		taskDigest: parentTask.digest,
		scheduler: { pubkey: SCHEDULER_PUBKEY, role: "scheduler" },
		schedulerEpoch: 7,
		fencingToken: 13,
		workerNodeId: "node_auth-envelope-001",
		executorPubkey: "w".repeat(64),
		executionProfileId: "safe-profile",
		issuedAt: "2026-08-31T12:00:00.000Z",
		leaseExpiresAt: "2026-08-31T12:05:00.000Z",
		renewAfterSeconds: 15,
		permissionsDigest: sha256CanonicalJson(parentTask.permissions),
		placementReason: { source: "test" },
		idempotencyKey: "auth-envelope-assignment-001",
		...overrides,
	});
}

describe("signed mesh envelopes", () => {
	test("signs and verifies a task with canonical payload binding", async () => {
		const signed = await signTaskContract(task(), signer("human", TASK_KEY_ID, TASK_PUBKEY), { signedAt: SIGNED_AT });
		const result = await verifySignedTaskContract(signed, verifier("human", TASK_KEY_ID, TASK_PUBKEY));

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(`expected a valid task signature, received ${result.reason}`);
		expect(result.payload).toEqual(signed.payload);
		expect(result.signingPayload).toEqual({
			schemaVersion: MESH_ENVELOPE_SIGNING_PAYLOAD_SCHEMA,
			envelopeSchemaVersion: "ompk.signed-mesh-envelope/v1",
			payloadSchemaVersion: MESH_SCHEMA.task,
			payloadDigest: signed.payloadDigest,
			signer: { algorithm: TEST_ALGORITHM, keyId: TASK_KEY_ID, actorPubkey: TASK_PUBKEY, role: "human", signedAt: SIGNED_AT },
		});
		expect(Object.isFrozen(signed)).toBe(true);
		expect(Object.isFrozen(signed.payload)).toBe(true);
	});

	test("signs and verifies an assignment only under scheduler origin evidence", async () => {
		const parentTask = task();
		const signed = await signAssignmentLease(assignment(parentTask), signer("scheduler", SCHEDULER_KEY_ID, SCHEDULER_PUBKEY), { signedAt: SIGNED_AT });
		const result = await verifySignedAssignmentLease(signed, verifier("scheduler", SCHEDULER_KEY_ID, SCHEDULER_PUBKEY));

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(`expected a valid assignment signature, received ${result.reason}`);
		expect(result.payload.assignmentId).toBe("asg_auth-envelope-001");
		expect(result.signingPayload.payloadSchemaVersion).toBe(MESH_SCHEMA.assignment);
	});

	test("rejects a payload modified after signing before it reaches the verifier", async () => {
		const signed = await signTaskContract(task(), signer("human", TASK_KEY_ID, TASK_PUBKEY), { signedAt: SIGNED_AT });
		const { digest: ignoredDigest, ...body } = signed.payload;
		const alteredTask = parseTaskContract({
			...body,
			goal: "Changed after the signer approved it.",
			digest: sha256CanonicalJson({ ...body, goal: "Changed after the signer approved it." }),
		});
		let verificationCalls = 0;
		const result = await verifySignedTaskContract(
			{ ...signed, payload: alteredTask },
			verifier("human", TASK_KEY_ID, TASK_PUBKEY, TEST_ALGORITHM, () => {
				verificationCalls += 1;
			}),
		);

		void ignoredDigest;
		expect(result).toEqual({ ok: false, reason: "payload_digest_mismatch" });
		expect(verificationCalls).toBe(0);
	});

	test("rejects key, algorithm, and role mismatches before verifier invocation", async () => {
		const signed = await signTaskContract(task(), signer("human", TASK_KEY_ID, TASK_PUBKEY), { signedAt: SIGNED_AT });
		let verificationCalls = 0;
		const countVerify = (): void => {
			verificationCalls += 1;
		};

		expect(await verifySignedTaskContract(signed, verifier("human", "task-author-key-beta", TASK_PUBKEY, TEST_ALGORITHM, countVerify))).toEqual({
			ok: false,
			reason: "key_id_mismatch",
		});
		expect(await verifySignedTaskContract(signed, verifier("human", TASK_KEY_ID, TASK_PUBKEY, "test-other-algorithm", countVerify))).toEqual({
			ok: false,
			reason: "algorithm_mismatch",
		});
		expect(await verifySignedTaskContract(signed, verifier("human", TASK_KEY_ID, "z".repeat(64), TEST_ALGORITHM, countVerify))).toEqual({
			ok: false,
			reason: "actor_pubkey_mismatch",
		});
		expect(await verifySignedTaskContract(signed, verifier("orchestrator", TASK_KEY_ID, TASK_PUBKEY, TEST_ALGORITHM, countVerify))).toEqual({
			ok: false,
			reason: "role_mismatch",
		});
		expect(verificationCalls).toBe(0);
	});

	test("fails closed for invalid base64 and forbidden task author roles before adapters run", async () => {
		const signed = await signTaskContract(task(), signer("human", TASK_KEY_ID, TASK_PUBKEY), { signedAt: SIGNED_AT });
		let verificationCalls = 0;
		const malformed = {
			...signed,
			signature: { ...signed.signature, signatureBase64: "not base64!" },
		};
		const invalidSignature = await verifySignedTaskContract(
			malformed,
			verifier("human", TASK_KEY_ID, TASK_PUBKEY, TEST_ALGORITHM, () => {
				verificationCalls += 1;
			}),
		);
		expect(invalidSignature).toEqual({ ok: false, reason: "invalid_signature_envelope" });
		expect(verificationCalls).toBe(0);
		const oversizedMetadata = await verifySignedTaskContract(
			{ ...signed, signature: { ...signed.signature, signatureBytes: MAX_MESH_SIGNATURE_BYTES + 1 } },
			verifier("human", TASK_KEY_ID, TASK_PUBKEY),
		);
		expect(oversizedMetadata).toEqual({ ok: false, reason: "invalid_signature_envelope" });

		let signingCalls = 0;
		await expect(
			signTaskContract(
				task({ requester: { pubkey: "w".repeat(64), role: "worker" } }),
				signer("worker", "worker-key-alpha", "w".repeat(64), TEST_ALGORITHM, () => {
					signingCalls += 1;
				}),
				{ signedAt: SIGNED_AT },
			),
		).rejects.toMatchObject({ code: "authority_mismatch" } satisfies Partial<MeshEnvelopeError>);
		expect(signingCalls).toBe(0);
		await expect(signTaskContract(task(), signer("human", TASK_KEY_ID, "z".repeat(64)), { signedAt: SIGNED_AT })).rejects.toMatchObject({
			code: "authority_mismatch",
		} satisfies Partial<MeshEnvelopeError>);
	});
});
