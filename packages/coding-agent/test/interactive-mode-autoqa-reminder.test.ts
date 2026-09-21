import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import { KeybindingsManager } from "@pk-nerdsaver-ai/pi-coding-agent/config/keybindings";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { HookSelectorComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/hook-selector";
import { InteractiveMode } from "@pk-nerdsaver-ai/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { resolveGitHubRepoSlug } from "@pk-nerdsaver-ai/pi-coding-agent/tools/report-tool-issue";
import { ProcessTerminal, setKeybindings } from "@pk-nerdsaver-ai/pi-tui";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

/**
 * Regression: the launch Auto-QA reminder popup rendered but ignored every
 * key. `#maybeShowAutoQaLaunchReminder` fires a detached task at the top of
 * `init()`; when `resolveGitHubRepoSlug` settles before the editor slot is
 * mounted, `showHookSelector` presents into a not-yet-attached container and
 * the unconditional `ui.setFocus(this.editor)` later in `init()` hands input
 * routing to the unmounted editor — the visible selector never receives
 * arrows or Esc. These tests drive the real TUI input path (captured
 * `terminal.start` onInput → `TUI.#handleInput` → focused component), not
 * component-level `handleInput` calls.
 */

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

/** Yield event-loop turns (not wall-clock) until `predicate` holds. The
 *  reminder presents off promise continuations, so a bounded number of
 *  macrotask turns is deterministic; exceeding the bound means it never
 *  appeared — a real failure, not a slow timer. */
async function waitForTurns(predicate: () => boolean, maxTurns = 200): Promise<void> {
	for (let i = 0; i < maxTurns; i++) {
		if (predicate()) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
	throw new Error("condition never became true");
}

describe("InteractiveMode auto-QA launch reminder", () => {
	let tempDir: TempDir;
	let sharedTempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let mode: InteractiveMode;
	let sendInput: (data: string) => void;

	beforeAll(async () => {
		initTheme();
		setKeybindings(KeybindingsManager.inMemory());
		sharedTempDir = TempDir.createSync("@pi-autoqa-reminder-shared-");
		await Settings.init({ inMemory: true, cwd: sharedTempDir.path() });
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}
		// init() warms the local collector; keep that spawn from ever reaching a
		// real ompk-collector binary while letting other spawns (git probe) run.
		const realSpawn = Bun.spawn.bind(Bun);
		vi.spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
			const argv = Array.isArray(args[0]) ? args[0] : [];
			if (argv.some(a => String(a).includes("ompk-collector"))) {
				throw new Error("collector spawn blocked in test");
			}
			return realSpawn(...args);
		}) as typeof Bun.spawn);

		// Capture the real TUI input handler so tests inject keys through the
		// same path a terminal would (terminal.start → TUI.#handleInput).
		vi.spyOn(ProcessTerminal.prototype, "start").mockImplementation(function (
			this: ProcessTerminal,
			onInput: (data: string) => void,
		) {
			sendInput = onInput;
		});

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-autoqa-reminder-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("dev.autoqa", true);

		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

		// Warm the per-cwd slug cache so the reminder's only async step resolves
		// in a microtask — the pre-fix race then presents the selector before
		// init() mounts/focuses the editor slot, deterministically.
		await resolveGitHubRepoSlug(tempDir.path());
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		tempDir?.removeSync();
	});

	it("keeps the reminder selector focused through init so arrows and Enter reach it", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await waitForTurns(() => mode.hookSelector instanceof HookSelectorComponent);

		// The visible popup must own keyboard focus — not the editor it replaced.
		expect(mode.ui.getFocused()).toBe(mode.hookSelector ?? null);

		// Down + Enter selects the second option ("Stop these reminders"),
		// proving arrow routing reaches the selector. The settings write lands
		// in the reminder continuation after the dialog settles, so wait on the
		// effect itself rather than the selector disappearing.
		sendInput(DOWN);
		sendInput(ENTER);
		await waitForTurns(() => mode.hookSelector === undefined);
		await waitForTurns(() => Settings.instance.get("dev.autoqa.reminders") === false);
		// `dev.autoqa` reads back as its subtree once a child key is set; the
		// collection leaf is only disabled by an explicit `false`.
		expect(Settings.instance.get("dev.autoqa")).not.toBe(false);
		// Dialog teardown restores focus to the remounted editor.
		expect(mode.ui.getFocused()).toBe(mode.editor);
		expect(mode.editorContainer.children.includes(mode.editor)).toBe(true);
	});

	it("Esc dismisses the reminder without changing collection settings", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		await waitForTurns(() => mode.hookSelector instanceof HookSelectorComponent);
		expect(mode.ui.getFocused()).toBe(mode.hookSelector ?? null);

		sendInput(ESC);
		await waitForTurns(() => mode.hookSelector === undefined);
		expect(Settings.instance.get("dev.autoqa")).not.toBe(false);
		expect(Settings.instance.get("dev.autoqa.reminders")).toBe(true);
		expect(Settings.instance.get("dev.autoqa.autoFile")).toBe(false);
		expect(mode.ui.getFocused()).toBe(mode.editor);
	});
});
