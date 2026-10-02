import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	launchInteractiveTerminal,
	type TerminalLaunchDependencies,
	type TerminalLaunchRequest,
	type TerminalLaunchSkill,
} from "@pk-nerdsaver-ai/pi-coding-agent/terminal/launch";

let skillRoot: string;
let skill: TerminalLaunchSkill;
beforeAll(async () => {
	skillRoot = await mkdtemp(join(tmpdir(), "ompk-herdr-launch-"));
	skill = {
		name: "pk-herdr",
		filePath: join(skillRoot, "SKILL.md"),
		content:
			"---\nname: pk-herdr\ndescription: Scoped terminal operations\n---\nUse returned IDs and close only owned resources.\n",
	};
	await Bun.write(skill.filePath, skill.content);
});
afterAll(async () => {
	await rm(skillRoot, { recursive: true, force: true });
});
const request: TerminalLaunchRequest = {
	command: "echo hello",
	cwd: process.cwd(),
	title: "New agent",
	backend: "pk-herdr",
};
const ok = { exitCode: 0, stdout: "", stderr: "" };
const created = {
	...ok,
	stdout: JSON.stringify({
		result: {
			workspace: { workspace_id: "w1" },
			tab: { workspace_id: "w1", tab_id: "w1:t2" },
			root_pane: { pane_id: "w1:p2" },
		},
	}),
};
const caller = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" };
function fixture(environment = {}) {
	const calls: string[][] = [];
	const events: string[] = [];
	const exit = Promise.withResolvers<number>();
	const deps: TerminalLaunchDependencies = {
		skill,
		environment,
		newId: () => "unique-123",
		startServer: async args => {
			calls.push(args);
			events.push("spawn");
			return {
				exited: exit.promise,
				kill: () => {
					events.push("kill");
				},
				release: () => {
					events.push("release");
				},
			};
		},
		waitForReady: async (name, _cwd, run) => {
			events.push("ready");
			await run(["pk-herdr", "--session", name, "status", "server", "--json"], request.cwd);
		},
		run: async args => {
			calls.push(args);
			return args.includes("create") ? created : ok;
		},
	};
	return { calls, events, deps, exit };
}
const name = "ompk-terminal-unique-123";
const scope = ["pk-herdr", "--session", name];

