import type { BeamMemoryState } from "./beam/types";

export interface MmrResult {
	readonly content?: string;
	readonly score?: number;
	readonly [key: string]: unknown;
}

export interface MmrCandidate extends MmrResult {
	readonly id?: string | number;
	readonly rerank_score?: number;
	readonly timestamp?: string | null;
	embedding?: Float32Array | null;
}

export interface MmrDiversifyOptions {
	lambda?: number;
	/** Retroactive interference weight: newer candidates suppress older near-duplicates. */
	wRetro?: number;
	/** Similarity at which a newer candidate begins suppressing an older one. */
	interferenceThreshold?: number;
}

function normalizeL2(vector: Float32Array): Float32Array {
	let sumSq = 0;
	for (let i = 0; i < vector.length; i++) sumSq += vector[i] * vector[i];
	if (sumSq === 0 || Math.abs(sumSq - 1) < 1e-5) return vector;
	const inv = 1 / Math.sqrt(sumSq);
	const out = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i++) out[i] = vector[i] * inv;
	return out;
}

function dotProduct(a: Float32Array, b: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
	return sum;
}

function minMaxNormalize(scores: readonly number[], floor = 0.05, ceil = 1): Float32Array {
	const out = new Float32Array(scores.length);
	if (scores.length === 0) return out;
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const score of scores) {
		if (score < min) min = score;
		if (score > max) max = score;
	}
	const span = max - min;
	if (span < 1e-9) {
		out.fill(ceil);
		return out;
	}
	for (let i = 0; i < scores.length; i++) {
		out[i] = floor + ((scores[i] - min) / span) * (ceil - floor);
	}
	return out;
}

function tokenizeToSet(text: string): Set<string> {
	const matches = text.toLowerCase().match(/[a-z0-9_]{2,}/g);
	return new Set(matches ?? []);
}

function jaccardSets(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let intersection = 0;
	for (const token of a) if (b.has(token)) intersection++;
	return intersection / (a.size + b.size - intersection);
}

/**
 * Batch-load stored embeddings for recall candidates so MMR can diversify on
 * cosine similarity instead of word overlap. memory_embeddings stores vectors
 * as JSON text; parsed rows are attached as normalized Float32Array.
 */
