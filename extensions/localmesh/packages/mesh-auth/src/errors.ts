export type MeshEnvelopeErrorCode =
	| "authority_mismatch"
	| "invalid_envelope"
	| "invalid_payload"
	| "invalid_signature"
	| "invalid_signature_envelope"
	| "invalid_signer"
	| "invalid_verifier"
	| "payload_digest_mismatch";

/** Safe-to-log error: it deliberately contains no payload, signature, or key material. */
export class MeshEnvelopeError extends Error {
	readonly code: MeshEnvelopeErrorCode;

	constructor(code: MeshEnvelopeErrorCode, message: string) {
		super(message);
		this.name = "MeshEnvelopeError";
		this.code = code;
	}
}
