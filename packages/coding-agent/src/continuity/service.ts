import * as path from "node:path";
import { ContinuityLocationError, type RecordLocation, registrationPointer, resolveRecord } from "./location";
import { contentSignature, openQuestions, parseHandoff, renderHandoff } from "./render";
import {
	assertWorkstreamId,
	indexPath,
	readIndex,
	readTextIfPresent,
	resolveWithinRoot,
	retainFile,
	retainRevision,
	sha256,
	withContinuityLock,
	withFileLock,
	writeFileAtomic,
	writeIndex,
} from "./store";
import type {
	ContinuityStatus,
	HandoffMeta,
	HandoffSectionKey,
	HandoffSections,
	RegisterOutcome,
	RegisterRequest,
	ResolveCandidate,
	ResolveOutcome,
	ResumeOutcome,
	ResumeRequest,
	SaveOutcome,
	SaveRequest,
	WorkstreamEntry,
	WorkstreamIndex,
} from "./types";
import { HANDOFF_SECTIONS } from "./types";

const STOPWORDS: Record<string, true> = {
	a: true,
	an: true,
	and: true,
	are: true,
	at: true,
	for: true,
	from: true,
	in: true,
	is: true,
	it: true,
	let: true,
	lets: true,
	my: true,
	of: true,
	on: true,
	our: true,
	please: true,
	the: true,
	this: true,
	to: true,
	we: true,
	where: true,
	with: true,
	work: true,
	workstream: true,
	handoff: true,
	save: true,
	continue: true,
	resume: true,
	pick: true,
	up: true,
	again: true,
};

function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.split(" ")
		.map(token => token.trim())
		.filter(token => token.length > 0 && !STOPWORDS[token]);
}

function candidateTokens(entry: { id: string; title: string; aliases: string[] }): Set<string> {
	return new Set(tokens([entry.id.replace(/[-_]+/g, " "), entry.title, ...entry.aliases].join(" ")));
}

function toCandidate(entry: {
	id: string;
	title: string;
	canonical: string;
	authority: "canonical" | "snapshot" | "historical";
}): ResolveCandidate {
	return { id: entry.id, title: entry.title, canonical: entry.canonical, authority: entry.authority };
}

const CLARIFY = (intent: string, entries: WorkstreamIndex["workstreams"]): ResolveOutcome => ({
	status: "needs_clarification",
	intent,
	candidates: entries.map(toCandidate),
});

/**
 * Pure intent matching: exact forms first, then full token containment, then
 * graded overlap. Two equally good matches always ask rather than pick.
 */
export function matchWorkstream(index: WorkstreamIndex, intent: string): ResolveOutcome {
	const entries = index.workstreams;
	if (entries.length === 0) return { status: "not_found", intent };
	const wanted = tokens(intent);
	if (wanted.length === 0) {
		const only = entries[0];
		if (entries.length === 1 && only) return { status: "resolved", entry: only };
		return CLARIFY(intent, entries);
	}

	const decorated = entries.map(entry => ({ entry, known: candidateTokens(entry) }));
	// A phrase contained by two titles (a base name and its "- West" variant) is
	// genuinely ambiguous: ask instead of guessing which record the user meant.
	const contained = decorated.filter(row => wanted.every(token => row.known.has(token)));
	if (contained.length === 1 && contained[0]) return { status: "resolved", entry: contained[0].entry };
	if (contained.length > 1)
		return CLARIFY(
			intent,
			contained.map(row => row.entry),
		);

	const scored = decorated
		.map(row => ({ entry: row.entry, score: wanted.filter(token => row.known.has(token)).length / wanted.length }))
		.filter(row => row.score >= 0.6)
		.sort((left, right) => right.score - left.score);
	const best = scored[0];
	if (!best) return { status: "not_found", intent };
	const tied = scored.filter(row => Math.abs(row.score - best.score) < 1e-9);
	if (tied.length > 1)
		return CLARIFY(
			intent,
			tied.map(row => row.entry),
		);
	return { status: "resolved", entry: best.entry };
}

