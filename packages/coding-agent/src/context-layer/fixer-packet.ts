import * as fs from "node:fs/promises";
import * as path from "node:path";

export type FixerSliceReason = "definition" | "diagnostic" | "reference" | "search" | "summary";

export interface FixerContextRange {
	readonly startLine: number;
	readonly endLine: number;
}

export interface FixerEvidenceCandidate {
	readonly type: "lsp" | "file" | "diagnostic" | "summary" | "search" | "cache";
	readonly file?: string;
	readonly range?: FixerContextRange;
	readonly symbol?: string;
	readonly detail: string;
}

export interface FixerContextSlice {
	readonly file: string;
	readonly range: FixerContextRange;
	readonly reason: FixerSliceReason;
	readonly score: number;
	readonly snippet: string;
	readonly tokenEstimate: number;
	readonly containsTarget: boolean;
}

export interface FixerContextPacketOptions {
	readonly file?: string;
	readonly maxTokens?: number;
	readonly contextLines?: number;
	readonly maxSlices?: number;
}

export interface FixerContextPacket {
	readonly target: string;
	readonly slices: readonly FixerContextSlice[];
	readonly filesIncluded: readonly string[];
	readonly tokenEstimate: number;
	readonly maxTokens: number;
	readonly droppedEvidenceCount: number;
	readonly totalCandidateCount: number;
	readonly targetSymbolIncluded: boolean;
}

const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_CONTEXT_LINES = 6;
const DEFAULT_MAX_SLICES = 12;

export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CODE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py)$/i;
const DOC_FILE_RE = /\.(?:md|mdx|txt|rst)$/i;

function classifySlice(
	target: string,
	candidate: FixerEvidenceCandidate,
	snippet: string,
	preferredFile?: string,
): { reason: FixerSliceReason; score: number; containsTarget: boolean } {
	const escaped = escapeRegExp(target);
	const defPattern = new RegExp(
		`\\b(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|const|let|var|enum|def)\\s+${escaped}\\b`,
	);
	const callOrImportPattern = new RegExp(`(?:\\bimport\\b[^\\n]*\\b${escaped}\\b|\\b${escaped}\\s*\\()`);
	const wordPattern = new RegExp(`\\b${escaped}\\b`);
	const file = candidate.file ?? "";
	const isCodeFile = CODE_FILE_RE.test(file);
	const isDocFile = DOC_FILE_RE.test(file);
	const containsTarget = target.length > 0 && (wordPattern.test(snippet) || snippet.includes(target));
	const isDefinition =
		target.length > 0 &&
		((isCodeFile && defPattern.test(snippet)) ||
			(candidate.type === "lsp" && candidate.detail.startsWith("definition:")));
	const isCodeCallOrImport = target.length > 0 && isCodeFile && callOrImportPattern.test(snippet);

	let reason: FixerSliceReason;
	let score: number;
	if (isDefinition) {
		reason = "definition";
		score = 100;
	} else if (candidate.type === "diagnostic") {
		reason = "diagnostic";
		score = 85;
	} else if (candidate.type === "lsp" || isCodeCallOrImport) {
		reason = "reference";
		score = 80;
	} else if (candidate.type === "search") {
		reason = "search";
		score = isDocFile ? 35 : 60;
	} else {
		reason = "summary";
		score = 25;
	}

	if (containsTarget) score += 15;
	if (preferredFile && file === preferredFile) score += 10;
	return { reason, score, containsTarget };
}

function rangesOverlap(a: FixerContextRange, b: FixerContextRange): boolean {
	return a.startLine <= b.endLine + 1 && b.startLine <= a.endLine + 1;
}

async function readWindowSnippet(
	cwd: string,
	relFile: string,
	range: FixerContextRange | undefined,
	contextLines: number,
): Promise<{ range: FixerContextRange; snippet: string } | null> {
	const abs = path.isAbsolute(relFile) ? relFile : path.resolve(cwd, relFile);
	const raw = await fs.readFile(abs, "utf8").catch(() => null);
	if (raw === null) return null;
	const lines = raw.split(/\r?\n/);
	if (lines.length === 0) return null;
	const anchorStart = Math.max(1, range?.startLine ?? 1);
	const anchorEnd = Math.max(anchorStart, range?.endLine ?? anchorStart);
	const startLine = Math.max(1, anchorStart - contextLines);
	const endLine = Math.min(lines.length, anchorEnd + contextLines);
	const numbered = lines
		.slice(startLine - 1, endLine)
		.map((line, idx) => `${startLine + idx}: ${line}`)
		.join("\n");
	return { range: { startLine, endLine }, snippet: numbered };
}