export function attachCandidateEmbeddings(beam: BeamMemoryState, candidates: readonly MmrCandidate[]): void {
	const missing = candidates.filter(candidate => candidate.embedding === undefined || candidate.embedding === null);
	if (missing.length === 0) return;
	const ids = missing
		.map(candidate => candidate.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	if (ids.length === 0) return;
	const placeholders = ids.map(() => "?").join(",");
	const rows = beam.db
		.query(`SELECT memory_id, embedding_json FROM memory_embeddings WHERE memory_id IN (${placeholders})`)
		.all(...ids) as Array<Record<string, unknown>>;
	const vectors = new Map<string, Float32Array>();
	for (const row of rows) {
		const memoryId = typeof row.memory_id === "string" ? row.memory_id : null;
		const json = typeof row.embedding_json === "string" ? row.embedding_json : null;
		if (memoryId === null || json === null) continue;
		try {
			const parsed: unknown = JSON.parse(json);
			if (Array.isArray(parsed)) vectors.set(memoryId, normalizeL2(Float32Array.from(parsed as number[])));
		} catch {
			// Malformed vector rows just fall back to Jaccard similarity.
		}
	}
	for (const candidate of missing) {
		candidate.embedding = (typeof candidate.id === "string" ? vectors.get(candidate.id) : undefined) ?? null;
	}
}

/**
 * Greedy MMR over recall candidates. Relevance (rerank_score ?? score) is
 * min-max normalized to [0.05, 1] so cross-encoder logits share the cosine
 * scale; pairwise similarity uses stored embeddings with a word-Jaccard
 * fallback. Retroactive interference decays older candidates that are highly
 * similar to newer ones so rolling snapshots do not crowd the top-K.
 */
export function mmrDiversify<T extends MmrCandidate>(
	candidates: readonly T[],
	topK: number,
	options: MmrDiversifyOptions = {},
): T[] {
	const n = candidates.length;
	if (n <= 1 || topK <= 0) return candidates.slice(0, Math.max(0, topK));
	const lambda = options.lambda ?? 0.65;
	const wRetro = options.wRetro ?? 0.6;
	const interferenceThreshold = options.interferenceThreshold ?? 0.82;

	// Interference decay applies to raw relevance BEFORE min-max normalization:
	// normalizing first collapses near-tied scores to the 0.05 floor, which no
	// multiplicative decay can recover from.
	const rawScores = candidates.map(c => c.rerank_score ?? c.score ?? 0);
	const normVecs = candidates.map(c => (c.embedding ? normalizeL2(c.embedding) : null));
	const wordSets: Array<Set<string> | null> = new Array<Set<string> | null>(n).fill(null);

	const sim = new Float32Array(n * n);
	for (let i = 0; i < n; i++) {
		sim[i * n + i] = 1;
		for (let j = i + 1; j < n; j++) {
			const a = normVecs[i];
			const b = normVecs[j];
			let value: number;
			if (a !== null && b !== null && a.length === b.length) {
				value = Math.max(0, dotProduct(a, b));
			} else {
				if (wordSets[i] === null) wordSets[i] = tokenizeToSet(candidates[i]?.content ?? "");
				if (wordSets[j] === null) wordSets[j] = tokenizeToSet(candidates[j]?.content ?? "");
				value = jaccardSets(wordSets[i] ?? new Set(), wordSets[j] ?? new Set());
			}
			sim[i * n + j] = value;
			sim[j * n + i] = value;
		}
	}

	if (wRetro > 0) {
		for (let j = 0; j < n; j++) {
			const tj = Date.parse(candidates[j]?.timestamp ?? "") || 0;
			let maxNewerSim = 0;
			for (let i = 0; i < n; i++) {
				if (i === j) continue;
				const ti = Date.parse(candidates[i]?.timestamp ?? "") || 0;
				const isNewer =
					ti > tj || (ti === tj && (candidates[i]?.content?.length ?? 0) > (candidates[j]?.content?.length ?? 0));
				if (isNewer && sim[i * n + j] >= interferenceThreshold && sim[i * n + j] > maxNewerSim) {
					maxNewerSim = sim[i * n + j];
				}
			}
			if (maxNewerSim > 0) rawScores[j] *= Math.max(0.1, 1 - wRetro * maxNewerSim);
		}
	}
	const relScores = minMaxNormalize(rawScores);

	const selected: number[] = [];
	const remaining = new Set<number>();
	for (let i = 0; i < n; i++) remaining.add(i);
	const target = Math.min(topK, n);
	while (selected.length < target && remaining.size > 0) {
		let bestIdx = -1;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (const idx of remaining) {
			const rel = relScores[idx] ?? 0;
			if (selected.length === 0) {
				if (rel > bestScore) {
					bestScore = rel;
					bestIdx = idx;
				}
				continue;
			}
			let maxSim = 0;
			for (const sel of selected) {
				const value = sim[idx * n + sel] ?? 0;
				if (value > maxSim) maxSim = value;
			}
			const mmrScore = lambda * rel - (1 - lambda) * maxSim;
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIdx = idx;
			}
		}
		if (bestIdx === -1) break;
		selected.push(bestIdx);
		remaining.delete(bestIdx);
	}
	return selected.map(idx => candidates[idx]) as T[];
}

export type SimilarityFn = (textA: string, textB: string) => number;

export function jaccardSimilarity(textA: string, textB: string): number {
	const wordsA = new Set(textA.toLowerCase().split(/\s+/).filter(Boolean));
	const wordsB = new Set(textB.toLowerCase().split(/\s+/).filter(Boolean));

	if (wordsA.size === 0 || wordsB.size === 0) return 0.0;

	let intersection = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) intersection += 1;
	}

	return intersection / (wordsA.size + wordsB.size - intersection);
}
export function mmrRerank<T extends MmrResult>(
	results: readonly T[],
	lambdaParam = 0.7,
	topK = 10,
	similarityFn: SimilarityFn = jaccardSimilarity,
): T[] {
	const limit = Math.max(0, Math.trunc(topK));
	if (limit <= 0) return [];
	if (results.length <= 1) return results.slice(0, limit);

	const sortedResults = results.slice().sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
	const first = sortedResults[0];
	if (first === undefined) return [];

	const selected: T[] = [first];
	const remaining = sortedResults.slice(1);

	while (remaining.length > 0 && selected.length < limit) {
		let bestIdx = 0;
		let bestScore = Number.NEGATIVE_INFINITY;

		for (let idx = 0; idx < remaining.length; idx += 1) {
			const candidate = remaining[idx];
			if (candidate === undefined) continue;

			let maxSimilarity = 0.0;
			const candidateContent = candidate.content ?? "";
			for (const selectedResult of selected) {
				const similarity = similarityFn(candidateContent, selectedResult.content ?? "");
				if (similarity > maxSimilarity) maxSimilarity = similarity;
			}

			const relevance = candidate.score ?? 0;
			const mmrScore = lambdaParam * relevance - (1.0 - lambdaParam) * maxSimilarity;
			if (mmrScore > bestScore) {
				bestScore = mmrScore;
				bestIdx = idx;
			}
		}

		const chosen = remaining.splice(bestIdx, 1)[0];
		if (chosen !== undefined) selected.push(chosen);
	}

	if (selected.length < limit) {
		selected.push(...remaining.slice(0, limit - selected.length));
	}

	return selected;
}
