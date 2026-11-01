import { existsSync } from "node:fs";

/**
 * Type-safe filesystem error handling utilities.
 *
 * Use these to check error codes without string matching on messages:
 *
 * @example
 * ```ts
 * import { isEnoent, isFsError } from "@pk-nerdsaver-ai/pi-utils";
 *
 * try {
 *     return await Bun.file(path).text();
 * } catch (err) {
 *     if (isEnoent(err)) return null;
 *     throw err;
 * }
 * ```
 */

export interface FsError extends Error {
	code: string;
	errno?: number;
	syscall?: string;
	path?: string;
}

export function isFsError(err: unknown): err is FsError {
	return err instanceof Error && "code" in err && typeof (err as FsError).code === "string";
}

export function isEnoent(err: unknown): err is FsError {
	return isFsError(err) && err.code === "ENOENT";
}

export function isEacces(err: unknown): err is FsError {
	return isFsError(err) && err.code === "EACCES";
}

export function isEisdir(err: unknown): err is FsError {
	return isFsError(err) && err.code === "EISDIR";
}

export function isEnotdir(err: unknown): err is FsError {
	return isFsError(err) && err.code === "ENOTDIR";
}

export function isEexist(err: unknown): err is FsError {
	return isFsError(err) && err.code === "EEXIST";
}

export function isEnotempty(err: unknown): err is FsError {
	return isFsError(err) && err.code === "ENOTEMPTY";
}

export function hasFsCode(err: unknown, code: string): err is FsError {
	return isFsError(err) && err.code === code;
}

/**
 * True when a filesystem operation failed because `targetPath` does not
 * resolve to anything. Covers ENOENT and ENOTDIR outright, and for any other
 * error — notably the `EUNKNOWN` that Bun's Windows file layer reports when
 * opening a dangling symlink or junction — falls back to a direct existence
 * check on `targetPath`. Use at "read a file that may not exist" call sites
 * where treating an unresolvable path as absent is the correct behavior;
 * errors on paths that still exist are NOT treated as missing.
 */
export function isFsMissing(err: unknown, targetPath: string): boolean {
	if (isEnoent(err) || isEnotdir(err)) return true;
	if (!isFsError(err)) return false;
	return !existsSync(targetPath);
}