describe("PK-Herdr-only terminal lifecycle", () => {
	it("rejects an untyped caller without the required skill before any Herdr process", async () => {
		const f = fixture();
		const missing = { ...f.deps, skill: undefined } as unknown as TerminalLaunchDependencies;
		await expect(launchInteractiveTerminal(request, missing)).rejects.toThrow("installed pk-herdr skill");
		expect(f.calls).toEqual([]);
		expect(f.events).toEqual([]);
	});
	it("rejects an unreadable installed skill before any Herdr process", async () => {
		const f = fixture();
		f.deps.skill = { ...skill, filePath: join(skillRoot, "missing.md") };
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow("skill unavailable");
		expect(f.calls).toEqual([]);
		expect(f.events).toEqual([]);
	});
	it("rejects instructions changed since they were exposed before any Herdr process", async () => {
		const f = fixture();
		const filePath = join(skillRoot, "changed.md");
		await Bun.write(filePath, skill.content);
		f.deps.skill = { ...skill, filePath };
		await Bun.write(filePath, `${skill.content}\nChanged after tool construction.\n`);
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow("instructions changed");
		expect(f.calls).toEqual([]);
		expect(f.events).toEqual([]);
	});
	it("creates only a no-focus caller tab without opting its session into cleanup", async () => {
		const f = fixture(caller);
		expect(await launchInteractiveTerminal(request, f.deps)).toEqual({
			backend: "pk-herdr",
			id: "w1:p2",
			paneId: "w1:p2",
			tabId: "w1:t2",
			workspaceId: "w1",
		});
		expect(f.calls).toEqual([
			[
				"pk-herdr",
				"tab",
				"create",
				"--workspace",
				"w1",
				"--cwd",
				request.cwd,
				"--label",
				"New agent [ompk-owned:unique-123]",
				"--no-focus",
			],
			["pk-herdr", "pane", "run", "w1:p2", request.command],
		]);
		expect(f.events).toEqual([]);
	});
	it("owns a named headless server, waits before creation, scopes controls and returns IDs", async () => {
		const f = fixture();
		expect((await launchInteractiveTerminal(request, f.deps)).sessionName).toBe(name);
		expect(f.calls).toEqual([
			[...scope, "--session-auto-close-after", "4h", "server"],
			[...scope, "status", "server", "--json"],
			[
				...scope,
				"workspace",
				"create",
				"--origin",
				"tool",
				"--cwd",
				request.cwd,
				"--label",
				"New agent",
				"--no-focus",
			],
			[...scope, "pane", "run", "w1:p2", request.command],
		]);
		expect(f.events).toEqual(["spawn", "ready", "release"]);
	});
	it("does not treat forged or incomplete context as caller ownership", async () => {
		for (const environment of [
			{ ...caller, HERDR_ENV: "0" },
			{ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
		]) {
			const f = fixture(environment);
			await launchInteractiveTerminal(request, f.deps);
			expect(f.calls[0]).toEqual([...scope, "--session-auto-close-after", "4h", "server"]);
		}
	});
	it("normalizes both legacy API backends without any fallback", async () => {
		for (const backend of ["managed", "system"] as const) {
			const f = fixture(caller);
			expect((await launchInteractiveTerminal({ ...request, backend }, f.deps)).backend).toBe("pk-herdr");
			expect(f.calls.every(args => args[0] === "pk-herdr")).toBe(true);
		}
	});
	for (const environment of [caller, {}]) {
		for (const phase of ["before-run", "during-run"] as const) {
			it(`cleans only owned resources when cancelled ${phase} (${environment === caller ? "caller" : "owned"})`, async () => {
				const f = fixture(environment);
				const controller = new AbortController();
				f.deps.signal = controller.signal;
				const run = f.deps.run!;
				f.deps.run = async (args, cwd, options) => {
					const result = await run(args, cwd, options);
					if (args.includes(phase === "before-run" ? "create" : "run")) controller.abort();
					return result;
				};
				await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow("cancelled");
				expect(f.calls.at(-1)).toEqual(
					environment === caller
						? ["pk-herdr", "tab", "close", "w1:t2"]
						: ["pk-herdr", "session", "stop", name, "--json"],
				);
				expect(f.calls.filter(args => args.includes("create"))).toHaveLength(1);
			});
		}
	}
	it("does nothing when already cancelled", async () => {
		const f = fixture();
		const controller = new AbortController();
		controller.abort();
		f.deps.signal = controller.signal;
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow("cancelled");
		expect(f.calls).toEqual([]);
	});
	it("fails closed and closes a known caller tab on missing pane IDs", async () => {
		const f = fixture(caller);
		const run = f.deps.run!;
		f.deps.run = async (args, cwd, options) => {
			if (!args.includes("create")) return run(args, cwd, options);
			f.calls.push(args);
			return { ...ok, stdout: '{"result":{"tab":{"tab_id":"w1:t2"}}}' };
		};
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow("malformed resource IDs");
		expect(f.calls.at(-1)).toEqual(["pk-herdr", "tab", "close", "w1:t2"]);
	});
	it("never closes a tab in another caller workspace on malformed IDs", async () => {
		const f = fixture(caller);
		f.deps.run = async args => {
			f.calls.push(args);
			return { ...ok, stdout: '{"result":{"tab":{"tab_id":"w2:t2"},"root_pane":{"pane_id":"w2:p2"}}}' };
		};
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow("refusing another launch");
		expect(f.calls.filter(args => args.includes("create"))).toHaveLength(1);
		expect(f.calls.some(args => args.includes("close"))).toBe(false);
	});
	it("stops exact owned session after malformed creation, never default", async () => {
		const f = fixture();
		const run = f.deps.run!;
		f.deps.run = async (args, cwd, options) => {
			if (!args.includes("create")) return run(args, cwd, options);
			f.calls.push(args);
			return { ...ok, stdout: "{}" };
		};
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow("malformed");
		expect(f.calls.at(-1)).toEqual(["pk-herdr", "session", "stop", name, "--json"]);
	});
	it("kills only direct startup handle if readiness fails", async () => {
		const f = fixture();
		f.deps.waitForReady = async () => {
			throw new Error("not ready");
		};
		// The original failure surfaces; a stop against a never-ready server would fail and mask it.
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow(/^not ready$/);
		expect(f.calls.some(args => args.includes("stop"))).toBe(false);
		expect(f.events).toEqual(["spawn", "kill", "release"]);
	});
	it("propagates pane failure and failed cleanup without launching another backend", async () => {
		const f = fixture();
		const run = f.deps.run!;
		f.deps.run = async (args, cwd, options) => {
			if (args.includes("run") || args.includes("stop")) {
				f.calls.push(args);
				return { ...ok, exitCode: 1, stderr: "unavailable" };
			}
			return run(args, cwd, options);
		};
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow(
			"cleanup failed; refusing another launch",
		);
		expect(f.calls.filter(args => args.includes("server") && !args.includes("status"))).toHaveLength(1);
		expect(f.events).not.toContain("kill");
	});
	it("uses bounded production readiness against the exact named server", async () => {
		const f = fixture();
		delete f.deps.waitForReady;
		let polls = 0;
		const run = f.deps.run!;
		f.deps.run = async (args, cwd, options) => {
			if (args.includes("status")) {
				f.calls.push(args);
				polls++;
				return { ...ok, stdout: JSON.stringify({ running: true, session: polls === 1 ? "default" : name }) };
			}
			return run(args, cwd, options);
		};
		await launchInteractiveTerminal(request, f.deps);
		expect(polls).toBe(2);
		expect(f.calls.filter(args => args.includes("status"))).toEqual(
			Array(2).fill([...scope, "status", "server", "--json"]),
		);
	});
	it("detects a server exit during startup with no sleeping test", async () => {
		const f = fixture();
		const blocked = Promise.withResolvers<void>();
		f.deps.waitForReady = () => blocked.promise;
		f.exit.resolve(1);
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow(
			/^PK-Herdr owned server exited during startup/,
		);
		expect(f.calls.some(args => args.includes("stop"))).toBe(false);
		expect(f.events).toContain("kill");
		blocked.resolve();
	});
	it("keeps the owned server running after the launching process exits", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ompk-herdr-detach-"));
		const marker = join(directory, "alive");
		try {
			const module = Bun.pathToFileURL(join(import.meta.dir, "../../src/terminal/launch.ts")).href;
			const server = [
				process.execPath,
				"--eval",
				"await Bun.sleep(1000); await Bun.write(process.argv[1], 'alive');",
				marker,
			];
			const launcher = Bun.spawn(
				[
					process.execPath,
					"--eval",
					`const { startServer } = await import(${JSON.stringify(module)});
(await startServer(${JSON.stringify(server)}, ${JSON.stringify(tmpdir())})).release();`,
				],
				{ stdout: "ignore", stderr: "pipe" },
			);
			expect(await launcher.exited, await new Response(launcher.stderr).text()).toBe(0);
			// The launcher is gone; only a detached server is still alive to write its marker.
			for (let attempt = 0; attempt < 100 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(100);
			expect(await Bun.file(marker).exists()).toBe(true);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 20_000);
	for (const cancelled of [false, true]) {
		it(`reconciles a committed caller tab after a lost receipt (cancelled=${cancelled})`, async () => {
			const f = fixture(caller);
			const controller = new AbortController();
			f.deps.signal = controller.signal;
			let label = "";
			let polls = 0;
			f.deps.run = async (args, cwd, options) => {
				expect(cwd).toBe(request.cwd);
				f.calls.push(args);
				if (args.includes("create")) {
					label = args[args.indexOf("--label") + 1]!;
					if (cancelled) controller.abort();
					throw new Error("creation receipt timed out");
				}
				if (args.includes("list")) {
					expect(options?.timeoutMs).toBe(2_000);
					polls++;
					return {
						...ok,
						stdout: JSON.stringify({
							id: "cli:tab:list",
							result: {
								type: "tab_list",
								tabs: [
									{ workspace_id: "w1", tab_id: "w1:t1", label: "User tab" },
									{ workspace_id: "w2", tab_id: "w2:t3", label },
									...(polls > 1 ? [{ workspace_id: "w1", tab_id: "w1:t7", label }] : []),
								],
							},
						}),
					};
				}
				return ok;
			};
			await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow("receipt timed out");
			expect(f.calls.filter(args => args.includes("create"))).toHaveLength(1);
			expect(f.calls.filter(args => args.includes("close"))).toEqual([["pk-herdr", "tab", "close", "w1:t7"]]);
			expect(polls).toBe(2);
		});
	}
	it("reports unreconciled ownership with its marker without closing unrelated tabs", async () => {
		const f = fixture(caller);
		f.deps.run = async args => {
			f.calls.push(args);
			return {
				...ok,
				stdout: args.includes("list")
					? JSON.stringify({
							result: { type: "tab_list", tabs: [{ workspace_id: "w1", tab_id: "w1:t1", label: "User tab" }] },
						})
					: "{}",
			};
		};
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow("ompk-owned:unique-123");
		expect(f.calls.filter(args => args.includes("list"))).toHaveLength(5);
		expect(f.calls.some(args => args.includes("close") || args.includes("stop"))).toBe(false);
	});
	it("separates bounded readiness probes from controls and the full stop protocol", async () => {
		const f = fixture();
		delete f.deps.waitForReady;
		const run = f.deps.run!;
		const budgets: Array<{ args: string[]; timeoutMs: number | undefined }> = [];
		f.deps.run = async (args, cwd, options) => {
			budgets.push({ args, timeoutMs: options?.timeoutMs });
			if (args.includes("status")) return { ...ok, stdout: JSON.stringify({ running: true, session: name }) };
			if (args.includes("run")) return { ...ok, exitCode: 1 };
			return run(args, cwd, options);
		};
		await expect(launchInteractiveTerminal(request, f.deps)).rejects.toThrow("pane launch failed");
		expect(budgets.find(entry => entry.args.includes("status"))?.timeoutMs).toBe(2_000);
		expect(budgets.filter(entry => !entry.args.includes("status")).every(entry => entry.timeoutMs === 20_000)).toBe(
			true,
		);
		expect(budgets.at(-1)?.args).toEqual(["pk-herdr", "session", "stop", name, "--json"]);
	});
});
