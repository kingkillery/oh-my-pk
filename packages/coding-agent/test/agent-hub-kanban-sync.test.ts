import { describe, expect, it } from "bun:test";
import {
	AgentHubKanbanSync,
	type KanbanCliRunner,
	renderKanbanPrompt,
} from "../src/modes/components/agent-hub-kanban-sync";
import type { AgentRef } from "../src/registry/agent-registry";

class RecordingKanbanRunner implements KanbanCliRunner {
	calls: Array<{ command: string; args: string[]; cwd: string }> = [];
	payload: unknown = {
		ok: true,
		results: [
			{
				agentId: "agent-1",
				idempotencyKey: "omp-agent-hub:C:/work/repo:agent-1",
				taskId: "task-synced",
				created: true,
				updated: false,
			},
		],
	};

	async run(
		command: string,
		args: string[],
		options: { cwd: string },
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		this.calls.push({ command, args, cwd: options.cwd });
		if (args[0] === "task" && args[1] === "sync-omp-background") {
			return { exitCode: 0, stdout: JSON.stringify(this.payload), stderr: "" };
		}
		return { exitCode: 1, stdout: "", stderr: "unexpected command" };
	}
}

function createAgent(overrides: Partial<AgentRef> = {}): AgentRef {
	return {
		id: "agent-1",
		displayName: "Implementation Agent",
		kind: "sub",
		status: "running",
		session: null,
		sessionFile: "C:/tmp/agent.jsonl",
		createdAt: 1,
		lastActivity: 2,
		activity: "editing files",
		collaborationScopeId: "test-scope",
		cwd: "C:/work/repo",
		...overrides,
	};
}

describe("AgentHubKanbanSync", () => {
	it("creates a Kanban task for an unsynced background agent", async () => {
		const runner = new RecordingKanbanRunner();
		const sync = new AgentHubKanbanSync({ projectPath: "C:/work/repo", command: "pk-kanban", runner });

		const result = await sync.syncAgent(createAgent());

		expect(result).toMatchObject({
			agentId: "agent-1",
			taskId: "task-synced",
			created: true,
			updated: false,
			ok: true,
		});
		expect(runner.calls).toHaveLength(1);
		expect(runner.calls[0].args.slice(0, 5)).toEqual([
			"task",
			"sync-omp-background",
			"--project-path",
			"C:/work/repo",
			"--agents-json",
		]);
		const agentsJson = runner.calls[0].args[5];
		expect(agentsJson).toContain('"id":"agent-1"');
		expect(agentsJson).toContain('"activity":"editing files"');
	});

	it("uses Kanban's native OMP background sync result", async () => {
		const runner = new RecordingKanbanRunner();
		runner.payload = {
			ok: true,
			results: [
				{
					agentId: "agent-1",
					idempotencyKey: "omp-agent-hub:C:/work/repo:agent-1",
					taskId: "task-existing",
					created: false,
					updated: true,
				},
			],
		};
		const sync = new AgentHubKanbanSync({ projectPath: "C:/work/repo", command: "pk-kanban", runner });

		const result = await sync.syncAgent(createAgent());

		expect(result).toMatchObject({
			agentId: "agent-1",
			taskId: "task-existing",
			created: false,
			updated: true,
			ok: true,
		});
		expect(runner.calls).toHaveLength(1);
	});

	it("renders enough agent context for a durable Kanban card", () => {
		const prompt = renderKanbanPrompt(createAgent());

		expect(prompt).toContain("[OMP background agent] Implementation Agent (agent-1)");
		expect(prompt).toContain("Status: running");
		expect(prompt).toContain("Activity: editing files");
		expect(prompt).toContain("Session file: C:/tmp/agent.jsonl");
	});
});
