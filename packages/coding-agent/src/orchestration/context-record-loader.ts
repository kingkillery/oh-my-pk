/**
 * Authorized record loader (A04/W3) — resolves fragment `contentRef`s into
 * concrete content against the durable launch-authority store.
 *
 * Fail-closed rules:
 * - `delivery:<id>` resolves ONLY through `launch_context_inbox` (the record
 *   must be admitted under the binding's CURRENT context generation and its
 *   `admitted_epoch` must not exceed the binding's policy epoch), the
 *   `launch_deliveries` row must re-hash to its recorded `request_digest`,
 *   and the delivery's domains must be a subset of the pinned channel's
 *   authorized domains.
 * - `contract://<path>` resolves ONLY against refs pinned inside the
 *   persisted `launch_contracts.canonical_json` (base-context segments,
 *   agent template, workspace instructions, disclosure intents, capsule).
 * - `grant:<id>` resolves ONLY through a live `launch_grants` row issued to
 *   this binding for an `artifact` resource; revoked/missing grants deny.
 * - Anything else is `unpinned_resource` unless the fragment is a
 *   same-lifecycle `local-trajectory`, which may resolve through the host
 *   resolver with digest integrity only.
 *
 * The loader NEVER fabricates content: every admitted byte must come back
 * through the caller-supplied `resolveContent` and match BOTH the fragment's
 * declared `sourceHash` and the store-recorded digest for the ref.
 */

import { Database } from "bun:sqlite";
import * as path from "node:path";
import type { DeliveryRecordV1 } from "../operational/lifecycle-types";
import type { OperationalStore } from "../operational/store";
import type { ArtifactManager } from "../session/artifacts";
import {
	type ArtifactRefV1,
	type CompiledLaunchContract,
	canonicalJson,
	type DisclosureDomain,
	type GrantRecordV1,
	isHex64,
	isPlainObject,
	type LaunchBinding,
	sha256Hex,
} from "../task/launch-contract";
import type { ContextFragment } from "./context-projector";

/** Store rows the loader needs beyond the store's public getters. */
export interface LaunchContextRows {
	readonly inbox: {
		readonly deliveryId: string;
		readonly contextGeneration: number;
		readonly contentRef: string;
		readonly domains: readonly DisclosureDomain[];
		readonly admittedEpoch: number;
	} | null;
	readonly delivery: DeliveryRecordV1 | null;
	readonly channel: {
		readonly domains: readonly DisclosureDomain[];
		readonly revokedAt: number | null;
	} | null;
}

/**
 * Read surface the loader authorizes against. `createStoreRecordSource`
 * adapts `OperationalStore`; tests may supply a narrower fake ONLY for
 * rows — never for content, which always flows through `resolveContent`.
 */
export interface LaunchRecordSource {
	getLaunchBinding(bindingId: string): LaunchBinding;
	getLaunchContract(digest: string): CompiledLaunchContract;
	getLaunchGrant(grantId: string): GrantRecordV1;
	readContextRows(bindingId: string, contextGeneration: number, deliveryId: string): LaunchContextRows;
	readGrantRevokedAt(grantId: string): number | null | undefined;
}

export type RecordContentResolver = (ref: {
	readonly uri: string;
	readonly sha256: string;
	readonly bytes: number | null;
}) => string | Promise<string>;

export type RecordLoadFailureCode =
	| "record_not_found"
	| "record_not_admitted"
	| "record_revoked"
	| "record_outside_scope"
	| "record_digest_mismatch"
	| "record_epoch_stale"
	| "unpinned_resource"
	| "content_unresolvable"
	| "content_digest_mismatch";

export interface ResolvedRecord {
	readonly content: string;
	/** sha256 of the resolved content — equals the fragment's sourceHash. */
	readonly contentDigest: string;
	/** Store-recorded digest the resolution was anchored to, when one exists. */
	readonly recordDigest: string | null;
	readonly domains: readonly DisclosureDomain[];
	readonly via: "delivery" | "contract" | "grant" | "lifecycle-local";
}

export type RecordLoadResult =
	| { readonly ok: true; readonly record: ResolvedRecord }
	| { readonly ok: false; readonly code: RecordLoadFailureCode };

const fail = (code: RecordLoadFailureCode): { readonly ok: false; readonly code: RecordLoadFailureCode } => ({
	ok: false,
	code,
});

