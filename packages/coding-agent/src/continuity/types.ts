/**
 * Project-continuity contract.
 *
 * A workstream owns exactly one canonical continuation record. Detection
 * pointers (the workstream index) are discovery hints, never authority, and
 * every write path in this module is guarded by a revision check.
 */

/** Literal delimiters required around every generated handoff body. */
export const HANDOFF_OPEN = "<handoff-prompt>";
export const HANDOFF_CLOSE = "</handoff-prompt>";

/** Ordered section headings, fixed so renders stay byte-comparable. */
export const HANDOFF_SECTIONS = [
	["objective", "Objective"],
	["currentState", "Current State"],
	["keyContext", "Key Context"],
	["nextSteps", "Next Steps"],
	["validation", "Validation"],
	["blockers", "Blockers"],
] as const;

export type HandoffSectionKey = (typeof HANDOFF_SECTIONS)[number][0];

export type HandoffSections = Record<HandoffSectionKey, string>;

/**
 * `canonical` is the single authoritative continuation record for a workstream.
 * `snapshot` is an explicitly requested export. `historical` is archival evidence.
 * Only canonical records may be updated in place.
 */
export type HandoffAuthority = "canonical" | "snapshot" | "historical";

export type ContinuityStore = "repo" | "vault";

/** Defaults for newly registered workstreams; existing pointers never move implicitly. */
export interface ContinuityStorageOptions {
	store?: ContinuityStore;
	vault?: string;
}

export interface RegisterRequest extends ContinuityStorageOptions {
	root: string;
	workstreamId: string;
	title?: string;
	aliases?: string[];
	/** Repository-relative markdown path or named vault:// URL. */
	canonical?: string;
	/** Explicitly repoint an existing entry, without copying or deleting either note. */
	replace?: boolean;
}

export type RegisterOutcome =
	| { status: "registered" | "unchanged"; entry: WorkstreamEntry; indexPath: string }
	| { status: "rejected" | "backend_unavailable"; reason: string; detail: string };

export interface WorkstreamEntry {
	/** Stable identifier; never derived from the display title. */
	id: string;
	title: string;
	/** Additional resume phrases, including user shorthand. */
	aliases: string[];
	/** Repository-relative path or named vault:// URL; legacy absolute repo paths remain readable. */
	canonical: string;
	/**
	 * Where the record lives. `repo` travels with a clone. `vault` is a pointer
	 * at a note outside the repo; the index itself always stays in the repo.
	 */
	store?: ContinuityStore;
	/** Vault name when `store` is `vault`, so a clone can say where the note lives. */
	vault?: string;
	authority: HandoffAuthority;
	revision: number;
	updatedAt: string;
	/** Digest of the last successfully saved canonical bytes. */
	sha256?: string;
	/** When the cited evidence was last observed, not when it was written. */
	evidenceObservedAt?: string;
	/** Session-manager identifiers this record was derived from. */
	sourceSessions?: string[];
}

export interface WorkstreamIndex {
	version: 1;
	workstreams: WorkstreamEntry[];
}

export interface HandoffMeta {
	workstream: string;
	title: string;
	authority: HandoffAuthority;
	revision: number;
	updated: string;
	evidenceObserved?: string;
	sourceSessions?: string[];
	/** Canonical record this copy was taken from; set only for snapshots. */
	canonicalSource?: string;
}

export interface ParsedHandoff {
	meta: HandoffMeta;
	sections: HandoffSections;
	body: string;
}

export type ResolveFailure =
	| { status: "not_found"; intent: string }
	| { status: "needs_clarification"; intent: string; candidates: ResolveCandidate[] }
	| { status: "backend_unavailable"; reason: string; detail: string };

export interface ResolveCandidate {
	id: string;
	title: string;
	canonical: string;
	authority: HandoffAuthority;
}

export type ResolveOutcome = { status: "resolved"; entry: WorkstreamEntry } | ResolveFailure;

export interface SaveRequest {
	/** Project root that owns the workstream index. */
	root: string;
	/** Natural-language reference, e.g. "the Tonia missed appointment review". */
	intent?: string;
	/** Explicit identifier, bypassing intent matching. */
	workstreamId?: string;
	sections: HandoffSections;
	/** Reject the write when the stored revision no longer matches. */
	expectedRevision?: number;
	/** Reject changed bytes even if a non-OMPK editor did not increment the revision. */
	expectedSha256?: string;
	evidenceObservedAt?: string;
	sourceSessions?: string[];
	/** Injectable for deterministic tests. */
	now?: Date;
}

export type SaveOutcome =
	| {
			status: "saved";
			workstream: string;
			path: string;
			revision: number;
			sha256: string;
			bytes: number;
			priorRevision?: number;
			pointerUpdated: true;
	  }
	| { status: "unchanged"; workstream: string; path: string; revision: number; sha256: string }
	| { status: "stale"; workstream: string; path: string; expectedRevision: number; actualRevision: number }
	| { status: "rejected"; workstream?: string; reason: string; detail: string }
	| {
			status: "partial";
			workstream: string;
			path: string;
			revision: number;
			sha256: string;
			pointerUpdated: false;
			reason: string;
			detail: string;
	  }
	| {
			status: "write_failed";
			workstream: string;
			path: string;
			reason: string;
			pointerUpdated: false;
			detail: string;
	  }
	| ResolveFailure;

export interface ResumeRequest {
	root: string;
	intent?: string;
	workstreamId?: string;
	/** Age in days after which cited evidence must be re-verified. */
	staleAfterDays?: number;
	/** Digest of the canonical bytes returned by resume. */
	now?: Date;
}

export type ResumeOutcome =
	| {
			status: "resumed";
			workstream: string;
			title: string;
			path: string;
			authority: HandoffAuthority;
			revision: number;
			updatedAt: string;
			sha256: string;
			evidenceObservedAt?: string;
			/** True when cited evidence is older than the staleness window. */
			stale: boolean;
			/** Bounded instruction to re-check current sources before acting. */
			verificationPrompt?: string;
			/** Recorded open questions; historical evidence, not current truth. */
			openQuestions: string[];
			handoff: string;
			sections: HandoffSections;
	  }
	| { status: "missing"; workstream: string; path: string; detail: string }
	| ResolveFailure;

export interface ContinuityStatus {
	root: string;
	indexPath: string;
	indexPresent: boolean;
	indexReadable: boolean;
	workstreams: ResolveCandidate[];
	detail?: string;
}
