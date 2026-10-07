import { expect, it } from "bun:test";
import path from "node:path";
import { Agent, type AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { callSessionTool } from "../src/eval/js/tool-bridge";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import type { ToolSession } from "../src/tools";
import { getLatestTodoPhasesFromEntries, TODO_STATE_CUSTOM_TYPE, type TodoPhase, TodoTool } from "../src/tools/todo";

it("commits native and eval todo changes once, retaining completions through compaction and reopen", async () => {
	using directory = TempDir.createSync("todo-persistence-");
	const auth = await AuthStorage.create(":memory:");
	const modelRegistry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });
	const manager = SessionManager.create(directory.path(), path.join(directory.path(), "sessions"));
	const session = new AgentSession({ agent: new Agent(), sessionManager: manager, settings, modelRegistry });
	const events: AgentSessionEvent[] = [];
	session.subscribe(event => events.push(event));
	const toolSession: ToolSession = {
		cwd: directory.path(),
		hasUI: false,
		settings,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
		getTodoPhases: () => session.getTodoPhases(),
		setTodoPhases: phases => session.setTodoPhases(phases),
		getToolByName: name => (name === "todo" ? (todo as unknown as AgentTool) : undefined),
	};
	const todo = new TodoTool(toolSession);
	try {
		await todo.execute("native-init", { op: "init", items: ["first", "second"] });
		await Promise.all(
			["first", "second"].map(task => callSessionTool("todo", { op: "done", task }, { session: toolSession })),
		);
		await todo.execute("native-append", { op: "append", phase: "Tasks", items: ["third"] });
		const expected: TodoPhase[] = [
			{
				name: "Tasks",
				tasks: [
					{ content: "first", status: "completed" },
					{ content: "second", status: "completed" },
					{ content: "third", status: "in_progress" },
				],
			},
		];
		expect(session.getTodoPhases()).toEqual(expected);
		expect(getLatestTodoPhasesFromEntries(manager.getBranch())).toEqual(expected);
		expect(
			manager.getBranch().filter(entry => entry.type === "custom" && entry.customType === TODO_STATE_CUSTOM_TYPE),
		).toHaveLength(4);
		expect(events.filter(event => event.type === "todo_updated")).toHaveLength(4);
		const viewed = await callSessionTool("todo", { op: "view" }, { session: toolSession });
		expect(viewed).toMatchObject({ details: { phases: expected } });
		expect(events.filter(event => event.type === "todo_updated")).toHaveLength(4);
		// A delayed result from an older call must not roll back the committed board.
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "older-call",
			toolName: "todo",
			content: [],
			details: { phases: [] },
			isError: false,
			timestamp: Date.now(),
		});
		expect(getLatestTodoPhasesFromEntries(manager.getBranch())).toEqual(expected);
		manager.appendCompaction("Retain the board", undefined, manager.getBranch()[0].id, 100);
		await manager.ensureOnDisk();
		const file = manager.getSessionFile()!;
		await session.dispose();
		manager.close();
		const reopened = await SessionManager.open(file);
		const restored = new AgentSession({ agent: new Agent(), sessionManager: reopened, settings, modelRegistry });
		try {
			expect(restored.getTodoPhases()).toEqual(expected);
		} finally {
			await restored.dispose();
			reopened.close();
		}
	} finally {
		await session.dispose();
		manager.close();
		auth.close();
	}
}, 30_000);