async function resolveWorkstream(
	root: string,
	intent: string | undefined,
	workstreamId: string | undefined,
): Promise<ResolveOutcome> {
	const read = await readIndex(root);
	if (read.kind === "corrupt") return { status: "backend_unavailable", reason: "index-corrupt", detail: read.detail };
	if (read.kind === "missing") {
		return {
			status: "backend_unavailable",
			reason: "index-missing",
			detail: `No workstream index at ${indexPath(root)}`,
		};
	}
	const index = read.index;
	if (workstreamId) {
		const entry = index.workstreams.find(candidate => candidate.id === workstreamId);
		if (!entry) return { status: "not_found", intent: workstreamId };
		return { status: "resolved", entry };
	}
	const trimmed = (intent ?? "").trim();
	if (!trimmed) {
		const only = index.workstreams[0];
		if (index.workstreams.length === 1 && only) return { status: "resolved", entry: only };
		return CLARIFY(trimmed, index.workstreams);
	}
	return matchWorkstream(index, trimmed);
}

function mergeSources(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
	const merged = Array.from(new Set([...(existing ?? []), ...(incoming ?? [])])).filter(value => value.length > 0);
	return merged.length > 0 ? merged : undefined;
}

/** Explicit save: resolve, validate, write under a revision guard, then the pointer. */
/** Report sections that would render as placeholders instead of real content. */
export function incompleteSections(sections: Partial<HandoffSections>): HandoffSectionKey[] {
	return HANDOFF_SECTIONS.map(([key]) => key).filter(key => (sections[key] ?? "").trim().length === 0);
}

