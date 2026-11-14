import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@pk-nerdsaver-ai/pi-agent-core";
import { type } from "arktype";
import { continuityStatus, exportHandoff, resumeHandoff, saveHandoff } from "../continuity/service";
import type { HandoffSections } from "../continuity/types";
import description from "../prompts/tools/continuity.md" with { type: "text" };
import type { ToolSession } from ".";

const schema = type({
	action: "'status' | 'save' | 'resume' | 'export'",
	"intent?": "string",
	"workstreamId?": "string",
	"sections?": type({
		"objective?": "string",
		"currentState?": "string",
		"keyContext?": "string",
		"nextSteps?": "string",
		"validation?": "string",
		"blockers?": "string",
	}),
	"expectedRevision?": "number.integer >= 0",
	"evidenceObservedAt?": "string",
	"sourceSessions?": "string[]",
	"destination?": "string",
	"staleAfterDays?": "number.integer >= 1",
});

export class ContinuityTool implements AgentTool<typeof schema> {
	#session: ToolSession;
	readonly name = "continuity";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		if (typeof args === "object" && args !== null && "action" in args && typeof args.action === "string") {
			return args.action === "save" || args.action === "export" ? "write" : "read";
		}
		return "read";
	};
	readonly label = "Project continuity";
	readonly description = description;
	readonly parameters = schema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Save or resume a workstream's canonical handoff with revision guards";
	constructor(session: ToolSession) {
		this.#session = session;
	}
	async execute(_id: string, params: typeof schema.infer, signal?: AbortSignal): Promise<AgentToolResult> {
		signal?.throwIfAborted();
		const root = this.#session.cwd;
		let result: unknown;
		switch (params.action) {
			case "status":
				result = await continuityStatus(root);
				break;
			case "resume":
				result = await resumeHandoff({
					root,
					intent: params.intent,
					workstreamId: params.workstreamId,
					staleAfterDays: params.staleAfterDays,
				});
				break;
			case "save":
				result = await saveHandoff({
					root,
					intent: params.intent,
					workstreamId: params.workstreamId,
					sections: (params.sections ?? {}) as HandoffSections,
					expectedRevision: params.expectedRevision,
					evidenceObservedAt: params.evidenceObservedAt,
					sourceSessions: params.sourceSessions,
				});
				break;
			case "export":
				if (!params.destination) {
					result = {
						status: "rejected",
						reason: "destination-required",
						detail: "export needs a destination path",
					};
					break;
				}
				result = await exportHandoff({
					root,
					intent: params.intent,
					workstreamId: params.workstreamId,
					destination: params.destination,
				});
				break;
		}
		signal?.throwIfAborted();
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
	}
}
