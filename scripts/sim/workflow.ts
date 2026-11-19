/**
 * Deep in-process Self-Improvement Memory (SIM) workflow module.
 *
 * Pulls `predict -> replay -> record -> carry -> status -> validate -> merge -> cases`
 * behind one seam so callers (`scripts/sim/cli.ts`, programmatic harnesses, and
 * tests) exercise the full SIM lifecycle without touching raw manifest hashes,
 * fallback chains, JSONL formatting, or `console.*` globals.
 *
 * Dependency strategy (`code-module-design` / `DEEPENING.md`):
 * - In-process (no seam): ledger validation, alias/exact-text resolution, round
 *   numbering, SHA-256 prediction digests, and 8-state baseline-to-candidate attribution.
 * - Local-substitutable (two real adapters per seam):
 *   1. `SimTextStore` — async filesystem adapter in production vs `createInMemorySimStore()` in tests.
 *   2. `runReplay` — live deterministic `runSimReplay` in production vs canned reports in tests.
 */
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@pk-nerdsaver-ai/pi-utils";
import {
	createChangeManifest,
	markManifestConsumed,
	type SimChangeManifest,
	validateChangeManifest,
} from "./manifest.ts";
import { runSimReplay, SIM_REPLAY_CASES, type SimReplayCase } from "./replay.ts";
import {
	type AppendAttemptResult,
	appendSimAttempt,
	type CarryForwardInput,
	carryForwardSimLedger,
	computeNextRound,
	createEmptySimLedger,
	evaluateReplayDiff,
	mergeDuplicateProblems,
	resolveProblemId,
	type SimLedger,
	type SimRejectedCandidateLogEntry,
	type SimReplayBaselineMeta,
	type SimReplayCaseResult,
	type SimReplayDiff,
	type SimReplayReport,
	validateSimLedger,
} from "./schema.ts";

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dir, "../..");

export type SimWorkflowErrorCode =
	| "usage"
	| "not_found"
	| "validation"
	| "manifest_state"
	| "manifest_mismatch"
	| "model_mismatch"
	| "store";

export class SimWorkflowError extends Error {
	readonly code: SimWorkflowErrorCode;

	constructor(code: SimWorkflowErrorCode, message: string) {
		super(message);
		this.name = "SimWorkflowError";
		this.code = code;
	}
}

export interface SimTextStore {
	readText(filePath: string): Promise<string | undefined>;
	writeText(filePath: string, content: string): Promise<void>;
	appendText(filePath: string, content: string): Promise<void>;
}

export interface InMemorySimStore extends SimTextStore {
	peekText(filePath: string): string | undefined;
	seedText(filePath: string, content: string): void;
	seedJson(filePath: string, value: unknown): void;
	peekRejectedEntries(rejectedLogPath: string): SimRejectedCandidateLogEntry[];
}

export interface SimWorkflowPaths {
	readonly rootDir: string;
	readonly ledgerPath: string;
	readonly manifestPath: string;
	readonly rejectedLogPath: string;
}

export interface SimWorkflowOptions {
	rootDir?: string;
	ledgerPath?: string;
	manifestPath?: string;
	rejectedLogPath?: string;
	store?: SimTextStore;
	runReplay?: (options?: { model?: string }) => Promise<SimReplayReport>;
	knownCaseIds?: Iterable<string>;
	now?: () => string;
}

export type SimBaselineSource = "explicit" | "manifest_path" | "manifest_inline" | "none";
export type SimCandidateSource = "explicit" | "file" | "live_replay";

export interface SimPredictInput {
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
	baseline?: SimReplayBaselineMeta;
	baselinePath?: string;
	force?: boolean;
	allowUnknownCases?: boolean;
	allowPreserved?: boolean;
}

export interface SimPredictResult {
	manifestPath: string;
	manifest: SimChangeManifest;
	baselineSource: SimBaselineSource;
}

export interface SimRecordInput {
	problem?: string;
	name?: string;
	predicted?: readonly string[];
	what?: string;
	files?: readonly string[];
	model?: string;
	domain?: string;
	benchmark?: string;
	sample?: string;
	accepted?: boolean;
	backfilled?: boolean;
	allowAdHoc?: boolean;
	round?: number;
	run?: string;
	commit?: string;
	baseline?: SimReplayBaselineMeta;
	baselinePath?: string;
	candidate?: SimReplayReport;
	replayJsonPath?: string;
	baselineRef?: string;
	candidateRef?: string;
	noRejectedLog?: boolean;
}

