import * as path from "node:path";
import { isEnoent, logger } from "@pk-nerdsaver-ai/pi-utils";
import { repo } from "./git";
import { normalizePromptPath } from "./prompt-path";

export const SIM_LEDGER_RELATIVE_PATH = ".omp/sim.json";

export interface SimLedgerContext {
	path: string;
	content: string;
}

function isSimLedgerShape(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	if (!("problems" in value) || !Array.isArray(value.problems)) return false;
	if (!("next_id" in value) || typeof value.next_id !== "number") return false;
	if (!("aliases" in value) || typeof value.aliases !== "object" || value.aliases === null) return false;
	return true;
}

async function resolveStopDirectory(resolvedCwd: string): Promise<string> {
	try {
		const resolved = await repo.resolve(resolvedCwd);
		if (resolved?.repoRoot) {
			return path.resolve(resolved.repoRoot);
		}
	} catch {
		// Fall through to cwd-only lookup when git metadata is unavailable.
	}
	return resolvedCwd;
}

/**
 * Locate and load the full `.omp/sim.json` ledger by walking from `cwd` up to
 * the enclosing git repository root (or checking only `cwd` outside git).
 *
 * Returns the full JSON content verbatim (no truncation or retrieval layer)
 * when a valid SIM ledger exists, or `null` otherwise.
 */
export async function loadSimLedger(cwd: string): Promise<SimLedgerContext | null> {
	const resolvedCwd = path.resolve(cwd);
	const stopDir = await resolveStopDirectory(resolvedCwd);

	let current = resolvedCwd;
	while (true) {
		const candidate = path.join(current, ".omp", "sim.json");
		const file = Bun.file(candidate);
		try {
			const raw = await file.text();
			const trimmed = raw.trim();
			if (trimmed.length === 0) {
				return null;
			}
			const parsed: unknown = JSON.parse(trimmed);
			if (!isSimLedgerShape(parsed)) {
				logger.warn("Ignoring malformed SIM ledger (missing next_id, aliases, or problems)", {
					path: candidate,
				});
				return null;
			}
			const relative = path.relative(resolvedCwd, candidate);
			const displayPath = relative.length > 0 ? normalizePromptPath(relative) : SIM_LEDGER_RELATIVE_PATH;
			return {
				path: displayPath,
				content: trimmed,
			};
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Failed to load SIM ledger", { path: candidate, error: String(error) });
				return null;
			}
		}

		if (current === stopDir) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return null;
}
