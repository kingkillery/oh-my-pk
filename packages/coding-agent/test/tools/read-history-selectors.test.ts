import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls";
import { historyUrl } from "@pk-nerdsaver-ai/pi-coding-agent/internal-urls/history-url";
import { AgentRegistry, type AgentStatus } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-entries";
import { formatOutputNotice } from "@pk-nerdsaver-ai/pi-coding-agent/tools/output-meta";
import { splitInternalUrlSel } from "@pk-nerdsaver-ai/pi-coding-agent/tools/path-utils";
import { ReadTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/read";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";

describe("read history:// selectors", () => {
	let dir: string;
	let tool: ReadTool;

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-history-selectors-"));
		tool = new ReadTool({
			cwd: dir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => path.join(dir, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => dir,
			allocateOutputArtifact: async () => ({ id: "output", path: path.join(dir, "output.txt") }),
		});
	});

	afterEach(async () => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		await removeWithRetries(dir);
	});

	async function register(status: AgentStatus = "running", lineCount = 100): Promise<string> {
		const id = "Parent.Child";
		const message = {
			role: "user",
			content: Array.from({ length: lineCount }, (_, i) => `transcript entry ${i + 1}`).join("\n"),
			timestamp: 1,
		};
		const sessionFile = path.join(dir, "child.jsonl");
		await Bun.write(
			sessionFile,
			[
				{ type: "session", version: CURRENT_SESSION_VERSION, id: "fixture", timestamp: "2026-01-01", cwd: dir },
				{ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01", message },
			]
				.map(entry => JSON.stringify(entry))
				.join("\n"),
		);
		AgentRegistry.global().register({
			id,
			parentId: "Parent",
			displayName: "child",
			kind: "sub",
			status,
			session:
				status === "running" || status === "idle" ? ({ messages: [message] } as unknown as AgentSession) : null,
			sessionFile,
		});
		return `history://${id}`;
	}

	async function read(target: string) {
		const result = await tool.execute("history-read", { path: target });
		const text = result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		return { text, details: result.details };
	}

	it.each(["running", "idle", "parked", "aborted"] as const)(
		"resolves bare, raw and ranged nested %s transcripts to the same agent",
		async status => {
			const uri = await register(status);
			const resource = await InternalUrlRouter.instance().resolve(uri);
			const before = await Bun.file(path.join(dir, "child.jsonl")).text();
			expect((await read(uri)).text).toContain(`# Parent.Child (${status})`);
			const raw = await read(`${uri.toLowerCase()}:raw`);
			expect(raw.details?.displayContent?.text).toBe(resource.content);
			expect(raw.text).toContain(resource.content);
			for (const selector of ["30-32", "30+3", "L30-L32", "30..32", "raw:30-32", "30-32:RAW"]) {
				const selected = await read(`${uri}:${selector}`);
				expect(selected.details?.displayContent?.startLine).toBe(30);
				expect(selected.details?.displayContent?.text).toBe(resource.content.split("\n").slice(29, 32).join("\n"));
				expect(selected.details?.meta?.source).toEqual({ type: "internal", value: uri });
			}
			expect(await Bun.file(path.join(dir, "child.jsonl")).text()).toBe(before);
		},
	);

	it("supports multi-ranges, open-ended ranges, and beyond-EOF guidance", async () => {
		const uri = await register();
		const lines = (await InternalUrlRouter.instance().resolve(uri)).content.split("\n");
		const multi = await read(`${uri}:raw:10-12,30-32`);
		expect(multi.text).toContain(`${lines.slice(9, 12).join("\n")}\n\n…\n\n${lines.slice(29, 32).join("\n")}`);
		for (const selector of ["90", "90-", "90.."]) {
			expect((await read(`${uri}:${selector}`)).details?.displayContent?.text).toBe(lines.slice(89).join("\n"));
		}
		expect((await read(`${uri}:99999`)).text).toContain("beyond end of resource");
	});

	it("follows the continuation selector advertised by a truncated transcript", async () => {
		const uri = await register("parked", 3000);
		const first = await read(uri);
		const next = formatOutputNotice(first.details?.meta).match(/Use :(\d+) to continue/);
		expect(next).not.toBeNull();
		const continuation = await read(`${uri}:${next![1]}`);
		expect(continuation.details?.meta?.source).toEqual({ type: "internal", value: uri });
		expect(continuation.details?.displayContent?.startLine).toBe(Number(next![1]));
		expect(continuation.text).toContain("transcript entry 3000");
	});

	it("follows the continuation after a finite range", async () => {
		const uri = await register();
		const first = await read(`${uri}:10-20`);
		const next = first.text.match(/Use :(\d+) to continue/);
		expect(next?.[1]).toBe("21");
		expect((await read(`${uri}:${next![1]}`)).text).toContain("transcript entry 100");
	});

	it("applies selectors to the agent index", async () => {
		await register();
		const index = await InternalUrlRouter.instance().resolve("history://");
		expect((await read("history://:raw")).details?.displayContent?.text).toBe(index.content);
		expect((await read("history://:1-1")).details?.displayContent?.text).toBe(index.content.split("\n")[0]);
	});

	it.each([
		["0", "1-indexed"],
		["20-10", "end must be >= start"],
		["10+0", "count must be >= 1"],
		["raw:-100", "Invalid selector"],
		["raw:raw", "Invalid selector"],
	])("rejects malformed :%s with selector guidance", async (selector, error) => {
		const uri = await register();
		await expect(read(`${uri}:${selector}`)).rejects.toThrow(error);
	});

	it("keeps unknown and hidden agents inaccessible with selectors", async () => {
		await register();
		AgentRegistry.global().register({
			id: "HiddenAdvisor",
			displayName: "advisor",
			kind: "advisor",
			session: { messages: [{ role: "user", content: "private", timestamp: 1 }] } as unknown as AgentSession,
		});
		for (const selector of ["raw", "10-20", "raw:10-20"]) {
			await expect(read(`history://Missing:${selector}`)).rejects.toThrow("Unknown agent: Missing\n");
			await expect(read(`history://hiddenadvisor:${selector}`)).rejects.toThrow("Unknown agent: hiddenadvisor\n");
		}
		expect((await read("history://:raw")).text).not.toContain("HiddenAdvisor");
	});

	it("keeps system-printed history URLs readable for colon-bearing agent ids", async () => {
		AgentRegistry.global().register({
			id: "background:1",
			displayName: "background",
			kind: "sub",
			session: { messages: [{ role: "user", content: "background work", timestamp: 1 }] } as unknown as AgentSession,
		});
		expect(historyUrl("Parent.Child")).toBe("history://Parent.Child");
		const uri = historyUrl("background:1");
		expect((await read(uri)).text).toContain("# background:1");
		expect((await read(`${uri}:raw`)).text).toContain("background work");
	});

	it("preserves encoded literal selector tails and unrelated URI grammars", async () => {
		await register();
		AgentRegistry.global().register({
			id: "Literal:raw",
			displayName: "literal",
			kind: "sub",
			session: { messages: [] } as unknown as AgentSession,
		});
		expect((await read("history://Literal%3Araw:raw")).text).toContain("# Literal:raw");
		for (const uri of ["mcp://server/resource:raw", "ssh://host:2222", "https://host:443"]) {
			expect(splitInternalUrlSel(uri)).toEqual({ path: uri });
		}
	});
});
