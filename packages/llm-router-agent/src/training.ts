import { featureMap } from "./learned.js";
import { decideRoute } from "./policy.js";
import type { LearnedPolicyConfig, RouterConfig, RouterFeatureVector, TelemetryRecord } from "./types.js";

export interface RoutePredictorTrainingOptions {
	learningRate?: number;
	epochs?: number;
	l2?: number;
	successBonus?: number;
	failurePenalty?: number;
	maxAbsWeight?: number;
	holdoutRecords?: TelemetryRecord[];
	baseConfig?: RouterConfig;
	minBaselineMargin?: number;
	maxCalibrationEce?: number;
}

export interface CalibrationBin {
	binIndex: number;
	lower: number;
	upper: number;
	count: number;
	meanConfidence: number;
	empiricalAccuracy: number;
	absGap: number;
}

export interface CalibrationReport {
	ece: number;
	samples: number;
	numBins: number;
	bins: CalibrationBin[];
}

export interface BaselineComparisonSummary {
	baselinePolicy: "deterministic_rules_v1";
	evaluated: number;
	baselineObservedScore: number;
	candidateObservedScore: number;
	scoreDelta: number;
	baselineMeanCostPerM: number;
	candidateMeanCostPerM: number;
	costDeltaPerM: number;
	baselineCalibrationEce: number;
	candidateCalibrationEce: number;
	eceDelta: number;
}

export interface RoutePredictorBaselineEvaluation {
	evaluated: number;
	droppedUnobserved: number;
	baselineObservedScore: number;
	candidateObservedScore: number;
	scoreDelta: number;
	baselineMeanCostPerM: number;
	candidateMeanCostPerM: number;
	costDeltaPerM: number;
	calibrationEce: number;
	baselineCalibrationEce: number;
	baselineComparison: BaselineComparisonSummary;
	promoted: boolean;
	reason: string;
}

export function computeExpectedCalibrationError(
	samples: Array<{ confidence: number; correct: boolean }>,
	numBins = 10,
): CalibrationReport {
	const binCount = Math.max(1, Math.floor(numBins));
	const valid = samples.filter(sample => typeof sample.confidence === "number" && Number.isFinite(sample.confidence));
	if (valid.length === 0) {
		return { ece: 0, samples: 0, numBins: binCount, bins: [] };
	}

	const buckets: Array<{ confSum: number; correctSum: number; count: number }> = Array.from(
		{ length: binCount },
		() => ({ confSum: 0, correctSum: 0, count: 0 }),
	);
	for (const sample of valid) {
		const conf = clamp(sample.confidence, 0, 1);
		const idx = Math.min(binCount - 1, Math.floor(conf * binCount));
		const bucket = buckets[idx];
		if (!bucket) continue;
		bucket.confSum += conf;
		bucket.correctSum += sample.correct ? 1 : 0;
		bucket.count += 1;
	}

	const bins: CalibrationBin[] = [];
	let eceSum = 0;
	for (let i = 0; i < binCount; i += 1) {
		const bucket = buckets[i];
		if (!bucket || bucket.count === 0) continue;
		const meanConfidence = bucket.confSum / bucket.count;
		const empiricalAccuracy = bucket.correctSum / bucket.count;
		const absGap = Math.abs(empiricalAccuracy - meanConfidence);
		eceSum += (bucket.count / valid.length) * absGap;
		bins.push({
			binIndex: i,
			lower: round(i / binCount, 4),
			upper: round((i + 1) / binCount, 4),
			count: bucket.count,
			meanConfidence: round(meanConfidence, 6),
			empiricalAccuracy: round(empiricalAccuracy, 6),
			absGap: round(absGap, 6),
		});
	}

	return {
		ece: round(eceSum, 6),
		samples: valid.length,
		numBins: binCount,
		bins,
	};
}

export interface RoutePredictorTrainingResult {
	role: "route-predictor";
	tier: "local-fast";
	executionRouter: "unchanged";
	examples: number;
	droppedUnobserved: number;
	models: string[];
	policy: LearnedPolicyConfig;
	baselineEvaluation?: RoutePredictorBaselineEvaluation;
}

interface TrainingExample {
	modelId: string;
	features: RouterFeatureVector;
	weight: number;
}

