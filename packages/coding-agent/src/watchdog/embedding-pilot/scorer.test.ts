import { describe, expect, spyOn, test } from "bun:test";
import {
	type Case,
	type Decision,
	FAMILY,
	FEATURES,
	features,
	type Head,
	hashCorpus,
	inputHash,
	neighbors,
	type Policy,
	policyFingerprint,
	rawScore,
	scoreChoices as scoreEmbedding,
} from "./scorer";
import { DIMENSIONS, embed, FORMAT_VERSION, formatInput, MODEL, normalize, splitInput } from "./titan";
import { fit, type Observation } from "./train";

const vector = (i = 0) => Array.from({ length: DIMENSIONS }, (_, n) => (n === i ? 1 : 0));
const identity = policyFingerprint({});
const policy: Policy = {
	identity,
	scope: "fixture",
	config: {},
	evaluation: { stallSeverity: 0.2, isThrashing: 0.1, blockerType: "none", confidence: 1, latencyMs: 1 },
};
const request: Decision = {
	id: "new",
	family: FAMILY,
	question: "What next?",
	state: "No failure",
	group: "new-group",
	at: 100,
	choices: [
		{ id: "a", actionKey: "pass", description: "Continue" },
		{ id: "b", actionKey: "tripwire_abort", description: "Stop" },
	],
};
const cases: Case[] = [
	{
		id: "old",
		group: "old-group",
		scope: "fixture",
		family: FAMILY,
		policyIdentity: identity,
		at: 1,
		outcomeAt: 2,
		actionKey: "pass",
		success: true,
		vector: vector(),
		embeddingModel: MODEL,
		embeddingFormat: FORMAT_VERSION,
	},
];
const head: Head = {
	version: "linear-v1",
	features: FEATURES,
	weights: [1, 1, 1, -1, 0, 0],
	means: [0, 0, 0, 0, 0, 0],
	scales: [1, 1, 1, 1, 1, 1],
	intercept: 0,
	minSupport: 1,
	minSimilarity: 0.5,
	minMargin: 0.01,
	corpusHash: hashCorpus(cases),
	model: MODEL,
	dimensions: DIMENSIONS,
	format: FORMAT_VERSION,
	policyIdentity: identity,
	trainingHash: "fixture",
	trainingExamples: 4,
};
const scoreChoices = (d: Decision, p: Policy | undefined, v: number[], c: Case[], h: Head) =>
	scoreEmbedding(d, p, { vector: v, model: h.model, format: h.format, inputHash: inputHash(d) }, c, h);

