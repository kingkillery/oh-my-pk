import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import terminalLaunchDescription from "../prompts/tools/terminal-launch.md" with { type: "text" };
import {
	launchInteractiveTerminal,
	type TerminalLaunchDependencies,
	type TerminalLaunchRequest,
	type TerminalLaunchResult,
	type TerminalLaunchSkill,
} from "../terminal/launch";
import type { ToolSession } from "./index";
import { resolveTerminalLaunchSkill } from "./terminal-skill";

const terminalLaunchParams = type({
	command: "string",
	"cwd?": "string",
	"title?": "string",
});

export interface TerminalLaunchDetails {
	ok: boolean;
	backend?: TerminalLaunchResult["backend"];
	id?: string;
	paneId?: string;
	tabId?: string;
	sessionName?: string;
	workspaceId?: string;
}
type TerminalLauncher = (
	request: TerminalLaunchRequest,
	dependencies: TerminalLaunchDependencies,
) => Promise<TerminalLaunchResult>;

export async function createTerminalLaunchTool(
	session: ToolSession,
	launch: TerminalLauncher = launchInteractiveTerminal,
): Promise<AgentTool<typeof terminalLaunchParams, TerminalLaunchDetails>> {
	let skill: TerminalLaunchSkill | undefined;
	let skillError: string | undefined;
	try {
		skill = await resolveTerminalLaunchSkill(session.skills);
	} catch (error) {
		skillError = error instanceof Error ? error.message : String(error);
	}
	return {
		name: "terminal_launch",
		label: "Terminal Launch",
		approval: "exec",
		concurrency: "exclusive",
		loadMode: "discoverable",
		summary: "Launch an interactive command through the required PK-Herdr skill and owned session lifecycle",
		description: prompt.render(terminalLaunchDescription, {
			skillContent: skill?.content,
			skillPath: skill?.filePath,
			skillError,
		}),
		parameters: terminalLaunchParams,
		async execute(_toolCallId, params, signal) {
			try {
				if (signal?.aborted) throw new Error("Terminal launch was cancelled.");
				if (!skill) throw new Error(skillError ?? "The installed pk-herdr skill is unavailable.");
				if (
					!session.skills?.some(
						candidate =>
							candidate.name === skill.name &&
							candidate.filePath === skill.filePath &&
							candidate.embeddedContent === undefined,
					)
				) {
					throw new Error(
						"The session's pk-herdr skill selection changed; reload the terminal tool before launching.",
					);
				}
				const result = await launch(
					{
						command: params.command,
						cwd: params.cwd ?? session.cwd,
						title: params.title,
						backend: session.settings.get("terminal.launchBackend"),
					},
					{
						signal,
						skill,
					},
				);
				return {
					content: [
						{
							type: "text",
							text: result.sessionName
								? `Launched in PK-Herdr session ${result.sessionName}, workspace ${result.workspaceId}, tab ${result.tabId} (pane ${result.paneId}). Scope control commands to --session ${result.sessionName}; stop only this owned session when work finishes.`
								: `Launched in PK-Herdr tab ${result.tabId} (pane ${result.paneId}).`,
						},
					],
					details: { ok: true, ...result },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Terminal launch failed: ${message}` }],
					isError: true,
					details: { ok: false },
				};
			}
		},
	};
}
