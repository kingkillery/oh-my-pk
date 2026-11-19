#!/usr/bin/env bun
/**
 * Thin CLI adapter over `scripts/sim/workflow.ts`.
 *
 * Parses argv flags, invokes the deep in-process SIM workflow module, renders
 * human or `--json` output, and maps outcomes/errors to exit codes `0` or `1`.
 *
 * Subcommands:
 *   bun scripts/sim/cli.ts replay   [--json] [--model <id>] [--save <file>] [--baseline <file>]
 *   bun scripts/sim/cli.ts predict  --problem <P#|new> [--name <text>] --predicted <id1,id2> [opts]
 *   bun scripts/sim/cli.ts carry    --arm <src> --domain <d> --into <target> [opts]
 *   bun scripts/sim/cli.ts validate [--ledger <path>]
 *   bun scripts/sim/cli.ts status   [--ledger <path>] [--json]
 *   bun scripts/sim/cli.ts merge    [--ledger <path>]
 *   bun scripts/sim/cli.ts record   --what <desc> --files <a,b> --model <m> --domain <d> --benchmark <b> [opts]
 *   bun scripts/sim/cli.ts cases
 */
import * as path from "node:path";
import { createSimWorkflow, type SimWorkflow } from "./workflow.ts";

interface ParsedArgs {
	command: string;
	flags: Map<string, string | boolean>;
}

function parseCliArgs(argv: string[]): ParsedArgs {
	const [command = "help", ...rest] = argv;
	const flags = new Map<string, string | boolean>();
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (!token.startsWith("--")) continue;
		const eqIdx = token.indexOf("=");
		if (eqIdx !== -1) {
			flags.set(token.slice(2, eqIdx), token.slice(eqIdx + 1));
			continue;
		}
		const key = token.slice(2);
		const next = rest[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags.set(key, next);
			i += 1;
		} else {
			flags.set(key, true);
		}
	}
	return { command, flags };
}

function getStringFlag(flags: Map<string, string | boolean>, name: string): string | undefined {
	const value = flags.get(name);
	return typeof value === "string" ? value : undefined;
}

function getBoolFlag(flags: Map<string, string | boolean>, name: string, fallback = false): boolean {
	const value = flags.get(name);
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
	if (normalized === "false" || normalized === "0" || normalized === "no") return false;
	throw new Error(`Invalid boolean value for --${name}: "${value}"`);
}

function parsePositiveIntFlag(flags: Map<string, string | boolean>, name: string): number | undefined {
	const raw = getStringFlag(flags, name);
	if (raw === undefined) return undefined;
	const trimmed = raw.trim();
	if (!/^[1-9][0-9]*$/.test(trimmed)) {
		throw new Error(`Invalid positive integer for --${name}: "${raw}"`);
	}
	return Number.parseInt(trimmed, 10);
}

function splitCsv(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map(part => part.trim())
		.filter(Boolean);
}

async function cmdReplay(workflow: SimWorkflow, flags: Map<string, string | boolean>): Promise<number> {
	const asJson = getBoolFlag(flags, "json", false);
	const { report, diff } = await workflow.replay({
		model: getStringFlag(flags, "model"),
		baselinePath: getStringFlag(flags, "baseline"),
		savePath: getStringFlag(flags, "save"),
	});

	if (asJson) {
		console.log(JSON.stringify(diff ? { ...report, diff } : report, null, 2));
	} else {
		console.log(`SIM Replay: ${report.passed}/${report.total} passed`);
		for (const item of report.results) {
			const status = item.passed ? "PASS" : "FAIL";
			console.log(`  [${status}] ${item.id} (${item.category}, ${item.duration_ms}ms)`);
			if (item.error) {
				console.log(`         ${item.error}`);
			}
		}
		if (diff) {
			console.log(
				`Baseline diff: newly_passing=[${diff.newly_passing.join(", ")}] regressed=[${diff.regressed.join(", ")}] unresolved=[${diff.unresolved.join(", ")}]`,
			);
			if (diff.model_mismatch) {
				console.log(
					`Model mismatch (RSI-21): baseline="${diff.model_mismatch.baselineModel}" != candidate="${diff.model_mismatch.candidateModel}"`,
				);
			}
		}
	}

	return report.passed === report.total ? 0 : 1;
}

