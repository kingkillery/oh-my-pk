#!/usr/bin/env bun
/**
 * Fast Decision Dispatcher & Benchmark Tool
 *
 * Demonstrates super-fast decision model routing to choose optimal models
 * from our preferred pool for maximum token savings and minimum latency.
 *
 * Usage:
 *   bun scripts/fast-decision-dispatch.ts "Your prompt here"
 *   bun scripts/fast-decision-dispatch.ts --preference=speed "Quick summary"
 *   bun scripts/fast-decision-dispatch.ts --preference=cost "General question"
 *   bun scripts/fast-decision-dispatch.ts --benchmark
 */

import { decideOptimalModel, type DecisionResult } from "../packages/llm-router-agent/src/fast-decision-client";

interface BenchmarkItem {
	prompt: string;
	category: string;
	preference?: "speed" | "quality" | "cost" | "safety" | "balanced";
}

const BENCHMARK_SUITE: BenchmarkItem[] = [
	{
		category: "Coding Specialist",
		prompt: "Refactor this TypeScript state machine with exhaustive type narrowing and unit tests.",
	},
	{
		category: "Coding Bugfix",
		prompt: "Fix memory leak in Node.js event emitter listener cleanup.",
	},
	{
		category: "High-Risk Security",
		prompt: "Perform a security audit looking for cryptographic timing attack vulnerabilities.",
		preference: "safety",
	},
	{
		category: "Speed / Low-Latency",
		prompt: "Translate 'Good morning, how are you today?' into German and French.",
		preference: "speed",
	},
	{
		category: "Zero-Cost Free Tier",
		prompt: "What are Kepler's three laws of planetary motion?",
		preference: "cost",
	},
	{
		category: "Balanced General",
		prompt: "Summarize the key differences between b-trees and log-structured merge trees.",
		preference: "balanced",
	},
];

async function runBenchmark(): Promise<void> {
	console.log("\n===============================================================================");
	console.log("       OH-MY-PK FAST DECISION DISPATCHER BENCHMARK & TOKEN SAVINGS");
	console.log("===============================================================================\n");
	console.log("Evaluating requests against preferred model pool with live decision routing...\n");

	const results: Array<DecisionResult & { category: string; prompt: string }> = [];
	let totalFrontierCost = 0;
	let totalRoutedCost = 0;
	let totalDecisionTime = 0;

	for (const item of BENCHMARK_SUITE) {
		const result = await decideOptimalModel(item.prompt, {
			preference: item.preference,
		});
		results.push({ ...result, category: item.category, prompt: item.prompt });
		totalFrontierCost += result.baselineFrontierCostPerM;
		totalRoutedCost += result.estimatedCostPerM;
		totalDecisionTime += result.decisionLatencyMs;
	}

	console.log(
		"| Category             | Selected Model                         | Cost/Mtok | Baseline | Savings | Decision Latency |",
	);
	console.log(
		"|:---------------------|:---------------------------------------|:----------|:---------|:--------|:-----------------|",
	);

	for (const r of results) {
		const cat = r.category.padEnd(20);
		const model = r.selectedModel.padEnd(38);
		const cost = `$${r.estimatedCostPerM.toFixed(2)}`.padEnd(9);
		const base = `$${r.baselineFrontierCostPerM.toFixed(2)}`.padEnd(8);
		const savings = `${r.tokenSavingsPercent}%`.padEnd(7);
		const lat = `${r.decisionLatencyMs}ms`.padEnd(16);
		console.log(`| ${cat} | ${model} | ${cost} | ${base} | ${savings} | ${lat} |`);
	}

	const overallSavingsPercent = Math.round(
		((totalFrontierCost - totalRoutedCost) / totalFrontierCost) * 100,
	);
	const avgDecisionMs = Math.round(totalDecisionTime / results.length);

	console.log("\n-------------------------------------------------------------------------------");
	console.log(`SUMMARY:`);
	console.log(` • Average Decision Latency:  ${avgDecisionMs} ms`);
	console.log(` • Baseline Flagship Cost:    $${totalFrontierCost.toFixed(2)} / Mtok`);
	console.log(` • Routed Aggregate Cost:     $${totalRoutedCost.toFixed(2)} / Mtok`);
	console.log(` • Total Cost/Token Savings:  ${overallSavingsPercent}% saved across requests`);
	console.log("-------------------------------------------------------------------------------\n");
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.includes("--benchmark") || args.length === 0) {
		await runBenchmark();
		return;
	}

	let preference: "speed" | "quality" | "cost" | "safety" | "balanced" | undefined;
	const promptParts: string[] = [];

	for (const arg of args) {
		if (arg.startsWith("--preference=")) {
			preference = arg.split("=")[1] as typeof preference;
		} else {
			promptParts.push(arg);
		}
	}

	const prompt = promptParts.join(" ").trim();
	if (!prompt) {
		console.error("Please provide a prompt or use --benchmark");
		process.exit(1);
	}

	console.log(`\nEvaluating prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}"`);
	const result = await decideOptimalModel(prompt, { preference });

	console.log("\n==================== ROUTING DECISION ====================");
	console.log(` • Selected Model:       ${result.selectedModel}`);
	console.log(` • Routing Lane:          ${result.lane}`);
	console.log(` • Reason:                ${result.reason}`);
	console.log(` • Confidence:            ${Math.round(result.confidence * 100)}%`);
	console.log(` • Estimated Model Cost:  $${result.estimatedCostPerM.toFixed(2)} / M tokens`);
	console.log(` • Baseline Frontier:     $${result.baselineFrontierCostPerM.toFixed(2)} / M tokens`);
	console.log(` • Token Savings:         ${result.tokenSavingsPercent}% ($${result.tokenSavingsUsdPerM.toFixed(2)}/Mtok saved)`);
	console.log(` • Decision Latency:      ${result.decisionLatencyMs} ms`);
	console.log(` • Fallback Chain:        ${result.fallbackChain.join(" -> ")}`);
	console.log(` • Decision Source:       ${result.source}`);
	console.log("==========================================================\n");
}

main().catch(err => {
	console.error("Error executing fast decision dispatcher:", err);
	process.exit(1);
});
