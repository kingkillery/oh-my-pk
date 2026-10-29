export const MODEL = "amazon/titan-embed-image-v1-20261026";
export const DIMENSIONS = 384;
export const FORMAT_VERSION = "question-state-ascii-chunks-mean-v2";

// ASCII bytes bound token count without silently truncating decision evidence.
// ponytail: 120 characters is intentionally conservative; use a verified tokenizer if longer inputs are needed.
export function formatInput(question: string, state: string): string {
	if (!question.trim() || !state.trim()) throw new Error("question and state are required");
	const input = `Question: ${question}\nState: ${state}`;
	if (!/^[\x20-\x7e\n]+$/.test(input) || input.length > 120 * 16)
		throw new Error("input exceeds supported text budget or format");
	return input;
}

// Each ASCII character is at most one token in the conservative budget used here.
// Concatenation recovers the exact input; no state is removed. Pooling loses
// cross-chunk context, so this representation must be independently evaluated.
export function splitInput(input: string): string[] {
	if (!input || !/^[\x20-\x7e\n]+$/.test(input) || input.length > 120 * 16)
		throw new Error("input exceeds supported text budget or format");
	return input.match(/[\s\S]{1,120}/g)!;
}

export function normalize(vector: unknown): number[] {
	if (
		!Array.isArray(vector) ||
		vector.length !== DIMENSIONS ||
		!vector.every(x => typeof x === "number" && Number.isFinite(x))
	) {
		throw new Error("invalid embedding vector");
	}
	const norm = Math.sqrt(vector.reduce((sum: number, x: number) => sum + x * x, 0));
	if (!Number.isFinite(norm) || norm === 0) throw new Error("invalid embedding norm");
	return vector.map((x: number) => x / norm);
}

export async function embed(question: string, state: string, apiKey: string, timeoutMs = 10_000): Promise<number[]> {
	return (await embedWithReceipt(question, state, apiKey, timeoutMs)).vector;
}

export async function embedWithReceipt(
	question: string,
	state: string,
	apiKey: string,
	timeoutMs = 10_000,
): Promise<{ vector: number[]; latencyMs: number; costUsd: number | null; chunkCount: number }> {
	const input = splitInput(formatInput(question, state));
	if (!apiKey.trim()) throw new Error("OpenRouter key unavailable");
	const started = performance.now();
	const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			input,
			dimensions: DIMENSIONS,
			encoding_format: "float",
			provider: { only: ["amazon-bedrock"], allow_fallbacks: false },
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`embedding request failed (${response.status})`);
	const body: unknown = await response.json();
	const data = (body as { data?: { index?: number; embedding?: unknown }[] })?.data;
	if (!Array.isArray(data) || data.length !== input.length || data.some((row, i) => row?.index !== i))
		throw new Error("invalid embedding response order or count");
	const vectors = data.map(row => normalize(row.embedding));
	const cost = (body as { usage?: { cost?: unknown } }).usage?.cost;
	return {
		vector: normalize(
			Array.from(
				{ length: DIMENSIONS },
				(_, i) => vectors.reduce((sum, vector) => sum + vector[i]!, 0) / vectors.length,
			),
		),
		latencyMs: performance.now() - started,
		costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
		chunkCount: input.length,
	};
}
