#!/usr/bin/env bun
/**
 * Minimal deterministic CLI for `oh-my-pk` Self-Improvement Memory (SIM).
 *
 * Subcommands:
 *   replay   Run the fast local regression harness and emit passed/total + diffs.
 *   validate Validate `.omp/sim.json` against the Appendix D.3 schema and invariants.
 *   record   Append a verified attempt (backing predicted vs fixed/missed with replay evidence).
 *   merge    Deterministically merge duplicate exact-text problems into canonical IDs + aliases.
 *   status   Print a concise ledger summary (problems, provenance, unresolved predictions).
 */

import * as path from "node:path";
import { runSimReplay, SIM_REPLAY_CASES } from "./replay";
import {
	appendSimAttempt,
	createEmptySimLedger,
	evaluateReplayDiff,
	mergeDuplicateProblems,
	type SimLedger,
	type SimReplayReport,
	validateSimLedger,
} from "./schema";

const DEFAULT_LEDGER_PATH = path.resolve(import.meta.dir, "../../.omp/sim.json");

interface ParsedArgs {
	command: string;
	flags: Record<string, string>;
	booleans: Set<string>;
}

function parseCliArgs(argv: readonly string[]): ParsedArgs {
	const [command = "help", ...rest] = argv;
	const flags: Record<string, string> = {};
	const booleans = new Set<string>();

	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (!token.startsWith("--")) continue;
		const eqIdx = token.indexOf("=");
		if (eqIdx !== -1) {
			const key = token.slice(2, eqIdx);
			flags[key] = token.slice(eqIdx + 1);
			continue;
		}
		const key = token.slice(2);
		const next = rest[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			flags[key] = next;
			i += 1;
		} else {
			booleans.add(key);
		}
	}

	return { command, flags, booleans };
}

function splitCsv(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map(part => part.trim())
		.filter(part => part.length > 0);
}

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	const lower = value.trim().toLowerCase();
	if (lower === "true" || lower === "1" || lower === "yes") return true;
	if (lower === "false" || lower === "0" || lower === "no") return false;
	throw new Error(`Invalid boolean value: "${value}". Expected true or false.`);
}

async function readLedger(ledgerPath: string, createIfMissing = false): Promise<SimLedger> {
	const file = Bun.file(ledgerPath);
	if (!(await file.exists())) {
		if (createIfMissing) return createEmptySimLedger();
		throw new Error(`SIM ledger not found at ${ledgerPath}`);
	}
	const parsed: unknown = await file.json();
	const check = validateSimLedger(parsed);
	if (!check.ok) {
		throw new Error(`Invalid SIM ledger at ${ledgerPath}:\n- ${check.errors.join("\n- ")}`);
	}
	return parsed as SimLedger;
}

async function writeLedger(ledgerPath: string, ledger: SimLedger): Promise<void> {
	await Bun.write(ledgerPath, `${JSON.stringify(ledger, null, "\t")}\n`);
}

async function readReplayReport(filePath: string): Promise<SimReplayReport> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		throw new Error(`Replay report file not found: ${filePath}`);
	}
	const parsed: unknown = await file.json();
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("passed" in parsed) ||
		!("total" in parsed) ||
		!("passed_ids" in parsed) ||
		!("failed_ids" in parsed) ||
		!Array.isArray(parsed.passed_ids) ||
		!Array.isArray(parsed.failed_ids)
	) {
		throw new Error(`Invalid replay report JSON at ${filePath}`);
	}
	return parsed as SimReplayReport;
}

function printHelp(): void {
	process.stdout.write(
		[
			"Usage: bun scripts/sim/cli.ts <command> [options]",
			"",
			"Commands:",
			"  replay    [--json] [--cases id1,id2] [--predicted id1,id2] [--baseline <file>] [--save <file>]",
			"  validate  [--ledger <path>]",
			"  status    [--ledger <path>] [--json]",
			"  merge     [--ledger <path>]",
			"  record    --what <text> --files <a,b> --model <model> --domain <domain>",
			"            [--problem <P#|new>] [--name <hypothesis>] [--predicted <id1,id2>]",
			"            [--accepted true|false] [--round <N>] [--replay | --replay-json <file>]",
			"            [--baseline <file>] [--commit <sha>] [--ledger <path>]",
			"  cases     List all replay case IDs",
			"",
		].join("\n"),
	);
}

