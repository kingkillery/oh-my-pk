import { expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@pk-nerdsaver-ai/pi-agent-core";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type {
	TerminalLaunchDependencies,
	TerminalLaunchRequest,
} from "@pk-nerdsaver-ai/pi-coding-agent/terminal/launch";
import { createTools, type ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { createTerminalLaunchTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/terminal-launch";

it("requires actual interactive confirmation before tool system fallback", async () => {
	const settings = Settings.isolated({ "terminal.launchBackend": "managed" });
	const session = { cwd: process.cwd(), settings, hasUI: true } as ToolSession;
	const confirm = vi.fn(async () => true);
	const launch = vi.fn(async (request: TerminalLaunchRequest, dependencies?: TerminalLaunchDependencies) => {
		expect(request.backend).toBe("managed");
		if (!(await dependencies?.confirmFallback?.("No managed terminal available")))
			throw new Error("Fallback declined");
		return { backend: "system" as const };
	});
	const tool = createTerminalLaunchTool(session, launch);
	const context = { hasUI: true, ui: { confirm } } as unknown as AgentToolContext;
	const result = await tool.execute("call", { command: "Get-Date" }, undefined, undefined, context);
	expect(result.isError).not.toBe(true);
	expect(confirm).toHaveBeenCalledWith("Use Windows Terminal?", "No managed terminal available");
	expect(launch).toHaveBeenCalledTimes(1);

	const headless = await tool.execute("call", { command: "Get-Date" });
	expect(headless.isError).toBe(true);
	expect(confirm).toHaveBeenCalledTimes(1);
});

it("reports the created PK-Herdr tab and pane", async () => {
	const settings = Settings.isolated({ "terminal.launchBackend": "managed" });
	const session = { cwd: process.cwd(), settings, hasUI: false } as ToolSession;
	const launch = vi.fn(async () => ({ backend: "pk-herdr" as const, id: "w1:p2", tabId: "w1:t2" }));
	const result = await createTerminalLaunchTool(session, launch).execute("call", { command: "Get-Date" });
	expect(result.content).toEqual([{ type: "text", text: "Launched in PK-Herdr tab w1:t2 (pane w1:p2)." }]);
	expect(result.details).toEqual({ ok: true, backend: "pk-herdr", id: "w1:p2", tabId: "w1:t2" });
});

it("passes system opt-out to the launcher and limits the tool to the main agent", async () => {
	const settings = Settings.isolated({ "terminal.launchBackend": "system" });
	const session = { cwd: process.cwd(), settings, hasUI: false, taskDepth: 0 } as ToolSession;
	const available = await createTools(session, ["terminal_launch"]);
	expect(available.some(tool => tool.name === "terminal_launch")).toBe(true);
	const child = await createTools({ ...session, taskDepth: 1 }, ["terminal_launch"]);
	expect(child.some(tool => tool.name === "terminal_launch")).toBe(false);
	const launch = vi.fn(async (request: TerminalLaunchRequest) => {
		expect(request.backend).toBe("system");
		return { backend: "system" as const };
	});
	const result = await createTerminalLaunchTool(session, launch).execute("call", { command: "Get-Date" });
	expect(result.isError).not.toBe(true);
	expect(launch).toHaveBeenCalledTimes(1);
});