export type SimRecordResult =
	| {
			recorded: true;
			problemId: string;
			createdProblem: boolean;
			mergedFromAlias?: string;
			round: number;
			report: SimReplayReport;
			diff: SimReplayDiff;
			baselineSource: SimBaselineSource;
			candidateSource: SimCandidateSource;
			ledgerPath: string;
			ledgerWritten: true;
			manifestId?: string;
			manifestConsumed: boolean;
	  }
	| {
			recorded: false;
			reason: string;
			round: number;
			report: SimReplayReport;
			diff: SimReplayDiff;
			baselineSource: SimBaselineSource;
			candidateSource: SimCandidateSource;
			ledgerPath: string;
			ledgerWritten: false;
			rejectedLogPath?: string;
			rejectedLogAppended: boolean;
			manifestId?: string;
			manifestConsumed: boolean;
	  };

export interface SimReplayInput {
	model?: string;
	baseline?: SimReplayBaselineMeta;
	baselinePath?: string;
	savePath?: string;
}

export interface SimReplayResult {
	report: SimReplayReport;
	diff?: SimReplayDiff;
	savedPath?: string;
}

export interface SimCarryResult {
	ledgerPath: string;
	ledger: SimLedger;
	carriedFrom: SimLedger["carried_from"];
	nextRound: number;
	problemCount: number;
}

export interface SimMergeResult {
	ledgerPath: string;
	ledger: SimLedger;
	merged: Array<{ from: string; into: string; name: string }>;
}

export type SimValidateResult =
	| {
			valid: true;
			ledgerPath: string;
			problemCount: number;
			attemptCount: number;
			aliasCount: number;
	  }
	| {
			valid: false;
			missing: boolean;
			ledgerPath: string;
			errors: string[];
	  };

export interface SimStatusProblemSummary {
	id: string;
	name: string;
	opened_round: number;
	attempts: number;
	latest_score: string;
	unresolved_predictions: string[];
	missed: string[];
	regressed: string[];
	unresolved: string[];
	unproven: string[];
	incomplete: string[];
	preserved: string[];
	domains: string[];
	benchmarks: string[];
	models: string[];
}

export interface SimStatusSummary {
	ledger: string;
	schema_version: 1 | 2;
	next_id: number;
	carried_from: SimLedger["carried_from"] | null;
	aliases: Record<string, string>;
	problem_count: number;
	attempt_count: number;
	problems: SimStatusProblemSummary[];
}

