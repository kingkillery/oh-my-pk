import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { type } from "arktype";
import terminalLaunchDescription from "../prompts/tools/terminal-launch.md" with { type: "text" };
import {
	launchInteractiveTerminal,
	type TerminalLaunchDependencies,
	type TerminalLaunchRequest,
	type TerminalLaunchResult,
} from "../terminal/launch";
import type { ToolSession } from "./index";

const terminalLaunchParams = type({
	command: "string",
	"cwd?": "string",
	"title?": "string",
});

export interface TerminalLaunchDetails {
	ok: boolean;
	backend?: TerminalLaunchResult["backend"];
	id?: string;
	tabId?: string;
}
type TerminalLauncher = (
	request: TerminalLaunchRequest,
	dependencies?: TerminalLaunchDependencies,
) => Promise<TerminalLaunchResult>;

export function createTerminalLaunchTool(
	session: ToolSession,
	launch: TerminalLauncher = launchInteractiveTerminal,
): AgentTool<typeof terminalLaunchParams, TerminalLaunchDetails> {
	return {
		name: "terminal_launch",
		label: "Terminal Launch",
		approval: "exec",
		concurrency: "exclusive",
		loadMode: "discoverable",
		summary: "Launch an interactive command through PK-Herdr, psmux, or an explicitly approved system terminal",
		description: terminalLaunchDescription,
		parameters: terminalLaunchParams,
		async execute(_toolCallId, params, signal, _onUpdate, context) {
			try {
				if (signal?.aborted) throw new Error("Terminal launch was cancelled.");
				const ui = context?.hasUI ? context.ui : undefined;
				const result = await launch(
					{
						command: params.command,
						cwd: params.cwd ?? session.cwd,
						title: params.title,
						backend: session.settings.get("terminal.launchBackend"),
					},
					{
						signal,
						confirmFallback: ui ? message => ui.confirm("Use Windows Terminal?", message) : undefined,
					},
				);
				return {
					content: [
						{
							type: "text",
							text: result.tabId
								? `Launched in PK-Herdr tab ${result.tabId} (pane ${result.id}).`
								: `Launched in ${result.backend}${result.id ? ` (${result.id})` : ""}.`,
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