export function trainRoutePredictorFromTelemetry(
	records: TelemetryRecord[],
	options: RoutePredictorTrainingOptions = {},
): RoutePredictorTrainingResult {
	const examples: TrainingExample[] = [];
	let droppedUnobserved = 0;
	for (const record of records) {
		const example = recordToTrainingExample(record);
		if (example === null) {
			if (record.route?.selectedModel && record.features) droppedUnobserved += 1;
			continue;
		}
		examples.push(example);
	}
	const models = [...new Set(examples.map(example => example.modelId))].sort();
	const weights = new Map<string, Record<string, number>>();
	const learningRate = options.learningRate ?? 0.08;
	const epochs = Math.max(1, Math.floor(options.epochs ?? 8));
	const l2 = options.l2 ?? 0.0005;
	const maxAbsWeight = options.maxAbsWeight ?? 2;

	for (const model of models) weights.set(model, {});
	for (let epoch = 0; epoch < epochs; epoch += 1) {
		for (const example of examples) {
			const fmap = featureMap(example.features);
			const prediction = sigmoid(dot(weights.get(example.modelId) ?? {}, fmap));
			const error = example.weight - prediction;
			const modelWeights = weights.get(example.modelId) ?? {};
			for (const [feature, value] of Object.entries(fmap)) {
				const current = modelWeights[feature] ?? 0;
				const next = current + learningRate * (error * value - l2 * current);
				modelWeights[feature] = clamp(round(next, 6), -maxAbsWeight, maxAbsWeight);
			}
			weights.set(example.modelId, modelWeights);
		}
	}

	const policy: LearnedPolicyConfig = {
		enabled: examples.length > 0,
		intercept: 0,
		modelWeights: Object.fromEntries(weights),
		globalWeights: {},
		minConfidenceToOverride: 0.18,
	};

	let baselineEvaluation: RoutePredictorBaselineEvaluation | undefined;
	if (options.holdoutRecords !== undefined && options.baseConfig !== undefined) {
		baselineEvaluation = evaluateRoutePredictorVsBaseline(options.holdoutRecords, policy, options.baseConfig, {
			minMargin: options.minBaselineMargin,
			maxCalibrationEce: options.maxCalibrationEce,
		});
		if (!baselineEvaluation.promoted) {
			policy.enabled = false;
		}
	}

	const result: RoutePredictorTrainingResult = {
		role: "route-predictor",
		tier: "local-fast",
		executionRouter: "unchanged",
		examples: examples.length,
		droppedUnobserved,
		models,
		policy,
	};
	if (baselineEvaluation !== undefined) {
		result.baselineEvaluation = baselineEvaluation;
	}
	return result;
}