async function cmdPredict(workflow: SimWorkflow, flags: Map<string, string | boolean>): Promise<number> {
	const asJson = getBoolFlag(flags, "json", false);
	const backfilled = flags.has("backfilled") ? getBoolFlag(flags, "backfilled", false) : undefined;
	const { manifestPath, manifest } = await workflow.predict({
		problem: getStringFlag(flags, "problem") ?? "",
		name: getStringFlag(flags, "name"),
		predicted: splitCsv(getStringFlag(flags, "predicted")),
		round: parsePositiveIntFlag(flags, "round"),
		what: getStringFlag(flags, "what"),
		files: splitCsv(getStringFlag(flags, "files")),
		model: getStringFlag(flags, "model"),
		domain: getStringFlag(flags, "domain"),
		benchmark: getStringFlag(flags, "benchmark"),
		sample: getStringFlag(flags, "sample"),
		backfilled,
		baselinePath: getStringFlag(flags, "baseline"),
		force: getBoolFlag(flags, "force", false),
		allowUnknownCases: getBoolFlag(flags, "allow-unknown-cases", false),
		allowPreserved: getBoolFlag(flags, "allow-preserved", false),
	});

	if (asJson) {
		console.log(JSON.stringify({ manifest_path: manifestPath, ...manifest }, null, 2));
	} else {
		console.log(
			`Pre-eval manifest saved: ${manifestPath}\n` +
				`  manifest_id: ${manifest.manifest_id}\n` +
				`  problem: ${manifest.problem}${manifest.name ? ` ("${manifest.name}")` : ""}\n` +
				`  predicted: [${manifest.predicted.join(", ")}]\n` +
				`  prediction_hash: ${manifest.prediction_hash}`,
		);
	}
	return 0;
}

async function cmdCarry(workflow: SimWorkflow, flags: Map<string, string | boolean>): Promise<number> {
	const asJson = getBoolFlag(flags, "json", false);
	const arm = getStringFlag(flags, "arm") ?? "";
	const domain = getStringFlag(flags, "domain") ?? "";
	const into = getStringFlag(flags, "into") ?? "";
	const benchmark = getStringFlag(flags, "benchmark");
	const model = getStringFlag(flags, "model");

	const outcome = await workflow.carry({ arm, domain, into, benchmark, model });
	if (asJson) {
		console.log(
			JSON.stringify(
				{
					ledger: outcome.ledgerPath,
					carried_from: outcome.carriedFrom,
					next_round: outcome.nextRound,
					problems: outcome.problemCount,
				},
				null,
				2,
			),
		);
	} else {
		console.log(
			`Carried SIM ledger forward -> ${into} (from arm=${arm}, domain=${domain}${benchmark ? `, benchmark=${benchmark}` : ""}${model ? `, model=${model}` : ""}); next round: ${outcome.nextRound}`,
		);
	}
	return 0;
}

async function cmdValidate(workflow: SimWorkflow): Promise<number> {
	const outcome = await workflow.validate();
	if (!outcome.valid) {
		if (outcome.missing) {
			console.error(outcome.errors[0] ?? `SIM ledger not found: ${outcome.ledgerPath}`);
			return 1;
		}
		console.error(`SIM ledger validation failed (${outcome.ledgerPath}):`);
		for (const err of outcome.errors) {
			console.error(`  - ${err}`);
		}
		return 1;
	}
	console.log(
		`SIM ledger valid: ${outcome.problemCount} problems, ${outcome.attemptCount} attempts, ${outcome.aliasCount} aliases (${outcome.ledgerPath})`,
	);
	return 0;
}