/**
 * Deterministically rank and budget minimal fixer-oriented file+symbol slices
 * under an explicit `maxTokens` cap, tracking `tokenEstimate` and `droppedEvidenceCount`.
 */
export async function rankAndBudgetFixerSlices(
	cwd: string,
	target: string,
	candidates: readonly FixerEvidenceCandidate[],
	options: FixerContextPacketOptions = {},
): Promise<FixerContextPacket> {
	const normalizedTarget = target.trim();
	const maxTokens = Math.max(32, Math.floor(options.maxTokens ?? DEFAULT_MAX_TOKENS));
	const contextLines = Math.max(0, Math.floor(options.contextLines ?? DEFAULT_CONTEXT_LINES));
	const maxSlices = Math.max(1, Math.floor(options.maxSlices ?? DEFAULT_MAX_SLICES));
	const preferredFile = options.file?.replaceAll("\\", "/");

	const built: FixerContextSlice[] = [];
	for (const candidate of candidates) {
		if (!candidate.file) continue;
		const relFile = candidate.file.replaceAll("\\", "/");
		const window = await readWindowSnippet(cwd, relFile, candidate.range, contextLines);
		if (!window) continue;
		const { reason, score, containsTarget } = classifySlice(
			normalizedTarget,
			candidate,
			window.snippet,
			preferredFile,
		);
		const header = `// ${relFile}:${window.range.startLine}-${window.range.endLine} (${reason})\n`;
		const snippet = `${header}${window.snippet}`;
		built.push({
			file: relFile,
			range: window.range,
			reason,
			score,
			snippet,
			tokenEstimate: estimateTokens(snippet),
			containsTarget,
		});
	}

	built.sort(
		(a, b) =>
			b.score - a.score ||
			a.tokenEstimate - b.tokenEstimate ||
			a.file.localeCompare(b.file) ||
			a.range.startLine - b.range.startLine,
	);

	// Deduplicate overlapping ranges in the same file (keeping highest-ranked slice first).
	const deduped: FixerContextSlice[] = [];
	let droppedEvidenceCount = 0;
	for (const slice of built) {
		const overlaps = deduped.some(kept => kept.file === slice.file && rangesOverlap(kept.range, slice.range));
		if (overlaps) {
			droppedEvidenceCount += 1;
			continue;
		}
		deduped.push(slice);
	}

	const selected: FixerContextSlice[] = [];
	let usedTokens = 0;
	for (const slice of deduped) {
		if (selected.length >= maxSlices) {
			droppedEvidenceCount += 1;
			continue;
		}
		if (usedTokens + slice.tokenEstimate > maxTokens) {
			droppedEvidenceCount += 1;
			continue;
		}
		selected.push(slice);
		usedTokens += slice.tokenEstimate;
	}

	const filesIncluded = [...new Set(selected.map(slice => slice.file))];
	return {
		target: normalizedTarget,
		slices: selected,
		filesIncluded,
		tokenEstimate: usedTokens,
		maxTokens,
		droppedEvidenceCount,
		totalCandidateCount: built.length,
		targetSymbolIncluded: selected.some(slice => slice.containsTarget),
	};
}

/** Deterministic workspace lexical scan producing fixer evidence candidates without LSP. */
export async function scanWorkspaceForTarget(
	cwd: string,
	target: string,
	maxMatches = 40,
): Promise<FixerEvidenceCandidate[]> {
	const evidence: FixerEvidenceCandidate[] = [];
	const query = target.trim();
	if (!query || query.length > 120) return evidence;

	const walk = async (dir: string): Promise<void> => {
		const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (evidence.length >= maxMatches) return;
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "build")
				continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|md|rs|go|py)$/.test(entry.name)) {
				const text = await fs.readFile(full, "utf8").catch(() => "");
				const lines = text.split(/\r?\n/);
				const rel = path.relative(cwd, full).replaceAll(path.sep, "/");
				for (let i = 0; i < lines.length && evidence.length < maxMatches; i++) {
					if (lines[i]?.includes(query)) {
						evidence.push({
							type: "search",
							file: rel,
							range: { startLine: i + 1, endLine: i + 1 },
							symbol: query,
							detail: lines[i].trim().slice(0, 240),
						});
					}
				}
			}
		}
	};

	await walk(cwd);
	return evidence;
}
