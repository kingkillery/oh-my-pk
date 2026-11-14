import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkstreamEntry, WorkstreamIndex } from "./types";

export function indexPath(root: string): string {
	return path.join(root, ".agents", "continuity", "workstreams.json");
}

/**
 * Refuse a target that resolves outside the continuity root. The continuity tree
 * owns only what lives under it, so an index entry or workstream id can never
 * redirect a write elsewhere on disk.
 */
export function assertWithinRoot(root: string, target: string): void {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return;
	throw new Error(`Refusing to use ${target}: it is outside ${path.resolve(root)}`);
}

/** Validate existing ancestors too, so a symlink or junction cannot escape the owning root. */
export async function resolveWithinRoot(root: string, target: string): Promise<string> {
	const base = path.resolve(root);
	const resolved = path.resolve(base, target);
	assertWithinRoot(base, resolved);
	const realRoot = await fs.realpath(base);
	let current = resolved;
	for (;;) {
		try {
			const real = await fs.realpath(current);
			if (real !== realRoot) assertWithinRoot(realRoot, real);
			return path.join(real, path.relative(current, resolved));
		} catch (error) {
			if (!isMissingFile(error)) throw error;
			const parent = path.dirname(current);
			if (parent === current) throw error;
			current = parent;
		}
	}
}

export function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Bounded cooperative lock. Never steal an old lock: age does not prove its owner has stopped. */
export async function withFileLock<T>(target: string, body: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	const token = `${process.pid}:${randomUUID()}`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let handle: fs.FileHandle;
		try {
			handle = await fs.open(target, "wx");
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error)) throw error;
			const transientWindowsLock =
				process.platform === "win32" &&
				(error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY");
			if (error.code !== "EEXIST" && !transientWindowsLock) throw error;
			if (Date.now() >= deadline) {
				throw new Error(`Continuity lock busy: ${target}. Confirm its owner has stopped before removing it.`);
			}
			await Bun.sleep(25);
			continue;
		}
		try {
			await handle.writeFile(token, "utf-8");
			return await body();
		} finally {
			await handle.close();
			if ((await readTextIfPresent(target)) === token) await fs.rm(target);
		}
	}
}

export async function withContinuityLock<T>(root: string, body: () => Promise<T>): Promise<T> {
	const target = await resolveWithinRoot(root, path.join(root, ".agents", "continuity", "workstreams.lock"));
	return withFileLock(target, body);
}

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

export type IndexRead =
	| { kind: "ok"; index: WorkstreamIndex }
	| { kind: "missing" }
	| { kind: "corrupt"; detail: string };

export async function readIndex(root: string): Promise<IndexRead> {
	let raw: string;
	try {
		raw = await fs.readFile(await resolveWithinRoot(root, indexPath(root)), "utf-8");
	} catch (error) {
		if (isMissingFile(error)) return { kind: "missing" };
		return { kind: "corrupt", detail: error instanceof Error ? error.message : String(error) };
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return validateIndex(parsed);
	} catch (error) {
		return { kind: "corrupt", detail: error instanceof Error ? error.message : String(error) };
	}
}

