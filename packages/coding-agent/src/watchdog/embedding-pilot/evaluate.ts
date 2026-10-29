import { arbitrateHealth } from "../arbitrator";
import {
	type Case,
	type Decision,
	type DecisionEmbedding,
	FAMILY,
	type Head,
	hashCorpus,
	inputHash,
	neighbors,
	type Policy,
	policyFingerprint,
	scoreChoices,
} from "./scorer";
import { DIMENSIONS, FORMAT_VERSION, MODEL, normalize } from "./titan";
import { fit, type Observation } from "./train";

type Action = "pass" | "inject_hint" | "tripwire_abort";
export interface EvaluationRow {
	split: "train" | "validation" | "test";
	decision: Decision;
	policy: Policy;
	embedding: DecisionEmbedding;
	incumbent: Action | null;
	incumbentLatencyMs: number | null;
	embeddingLatencyMs: number | null;
	embeddingCostUsd: number | null;
	outcome: { action: Action; success: boolean; knownAt: number } | null;
	label: { action: Action | "unknown"; reviewer: string; reviewedAt: number; independent: boolean } | null;
}

const actions = ["pass", "inject_hint", "tripwire_abort"];
const numberOrNull = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
function percentile(values: number[], p: number) {
	const v = [...values].sort((a, b) => a - b);
	return v.length ? v[Math.ceil(v.length * p) - 1] : null;
}