export function evaluateRoutePredictorVsBaseline(
	holdoutRecords: TelemetryRecord[],
	candidatePolicy: LearnedPolicyConfig,
	baseConfig: RouterConfig,
	options: { minMargin?: number; maxCalibrationEce?: number; numCalibrationBins?: number } = {},
): RoutePredictorBaselineEvaluation {
	const minMargin = options.minMargin ?? 0;
	const numBins = options.numCalibrationBins ?? 10;
	const baselineConfig: RouterConfig = {
		...baseConfig,
		learned: { ...(baseConfig.learned ?? { intercept: 0, modelWeights: {}, globalWeights: {} }), enabled: false },
	};
	const candidateConfig: RouterConfig = {
		...baseConfig,
		learned: { ...candidatePolicy, enabled: true },
	};

	let evaluated = 0;
	let droppedUnobserved = 0;
	let baselineRewardSum = 0;
	let candidateRewardSum = 0;
	let baselineCostSum = 0;
	let candidateCostSum = 0;
	const baselineCalSamples: Array<{ confidence: number; correct: boolean }> = [];
	const candidateCalSamples: Array<{ confidence: number; correct: boolean }> = [];

	for (const record of holdoutRecords) {
		const observed = recordToTrainingExample(record);
		if (observed === null) {
			if (record.route?.selectedModel && record.features) droppedUnobserved += 1;
			continue;
		}
		evaluated += 1;
		const req = { message: record.contextTrace?.promptPreview ?? "" };
		const baselineDecision = decideRoute(req, observed.features, baselineConfig);
		const candidateDecision = decideRoute(req, observed.features, candidateConfig);

		const baselineReward = counterfactualAgreementReward(
			baselineDecision.selectedModel,
			observed.modelId,
			observed.weight,
		);
		const candidateReward = counterfactualAgreementReward(
			candidateDecision.selectedModel,
			observed.modelId,
			observed.weight,
		);
		baselineRewardSum += baselineReward;
		candidateRewardSum += candidateReward;
		baselineCostSum += baseConfig.models[baselineDecision.selectedModel]?.costPerMillionTokens ?? 0;
		candidateCostSum += baseConfig.models[candidateDecision.selectedModel]?.costPerMillionTokens ?? 0;
		baselineCalSamples.push({ confidence: baselineDecision.confidence, correct: baselineReward >= 0.5 });
		candidateCalSamples.push({ confidence: candidateDecision.confidence, correct: candidateReward >= 0.5 });
	}

	if (evaluated === 0) {
		const emptyComparison: BaselineComparisonSummary = {
			baselinePolicy: "deterministic_rules_v1",
			evaluated: 0,
			baselineObservedScore: 0,
			candidateObservedScore: 0,
			scoreDelta: 0,
			baselineMeanCostPerM: 0,
			candidateMeanCostPerM: 0,
			costDeltaPerM: 0,
			baselineCalibrationEce: 0,
			candidateCalibrationEce: 0,
			eceDelta: 0,
		};
		return {
			evaluated: 0,
			droppedUnobserved,
			baselineObservedScore: 0,
			candidateObservedScore: 0,
			scoreDelta: 0,
			baselineMeanCostPerM: 0,
			candidateMeanCostPerM: 0,
			costDeltaPerM: 0,
			calibrationEce: 0,
			baselineCalibrationEce: 0,
			baselineComparison: emptyComparison,
			promoted: false,
			reason: "No held-out telemetry records had explicit observed outcomes; refusing promotion.",
		};
	}

	const baselineObservedScore = round(baselineRewardSum / evaluated, 6);
	const candidateObservedScore = round(candidateRewardSum / evaluated, 6);
	const scoreDelta = round(candidateObservedScore - baselineObservedScore, 6);
	const baselineMeanCostPerM = round(baselineCostSum / evaluated, 6);
	const candidateMeanCostPerM = round(candidateCostSum / evaluated, 6);
	const costDeltaPerM = round(candidateMeanCostPerM - baselineMeanCostPerM, 6);
	const baselineCalibrationEce = computeExpectedCalibrationError(baselineCalSamples, numBins).ece;
	const calibrationEce = computeExpectedCalibrationError(candidateCalSamples, numBins).ece;
	const eceDelta = round(calibrationEce - baselineCalibrationEce, 6);

	const baselineComparison: BaselineComparisonSummary = {
		baselinePolicy: "deterministic_rules_v1",
		evaluated,
		baselineObservedScore,
		candidateObservedScore,
		scoreDelta,
		baselineMeanCostPerM,
		candidateMeanCostPerM,
		costDeltaPerM,
		baselineCalibrationEce,
		candidateCalibrationEce: calibrationEce,
		eceDelta,
	};

	const calibrationPassed = options.maxCalibrationEce === undefined || calibrationEce <= options.maxCalibrationEce;
	const beatsQuality = scoreDelta > minMargin;
	const tiesQualityCutsCost = scoreDelta >= minMargin && costDeltaPerM < 0;
	const promoted = calibrationPassed && (beatsQuality || tiesQualityCutsCost);
	const reason = !calibrationPassed
		? `Candidate calibration ECE (${calibrationEce}) exceeded maxCalibrationEce (${options.maxCalibrationEce}); keeping learned policy disabled.`
		: promoted
			? beatsQuality
				? `Candidate beat deterministic baseline on observed outcomes (+${scoreDelta}, ECE=${calibrationEce}).`
				: `Candidate matched deterministic baseline on observed outcomes (${scoreDelta}, ECE=${calibrationEce}) while reducing mean cost (${costDeltaPerM}/M).`
			: `Candidate did not beat deterministic baseline (scoreDelta=${scoreDelta}, costDeltaPerM=${costDeltaPerM}, ECE=${calibrationEce}); keeping learned policy disabled.`;

	return {
		evaluated,
		droppedUnobserved,
		baselineObservedScore,
		candidateObservedScore,
		scoreDelta,
		baselineMeanCostPerM,
		candidateMeanCostPerM,
		costDeltaPerM,
		calibrationEce,
		baselineCalibrationEce,
		baselineComparison,
		promoted,
		reason,
	};
}

