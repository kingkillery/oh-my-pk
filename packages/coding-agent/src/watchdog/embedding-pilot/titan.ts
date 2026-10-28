export const MODEL = "amazon/titan-embed-image-v1-20261026";
export const DIMENSIONS = 384;
export const FORMAT_VERSION = "question-state-ascii-v1";

// ASCII bytes bound token count without silently truncating decision evidence.
// ponytail: 120 characters is intentionally conservative; use a verified tokenizer if longer inputs are needed.
export function formatInput(question: string, state: string): string {
	if (!question.trim() || !state.trim()) throw new Error("question and state are required");
	const input = `Question: ${question}\nState: ${state}`;
	if (!/^[\x20-\x7e\n]+$/.test(input) || input.length > 120)
		throw new Error("input exceeds supported text budget or format");
	return input;
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
	const input = formatInput(question, state);
	if (!apiKey.trim()) throw new Error("OpenRouter key unavailable");
	const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({
			model: MODEL,
			input: [input],
			dimensions: DIMENSIONS,
			encoding_format: "float",
			provider: { only: ["amazon-bedrock"], allow_fallbacks: false },
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`embedding request failed (${response.status})`);
	const body: unknown = await response.json();
	const data = (body as { data?: { index?: number; embedding?: unknown }[] })?.data;
	if (!Array.isArray(data) || data.length !== 1 || data[0]?.index !== 0)
		throw new Error("invalid embedding response order or count");
	return normalize(data[0].embedding);
}