function parseDomainsJson(raw: string): readonly DisclosureDomain[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return Object.freeze([]);
		return Object.freeze(
			parsed.filter(
				(d): d is DisclosureDomain => typeof d === "string" || (isPlainObject(d) && d.kind === "artifact-scope"),
			),
		);
	} catch {
		return Object.freeze([]);
	}
}

function domainEquals(a: DisclosureDomain, b: DisclosureDomain): boolean {
	if (typeof a === "string" || typeof b === "string") return a === b;
	return a.kind === b.kind && a.artifactId === b.artifactId;
}

/**
 * Adapt an `OperationalStore` to the loader's read surface. Inbox, delivery,
 * channel and grant-revocation rows have no public store getter yet (the
 * store file is owned by another lane), so they are read through a SQLite
 * handle on the same database — a caller-supplied one, or a lazily opened
 * read-only connection on `store.dbPath`.
 */
export function createStoreRecordSource(store: OperationalStore, db?: Database): LaunchRecordSource {
	let owned: Database | null = null;
	const handle = (): Database => {
		if (db) return db;
		owned ??= new Database(store.dbPath, { readonly: true });
		return owned;
	};
	return {
		getLaunchBinding: bindingId => store.getLaunchBinding(bindingId),
		getLaunchContract: digest => store.getLaunchContract(digest),
		getLaunchGrant: grantId => store.getLaunchGrant(grantId),
		readContextRows(bindingId, contextGeneration, deliveryId) {
			const database = handle();
			const inboxRow = database
				.prepare(
					`SELECT delivery_id, context_generation, content_ref, domains_json, admitted_epoch
					 FROM launch_context_inbox
					 WHERE binding_id = ? AND context_generation = ? AND delivery_id = ?`,
				)
				.get(bindingId, contextGeneration, deliveryId) as
				| {
						delivery_id: string;
						context_generation: number;
						content_ref: string;
						domains_json: string;
						admitted_epoch: number;
				  }
				| undefined;
			const deliveryRow = database
				.prepare(
					`SELECT payload_json, request_digest FROM launch_deliveries
					 WHERE binding_id = ? AND delivery_id = ?`,
				)
				.get(bindingId, deliveryId) as { payload_json: string; request_digest: string } | undefined;
			let delivery: DeliveryRecordV1 | null = null;
			if (deliveryRow) {
				try {
					const parsed = JSON.parse(deliveryRow.payload_json) as DeliveryRecordV1;
					// The recorded digest is recomputed over the stored record, never
					// trusted from the caller — a tampered payload cannot match.
					const recomputed = sha256Hex(
						canonicalJson({
							channelId: parsed.channelId,
							attemptId: parsed.attemptId,
							contractRevision: parsed.contractRevision,
							contextGeneration: parsed.contextGeneration,
							payloadRef: parsed.payloadRef,
							resourceRefs: parsed.resourceRefs,
							domains: parsed.domains,
							kind: parsed.kind,
						}),
					);
					if (recomputed === deliveryRow.request_digest) delivery = parsed;
				} catch {
					delivery = null;
				}
			}
			const channelRow = delivery
				? (database
						.prepare(
							`SELECT canonical_json, revoked_at FROM launch_channels
							 WHERE binding_id = ? AND channel_id = ?`,
						)
						.get(bindingId, delivery.channelId) as
						| { canonical_json: string; revoked_at: number | null }
						| undefined)
				: undefined;
			let channel: LaunchContextRows["channel"] = null;
			if (channelRow) {
				const parsed = JSON.parse(channelRow.canonical_json) as { domains?: DisclosureDomain[] };
				channel = {
					domains: Object.freeze(Array.isArray(parsed.domains) ? parsed.domains : []),
					revokedAt: channelRow.revoked_at,
				};
			}
			return {
				inbox: inboxRow
					? {
							deliveryId: inboxRow.delivery_id,
							contextGeneration: inboxRow.context_generation,
							contentRef: inboxRow.content_ref,
							domains: parseDomainsJson(inboxRow.domains_json),
							admittedEpoch: inboxRow.admitted_epoch,
						}
					: null,
				delivery,
				channel,
			};
		},
		readGrantRevokedAt(grantId) {
			const row = handle().prepare("SELECT revoked_at FROM launch_grants WHERE grant_id = ?").get(grantId) as
				| { revoked_at: number | null }
				| undefined;
			return row ? row.revoked_at : undefined;
		},
	};
}

