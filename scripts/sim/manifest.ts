/**
 * Pre-evaluation SIM change manifest (arXiv:2611.18856 §3.2 & Appendix D.1).
 *
 * Enforces recording the problem match and `predicted` case IDs BEFORE running
 * evaluation, with a SHA-256 `prediction_hash` to detect post-hoc tampering.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SIM_PROBLEM_ID_RE } from "./schema.ts";

export const DEFAULT_MANIFEST_PATH = path.resolve(import.meta.dir, "..", "..", ".omp", "sim-manifest.json");

export type SimManifestStatus = "pending" | "consumed";

const MANIFEST_ALLOWED_KEYS = new Set([
	"version",
	"manifest_id",
	"status",
	"created_at",
	"consumed_at",
	"problem",
	"name",
	"round",
	"what",
	"files",
	"model",
	"domain",
	"benchmark",
	"sample",
	"backfilled",
	"predicted",
	"baseline_path",
	"baseline_model",
	"baseline_passed_ids",
	"baseline_failed_ids",
	"prediction_hash",
]);

export interface SimChangeManifest {
	version: 1;
	manifest_id: string;
	status: SimManifestStatus;
	created_at: string;
	consumed_at?: string;
	problem: string;
	name?: string;
	round?: number;
	what?: string;
	files?: string[];
	model?: string;
	domain?: string;
	benchmark?: string;
	sample?: string;
	backfilled?: boolean;
	predicted: string[];
	baseline_path?: string;
	baseline_model?: string;
	baseline_passed_ids?: string[];
	baseline_failed_ids?: string[];
	prediction_hash: string;
}

export interface CreateManifestInput {
	problem: string;
	name?: string;
	predicted: readonly string[];
	round?: number;
	what?: string;
	files?: readonly string[];
	model?: string;
	domain?: string;
	benchmark?: string;
	sample?: string;
	backfilled?: boolean;
	baseline_path?: string;
	baseline_model?: string;
	baseline_passed_ids?: readonly string[];
	baseline_failed_ids?: readonly string[];
	manifestId?: string;
	createdAt?: string;
}

export interface ManifestValidationResult {
	ok: boolean;
	errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function validateUniqueNonEmptyStrings(value: unknown, label: string, errors: string[]): string[] {
	if (!Array.isArray(value)) {
		errors.push(`${label} must be an array of strings`);
		return [];
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = 0; i < value.length; i++) {
		const entry = value[i];
		if (!isNonEmptyString(entry)) {
			errors.push(`${label}[${i}] must be a non-empty string`);
			continue;
		}
		if (seen.has(entry)) {
			errors.push(`${label}[${i}] duplicates "${entry}"`);
			continue;
		}
		seen.add(entry);
		out.push(entry);
	}
	return out;
}

/**
 * Deterministic SHA-256 hex digest over `{ problem, name, predicted }`.
 */
export function computePredictionHash(input: { problem: string; name?: string; predicted: string[] }): string {
	const canonical = JSON.stringify({
		problem: input.problem.trim(),
		name: input.name?.trim() ? input.name.trim() : null,
		predicted: input.predicted.map(id => id.trim()),
	});
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(canonical);
	return hasher.digest("hex");
}

export function createChangeManifest(input: CreateManifestInput): SimChangeManifest {
	const problem = input.problem.trim();
	if (problem !== "new" && !SIM_PROBLEM_ID_RE.test(problem)) {
		throw new Error(`Invalid manifest problem "${input.problem}": expected "new" or P<positive-integer>`);
	}
	const trimmedName = input.name?.trim();
	if (problem === "new" && !trimmedName) {
		throw new Error('Manifest requires a non-empty name when problem is "new"');
	}

	const predicted = input.predicted.map(id => id.trim()).filter(Boolean);
	if (predicted.length === 0) {
		throw new Error("Manifest requires at least one predicted case ID");
	}
	const uniquePredicted = new Set(predicted);
	if (uniquePredicted.size !== predicted.length) {
		throw new Error("Manifest predicted case IDs must be unique");
	}

	if (input.round !== undefined && (!Number.isInteger(input.round) || input.round < 1)) {
		throw new Error("Manifest round must be a positive integer");
	}

	const createdAt = input.createdAt?.trim() || new Date().toISOString();
	const predictionHash = computePredictionHash({
		problem,
		name: trimmedName,
		predicted,
	});
	const manifestId = input.manifestId?.trim() || `sim-manifest-${predictionHash.slice(0, 12)}`;

	const cleanedFiles = input.files?.map(f => f.trim()).filter(Boolean);
	return {
		version: 1,
		manifest_id: manifestId,
		status: "pending",
		created_at: createdAt,
		problem,
		...(trimmedName ? { name: trimmedName } : {}),
		...(input.round !== undefined ? { round: input.round } : {}),
		...(input.what?.trim() ? { what: input.what.trim() } : {}),
		...(cleanedFiles && cleanedFiles.length > 0 ? { files: cleanedFiles } : {}),
		...(input.model?.trim() ? { model: input.model.trim() } : {}),
		...(input.domain?.trim() ? { domain: input.domain.trim() } : {}),
		...(input.benchmark?.trim() ? { benchmark: input.benchmark.trim() } : {}),
		...(input.sample?.trim() ? { sample: input.sample.trim() } : {}),
		...(input.backfilled !== undefined ? { backfilled: input.backfilled } : {}),
		predicted,
		...(input.baseline_path?.trim() ? { baseline_path: input.baseline_path.trim() } : {}),
		...(input.baseline_model?.trim() ? { baseline_model: input.baseline_model.trim() } : {}),
		...(input.baseline_passed_ids ? { baseline_passed_ids: [...input.baseline_passed_ids] } : {}),
		...(input.baseline_failed_ids ? { baseline_failed_ids: [...input.baseline_failed_ids] } : {}),
		prediction_hash: predictionHash,
	};
}

