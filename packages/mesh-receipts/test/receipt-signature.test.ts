import { expect, test } from "bun:test";
import {
	MESH_SCHEMA,
	MeshValidationError,
	contractDigest,
	parseExecutionReceipt,
	type ExecutionReceiptV1,
	type JsonRecord,
} from "@pk-nerdsaver-ai/mesh-contracts";

import {
	canonicalReceiptSigningPayload,
	createReceiptSigningPayload,
	decodeReceiptSignatureBase64,
	signExecutionReceipt,
	verifySignedExecutionReceipt,
	type ReceiptSignatureVerifier,
	type ReceiptSigner,
} from "../src";

const TEST_KEY_ID = "test-worker-key-alpha";
const TEST_ALGORITHM = "test-deterministic-v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function digest(value: Record<string, unknown>, field: string): string {
	return contractDigest(value as unknown as JsonRecord, field);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/** Deterministic test-only adapter: it deliberately is not cryptography. */
function deterministicSignature(payload: Uint8Array, keyId: string): Uint8Array {
	return encoder.encode(`${keyId}:${decoder.decode(payload).split("").reverse().join("")}`);
}

function deterministicSigner(keyId = TEST_KEY_ID, onSign?: () => void): ReceiptSigner {
	return {
		algorithm: TEST_ALGORITHM,
		keyId,
		sign(payload) {
			onSign?.();
			return deterministicSignature(payload, keyId);
		},
	};
}

function deterministicVerifier(keyId = TEST_KEY_ID, onVerify?: () => void): ReceiptSignatureVerifier {
	return {
		algorithm: TEST_ALGORITHM,
		keyId,
		verify(payload, signature) {
			onVerify?.();
			return bytesEqual(signature, deterministicSignature(payload, keyId));
		},
	};
}

function receipt(): ExecutionReceiptV1 {
	const body = {
		schemaVersion: MESH_SCHEMA.receipt,
		receiptId: "rcpt_signed-receipt-one",
		taskId: "task_signed-receipt-one",
		taskDigest: "a".repeat(64),
		assignmentId: "asg_signed-receipt-one",
		schedulerEpoch: 7,
		fencingToken: 19,
		worker: { pubkey: "worker-public-key-signed-001", role: "worker", nodeId: "node_signed-worker-one" },
		nodeId: "node_signed-worker-one",
		startedAt: "2026-08-31T12:00:00.000Z",
		endedAt: "2026-08-31T12:00:10.000Z",
		outcome: "succeeded" as const,
		execution: {},
		artifacts: [],
		evidence: [],
		validation: {},
		resourceUsage: {},
		cost: {},
		cleanup: {},
	};
	return parseExecutionReceipt({ ...body, receiptHash: digest(body, "receiptHash") });
}

test("signs and verifies the canonical receipt-bound payload through injected adapters", async () => {
	const signed = await signExecutionReceipt(receipt(), deterministicSigner());
	const result = await verifySignedExecutionReceipt(signed, deterministicVerifier());

	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(`expected valid signature, received ${result.reason}`);
	expect(result.payload).toEqual(createReceiptSigningPayload(signed.receipt));
	expect(result.payload).toMatchObject({
		receiptHash: signed.receipt.receiptHash,
		taskId: signed.receipt.taskId,
		assignmentId: signed.receipt.assignmentId,
		schedulerEpoch: signed.receipt.schedulerEpoch,
		fencingToken: signed.receipt.fencingToken,
	});
	expect(canonicalReceiptSigningPayload(signed.receipt)).toContain(signed.receipt.receiptHash);
	expect(decodeReceiptSignatureBase64(signed.signature.signatureBase64).byteLength).toBe(signed.signature.signatureBytes);
});

test("rejects a receipt altered after signing even when its self-hash is recomputed", async () => {
	const signed = await signExecutionReceipt(receipt(), deterministicSigner());
	const { receiptHash: ignoredReceiptHash, ...withoutHash } = signed.receipt;
	const tamperedBody = { ...withoutHash, outcome: "failed" as const };
	const tamperedReceipt = { ...tamperedBody, receiptHash: digest(tamperedBody, "receiptHash") };
	const result = await verifySignedExecutionReceipt({ receipt: tamperedReceipt, signature: signed.signature }, deterministicVerifier());

	void ignoredReceiptHash;
	expect(result).toEqual({ ok: false, reason: "signature_rejected" });
});

test("rejects a signature whose key identity does not match the trusted verifier", async () => {
	const signed = await signExecutionReceipt(receipt(), deterministicSigner());
	let verificationCalls = 0;
	const result = await verifySignedExecutionReceipt(
		signed,
		deterministicVerifier("test-worker-key-beta", () => {
			verificationCalls += 1;
		}),
	);

	expect(result).toEqual({ ok: false, reason: "key_id_mismatch" });
	expect(verificationCalls).toBe(0);
});

test("refuses an invalid receipt before calling a signer or verifier", async () => {
	const invalidReceipt = { ...receipt(), receiptHash: "0".repeat(64) };
	let signingCalls = 0;
	await expect(
		signExecutionReceipt(
			invalidReceipt,
			deterministicSigner(TEST_KEY_ID, () => {
				signingCalls += 1;
			}),
		),
	).rejects.toBeInstanceOf(MeshValidationError);
	expect(signingCalls).toBe(0);

	const signed = await signExecutionReceipt(receipt(), deterministicSigner());
	let verificationCalls = 0;
	const result = await verifySignedExecutionReceipt(
		{ receipt: invalidReceipt, signature: signed.signature },
		deterministicVerifier(TEST_KEY_ID, () => {
			verificationCalls += 1;
		}),
	);
	expect(result).toEqual({ ok: false, reason: "invalid_receipt" });
	expect(verificationCalls).toBe(0);
});
