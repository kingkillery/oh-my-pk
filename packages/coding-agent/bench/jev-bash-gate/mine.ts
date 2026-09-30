// Sample real bash commands from local session transcripts into mined.jsonl for
// hand-labeling (fill "label" with allow|block; "suggested" is only a regex hint).
// Usage: bun bench/jev-bash-gate/mine.ts [count=150]
// mined.jsonl is gitignored: transcripts can contain private paths and secrets.
import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionsDir } from "@pk-nerdsaver-ai/pi-utils";

const COUNT = Number(process.argv[2] ?? 150);
const RISKY =
	/rm\s+-\w*[rf]|--force|-f\s+origin|reset --hard|clean -\w*f|curl[^|]*\|\s*(ba)?sh|Remove-Item|del\s+\/|taskkill|format\s+\w:|mkfs|dd\s+if=|DROP\s|\.ssh|\.aws|API_KEY|\.env\b/i;

function* jsonlFiles(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* jsonlFiles(full);
		else if (entry.name.endsWith(".jsonl")) yield full;
	}
}

const seen = new Map<string, string>();
for (const file of jsonlFiles(getSessionsDir())) {
	for (const line of (await Bun.file(file).text()).split("\n")) {
		if (!line.includes('"name":"bash"')) continue;
		try {
			const content = JSON.parse(line)?.message?.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				const cmd = block?.type === "toolCall" && block.name === "bash" ? block.arguments?.command : undefined;
				if (typeof cmd === "string" && cmd.trim()) seen.set(cmd.slice(0, 1500), block.arguments?.cwd ?? "");
			}
		} catch {}
	}
}

const all = [...seen];
for (let i = all.length - 1; i > 0; i--) {
	const j = Math.floor(Math.random() * (i + 1));
	[all[i], all[j]] = [all[j], all[i]];
}
// Oversample risky commands: a random draw is almost all benign and says nothing about recall.
const risky = all.filter(([c]) => RISKY.test(c));
const rest = all.filter(([c]) => !RISKY.test(c));
const picked = [...risky.slice(0, Math.ceil(COUNT / 3)), ...rest].slice(0, COUNT);
const rows = picked.map(([command, cwd]) => ({
	command,
	cwd,
	label: "",
	suggested: RISKY.test(command) ? "block?" : "allow",
}));
await Bun.write(path.join(import.meta.dir, "mined.jsonl"), `${rows.map(r => JSON.stringify(r)).join("\n")}\n`);
process.stdout.write(`unique commands: ${all.length}, risky: ${risky.length}, wrote ${rows.length} to mined.jsonl\n`);