export function parseTelemetryJsonl(text: string): TelemetryRecord[] {
	const records: TelemetryRecord[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		records.push(JSON.parse(line) as TelemetryRecord);
	}
	return records;
}

/**
 * Score a routing policy against an actually executed telemetry record without
 * inventing outcomes for unexecuted models: matching a successful execution
 * earns its observed weight; avoiding a failed execution earns (1 - weight);
 * matching a failed execution earns its low weight; diverging from a successful
 * execution is conservatively unscored (0).
 */
function counterfactualAgreementReward(chosenModel: string, executedModel: string, observedWeight: number): number {
	const succeeded = observedWeight >= 0.5;
	if (chosenModel === executedModel) return observedWeight;
	return succeeded ? 0 : round(1 - observedWeight, 6);
}

function recordToTrainingExample(record: TelemetryRecord): TrainingExample | null {
	if (!record.route?.selectedModel || !record.features) return null;
	const selectedWeight = observedOutcomeWeight(record);
	if (selectedWeight === null) return null;
	const features = completeFeatures(record.features);
	// Never fabricate negative labels for unexecuted fallbackChain models.
	return { modelId: record.route.selectedModel, features, weight: selectedWeight };
}

function observedOutcomeWeight(record: TelemetryRecord): number | null {
	if (record.metrics?.success === false) return 0.15;
	if (record.validation && !record.validation.passed) return 0.25;
	if (typeof record.metrics?.userRating === "number" && Number.isFinite(record.metrics.userRating)) {
		return clamp(record.metrics.userRating / 5, 0, 1);
	}
	if (record.metrics?.success === true) return 1;
	if (record.validation?.passed === true) return 1;
	if (record.features?.lastVerifier === "pass") return 1;
	if (record.features?.lastVerifier === "fail") return 0.15;
	// Drop unobserved records instead of fabricating a default 0.8 success label.
	return null;
}

function completeFeatures(features: Partial<RouterFeatureVector>): RouterFeatureVector {
	return {
		taskScores: features.taskScores ?? defaultTaskScores(),
		taskType: features.taskType ?? "unknown",
		approxInputTokens: features.approxInputTokens ?? 0,
		approxOutputTokens: features.approxOutputTokens ?? 0,
		totalTokenEstimate: features.totalTokenEstimate ?? 0,
		language: features.language ?? "unknown",
		hasCode: features.hasCode ?? false,
		hasUrl: features.hasUrl ?? false,
		hasJsonRequirement: features.hasJsonRequirement ?? false,
		hasStructuredData: features.hasStructuredData ?? false,
		hasToolNeed: features.hasToolNeed ?? false,
		hasRetrievalNeed: features.hasRetrievalNeed ?? false,
		hasMultimodalInput: features.hasMultimodalInput ?? false,
		hasLongContextNeed: features.hasLongContextNeed ?? false,
		reasoningComplexity: features.reasoningComplexity ?? 0,
		ambiguity: features.ambiguity ?? 0,
		safetySensitivity: features.safetySensitivity ?? 0,
		runtimePressure: features.runtimePressure ?? 0,
		userTier: features.userTier ?? "default",
		userPreference: features.userPreference ?? "balanced",
		tags: features.tags ?? [],
		signals: features.signals ?? [],
	};
}
function defaultTaskScores(): Record<RouterFeatureVector["taskType"], number> {
	return {
		chat: 0,
		classification: 0,
		coding: 0,
		translation: 0,
		summarization: 0,
		extraction: 0,
		reasoning: 0,
		retrieval: 0,
		planning: 0,
		multimodal: 0,
		safety: 0,
		unknown: 1,
	};
}

function dot(weights: Record<string, number>, fmap: Record<string, number>): number {
	let total = 0;
	for (const [feature, value] of Object.entries(fmap)) total += (weights[feature] ?? 0) * value;
	return total;
}

function sigmoid(value: number): number {
	return 1 / (1 + Math.exp(-value));
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
function round(value: number, places: number): number {
	const scale = 10 ** places;
	return Math.round(value * scale) / scale;
}
