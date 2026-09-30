import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { judgeAll } from "../bench/jev-bash-gate/replay";
import { getBashJudgmentCacheKey, getJevBashToolBlockReason } from "../src/lib/jev-bash-gate";
import { systemOne } from "../src/lib/typesafe-http";

const ENV_KEYS = ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "OPENROUTER_API_KEY", "OMP_JEV_BASH_GATE"] as const;
type RequestBody = { state: { command: string; working_directory: string }; model: string };

describe("Jev gate HTTP contracts", () => {
	let savedEnv: Record<string, string | undefined>;
	let server: Bun.Server<undefined>;
	let temporary: TempDir;
	let mode: "reply" | "overload" | "body-stall";
	let requests: RequestBody[];
	beforeEach(() => {
		savedEnv = {};
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		requests = [];
		mode = "reply";
		temporary = TempDir.createSync("jev-gate-contract-");
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push((await request.json()) as RequestBody);
				if (mode === "overload") return new Response("overloaded", { status: 529 });
				if (mode === "body-stall") {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode('{"answers":'));
							},
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				return Response.json({
					model: "test",
					answers: {
						action: {
							type: "choice",
							choice: "allow",
							confidence: 0.99,
							probabilities: { allow: 0.99, block: 0.01 },
						},
						destructive: { type: "noul", noul: 0.01 },
					},
					usage: { input_tokens: 1, output_tokens: 0 },
				});
			},
		});
		process.env.TYPESAFE_API_KEY = "fixture-key";
		process.env.TYPESAFE_BASE_URL = server.url.href.replace(/\/$/, "");
		process.env.OMP_JEV_BASH_GATE = "1";
	});
	afterEach(() => {
		server.stop(true);
		temporary.removeSync();
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("judges a relative requested cwd against the session directory", async () => {
		const sessionCwd = path.join(temporary.path(), "workspace");
		await getJevBashToolBlockReason({ command: "git status", cwd: "../other" }, sessionCwd);
		expect(requests[0].state.working_directory).toBe(path.resolve(sessionCwd, "../other"));
	});

	it("cancels a tool judgment while the response body is stalled", async () => {
		mode = "body-stall";
		const controller = new AbortController();
		const result = getJevBashToolBlockReason({ command: "git status" }, temporary.path(), controller.signal);
		const timer = setTimeout(() => controller.abort(new Error("User cancelled")), 100);
		const started = performance.now();
		try {
			expect(await result).toBeUndefined();
			expect(performance.now() - started).toBeLessThan(1500);
			expect(requests).toHaveLength(1);
		} finally {
			clearTimeout(timer);
		}
	});

	it("includes response-body parsing in the request deadline", async () => {
		mode = "body-stall";
		await expect(systemOne("state", {}, { timeoutMs: 100 })).rejects.toThrow("timed out");
		expect(requests).toHaveLength(1);
	});

	it("expires during retry backoff without sending another request", async () => {
		mode = "overload";
		await expect(systemOne("state", {}, { timeoutMs: 100 })).rejects.toThrow("timed out");
		expect(requests).toHaveLength(1);
	});

	it("makes no request when the tool is already cancelled", async () => {
		await getJevBashToolBlockReason({ command: "git status" }, temporary.path(), AbortSignal.abort());
		expect(requests).toHaveLength(0);
	});

	it("separates directories, deduplicates inputs, and invalidates cache when the model changes", async () => {
		const cachePath = path.join(temporary.path(), "results.json");
		const rows = [
			{ command: "git status", cwd: "workspace", label: "allow" as const },
			{ command: "git status", cwd: "other", label: "allow" as const },
			{ command: "git status", cwd: "workspace", label: "allow" as const },
		];
		const judged = await judgeAll(rows, cachePath);
		expect(requests).toHaveLength(2);
		expect(judged.every(row => row.verdict?.choice === "allow")).toBe(true);
		await judgeAll(rows, cachePath);
		expect(requests).toHaveLength(2);
		const originalKey = getBashJudgmentCacheKey("git status", "workspace");
		delete process.env.TYPESAFE_API_KEY;
		process.env.OPENROUTER_API_KEY = "fixture-router-key";
		expect(getBashJudgmentCacheKey("git status", "workspace")).not.toBe(originalKey);
		await judgeAll(rows, cachePath);
		expect(requests).toHaveLength(4);
		expect(requests.slice(2).every(request => request.model === "jev-1.13")).toBe(true);
	});
});
