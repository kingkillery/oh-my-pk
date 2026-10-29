import { arbitrateHealth } from "../arbitrator";
import type { WatchdogConfig, WatchdogEvaluation } from "../types";
import { DIMENSIONS, embed, FORMAT_VERSION, formatInput, MODEL, normalize } from "./titan";

export const FAMILY = "watchdog-intervention";
export const FEATURES = [
	"nearest",
	"action_similarity",
	"success_support",
	"failure_support",
	"severity",
	"thrashing",
] as const;
export interface Choice {
	id: string;
	actionKey: "pass" | "inject_hint" | "tripwire_abort";
	description: string;
}
export interface Decision {
	id: string;
	family: string;
	question: string;
	state: string;
	group: string;
	at: number;
	choices: Choice[];
}
export interface DecisionEmbedding {
	vector: number[];
	model: string;
	format: string;
	inputHash: string;
}
export function inputHash(request: Decision): string {
	return new Bun.CryptoHasher("sha256").update(formatInput(request.question, request.state)).digest("hex");
}
export async function embedDecision(request: Decision, apiKey: string): Promise<DecisionEmbedding> {
	return {
		vector: await embed(request.question, request.state, apiKey),
		model: MODEL,
		format: FORMAT_VERSION,
		inputHash: inputHash(request),
	};
}
export interface Policy {
	identity: string;
	scope: string;
	evaluation: WatchdogEvaluation;
	config: WatchdogConfig;
}
export interface Case {
	id: string;
	group: string;
	scope: string;
	family: string;
	policyIdentity: string;
	at: number;
	outcomeAt: number;
	actionKey: Choice["actionKey"];
	success: boolean;
	vector: number[];
	embeddingModel: string;
	embeddingFormat: string;
}
export interface Head {
	version: "linear-v1";
	features: readonly string[];
	weights: number[];
	means: number[];
	scales: number[];
	intercept: number;
	minSupport: number;
	minSimilarity: number;
	minMargin: number;
	corpusHash: string;
	model: string;
	dimensions: number;
	format: string;
	policyIdentity: string;
	trainingHash: string;
	trainingExamples: number;
}
export interface Recommendation {
	choiceId: string | null;
	rankings: { id: string; score: number }[];
	abstained: boolean;
	reasonCodes: string[];
	evidenceCaseIds: string[];
	confidence: null;
	provenance: {
		model: string;
		dimensions: number;
		format: string;
		head: string;
		corpusHash: string;
		policyIdentity: string;
	};
}

export function hashCorpus(cases: readonly Case[]): string {
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(cases)).digest("hex");
}
export function policyFingerprint(config: WatchdogConfig): string {
	return new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify({
				version: "watchdog-arbitrator-v1",
				abortSeverity: config.abortSeverityThreshold ?? 2.5,
				abortThrash: config.abortThrashThreshold ?? 0.85,
				hintSeverity: config.hintSeverityThreshold ?? 1.6,
				hintThrash: config.hintThrashThreshold ?? 0.6,
			}),
		)
		.digest("hex");
}
function dot(a: readonly number[], b: readonly number[]): number {
	return a.reduce((sum, x, i) => sum + x * b[i]!, 0);
}

export function neighbors(
	request: Decision,
	policy: Policy,
	vector: number[],
	cases: readonly Case[],
	model = MODEL,
): { item: Case; similarity: number }[] {
	const normalized = normalize(vector);
	return cases
		.filter(
			c =>
				c.id !== request.id &&
				c.group !== request.group &&
				c.scope === policy.scope &&
				c.family === FAMILY &&
				c.policyIdentity === policy.identity &&
				c.embeddingModel === model &&
				c.embeddingFormat === FORMAT_VERSION &&
				c.at < request.at &&
				c.outcomeAt < request.at,
		)
		.map(item => ({ item, similarity: dot(normalized, normalize(item.vector)) }))
		.sort((a, b) => b.similarity - a.similarity || a.item.id.localeCompare(b.item.id))
		.slice(0, 8);
}

export function features(
	action: Choice["actionKey"],
	similar: ReturnType<typeof neighbors>,
	evaluation: WatchdogEvaluation,
): number[] {
	const support = similar.filter(n => n.item.actionKey === action);
	if (!similar.length || !support.length) throw new Error("action has no historical support");
	return [
		similar[0]!.similarity,
		support[0]!.similarity,
		support.filter(n => n.item.success).length,
		support.filter(n => !n.item.success).length,
		evaluation.stallSeverity,
		evaluation.isThrashing,
	];
}
export function rawScore(
	values: readonly number[],
	head: Pick<Head, "weights" | "means" | "scales" | "intercept">,
): number {
	if (
		values.length !== head.weights.length ||
		values.length !== head.means.length ||
		values.length !== head.scales.length ||
		!values.every(Number.isFinite) ||
		!head.weights.every(Number.isFinite) ||
		!head.means.every(Number.isFinite) ||
		!head.scales.every(x => Number.isFinite(x) && x > 0) ||
		!Number.isFinite(head.intercept)
	)
		throw new Error("invalid features or head");
	return (
		head.intercept +
		dot(
			values.map((v, i) => (v - head.means[i]!) / head.scales[i]!),
			head.weights,
		)
	);
}