async function cmdStatus(workflow: SimWorkflow, flags: Map<string, string | boolean>): Promise<number> {
	const asJson = getBoolFlag(flags, "json", false);
	const summary = await workflow.status();
	if (asJson) {
		console.log(JSON.stringify(summary, null, 2));
		return 0;
	}

	console.log(
		`SIM Status (v${summary.schema_version}, ${summary.problem_count} problems, ${summary.attempt_count} attempts, next_id=${summary.next_id})`,
	);
	if (summary.carried_from) {
		const cf = summary.carried_from;
		console.log(
			`Carried from: arm=${cf.arm}, domain=${cf.domain}, into=${cf.into}${cf.benchmark ? `, benchmark=${cf.benchmark}` : ""}${cf.model ? `, model=${cf.model}` : ""}${cf.carried_at ? `, carried_at=${cf.carried_at}` : ""}`,
		);
	}
	if (Object.keys(summary.aliases).length > 0) {
		console.log(`Aliases: ${JSON.stringify(summary.aliases)}`);
	}
	for (const p of summary.problems) {
		const bucketParts: string[] = [];
		if (p.missed.length > 0) bucketParts.push(`missed=[${p.missed.join(", ")}]`);
		if (p.regressed.length > 0) bucketParts.push(`regressed=[${p.regressed.join(", ")}]`);
		if (p.unresolved.length > 0) bucketParts.push(`unresolved=[${p.unresolved.join(", ")}]`);
		if (p.unproven.length > 0) bucketParts.push(`unproven=[${p.unproven.join(", ")}]`);
		if (p.incomplete.length > 0) bucketParts.push(`incomplete=[${p.incomplete.join(", ")}]`);
		const bucketText = bucketParts.length > 0 ? ` ${bucketParts.join(" ")}` : "";
		console.log(
			`  ${p.id} (r${p.opened_round}, ${p.attempts} attempt${p.attempts === 1 ? "" : "s"}, ${p.latest_score}${bucketText}): ${p.name}`,
		);
		console.log(
			`     domains=[${p.domains.join(", ")}] benchmarks=[${p.benchmarks.join(", ")}] models=[${p.models.join(", ")}]`,
		);
	}
	return 0;
}

async function cmdMerge(workflow: SimWorkflow): Promise<number> {
	const { merged } = await workflow.merge();
	if (merged.length === 0) {
		console.log("No exact-text duplicate problems found.");
	} else {
		console.log(`Merged ${merged.length} duplicate problem(s):`);
		for (const item of merged) {
			console.log(`  ${item.from} -> ${item.into} ("${item.name}")`);
		}
	}
	return 0;
}

async function cmdRecord(workflow: SimWorkflow, flags: Map<string, string | boolean>): Promise<number> {
	const noRejectedLog = getBoolFlag(flags, "no-rejected-log", false);
	const backfilled = flags.has("backfilled") ? getBoolFlag(flags, "backfilled", false) : undefined;
	const outcome = await workflow.record({
		problem: getStringFlag(flags, "problem"),
		name: getStringFlag(flags, "name"),
		predicted: flags.has("predicted") ? splitCsv(getStringFlag(flags, "predicted")) : undefined,
		what: getStringFlag(flags, "what"),
		files: flags.has("files") ? splitCsv(getStringFlag(flags, "files")) : undefined,
		model: getStringFlag(flags, "model"),
		domain: getStringFlag(flags, "domain"),
		benchmark: getStringFlag(flags, "benchmark"),
		sample: getStringFlag(flags, "sample"),
		accepted: getBoolFlag(flags, "accepted", true),
		backfilled,
		allowAdHoc: getBoolFlag(flags, "allow-ad-hoc", false),
		round: parsePositiveIntFlag(flags, "round"),
		run: getStringFlag(flags, "run"),
		commit: getStringFlag(flags, "commit"),
		baselinePath: getStringFlag(flags, "baseline"),
		replayJsonPath: getStringFlag(flags, "replay-json"),
		baselineRef: getStringFlag(flags, "baseline-ref"),
		candidateRef: getStringFlag(flags, "candidate-ref"),
		noRejectedLog,
	});

	if (!outcome.recorded) {
		console.log(
			`[NO-OP §3.2] Rejected candidate not appended to ${outcome.ledgerPath}.` +
				(outcome.rejectedLogPath ? ` Logged negative experience to ${outcome.rejectedLogPath}.` : ""),
		);
		return 0;
	}

	const aliasNote = outcome.mergedFromAlias ? ` (via alias ${outcome.mergedFromAlias})` : "";
	const action = outcome.createdProblem ? "Opened" : "Updated";
	console.log(
		`${action} ${outcome.problemId}${aliasNote} round ${outcome.round}: ${outcome.report.passed}/${outcome.report.total} passed, ` +
			`fixed=[${outcome.diff.fixed.join(", ")}], missed=[${outcome.diff.missed.join(", ")}], ` +
			`preserved=[${outcome.diff.preserved.join(", ")}], regressed=[${outcome.diff.regressed.join(", ")}], ` +
			`unproven=[${outcome.diff.unproven.join(", ")}], incomplete=[${outcome.diff.incomplete.join(", ")}]`,
	);
	return 0;
}

