export type ReceiptSignatureErrorCode =
	| "invalid_signer"
	| "invalid_verifier"
	| "invalid_signature"
	| "invalid_signature_envelope";

/** A safe-to-log error for receipt-signature construction or envelope parsing. */
export class ReceiptSignatureError extends Error {
	readonly code: ReceiptSignatureErrorCode;

	constructor(code: ReceiptSignatureErrorCode, message: string) {
		super(message);
		this.name = "ReceiptSignatureError";
		this.code = code;
	}
}