export function validateChangeManifest(raw: unknown): ManifestValidationResult {
	const errors: string[] = [];
	if (!isRecord(raw)) {
		return { ok: false, errors: ["Manifest must be a JSON object"] };
	}

	for (const key of Object.keys(raw)) {
		if (!MANIFEST_ALLOWED_KEYS.has(key)) {
			errors.push(`manifest.${key} is not an allowed property`);
		}
	}

	if (raw.version !== 1) {
		errors.push("manifest.version must be 1");
	}
	if (!isNonEmptyString(raw.manifest_id)) {
		errors.push("manifest.manifest_id must be a non-empty string");
	}
	if (raw.status !== "pending" && raw.status !== "consumed") {
		errors.push('manifest.status must be "pending" or "consumed"');
	}
	if (!isNonEmptyString(raw.created_at)) {
		errors.push("manifest.created_at must be a non-empty string");
	}
	if (raw.consumed_at !== undefined && !isNonEmptyString(raw.consumed_at)) {
		errors.push("manifest.consumed_at must be a non-empty string when provided");
	}
	if (raw.status === "consumed" && !isNonEmptyString(raw.consumed_at)) {
		errors.push("manifest.consumed_at is required when status is consumed");
	}

	const problem = raw.problem;
	if (typeof problem !== "string" || (problem !== "new" && !SIM_PROBLEM_ID_RE.test(problem))) {
		errors.push('manifest.problem must be "new" or match /^P[1-9][0-9]*$/');
	}
	if (problem === "new" && !isNonEmptyString(raw.name)) {
		errors.push('manifest.name is required when problem is "new"');
	} else if (raw.name !== undefined && !isNonEmptyString(raw.name)) {
		errors.push("manifest.name must be a non-empty string when provided");
	}

	if (raw.round !== undefined && (typeof raw.round !== "number" || !Number.isInteger(raw.round) || raw.round < 1)) {
		errors.push("manifest.round must be a positive integer when provided");
	}

	for (const optionalStr of [
		"what",
		"model",
		"domain",
		"benchmark",
		"sample",
		"baseline_path",
		"baseline_model",
	] as const) {
		if (raw[optionalStr] !== undefined && !isNonEmptyString(raw[optionalStr])) {
			errors.push(`manifest.${optionalStr} must be a non-empty string when provided`);
		}
	}

	if (raw.backfilled !== undefined && typeof raw.backfilled !== "boolean") {
		errors.push("manifest.backfilled must be a boolean when provided");
	}

	if (raw.files !== undefined) {
		if (!Array.isArray(raw.files) || raw.files.length === 0 || !raw.files.every(isNonEmptyString)) {
			errors.push("manifest.files must be a non-empty array of non-empty strings when provided");
		}
	}

	const predicted = validateUniqueNonEmptyStrings(raw.predicted, "manifest.predicted", errors);
	if (predicted.length === 0) {
		errors.push("manifest.predicted must contain at least one case ID");
	}

	if (raw.baseline_passed_ids !== undefined) {
		validateUniqueNonEmptyStrings(raw.baseline_passed_ids, "manifest.baseline_passed_ids", errors);
	}
	if (raw.baseline_failed_ids !== undefined) {
		validateUniqueNonEmptyStrings(raw.baseline_failed_ids, "manifest.baseline_failed_ids", errors);
	}

	if (!isNonEmptyString(raw.prediction_hash)) {
		errors.push("manifest.prediction_hash must be a non-empty SHA-256 hex digest");
	} else if (typeof problem === "string" && predicted.length > 0) {
		const expectedHash = computePredictionHash({
			problem,
			name: typeof raw.name === "string" ? raw.name : undefined,
			predicted,
		});
		if (raw.prediction_hash !== expectedHash) {
			errors.push(
				`manifest.prediction_hash mismatch: expected ${expectedHash}, found ${raw.prediction_hash} (possible post-hoc tampering)`,
			);
		}
	}

	return { ok: errors.length === 0, errors };
}

export async function readChangeManifest(manifestPath: string): Promise<SimChangeManifest> {
	const rawText = await fs.readFile(manifestPath, "utf-8");
	const parsed: unknown = JSON.parse(rawText);
	const validation = validateChangeManifest(parsed);
	if (!validation.ok) {
		throw new Error(`Invalid SIM change manifest (${manifestPath}):\n- ${validation.errors.join("\n- ")}`);
	}
	return parsed as SimChangeManifest;
}

export async function writeChangeManifest(manifestPath: string, manifest: SimChangeManifest): Promise<void> {
	const validation = validateChangeManifest(manifest);
	if (!validation.ok) {
		throw new Error(`Refusing to write invalid SIM change manifest:\n- ${validation.errors.join("\n- ")}`);
	}
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`, "utf-8");
}

export function markManifestConsumed(manifest: SimChangeManifest, consumedAt?: string): SimChangeManifest {
	return {
		...manifest,
		status: "consumed",
		consumed_at: consumedAt?.trim() || new Date().toISOString(),
	};
}
