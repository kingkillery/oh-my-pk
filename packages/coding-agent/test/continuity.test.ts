import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseHandoff, renderHandoff } from "../src/continuity/render";
import {
	continuityStatus,
	exportHandoff,
	matchWorkstream,
	resumeHandoff,
	saveHandoff,
} from "../src/continuity/service";
import { indexPath, readIndex } from "../src/continuity/store";
import type { HandoffSections, WorkstreamEntry } from "../src/continuity/types";

let root: string;
let vault: string;
let canonical: string;

const SECTIONS: HandoffSections = {
	objective: "Keep the missed-appointment review traceable without replaying it.",
	currentState: "Verified: brief compiled. Incomplete: no dispatcher confirmation.",
	keyContext: "Operational record: References/Tonia Missed Appointment Review - Continuation.md",
	nextSteps: "1. Confirm dispatcher notes. 2. Publish the weekly brief.",
	validation: "Checked source counts against the export of 2026-11-13.",
	blockers: "- Dispatcher confirmation still outstanding\n- Owner for the follow-up call undecided",
};

function entry(overrides: Partial<WorkstreamEntry> = {}): WorkstreamEntry {
	return {
		id: "tonia-missed-appointment-review",
		title: "Tonia Missed Appointment Review",
		aliases: ["Tonia review", "missed appointment review"],
		canonical,
		authority: "canonical",
		revision: 0,
		updatedAt: "",
		...overrides,
	};
}

