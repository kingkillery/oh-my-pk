import type { AgentTool, AgentToolResult } from "@pk-nerdsaver-ai/pi-agent-core";
import { type } from "arktype";
import description from "../prompts/tools/session-memory.md" with { type: "text" };
import { readSessionMemory, sessionMemoryProject } from "../session-memory/project";
import type { ToolSession } from ".";

const schema = type({
	action: "'status' | 'wake' | 'search' | 'expand' | 'source'",
	"value?": "string",
	"offset?": "number.integer >= 0",
	"limit?": "number.integer >= 1",
});

export class SessionMemoryTool implements AgentTool<typeof schema> {
	#session: ToolSession;
	readonly name = "session_memory";
	readonly approval = "read" as const;
	readonly label = "Session memory";
	readonly description = description;
	readonly parameters = schema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search prior sessions and expand summaries to exact source evidence";
	constructor(session: ToolSession) {
		this.#session = session;
	}
	async execute(_id: string, params: typeof schema.infer, signal?: AbortSignal): Promise<AgentToolResult> {
		signal?.throwIfAborted();
		const project = await sessionMemoryProject(this.#session.cwd, signal);
		const result = await readSessionMemory(
			project,
			params.action,
			params.value,
			params.offset,
			params.limit ?? (params.action === "source" ? 8192 : 10),
		);
		signal?.throwIfAborted();
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
	}
}
