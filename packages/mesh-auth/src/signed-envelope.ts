import {
	MESH_SCHEMA,
	canonicalizeJson,
	parseAssignmentLease,
	parseMeshContract,
	parseTaskContract,
	sha256CanonicalJson,
	toImmutableJson,
	type AssignmentLeaseV1,
	type MeshContractV1,
	type MeshRole,
	type MeshSchemaVersion,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";

import { MeshEnvelopeError, type MeshEnvelopeErrorCode } from "./errors";

export const MESH_SIGNED_ENVELOPE_SCHEMA = "ompk.signed-mesh-envelope/v1" as const;
export const MESH_ENVELOPE_SIGNING_PAYLOAD_SCHEMA = "ompk.mesh-envelope-signing-payload/v1" as const;
export const MESH_SIGNATURE_ENVELOPE_SCHEMA = "ompk.mesh-signature-envelope/v1" as const;

/** Roles permitted to author a root task. A signature remains origin evidence, not authorization. */
export const TASK_REQUESTER_AUTHOR_ROLES = Object.freeze(["human", "orchestrator", "agent", "service"] as const);

export interface MeshSignatureMetadataV1 {
	readonly algorithm: string;
	readonly keyId: string;
	/** Public identity represented by this signing key; it is bound to the claimed contract actor. */
	readonly actorPubkey: string;
	readonly role: MeshRole;
	readonly signedAt: string;
}

/** JSON-safe, portable signature data. The key itself never enters this package. */
export interface MeshSignatureEnvelopeV1 extends MeshSignatureMetadataV1 {
	readonly schemaVersion: typeof MESH_SIGNATURE_ENVELOPE_SCHEMA;
	readonly signatureBytes: number;
	readonly signatureBase64: string;
}

/** An immutable contract plus a signature that binds its canonical payload hash and signer identity. */
export interface SignedMeshEnvelopeV1<TPayload extends MeshContractV1 = MeshContractV1> {
	readonly schemaVersion: typeof MESH_SIGNED_ENVELOPE_SCHEMA;
	readonly payload: TPayload;
	readonly payloadDigest: string;
	readonly signature: MeshSignatureEnvelopeV1;
}

/** The exact portable object turned into UTF-8 bytes for every signature operation. */
export interface MeshEnvelopeSigningPayloadV1 {
	readonly schemaVersion: typeof MESH_ENVELOPE_SIGNING_PAYLOAD_SCHEMA;
	readonly envelopeSchemaVersion: typeof MESH_SIGNED_ENVELOPE_SCHEMA;
	readonly payloadSchemaVersion: MeshSchemaVersion;
	readonly payloadDigest: string;
	readonly signer: MeshSignatureMetadataV1;
}

/** A caller-owned signing adapter. It must never expose or return private key material. */
export interface MeshEnvelopeSigner {
	readonly algorithm: string;
	readonly keyId: string;
	readonly actorPubkey: string;
	readonly role: MeshRole;
	sign(payload: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** A caller-owned verifier bound to precisely one trusted signer identity. */
export interface MeshEnvelopeVerifier {
	readonly algorithm: string;
	readonly keyId: string;
	readonly actorPubkey: string;
	readonly role: MeshRole;
	verify(payload: Uint8Array, signature: Uint8Array): boolean | Promise<boolean>;
}

/** The timestamp must come from the caller so production and tests can use their own trusted clock. */
export interface MeshEnvelopeSigningOptions {
	readonly signedAt: string;
}

export type MeshEnvelopeVerificationFailureCode =
	| "algorithm_mismatch"
	| "actor_pubkey_mismatch"
	| "authority_mismatch"
	| "invalid_envelope"
	| "invalid_payload"
	| "invalid_signature_envelope"
	| "invalid_verifier"
	| "key_id_mismatch"
	| "payload_digest_mismatch"
	| "payload_type_mismatch"
	| "role_mismatch"
	| "signature_rejected"
	| "verifier_error";

export interface MeshEnvelopeVerificationSuccess<TPayload extends MeshContractV1 = MeshContractV1> {
	readonly ok: true;
	readonly envelope: SignedMeshEnvelopeV1<TPayload>;
	readonly payload: TPayload;
	readonly signingPayload: MeshEnvelopeSigningPayloadV1;
}

export interface MeshEnvelopeVerificationFailure {
	readonly ok: false;
	readonly reason: MeshEnvelopeVerificationFailureCode;
}

export type MeshEnvelopeVerificationResult<TPayload extends MeshContractV1 = MeshContractV1> =
	| MeshEnvelopeVerificationSuccess<TPayload>
	| MeshEnvelopeVerificationFailure;

interface MeshSignerDescriptor {
	readonly algorithm: string;
	readonly keyId: string;
	readonly actorPubkey: string;
	readonly role: MeshRole;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
export const MAX_MESH_SIGNATURE_BYTES = 16 * 1024;
const MAX_MESH_SIGNATURE_BASE64_CHARS = 4 * Math.ceil(MAX_MESH_SIGNATURE_BYTES / 3);
const MESH_ROLES = new Set<MeshRole>(["human", "orchestrator", "scheduler", "node", "worker", "agent", "tool", "service", "validator"]);
const TASK_REQUESTER_ROLE_SET = new Set<MeshRole>(TASK_REQUESTER_AUTHOR_ROLES);
const ENVELOPE_FIELDS = new Set(["schemaVersion", "payload", "payloadDigest", "signature"]);
const SIGNATURE_FIELDS = new Set(["schemaVersion", "algorithm", "keyId", "actorPubkey", "role", "signedAt", "signatureBytes", "signatureBase64"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function error(code: MeshEnvelopeErrorCode, message: string): never {
	throw new MeshEnvelopeError(code, message);
}

function requiredText(value: unknown, field: string, code: MeshEnvelopeErrorCode): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.trim() !== value) {
		error(code, `${field} must be a trimmed non-empty string of at most 256 characters`);
	}
	return value;
}

function requiredTimestamp(value: unknown, field: string, code: MeshEnvelopeErrorCode): string {
	const timestamp = requiredText(value, field, code);
	if (!ISO_TIMESTAMP.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
		error(code, `${field} must be an ISO-8601 timestamp with timezone`);
	}
	return timestamp;
}

function requiredRole(value: unknown, field: string, code: MeshEnvelopeErrorCode): MeshRole {
	const role = requiredText(value, field, code);
	if (!MESH_ROLES.has(role as MeshRole)) error(code, `${field} must be a known mesh role`);
	return role as MeshRole;
}

function requiredActorPubkey(value: unknown, field: string, code: MeshEnvelopeErrorCode): string {
	const pubkey = requiredText(value, field, code);
	if (pubkey.length < 16 || pubkey.length > 200) {
		error(code, `${field} must be 16-200 characters`);
	}
	return pubkey;
}

function immutableRecord(input: unknown, code: MeshEnvelopeErrorCode, label: string): Readonly<Record<string, unknown>> {
	try {
		const immutable = toImmutableJson(input);
		if (!isRecord(immutable)) error(code, `${label} must be an object`);
		return immutable;
	} catch (cause) {
		if (cause instanceof MeshEnvelopeError) throw cause;
		error(code, `${label} must contain only immutable JSON values`);
	}
}

function assertExactFields(record: Readonly<Record<string, unknown>>, fields: ReadonlySet<string>, code: MeshEnvelopeErrorCode, label: string): void {
	for (const key of Object.keys(record)) {
		if (!fields.has(key)) error(code, `${label}.${key} is not permitted`);
	}
	for (const key of fields) {
		if (!hasOwn(record, key)) error(code, `${label}.${key} is required`);
	}
}

function parsePayload(input: unknown): MeshContractV1 {
	try {
		return parseMeshContract(input);
	} catch {
		error("invalid_payload", "payload must be a valid, digest-verified mesh contract");
	}
}

function parseTaskPayload(input: unknown): TaskContractV1 {
	try {
		return parseTaskContract(input);
	} catch {
		error("invalid_payload", "payload must be a valid, digest-verified task contract");
	}
}

function parseAssignmentPayload(input: unknown): AssignmentLeaseV1 {
	try {
		return parseAssignmentLease(input);
	} catch {
		error("invalid_payload", "payload must be a valid assignment lease");
	}
}

function parseSignerDescriptor(input: unknown, kind: "signer" | "verifier"): MeshSignerDescriptor {
	const code = kind === "signer" ? "invalid_signer" : "invalid_verifier";
	if (!isRecord(input)) error(code, `${kind} must be an object`);
	return Object.freeze({
		algorithm: requiredText(input.algorithm, `${kind}.algorithm`, code),
		keyId: requiredText(input.keyId, `${kind}.keyId`, code),
		actorPubkey: requiredActorPubkey(input.actorPubkey, `${kind}.actorPubkey`, code),
		role: requiredRole(input.role, `${kind}.role`, code),
	});
}

function assertSigner(signer: MeshEnvelopeSigner): MeshSignerDescriptor {
	const descriptor = parseSignerDescriptor(signer, "signer");
	if (typeof signer.sign !== "function") error("invalid_signer", "signer.sign must be a function");
	return descriptor;
}

function assertVerifier(verifier: MeshEnvelopeVerifier): MeshSignerDescriptor {
	const descriptor = parseSignerDescriptor(verifier, "verifier");
	if (typeof verifier.verify !== "function") error("invalid_verifier", "verifier.verify must be a function");
	return descriptor;
}

function parseSigningMetadata(input: unknown, code: MeshEnvelopeErrorCode, label: string): MeshSignatureMetadataV1 {
	if (!isRecord(input)) error(code, `${label} must be an object`);
	return Object.freeze({
		algorithm: requiredText(input.algorithm, `${label}.algorithm`, code),
		keyId: requiredText(input.keyId, `${label}.keyId`, code),
		actorPubkey: requiredActorPubkey(input.actorPubkey, `${label}.actorPubkey`, code),
		role: requiredRole(input.role, `${label}.role`, code),
		signedAt: requiredTimestamp(input.signedAt, `${label}.signedAt`, code),
	});
}

function signingMetadataFor(signer: MeshEnvelopeSigner, options: MeshEnvelopeSigningOptions): MeshSignatureMetadataV1 {
	const descriptor = assertSigner(signer);
	if (!isRecord(options)) error("invalid_signer", "signing options must be an object");
	return Object.freeze({
		...descriptor,
		signedAt: requiredTimestamp(options.signedAt, "signingOptions.signedAt", "invalid_signer"),
	});
}

function isTaskPayload(payload: MeshContractV1): payload is TaskContractV1 {
	return payload.schemaVersion === MESH_SCHEMA.task;
}

function isAssignmentPayload(payload: MeshContractV1): payload is AssignmentLeaseV1 {
	return payload.schemaVersion === MESH_SCHEMA.assignment;
}

function isTaskEnvelope(envelope: SignedMeshEnvelopeV1): envelope is SignedMeshEnvelopeV1<TaskContractV1> {
	return isTaskPayload(envelope.payload);
}

function isAssignmentEnvelope(envelope: SignedMeshEnvelopeV1): envelope is SignedMeshEnvelopeV1<AssignmentLeaseV1> {
	return isAssignmentPayload(envelope.payload);
}

/** Enforces signed origin identity and role binding; authorization remains local-policy/delegation work. */
function assertPayloadAuthorityBinding(payload: MeshContractV1, signer: MeshSignatureMetadataV1): void {
	if (isTaskPayload(payload)) {
		if (!TASK_REQUESTER_ROLE_SET.has(payload.requester.role)) {
			error("authority_mismatch", "task requester must hold a task-author role");
		}
		if (signer.role !== payload.requester.role) {
			error("authority_mismatch", "task signature role must match the requester role");
		}
		if (signer.actorPubkey !== payload.requester.pubkey) {
			error("authority_mismatch", "task signature identity must match the requester public key");
		}
		return;
	}
	if (isAssignmentPayload(payload)) {
		if (payload.scheduler.role !== "scheduler" || signer.role !== "scheduler") {
			error("authority_mismatch", "assignment lease signatures require a scheduler role");
		}
		if (signer.actorPubkey !== payload.scheduler.pubkey) {
			error("authority_mismatch", "assignment signature identity must match the scheduler public key");
		}
	}
}

function signingPayloadFor(payload: MeshContractV1, payloadDigest: string, signer: MeshSignatureMetadataV1): MeshEnvelopeSigningPayloadV1 {
	return Object.freeze({
		schemaVersion: MESH_ENVELOPE_SIGNING_PAYLOAD_SCHEMA,
		envelopeSchemaVersion: MESH_SIGNED_ENVELOPE_SCHEMA,
		payloadSchemaVersion: payload.schemaVersion,
		payloadDigest,
		// Bind only the four protocol fields.  The outer signature envelope adds
		// encoding fields after signing; including those would change the bytes a
		// verifier reconstructs and make a valid signature unverifiable.
		signer: Object.freeze({
			algorithm: signer.algorithm,
			keyId: signer.keyId,
			actorPubkey: signer.actorPubkey,
			role: signer.role,
			signedAt: signer.signedAt,
		}),
	});
}

function signingPayloadBytesFor(payload: MeshContractV1, payloadDigest: string, signer: MeshSignatureMetadataV1): Uint8Array {
	return new TextEncoder().encode(canonicalizeJson(signingPayloadFor(payload, payloadDigest, signer)));
}

/** Encodes non-empty signature bytes as canonical RFC 4648 padded base64. */
export function encodeMeshSignatureBase64(signature: Uint8Array): string {
	if (!(signature instanceof Uint8Array) || signature.byteLength === 0 || signature.byteLength > MAX_MESH_SIGNATURE_BYTES) {
		error("invalid_signature", `signature must be a non-empty Uint8Array no larger than ${MAX_MESH_SIGNATURE_BYTES} bytes`);
	}
	let binary = "";
	for (const byte of signature) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Rejects alternate, unpadded, or malformed base64 representations. */
export function decodeMeshSignatureBase64(signatureBase64: string): Uint8Array {
	if (
		typeof signatureBase64 !== "string" ||
		signatureBase64.length === 0 ||
		signatureBase64.length > MAX_MESH_SIGNATURE_BASE64_CHARS ||
		!BASE64.test(signatureBase64)
	) {
		error("invalid_signature_envelope", `signatureBase64 must be non-empty canonical padded base64 no larger than ${MAX_MESH_SIGNATURE_BYTES} bytes`);
	}
	let binary: string;
	try {
		binary = atob(signatureBase64);
	} catch {
		error("invalid_signature_envelope", "signatureBase64 is not valid base64");
	}
	const signature = Uint8Array.from(binary, character => character.charCodeAt(0));
	if (signature.byteLength === 0 || signature.byteLength > MAX_MESH_SIGNATURE_BYTES || encodeMeshSignatureBase64(signature) !== signatureBase64) {
		error("invalid_signature_envelope", "signatureBase64 must be canonical padded base64");
	}
	return signature;
}

export function parseMeshSignatureEnvelope(input: unknown): MeshSignatureEnvelopeV1 {
	const record = immutableRecord(input, "invalid_signature_envelope", "signature");
	assertExactFields(record, SIGNATURE_FIELDS, "invalid_signature_envelope", "signature");
	if (record.schemaVersion !== MESH_SIGNATURE_ENVELOPE_SCHEMA) {
		error("invalid_signature_envelope", `signature.schemaVersion must be ${MESH_SIGNATURE_ENVELOPE_SCHEMA}`);
	}
	const metadata = parseSigningMetadata(record, "invalid_signature_envelope", "signature");
	if (
		typeof record.signatureBytes !== "number" ||
		!Number.isSafeInteger(record.signatureBytes) ||
		record.signatureBytes <= 0 ||
		record.signatureBytes > MAX_MESH_SIGNATURE_BYTES
	) {
		error("invalid_signature_envelope", `signature.signatureBytes must be a positive safe integer no larger than ${MAX_MESH_SIGNATURE_BYTES}`);
	}
	if (typeof record.signatureBase64 !== "string") error("invalid_signature_envelope", "signature.signatureBase64 must be a string");
	const signature = decodeMeshSignatureBase64(record.signatureBase64);
	if (signature.byteLength !== record.signatureBytes) {
		error("invalid_signature_envelope", "signature.signatureBytes does not match signatureBase64");
	}
	return Object.freeze({
		schemaVersion: MESH_SIGNATURE_ENVELOPE_SCHEMA,
		...metadata,
		signatureBytes: signature.byteLength,
		signatureBase64: record.signatureBase64,
	});
}

/**
 * Parses a portable signed envelope, revalidates the payload digest, and
 * applies the root-task and scheduler-origin role bindings before verification.
 */
export function parseSignedMeshEnvelope(input: unknown): SignedMeshEnvelopeV1 {
	const record = immutableRecord(input, "invalid_envelope", "signed envelope");
	assertExactFields(record, ENVELOPE_FIELDS, "invalid_envelope", "signed envelope");
	if (record.schemaVersion !== MESH_SIGNED_ENVELOPE_SCHEMA) {
		error("invalid_envelope", `signed envelope.schemaVersion must be ${MESH_SIGNED_ENVELOPE_SCHEMA}`);
	}
	const payload = parsePayload(record.payload);
	if (typeof record.payloadDigest !== "string" || !SHA256.test(record.payloadDigest)) {
		error("invalid_envelope", "signed envelope.payloadDigest must be a lowercase SHA-256 digest");
	}
	if (sha256CanonicalJson(payload) !== record.payloadDigest) {
		error("payload_digest_mismatch", "signed envelope.payloadDigest does not match the canonical payload");
	}
	const signature = parseMeshSignatureEnvelope(record.signature);
	assertPayloadAuthorityBinding(payload, signature);
	return Object.freeze({
		schemaVersion: MESH_SIGNED_ENVELOPE_SCHEMA,
		payload,
		payloadDigest: record.payloadDigest,
		signature,
	});
}

/** Creates the fixed, canonical signing object from a validated payload and signer metadata. */
export function createMeshEnvelopeSigningPayload(payload: MeshContractV1, signer: MeshSignatureMetadataV1): MeshEnvelopeSigningPayloadV1 {
	const parsedPayload = parsePayload(payload);
	const parsedSigner = parseSigningMetadata(signer, "invalid_envelope", "signer");
	assertPayloadAuthorityBinding(parsedPayload, parsedSigner);
	return signingPayloadFor(parsedPayload, sha256CanonicalJson(parsedPayload), parsedSigner);
}

export function canonicalMeshEnvelopeSigningPayload(payload: MeshContractV1, signer: MeshSignatureMetadataV1): string {
	return canonicalizeJson(createMeshEnvelopeSigningPayload(payload, signer));
}

export function meshEnvelopeSigningPayloadBytes(payload: MeshContractV1, signer: MeshSignatureMetadataV1): Uint8Array {
	return new TextEncoder().encode(canonicalMeshEnvelopeSigningPayload(payload, signer));
}

async function signValidatedMeshEnvelope<TPayload extends MeshContractV1>(
	payload: TPayload,
	signer: MeshEnvelopeSigner,
	options: MeshEnvelopeSigningOptions,
): Promise<SignedMeshEnvelopeV1<TPayload>> {
	const metadata = signingMetadataFor(signer, options);
	assertPayloadAuthorityBinding(payload, metadata);
	const payloadDigest = sha256CanonicalJson(payload);
	const signature = await signer.sign(signingPayloadBytesFor(payload, payloadDigest, metadata));
	if (!(signature instanceof Uint8Array) || signature.byteLength === 0) {
		error("invalid_signature", "signer.sign must return a non-empty Uint8Array");
	}
	const signatureBase64 = encodeMeshSignatureBase64(signature);
	return Object.freeze({
		schemaVersion: MESH_SIGNED_ENVELOPE_SCHEMA,
		payload,
		payloadDigest,
		signature: Object.freeze({
			schemaVersion: MESH_SIGNATURE_ENVELOPE_SCHEMA,
			...metadata,
			signatureBytes: signature.byteLength,
			signatureBase64,
		}),
	});
}

/** Signs an already-parsed mesh contract through an injected signing adapter. */
export async function signMeshEnvelope(
	payload: MeshContractV1,
	signer: MeshEnvelopeSigner,
	options: MeshEnvelopeSigningOptions,
): Promise<SignedMeshEnvelopeV1> {
	return signValidatedMeshEnvelope(parsePayload(payload), signer, options);
}

export async function signTaskContract(
	task: TaskContractV1,
	signer: MeshEnvelopeSigner,
	options: MeshEnvelopeSigningOptions,
): Promise<SignedMeshEnvelopeV1<TaskContractV1>> {
	return signValidatedMeshEnvelope(parseTaskPayload(task), signer, options);
}

export async function signAssignmentLease(
	assignment: AssignmentLeaseV1,
	signer: MeshEnvelopeSigner,
	options: MeshEnvelopeSigningOptions,
): Promise<SignedMeshEnvelopeV1<AssignmentLeaseV1>> {
	return signValidatedMeshEnvelope(parseAssignmentPayload(assignment), signer, options);
}

function verificationFailure<TPayload extends MeshContractV1>(reason: MeshEnvelopeVerificationFailureCode): MeshEnvelopeVerificationResult<TPayload> {
	return Object.freeze({ ok: false, reason });
}

function verificationReason(errorValue: unknown): MeshEnvelopeVerificationFailureCode {
	if (!(errorValue instanceof MeshEnvelopeError)) return "invalid_envelope";
	switch (errorValue.code) {
		case "authority_mismatch":
		case "invalid_envelope":
		case "invalid_payload":
		case "invalid_signature_envelope":
		case "payload_digest_mismatch":
			return errorValue.code;
		default:
			return "invalid_envelope";
	}
}

/**
 * Verifies origin evidence without treating it as authorization. Invalid input,
 * metadata mismatch, and signature failure always deny and never throw.
 */
export async function verifySignedMeshEnvelope(input: unknown, verifier: MeshEnvelopeVerifier): Promise<MeshEnvelopeVerificationResult> {
	let envelope: SignedMeshEnvelopeV1;
	try {
		envelope = parseSignedMeshEnvelope(input);
	} catch (cause) {
		return verificationFailure(verificationReason(cause));
	}

	let expected: MeshSignerDescriptor;
	try {
		expected = assertVerifier(verifier);
	} catch {
		return verificationFailure("invalid_verifier");
	}
	if (envelope.signature.algorithm !== expected.algorithm) return verificationFailure("algorithm_mismatch");
	if (envelope.signature.keyId !== expected.keyId) return verificationFailure("key_id_mismatch");
	if (envelope.signature.actorPubkey !== expected.actorPubkey) return verificationFailure("actor_pubkey_mismatch");
	if (envelope.signature.role !== expected.role) return verificationFailure("role_mismatch");

	let signature: Uint8Array;
	try {
		signature = decodeMeshSignatureBase64(envelope.signature.signatureBase64);
	} catch {
		return verificationFailure("invalid_signature_envelope");
	}
	const signingPayload = signingPayloadFor(envelope.payload, envelope.payloadDigest, envelope.signature);
	try {
		if ((await verifier.verify(new TextEncoder().encode(canonicalizeJson(signingPayload)), signature)) !== true) {
			return verificationFailure("signature_rejected");
		}
	} catch {
		return verificationFailure("verifier_error");
	}
	return Object.freeze({
		ok: true,
		envelope,
		payload: envelope.payload,
		signingPayload,
	});
}

export async function verifySignedTaskContract(input: unknown, verifier: MeshEnvelopeVerifier): Promise<MeshEnvelopeVerificationResult<TaskContractV1>> {
	const result = await verifySignedMeshEnvelope(input, verifier);
	if (!result.ok) return verificationFailure(result.reason);
	if (!isTaskEnvelope(result.envelope)) return verificationFailure("payload_type_mismatch");
	return Object.freeze({
		ok: true,
		envelope: result.envelope,
		payload: result.envelope.payload,
		signingPayload: result.signingPayload,
	});
}

export async function verifySignedAssignmentLease(
	input: unknown,
	verifier: MeshEnvelopeVerifier,
): Promise<MeshEnvelopeVerificationResult<AssignmentLeaseV1>> {
	const result = await verifySignedMeshEnvelope(input, verifier);
	if (!result.ok) return verificationFailure(result.reason);
	if (!isAssignmentEnvelope(result.envelope)) return verificationFailure("payload_type_mismatch");
	return Object.freeze({
		ok: true,
		envelope: result.envelope,
		payload: result.envelope.payload,
		signingPayload: result.signingPayload,
	});
}
