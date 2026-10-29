/**
 * The HMAC key that binds approval codes and signed authorize forms.
 *
 * It lives at `<dataDir>/hmac.key` (0600): generated on first use, shared by
 * `pair` (minting) and `serve` (redeeming). A stolen database alone redeems
 * nothing; a stolen key file alone mints codes but cannot approve without a
 * browser in front of the gateway.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

export function signingKeyPath(dataDir: string): string {
	return path.join(dataDir, "hmac.key");
}

/** Load or create the 256-bit signing key for a data directory. */
export function loadOrCreateSigningKey(dataDir: string): string {
	const file = signingKeyPath(dataDir);
	if (existsSync(file)) {
		const key = readFileSync(file, "utf8").trim();
		if (key.length >= 32) return key;
	}
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const key = randomBytes(32).toString("base64url");
	writeFileSync(file, `${key}\n`, { mode: 0o600 });
	return key;
}