async function cmdReplay(args: ParsedArgs): Promise<number> {
	const caseIds = splitCsv(args.flags.cases);
	const predicted = splitCsv(args.flags.predicted);
	const baseline = args.flags.baseline ? await readReplayReport(args.flags.baseline) : undefined;
	const report = await runSimReplay({
		caseIds: caseIds.length > 0 ? caseIds : undefined,
		predicted: predicted.length > 0 ? predicted : undefined,
		baseline,
	});

	if (args.flags.save) {
		await Bun.write(args.flags.save, `${JSON.stringify(report, null, "\t")}\n`);
	}

	if (args.booleans.has("json") || args.flags.json === "true") {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else {
		for (const item of report.results) {
			const status = item.passed ? "PASS" : "FAIL";
			process.stdout.write(`[${status}] ${item.id} (${item.category}, ${item.durationMs}ms)\n`);
			if (!item.passed && item.error) {
				process.stdout.write(`       ${item.error}\n`);
			}
		}
		process.stdout.write(`\nReplay: ${report.passed}/${report.total} passed\n`);
		if (report.diff) {
			process.stdout.write(
				`Predicted: ${report.diff.predicted.length} | Fixed: ${report.diff.fixed.length} | Missed: ${report.diff.missed.length}\n`,
			);
			if (report.diff.regressed.length > 0) {
				process.stdout.write(`Regressed: ${report.diff.regressed.join(", ")}\n`);
			}
		}
	}

	return report.failed_ids.length === 0 ? 0 : 1;
}

async function cmdValidate(args: ParsedArgs): Promise<number> {
	const ledgerPath = path.resolve(args.flags.ledger ?? DEFAULT_LEDGER_PATH);
	const file = Bun.file(ledgerPath);
	if (!(await file.exists())) {
		process.stderr.write(`SIM ledger not found: ${ledgerPath}\n`);
		return 1;
	}
	const parsed: unknown = await file.json();
	const result = validateSimLedger(parsed);
	if (!result.ok) {
		process.stderr.write(`SIM validation failed (${ledgerPath}):\n`);
		for (const err of result.errors) {
			process.stderr.write(`- ${err}\n`);
		}
		return 1;
	}
	const ledger = parsed as SimLedger;
	const attempts = ledger.problems.reduce((sum, p) => sum + p.attempts.length, 0);
	process.stdout.write(
		`SIM ledger valid: ${ledger.problems.length} problems, ${attempts} attempts, ${Object.keys(ledger.aliases).length} aliases (${ledgerPath})\n`,
	);
	return 0;
}

async function cmdStatus(args: ParsedArgs): Promise<number> {
	const ledgerPath = path.resolve(args.flags.ledger ?? DEFAULT_LEDGER_PATH);
	const ledger = await readLedger(ledgerPath);
	const summary = ledger.problems.map(problem => {
		const latest = problem.attempts.at(-1);
		const models = [...new Set(problem.attempts.map(a => a.model))];
		const domains = [...new Set(problem.attempts.map(a => a.domain))];
		return {
			id: problem.id,
			name: problem.name,
			opened_round: problem.opened_round,
			attempts: problem.attempts.length,
			models,
			domains,
			latest_score: latest ? `${latest.passed}/${latest.total}` : "0/0",
			latest_missed: latest?.missed ?? [],
		};
	});

	if (args.booleans.has("json")) {
		process.stdout.write(
			`${JSON.stringify({ next_id: ledger.next_id, aliases: ledger.aliases, problems: summary }, null, 2)}\n`,
		);
		return 0;
	}

	process.stdout.write(`SIM Ledger (${ledgerPath}) — next_id=${ledger.next_id}\n`);
	for (const row of summary) {
		const missedNote = row.latest_missed.length > 0 ? ` | missed: ${row.latest_missed.join(", ")}` : "";
		process.stdout.write(
			`- ${row.id} (r${row.opened_round}, ${row.attempts}x, ${row.latest_score}): ${row.name} [${row.models.join(", ")} | ${row.domains.join(", ")}]${missedNote}\n`,
		);
	}
	return 0;
}

async function cmdMerge(args: ParsedArgs): Promise<number> {
	const ledgerPath = path.resolve(args.flags.ledger ?? DEFAULT_LEDGER_PATH);
	const file = Bun.file(ledgerPath);
	if (!(await file.exists())) {
		process.stderr.write(`SIM ledger not found: ${ledgerPath}\n`);
		return 1;
	}
	const raw = (await file.json()) as SimLedger;
	const { ledger, merged } = mergeDuplicateProblems(raw);
	const check = validateSimLedger(ledger);
	if (!check.ok) {
		process.stderr.write(`Merged ledger failed validation:\n- ${check.errors.join("\n- ")}\n`);
		return 1;
	}
	await writeLedger(ledgerPath, ledger);
	if (merged.length === 0) {
		process.stdout.write("No duplicate root-cause entries found.\n");
	} else {
		for (const [fromId, toId] of merged) {
			process.stdout.write(`Merged ${fromId} -> ${toId}\n`);
		}
	}
	return 0;
}

async function cmdRecord(args: ParsedArgs): Promise<number> {
	const ledgerPath = path.resolve(args.flags.ledger ?? DEFAULT_LEDGER_PATH);
	const ledger = await readLedger(ledgerPath, true);

	const what = args.flags.what;
	const files = splitCsv(args.flags.files);
	const model = args.flags.model;
	const domain = args.flags.domain;
	const predicted = splitCsv(args.flags.predicted);

	if (!what || files.length === 0 || !model || !domain) {
		process.stderr.write("Missing required flags: --what, --files, --model, --domain\n");
		return 1;
	}

	const accepted = args.booleans.has("accepted") ? true : parseBooleanFlag(args.flags.accepted, true);
	const round = args.flags.round ? Number.parseInt(args.flags.round, 10) : undefined;
	if (round !== undefined && (!Number.isInteger(round) || round < 1)) {
		process.stderr.write(`Invalid --round value: "${args.flags.round}"\n`);
		return 1;
	}

	let report: SimReplayReport;
	if (args.flags["replay-json"]) {
		report = await readReplayReport(args.flags["replay-json"]);
	} else {
		// Default to running the fast local replay harness so every recorded attempt
		// is backed by observed execution evidence.
		const baseline = args.flags.baseline ? await readReplayReport(args.flags.baseline) : undefined;
		report = await runSimReplay({ predicted, baseline });
	}

	const diff = evaluateReplayDiff(report, predicted);
	const appended = appendSimAttempt(ledger, {
		problemId: args.flags.problem,
		name: args.flags.name,
		round,
		accepted,
		what,
		files,
		model,
		domain,
		predicted: diff.predicted,
		fixed: diff.fixed,
		missed: diff.missed,
		passed: report.passed,
		total: report.total,
		commit: args.flags.commit,
		timestamp: new Date().toISOString(),
	});

	await writeLedger(ledgerPath, appended.ledger);

	const action = appended.createdProblem ? "Opened" : "Appended to";
	const aliasNote = appended.mergedFromAlias ? ` (via alias ${appended.mergedFromAlias})` : "";
	process.stdout.write(
		`${action} ${appended.problemId}${aliasNote}: ${report.passed}/${report.total} passed | fixed=[${diff.fixed.join(", ")}] | missed=[${diff.missed.join(", ")}]\n`,
	);
	return 0;
}

export async function runSimCli(argv: readonly string[]): Promise<number> {
	const args = parseCliArgs(argv);
	try {
		switch (args.command) {
			case "replay":
				return await cmdReplay(args);
			case "validate":
				return await cmdValidate(args);
			case "status":
				return await cmdStatus(args);
			case "merge":
				return await cmdMerge(args);
			case "record":
				return await cmdRecord(args);
			case "cases":
				for (const c of SIM_REPLAY_CASES) {
					process.stdout.write(`${c.id}\t[${c.category}]\t${c.description}\n`);
				}
				return 0;
			default:
				printHelp();
				return args.command === "help" || args.command === "--help" || args.command === "-h" ? 0 : 1;
		}
	} catch (error) {
		process.stderr.write(`SIM CLI error: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

if (import.meta.main) {
	const exitCode = await runSimCli(process.argv.slice(2));
	process.exit(exitCode);
}
