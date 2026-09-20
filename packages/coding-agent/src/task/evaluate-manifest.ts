export interface RevampEvaluateManifest {
	readonly candidateLabel: string;
	readonly baselineLabel: string;
	readonly tasks: readonly string[];
	readonly seeds: readonly number[];
	readonly limits: { readonly timeoutMs: number };
	readonly acceptancePolicy: string;
}

export interface RevampEvaluateReport {
	readonly candidateLabel: string;
	readonly baselineLabel: string;
	readonly taskResults: readonly { readonly task: string; readonly pass: boolean; readonly detail: string }[];
	readonly acceptedCount: number;
	readonly totalCount: number;
	readonly seedCount: number;
}

export function parseEvaluateManifest(raw: unknown): RevampEvaluateManifest {
	if (!raw || typeof raw !== "object") throw new Error("Manifest must be a JSON object.");
	const manifest = raw as Record<string, unknown>;
	for (const key of ["candidateLabel", "baselineLabel", "acceptancePolicy"] as const) {
		if (typeof manifest[key] !== "string" || !(manifest[key] as string).trim()) {
			throw new Error(`Manifest field '${key}' must be a non-empty string.`);
		}
	}
	if (
		!Array.isArray(manifest.tasks) ||
		manifest.tasks.length === 0 ||
		manifest.tasks.some(t => typeof t !== "string")
	) {
		throw new Error("Manifest field 'tasks' must be a non-empty string array.");
	}
	if (!Array.isArray(manifest.seeds) || manifest.seeds.some(s => typeof s !== "number")) {
		throw new Error("Manifest field 'seeds' must be a number array.");
	}
	const limits = manifest.limits as { timeoutMs?: unknown } | undefined;
	if (!limits || typeof limits.timeoutMs !== "number" || limits.timeoutMs <= 0) {
		throw new Error("Manifest field 'limits.timeoutMs' must be a positive number.");
	}
	return {
		candidateLabel: manifest.candidateLabel as string,
		baselineLabel: manifest.baselineLabel as string,
		tasks: manifest.tasks as string[],
		seeds: manifest.seeds as number[],
		limits: { timeoutMs: limits.timeoutMs },
		acceptancePolicy: manifest.acceptancePolicy as string,
	};
}
