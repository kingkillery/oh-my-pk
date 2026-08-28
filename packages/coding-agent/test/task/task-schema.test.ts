import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@pk-nerdsaver-ai/omptype";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { TaskTool, taskSchema } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import * as discoveryModule from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";

// Contract: the single-spawn schema (`task.batch: false`; the exported
// `taskSchema` instance) carries no batch fields while accepting a caller
// `model`, `outputSchema`, and its validation mode. The batch shape (`tasks[]` + shared
// `context`) is gated by the `task.batch` setting (default on, covered by
// test/task/task-batch.test.ts).

describe("task schema (single-spawn)", () => {
	it("accepts {agent, task}", () => {
		const parsed = taskSchema({ agent: "scout", task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
	});

	it("defaults agent to `task` when omitted", () => {
		const parsed = taskSchema({ task: "Map the auth module." });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.agent).toBe("task");
		}
	});

	it("requires task", () => {
		const parsed = taskSchema({ agent: "scout" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("retains caller outputSchema and schemaMode while stripping stale keys", () => {
		const outputSchema = { type: "object", properties: { answer: { type: "string" } } };
		const parsed = taskSchema({
			agent: "scout",
			task: "Map the auth module.",
			outputSchema,
			schemaMode: "strict",
			context: "shared background",
			tasks: [{ name: "A", task: "..." }],
			schema: '{"properties":{}}',
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.outputSchema).toEqual(outputSchema);
			expect(parsed.schemaMode).toBe("strict");
			expect("tasks" in parsed).toBe(false);
			expect("context" in parsed).toBe(false);
			expect("schema" in parsed).toBe(false);
		}
	});
});

describe("task schema difficulty field", () => {
	it("accepts a valid difficulty value on the single-spawn schema", () => {
		const parsed = taskSchema({ agent: "explore", assignment: "Map the auth module.", difficulty: "low" });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.difficulty).toBe("low");
		}
	});

	it("accepts every difficulty value", () => {
		for (const difficulty of ["low", "medium", "high"] as const) {
			const parsed = taskSchema({ agent: "explore", assignment: "...", difficulty });
			expect(parsed instanceof type.errors).toBe(false);
		}
	});

	it("rejects an unsupported difficulty string", () => {
		const parsed = taskSchema({ agent: "explore", assignment: "...", difficulty: "extreme" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("omits difficulty when not provided", () => {
		const parsed = taskSchema({ agent: "explore", assignment: "..." });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect("difficulty" in parsed).toBe(false);
		}
	});
});

describe("task item schema (direct) — flat/no-batch item shape", () => {
	it("accepts a valid item with every field including difficulty", () => {
		const parsed = taskItemSchema({
			id: "A",
			description: "Map auth",
			assignment: "Map the auth module.",
			model: "anthropic/claude-haiku",
			difficulty: "medium",
			fork: false,
			cwd: "/tmp",
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.difficulty).toBe("medium");
		}
	});

	it("accepts an item with no difficulty at all", () => {
		const parsed = taskItemSchema({ id: "A", assignment: "..." });
		expect(parsed instanceof type.errors).toBe(false);
	});

	it("rejects an invalid difficulty value", () => {
		const parsed = taskItemSchema({ id: "A", assignment: "...", difficulty: "extreme" });
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("still requires assignment", () => {
		const parsed = taskItemSchema({ id: "A", difficulty: "low" });
		expect(parsed instanceof type.errors).toBe(true);
	});
});

describe("task item schema (direct) — batch/isolated item shape via getTaskSchema", () => {
	const batchSchema = getTaskSchema({ isolationEnabled: true, batchEnabled: true });

	it("accepts a batch tasks[] item with a valid difficulty and isolated/fork fields", () => {
		const parsed = batchSchema({
			agent: "explore",
			context: "shared background",
			tasks: [{ id: "A", assignment: "Map the auth module.", difficulty: "high", isolated: true, fork: false }],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect("tasks" in parsed).toBe(true);
			if ("tasks" in parsed) expect(parsed.tasks[0]?.difficulty).toBe("high");
		}
	});

	it("accepts every difficulty value on a batch tasks[] item", () => {
		for (const difficulty of ["low", "medium", "high"] as const) {
			const parsed = batchSchema({
				agent: "explore",
				context: "shared background",
				tasks: [{ id: "A", assignment: "...", difficulty }],
			});
			expect(parsed instanceof type.errors).toBe(false);
		}
	});

	it("rejects a batch tasks[] item with an invalid difficulty value", () => {
		const parsed = batchSchema({
			agent: "explore",
			context: "shared background",
			tasks: [{ id: "A", assignment: "...", difficulty: "extreme" }],
		});
		expect(parsed instanceof type.errors).toBe(true);
	});

	it("accepts a batch tasks[] item with no difficulty at all", () => {
		const parsed = batchSchema({
			agent: "explore",
			context: "shared background",
			tasks: [{ id: "A", assignment: "..." }],
		});
		expect(parsed instanceof type.errors).toBe(false);
	});
});

describe("task spawn validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createSession(): ToolSession {
		return {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({ "task.isolation.mode": "none", "task.batch": false }),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession;
	}

	async function executeText(params: unknown): Promise<string> {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [], projectAgentsDir: null });
		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", params);
		return result.content.find(part => part.type === "text")?.text ?? "";
	}

	it("defaults a missing agent to `task`", async () => {
		// With no `agent`, execute() normalizes to the `task` default, so the
		// failure is unknown-agent (none discovered), not missing-agent.
		const text = await executeText({ task: "..." });
		expect(text).toContain('Unknown agent "task"');
	});

	it("rejects a missing task", async () => {
		const text = await executeText({ agent: "scout" });
		expect(text).toContain("Missing `task`");
	});
});
