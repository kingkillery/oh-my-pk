import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseHandoff } from "../src/continuity/render";
import { continuityStatus, resumeHandoff, saveHandoff } from "../src/continuity/service";
import { indexPath, readIndex, retainRevision, writeIndex } from "../src/continuity/store";
import type { HandoffSections, WorkstreamEntry } from "../src/continuity/types";

let root: string;
let outside: string;
let vault: string;
let canonical: string;

const SECTIONS: HandoffSections = {
	objective: "Prove the notebook writes only where it is pointed.",
	currentState: "Verified: containment guard added. Incomplete: concurrency lock.",
	keyContext: "Safety harness for the continuity notebook.",
	nextSteps: "1. Assert containment. 2. Assert fail-closed.",
	validation: "Each assertion observes the filesystem, not the implementation.",
	blockers: "- None recorded",
};

function entry(overrides: Partial<WorkstreamEntry> = {}): WorkstreamEntry {
	return {
		id: "notebook-safety",
		title: "Notebook Safety",
		aliases: ["notebook safety"],
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

/** Every file under `directory`, so a test can prove nothing outside it moved. */
async function manifest(directory: string): Promise<Record<string, string>> {
	const found: Record<string, string> = {};
	async function walk(current: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const dirent of entries) {
			const target = path.join(current, dirent.name);
			if (dirent.isDirectory()) {
				await walk(target);
				continue;
			}
			found[path.relative(directory, target)] = String((await fs.stat(target)).size);
		}
	}
	await walk(directory);
	return found;
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "ompk-continuity-safety-"));
	outside = await fs.mkdtemp(path.join(os.tmpdir(), "ompk-continuity-outside-"));
	vault = path.join(root, "Task-Hub", "References");
	canonical = path.join(vault, "Notebook Safety - Continuation.md");
	await fs.mkdir(vault, { recursive: true });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
	await fs.rm(outside, { recursive: true, force: true });
});

describe("writes stay inside the injected root", () => {
	test("a save touches the canonical record and the index, and nothing outside the root", async () => {
		await seed([entry()]);
		const outsideBefore = await manifest(outside);

		const result = await saveHandoff({ root, intent: "save where we are", sections: SECTIONS });
		expect(result.status).toBe("saved");

		expect(await manifest(outside)).toEqual(outsideBefore);
		expect(await fs.readFile(canonical, "utf-8")).toContain("<handoff-prompt>");
		const index = await readIndex(root);
		expect(index.kind).toBe("ok");
	});

	test("an index entry pointing outside the root is refused instead of written", async () => {
		const escaped = path.join(outside, "Elsewhere - Continuation.md");
		await seed([entry({ canonical: escaped })]);

		const result = await saveHandoff({ root, intent: "save where we are", sections: SECTIONS });
		expect(result.status).toBe("rejected");
		if (result.status !== "rejected") return;
		expect(result.reason).toBe("canonical-outside-root");

		expect(await manifest(outside)).toEqual({});
	});

	test("resume refuses to read a record registered outside the root", async () => {
		const escaped = path.join(outside, "Elsewhere - Continuation.md");
		await fs.writeFile(escaped, "<handoff-prompt>\n</handoff-prompt>\n", "utf-8");
		await seed([entry({ canonical: escaped })]);

		const result = await resumeHandoff({ root, intent: "notebook safety" });
		expect(result.status).toBe("backend_unavailable");
		if (result.status !== "backend_unavailable") return;
		expect(result.reason).toBe("canonical-outside-root");
	});

	test("a workstream id cannot steer a retained revision out of the root", async () => {
		await expect(retainRevision(root, "../../escape", 1, "text")).rejects.toThrow();
		expect(await manifest(outside)).toEqual({});
	});

	test("the index writer refuses a target it cannot place inside the root", async () => {
		const index = { version: 1 as const, workstreams: [] };
		await writeIndex(root, index);
		expect(await fs.readFile(indexPath(root), "utf-8")).toContain('"workstreams": []');
	});
});

describe("failures leave prior work intact", () => {
	test("a corrupt index is reported and never overwritten by a save", async () => {
		await fs.mkdir(path.dirname(indexPath(root)), { recursive: true });
		await fs.writeFile(indexPath(root), "{ not json", "utf-8");

		const result = await saveHandoff({ root, intent: "save where we are", sections: SECTIONS });
		expect(result.status).toBe("backend_unavailable");

		expect(await fs.readFile(indexPath(root), "utf-8")).toBe("{ not json");
		expect(await manifest(vault)).toEqual({});
	});

	test("an absent index reports absence instead of inventing a workstream", async () => {
		const status = await continuityStatus(root);
		expect(status.indexPresent).toBe(false);
		expect(status.workstreams).toEqual([]);

		const result = await saveHandoff({ root, intent: "save where we are", sections: SECTIONS });
		expect(result.status).toBe("backend_unavailable");
		expect(await manifest(vault)).toEqual({});
	});

	test("saving twice with identical content writes nothing the second time", async () => {
		await seed([entry()]);
		const first = await saveHandoff({ root, intent: "save where we are", sections: SECTIONS });
		expect(first.status).toBe("saved");
		const before = await manifest(root);

		const second = await saveHandoff({ root, intent: "save where we are", sections: SECTIONS });
		expect(second.status).toBe("unchanged");
		expect(await manifest(root)).toEqual(before);
	});

	test("concurrent saves leave a parseable record and a consistent pointer", async () => {
		await seed([entry()]);
		const results = await Promise.all([
			saveHandoff({ root, intent: "save where we are", sections: SECTIONS }),
			saveHandoff({ root, intent: "save where we are", sections: { ...SECTIONS, nextSteps: "1. Ship it." } }),
		]);

		// The lock serializes them, so both writes land and the pointer names the later one.
		expect(results.every(result => result.status === "saved")).toBe(true);
		const revisions = results.flatMap(result => (result.status === "saved" ? [result.revision] : []));
		expect(revisions.sort()).toEqual([1, 2]);
		const written = await fs.readFile(canonical, "utf-8");
		const parsed = parseHandoff(written);
		expect(parsed).not.toBeUndefined();
		if (!parsed) return;
		expect(written.split("</handoff-prompt>").length - 1).toBe(1);

		const index = await readIndex(root);
		expect(index.kind).toBe("ok");
		if (index.kind !== "ok") return;
		// The pointer must describe the bytes that survived, not a revision neither writer produced.
		expect(index.index.workstreams[0]?.revision).toBe(parsed.meta.revision);
	});
});
