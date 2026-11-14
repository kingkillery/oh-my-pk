import * as path from "node:path";
import { contentSignature, openQuestions, parseHandoff, renderHandoff } from "./render";
import {
	assertWithinRoot,
	indexPath,
	readIndex,
	readTextIfPresent,
	retainRevision,
	sha256,
	withContinuityLock,
	writeFileAtomic,
	writeIndex,
} from "./store";
import type {
	ContinuityStatus,
	HandoffMeta,
	HandoffSectionKey,
	HandoffSections,
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

export async function saveHandoff(request: SaveRequest): Promise<SaveOutcome> {
	const resolution = await resolveWorkstream(request.root, request.intent, request.workstreamId);
	if (resolution.status !== "resolved") return resolution;
	const entry = resolution.entry;
	const missing = incompleteSections(request.sections);
	if (missing.length > 0)
		return {
			status: "rejected",
			workstream: entry.id,
			reason: "incomplete-sections",
			detail: `Refusing to save a handoff with empty sections: ${missing.join(", ")}`,
		};
	const target = entry.canonical;
	try {
		assertWithinRoot(request.root, target);
	} catch (error) {
		return {
			status: "rejected",
			workstream: entry.id,
			reason: "canonical-outside-root",
			detail: error instanceof Error ? error.message : String(error),
		};
	}

	if (entry.authority !== "canonical") {
		return {
			status: "rejected",
			workstream: entry.id,
			reason: "not-canonical-authority",
			detail: `${target} is registered as ${entry.authority}; update the canonical record instead of overwriting a copy.`,
		};
	}
	return withContinuityLock(request.root, () => writeLocked(request, entry, target));

	async function writeLocked(request: SaveRequest, entry: WorkstreamEntry, target: string): Promise<SaveOutcome> {
		const registered = await readIndex(request.root);
		const current =
			registered.kind === "ok"
				? registered.index.workstreams.find(candidate => candidate.id === entry.id)
				: undefined;
		if (!current || path.resolve(current.canonical) !== path.resolve(target) || current.authority !== "canonical") {
			return {
				status: "rejected",
				workstream: entry.id,
				reason: "registry-changed",
				detail:
					"The workstream registry changed while waiting for the lock; refusing to write against a stale registration.",
			};
		}

		const existing = await readTextIfPresent(target);
		const parsed = existing === undefined ? undefined : parseHandoff(existing);
		if (existing !== undefined && !parsed) {
			return {
				status: "rejected",
				workstream: entry.id,
				reason: "canonical-unreadable",
				detail: `${target} is not a well-formed tagged handoff; refusing to overwrite it.`,
			};
		}

		const currentRevision = parsed?.meta.revision ?? current.revision;
		if (request.expectedRevision !== undefined && request.expectedRevision !== currentRevision) {
			return {
				status: "stale",
				workstream: entry.id,
				path: target,
				expectedRevision: request.expectedRevision,
				actualRevision: currentRevision,
			};
		}

		const now = request.now ?? new Date();
		const evidenceObserved = request.evidenceObservedAt ?? entry.evidenceObservedAt;
		const sourceSessions = mergeSources(parsed?.meta.sourceSessions ?? entry.sourceSessions, request.sourceSessions);
		const nextMeta: HandoffMeta = {
			workstream: entry.id,
			title: entry.title,
			authority: "canonical",
			revision: currentRevision + 1,
			updated: now.toISOString(),
			...(evidenceObserved ? { evidenceObserved } : {}),
			...(sourceSessions ? { sourceSessions } : {}),
		};

		if (parsed && contentSignature(parsed.meta, parsed.sections) === contentSignature(nextMeta, request.sections)) {
			return {
				status: "unchanged",
				workstream: entry.id,
				path: target,
				revision: currentRevision,
				sha256: sha256(existing ?? ""),
			};
		}

		if (existing !== undefined && parsed) {
			try {
				await retainRevision(request.root, entry.id, parsed.meta.revision, existing);
			} catch (error) {
				return {
					status: "write_failed",
					workstream: entry.id,
					path: target,
					reason: "retention-failed",
					pointerUpdated: false,
					detail: error instanceof Error ? error.message : String(error),
				};
			}
		}

		const rendered = renderHandoff(nextMeta, request.sections);
		try {
			await writeFileAtomic(target, rendered);
		} catch (error) {
			return {
				status: "write_failed",
				workstream: entry.id,
				path: target,
				reason: "canonical-write-failed",
				pointerUpdated: false,
				detail: error instanceof Error ? error.message : String(error),
			};
		}

		const verified = await readTextIfPresent(target);
		if (verified !== rendered) {
			return {
				status: "write_failed",
				workstream: entry.id,
				path: target,
				reason: "verification-mismatch",
				pointerUpdated: false,
				detail: "The written bytes did not read back identically; the pointer was left unchanged.",
			};
		}

		const digest = sha256(rendered);
		const read = await readIndex(request.root);
		if (read.kind !== "ok") {
			// The canonical record is already written and verified, so the pointer is the
			// only thing at risk. An unreadable registry here is an anomaly, never a cue to
			// start a fresh one: rebuilding it would silently discard every other workstream.
			return {
				status: "partial",
				workstream: entry.id,
				path: target,
				revision: nextMeta.revision,
				sha256: digest,
				pointerUpdated: false,
				reason: "pointer-unreadable",
				detail:
					read.kind === "corrupt"
						? read.detail
						: `The workstream index at ${indexPath(request.root)} disappeared while saving.`,
			};
		}
		const index: WorkstreamIndex = read.index;
		const updated: WorkstreamIndex = {
			version: 1,
			workstreams: index.workstreams.map(candidate =>
				candidate.id === entry.id
					? {
							...candidate,
							revision: nextMeta.revision,
							updatedAt: nextMeta.updated,
							...(evidenceObserved ? { evidenceObservedAt: evidenceObserved } : {}),
							...(sourceSessions ? { sourceSessions } : {}),
						}
					: candidate,
			),
		};
		try {
			await writeIndex(request.root, updated);
		} catch (error) {
			return {
				status: "partial",
				workstream: entry.id,
				path: target,
				revision: nextMeta.revision,
				sha256: digest,
				pointerUpdated: false,
				reason: "pointer-write-failed",
				detail: error instanceof Error ? error.message : String(error),
			};
		}

		return {
			status: "saved",
			workstream: entry.id,
			path: target,
			revision: nextMeta.revision,
			sha256: digest,
			bytes: Buffer.byteLength(rendered, "utf-8"),
			...(parsed ? { priorRevision: parsed.meta.revision } : {}),
			pointerUpdated: true,
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
	try {
		assertWithinRoot(request.root, entry.canonical);
	} catch (error) {
		return {
			status: "backend_unavailable",
			reason: "canonical-outside-root",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	const text = await readTextIfPresent(entry.canonical);
	if (text === undefined) {
		return {
			status: "missing",
			workstream: entry.id,
			path: entry.canonical,
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
	const observed = parsed.meta.evidenceObserved ?? entry.evidenceObservedAt;
	const { stale, detail } = staleness(observed, request.now ?? new Date(), request.staleAfterDays ?? 30);
	return {
		status: "resumed",
		workstream: entry.id,
		title: parsed.meta.title || entry.title,
		path: entry.canonical,
		authority: parsed.meta.authority,
		revision: parsed.meta.revision,
		updatedAt: parsed.meta.updated || entry.updatedAt,
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
	const text = await readTextIfPresent(resolution.entry.canonical);
	const parsed = text === undefined ? undefined : parseHandoff(text);
	if (!parsed) {
		return {
			status: "rejected",
			reason: "canonical-unavailable",
			detail: "No readable canonical handoff to export.",
		};
	}
	if (request.destination === resolution.entry.canonical) {
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
		await writeFileAtomic(request.destination, snapshot);
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