export function scoreChoices(
	request: Decision,
	policy: Policy | undefined,
	embedding: DecisionEmbedding,
	cases: readonly Case[],
	head: Head,
): Recommendation {
	const provenance = {
		model: head.model,
		dimensions: head.dimensions,
		format: head.format,
		head: head.version,
		corpusHash: head.corpusHash,
		policyIdentity: policy?.identity ?? "unavailable",
	};
	const abstain = (reason: string): Recommendation => ({
		choiceId: null,
		rankings: [],
		abstained: true,
		reasonCodes: [reason],
		evidenceCaseIds: [],
		confidence: null,
		provenance,
	});
	if (
		!policy ||
		!policy.identity ||
		!policy.scope ||
		!policy.evaluation ||
		!policy.config ||
		!Number.isFinite(policy.evaluation.stallSeverity) ||
		!Number.isFinite(policy.evaluation.isThrashing) ||
		policy.evaluation.stallSeverity < 0 ||
		policy.evaluation.stallSeverity > 3 ||
		policy.evaluation.isThrashing < 0 ||
		policy.evaluation.isThrashing > 1 ||
		Object.values(policy.config).some(v => typeof v === "number" && !Number.isFinite(v)) ||
		policy.identity !== policyFingerprint(policy.config)
	)
		return abstain("POLICY_UNAVAILABLE");
	if (
		!request.id ||
		request.family !== FAMILY ||
		!request.question.trim() ||
		!request.state.trim() ||
		!request.group ||
		!Number.isFinite(request.at) ||
		!Array.isArray(request.choices) ||
		request.choices.length < 1 ||
		request.choices.length > 16 ||
		new Set(request.choices.map(c => c.id)).size !== request.choices.length ||
		request.choices.some(
			c => !c.id || !c.description || !["pass", "inject_hint", "tripwire_abort"].includes(c.actionKey),
		)
	)
		return abstain("INVALID_REQUEST");
	if (
		!Array.isArray(cases) ||
		cases.length > 10000 ||
		new Set(cases.map(c => c.id)).size !== cases.length ||
		cases.some(
			c =>
				!c.id ||
				!c.group ||
				!c.scope ||
				!Number.isFinite(c.at) ||
				!Number.isFinite(c.outcomeAt) ||
				c.outcomeAt < c.at ||
				typeof c.success !== "boolean" ||
				!["pass", "inject_hint", "tripwire_abort"].includes(c.actionKey),
		)
	)
		return abstain("INVALID_EVIDENCE");
	if (
		head.version !== "linear-v1" ||
		![MODEL, "fixture:384"].includes(head.model) ||
		head.dimensions !== DIMENSIONS ||
		head.format !== FORMAT_VERSION ||
		head.policyIdentity !== policy.identity ||
		head.corpusHash !== hashCorpus(cases) ||
		JSON.stringify(head.features) !== JSON.stringify(FEATURES) ||
		head.weights.length !== FEATURES.length ||
		!Number.isInteger(head.minSupport) ||
		head.minSupport < 1 ||
		!Number.isFinite(head.minSimilarity) ||
		!Number.isFinite(head.minMargin)
	)
		return abstain("INCOMPATIBLE_ARTIFACT");
	try {
		if (
			!embedding ||
			embedding.model !== head.model ||
			embedding.format !== head.format ||
			embedding.inputHash !== inputHash(request)
		)
			return abstain("INCOMPATIBLE_EMBEDDING");
	} catch {
		return abstain("INVALID_REQUEST");
	}
	const eligible = arbitrateHealth(policy.evaluation, policy.config).action;
	const choices = request.choices.filter(c => c.actionKey === eligible);
	if (!choices.length) return abstain("NO_ELIGIBLE_CHOICE");
	try {
		const matches = neighbors(request, policy, embedding.vector, cases, head.model);
		if (!matches.length || matches[0]!.similarity < head.minSimilarity) return abstain("UNFAMILIAR_STATE");
		if (choices.some(c => matches.filter(n => n.item.actionKey === c.actionKey).length < head.minSupport))
			return abstain("INADEQUATE_SUPPORT");
		const rankings = choices
			.map(c => ({ id: c.id, score: rawScore(features(c.actionKey, matches, policy.evaluation), head) }))
			.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		const winner = choices.find(c => c.id === rankings[0]!.id)!;
		const support = matches.filter(n => n.item.actionKey === winner.actionKey);
		if (support.length < head.minSupport) return abstain("INADEQUATE_SUPPORT");
		if (rankings.length > 1 && rankings[0]!.score - rankings[1]!.score <= head.minMargin)
			return abstain("UNRESOLVED_TIE");
		return {
			choiceId: winner.id,
			rankings,
			abstained: false,
			reasonCodes: [],
			evidenceCaseIds: support.map(n => n.item.id),
			confidence: null,
			provenance,
		};
	} catch {
		return abstain("INVALID_EVIDENCE");
	}
}
