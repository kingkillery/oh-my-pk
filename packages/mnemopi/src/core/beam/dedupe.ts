import { quoteSqlIdentifier } from "../../util/sql";
import { containmentRatio, type NearDupMember, prefixHash, toNearDupMember } from "./near-dup";
import type { BeamMemoryState } from "./types";

type Row = Record<string, unknown>;

export interface DedupeOptions {
	dryRun?: boolean;
	/** Minimum fraction of a member's shingles found in the canonical row to tombstone it. */
	containmentThreshold?: number;
	/** Tokens (after envelope stripping) used for the family signature. */
	prefixTokens?: number;
	/** Word-shingle width used for the containment check. */
	shingleSize?: number;
	/** Physically delete tombstoned rows instead of marking dup_superseded_by. */
	hardDelete?: boolean;
}

export interface DedupeFamilyReport {
	table: "working" | "episodic";
	canonical_id: string;
	tombstoned_ids: string[];
	kept_ids: string[];
	preview: string;
}

export interface DedupeResult {
	dry_run: boolean;
	scanned: { working: number; episodic: number };
	families: number;
	tombstoned: { working: number; episodic: number };
	kept_noncanonical: number;
	content_bytes_tombstoned: number;
	embeddings_removed: number;
	embedding_bytes_removed: number;
	hard_deleted: number;
	family_reports: DedupeFamilyReport[];
}

function tableExists(beam: BeamMemoryState, table: string): boolean {
	return (
		beam.db.query("SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ?").get(table) !==
		null
	);
}

export function dedupeBank(beam: BeamMemoryState, options: DedupeOptions = {}): DedupeResult {
	const dryRun = options.dryRun === true;
	const threshold = options.containmentThreshold ?? 0.85;
	const prefixTokens = Math.max(4, options.prefixTokens ?? 24);
	const shingleSize = Math.max(2, options.shingleSize ?? 8);
	const hardDelete = options.hardDelete === true;

	const result: DedupeResult = {
		dry_run: dryRun,
		scanned: { working: 0, episodic: 0 },
		families: 0,
		tombstoned: { working: 0, episodic: 0 },
		kept_noncanonical: 0,
		content_bytes_tombstoned: 0,
		embeddings_removed: 0,
		embedding_bytes_removed: 0,
		hard_deleted: 0,
		family_reports: [],
	};

	const tombstonedIds: string[] = [];
	const hasEmbeddings = tableExists(beam, "memory_embeddings");

	for (const spec of [
		{ table: "working_memory", tier: "working" as const },
		{ table: "episodic_memory", tier: "episodic" as const },
	]) {
		const tableSql = quoteSqlIdentifier(spec.table);
		const rows = beam.db
			.query(`SELECT id, content FROM ${tableSql} WHERE superseded_by IS NULL AND dup_superseded_by IS NULL`)
			.all() as Row[];

		const members: NearDupMember[] = [];
		const backfill = beam.db.prepare(
			`UPDATE ${tableSql} SET prefix_hash = ?, char_length = ? WHERE id = ? AND (prefix_hash IS NULL OR char_length IS NULL)`,
		);
		for (const row of rows) {
			const id = typeof row.id === "string" ? row.id : null;
			const content = typeof row.content === "string" ? row.content : null;
			if (id !== null && content !== null) {
				members.push(toNearDupMember(id, content, shingleSize));
				if (!dryRun) backfill.run(prefixHash(content), content.length, id);
			}
		}
		result.scanned[spec.tier] = members.length;

		const families = new Map<string, NearDupMember[]>();
		for (const member of members) {
			const signature = member.tokens.slice(0, prefixTokens).join(" ");
			if (signature.length === 0) continue;
			const family = families.get(signature);
			if (family) family.push(member);
			else families.set(signature, [member]);
		}

		for (const family of families.values()) {
			if (family.length < 2) continue;
			family.sort((a, b) => b.normalized.length - a.normalized.length);
			const canonical = family[0];
			if (canonical === undefined) continue;

			const report: DedupeFamilyReport = {
				table: spec.tier,
				canonical_id: canonical.id,
				tombstoned_ids: [],
				kept_ids: [],
				preview: canonical.normalized.slice(0, 80),
			};
			result.families++;

			for (const member of family.slice(1)) {
				if (member.id === canonical.id) continue;
				if (containmentRatio(member, canonical) >= threshold) {
					report.tombstoned_ids.push(member.id);
					result.tombstoned[spec.tier]++;
					result.content_bytes_tombstoned += member.content.length;
					tombstonedIds.push(member.id);
					if (!dryRun) {
						if (hardDelete) {
							beam.db.run(`DELETE FROM ${tableSql} WHERE id = ?`, [member.id]);
							result.hard_deleted++;
						} else {
							beam.db.run(`UPDATE ${tableSql} SET dup_superseded_by = ? WHERE id = ?`, [
								canonical.id,
								member.id,
							]);
						}
					}
				} else {
					report.kept_ids.push(member.id);
					result.kept_noncanonical++;
				}
			}
			result.family_reports.push(report);
		}
	}

	// Tombstoned rows are excluded from recall; their vectors are dead weight and
	// can always be recomputed later, so drop them regardless of hardDelete.
	if (hasEmbeddings && tombstonedIds.length > 0) {
		const placeholders = tombstonedIds.map(() => "?").join(",");
		const sized = beam.db
			.query(
				`SELECT COALESCE(SUM(LENGTH(embedding_json)), 0) AS bytes FROM memory_embeddings WHERE memory_id IN (${placeholders})`,
			)
			.get(...tombstonedIds) as Row | null;
		result.embedding_bytes_removed = typeof sized?.bytes === "number" ? sized.bytes : 0;
		const removed = beam.db
			.query(`SELECT COUNT(*) AS c FROM memory_embeddings WHERE memory_id IN (${placeholders})`)
			.get(...tombstonedIds) as Row | null;
		result.embeddings_removed = typeof removed?.c === "number" ? removed.c : 0;
		if (!dryRun) {
			beam.db.run(`DELETE FROM memory_embeddings WHERE memory_id IN (${placeholders})`, tombstonedIds);
		}
	}

	return result;
}