/** Pinned refs inside the persisted contract that a `contract://` ref may name. */
function contractPinnedRef(
	contract: CompiledLaunchContract,
	path: string,
): { readonly ref: ArtifactRefV1 | null; readonly capsuleDigest?: string } | null {
	const authority = contract.authority;
	if (path === "capsule") {
		return { ref: null, capsuleDigest: sha256Hex(canonicalJson(contract.capsule)) };
	}
	if (path === "agent-template") return { ref: authority.agentTemplateRef };
	const baseMatch = /^base-context\/(.+)$/.exec(path);
	if (baseMatch) {
		const segment = authority.baseContextManifest.segments.find(s => s.segmentId === baseMatch[1]);
		return segment ? { ref: segment.contentRef } : null;
	}
	const wsMatch = /^workspace-instructions\/(\d+)$/.exec(path);
	if (wsMatch) {
		const ref = authority.workspaceInstructionRefs[Number(wsMatch[1])];
		return ref ? { ref } : null;
	}
	const discMatch = /^disclosure\/(.+)$/.exec(path);
	if (discMatch) {
		const intent = authority.initialDisclosures.find(d => d.intentId === discMatch[1]);
		return intent ? { ref: intent.contentRef } : null;
	}
	return null;
}

async function resolveAndVerify(
	resolveContent: RecordContentResolver,
	ref: { uri: string; sha256: string; bytes: number | null },
	expectedDigest: string,
): Promise<
	{ readonly ok: true; readonly content: string } | { readonly ok: false; readonly code: RecordLoadFailureCode }
> {
	if (!isHex64(expectedDigest)) return fail("record_digest_mismatch");
	let content: string;
	try {
		content = await resolveContent(ref);
	} catch {
		return fail("content_unresolvable");
	}
	if (typeof content !== "string" || content.length === 0) return fail("content_unresolvable");
	const digest = sha256Hex(content);
	if (digest !== expectedDigest) return fail("content_digest_mismatch");
	if (ref.bytes !== null && Buffer.byteLength(content, "utf8") !== ref.bytes) {
		return fail("content_digest_mismatch");
	}
	return { ok: true, content };
}

/**
 * Resolve one fragment's `contentRef` into authorized content.
 *
 * `authority` carries the persisted binding + contract the projection runs
 * under; `sameLifecycle` marks fragments whose ownerScope is this binding's
 * own scope (local trajectory may resolve host-side with integrity only).
 */