export async function registerWorkstream(request: RegisterRequest): Promise<RegisterOutcome> {
	try {
		const location = await resolveRecord(request.root, registrationPointer(request));
		return await withContinuityLock(request.root, async () => {
			const read = await readIndex(request.root);
			if (read.kind === "corrupt")
				return { status: "backend_unavailable", reason: "index-corrupt", detail: read.detail };
			const index: WorkstreamIndex = read.kind === "ok" ? read.index : { version: 1, workstreams: [] };
			const previous = index.workstreams.find(entry => entry.id === request.workstreamId);
			if (previous) {
				const same =
					previous.canonical === location.canonical ||
					(location.store === "repo" && path.resolve(request.root, previous.canonical) === location.path);
				if (same && previous.authority === "canonical")
					return { status: "unchanged", entry: previous, indexPath: indexPath(request.root) };
				if (!request.replace || !request.canonical)
					return {
						status: "rejected",
						reason: "explicit-repoint-required",
						detail:
							"This workstream is already registered. Supply replace: true and an explicit canonical path to repoint it; neither note will be copied or deleted.",
					};
			}
			const text = await readTextIfPresent(location.path);
			const parsed = text === undefined ? undefined : parseHandoff(text);
			if (
				text !== undefined &&
				(!parsed || parsed.meta.workstream !== request.workstreamId || parsed.meta.authority !== "canonical")
			) {
				return {
					status: "rejected",
					reason: "canonical-identity-mismatch",
					detail:
						"An existing target must be a canonical tagged handoff for this workstream. Its contents were left untouched.",
				};
			}
			const entry: WorkstreamEntry = {
				id: request.workstreamId,
				title: request.title?.trim() || parsed?.meta.title || previous?.title || request.workstreamId,
				aliases: request.aliases ?? previous?.aliases ?? [],
				canonical: location.canonical,
				store: location.store,
				...(location.vault ? { vault: location.vault } : {}),
				authority: "canonical",
				revision: parsed?.meta.revision ?? 0,
				updatedAt: parsed?.meta.updated ?? "",
				...(text !== undefined ? { sha256: sha256(text) } : {}),
			};
			const workstreams = previous
				? index.workstreams.map(value => (value.id === entry.id ? entry : value))
				: [...index.workstreams, entry];
			await writeIndex(request.root, { version: 1, workstreams });
			return { status: "registered", entry, indexPath: indexPath(request.root) };
		});
	} catch (error) {
		return {
			status: "backend_unavailable",
			reason: error instanceof ContinuityLocationError ? error.reason : "registration-failed",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function saveHandoff(request: SaveRequest): Promise<SaveOutcome> {
	const missing = incompleteSections(request.sections);
	if (missing.length > 0)
		return {
			status: "rejected",
			reason: "incomplete-sections",
			detail: `Refusing to save a handoff with empty sections: ${missing.join(", ")}`,
		};
	let location: RecordLocation | undefined;
	let workstream = request.workstreamId ?? "";
	try {
		const resolution = await resolveWorkstream(request.root, request.intent, request.workstreamId);
		if (resolution.status !== "resolved") return resolution;
		const entry = resolution.entry;
		workstream = entry.id;
		assertWorkstreamId(entry.id);
		if (entry.authority !== "canonical")
			return {
				status: "rejected",
				workstream,
				reason: "not-canonical-authority",
				detail: "Update the canonical record instead of overwriting a copy.",
			};
		location = await resolveRecord(request.root, entry);
		const target = location;
		return await withContinuityLock(request.root, async () => {
			const recordLock = await resolveWithinRoot(
				target.root,
				path.join(path.dirname(target.path), `.${path.basename(target.path)}.ompk.lock`),
			);
			return withFileLock(recordLock, async () => {
				const registered = await readIndex(request.root);
				const current =
					registered.kind === "ok"
						? registered.index.workstreams.find(candidate => candidate.id === entry.id)
						: undefined;
				if (current?.authority !== "canonical") {
					return {
						status: "rejected",
						workstream,
						reason: "registry-changed",
						detail: "The registration changed while waiting for the lock; no record was written.",
					};
				}
				const fresh = await resolveRecord(request.root, current);
				if (fresh.path !== target.path || fresh.store !== target.store || fresh.vault !== target.vault)
					return {
						status: "rejected",
						workstream,
						reason: "registry-changed",
						detail: "The resolved record path changed while waiting for the lock.",
					};
				const existing = await readTextIfPresent(target.path);
				const parsed = existing === undefined ? undefined : parseHandoff(existing);
				if (existing !== undefined && !parsed)
					return {
						status: "rejected",
						workstream,
						reason: "canonical-unreadable",
						detail: "The target is not a well-formed tagged handoff; refusing to overwrite it.",
					};
				if (parsed && (parsed.meta.workstream !== entry.id || parsed.meta.authority !== "canonical"))
					return {
						status: "rejected",
						workstream,
						reason: "canonical-identity-mismatch",
						detail: "The target belongs to another workstream or is not canonical.",
					};
				if (existing === undefined && (current.revision > 0 || current.sha256))
					return {
						status: "rejected",
						workstream,
						reason: "canonical-missing",
						detail: "A previously saved record is missing; refusing to recreate it silently.",
					};
				const revision = parsed?.meta.revision ?? current.revision;
				if (request.expectedRevision !== undefined && request.expectedRevision !== revision)
					return {
						status: "stale",
						workstream,
						path: target.path,
						expectedRevision: request.expectedRevision,
						actualRevision: revision,
					};
				const expectedHash = request.expectedSha256 ?? current.sha256;
				if (expectedHash && (existing === undefined || sha256(existing) !== expectedHash))
					return {
						status: "rejected",
						workstream,
						reason: "content-changed",
						detail: "Canonical bytes changed since the last observation. Resume the record again before saving.",
					};
				const evidenceObserved = request.evidenceObservedAt ?? current.evidenceObservedAt;
				const sourceSessions = mergeSources(
					parsed?.meta.sourceSessions ?? current.sourceSessions,
					request.sourceSessions,
				);
				const nextMeta: HandoffMeta = {
					workstream,
					title: current.title,
					authority: "canonical",
					revision: revision + 1,
					updated: (request.now ?? new Date()).toISOString(),
					...(evidenceObserved ? { evidenceObserved } : {}),
					...(sourceSessions ? { sourceSessions } : {}),
				};
				if (
					parsed &&
					contentSignature(parsed.meta, parsed.sections) === contentSignature(nextMeta, request.sections)
				)
					return { status: "unchanged", workstream, path: target.path, revision, sha256: sha256(existing ?? "") };
				if (existing !== undefined && parsed) {
					try {
						if (target.store === "repo") await retainRevision(request.root, workstream, revision, existing);
						else {
							const retained = await resolveWithinRoot(
								target.root,
								path.join(
									path.dirname(target.path),
									".ompk-continuity",
									path.basename(target.path),
									`r${revision}.md`,
								),
							);
							await retainFile(retained, existing);
						}
					} catch (error) {
						return {
							status: "write_failed",
							workstream,
							path: target.path,
							reason: "retention-failed",
							pointerUpdated: false,
							detail: error instanceof Error ? error.message : String(error),
						};
					}
				}
				const rendered = renderHandoff(nextMeta, request.sections);
				// Detect non-cooperating edits before replacing bytes. Cooperative writers share the record lock.
				if ((await readTextIfPresent(target.path)) !== existing)
					return {
						status: "rejected",
						workstream,
						reason: "content-changed",
						detail: "The record changed during save; retry from a fresh resume.",
					};
				await writeFileAtomic(target.path, rendered);
				if ((await readTextIfPresent(target.path)) !== rendered)
					return {
						status: "write_failed",
						workstream,
						path: target.path,
						reason: "verification-mismatch",
						pointerUpdated: false,
						detail: "Written bytes did not verify; the index was left unchanged.",
					};
				const digest = sha256(rendered);
				const read = await readIndex(request.root);
				if (
					read.kind !== "ok" ||
					!read.index.workstreams.some(
						value =>
							value.id === current.id &&
							value.canonical === current.canonical &&
							value.authority === "canonical",
					)
				)
					return {
						status: "partial",
						workstream,
						path: target.path,
						revision: nextMeta.revision,
						sha256: digest,
						pointerUpdated: false,
						reason: "pointer-unreadable",
						detail:
							"The canonical record was written, but the registry is unreadable or changed. It was left untouched.",
					};
				const updated: WorkstreamIndex = {
					version: 1,
					workstreams: read.index.workstreams.map(value =>
						value.id === workstream
							? {
									...value,
									canonical: target.canonical,
									store: target.store,
									...(target.vault ? { vault: target.vault } : {}),
									revision: nextMeta.revision,
									updatedAt: nextMeta.updated,
									sha256: digest,
									...(evidenceObserved ? { evidenceObservedAt: evidenceObserved } : {}),
									...(sourceSessions ? { sourceSessions } : {}),
								}
							: value,
					),
				};
				try {
					await writeIndex(request.root, updated);
				} catch (error) {
					return {
						status: "partial",
						workstream,
						path: target.path,
						revision: nextMeta.revision,
						sha256: digest,
						pointerUpdated: false,
						reason: "pointer-write-failed",
						detail: error instanceof Error ? error.message : String(error),
					};
				}
				return {
					status: "saved",
					workstream,
					path: target.path,
					revision: nextMeta.revision,
					sha256: digest,
					bytes: Buffer.byteLength(rendered, "utf-8"),
					...(parsed ? { priorRevision: revision } : {}),
					pointerUpdated: true,
				};
			});
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		if (error instanceof ContinuityLocationError)
			return {
				status: error.reason === "canonical-outside-root" ? "rejected" : "backend_unavailable",
				workstream,
				reason: error.reason,
				detail,
			};
		return {
			status: "write_failed",
			workstream,
			path: location?.path ?? "",
			reason: "canonical-write-failed",
			pointerUpdated: false,
			detail,
		};
	}
}

function staleness(
	observed: string | undefined,
	now: Date,
	staleAfterDays: number,
): { stale: boolean; detail: string } {
	if (!observed) return { stale: true, detail: "The record cites no evidence observation date." };
	const parsed = Date.parse(observed);
	if (Number.isNaN(parsed)) return { stale: true, detail: `Unreadable evidence date: ${observed}` };
	const ageDays = Math.floor((now.getTime() - parsed) / 86_400_000);
	if (ageDays > staleAfterDays) return { stale: true, detail: `Evidence observed ${observed}, ${ageDays} days ago.` };
	return { stale: false, detail: `Evidence observed ${observed}, ${ageDays} days ago.` };
}

/** Explicit resume: read the canonical record and report its freshness honestly. */
export async function resumeHandoff(request: ResumeRequest): Promise<ResumeOutcome> {
	const resolution = await resolveWorkstream(request.root, request.intent, request.workstreamId);
	if (resolution.status !== "resolved") return resolution;
	const entry = resolution.entry;
	let location: RecordLocation;
	let text: string | undefined;
	try {
		location = await resolveRecord(request.root, entry);
		text = await readTextIfPresent(location.path);
	} catch (error) {
		return {
			status: "backend_unavailable",
			reason: error instanceof ContinuityLocationError ? error.reason : "canonical-unavailable",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	if (text === undefined) {
		return {
			status: "missing",
			workstream: entry.id,
			path: location.canonical,
			detail: "The index references this record but the file is absent.",
		};
	}
	const parsed = parseHandoff(text);
	if (!parsed) {
		return {
			status: "backend_unavailable",
			reason: "canonical-unparseable",
			detail: `${entry.canonical} does not contain a tagged six-section handoff.`,
		};
	}
	if (parsed.meta.workstream !== entry.id || parsed.meta.authority !== entry.authority) {
		return {
			status: "backend_unavailable",
			reason: "canonical-identity-mismatch",
			detail: "The record's workstream or authority does not match its registration.",
		};
	}
	const observed = parsed.meta.evidenceObserved ?? entry.evidenceObservedAt;
	const { stale, detail } = staleness(observed, request.now ?? new Date(), request.staleAfterDays ?? 30);
	return {
		status: "resumed",
		workstream: entry.id,
		title: parsed.meta.title || entry.title,
		path: location.store === "repo" ? location.path : location.canonical,
		authority: parsed.meta.authority,
		revision: parsed.meta.revision,
		updatedAt: parsed.meta.updated || entry.updatedAt,
		sha256: sha256(text),
		...(observed ? { evidenceObservedAt: observed } : {}),
		stale,
		...(stale
			? {
					verificationPrompt: `${detail} Re-check only the time-sensitive claims needed for the next action against current sources, and label anything unverified. Recorded history is evidence, not renewed authorization.`,
				}
			: {}),
		openQuestions: openQuestions(parsed.sections),
		handoff: parsed.body,
		sections: parsed.sections,
	};
}

/**
 * Explicit export: a portable snapshot. It is never registered in the index, so
 * it cannot silently compete with the canonical record.
 */
export async function exportHandoff(request: {
	root: string;
	intent?: string;
	workstreamId?: string;
	destination: string;
	now?: Date;
}): Promise<
	| {
			status: "exported";
			workstream: string;
			destination: string;
			canonical: string;
			revision: number;
			sha256: string;
	  }
	| { status: "rejected"; reason: string; detail: string }
	| { status: "write_failed"; reason: string; detail: string }
	| ResolveOutcome
> {
	const resolution = await resolveWorkstream(request.root, request.intent, request.workstreamId);
	if (resolution.status !== "resolved") return resolution;
	let location: RecordLocation;
	let destination: string;
	let text: string | undefined;
	try {
		location = await resolveRecord(request.root, resolution.entry);
		destination = await resolveWithinRoot(request.root, path.resolve(request.root, request.destination));
		text = await readTextIfPresent(location.path);
	} catch (error) {
		return {
			status: "rejected",
			reason: error instanceof ContinuityLocationError ? error.reason : "export-path-unavailable",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	const parsed = text === undefined ? undefined : parseHandoff(text);
	if (
		!parsed ||
		parsed.meta.workstream !== resolution.entry.id ||
		parsed.meta.authority !== resolution.entry.authority
	) {
		return {
			status: "rejected",
			reason: "canonical-unavailable",
			detail: "No readable canonical handoff to export.",
		};
	}
	if (destination === location.path) {
		return {
			status: "rejected",
			reason: "destination-is-canonical",
			detail: "Exporting onto the canonical record would fork authority.",
		};
	}
	const snapshot = renderHandoff(
		{
			...parsed.meta,
			authority: "snapshot",
			updated: (request.now ?? new Date()).toISOString(),
			canonicalSource: resolution.entry.canonical,
		},
		parsed.sections,
	);
	try {
		await writeFileAtomic(destination, snapshot);
	} catch (error) {
		return {
			status: "write_failed",
			reason: "export-write-failed",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	return {
		status: "exported",
		workstream: resolution.entry.id,
		destination: request.destination,
		canonical: resolution.entry.canonical,
		revision: parsed.meta.revision,
		sha256: sha256(snapshot),
	};
}

export async function continuityStatus(root: string): Promise<ContinuityStatus> {
	const read = await readIndex(root);
	const base = { root, indexPath: indexPath(root) };
	if (read.kind === "missing") return { ...base, indexPresent: false, indexReadable: false, workstreams: [] };
	if (read.kind === "corrupt") {
		return { ...base, indexPresent: true, indexReadable: false, workstreams: [], detail: read.detail };
	}
	return { ...base, indexPresent: true, indexReadable: true, workstreams: read.index.workstreams.map(toCandidate) };
}
