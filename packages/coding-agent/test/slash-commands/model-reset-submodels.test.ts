import { expect, test, vi } from "bun:test";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";

test("/model reset-submodels keeps the default and allows picker role reassignment", async () => {
	const settings = Settings.isolated({
		modelRoles: {
			default: "anthropic/claude-sonnet-4-5",
			smol: "openai/gpt-4o-mini",
			slow: "anthropic/claude-opus-4-5",
		},
		"task.agentModelOverrides": { explore: "openai/gpt-4o" },
	});
	const showStatus = vi.fn();
	const setText = vi.fn();
	const session = { model: { provider: "anthropic", id: "claude-sonnet-4-5" } };
	const runtime = {
		ctx: {
			settings,
			session,
			showStatus,
			editor: { setText },
		} as unknown as InteractiveModeContext,
	};

	expect(await executeBuiltinSlashCommand("/model reset-submodels", runtime)).toBe(true);
	expect(settings.getModelRoles()).toEqual({ default: "anthropic/claude-sonnet-4-5" });
	expect(settings.get("task.agentModelOverrides")).toEqual({});
	expect(session.model.id).toBe("claude-sonnet-4-5");
	expect(showStatus).toHaveBeenCalledWith(
		"Submodel assignments cleared; default model preserved. Reassign roles in /model.",
	);
	expect(setText).toHaveBeenCalledWith("");

	settings.setModelRole("smol", "openai/gpt-4o-mini");
	expect(settings.getModelRole("smol")).toBe("openai/gpt-4o-mini");
});