export async function loadAuthorizedRecord(input: {
	readonly fragment: ContextFragment;
	readonly binding: LaunchBinding;
	readonly contract: CompiledLaunchContract;
	readonly source: LaunchRecordSource;
	readonly resolveContent: RecordContentResolver;
	readonly sameLifecycle: boolean;
}): Promise<RecordLoadResult> {
	const { fragment, binding, contract, source, resolveContent } = input;
	const ref = fragment.contentRef;

	if (ref.startsWith("delivery:")) {
		const deliveryId = ref.slice("delivery:".length);
		const rows = source.readContextRows(binding.bindingId, binding.contextGeneration, deliveryId);
		if (!rows.inbox) return fail("record_not_admitted");
		if (rows.inbox.admittedEpoch > binding.policyEpoch) return fail("record_epoch_stale");
		if (!rows.delivery) return fail("record_not_found");
		if (rows.delivery.recipientBindingId !== binding.bindingId) return fail("record_outside_scope");
		if (!rows.channel) return fail("record_not_found");
		if (rows.channel.revokedAt !== null) return fail("record_revoked");
		// Domains the delivery was admitted under must stay inside the
		// channel's authorized domain set.
		for (const domain of rows.inbox.domains) {
			if (!rows.channel.domains.some(d => domainEquals(d, domain))) {
				return fail("record_outside_scope");
			}
		}
		const payload = rows.delivery.payloadRef;
		// The descriptor must name the exact recorded payload digest — a
		// fragment cannot point at a delivery and ask for different bytes.
		if (payload.sha256 !== fragment.sourceHash) return fail("record_digest_mismatch");
		const resolved = await resolveAndVerify(
			resolveContent,
			{ uri: payload.uri, sha256: payload.sha256, bytes: payload.bytes },
			fragment.sourceHash,
		);
		if (!resolved.ok) return resolved;
		return {
			ok: true,
			record: {
				content: resolved.content as string,
				contentDigest: fragment.sourceHash,
				recordDigest: rows.delivery.requestDigest,
				domains: rows.inbox.domains,
				via: "delivery",
			},
		};
	}

	if (ref.startsWith("contract://")) {
		const pinned = contractPinnedRef(contract, ref.slice("contract://".length));
		if (!pinned) return fail("unpinned_resource");
		if (pinned.capsuleDigest !== undefined) {
			if (pinned.capsuleDigest !== fragment.sourceHash) return fail("record_digest_mismatch");
			const resolved = await resolveAndVerify(
				resolveContent,
				{ uri: ref, sha256: fragment.sourceHash, bytes: null },
				fragment.sourceHash,
			);
			if (!resolved.ok) return resolved;
			return {
				ok: true,
				record: {
					content: resolved.content as string,
					contentDigest: fragment.sourceHash,
					recordDigest: contract.contractDigest,
					domains: Object.freeze([]),
					via: "contract",
				},
			};
		}
		const artifact = pinned.ref as ArtifactRefV1;
		if (artifact.sha256 !== fragment.sourceHash) return fail("record_digest_mismatch");
		const resolved = await resolveAndVerify(
			resolveContent,
			{ uri: artifact.uri, sha256: artifact.sha256, bytes: artifact.bytes },
			fragment.sourceHash,
		);
		if (!resolved.ok) return resolved;
		return {
			ok: true,
			record: {
				content: resolved.content as string,
				contentDigest: fragment.sourceHash,
				recordDigest: artifact.sha256,
				domains: Object.freeze([]),
				via: "contract",
			},
		};
	}

	if (ref.startsWith("grant:")) {
		const grantId = ref.slice("grant:".length);
		const revokedAt = source.readGrantRevokedAt(grantId);
		if (revokedAt === undefined) return fail("record_not_found");
		if (revokedAt !== null) return fail("record_revoked");
		let grant: GrantRecordV1;
		try {
			grant = source.getLaunchGrant(grantId);
		} catch {
			return fail("record_not_found");
		}
		if (grant.recipientBindingId !== binding.bindingId) return fail("record_outside_scope");
		if (grant.resource.kind !== "artifact") return fail("record_outside_scope");
		const expected = grant.resource.versionDigest ?? fragment.sourceHash;
		if (expected !== fragment.sourceHash) return fail("record_digest_mismatch");
		const uri = grant.resource.resourceId.includes("://")
			? grant.resource.resourceId
			: `artifact://${grant.resource.resourceId}`;
		const resolved = await resolveAndVerify(
			resolveContent,
			{ uri, sha256: expected, bytes: grant.resource.scope.maxBytes },
			fragment.sourceHash,
		);
		if (!resolved.ok) return resolved;
		return {
			ok: true,
			record: {
				content: resolved.content as string,
				contentDigest: fragment.sourceHash,
				recordDigest: grant.recordDigest,
				domains: grant.domains,
				via: "grant",
			},
		};
	}

	// Same-lifecycle local trajectory: the host resolves the ref and the
	// digest pins integrity. No store record exists for a child's own
	// working state; anything else without a pinned record is denied.
	if (input.sameLifecycle && fragment.contextClass === "local-trajectory") {
		const resolved = await resolveAndVerify(
			resolveContent,
			{ uri: ref, sha256: fragment.sourceHash, bytes: null },
			fragment.sourceHash,
		);
		if (!resolved.ok) return resolved;
		return {
			ok: true,
			record: {
				content: resolved.content as string,
				contentDigest: fragment.sourceHash,
				recordDigest: null,
				domains: Object.freeze([]),
				via: "lifecycle-local",
			},
		};
	}
	return fail("unpinned_resource");
}

/**
 * Narrowest artifact read surface the resolver needs — satisfied by the real
 * session `ArtifactManager` and by focused test doubles.
 */
export type SessionArtifactReader = Pick<ArtifactManager, "getPath">;

/**
 * Production `RecordContentResolver` (§14.6): resolves the URIs that
 * admitted store records and contract-pinned refs point at, returning raw
 * text. Integrity is NOT decided here — `loadAuthorizedRecord` re-hashes
 * every returned byte string against the fragment's pinned `sourceHash`, so
 * this adapter only has to fetch honestly and FAIL CLOSED (throw) on
 * anything it cannot resolve. It never fabricates content.
 *
 * Resolution rules:
 * - `artifact://<id>` → `artifactManager.getPath(id)` → file bytes. A
 *   missing artifact throws (→ `content_unresolvable`).
 * - `delivery:<deliveryId>` → the `launch_deliveries` row's recorded
 *   `payloadRef` → recurse. Scoped to `bindingId` when supplied; otherwise
 *   the delivery id must be unique across bindings or it throws.
 * - `grant:<grantId>` → `store.getLaunchGrant` → `resource.resourceId`
 *   (artifact kind only) → recurse.
 * - `contract://capsule` → the persisted contract whose re-canonicalized
 *   capsule digest equals the pinned `ref.sha256`; the canonical capsule
 *   JSON is returned. Any other `contract://` path throws — the loader
 *   resolves those refs to `ArtifactRefV1`s before calling.
 * - `file://` / absolute paths → file bytes (digest-pinned by the caller).
 * - Everything else throws `unsupported_record_uri`.
 */
