import { arbitrateHealth } from "../arbitrator";
import {
	type Case,
	type Decision,
	FAMILY,
	FEATURES,
	features,
	type Head,
	hashCorpus,
	neighbors,
	type Policy,
} from "./scorer";
import { DIMENSIONS, FORMAT_VERSION, MODEL } from "./titan";

export interface Observation {
	decision: Decision;
	policy: Policy;
	vector: number[];
	actionKey: "pass" | "inject_hint" | "tripwire_abort";
	success: boolean;
}

/** Fit only observed actions, using strictly prior, unrelated outcomes. */
export function fit(
	observations: readonly Observation[],
	corpus: readonly Case[],
	policyIdentity: string,
	model = MODEL,
): Head {
	const samples: { x: number[]; y: number }[] = [];
	for (const o of observations) {
		if (
			typeof o.success !== "boolean" ||
			!o.policy?.evaluation ||
			!Number.isFinite(o.policy.evaluation.stallSeverity) ||
			!Number.isFinite(o.policy.evaluation.isThrashing)
		)
			throw new Error("missing training outcome or features");
		if (
			o.decision.family !== FAMILY ||
			o.policy.identity !== policyIdentity ||
			arbitrateHealth(o.policy.evaluation, o.policy.config).action !== o.actionKey
		)
			continue;
		const relevant = neighbors(o.decision, o.policy, o.vector, corpus, model);
		if (!relevant.some(n => n.item.actionKey === o.actionKey)) continue;
		samples.push({ x: features(o.actionKey, relevant, o.policy.evaluation), y: o.success ? 1 : 0 });
	}
	if (samples.length < 4 || !samples.some(s => s.y === 0) || !samples.some(s => s.y === 1))
		throw new Error("insufficient observed training labels");
	const means = FEATURES.map((_, i) => samples.reduce((sum, s) => sum + s.x[i]!, 0) / samples.length);
	const scales = FEATURES.map(
		(_, i) => Math.sqrt(samples.reduce((sum, s) => sum + (s.x[i]! - means[i]!) ** 2, 0) / samples.length) || 1,
	);
	const weights = FEATURES.map(() => 0);
	let intercept = 0;
	for (let epoch = 0; epoch < 250; epoch++) {
		const gradient = weights.map(() => 0);
		let bias = 0;
		for (const s of samples) {
			const x = s.x.map((v, i) => (v - means[i]!) / scales[i]!);
			const logit = Math.max(-30, Math.min(30, intercept + x.reduce((sum, v, i) => sum + v * weights[i]!, 0)));
			const error = 1 / (1 + Math.exp(-logit)) - s.y;
			bias += error;
			for (let i = 0; i < gradient.length; i++) gradient[i]! += error * x[i]!;
		}
		for (let i = 0; i < weights.length; i++)
			weights[i]! -= 0.05 * (gradient[i]! / samples.length + 0.01 * weights[i]!);
		intercept -= (0.05 * bias) / samples.length;
	}
	return {
		version: "linear-v1",
		features: FEATURES,
		weights,
		means,
		scales,
		intercept,
		minSupport: 1,
		minSimilarity: 0.5,
		minMargin: 0.01,
		corpusHash: hashCorpus(corpus),
		model,
		dimensions: DIMENSIONS,
		format: FORMAT_VERSION,
		policyIdentity,
		trainingHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(observations)).digest("hex"),
		trainingExamples: samples.length,
	};
}