describe("watchdog offline scorer", () => {
	test("respects incumbent arbitration regardless of candidate order", () => {
		const a = scoreChoices(request, policy, vector(), cases, head);
		const b = scoreChoices({ ...request, choices: [...request.choices].reverse() }, policy, vector(), cases, head);
		expect(a.choiceId).toBe("a");
		expect(b.choiceId).toBe("a");
		expect(a.evidenceCaseIds).toEqual(["old"]);
		expect(a.confidence).toBeNull();
	});
	test("abstains for missing policy, invalid candidates, unobserved support, and ties", () => {
		expect(scoreChoices(request, undefined, vector(), cases, head).reasonCodes).toEqual(["POLICY_UNAVAILABLE"]);
		expect(
			scoreChoices(
				{ ...request, choices: [request.choices[0]!, request.choices[0]!] },
				policy,
				vector(),
				cases,
				head,
			).reasonCodes,
		).toEqual(["INVALID_REQUEST"]);
		expect(
			scoreChoices({ ...request, choices: [request.choices[1]!] }, policy, vector(), cases, head).reasonCodes,
		).toEqual(["NO_ELIGIBLE_CHOICE"]);
		expect(
			scoreChoices(
				{ ...request, choices: [...request.choices, { ...request.choices[0]!, id: "same-action" }] },
				policy,
				vector(),
				cases,
				head,
			).reasonCodes,
		).toEqual(["UNRESOLVED_TIE"]);
	});
	test("excludes same-group, future, and cross-scope cases", () => {
		const changes: Case[] = [
			{ ...cases[0]!, group: request.group },
			{ ...cases[0]!, id: "future", outcomeAt: 101 },
			{ ...cases[0]!, id: "other-scope", scope: "elsewhere" },
		];
		expect(neighbors(request, policy, vector(), changes)).toEqual([]);
		expect(
			scoreChoices(request, policy, vector(), changes, { ...head, corpusHash: hashCorpus(changes) }).reasonCodes,
		).toEqual(["UNFAMILIAR_STATE"]);
	});
	test("rejects incompatible artifacts and malformed embeddings", () => {
		expect(scoreChoices(request, policy, vector(), cases, { ...head, dimensions: 1024 }).reasonCodes).toEqual([
			"INCOMPATIBLE_ARTIFACT",
		]);
		expect(scoreChoices(request, policy, [NaN], cases, head).reasonCodes).toEqual(["INVALID_EVIDENCE"]);
		expect(() => normalize(Array(DIMENSIONS).fill(0))).toThrow();
	});
	test("a fitted head uses the same features and score during replay", () => {
		const corpus: Case[] = Array.from({ length: 8 }, (_, i) => ({
			...cases[0]!,
			id: `c${i}`,
			group: `g${i}`,
			at: i * 10,
			outcomeAt: i * 10 + 1,
			success: i % 2 === 0,
		}));
		const observations: Observation[] = corpus.map(c => ({
			decision: { ...request, id: c.id, group: c.group, at: c.at },
			policy,
			vector: vector(),
			actionKey: "pass",
			success: c.success,
		}));
		const fitted = fit(observations, corpus, identity);
		const actual = scoreChoices(request, policy, vector(), corpus, fitted);
		const expected = rawScore(
			features("pass", neighbors(request, policy, vector(), corpus), policy.evaluation),
			fitted,
		);
		expect(actual.rankings[0]?.score).toBeCloseTo(expected, 12);
		expect(fitted.trainingExamples).toBeGreaterThan(0);
	});
	test("preserves negation and rejects oversize input", () => {
		expect(formatInput("Should I stop?", "Do not stop")).toContain("Do not stop");
		const input = formatInput("Question", "Do not stop. ".repeat(30));
		expect(splitInput(input).join("")).toBe(input);
		expect(splitInput(input).every(chunk => chunk.length <= 120)).toBe(true);
		expect(() => formatInput("Question", "x".repeat(1921))).toThrow();
		expect(
			scoreEmbedding(
				{ ...request, question: "What else?" },
				policy,
				{ vector: vector(), model: MODEL, format: FORMAT_VERSION, inputHash: inputHash(request) },
				cases,
				head,
			).reasonCodes,
		).toEqual(["INCOMPATIBLE_EMBEDDING"]);
	});
	test("embeds every chunk in order and pools normalized vectors", async () => {
		const spy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_url: string | Request | URL, init?: RequestInit) => {
					const body = JSON.parse(String(init?.body));
					expect(body.input.join("")).toBe(formatInput("Q", "not stuck ".repeat(35)));
					return Response.json({
						data: body.input.map((_x: string, i: number) => ({ index: i, embedding: vector(i % 2) })),
					});
				},
				{ preconnect: fetch.preconnect },
			),
		);
		try {
			const result = await embed("Q", "not stuck ".repeat(35), "key");
			expect(result).toHaveLength(DIMENSIONS);
			expect(result[0]).toBeGreaterThan(0);
			expect(result[1]).toBeGreaterThan(0);
		} finally {
			spy.mockRestore();
		}
	});
	test("fails on missing credentials, malformed response and timeout", async () => {
		await expect(embed("Q", "S", "")).rejects.toThrow("key");
		const spy = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async () => Response.json({ data: [{ index: 1, embedding: vector() }] }), {
				preconnect: fetch.preconnect,
			}),
		);
		try {
			await expect(embed("Q", "S", "key")).rejects.toThrow("order");
		} finally {
			spy.mockRestore();
		}
		const timeout = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | Request | URL, init?: RequestInit) => {
					const pending = Promise.withResolvers<void>();
					const timer = setTimeout(() => pending.reject(new Error("signal did not abort")), 100);
					init!.signal!.addEventListener("abort", () => {
						clearTimeout(timer);
						pending.reject(new Error("timeout"));
					});
					await pending.promise;
					return new Response();
				},
				{ preconnect: fetch.preconnect },
			),
		);
		try {
			await expect(embed("Q", "S", "key", 5)).rejects.toThrow("timeout");
		} finally {
			timeout.mockRestore();
		}
	});
});
