import {
	canonicalizeJson,
	parseExecutionReceipt,
	toImmutableJson,
	type ExecutionReceiptV1,
	type JsonRecord,
} from "@pk-nerdsaver-ai/mesh-contracts";

import { ReceiptSignatureError } from "./errors";

export const RECEIPT_SIGNING_PAYLOAD_SCHEMA = "ompk.execution-receipt-signing-payload/v1" as const;
export const RECEIPT_SIGNATURE_ENVELOPE_SCHEMA = "ompk.execution-receipt-signature/v1" as const;

export interface ReceiptSigningPayloadV1 {
	readonly schemaVersion: typeof RECEIPT_SIGNING_PAYLOAD_SCHEMA;
	readonly receiptHash: string;
	readonly taskId: string;
	readonly taskDigest: string;
	readonly assignmentId: string;
	readonly schedulerEpoch: number;
	readonly fencingToken: number;
}

/** JSON-safe signature metadata. Signature bytes are transported as canonical base64. */
export interface ReceiptSignatureEnvelopeV1 {
	readonly schemaVersion: typeof RECEIPT_SIGNATURE_ENVELOPE_SCHEMA;
	readonly algorithm: string;
	readonly keyId: string;
	readonly signatureBytes: number;
	readonly signatureBase64: string;
}

export interface SignedExecutionReceiptV1 {
	readonly receipt: ExecutionReceiptV1;
	readonly signature: ReceiptSignatureEnvelopeV1;
}

/**
 * A caller-owned signing adapter. This package never receives or stores private
 * key material; it only supplies the canonical payload bytes.
 */
