import { arbitrateHealth } from "../arbitrator";
import {
	type Case,
	type Choice,
	type Decision,
	FAMILY,
	FEATURES,
	hashCorpus,
	inputHash,
	neighbors,
	type Policy,
	policyFingerprint,
	scoreChoices,
} from "./scorer";
import { FORMAT_VERSION } from "./titan";
import { fit, type Observation } from "./train";

// Fixture-only demonstration. These vectors are deterministic test doubles, not Titan outputs.
const identity = policyFingerprint({});
const vector = (n: number) => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : i === 1 ? n / 100 : 0));
const policy: Policy = {
	identity,
	scope: "fixture-only",
	config: {},
	evaluation: { stallSeverity: 0.1, isThrashing: 0.1, blockerType: "none", confidence: 1, latencyMs: 0 },
};
const choices: Choice[] = [
	{ id: "continue", actionKey: "pass", description: "Continue" },
	{ id: "stop", actionKey: "tripwire_abort", description: "Stop" },
];
const makeDecision = (id: string, at: number): Decision => ({
	id,
	group: `group-${id}`,
	family: FAMILY,
	question: "What action?",
	state: "No stall",
	at,
	choices,
});
const corpus: Case[] = Array.from({ length: 12 }, (_, i) => ({
	id: `train-${i}`,
	group: `group-train-${i}`,
	scope: policy.scope,
	family: FAMILY,
	policyIdentity: identity,
	at: i * 10,
	outcomeAt: i * 10 + 1,
	actionKey: "pass",
	success: i % 2 === 0,
	vector: vector(i),
	embeddingModel: "fixture:384",
	embeddingFormat: FORMAT_VERSION,
}));
const training: Observation[] = corpus.map((c, i) => ({
	decision: makeDecision(c.id, c.at),
	policy,
	vector: vector(i),
	actionKey: c.actionKey,
	success: c.success,
}));
const validation = [201, 202, 203, 204].map((at, i) => ({
	decision: makeDecision(`validation-${i}`, at),
	vector: vector(i + 3),
	expected: "continue",
}));
const testSet = [301, 302, 303, 304].map((at, i) => ({
	decision: makeDecision(`test-${i}`, at),
	vector: vector(i + 6),
	expected: "continue",
}));
// Gate frozen before inspecting test output; real deployment needs a representative independent dataset.
const acceptance = {
	minIndependentTestCases: 20,
	minAnswerCoverage: 0.8,
	maxAnsweredErrorRate: 0.05,
	maxPolicyViolations: 0,
	latencyAndCost: "not evaluated against incumbent",
};
const head = fit(training, corpus, identity, "fixture:384");
// Select the highest-coverage candidate that is error-free on the validation fixtures.
const candidates = [0.99, 0.95, 0.9, 0.75, 0.5].map(threshold => {
	const h = { ...head, minSimilarity: threshold };
	const results = validation.map(x =>
		scoreChoices(
			x.decision,
			policy,
			{ vector: x.vector, model: h.model, format: h.format, inputHash: inputHash(x.decision) },
			corpus,
			h,
		),
	);
	return {
		threshold,
		answered: results.filter(x => !x.abstained).length,
		errors: results.filter((x, i) => !x.abstained && x.choiceId !== validation[i]!.expected).length,
	};
});
const chosen = candidates
	.filter(x => x.errors === 0)
	.sort((a, b) => b.answered - a.answered || b.threshold - a.threshold)[0];
if (!chosen) throw new Error("no usable validation threshold");
head.minSimilarity = chosen.threshold;
const frozen = Object.freeze({ ...head });
const baselines = {
	incumbentJev: null,
	policyAction: 0,
	similarityOnly: 0,
	retrievalOnly: 0,
	hybrid: 0,
	abstained: 0,
	policyViolations: 0,
	errorsAnswered: 0,
};
const timings: number[] = [];
for (const x of testSet) {
	const allowed = arbitrateHealth(policy.evaluation, policy.config).action;
	const incumbent = x.decision.choices.find(c => c.actionKey === allowed)?.id;
	const retrieved = neighbors(x.decision, policy, x.vector, corpus, "fixture:384");
	const prior = x.decision.choices.find(
		c => c.actionKey === allowed && retrieved.some(n => n.item.actionKey === c.actionKey),
	)?.id;
	const start = performance.now();
	const result = scoreChoices(
		x.decision,
		policy,
		{ vector: x.vector, model: frozen.model, format: frozen.format, inputHash: inputHash(x.decision) },
		corpus,
		frozen,
	);
	timings.push(performance.now() - start);
	if (incumbent === x.expected) baselines.policyAction++;
	if (prior === x.expected) {
		baselines.similarityOnly++;
		baselines.retrievalOnly++;
	}
	if (result.choiceId === x.expected) baselines.hybrid++;
	if (result.abstained) baselines.abstained++;
	if (result.choiceId && result.choiceId !== x.expected) baselines.errorsAnswered++;
	if (result.choiceId && x.decision.choices.find(c => c.id === result.choiceId)?.actionKey !== allowed)
		baselines.policyViolations++;
}
timings.sort((a, b) => a - b);
const output = {
	fixtureOnly: true,
	model: "test-double-384 (not live Titan)",
	corpusHash: hashCorpus(corpus),
	trainingHash: head.trainingHash,
	features: FEATURES,
	trainingSize: training.length,
	fittedExamples: head.trainingExamples,
	validationSize: validation.length,
	testSize: testSet.length,
	observedOutcomeCoverage: training.length,
	independentLabels: "synthetic fixture assertions only",
	acceptance,
	acceptanceStatus: "unproven",
	validationCandidates: candidates,
	frozenThreshold: chosen.threshold,
	baselines,
	latencyMs: { p50: (timings[1]! + timings[2]!) / 2, p95: timings[3] },
	cost: null,
	limitation:
		"All eligible candidate sets contain one choice; labels and vectors are synthetic. JEV, live embeddings, latency versus incumbent and cost are not evaluated. Quality is unproven.",
};
const outIndex = process.argv.indexOf("--out");
if (outIndex !== -1) {
	const target = process.argv[outIndex + 1];
	if (!target) throw new Error("--out requires a path");
	await Bun.write(target, JSON.stringify({ fixtureOnly: true, head: frozen, report: output }, null, 2) + "\n");
}
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