export function evaluate(rows: EvaluationRow[]) {
	if (!Array.isArray(rows) || !rows.length || rows.length > 10000) throw new Error("invalid dataset size");
	const groups = new Map<string, string>();
	const ids = new Set<string>();
	const order = { train: 0, validation: 1, test: 2 } as const;
	let previousSplit = 0,
		previousAt = -Infinity;
	for (const row of rows) {
		const rank = order[row.split];
		const d = row.decision;
		if (
			rank === undefined ||
			!d?.id ||
			ids.has(d.id) ||
			!d.group ||
			d.family !== FAMILY ||
			!Number.isFinite(d.at) ||
			d.at < previousAt ||
			rank < previousSplit
		)
			throw new Error("invalid chronological split or case identity");
		if (groups.has(d.group) && groups.get(d.group) !== row.split) throw new Error("related group crosses splits");
		ids.add(d.id);
		groups.set(d.group, row.split);
		previousAt = d.at;
		previousSplit = rank;
		if (
			!row.policy?.config ||
			!row.policy?.scope ||
			row.policy.identity !== policyFingerprint(row.policy.config) ||
			!row.policy.evaluation ||
			!Number.isFinite(row.policy.evaluation.stallSeverity) ||
			!Number.isFinite(row.policy.evaluation.isThrashing)
		)
			throw new Error("invalid policy context");
		if (
			!Array.isArray(d.choices) ||
			!d.choices.length ||
			new Set(d.choices.map(x => x.id)).size !== d.choices.length ||
			d.choices.some(x => !x.id || !x.description || !actions.includes(x.actionKey)) ||
			new Set(d.choices.map(x => x.actionKey)).size !== d.choices.length
		)
			throw new Error("invalid candidate set");
		if (
			row.embedding?.model !== MODEL ||
			row.embedding.format !== FORMAT_VERSION ||
			row.embedding.inputHash !== inputHash(d)
		)
			throw new Error("incompatible embedding");
		normalize(row.embedding.vector);
		if (
			!numberOrNull(row.incumbentLatencyMs) ||
			!numberOrNull(row.embeddingLatencyMs) ||
			!numberOrNull(row.embeddingCostUsd) ||
			(row.incumbent !== null && !actions.includes(row.incumbent))
		)
			throw new Error("invalid measurement");
		if (
			row.outcome &&
			(!actions.includes(row.outcome.action) ||
				typeof row.outcome.success !== "boolean" ||
				!Number.isFinite(row.outcome.knownAt) ||
				row.outcome.knownAt < d.at ||
				row.outcome.action !== row.incumbent)
		)
			throw new Error("invalid observed outcome");
		if (
			row.label &&
			(!row.label.reviewer ||
				!Number.isFinite(row.label.reviewedAt) ||
				row.label.reviewedAt < d.at ||
				![...actions, "unknown"].includes(row.label.action) ||
				typeof row.label.independent !== "boolean")
		)
			throw new Error("invalid review label");
	}
	const train = rows.filter(r => r.split === "train" && r.outcome);
	const validation = rows.filter(r => r.split === "validation");
	const test = rows.filter(r => r.split === "test");
	const evaluationStart = validation[0]?.decision.at ?? test[0]?.decision.at;
	if (evaluationStart !== undefined && train.some(r => r.outcome!.knownAt >= evaluationStart))
		throw new Error("training outcome was not known before evaluation");
	const testStart = test[0]?.decision.at;
	if (
		testStart !== undefined &&
		validation.some(r => r.label?.independent && r.label.action !== "unknown" && r.label.reviewedAt >= testStart)
	)
		throw new Error("validation label was not known before testing");
	const corpus: Case[] = train.map(r => ({
		id: r.decision.id,
		group: r.decision.group,
		scope: r.policy.scope,
		family: FAMILY,
		policyIdentity: r.policy.identity,
		at: r.decision.at,
		outcomeAt: r.outcome!.knownAt,
		actionKey: r.outcome!.action,
		success: r.outcome!.success,
		vector: r.embedding.vector,
		embeddingModel: MODEL,
		embeddingFormat: FORMAT_VERSION,
	}));
	const observations: Observation[] = train.map(r => ({
		decision: r.decision,
		policy: r.policy,
		vector: r.embedding.vector,
		actionKey: r.outcome!.action,
		success: r.outcome!.success,
	}));
	const identity = corpus[0]?.policyIdentity;
	let head: Head | undefined;
	let headBlocker: string | null = null;
	try {
		if (!identity || corpus.some(c => c.policyIdentity !== identity))
			throw new Error("missing or mixed training policy");
		head = fit(observations, corpus, identity);
	} catch (e) {
		headBlocker = e instanceof Error ? e.message : "training failed";
	}
	const reviewed = (r: EvaluationRow) => r.label?.independent === true && r.label.action !== "unknown";
	let threshold: number | null = null;
	if (head) {
		const candidates = [0.99, 0.95, 0.9, 0.75, 0.5]
			.map(t => {
				const h = { ...head!, minSimilarity: t };
				let answered = 0,
					errors = 0;
				for (const row of validation.filter(reviewed)) {
					const result = scoreChoices(row.decision, row.policy, row.embedding, corpus, h);
					if (!result.abstained) {
						answered++;
						if (row.decision.choices.find(c => c.id === result.choiceId)?.actionKey !== row.label!.action)
							errors++;
					}
				}
				return { t, answered, errors };
			})
			.filter(x => x.answered > 0 && x.errors / x.answered <= 0.05)
			.sort((a, b) => b.answered - a.answered || b.t - a.t);
		threshold = candidates[0]?.t ?? null;
		if (threshold === null) {
			headBlocker = "no independently labeled usable validation threshold";
			head = undefined;
		} else head = { ...head, minSimilarity: threshold };
	}
	const counts = {
		independentLabels: 0,
		eligibleCandidateCases: 0,
		labeledCandidateCases: 0,
		labeledIncumbentAvailable: 0,
		incumbentAvailable: 0,
		incumbentCorrect: 0,
		similarityAnswered: 0,
		similarityCorrect: 0,
		retrievalAnswered: 0,
		retrievalCorrect: 0,
		hybridAnswered: 0,
		hybridCorrect: 0,
		hybridErrors: 0,
		hybridDisagreements: 0,
		policyViolations: 0,
	};
	const scoreTimes: number[] = [];
	for (const r of test) {
		const allowed = arbitrateHealth(r.policy.evaluation, r.policy.config).action;
		const eligible = r.decision.choices.find(c => c.actionKey === allowed);
		if (eligible) counts.eligibleCandidateCases++;
		const near = neighbors(r.decision, r.policy, r.embedding.vector, corpus);
		const supported = eligible && near.some(n => n.item.actionKey === allowed);
		const similarity = supported ? allowed : null;
		const retrieval = supported ? allowed : null;
		let hybrid: Action | null = null;
		if (head) {
			const start = performance.now();
			const result = scoreChoices(r.decision, r.policy, r.embedding, corpus, head);
			scoreTimes.push(performance.now() - start);
			hybrid = r.decision.choices.find(c => c.id === result.choiceId)?.actionKey ?? null;
		}
		if (hybrid && hybrid !== allowed) counts.policyViolations++;
		if (hybrid && r.incumbent && hybrid !== r.incumbent) counts.hybridDisagreements++;
		if (similarity) counts.similarityAnswered++;
		if (retrieval) counts.retrievalAnswered++;
		if (hybrid) counts.hybridAnswered++;
		if (r.incumbent) counts.incumbentAvailable++;
		if (reviewed(r)) {
			counts.independentLabels++;
			if (r.incumbent) counts.labeledIncumbentAvailable++;
			if (r.decision.choices.some(c => c.actionKey === r.label!.action)) counts.labeledCandidateCases++;
			if (r.incumbent === r.label!.action) counts.incumbentCorrect++;
			if (similarity === r.label!.action) counts.similarityCorrect++;
			if (retrieval === r.label!.action) counts.retrievalCorrect++;
			if (hybrid === r.label!.action) counts.hybridCorrect++;
			else if (hybrid) counts.hybridErrors++;
		}
	}
	const labeledAnswered = test.filter(
		r => reviewed(r) && head && !scoreChoices(r.decision, r.policy, r.embedding, corpus, head).abstained,
	).length;
	return {
		datasetHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(rows)).digest("hex"),
		corpusHash: hashCorpus(corpus),
		model: MODEL,
		dimensions: DIMENSIONS,
		format: FORMAT_VERSION,
		splitSizes: {
			train: rows.filter(r => r.split === "train").length,
			observedTrain: train.length,
			validation: validation.length,
			test: test.length,
		},
		counts,
		threshold,
		headBlocker,
		qualityGate: "unproven",
		hybridCoverage: test.length ? counts.hybridAnswered / test.length : null,
		incumbentAccuracy: counts.labeledIncumbentAvailable
			? counts.incumbentCorrect / counts.labeledIncumbentAvailable
			: null,
		hybridAccuracyAmongLabeledAnswers: labeledAnswered ? counts.hybridCorrect / labeledAnswered : null,
		answeredErrorRate: labeledAnswered ? counts.hybridErrors / labeledAnswered : null,
		latencyMs: {
			incumbentP50: percentile(
				test.flatMap(r => (r.incumbentLatencyMs === null ? [] : [r.incumbentLatencyMs])),
				0.5,
			),
			incumbentP95: percentile(
				test.flatMap(r => (r.incumbentLatencyMs === null ? [] : [r.incumbentLatencyMs])),
				0.95,
			),
			embeddingP50: percentile(
				test.flatMap(r => (r.embeddingLatencyMs === null ? [] : [r.embeddingLatencyMs])),
				0.5,
			),
			embeddingP95: percentile(
				test.flatMap(r => (r.embeddingLatencyMs === null ? [] : [r.embeddingLatencyMs])),
				0.95,
			),
			scoringP50: percentile(scoreTimes, 0.5),
			scoringP95: percentile(scoreTimes, 0.95),
		},
		embeddingCostUsd:
			test.every(r => r.embeddingCostUsd !== null) && test.length
				? test.reduce((s, r) => s + r.embeddingCostUsd!, 0)
				: null,
		limitation:
			"Policy admits one action, so similarity and retrieval baselines are identical; action-effectiveness labels are not inferred from exit status.",
	};
}

if (import.meta.main) {
	const [input, output] = process.argv.slice(2);
	if (!input || !output) throw new Error("Usage: bun evaluate.ts <prepared-dataset.json> <report.json>");
	const rows: EvaluationRow[] = JSON.parse(await Bun.file(input).text());
	await Bun.write(output, JSON.stringify(evaluate(rows), null, 2) + "\n");
}