export interface ReceiptSigner {
	readonly algorithm: string;
	readonly keyId: string;
	sign(payload: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** A caller-owned verification adapter anchored to one expected key identity. */
export interface ReceiptSignatureVerifier {
	readonly algorithm: string;
	readonly keyId: string;
	verify(payload: Uint8Array, signature: Uint8Array): boolean | Promise<boolean>;
}

export type ReceiptSignatureVerificationFailureCode =
	| "invalid_receipt"
	| "invalid_signature_envelope"
	| "invalid_verifier"
	| "algorithm_mismatch"
	| "key_id_mismatch"
	| "signature_rejected"
	| "verifier_error";

export type ReceiptSignatureVerificationResult =
	| Readonly<{
			readonly ok: true;
			readonly receipt: ExecutionReceiptV1;
			readonly payload: ReceiptSigningPayloadV1;
			readonly signature: ReceiptSignatureEnvelopeV1;
		}>
	| Readonly<{
			readonly ok: false;
			readonly reason: ReceiptSignatureVerificationFailureCode;
		}>;

interface SignatureDescriptor {
	readonly algorithm: string;
	readonly keyId: string;
}

interface SignedReceiptInput {
	readonly receipt: unknown;
	readonly signature: unknown;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ENVELOPE_FIELDS = new Set(["schemaVersion", "algorithm", "keyId", "signatureBytes", "signatureBase64"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function requiredText(value: unknown, field: string, code: ReceiptSignatureError["code"]): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.trim() !== value) {
		throw new ReceiptSignatureError(code, `${field} must be a trimmed non-empty string of at most 256 characters`);
	}
	return value;
}

function descriptor(value: unknown, kind: "signer" | "verifier"): SignatureDescriptor {
	if (!isRecord(value)) throw new ReceiptSignatureError(kind === "signer" ? "invalid_signer" : "invalid_verifier", `${kind} must be an object`);
	const code = kind === "signer" ? "invalid_signer" : "invalid_verifier";
	const algorithm = requiredText(value.algorithm, `${kind}.algorithm`, code);
	const keyId = requiredText(value.keyId, `${kind}.keyId`, code);
	return Object.freeze({ algorithm, keyId });
}

function assertSigner(value: ReceiptSigner): SignatureDescriptor {
	const result = descriptor(value, "signer");
	if (typeof value.sign !== "function") throw new ReceiptSignatureError("invalid_signer", "signer.sign must be a function");
	return result;
}

function assertVerifier(value: ReceiptSignatureVerifier): SignatureDescriptor {
	const result = descriptor(value, "verifier");
	if (typeof value.verify !== "function") throw new ReceiptSignatureError("invalid_verifier", "verifier.verify must be a function");
	return result;
}

function payloadForReceipt(receipt: ExecutionReceiptV1): ReceiptSigningPayloadV1 {
	return Object.freeze({
		schemaVersion: RECEIPT_SIGNING_PAYLOAD_SCHEMA,
		receiptHash: receipt.receiptHash,
		taskId: receipt.taskId,
		taskDigest: receipt.taskDigest,
		assignmentId: receipt.assignmentId,
		schedulerEpoch: receipt.schedulerEpoch,
		fencingToken: receipt.fencingToken,
	});
}

function payloadBytes(payload: ReceiptSigningPayloadV1): Uint8Array {
	return new TextEncoder().encode(canonicalizeJson(payload));
}

function signedInput(value: unknown): SignedReceiptInput | undefined {
	if (!isRecord(value) || !hasOwn(value, "receipt") || !hasOwn(value, "signature")) return undefined;
	return Object.freeze({ receipt: value.receipt, signature: value.signature });
}

function verificationFailure(reason: ReceiptSignatureVerificationFailureCode): ReceiptSignatureVerificationResult {
	return Object.freeze({ ok: false, reason });
}

/**
 * Revalidates the receipt, including its self-hash, before extracting the fields
 * that a signature binds. No signer or verifier is called before this succeeds.
 */
export function createReceiptSigningPayload(receipt: unknown): ReceiptSigningPayloadV1 {
	return payloadForReceipt(parseExecutionReceipt(receipt));
}

export function canonicalReceiptSigningPayload(receipt: unknown): string {
	return canonicalizeJson(createReceiptSigningPayload(receipt));
}

export function receiptSigningPayloadBytes(receipt: unknown): Uint8Array {
	return payloadBytes(createReceiptSigningPayload(receipt));
}

/** Encodes signature bytes as RFC 4648 padded base64 for a portable envelope. */
export function encodeReceiptSignatureBase64(signature: Uint8Array): string {
	if (!(signature instanceof Uint8Array) || signature.byteLength === 0) {
		throw new ReceiptSignatureError("invalid_signature", "signature must be a non-empty Uint8Array");
	}
	let binary = "";
	for (const byte of signature) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Decodes only canonical RFC 4648 padded base64 to avoid alternate wire encodings. */
export function decodeReceiptSignatureBase64(signatureBase64: string): Uint8Array {
	if (typeof signatureBase64 !== "string" || signatureBase64.length === 0 || !BASE64.test(signatureBase64)) {
		throw new ReceiptSignatureError("invalid_signature_envelope", "signatureBase64 must be non-empty canonical padded base64");
	}
	let binary: string;
	try {
		binary = atob(signatureBase64);
	} catch {
		throw new ReceiptSignatureError("invalid_signature_envelope", "signatureBase64 is not valid base64");
	}
	const signature = Uint8Array.from(binary, character => character.charCodeAt(0));
	if (signature.byteLength === 0 || encodeReceiptSignatureBase64(signature) !== signatureBase64) {
		throw new ReceiptSignatureError("invalid_signature_envelope", "signatureBase64 must be canonical padded base64");
	}
	return signature;
}

export function parseReceiptSignatureEnvelope(input: unknown): ReceiptSignatureEnvelopeV1 {
	let normalized: JsonRecord;
	try {
		const immutable = toImmutableJson(input);
		if (!isRecord(immutable)) throw new ReceiptSignatureError("invalid_signature_envelope", "signature envelope must be an object");
		normalized = immutable as JsonRecord;
	} catch (error) {
		if (error instanceof ReceiptSignatureError) throw error;
		throw new ReceiptSignatureError("invalid_signature_envelope", "signature envelope must contain only JSON values");
	}
	for (const key of Object.keys(normalized)) {
		if (!ENVELOPE_FIELDS.has(key)) throw new ReceiptSignatureError("invalid_signature_envelope", `${key} is not permitted in a signature envelope`);
	}
	for (const key of ENVELOPE_FIELDS) {
		if (!hasOwn(normalized, key)) throw new ReceiptSignatureError("invalid_signature_envelope", `${key} is required in a signature envelope`);
	}
	if (normalized.schemaVersion !== RECEIPT_SIGNATURE_ENVELOPE_SCHEMA) {
		throw new ReceiptSignatureError("invalid_signature_envelope", `schemaVersion must be ${RECEIPT_SIGNATURE_ENVELOPE_SCHEMA}`);
	}
	const algorithm = requiredText(normalized.algorithm, "signature.algorithm", "invalid_signature_envelope");
	const keyId = requiredText(normalized.keyId, "signature.keyId", "invalid_signature_envelope");
	if (typeof normalized.signatureBytes !== "number" || !Number.isSafeInteger(normalized.signatureBytes) || normalized.signatureBytes <= 0) {
		throw new ReceiptSignatureError("invalid_signature_envelope", "signature.signatureBytes must be a positive safe integer");
	}
	if (typeof normalized.signatureBase64 !== "string") {
		throw new ReceiptSignatureError("invalid_signature_envelope", "signature.signatureBase64 must be a string");
	}
	const signature = decodeReceiptSignatureBase64(normalized.signatureBase64);
	if (signature.byteLength !== normalized.signatureBytes) {
		throw new ReceiptSignatureError("invalid_signature_envelope", "signature.signatureBytes does not match signatureBase64");
	}
	return Object.freeze({
		schemaVersion: RECEIPT_SIGNATURE_ENVELOPE_SCHEMA,
		algorithm,
		keyId,
		signatureBytes: signature.byteLength,
		signatureBase64: normalized.signatureBase64,
	});
}

/**
 * Signs a hash-validated receipt through the injected adapter. It has no
 * cryptographic implementation or private-key storage of its own.
 */
export async function signExecutionReceipt(receipt: unknown, signer: ReceiptSigner): Promise<SignedExecutionReceiptV1> {
	const parsedReceipt = parseExecutionReceipt(receipt);
	const payload = payloadForReceipt(parsedReceipt);
	const signerDescriptor = assertSigner(signer);
	const signature = await signer.sign(payloadBytes(payload));
	if (!(signature instanceof Uint8Array) || signature.byteLength === 0) {
		throw new ReceiptSignatureError("invalid_signature", "signer.sign must return a non-empty Uint8Array");
	}
	const signatureBase64 = encodeReceiptSignatureBase64(signature);
	return Object.freeze({
		receipt: parsedReceipt,
		signature: Object.freeze({
			schemaVersion: RECEIPT_SIGNATURE_ENVELOPE_SCHEMA,
			algorithm: signerDescriptor.algorithm,
			keyId: signerDescriptor.keyId,
			signatureBytes: signature.byteLength,
			signatureBase64,
		}),
	});
}

/**
 * Verifies a signed receipt without throwing for untrusted input. Every parse,
 * identity, algorithm, decoding, or verifier failure is an explicit denial.
 */
export async function verifySignedExecutionReceipt(input: unknown, verifier: ReceiptSignatureVerifier): Promise<ReceiptSignatureVerificationResult> {
	const signed = signedInput(input);
	if (signed === undefined) return verificationFailure("invalid_receipt");

	let receipt: ExecutionReceiptV1;
	try {
		receipt = parseExecutionReceipt(signed.receipt);
	} catch {
		return verificationFailure("invalid_receipt");
	}

	let envelope: ReceiptSignatureEnvelopeV1;
	try {
		envelope = parseReceiptSignatureEnvelope(signed.signature);
	} catch {
		return verificationFailure("invalid_signature_envelope");
	}

	let expected: SignatureDescriptor;
	try {
		expected = assertVerifier(verifier);
	} catch {
		return verificationFailure("invalid_verifier");
	}
	if (envelope.algorithm !== expected.algorithm) return verificationFailure("algorithm_mismatch");
	if (envelope.keyId !== expected.keyId) return verificationFailure("key_id_mismatch");

	const payload = payloadForReceipt(receipt);
	let signature: Uint8Array;
	try {
		signature = decodeReceiptSignatureBase64(envelope.signatureBase64);
	} catch {
		return verificationFailure("invalid_signature_envelope");
	}
	try {
		if ((await verifier.verify(payloadBytes(payload), signature)) !== true) return verificationFailure("signature_rejected");
	} catch {
		return verificationFailure("verifier_error");
	}
	return Object.freeze({ ok: true, receipt, payload, signature: envelope });
}