function validateIndex(parsed: unknown): IndexRead {
	if (!parsed || typeof parsed !== "object") return { kind: "corrupt", detail: "index is not an object" };
	const candidate = parsed as Partial<WorkstreamIndex>;
	if (candidate.version !== 1)
		return { kind: "corrupt", detail: `unsupported index version: ${String(candidate.version)}` };
	if (!Array.isArray(candidate.workstreams)) return { kind: "corrupt", detail: "workstreams is not an array" };
	const workstreams: WorkstreamEntry[] = [];
	for (const [position, entry] of candidate.workstreams.entries()) {
		if (!entry || typeof entry !== "object") return { kind: "corrupt", detail: `entry ${position} is not an object` };
		const value = entry as Partial<WorkstreamEntry>;
		if (typeof value.id !== "string" || !value.id.trim())
			return { kind: "corrupt", detail: `entry ${position} has no id` };
		const id = value.id.trim();
		if (typeof value.canonical !== "string" || !value.canonical.trim())
			return { kind: "corrupt", detail: `entry ${value.id} has no canonical path` };
		if (value.store !== undefined && value.store !== "repo" && value.store !== "vault")
			return { kind: "corrupt", detail: `entry ${value.id} has an invalid store` };
		if (workstreams.some(existing => existing.id === id))
			return { kind: "corrupt", detail: `duplicate workstream id: ${id}` };
		workstreams.push({
			id,
			title: typeof value.title === "string" && value.title.trim() ? value.title : value.id,
			aliases: Array.isArray(value.aliases)
				? value.aliases.filter((alias): alias is string => typeof alias === "string")
				: [],
			canonical: value.canonical,
			...(value.store ? { store: value.store } : {}),
			...(typeof value.vault === "string" ? { vault: value.vault } : {}),
			...(typeof value.sha256 === "string" ? { sha256: value.sha256 } : {}),
			authority: value.authority === "snapshot" || value.authority === "historical" ? value.authority : "canonical",
			revision: typeof value.revision === "number" && Number.isFinite(value.revision) ? value.revision : 0,
			updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
			...(typeof value.evidenceObservedAt === "string" ? { evidenceObservedAt: value.evidenceObservedAt } : {}),
			...(Array.isArray(value.sourceSessions)
				? {
						sourceSessions: value.sourceSessions.filter(
							(session): session is string => typeof session === "string",
						),
					}
				: {}),
		});
	}
	return { kind: "ok", index: { version: 1, workstreams } };
}

/** Atomic replace: a temp file in the same directory, then a rename. */
export async function writeFileAtomic(target: string, text: string): Promise<void> {
	const directory = path.dirname(target);
	await fs.mkdir(directory, { recursive: true });
	const temporary = path.join(directory, `.${path.basename(target)}.tmp-${randomUUID()}`);
	await fs.writeFile(temporary, text, "utf-8");
	try {
		await fs.rename(temporary, target);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function writeIndex(root: string, index: WorkstreamIndex): Promise<void> {
	const target = await resolveWithinRoot(root, indexPath(root));
	await writeFileAtomic(target, `${JSON.stringify(index, null, 2)}\n`);
}

export async function readTextIfPresent(target: string): Promise<string | undefined> {
	try {
		return await fs.readFile(target, "utf-8");
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
}

/** Retain the outgoing revision so a guard never destroys prior work. */
export async function retainRevision(
	root: string,
	workstreamId: string,
	revision: number,
	text: string,
): Promise<void> {
	assertWorkstreamId(workstreamId);
	const target = await resolveWithinRoot(
		root,
		path.join(root, ".agents", "continuity", "revisions", workstreamId, `r${revision}.md`),
	);
	await retainFile(target, text);
}

export function assertWorkstreamId(id: string): void {
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) ||
		id.endsWith(".") ||
		/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)
	)
		throw new Error(`Invalid workstream id: ${JSON.stringify(id)}; use a portable single path segment.`);
}

/** Revisions are immutable, including when a pointer update previously failed. */
export async function retainFile(target: string, text: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true });
	const extension = path.extname(target);
	const alternate = `${target.slice(0, target.length - extension.length)}.${sha256(text)}${extension}`;
	// Repointing or an external edit can legitimately reuse a revision number.
	// Keep both byte sequences rather than overwriting history or wedging saves.
	for (const candidate of [target, alternate]) {
		const confined = await resolveWithinRoot(path.dirname(target), candidate);
		try {
			await fs.writeFile(confined, text, { encoding: "utf-8", flag: "wx" });
			return;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			if ((await fs.readFile(confined, "utf-8")) === text) return;
		}
	}
	throw new Error(`Retained revision digest conflict at ${alternate}`);
}
