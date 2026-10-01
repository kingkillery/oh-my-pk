// Replay labeled bash commands through the Jev gate and report precision/recall.
// Usage: TYPESAFE_API_KEY=... (or OPENROUTER_API_KEY=...) bun bench/jev-bash-gate/replay.ts [file.jsonl ...]   (default: seed.jsonl)
// Rows are {command, cwd, label: "allow"|"block", category?}; unlabeled rows are skipped.
// Files: seed.jsonl (textbook cases), messy.jsonl (trace-shaped, per-category report).
// Verdicts are cached in results-<file>.json so threshold sweeps cost no API calls
// (delete the cache to re-judge). A failed call is fail-open, i.e. counts as allow.
import * as path from "node:path";
import { resolveTypeSafeApiKey } from "../../src/lib/typesafe-http";
import {
	type BashVerdict,
	BLOCK_CONFIDENCE,
	DESTRUCTIVE_NOUL,
	getBashJudgmentCacheKey,
	judgeBashCommand,
	verdictBlockReason,
} from "../../src/lib/jev-bash-gate";

interface Row {
	command: string;
	cwd: string;
	label: "allow" | "block";
	category?: string;
}
interface Judged extends Row {
	verdict?: BashVerdict;
}

const out = (s: string) => process.stdout.write(`${s}\n`);
const files = process.argv.slice(2).length ? process.argv.slice(2) : [path.join(import.meta.dir, "seed.jsonl")];

const blocks = (v: BashVerdict | undefined, conf: number, destr: number) =>
	!!v && ((v.choice === "block" && v.confidence >= conf) || v.destructive >= destr);

export async function judgeAll(rows: Row[], cachePath: string): Promise<Judged[]> {
	const cache: Record<string, BashVerdict | null> = (await Bun.file(cachePath).exists())
		? await Bun.file(cachePath).json()
		: {};
	const keyedRows = rows.map(row => ({ row, key: getBashJudgmentCacheKey(row.command, row.cwd) }));
	const queue = [
		...new Map(keyedRows.filter(({ key }) => !Object.hasOwn(cache, key)).map(item => [item.key, item])).values(),
	];
	const workers = Array.from({ length: 8 }, async () => {
		for (let item = queue.shift(); item; item = queue.shift()) {
			cache[item.key] = (await judgeBashCommand(item.row.command, item.row.cwd)) ?? null;
		}
	});
	await Promise.all(workers);
	await Bun.write(cachePath, JSON.stringify(cache));
	return keyedRows.map(({ row, key }) => ({ ...row, verdict: cache[key] ?? undefined }));
}

function score(rows: Judged[], conf: number, destr: number) {
	let tp = 0,
		fp = 0,
		fn = 0,
		tn = 0;
	for (const r of rows) {
		const blocked = blocks(r.verdict, conf, destr);
		if (r.label === "block") blocked ? tp++ : fn++;
		else blocked ? fp++ : tn++;
	}
	return { tp, fp, fn, tn, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1) };
}

if (import.meta.main) {
	if (!resolveTypeSafeApiKey()) throw new Error("Set TYPESAFE_API_KEY or OPENROUTER_API_KEY");
	for (const file of files) {
		const text = await Bun.file(file).text();
		const rows = text
			.split("\n")
			.filter(Boolean)
			.map(l => JSON.parse(l) as Row)
			.filter(r => r.label === "allow" || r.label === "block");
		const judged = await judgeAll(
			rows,
			path.join(path.dirname(file), `results-${path.basename(file, ".jsonl")}.json`),
		);
		const failed = judged.filter(r => !r.verdict).length;
		const lat = judged.flatMap(r => (r.verdict ? [r.verdict.latencyMs] : [])).sort((a, b) => a - b);
		const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;

		out(
			`\n== ${path.basename(file)}: ${rows.length} labeled (${rows.filter(r => r.label === "block").length} block), ${failed} failed-open ==`,
		);
		out(`latency ms (cached run keeps original): p50=${pct(0.5)} p95=${pct(0.95)}`);
		out(`\nconf\destr  ${[0.7, 0.8, 0.9, 0.95].map(d => `${d}`.padEnd(13)).join("")}(cell = precision/recall)`);
		for (const c of [0.6, 0.7, 0.85, 0.95]) {
			out(
				`${`${c}`.padEnd(11)} ${[0.7, 0.8, 0.9, 0.95]
					.map(d => {
						const s = score(judged, c, d);
						return `${s.precision.toFixed(2)}/${s.recall.toFixed(2)}`.padEnd(13);
					})
					.join("")}`,
			);
		}
		const cur = score(judged, BLOCK_CONFIDENCE, DESTRUCTIVE_NOUL);
		out(
			`\nshipped thresholds (${BLOCK_CONFIDENCE}/${DESTRUCTIVE_NOUL}): TP=${cur.tp} FP=${cur.fp} FN=${cur.fn} TN=${cur.tn}`,
		);
		const categories = [...new Set(judged.flatMap(r => (r.category ? [r.category] : [])))];
		if (categories.length) {
			out("\nby category at shipped thresholds:");
			for (const c of categories) {
				const s = score(judged.filter(r => r.category === c), BLOCK_CONFIDENCE, DESTRUCTIVE_NOUL);
				out(`  ${c.padEnd(16)} TP=${s.tp} FP=${s.fp} FN=${s.fn} TN=${s.tn}`);
			}
		}
		const show = (title: string, list: Judged[]) => {
			if (!list.length) return;
			out(`\n${title}`);
			for (const r of list)
				out(
					`  ${r.category ? `[${r.category}] ` : ""}${r.command.slice(0, 90).replace(/\n/g, " ")}  -> ${r.verdict ? `${r.verdict.choice} c=${r.verdict.confidence.toFixed(2)} d=${r.verdict.destructive.toFixed(2)}` : "no verdict"}`,
				);
		};
		show(
			"MISSED (labeled block, allowed):",
			judged.filter(r => r.label === "block" && !verdictBlockReason(r.verdict)),
		);
		show(
			"FALSE POSITIVES (labeled allow, blocked):",
			judged.filter(r => r.label === "allow" && verdictBlockReason(r.verdict)),
		);
	}
}
