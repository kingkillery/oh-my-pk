import { createHash } from "node:crypto";

import { ContentHashFormatError } from "./errors";

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function sha256Bytes(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

export function assertContentSha256(value: string): string {
	if (!SHA256_HEX.test(value)) throw new ContentHashFormatError("content SHA-256 must be lowercase hexadecimal");
	return value;
}

export function isContentSha256(value: string): boolean {
	return SHA256_HEX.test(value);
}