export function createSessionRecordResolver(input: {
	readonly artifactManager: SessionArtifactReader;
	readonly store: OperationalStore;
	/** Binding whose deliveries `delivery:` refs resolve against. */
	readonly bindingId?: string;
	/** Optional caller-owned SQLite handle on the same database (tests). */
	readonly db?: Database;
}): RecordContentResolver {
	const { artifactManager, store } = input;
	let owned: Database | null = null;
	const handle = (): Database => {
		if (input.db) return input.db;
		owned ??= new Database(store.dbPath, { readonly: true });
		return owned;
	};

	const resolveArtifactUri = async (uri: string): Promise<string> => {
		const id = uri.slice("artifact://".length);
		if (!id) throw new Error("artifact_uri_missing_id");
		const artifactPath = await artifactManager.getPath(id);
		if (!artifactPath) throw new Error(`artifact_not_found: ${id}`);
		return Bun.file(artifactPath).text();
	};

	const resolveRef = async (
		ref: { readonly uri: string; readonly sha256: string; readonly bytes: number | null },
		depth: number,
	): Promise<string> => {
		if (depth > 4) throw new Error("record_ref_depth_exceeded");
		const uri = ref.uri;

		if (uri.startsWith("artifact://")) return resolveArtifactUri(uri);

		if (uri.startsWith("delivery:")) {
			const deliveryId = uri.slice("delivery:".length);
			// bun:sqlite `.all()` returns unknown[]; the payload_json column is
			// NOT NULL TEXT by schema, same convention as createStoreRecordSource.
			const rows = (
				input.bindingId
					? handle()
							.prepare("SELECT payload_json FROM launch_deliveries WHERE binding_id = ? AND delivery_id = ?")
							.all(input.bindingId, deliveryId)
					: handle().prepare("SELECT payload_json FROM launch_deliveries WHERE delivery_id = ?").all(deliveryId)
			) as { payload_json: string }[];
			if (rows.length !== 1) {
				throw new Error(`delivery_ref_ambiguous: '${deliveryId}' matched ${rows.length} rows`);
			}
			const payload = (JSON.parse(rows[0].payload_json) as DeliveryRecordV1).payloadRef;
			return resolveRef({ uri: payload.uri, sha256: payload.sha256, bytes: payload.bytes }, depth + 1);
		}

		if (uri.startsWith("grant:")) {
			const grant = store.getLaunchGrant(uri.slice("grant:".length));
			if (grant.resource.kind !== "artifact") throw new Error("grant_resource_not_artifact");
			const resourceUri = grant.resource.resourceId.includes("://")
				? grant.resource.resourceId
				: `artifact://${grant.resource.resourceId}`;
			return resolveRef(
				{
					uri: resourceUri,
					sha256: grant.resource.versionDigest ?? ref.sha256,
					bytes: grant.resource.scope.maxBytes,
				},
				depth + 1,
			);
		}

		if (uri === "contract://capsule") {
			// The capsule ref carries no contract identity, so the pinned digest
			// selects the row: re-canonicalize each persisted capsule and keep
			// the one whose digest matches. Deterministic canonical encoding
			// makes the match exact; no match means the content is unresolvable.
			const contracts = handle().prepare("SELECT canonical_json FROM launch_contracts").all() as {
				canonical_json: string;
			}[];
			for (const row of contracts) {
				const capsule = (JSON.parse(row.canonical_json) as CompiledLaunchContract).capsule;
				const canonical = canonicalJson(capsule);
				if (sha256Hex(canonical) === ref.sha256) return canonical;
			}
			throw new Error("contract_capsule_not_found");
		}
		if (uri.startsWith("contract://")) throw new Error(`unsupported_record_uri: ${uri}`);

		if (uri.startsWith("file://") || path.isAbsolute(uri) || /^[a-zA-Z]:[\\/]/.test(uri)) {
			const filePath = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
			return Bun.file(filePath).text();
		}

		throw new Error(`unsupported_record_uri: ${uri}`);
	};

	return ref => resolveRef(ref, 0);
}
