import { supportsCodexSpeedModes } from "@pk-nerdsaver-ai/pi-ai";
import type { InteractiveModeContext } from "../../modes/types";
import type { AgentSession } from "../../session/agent-session";
import type { ParsedSlashCommand, SlashCommandRuntime } from "../types";
import { commandConsumed } from "./parse";

type FastModeSession = Pick<
	AgentSession,
	"model" | "serviceTier" | "isFastModeEnabled" | "setServiceTier" | "setFastMode" | "toggleFastMode"
>;

export function formatFastModeStatus(session: FastModeSession): string {
	if (!session.isFastModeEnabled()) return "off";
	switch (session.serviceTier) {
		case "fast":
			return "fast";
		case "ultrafast":
			return "ultrafast";
		case "openai-only":
			return "on (OpenAI only)";
		case "claude-only":
			return "on (Claude only)";
		default:
			return "on";
	}
}

export function applyFastModeCommand(session: FastModeSession, args: string): string {
	const arg = args.trim().toLowerCase();
	if (arg === "fast" || arg === "ultrafast") {
		if (!supportsCodexSpeedModes(session.model)) {
			return "Fast/ultrafast selection requires GPT-6.1 Sol or GPT-6 Astra with ChatGPT sign-in. Use /fast on for this model.";
		}
		session.setServiceTier(arg);
		return `${arg === "fast" ? "Fast" : "Ultrafast"} mode enabled.`;
	}
	if (!arg || arg === "toggle") {
		const enabled = session.toggleFastMode();
		return `Fast mode ${enabled ? "enabled" : "disabled"}.`;
	}
	if (arg === "on" || arg === "off") {
		session.setFastMode(arg === "on");
		return `Fast mode ${arg === "on" ? "enabled" : "disabled"}.`;
	}
	if (arg === "status") return `Fast mode is ${formatFastModeStatus(session)}.`;
	return "Usage: /fast [fast|ultrafast|on|off|status]";
}

export async function handleFastCommand(command: ParsedSlashCommand, runtime: SlashCommandRuntime) {
	// Text clients cannot display a selector. Advertise choices without changing the tier.
	const message =
		!command.args.trim() && supportsCodexSpeedModes(runtime.session.model)
			? "Choose /fast fast or /fast ultrafast. Use /fast off for standard speed."
			: applyFastModeCommand(runtime.session, command.args);
	await runtime.output(message);
	return commandConsumed();
}

export async function handleFastCommandTui(command: ParsedSlashCommand, ctx: InteractiveModeContext): Promise<void> {
	let args = command.args;
	if (!args.trim() && supportsCodexSpeedModes(ctx.session.model)) {
		const selected = await ctx.showHookSelector("Speed", [
			{ label: "fast", description: "Faster responses" },
			{ label: "ultrafast", description: "Fastest responses; requires an eligible plan and uses more usage" },
			{ label: "off", description: "Standard speed" },
		]);
		ctx.editor.setText("");
		if (selected === undefined) return;
		args = selected;
	}
	const message = applyFastModeCommand(ctx.session, args);
	ctx.statusLine.invalidate();
	ctx.updateEditorTopBorder();
	ctx.ui.requestRender();
	ctx.showStatus(message);
	ctx.editor.setText("");
}
