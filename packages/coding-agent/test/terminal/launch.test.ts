import { describe, expect, it, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { buildSystemPrompt } from "@pk-nerdsaver-ai/pi-coding-agent/system-prompt";
import {
	launchInteractiveTerminal,
	type TerminalLaunchRequest,
} from "@pk-nerdsaver-ai/pi-coding-agent/terminal/launch";

type CommandResult = { exitCode: number; stdout: string; stderr: string };
const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };
const herdTab = (tabId = "w1:t2", paneId = "w1:p2"): CommandResult => ({
	...ok,
	stdout: JSON.stringify({ result: { tab: { tab_id: tabId }, root_pane: { pane_id: paneId } } }),
});
const request: TerminalLaunchRequest = {
	command: "& 'C:/Users/prest/bin/ompk.exe'",
	cwd: process.cwd(),
	title: "New agent",
	backend: "managed",
};

describe("managed interactive terminal launch", () => {
	it("opens a background PK-Herdr tab in the caller's workspace and returns its IDs", async () => {
		const calls: string[][] = [];
		const confirmFallback = vi.fn(async (_reason: string): Promise<boolean> => true);
		const result = await launchInteractiveTerminal(request, {
			environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
			platform: "win32",
			confirmFallback,
			run: async args => {
				calls.push(args);
				return args[1] === "tab" ? herdTab() : ok;
			},
		});
		expect(result).toEqual({ backend: "pk-herdr", id: "w1:p2", tabId: "w1:t2" });
		expect(calls).toEqual([
			["pk-herdr", "tab", "create", "--workspace", "w1", "--cwd", request.cwd, "--label", "New agent", "--no-focus"],
			["pk-herdr", "pane", "run", "w1:p2", request.command],
		]);
		expect(confirmFallback).not.toHaveBeenCalled();
	});

	it("closes a created tab without a root pane before trying psmux", async () => {
		const calls: string[][] = [];
		const result = await launchInteractiveTerminal(request, {
			environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
			platform: "win32",
			newId: () => "12345678-abcd",
			run: async args => {
				calls.push(args);
				return args[2] === "create" ? { ...ok, stdout: '{"result":{"tab":{"tab_id":"w1:t2"}}}' } : ok;
			},
		});
		expect(result.backend).toBe("psmux");
		expect(calls[1]).toEqual(["pk-herdr", "tab", "close", "w1:t2"]);
		expect(calls[2]?.[0]).toBe("psmux");
	});

	it("closes a failed PK-Herdr tab and verifies the psmux fallback", async () => {
		const calls: string[][] = [];
		const result = await launchInteractiveTerminal(request, {
			environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
			platform: "win32",
			newId: () => "12345678-abcd",
			run: async args => {
				calls.push(args);
				if (args[2] === "create") return herdTab("w1:t3", "w1:p3");
				if (args[2] === "run") return { exitCode: 1, stdout: "", stderr: "busy pane" };
				return ok;
			},
		});
		expect(result).toEqual({ backend: "psmux", id: "ompk-new-agent-12345678" });
		expect(calls[2]).toEqual(["pk-herdr", "tab", "close", "w1:t3"]);
		expect(calls[3]?.slice(0, 6)).toEqual(["psmux", "new-session", "-d", "-s", "ompk-new-agent-12345678", "--"]);
		expect(calls[4]).toEqual(["psmux", "has-session", "-t", "ompk-new-agent-12345678"]);
	});

	it("refuses another terminal when a failed Herdr tab cannot be closed", async () => {
		const calls: string[][] = [];
		await expect(
			launchInteractiveTerminal(request, {
				environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
				platform: "win32",
				run: async args => {
					calls.push(args);
					if (args[2] === "create") return herdTab("w1:t4", "w1:p4");
					return { exitCode: 1, stdout: "", stderr: "tab unavailable" };
				},
			}),
		).rejects.toThrow("could not be closed");
		expect(calls.map(args => args[0])).toEqual(["pk-herdr", "pk-herdr", "pk-herdr"]);
	});

	it("closes its new tab when cancelled before running the command", async () => {
		const controller = new AbortController();
		const calls: string[][] = [];
		await expect(
			launchInteractiveTerminal(request, {
				environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
				platform: "win32",
				signal: controller.signal,
				run: async args => {
					calls.push(args);
					if (args[2] === "create") {
						controller.abort();
						return herdTab();
					}
					return ok;
				},
			}),
		).rejects.toThrow("cancelled");
		expect(calls).toEqual([
			["pk-herdr", "tab", "create", "--workspace", "w1", "--cwd", request.cwd, "--label", "New agent", "--no-focus"],
			["pk-herdr", "tab", "close", "w1:t2"],
		]);
	});

	it("does not start another terminal when a successful tab creation lacks its ID", async () => {
		const calls: string[][] = [];
		await expect(
			launchInteractiveTerminal(request, {
				environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" },
				platform: "win32",
				run: async args => {
					calls.push(args);
					return args[2] === "create" ? { ...ok, stdout: '{"result":{}}' } : ok;
				},
			}),
		).rejects.toThrow("without a usable tab ID");
		expect(calls).toHaveLength(1);
	});

	it("does not inspect an unrelated focused Herdr pane from outside Herdr", async () => {
		const calls: string[][] = [];
		const result = await launchInteractiveTerminal(request, {
			environment: {},
			platform: "win32",
			newId: () => "12345678-abcd",
			run: async args => {
				calls.push(args);
				return ok;
			},
		});
		expect(result.backend).toBe("psmux");
		expect(calls.every(args => args[0] === "psmux")).toBe(true);
	});

	it("fails closed when neither manager works and no interactive approval exists", async () => {
		const calls: string[][] = [];
		await expect(
			launchInteractiveTerminal(request, {
				environment: {},
				platform: "win32",
				run: async args => {
					calls.push(args);
					return { exitCode: 1, stdout: "", stderr: "psmux unavailable" };
				},
			}),
		).rejects.toThrow("without an approved fallback");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe("psmux");
	});

	it("cleans up a psmux session that cannot be verified", async () => {
		const calls: string[][] = [];
		await expect(
			launchInteractiveTerminal(request, {
				environment: {},
				platform: "win32",
				newId: () => "12345678-abcd",
				run: async args => {
					calls.push(args);
					return args[1] === "has-session" ? { exitCode: 1, stdout: "", stderr: "missing session" } : ok;
				},
			}),
		).rejects.toThrow("without an approved fallback");
		expect(calls.filter(args => args[1] === "has-session")).toHaveLength(2);
		expect(calls.at(-1)).toEqual(["psmux", "kill-session", "-t", "ompk-new-agent-12345678"]);
	});

	it("kills a psmux session when cancelled during verification", async () => {
		const controller = new AbortController();
		const calls: string[][] = [];
		await expect(
			launchInteractiveTerminal(request, {
				environment: {},
				platform: "win32",
				signal: controller.signal,
				newId: () => "12345678-abcd",
				run: async args => {
					calls.push(args);
					if (args[1] === "has-session") controller.abort();
					return ok;
				},
			}),
		).rejects.toThrow("Terminal launch was cancelled");
		expect(calls.at(-1)).toEqual(["psmux", "kill-session", "-t", "ompk-new-agent-12345678"]);
	});

	it("prompts before system fallback and honors refusal", async () => {
		const calls: string[][] = [];
		const confirmFallback = vi.fn(async (_reason: string): Promise<boolean> => false);
		const run = async (args: string[]) => {
			calls.push(args);
			return args[0] === "psmux" ? { exitCode: 1, stdout: "", stderr: "not running" } : ok;
		};
		await expect(
			launchInteractiveTerminal(request, {
				environment: {},
				platform: "win32",
				run,
				confirmFallback,
			}),
		).rejects.toThrow("without an approved fallback");
		expect(confirmFallback).toHaveBeenCalledTimes(1);
		expect(confirmFallback.mock.calls[0]?.[0]).toContain("psmux launch failed");
		expect(calls).toHaveLength(1);
		confirmFallback.mockResolvedValue(true);
		expect(
			await launchInteractiveTerminal(request, {
				environment: {},
				platform: "win32",
				run,
				confirmFallback,
			}),
		).toEqual({ backend: "system" });
		expect(calls.at(-1)?.[0]).toBe("powershell.exe");
		expect(calls.at(-1)?.join(" ")).toContain("Start-Process");
	});

	it("does not launch after a tool call is cancelled during confirmation", async () => {
		const controller = new AbortController();
		const calls: string[][] = [];
		await expect(
			launchInteractiveTerminal(request, {
				environment: {},
				platform: "win32",
				signal: controller.signal,
				confirmFallback: async () => {
					controller.abort();
					return true;
				},
				run: async args => {
					calls.push(args);
					return { exitCode: 1, stdout: "", stderr: "psmux unavailable" };
				},
			}),
		).rejects.toThrow("cancelled");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe("psmux");
	});

	it("uses the system terminal directly only when the setting opts out", async () => {
		const calls: string[][] = [];
		const confirmFallback = vi.fn(async (_reason: string): Promise<boolean> => false);
		const result = await launchInteractiveTerminal(
			{ ...request, backend: "system" },
			{
				environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
				platform: "win32",
				confirmFallback,
				run: async args => {
					calls.push(args);
					return ok;
				},
			},
		);
		expect(result.backend).toBe("system");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBe("powershell.exe");
		expect(confirmFallback).not.toHaveBeenCalled();
	});
	it("quotes spaced and apostrophe-containing paths without changing command text", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "ompk's terminal "));
		try {
			const calls: string[][] = [];
			await launchInteractiveTerminal(
				{ ...request, cwd, backend: "system", command: "Write-Output 'hello world'" },
				{
					platform: "win32",
					run: async args => {
						calls.push(args);
						return ok;
					},
				},
			);
			const script = calls[0]?.[4] ?? "";
			expect(script).toContain(`-WorkingDirectory '${cwd.replaceAll("'", "''")}'`);
			const encoded = script.match(/"-EncodedCommand" "([A-Za-z0-9+/=]+)"/)?.[1];
			expect(encoded).toBeDefined();
			expect(Buffer.from(encoded ?? "", "base64").toString("utf16le")).toContain("Write-Output 'hello world'");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

it("defaults to managed launches and renders the supported boundary", async () => {
	const settings = Settings.isolated();
	expect(settings.get("terminal.launchBackend")).toBe("managed");
	settings.set("terminal.launchBackend", "system");
	expect(settings.get("terminal.launchBackend")).toBe("system");
	const { systemPrompt } = await buildSystemPrompt({
		cwd: process.cwd(),
		contextFiles: [],
		skills: [],
		rules: [],
		toolNames: ["terminal_launch"],
		workspaceTree: { rootPath: process.cwd(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		activeRepoContext: null,
		managedTerminalLaunches: true,
	});
	const rendered = systemPrompt.join("\n");
	expect(rendered).toContain("For an external interactive terminal");
	expect(rendered).toContain("terminal_launch");
	expect(rendered).toContain("NEVER launch one via bash/eval");
});
