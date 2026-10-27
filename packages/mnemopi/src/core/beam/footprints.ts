import { relative, resolve, sep } from "node:path";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type { BeamMemoryState } from "./types";

type Row = Record<string, unknown>;

export type ArtifactType = "file" | "symbol" | "dir";
export type TouchMode = "read" | "write";

export interface FootprintContext {
	sessionId: string;
	repoRoot: string;
	paneId?: string | null;
	pid?: number;
	gitBranch?: string | null;
}

export interface FootprintArtifact {
	type: ArtifactType;
	key: string;
}

export interface FootprintCollision {
	other_session_id: string;
	other_pane_id: string | null;
	other_pid: number | null;
	other_branch: string | null;
	other_goal: string | null;
	artifact_type: ArtifactType;
	artifact_key: string;
	other_touch_mode: TouchMode;
	last_touched_at: number;
	is_process_alive: boolean;
}

export interface LiveSessionFootprint {
	session_id: string;
	pane_id: string | null;
	goal: string | null;
	last_active_at: number;
	footprint_summary: string;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isPidAlive(pid: number | null): boolean {
	if (pid === null || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export class FootprintTracker {
	readonly #ctx: FootprintContext;
	readonly #warnedPairs = new Set<string>();
	readonly #upsert: ReturnType<BeamMemoryState["db"]["prepare"]>;
	readonly #collisions: ReturnType<BeamMemoryState["db"]["prepare"]>;
	readonly #touchSession: ReturnType<BeamMemoryState["db"]["prepare"]>;
	readonly #registerSession: ReturnType<BeamMemoryState["db"]["prepare"]>;

	constructor(beam: BeamMemoryState, ctx: FootprintContext) {
		this.#ctx = ctx;
		this.#upsert = beam.db.prepare(`
			INSERT INTO session_footprints (
				session_id, pane_id, pid, git_branch,
				artifact_type, artifact_key, touch_mode,
				touch_count, first_touched_at, last_touched_at, consolidated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
			ON CONFLICT(session_id, artifact_type, artifact_key) DO UPDATE SET
				pane_id = excluded.pane_id,
				pid = excluded.pid,
				git_branch = COALESCE(excluded.git_branch, session_footprints.git_branch),
				touch_mode = CASE
					WHEN session_footprints.touch_mode = 'write' OR excluded.touch_mode = 'write' THEN 'write'
					ELSE 'read'
				END,
				touch_count = session_footprints.touch_count + 1,
				last_touched_at = excluded.last_touched_at,
				consolidated_at = NULL
		`);
		this.#collisions = beam.db.prepare(`
			SELECT
				sf.session_id AS other_session_id,
				sf.pane_id AS other_pane_id,
				sf.pid AS other_pid,
				sf.git_branch AS other_branch,
				s.initial_prompt AS other_goal,
				sf.touch_mode AS other_touch_mode,
				sf.last_touched_at AS last_touched_at
			FROM session_footprints sf
			LEFT JOIN active_sessions s ON s.session_id = sf.session_id
			WHERE sf.artifact_type = ?
				AND sf.artifact_key = ?
				AND sf.session_id != ?
				AND sf.last_touched_at >= ?
				AND (sf.touch_mode = 'write' OR ? = 'write')
			ORDER BY sf.last_touched_at DESC
			LIMIT 3
		`);
		this.#touchSession = beam.db.prepare("UPDATE active_sessions SET last_active_at = ? WHERE session_id = ?");
		this.#registerSession = beam.db.prepare(`
			INSERT INTO active_sessions (session_id, pane_id, pid, initial_prompt, started_at, last_active_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				pane_id = excluded.pane_id,
				pid = excluded.pid,
				last_active_at = excluded.last_active_at
		`);
	}

	registerSession(initialPrompt: string): void {
		const now = Date.now();
		this.#registerSession.run(
			this.#ctx.sessionId,
			this.#ctx.paneId ?? null,
			this.#ctx.pid ?? process.pid,
			initialPrompt.slice(0, 160),
			now,
			now,
		);
	}

	normalizePath(rawPath: string): string | null {
		const abs = resolve(this.#ctx.repoRoot, rawPath);
		const rel = relative(this.#ctx.repoRoot, abs).split(sep).join("/");
		if (rel.startsWith("..") || rel.startsWith(".git/") || rel.includes("node_modules/")) return null;
		return rel;
	}

	recordAndCheck(
		artifacts: readonly FootprintArtifact[],
		mode: TouchMode,
		lookbackMs = 4 * 60 * 60 * 1000,
	): FootprintCollision[] {
		const now = Date.now();
		const cutoff = now - lookbackMs;
		const hits: FootprintCollision[] = [];
		this.#touchSession.run(now, this.#ctx.sessionId);

		for (const artifact of artifacts) {
			const key = artifact.type === "symbol" ? artifact.key.trim() : this.normalizePath(artifact.key);
			if (key === null || key.length === 0) continue;

			const rows = this.#collisions.all(artifact.type, key, this.#ctx.sessionId, cutoff, mode) as Row[];
			for (const row of rows) {
				const otherSessionId = asString(row.other_session_id);
				if (otherSessionId === null) continue;
				const dedupeKey = `${otherSessionId}:${artifact.type}:${key}`;
				if (this.#warnedPairs.has(dedupeKey)) continue;
				this.#warnedPairs.add(dedupeKey);
				const pid = asNumber(row.other_pid);
				hits.push({
					other_session_id: otherSessionId,
					other_pane_id: asString(row.other_pane_id),
					other_pid: pid,
					other_branch: asString(row.other_branch),
					other_goal: asString(row.other_goal),
					artifact_type: artifact.type,
					artifact_key: key,
					other_touch_mode: asString(row.other_touch_mode) === "write" ? "write" : "read",
					last_touched_at: asNumber(row.last_touched_at) ?? 0,
					is_process_alive: isPidAlive(pid),
				});
			}

			try {
				this.#upsert.run(
					this.#ctx.sessionId,
					this.#ctx.paneId ?? null,
					this.#ctx.pid ?? process.pid,
					this.#ctx.gitBranch ?? null,
					artifact.type,
					key,
					mode,
					now,
					now,
				);
			} catch (error) {
				logger.debug("mnemopi footprint upsert failed", { error: String(error) });
			}
		}
		return hits;
	}
}

/**
 * Lane 5 bridge: live sessions with unconsolidated footprints — the real-time
 * WAL that fills the gap between cmdSleep passes.
 */
export function liveFootprintSessions(
	beam: BeamMemoryState,
	sinceMs: number,
	excludeSessionId: string,
	limit = 8,
): LiveSessionFootprint[] {
	const cutoff = Date.now() - sinceMs;
	const rows = beam.db
		.query(
			`SELECT
				sf.session_id AS session_id,
				sf.pane_id AS pane_id,
				s.initial_prompt AS goal,
				MAX(sf.last_touched_at) AS last_active_at,
				GROUP_CONCAT(
					CASE WHEN sf.touch_mode = 'write' THEN '✏️ ' || sf.artifact_key ELSE sf.artifact_key END,
					', '
				) AS footprint_summary
			FROM session_footprints sf
			LEFT JOIN active_sessions s ON s.session_id = sf.session_id
			WHERE sf.consolidated_at IS NULL
				AND sf.last_touched_at >= ?
				AND sf.session_id != ?
			GROUP BY sf.session_id
			ORDER BY last_active_at DESC
			LIMIT ?`,
		)
		.all(cutoff, excludeSessionId, limit) as Row[];

	const out: LiveSessionFootprint[] = [];
	for (const row of rows) {
		const sessionId = asString(row.session_id);
		if (sessionId === null) continue;
		out.push({
			session_id: sessionId,
			pane_id: asString(row.pane_id),
			goal: asString(row.goal),
			last_active_at: asNumber(row.last_active_at) ?? 0,
			footprint_summary: asString(row.footprint_summary) ?? "",
		});
	}
	return out;
}

/** cmdSleep hook: mark a session's footprints as folded into the ledger. */
export function markFootprintsConsolidated(beam: BeamMemoryState, sessionIds: readonly string[]): void {
	if (sessionIds.length === 0) return;
	const now = Date.now();
	const statement = beam.db.prepare(
		"UPDATE session_footprints SET consolidated_at = ? WHERE session_id = ? AND consolidated_at IS NULL",
	);
	for (const sessionId of sessionIds) statement.run(now, sessionId);
}
