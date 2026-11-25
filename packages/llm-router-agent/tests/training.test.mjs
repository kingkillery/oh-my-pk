import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cloneDefaultConfig,
  computeExpectedCalibrationError,
  decideRoute,
  evaluateRoutePredictorVsBaseline,
  parseTelemetryJsonl,
  trainRoutePredictorFromTelemetry,
} from '../dist/index.js';

const CODING_FEATURES = {
  taskType: 'coding',
  approxInputTokens: 1000,
  approxOutputTokens: 500,
  totalTokenEstimate: 1500,
  hasCode: true,
  hasJsonRequirement: false,
  hasRetrievalNeed: false,
  hasMultimodalInput: false,
  reasoningComplexity: 0.7,
  safetySensitivity: 0.1,
  userTier: 'default',
  userPreference: 'quality',
  signals: [],
};

test('trains route-predictor weights only from observed executions without fabricating fallback negatives', () => {
  const records = parseTelemetryJsonl([
    JSON.stringify({
      requestId: 'r1',
      timestamp: '2026-01-01T00:00:00.000Z',
      kind: 'decision',
      route: { selectedModel: 'quality', selector: '9router/quality', confidence: 0.8, taskType: 'coding', reasons: [], fallbackChain: ['balanced', 'fast'] },
      features: CODING_FEATURES,
      metrics: { success: true }
    })
  ].join('\n'));

  const result = trainRoutePredictorFromTelemetry(records, { epochs: 3, learningRate: 0.1 });
  assert.equal(result.examples, 1);
  assert.equal(result.droppedUnobserved, 0);
  assert.equal(result.role, 'route-predictor');
  assert.equal(result.tier, 'local-fast');
  assert.equal(result.executionRouter, 'unchanged');
  assert.equal(result.policy.enabled, true);
  assert.deepEqual(result.models, ['quality']);
  assert.equal(result.policy.modelWeights.balanced, undefined);
  assert.ok(result.policy.modelWeights.quality['has.code'] > 0);
});

test('drops telemetry records lacking explicit observed outcome or verifier signal', () => {
  const records = parseTelemetryJsonl([
    JSON.stringify({
      requestId: 'r_unobserved',
      timestamp: '2026-01-01T00:00:00.000Z',
      kind: 'decision',
      route: { selectedModel: 'quality', selector: '9router/quality', confidence: 0.8, taskType: 'coding', reasons: [], fallbackChain: ['balanced'] },
      features: CODING_FEATURES,
      metrics: { latencyMs: 120 }
    })
  ].join('\n'));

  const result = trainRoutePredictorFromTelemetry(records, { epochs: 3, learningRate: 0.1 });
  assert.equal(result.examples, 0);
  assert.equal(result.droppedUnobserved, 1);
  assert.equal(result.policy.enabled, false);
});

test('evaluateRoutePredictorVsBaseline refuses promotion when candidate ties or loses to deterministic policy', () => {
  const baseConfig = cloneDefaultConfig();
  const holdout = [
    {
      requestId: 'h1',
      timestamp: '2026-01-02T00:00:00.000Z',
      kind: 'outcome',
      route: { selectedModel: 'quality', selector: baseConfig.models.quality.selector, confidence: 0.9, taskType: 'coding', reasons: [], fallbackChain: [] },
      features: CODING_FEATURES,
      metrics: { success: true },
    },
  ];

  // Zero-weight candidate matches baseline exactly -> no improvement -> must NOT promote
  const tieEval = evaluateRoutePredictorVsBaseline(
    holdout,
    { enabled: true, intercept: 0, modelWeights: {}, globalWeights: {}, minConfidenceToOverride: 0.18 },
    baseConfig,
  );
  assert.equal(tieEval.evaluated, 1);
  assert.equal(tieEval.scoreDelta, 0);
  assert.equal(tieEval.promoted, false);

  // Wired directly into trainRoutePredictorFromTelemetry -> forces policy.enabled = false on non-improvement
  const trained = trainRoutePredictorFromTelemetry(holdout, {
    epochs: 4,
    learningRate: 0.1,
    holdoutRecords: holdout,
    baseConfig,
  });
  assert.ok(trained.baselineEvaluation);
  assert.equal(trained.baselineEvaluation.promoted, false);
  assert.equal(trained.policy.enabled, false);
});