async function seed(entries: WorkstreamEntry[]): Promise<void> {
	await fs.mkdir(path.dirname(indexPath(root)), { recursive: true });
	await fs.writeFile(indexPath(root), `${JSON.stringify({ version: 1, workstreams: entries }, null, 2)}\n`, "utf-8");
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "ompk-continuity-"));
	vault = path.join(root, "Task-Hub", "References");
	canonical = path.join(vault, "Tonia Missed Appointment Review - Continuation.md");
	await fs.mkdir(vault, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("explicit save", () => {
	test("saves a tagged six-section handoff from a bare 'where we are' request", async () => {
		await seed([entry()]);
		const result = await saveHandoff({ root, intent: "save where we are", sections: SECTIONS });
		expect(result.status).toBe("saved");
		if (result.status !== "saved") return;
		expect(result.path).toBe(canonical);
		expect(result.revision).toBe(1);
		expect(result.pointerUpdated).toBe(true);

		const written = await fs.readFile(canonical, "utf-8");
		expect(written).toContain("<handoff-prompt>");
		expect(written).toContain("</handoff-prompt>");
		for (const heading of ["Objective", "Current State", "Key Context", "Next Steps", "Validation", "Blockers"]) {
			expect(written).toContain(`## ${heading}`);
		}
		const parsed = parseHandoff(written);
		expect(parsed?.meta.authority).toBe("canonical");
		expect(parsed?.sections.objective).toContain("missed-appointment review");
	});

	test("rejects a handoff with empty sections instead of writing placeholders", async () => {
		await seed([entry()]);
		const result = await saveHandoff({ root, intent: "Tonia review", sections: { ...SECTIONS, blockers: "  " } });
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") return;
		expect(result.reason).toBe("incomplete-sections");
		await expect(fs.readFile(canonical, "utf-8")).rejects.toBeDefined();
	});
});

describe("explicit resume", () => {
	test("locates the canonical record and its unresolved questions from a natural phrase", async () => {
		await seed([entry()]);
		await saveHandoff({ root, intent: "Tonia review", sections: SECTIONS, evidenceObservedAt: "2026-11-13" });

		const resumed = await resumeHandoff({
			root,
			intent: "Continue the Tonia Missed appointment review",
			now: new Date("2026-11-14T00:00:00Z"),
		});
		expect(resumed.status).toBe("resumed");
		if (resumed.status !== "resumed") return;
		expect(resumed.workstream).toBe("tonia-missed-appointment-review");
		expect(resumed.path).toBe(canonical);
		expect(resumed.handoff.startsWith("<handoff-prompt>")).toBe(true);
		expect(resumed.handoff.endsWith("</handoff-prompt>")).toBe(true);
		expect(resumed.openQuestions).toEqual([
			"Dispatcher confirmation still outstanding",
			"Owner for the follow-up call undecided",
		]);
		expect(resumed.stale).toBe(false);
	});

	test("keeps evidence dates and prompts bounded verification for a stale record", async () => {
		await seed([entry()]);
		await saveHandoff({ root, intent: "Tonia review", sections: SECTIONS, evidenceObservedAt: "2025-01-05" });

		const resumed = await resumeHandoff({ root, intent: "Tonia review", now: new Date("2026-11-14T00:00:00Z") });
		expect(resumed.status).toBe("resumed");
		if (resumed.status !== "resumed") return;
		expect(resumed.stale).toBe(true);
		expect(resumed.evidenceObservedAt).toBe("2025-01-05");
		expect(resumed.verificationPrompt).toContain("2025-01-05");
		expect(resumed.verificationPrompt).toContain("Re-check only the time-sensitive claims");
		expect(await fs.readFile(canonical, "utf-8")).toContain("evidence_observed: 2025-01-05");
	});
});

describe("revision safety", () => {
	test("repeated identical saves are idempotent and changed milestones reuse the workstream", async () => {
		await seed([entry()]);
		const first = await saveHandoff({ root, intent: "Tonia review", sections: SECTIONS });
		expect(first.status).toBe("saved");

		const before = await fs.readFile(canonical, "utf-8");
		const repeat = await saveHandoff({ root, intent: "Tonia review", sections: SECTIONS });
		expect(repeat.status).toBe("unchanged");
		if (repeat.status !== "unchanged") return;
		expect(repeat.revision).toBe(1);
		expect(await fs.readFile(canonical, "utf-8")).toBe(before);

		const changed = await saveHandoff({
			root,
			intent: "Tonia review",
			sections: { ...SECTIONS, nextSteps: "1. Confirm dispatcher notes. 2. Publish. 3. Close the loop with Tonia." },
		});
		expect(changed.status).toBe("saved");
		if (changed.status !== "saved") return;
		expect(changed.revision).toBe(2);
		expect(changed.path).toBe(canonical);
		expect(changed.priorRevision).toBe(1);
	});

	test("refuses to overwrite a newer revision written by another writer", async () => {
		await seed([entry()]);
		await saveHandoff({ root, intent: "Tonia review", sections: SECTIONS });
		const observed = await resumeHandoff({ root, intent: "Tonia review" });
		expect(observed.status).toBe("resumed");
		if (observed.status !== "resumed") return;

		await saveHandoff({
			root,
			intent: "Tonia review",
			sections: { ...SECTIONS, keyContext: "Newer note from another session." },
		});
		const newer = await fs.readFile(canonical, "utf-8");

		const stale = await saveHandoff({
			root,
			intent: "Tonia review",
			sections: { ...SECTIONS, keyContext: "Late write from a stale reader." },
			expectedRevision: observed.revision,
		});
		expect(stale.status).toBe("stale");
		if (stale.status !== "stale") return;
		expect(stale.actualRevision).toBe(2);
		expect(await fs.readFile(canonical, "utf-8")).toBe(newer);
	});

	test("keeps the prior revision so a guard never destroys earlier work", async () => {
		await seed([entry()]);
		await saveHandoff({ root, intent: "Tonia review", sections: SECTIONS });
		await saveHandoff({
			root,
			intent: "Tonia review",
			sections: { ...SECTIONS, validation: "Re-verified 2026-11-14." },
		});
		const retained = await fs.readFile(
			path.join(root, ".agents", "continuity", "revisions", "tonia-missed-appointment-review", "r1.md"),
			"utf-8",
		);
		expect(retained).toContain("Checked source counts against the export of 2026-11-13.");
	});
});

describe("identity and routing", () => {
	test("ambiguous names ask for clarification and write nothing", async () => {
		const westCanonical = path.join(vault, "Tonia Missed Appointment Review - West.md");
		await seed([
			entry(),
			entry({
				id: "tonia-missed-appointment-review-west",
				title: "Tonia Missed Appointment Review - West",
				canonical: westCanonical,
			}),
		]);
		const result = await saveHandoff({ root, intent: "Tonia missed appointment review", sections: SECTIONS });
		expect(result.status).toBe("needs_clarification");
		if (result.status !== "needs_clarification") return;
		expect(result.candidates.map(candidate => candidate.id).sort()).toEqual([
			"tonia-missed-appointment-review",
			"tonia-missed-appointment-review-west",
		]);
		await expect(fs.readFile(canonical, "utf-8")).rejects.toBeDefined();
		await expect(fs.readFile(westCanonical, "utf-8")).rejects.toBeDefined();
	});

	test("an unknown workstream is not_found while an unreadable index is backend_unavailable", async () => {
		const absent = await resumeHandoff({ root, intent: "Continue the Tonia Missed appointment review" });
		expect(absent.status).toBe("backend_unavailable");
		if (absent.status === "backend_unavailable") expect(absent.reason).toBe("index-missing");

		await fs.mkdir(path.dirname(indexPath(root)), { recursive: true });
		await fs.writeFile(indexPath(root), "{ not json", "utf-8");
		const corrupt = await resumeHandoff({ root, intent: "Continue the Tonia review" });
		expect(corrupt.status).toBe("backend_unavailable");
		if (corrupt.status === "backend_unavailable") expect(corrupt.reason).toBe("index-corrupt");

		await seed([entry()]);
		const missingRecord = await resumeHandoff({ root, intent: "Continue the Tonia review" });
		expect(missingRecord.status).toBe("missing");

		const unknown = await resumeHandoff({ root, intent: "Continue the quarterly pipeline audit" });
		expect(unknown.status).toBe("not_found");
	});

	test("matchWorkstream prefers an exact phrase over a shared word", () => {
		const index = {
			version: 1 as const,
			workstreams: [
				entry(),
				entry({ id: "pipeline-audit", title: "Pipeline Audit", canonical: path.join(vault, "audit.md") }),
			],
		};
		const resolved = matchWorkstream(index, "pipeline audit");
		expect(resolved.status).toBe("resolved");
		if (resolved.status === "resolved") expect(resolved.entry.id).toBe("pipeline-audit");
	});
});

describe("failure honesty", () => {
	test("a failed canonical write advances neither the pointer nor a success receipt", async () => {
		await seed([entry()]);
		await saveHandoff({ root, intent: "Tonia review", sections: SECTIONS });
		const indexBefore = await readIndex(root);

		await fs.rm(canonical, { force: true });
		await fs.mkdir(canonical, { recursive: true });
		const blocked = await saveHandoff({
			root,
			intent: "Tonia review",
			sections: { ...SECTIONS, blockers: "- Blocked on purpose" },
		});
		expect(blocked.status).toBe("write_failed");
		if (blocked.status !== "write_failed") return;
		expect(blocked.pointerUpdated).toBe(false);
		const indexAfter = await readIndex(root);
		expect(JSON.stringify(indexAfter)).toBe(JSON.stringify(indexBefore));
	});

	test("a failed retention step stops before the canonical write", async () => {
		await seed([entry()]);
		await saveHandoff({ root, intent: "Tonia review", sections: SECTIONS });
		const before = await fs.readFile(canonical, "utf-8");

		const revisionPath = path.join(
			root,
			".agents",
			"continuity",
			"revisions",
			"tonia-missed-appointment-review",
			"r1.md",
		);
		await fs.mkdir(revisionPath, { recursive: true });
		const result = await saveHandoff({
			root,
			intent: "Tonia review",
			sections: { ...SECTIONS, blockers: "- Different blocker" },
		});
		expect(result.status).toBe("write_failed");
		if (result.status !== "write_failed") return;
		expect(result.reason).toBe("retention-failed");
		expect(await fs.readFile(canonical, "utf-8")).toBe(before);
	});
});

describe("authority", () => {
	test("historical and snapshot records are never promoted to canonical", async () => {
		const snapshot = path.join(vault, "Tonia Missed Appointment Review - Agent Handoff.md");
		await seed([
			entry({
				id: "tonia-snapshot",
				title: "Tonia Agent Handoff",
				aliases: ["handoff snapshot"],
				canonical: snapshot,
				authority: "snapshot",
			}),
		]);
		const result = await saveHandoff({ root, intent: "handoff snapshot", sections: SECTIONS });
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") return;
		expect(result.reason).toBe("not-canonical-authority");
		await expect(fs.readFile(snapshot, "utf-8")).rejects.toBeDefined();
	});

	test("an export is a portable snapshot that never becomes a second authority", async () => {
		await seed([entry()]);
		await saveHandoff({ root, intent: "Tonia review", sections: SECTIONS, evidenceObservedAt: "2026-11-13" });
		const destination = path.join(root, "exports", "tonia-handoff.md");
		const exported = await exportHandoff({ root, intent: "Tonia review", destination });
		expect(exported.status).toBe("exported");
		if (exported.status !== "exported") return;

		const snapshot = await fs.readFile(destination, "utf-8");
		expect(snapshot).toContain("<handoff-prompt>");
		expect(snapshot).toContain("</handoff-prompt>");
		expect(snapshot).toContain("authority: snapshot");
		expect(snapshot).toContain(`canonical_source: "${canonical.replace(/\\/g, "\\\\")}"`);
		expect(snapshot).not.toContain("vault://");
		expect(snapshot).not.toContain("session_memory");
		for (const heading of ["Objective", "Current State", "Key Context", "Next Steps", "Validation", "Blockers"]) {
			expect(snapshot).toContain(`## ${heading}`);
		}

		const index = await readIndex(root);
		expect(index.kind).toBe("ok");
		if (index.kind !== "ok") return;
		expect(index.index.workstreams).toHaveLength(1);
		expect(index.index.workstreams[0]?.canonical).toBe(canonical);
	});
});

describe("lifecycle boundaries", () => {
	test("continuity code never switches sessions or cancels jobs", async () => {
		const directory = new URL("../src/continuity/", import.meta.url);
		const files = await fs.readdir(directory);
		const sources = await Promise.all(files.map(file => fs.readFile(new URL(file, directory), "utf-8")));
		for (const source of sources) {
			expect(source).not.toContain("session-manager");
			expect(source).not.toContain("cancelJob");
			expect(source).not.toContain("SessionStopEvent");
		}
	});

	test("rendering is deterministic across repeated calls", async () => {
		const meta = {
			workstream: "tonia-missed-appointment-review",
			title: "Tonia Missed Appointment Review",
			authority: "canonical" as const,
			revision: 3,
			updated: "2026-11-14T00:00:00.000Z",
			evidenceObserved: "2026-11-13",
		};
		const first = renderHandoff(meta, SECTIONS);
		const second = renderHandoff(meta, SECTIONS);
		expect(first).toBe(second);
		expect(parseHandoff(first)?.sections).toEqual(SECTIONS);
	});

	test("status reports an absent index without inventing workstreams", async () => {
		const status = await continuityStatus(root);
		expect(status.indexPresent).toBe(false);
		expect(status.workstreams).toHaveLength(0);
		await seed([entry()]);
		const seeded = await continuityStatus(root);
		expect(seeded.indexReadable).toBe(true);
		expect(seeded.workstreams.map(candidate => candidate.id)).toEqual(["tonia-missed-appointment-review"]);
	});
});
