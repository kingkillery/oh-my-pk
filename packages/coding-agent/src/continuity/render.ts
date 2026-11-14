import { createHash } from "node:crypto";
import {
	HANDOFF_CLOSE,
	HANDOFF_OPEN,
	HANDOFF_SECTIONS,
	type HandoffAuthority,
	type HandoffMeta,
	type HandoffSections,
	type ParsedHandoff,
} from "./types";

const AUTHORITIES: readonly HandoffAuthority[] = ["canonical", "snapshot", "historical"];

/** Collapse incidental whitespace so repeated renders are byte-identical. */
export function normalizeBlock(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map(line => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function contentSignature(meta: HandoffMeta, sections: HandoffSections): string {
	const material = JSON.stringify({
		workstream: meta.workstream,
		title: meta.title,
		authority: meta.authority,
		evidenceObserved: meta.evidenceObserved ?? null,
		sourceSessions: meta.sourceSessions ?? [],
		sections: HANDOFF_SECTIONS.map(([key]) => [key, normalizeBlock(sections[key])]),
	});
	return createHash("sha256").update(material, "utf-8").digest("hex");
}

function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (!(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2)) return trimmed;
	return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/**
 * Render the canonical document: vault-required metadata lives in frontmatter,
 * outside the tagged body, so the prompt body stays portable across harnesses.
 */
export function renderHandoff(meta: HandoffMeta, sections: HandoffSections): string {
	const lines = [
		"---",
		`workstream: ${meta.workstream}`,
		`title: ${quote(meta.title)}`,
		`authority: ${meta.authority}`,
		`revision: ${meta.revision}`,
		`updated: ${meta.updated}`,
	];
	if (meta.evidenceObserved) lines.push(`evidence_observed: ${meta.evidenceObserved}`);
	if (meta.canonicalSource) lines.push(`canonical_source: ${quote(meta.canonicalSource)}`);
	if (meta.sourceSessions?.length) {
		lines.push("source_sessions:");
		for (const session of meta.sourceSessions) lines.push(`  - ${session}`);
	}
	lines.push("---", "", HANDOFF_OPEN, "");
	for (const [key, heading] of HANDOFF_SECTIONS) {
		lines.push(`## ${heading}`, "", normalizeBlock(sections[key]) || "_Not recorded._", "");
	}
	lines.push(HANDOFF_CLOSE, "");
	return lines.join("\n");
}

function parseFrontmatter(lines: string[]): { meta: Partial<HandoffMeta>; end: number } | undefined {
	if (lines[0]?.trim() !== "---") return undefined;
	const meta: Partial<HandoffMeta> = {};
	let sourceSessions: string[] | undefined;
	let end = -1;
	for (let index = 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim() === "---") {
			end = index;
			break;
		}
		const listItem = /^\s+-\s*(.+)$/.exec(line);
		if (listItem) {
			sourceSessions ??= [];
			sourceSessions.push(listItem[1]!.trim());
			continue;
		}
		const pair = /^([a-z_]+):\s*(.*)$/.exec(line);
		if (!pair) continue;
		const [, rawKey, rawValue] = pair;
		switch (rawKey) {
			case "workstream":
				meta.workstream = unquote(rawValue ?? "");
				break;
			case "title":
				meta.title = unquote(rawValue ?? "");
				break;
			case "authority": {
				const value = (rawValue ?? "").trim() as HandoffAuthority;
				if (AUTHORITIES.includes(value)) meta.authority = value;
				break;
			}
			case "revision": {
				const value = Number.parseInt((rawValue ?? "").trim(), 10);
				if (Number.isFinite(value)) meta.revision = value;
				break;
			}
			case "updated":
				meta.updated = (rawValue ?? "").trim();
				break;
			case "evidence_observed":
				meta.evidenceObserved = (rawValue ?? "").trim();
				break;
			case "canonical_source":
				meta.canonicalSource = unquote(rawValue ?? "");
				break;
			default:
				break;
		}
	}
	if (end < 0) return undefined;
	if (sourceSessions?.length) meta.sourceSessions = sourceSessions;
	return { meta, end };
}

/**
 * Parse a previously rendered handoff. Returns `undefined` when the document is
 * not a well-formed tagged handoff, so callers report an accurate failure
 * instead of treating arbitrary prose as a resumable record.
 */
export function parseHandoff(text: string): ParsedHandoff | undefined {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const frontmatter = parseFrontmatter(lines);
	if (!frontmatter) return undefined;
	const { meta, end } = frontmatter;
	const openIndex = lines.findIndex((line, index) => index > end && line.trim() === HANDOFF_OPEN);
	const closeIndex = lines.findIndex((line, index) => index > openIndex && line.trim() === HANDOFF_CLOSE);
	if (openIndex < 0 || closeIndex < 0) return undefined;

	const sections: HandoffSections = {
		objective: "",
		currentState: "",
		keyContext: "",
		nextSteps: "",
		validation: "",
		blockers: "",
	};
	let current: keyof HandoffSections | undefined;
	const buckets: Record<string, string[]> = {};
	for (const line of lines.slice(openIndex + 1, closeIndex)) {
		const heading = /^##\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const match = HANDOFF_SECTIONS.find(([, label]) => label.toLowerCase() === heading[1]!.toLowerCase());
			current = match?.[0];
			if (current) buckets[current] = [];
			continue;
		}
		if (current) buckets[current]!.push(line);
	}
	for (const [key] of HANDOFF_SECTIONS) {
		const value = normalizeBlock((buckets[key] ?? []).join("\n"));
		sections[key] = value === "_Not recorded._" ? "" : value;
	}

	const body = lines
		.slice(openIndex, closeIndex + 1)
		.join("\n")
		.trim();
	return {
		meta: {
			workstream: meta.workstream ?? "",
			title: meta.title ?? meta.workstream ?? "",
			authority: meta.authority ?? "canonical",
			revision: meta.revision ?? 0,
			updated: meta.updated ?? "",
			...(meta.evidenceObserved ? { evidenceObserved: meta.evidenceObserved } : {}),
			...(meta.sourceSessions ? { sourceSessions: meta.sourceSessions } : {}),
			...(meta.canonicalSource ? { canonicalSource: meta.canonicalSource } : {}),
		},
		sections,
		body,
	};
}

/** Bullet lines in Blockers are the recorded open questions. */
export function openQuestions(sections: HandoffSections): string[] {
	return normalizeBlock(sections.blockers)
		.split("\n")
		.map(line => /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line)?.[1]?.trim())
		.filter((value): value is string => Boolean(value));
}