function cmdCases(workflow: SimWorkflow): number {
	const cases = workflow.cases();
	console.log(`SIM Replay Cases (${cases.length}):`);
	for (const item of cases) {
		console.log(`  ${item.id.padEnd(48)} [${item.category}] ${item.description}`);
	}
	return 0;
}

function printHelp(): number {
	console.log(
		`SIM CLI (arXiv:2611.18856 Appendix D & OMPK-RSI §24.1)\n\n` +
			`Commands:\n` +
			`  replay   [--json] [--model <id>] [--save <file>] [--baseline <file>]\n` +
			`  predict  --problem <P#|new> [--name <text>] --predicted <id1,id2> [--baseline <file>] [--allow-preserved] [--allow-unknown-cases] [--manifest <path>] [--force] [--json]\n` +
			`  carry    --arm <src> --domain <domain> --into <target-run> [--benchmark <b>] [--model <m>] [--ledger <path>] [--json]\n` +
			`  validate [--ledger <path>]\n` +
			`  status   [--ledger <path>] [--json]\n` +
			`  merge    [--ledger <path>]\n` +
			`  record   --what <desc> --files <a,b> --model <m> --domain <d> --benchmark <b> [--accepted true|false] [--baseline <file>] [--replay-json <file>] [--manifest <path>] [--sample <id>] [--backfilled true|false] [--allow-ad-hoc] [--run <id>] [--baseline-ref <ref>] [--candidate-ref <ref>] [--rejected-log <path>] [--no-rejected-log] [--ledger <path>]\n` +
			`  cases\n`,
	);
	return 0;
}

export async function runSimCli(argv: string[]): Promise<number> {
	const { command, flags } = parseCliArgs(argv);
	const ledgerFlag = getStringFlag(flags, "ledger");
	const manifestFlag = getStringFlag(flags, "manifest");
	const rejectedLogFlag = getStringFlag(flags, "rejected-log");
	const workflow = createSimWorkflow({
		...(ledgerFlag ? { ledgerPath: path.resolve(ledgerFlag) } : {}),
		...(manifestFlag ? { manifestPath: path.resolve(manifestFlag) } : {}),
		...(rejectedLogFlag ? { rejectedLogPath: path.resolve(rejectedLogFlag) } : {}),
	});

	try {
		switch (command) {
			case "replay":
				return await cmdReplay(workflow, flags);
			case "predict":
				return await cmdPredict(workflow, flags);
			case "carry":
				return await cmdCarry(workflow, flags);
			case "validate":
				return await cmdValidate(workflow);
			case "status":
				return await cmdStatus(workflow, flags);
			case "merge":
				return await cmdMerge(workflow);
			case "record":
				return await cmdRecord(workflow, flags);
			case "cases":
				return cmdCases(workflow);
			default:
				return printHelp();
		}
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

if (import.meta.main) {
	const exitCode = await runSimCli(process.argv.slice(2));
	process.exit(exitCode);
}