export interface SimWorkflow {
	readonly paths: SimWorkflowPaths;
	predict(input: SimPredictInput): Promise<SimPredictResult>;
	record(input?: SimRecordInput): Promise<SimRecordResult>;
	replay(input?: SimReplayInput): Promise<SimReplayResult>;
	carry(input: CarryForwardInput): Promise<SimCarryResult>;
	merge(): Promise<SimMergeResult>;
	validate(): Promise<SimValidateResult>;
	status(): Promise<SimStatusSummary>;
	cases(): readonly SimReplayCase[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStoreKey(filePath: string): string {
	return path.resolve(filePath).replace(/\\/g, "/");
}

function createFilesystemSimStore(): SimTextStore {
	return {
		async readText(filePath: string): Promise<string | undefined> {
			try {
				return await Bun.file(filePath).text();
			} catch (err) {
				if (isEnoent(err)) {
					return undefined;
				}
				throw new SimWorkflowError(
					"store",
					`Failed reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
		async writeText(filePath: string, content: string): Promise<void> {
			try {
				await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
				await Bun.write(filePath, content);
			} catch (err) {
				throw new SimWorkflowError(
					"store",
					`Failed writing ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
		async appendText(filePath: string, content: string): Promise<void> {
			try {
				await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
				await fsPromises.appendFile(filePath, content, "utf-8");
			} catch (err) {
				throw new SimWorkflowError(
					"store",
					`Failed appending ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	};
}

export function createInMemorySimStore(seed?: Record<string, string>): InMemorySimStore {
	const files = new Map<string, string>();
	if (seed) {
		for (const [key, content] of Object.entries(seed)) {
			files.set(normalizeStoreKey(key), content);
		}
	}

	return {
		async readText(filePath: string): Promise<string | undefined> {
			return files.get(normalizeStoreKey(filePath));
		},
		async writeText(filePath: string, content: string): Promise<void> {
			files.set(normalizeStoreKey(filePath), content);
		},
		async appendText(filePath: string, content: string): Promise<void> {
			const key = normalizeStoreKey(filePath);
			files.set(key, `${files.get(key) ?? ""}${content}`);
		},
		peekText(filePath: string): string | undefined {
			return files.get(normalizeStoreKey(filePath));
		},
		seedText(filePath: string, content: string): void {
			files.set(normalizeStoreKey(filePath), content);
		},
		seedJson(filePath: string, value: unknown): void {
			files.set(normalizeStoreKey(filePath), `${JSON.stringify(value, null, "\t")}\n`);
		},
		peekRejectedEntries(rejectedLogPath: string): SimRejectedCandidateLogEntry[] {
			const raw = files.get(normalizeStoreKey(rejectedLogPath));
			if (!raw) return [];
			return raw
				.split("\n")
				.map(line => line.trim())
				.filter(Boolean)
				.map(line => JSON.parse(line) as SimRejectedCandidateLogEntry);
		},
	};
}

function readCaseDurationMs(item: unknown): number {
	if (!isRecord(item)) return 0;
	if (typeof item.duration_ms === "number") return item.duration_ms;
	if (typeof item.durationMs === "number") return item.durationMs;
	return 0;
}

function parseReplayCaseResults(raw: unknown): SimReplayCaseResult[] {
	if (!Array.isArray(raw)) return [];
	const out: SimReplayCaseResult[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const id = typeof entry.id === "string" ? entry.id : "";
		const category = entry.category;
		const description = typeof entry.description === "string" ? entry.description : "";
		const passed = typeof entry.passed === "boolean" ? entry.passed : false;
		const duration_ms = readCaseDurationMs(entry);
		const error = typeof entry.error === "string" ? entry.error : undefined;
		if (
			id &&
			(category === "parser" ||
				category === "retry" ||
				category === "truncation" ||
				category === "hooks" ||
				category === "compat")
		) {
			out.push({
				id,
				category,
				description,
				passed,
				duration_ms,
				...(error ? { error } : {}),
			});
		}
	}
	return out;
}

function parseJsonOrThrow(rawText: string, filePath: string, label: string): unknown {
	try {
		return JSON.parse(rawText);
	} catch (err) {
		throw new SimWorkflowError(
			"validation",
			`Invalid ${label} JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

function parseBaselineText(rawText: string, filePath: string): SimReplayBaselineMeta {
	const parsed = parseJsonOrThrow(rawText, filePath, "baseline");
	if (!isRecord(parsed) || !Array.isArray(parsed.passed_ids) || !Array.isArray(parsed.failed_ids)) {
		throw new SimWorkflowError(
			"validation",
			`Invalid baseline JSON at ${filePath}: expected { passed_ids: string[], failed_ids: string[] }`,
		);
	}
	const passed_ids = parsed.passed_ids.filter((v): v is string => typeof v === "string");
	const failed_ids = parsed.failed_ids.filter((v): v is string => typeof v === "string");
	const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
	const evaluator_id =
		typeof parsed.evaluator_id === "string" && parsed.evaluator_id.trim() ? parsed.evaluator_id.trim() : undefined;
	return { passed_ids, failed_ids, ...(model ? { model } : {}), ...(evaluator_id ? { evaluator_id } : {}) };
}

function parseReplayReportText(rawText: string, filePath: string, fallbackNow: () => string): SimReplayReport {
	const parsed = parseJsonOrThrow(rawText, filePath, "replay report");
	if (
		!isRecord(parsed) ||
		!Array.isArray(parsed.passed_ids) ||
		!Array.isArray(parsed.failed_ids) ||
		typeof parsed.passed !== "number" ||
		typeof parsed.total !== "number"
	) {
		throw new SimWorkflowError("validation", `Invalid replay report JSON at ${filePath}`);
	}
	const passed_ids = parsed.passed_ids.filter((v): v is string => typeof v === "string");
	const failed_ids = parsed.failed_ids.filter((v): v is string => typeof v === "string");
	const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : fallbackNow();
	const model = typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : undefined;
	const results = parseReplayCaseResults(parsed.results);
	return {
		timestamp,
		passed: parsed.passed,
		total: parsed.total,
		passed_ids,
		failed_ids,
		...(model ? { model } : {}),
		results,
	};
}

function sameStringList(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function serializeLedger(ledger: SimLedger): string {
	return `${JSON.stringify(ledger, null, "\t")}\n`;
}

export function createSimWorkflow(options?: SimWorkflowOptions): SimWorkflow {
	const rootDir = path.resolve(options?.rootDir ?? DEFAULT_REPO_ROOT);
	const paths: SimWorkflowPaths = {
		rootDir,
		ledgerPath: path.resolve(options?.ledgerPath ?? path.join(rootDir, ".omp", "sim.json")),
		manifestPath: path.resolve(options?.manifestPath ?? path.join(rootDir, ".omp", "sim-manifest.json")),
		rejectedLogPath: path.resolve(options?.rejectedLogPath ?? path.join(rootDir, ".omp", "sim-rejected.jsonl")),
	};
	const store = options?.store ?? createFilesystemSimStore();
	const now = options?.now ?? (() => new Date().toISOString());
	const knownCaseSet = new Set(options?.knownCaseIds ?? SIM_REPLAY_CASES.map(c => c.id));

	const executeReplay = async (replayOpts?: { model?: string }): Promise<SimReplayReport> => {
		if (options?.runReplay) {
			const custom = await options.runReplay(replayOpts);
			return {
				...custom,
				timestamp: custom.timestamp || now(),
				...(replayOpts?.model?.trim()
					? { model: replayOpts.model.trim() }
					: custom.model
						? { model: custom.model }
						: {}),
			};
		}
		const live = await runSimReplay();
		const model = replayOpts?.model?.trim();
		return {
			timestamp: now(),
			passed: live.passed,
			total: live.total,
			passed_ids: live.passed_ids,
			failed_ids: live.failed_ids,
			...(model ? { model } : {}),
			results: live.results.map(r => ({
				id: r.id,
				category: r.category,
				description: r.description,
				passed: r.passed,
				duration_ms: readCaseDurationMs(r),
				...(r.error ? { error: r.error } : {}),
			})),
		};
	};

	const readLedgerOrThrow = async (): Promise<SimLedger> => {
		const rawText = await store.readText(paths.ledgerPath);
		if (rawText === undefined) {
			throw new SimWorkflowError("not_found", `SIM ledger not found at ${paths.ledgerPath}`);
		}
		const raw = parseJsonOrThrow(rawText, paths.ledgerPath, "SIM ledger");
		const check = validateSimLedger(raw);
		if (!check.ok) {
			throw new SimWorkflowError("validation", `SIM ledger validation failed:\n- ${check.errors.join("\n- ")}`);
		}
		return raw as SimLedger;
	};

	const readBaselineFromStore = async (baselinePath: string): Promise<SimReplayBaselineMeta> => {
		const resolved = path.resolve(baselinePath);
		const rawText = await store.readText(resolved);
		if (rawText === undefined) {
			throw new SimWorkflowError("not_found", `Baseline JSON not found at ${resolved}`);
		}
		return parseBaselineText(rawText, resolved);
	};

	const readManifestOrThrow = async (): Promise<SimChangeManifest | undefined> => {
		const rawText = await store.readText(paths.manifestPath);
		if (rawText === undefined) {
			return undefined;
		}
		const parsed = parseJsonOrThrow(rawText, paths.manifestPath, "SIM change manifest");
		const validation = validateChangeManifest(parsed);
		if (!validation.ok) {
			throw new SimWorkflowError(
				"validation",
				`Invalid SIM change manifest (${paths.manifestPath}):\n- ${validation.errors.join("\n- ")}`,
			);
		}
		return parsed as SimChangeManifest;
	};

	const writeValidatedManifest = async (manifest: SimChangeManifest): Promise<void> => {
		const validation = validateChangeManifest(manifest);
		if (!validation.ok) {
			throw new SimWorkflowError(
				"validation",
				`Refusing to write invalid SIM change manifest:\n- ${validation.errors.join("\n- ")}`,
			);
		}
		await store.writeText(paths.manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	};

	return {
		paths,

		cases(): readonly SimReplayCase[] {
			return SIM_REPLAY_CASES;
		},

		async replay(input?: SimReplayInput): Promise<SimReplayResult> {
			const report = await executeReplay({ model: input?.model });
			let baseline: SimReplayBaselineMeta | undefined;
			if (input?.baseline) {
				baseline = input.baseline;
			} else if (input?.baselinePath) {
				baseline = await readBaselineFromStore(input.baselinePath);
			}

			const diff = baseline
				? evaluateReplayDiff(
						report,
						[...new Set([...baseline.failed_ids, ...report.failed_ids])],
						baseline,
						report.model ? { candidateModel: report.model } : undefined,
					)
				: undefined;

			let savedPath: string | undefined;
			if (input?.savePath) {
				savedPath = path.resolve(input.savePath);
				await store.writeText(savedPath, `${JSON.stringify(report, null, "\t")}\n`);
			}

			return {
				report,
				...(diff ? { diff } : {}),
				...(savedPath ? { savedPath } : {}),
			};
		},

		async predict(input: SimPredictInput): Promise<SimPredictResult> {
			const problem = input.problem?.trim() ?? "";
			const predicted = input.predicted.map(id => id.trim()).filter(Boolean);
			if (!problem) {
				throw new SimWorkflowError("usage", "predict requires --problem <P#|new>");
			}
			if (predicted.length === 0) {
				throw new SimWorkflowError("usage", "predict requires non-empty --predicted <id1,id2,...>");
			}

			if (!input.allowUnknownCases) {
				const unknown = predicted.filter(id => !knownCaseSet.has(id));
				if (unknown.length > 0) {
					throw new SimWorkflowError(
						"usage",
						`Unknown replay case ID(s) in --predicted: ${unknown.join(", ")} (pass --allow-unknown-cases to override)`,
					);
				}
			}

			if (!input.force) {
				const existing = await readManifestOrThrow();
				if (existing?.status === "pending") {
					throw new SimWorkflowError(
						"manifest_state",
						`Pending manifest already exists at ${paths.manifestPath} (${existing.manifest_id}); consume it with 'record' or pass --force to replace it`,
					);
				}
			}

			let baselineMeta: SimReplayBaselineMeta | undefined;
			let baselineSource: SimBaselineSource = "none";
			let resolvedBaselinePath: string | undefined;
			if (input.baseline) {
				baselineMeta = input.baseline;
				baselineSource = "explicit";
			} else if (input.baselinePath) {
				resolvedBaselinePath = path.resolve(input.baselinePath);
				baselineMeta = await readBaselineFromStore(resolvedBaselinePath);
				baselineSource = "explicit";
			}

			if (baselineMeta && !input.allowPreserved) {
				const baselinePassSet = new Set(baselineMeta.passed_ids);
				const alreadyPassing = predicted.filter(id => baselinePassSet.has(id));
				if (alreadyPassing.length > 0) {
					throw new SimWorkflowError(
						"usage",
						`Predicted case(s) already pass in baseline: ${alreadyPassing.join(", ")} (pass --allow-preserved to acknowledge)`,
					);
				}
			}

			let manifest: SimChangeManifest;
			try {
				manifest = createChangeManifest({
					problem,
					name: input.name,
					predicted,
					round: input.round,
					what: input.what,
					files: input.files,
					model: input.model,
					domain: input.domain,
					benchmark: input.benchmark,
					sample: input.sample,
					backfilled: input.backfilled,
					baseline_path: resolvedBaselinePath,
					baseline_model: baselineMeta?.model,
					baseline_passed_ids: baselineMeta?.passed_ids,
					baseline_failed_ids: baselineMeta?.failed_ids,
					createdAt: now(),
				});
			} catch (err) {
				throw new SimWorkflowError("usage", err instanceof Error ? err.message : String(err));
			}

			await writeValidatedManifest(manifest);
			return {
				manifestPath: paths.manifestPath,
				manifest,
				baselineSource,
			};
		},

		async record(input?: SimRecordInput): Promise<SimRecordResult> {
			const opts = input ?? {};
			const allowAdHoc = opts.allowAdHoc ?? false;
			const noRejectedLog = opts.noRejectedLog ?? false;

			let manifest: SimChangeManifest | undefined;
			if (opts.backfilled === true && allowAdHoc) {
				// Historical backfill explicitly bypasses pre-evaluation manifest requirement.
			} else {
				manifest = await readManifestOrThrow();
				if (!manifest) {
					throw new SimWorkflowError(
						"manifest_state",
						`Missing pre-eval SIM manifest at ${paths.manifestPath}. Run 'bun run sim:predict ...' before evaluation (or pass --backfilled true --allow-ad-hoc for historical backfills).`,
					);
				}
				if (manifest.status !== "pending") {
					throw new SimWorkflowError(
						"manifest_state",
						`SIM manifest ${manifest.manifest_id} at ${paths.manifestPath} is already "${manifest.status}". Run 'bun run sim:predict' for a new round.`,
					);
				}
			}

			const callerProblem = opts.problem;
			const callerName = opts.name;
			const callerPredicted = opts.predicted ? opts.predicted.map(id => id.trim()).filter(Boolean) : undefined;

			const problem = manifest ? manifest.problem : callerProblem?.trim();
			if (!problem) {
				throw new SimWorkflowError("usage", "Missing required flag --problem <P#|new>");
			}
			if (manifest && callerProblem !== undefined && callerProblem.trim() !== manifest.problem) {
				throw new SimWorkflowError(
					"manifest_mismatch",
					`CLI --problem "${callerProblem}" contradicts pre-eval manifest problem "${manifest.problem}" (${manifest.manifest_id})`,
				);
			}
			if (manifest?.name && callerName !== undefined && callerName.trim() !== manifest.name.trim()) {
				throw new SimWorkflowError(
					"manifest_mismatch",
					`CLI --name "${callerName}" contradicts pre-eval manifest name "${manifest.name}" (${manifest.manifest_id})`,
				);
			}
			const name = manifest ? (manifest.name ?? callerName?.trim()) : callerName?.trim();
			const predicted = manifest ? manifest.predicted : (callerPredicted ?? []);
			if (manifest && callerPredicted !== undefined && !sameStringList(callerPredicted, manifest.predicted)) {
				throw new SimWorkflowError(
					"manifest_mismatch",
					`CLI --predicted [${callerPredicted.join(", ")}] contradicts pre-eval manifest [${manifest.predicted.join(", ")}] (${manifest.manifest_id})`,
				);
			}
			if (predicted.length === 0) {
				throw new SimWorkflowError("usage", "Missing non-empty --predicted <id1,id2,...>");
			}

			const what = (opts.what ?? manifest?.what)?.trim();
			const files =
				opts.files !== undefined ? opts.files.map(f => f.trim()).filter(Boolean) : (manifest?.files ?? []);
			const model = (opts.model ?? manifest?.model)?.trim();
			const domain = (opts.domain ?? manifest?.domain)?.trim();
			const benchmark = (opts.benchmark ?? manifest?.benchmark)?.trim();
			const accepted = opts.accepted ?? true;
			const backfilled = opts.backfilled ?? manifest?.backfilled;
			const commit = opts.commit?.trim() || undefined;

			if (!what) throw new SimWorkflowError("usage", "Missing required flag --what");
			if (files.length === 0) {
				throw new SimWorkflowError("usage", "Missing required flag --files (comma-separated paths)");
			}
			if (!model) throw new SimWorkflowError("usage", "Missing required flag --model");
			if (!domain) throw new SimWorkflowError("usage", "Missing required flag --domain");
			if (!benchmark) throw new SimWorkflowError("usage", "Missing required flag --benchmark");

			const existingLedgerText = await store.readText(paths.ledgerPath);
			const ledger = existingLedgerText !== undefined ? await readLedgerOrThrow() : createEmptySimLedger();
			const effectiveRun = opts.run?.trim() || ledger.carried_from?.into;
			const round =
				opts.round ?? manifest?.round ?? computeNextRound(ledger, effectiveRun ? { run: effectiveRun } : undefined);
			const sample = (opts.sample ?? manifest?.sample)?.trim() || (backfilled ? undefined : `s${round}`);

			let report: SimReplayReport;
			let candidateSource: SimCandidateSource;
			if (opts.candidate) {
				report = opts.candidate;
				candidateSource = "explicit";
			} else if (opts.replayJsonPath) {
				const resolvedReplayPath = path.resolve(opts.replayJsonPath);
				const rawReplay = await store.readText(resolvedReplayPath);
				if (rawReplay === undefined) {
					throw new SimWorkflowError("not_found", `Replay report JSON not found at ${resolvedReplayPath}`);
				}
				report = parseReplayReportText(rawReplay, resolvedReplayPath, now);
				candidateSource = "file";
			} else {
				report = await executeReplay({ model });
				candidateSource = "live_replay";
			}

			let baseline: SimReplayBaselineMeta | undefined;
			let baselineSource: SimBaselineSource = "none";
			const effectiveBaselinePath = opts.baselinePath ?? manifest?.baseline_path;
			if (opts.baseline) {
				baseline = opts.baseline;
				baselineSource = "explicit";
			} else if (opts.baselinePath) {
				baseline = await readBaselineFromStore(opts.baselinePath);
				baselineSource = "explicit";
			} else if (manifest?.baseline_path) {
				const resolvedManifestBaseline = path.resolve(manifest.baseline_path);
				const manifestBaselineText = await store.readText(resolvedManifestBaseline);
				if (manifestBaselineText !== undefined) {
					baseline = parseBaselineText(manifestBaselineText, resolvedManifestBaseline);
					baselineSource = "manifest_path";
				} else if (manifest.baseline_passed_ids && manifest.baseline_failed_ids) {
					baseline = {
						passed_ids: manifest.baseline_passed_ids,
						failed_ids: manifest.baseline_failed_ids,
						...(manifest.baseline_model ? { model: manifest.baseline_model } : {}),
					};
					baselineSource = "manifest_inline";
				}
			} else if (manifest?.baseline_passed_ids && manifest.baseline_failed_ids) {
				baseline = {
					passed_ids: manifest.baseline_passed_ids,
					failed_ids: manifest.baseline_failed_ids,
					...(manifest.baseline_model ? { model: manifest.baseline_model } : {}),
				};
				baselineSource = "manifest_inline";
			}

			const diff = evaluateReplayDiff(report, predicted, baseline, { candidateModel: model });
			if (diff.model_mismatch) {
				throw new SimWorkflowError(
					"model_mismatch",
					`Baseline/candidate model mismatch (RSI-21): baseline model "${diff.model_mismatch.baselineModel}" != candidate model "${diff.model_mismatch.candidateModel}"`,
				);
			}

			const baselineRef =
				opts.baselineRef?.trim() || (effectiveBaselinePath ? path.basename(effectiveBaselinePath) : undefined);
			const candidateRef =
				opts.candidateRef?.trim() || (opts.replayJsonPath ? path.basename(opts.replayJsonPath) : undefined);

			let appendResult: AppendAttemptResult;
			try {
				appendResult = appendSimAttempt(ledger, {
					problem,
					name,
					round,
					accepted,
					what,
					files,
					model,
					domain,
					benchmark,
					predicted: diff.predicted,
					fixed: diff.fixed,
					missed: diff.missed,
					regressed: diff.regressed,
					preserved: diff.preserved,
					unresolved: diff.unresolved,
					unproven: diff.unproven,
					incomplete: diff.incomplete,
					passed: report.passed,
					total: report.total,
					sample,
					backfilled,
					run: effectiveRun,
					baseline_ref: baselineRef,
					candidate_ref: candidateRef,
					commit,
					timestamp: now(),
				});
			} catch (err) {
				throw new SimWorkflowError("usage", err instanceof Error ? err.message : String(err));
			}

			if (!appendResult.recorded) {
				let rejectedLogAppended = false;
				if (!noRejectedLog) {
					const resolvedProblemId =
						problem !== "new"
							? (() => {
									try {
										return resolveProblemId(ledger, problem);
									} catch {
										return problem;
									}
								})()
							: undefined;
					const rejectedEntry: SimRejectedCandidateLogEntry = {
						timestamp: now(),
						...(resolvedProblemId ? { problem_id: resolvedProblemId } : {}),
						...(name ? { name } : {}),
						round,
						accepted: false,
						what,
						files,
						model,
						domain,
						benchmark,
						...(sample ? { sample } : {}),
						predicted: diff.predicted,
						fixed: diff.fixed,
						missed: diff.missed,
						regressed: diff.regressed,
						...(diff.preserved.length > 0 ? { preserved: diff.preserved } : {}),
						...(diff.unresolved.length > 0 ? { unresolved: diff.unresolved } : {}),
						...(diff.unproven.length > 0 ? { unproven: diff.unproven } : {}),
						...(diff.incomplete.length > 0 ? { incomplete: diff.incomplete } : {}),
						passed: report.passed,
						total: report.total,
						reason: appendResult.reason,
						...(manifest ? { manifest_id: manifest.manifest_id } : {}),
						...(baselineRef ? { baseline_ref: baselineRef } : {}),
						...(candidateRef ? { candidate_ref: candidateRef } : {}),
					};
					await store.appendText(paths.rejectedLogPath, `${JSON.stringify(rejectedEntry)}\n`);
					rejectedLogAppended = true;
				}
				if (manifest) {
					await writeValidatedManifest(markManifestConsumed(manifest, now()));
				}
				return {
					recorded: false,
					reason: appendResult.reason,
					round,
					report,
					diff,
					baselineSource,
					candidateSource,
					ledgerPath: paths.ledgerPath,
					ledgerWritten: false,
					...(noRejectedLog ? {} : { rejectedLogPath: paths.rejectedLogPath }),
					rejectedLogAppended,
					...(manifest ? { manifestId: manifest.manifest_id } : {}),
					manifestConsumed: Boolean(manifest),
				};
			}

			const check = validateSimLedger(appendResult.ledger);
			if (!check.ok) {
				throw new SimWorkflowError(
					"validation",
					`Updated SIM ledger failed validation:\n- ${check.errors.join("\n- ")}`,
				);
			}
			await store.writeText(paths.ledgerPath, serializeLedger(appendResult.ledger));
			if (manifest) {
				await writeValidatedManifest(markManifestConsumed(manifest, now()));
			}
			return {
				recorded: true,
				problemId: appendResult.problemId,
				createdProblem: appendResult.createdProblem,
				...(appendResult.mergedFromAlias ? { mergedFromAlias: appendResult.mergedFromAlias } : {}),
				round,
				report,
				diff,
				baselineSource,
				candidateSource,
				ledgerPath: paths.ledgerPath,
				ledgerWritten: true,
				...(manifest ? { manifestId: manifest.manifest_id } : {}),
				manifestConsumed: Boolean(manifest),
			};
		},

		async carry(input: CarryForwardInput): Promise<SimCarryResult> {
			const arm = input.arm?.trim() ?? "";
			const domain = input.domain?.trim() ?? "";
			const into = input.into?.trim() ?? "";
			if (!arm || !domain || !into) {
				throw new SimWorkflowError("usage", "carry requires --arm <src> --domain <domain> --into <target-run>");
			}
			const ledger = await readLedgerOrThrow();
			const carried = carryForwardSimLedger(ledger, {
				arm,
				domain,
				into,
				benchmark: input.benchmark,
				model: input.model,
				carriedAt: input.carriedAt ?? now(),
			});
			const check = validateSimLedger(carried);
			if (!check.ok) {
				throw new SimWorkflowError(
					"validation",
					`Carry-forward ledger failed validation:\n- ${check.errors.join("\n- ")}`,
				);
			}
			await store.writeText(paths.ledgerPath, serializeLedger(carried));
			const nextRound = computeNextRound(carried);
			return {
				ledgerPath: paths.ledgerPath,
				ledger: carried,
				carriedFrom: carried.carried_from,
				nextRound,
				problemCount: carried.problems.length,
			};
		},

		async validate(): Promise<SimValidateResult> {
			const rawText = await store.readText(paths.ledgerPath);
			if (rawText === undefined) {
				return {
					valid: false,
					missing: true,
					ledgerPath: paths.ledgerPath,
					errors: [`SIM ledger not found: ${paths.ledgerPath}`],
				};
			}
			let raw: unknown;
			try {
				raw = JSON.parse(rawText);
			} catch (err) {
				return {
					valid: false,
					missing: false,
					ledgerPath: paths.ledgerPath,
					errors: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`],
				};
			}
			const result = validateSimLedger(raw);
			if (!result.ok) {
				return {
					valid: false,
					missing: false,
					ledgerPath: paths.ledgerPath,
					errors: result.errors,
				};
			}
			const ledger = raw as SimLedger;
			const attemptCount = ledger.problems.reduce((sum, p) => sum + p.attempts.length, 0);
			return {
				valid: true,
				ledgerPath: paths.ledgerPath,
				problemCount: ledger.problems.length,
				attemptCount,
				aliasCount: Object.keys(ledger.aliases).length,
			};
		},

		async status(): Promise<SimStatusSummary> {
			const ledger = await readLedgerOrThrow();
			return {
				ledger: paths.ledgerPath,
				schema_version: ledger.schema_version ?? 1,
				next_id: ledger.next_id,
				carried_from: ledger.carried_from ?? null,
				aliases: ledger.aliases,
				problem_count: ledger.problems.length,
				attempt_count: ledger.problems.reduce((sum, p) => sum + p.attempts.length, 0),
				problems: ledger.problems.map(p => {
					const latest = p.attempts.at(-1);
					const missed = latest?.missed ?? [];
					const regressed = latest?.regressed ?? [];
					const unresolved = latest?.unresolved ?? [];
					const unproven = latest?.unproven ?? [];
					const incomplete = latest?.incomplete ?? [];
					const preserved = latest?.preserved ?? [];
					return {
						id: p.id,
						name: p.name,
						opened_round: p.opened_round,
						attempts: p.attempts.length,
						latest_score: latest ? `${latest.passed}/${latest.total}` : "none",
						unresolved_predictions: missed,
						missed,
						regressed,
						unresolved,
						unproven,
						incomplete,
						preserved,
						domains: [...new Set(p.attempts.map(a => a.domain))],
						benchmarks: [...new Set(p.attempts.map(a => a.benchmark))],
						models: [...new Set(p.attempts.map(a => a.model))],
					};
				}),
			};
		},

		async merge(): Promise<SimMergeResult> {
			const ledger = await readLedgerOrThrow();
			const { ledger: mergedLedger, merged } = mergeDuplicateProblems(ledger);
			const check = validateSimLedger(mergedLedger);
			if (!check.ok) {
				throw new SimWorkflowError(
					"validation",
					`Merged ledger failed validation:\n- ${check.errors.join("\n- ")}`,
				);
			}
			await store.writeText(paths.ledgerPath, serializeLedger(mergedLedger));
			return {
				ledgerPath: paths.ledgerPath,
				ledger: mergedLedger,
				merged,
			};
		},
	};
}
