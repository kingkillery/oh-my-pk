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
	if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return;
	throw new Error(`Refusing to use ${target}: it is outside ${path.resolve(root)}`);
}

const LOCK_STALE_MS = 30_000;

function lockPath(root: string): string {
	return path.join(root, ".agents", "continuity", "workstreams.lock");
}

/**
 * Hold the continuity lock for one critical section. The lock file is created
 * exclusively, so two saves cannot both read revision N and both write N+1.
 * A lock older than 30 seconds is treated as abandoned and replaced.
 */
export async function withContinuityLock<T>(root: string, body: () => Promise<T>): Promise<T> {
	const target = lockPath(root);
	assertWithinRoot(root, target);
	await fs.mkdir(path.dirname(target), { recursive: true });
	const started = Date.now();
	for (;;) {
		try {
			const handle = await fs.open(target, "wx");
			await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf-8");
			try {
				return await body();
			} finally {
				await handle.close();
				await fs.rm(target, { force: true });
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (Date.now() - started > LOCK_STALE_MS) {
				await fs.rm(target, { force: true });
				continue;
			}
			const held = await fs.stat(target).catch(() => undefined);
			if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
				await fs.rm(target, { force: true });
				continue;
			}
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}
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
		raw = await fs.readFile(indexPath(root), "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		throw error;
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
		if (typeof value.canonical !== "string" || !value.canonical.trim())
			return { kind: "corrupt", detail: `entry ${value.id} has no canonical path` };
		workstreams.push({
			id: value.id.trim(),
			title: typeof value.title === "string" && value.title.trim() ? value.title : value.id,
			aliases: Array.isArray(value.aliases)
				? value.aliases.filter((alias): alias is string => typeof alias === "string")
				: [],
			canonical: value.canonical,
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
	const target = indexPath(root);
	assertWithinRoot(root, target);
	await writeFileAtomic(target, `${JSON.stringify(index, null, 2)}\n`);
}

export async function readTextIfPresent(target: string): Promise<string | undefined> {
	try {
		return await fs.readFile(target, "utf-8");
	} catch (error) {
		// ENOENT is absent; EISDIR is "present but not a readable file". Both mean
		// there is no prior record to compare against, so the caller writes and the
		// write itself reports the real failure.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EISDIR") return undefined;
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
	if (!workstreamId || workstreamId.includes("/") || workstreamId.includes("\\") || workstreamId.includes(".."))
		throw new Error(`Refusing to retain a revision for ${JSON.stringify(workstreamId)}: not a single path segment`);
	const target = path.join(root, ".agents", "continuity", "revisions", workstreamId, `r${revision}.md`);
	assertWithinRoot(root, target);

	await writeFileAtomic(target, text);
}