test('evaluateRoutePredictorVsBaseline promotes when candidate beats deterministic baseline on observed failures', () => {
  const baseConfig = cloneDefaultConfig();
  // Use a non-forced feature vector (complexity 0.3 < 0.45 high-complexity-coding force threshold)
  // so learned weights can legitimately steer the route decision.
  const nonForcedFeatures = { ...CODING_FEATURES, reasoningComplexity: 0.3, userPreference: 'balanced' };
  const baselinePicked = decideRoute({ message: '' }, {
    ...nonForcedFeatures,
    taskScores: {
      chat: 0, classification: 0, coding: 1, translation: 0, summarization: 0, extraction: 0,
      reasoning: 0, retrieval: 0, planning: 0, multimodal: 0, safety: 0, unknown: 0,
    },
    language: 'en',
    hasUrl: false,
    hasStructuredData: false,
    hasToolNeed: false,
    hasLongContextNeed: false,
    ambiguity: 0,
    runtimePressure: 0,
    tags: [],
  }, { ...baseConfig, learned: { enabled: false, intercept: 0, modelWeights: {}, globalWeights: {} } }).selectedModel;
  const altModel = baselinePicked === 'balanced' ? 'quality' : 'balanced';

  const holdout = [
    {
      requestId: 'h_fail',
      timestamp: '2026-01-02T00:00:00.000Z',
      kind: 'outcome',
      route: {
        selectedModel: baselinePicked,
        selector: baseConfig.models[baselinePicked].selector,
        confidence: 0.9,
        taskType: 'coding',
        reasons: [],
        fallbackChain: [],
      },
      features: nonForcedFeatures,
      metrics: { success: false },
    },
  ];
  const strongCandidate = {
    enabled: true,
    intercept: 0,
    modelWeights: {
      [baselinePicked]: { 'has.code': -2.0, 'task.coding': -2.0 },
      [altModel]: { 'has.code': 2.0, 'task.coding': 2.0 },
    },
    globalWeights: {},
    minConfidenceToOverride: 0.1,
  };
  const evalResult = evaluateRoutePredictorVsBaseline(holdout, strongCandidate, baseConfig);
  assert.equal(evalResult.evaluated, 1);
  assert.ok(evalResult.candidateObservedScore > evalResult.baselineObservedScore);
  assert.equal(evalResult.promoted, true);
  assert.equal(typeof evalResult.calibrationEce, 'number');
  assert.equal(evalResult.baselineComparison.baselinePolicy, 'deterministic_rules_v1');
  assert.equal(evalResult.baselineComparison.candidateCalibrationEce, evalResult.calibrationEce);
});

test('computeExpectedCalibrationError measures calibration and gates overconfident promotion', () => {
  const perfect = computeExpectedCalibrationError([
    { confidence: 1.0, correct: true },
    { confidence: 0.0, correct: false },
  ]);
  assert.equal(perfect.samples, 2);
  assert.equal(perfect.ece, 0);

  const overconfident = computeExpectedCalibrationError([
    { confidence: 0.95, correct: false },
    { confidence: 0.95, correct: false },
  ]);
  assert.equal(overconfident.samples, 2);
  assert.ok(overconfident.ece >= 0.9);

  // maxCalibrationEce blocks promotion even when observed score improves
  const baseConfig = cloneDefaultConfig();
  const nonForcedFeatures = { ...CODING_FEATURES, reasoningComplexity: 0.3, userPreference: 'balanced' };
  const baselinePicked = decideRoute({ message: '' }, {
    ...nonForcedFeatures,
    taskScores: {
      chat: 0, classification: 0, coding: 1, translation: 0, summarization: 0, extraction: 0,
      reasoning: 0, retrieval: 0, planning: 0, multimodal: 0, safety: 0, unknown: 0,
    },
    language: 'en',
    hasUrl: false,
    hasStructuredData: false,
    hasToolNeed: false,
    hasLongContextNeed: false,
    ambiguity: 0,
    runtimePressure: 0,
    tags: [],
  }, { ...baseConfig, learned: { enabled: false, intercept: 0, modelWeights: {}, globalWeights: {} } }).selectedModel;
  const altModel = baselinePicked === 'balanced' ? 'quality' : 'balanced';
  const holdout = [
    {
      requestId: 'h_ece_fail',
      timestamp: '2026-01-02T00:00:00.000Z',
      kind: 'outcome',
      route: {
        selectedModel: baselinePicked,
        selector: baseConfig.models[baselinePicked].selector,
        confidence: 0.9,
        taskType: 'coding',
        reasons: [],
        fallbackChain: [],
      },
      features: nonForcedFeatures,
      metrics: { success: false },
    },
  ];
  const strongCandidate = {
    enabled: true,
    intercept: 0,
    modelWeights: {
      [baselinePicked]: { 'has.code': -2.0, 'task.coding': -2.0 },
      [altModel]: { 'has.code': 2.0, 'task.coding': 2.0 },
    },
    globalWeights: {},
    minConfidenceToOverride: 0.1,
  };
  // Candidate has non-zero calibration gap (confidence < 1.0 on 100% empirical hit), so maxCalibrationEce=0 blocks it
  const blocked = evaluateRoutePredictorVsBaseline(holdout, strongCandidate, baseConfig, { maxCalibrationEce: 0 });
  assert.equal(blocked.promoted, false);
  assert.ok(blocked.reason.includes('calibration ECE'));
});
