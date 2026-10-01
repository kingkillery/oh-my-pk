import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { InteractiveMode } from "@pk-nerdsaver-ai/pi-coding-agent/modes/interactive-mode";
import * as loopSynthesis from "@pk-nerdsaver-ai/pi-coding-agent/modes/loop-synthesis";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

// Contract: spiral loop mode runs a verifier/synthesis pass between iterations,
// keeps the objective immutable while appending the reflection, stops on a
// completeness verdict, and stops when progress stalls.
describe("InteractiveMode spiral loop mode", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-loop-spiral-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		mode.ui.requestRender = vi.fn();
		settings.set("loop.mode", "spiral");
		// Idle session so the auto-submit path is never blocked.
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => false });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => false });
		Object.defineProperty(session, "hasPostPromptWork", { configurable: true, get: () => false });
	});

	afterEach(async () => {
		mode?.disableLoopMode("Loop mode disabled.");
		mode?.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	/** Drive exactly one spiral iteration; returns the submitted input, if any. */
	async function runIteration(): Promise<SubmittedUserInput | undefined> {
		let resolved: SubmittedUserInput | undefined;
		void mode.getUserInput().then(input => {
			resolved = input;
		});
		vi.advanceTimersByTime(800); // fire #runLoopIteration
		await flushMicrotasks(); // settle the async synthesis + submit
		return resolved;
	}

	it("appends the synthesized reflection while keeping the objective immutable", async () => {
		vi.useFakeTimers();
		const synth = vi
			.spyOn(loopSynthesis, "runLoopSynthesis")
			.mockResolvedValue({ complete: false, reflection: "Done step 1; next do step 2." });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "Finish the migration.";

		const submitted = await runIteration();

		expect(synth).toHaveBeenCalledTimes(1);
		expect(synth.mock.calls[0]?.[1]).toMatchObject({ objective: "Finish the migration." });
		expect(submitted?.text).toBe(
			loopSynthesis.composeSpiralPrompt("Finish the migration.", "Done step 1; next do step 2."),
		);
		// The submitted text carries the reflection but the loop objective is unchanged.
		expect(submitted?.text).toContain("Finish the migration.");
		expect(submitted?.text).toContain("Done step 1; next do step 2.");
		expect(mode.loopPrompt).toBe("Finish the migration.");
		expect(mode.loopModeEnabled).toBe(true);
	});

	it("stops the loop when the verifier reports the objective complete", async () => {
		vi.useFakeTimers();
		vi.spyOn(loopSynthesis, "runLoopSynthesis").mockResolvedValue({ complete: true, reflection: "All done." });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "Finish the migration.";

		const submitted = await runIteration();

		expect(submitted).toBeUndefined();
		expect(mode.loopModeEnabled).toBe(false);
	});

	it("stops the loop after the reflection repeats unchanged across iterations", async () => {
		vi.useFakeTimers();
		vi.spyOn(loopSynthesis, "runLoopSynthesis").mockResolvedValue({
			complete: false,
			reflection: "Still blocked on the same failing test.",
		});

		mode.loopModeEnabled = true;
		mode.loopPrompt = "Fix the flaky test.";

		// Iterations 1 and 2 still submit (stall count 0 then 1).
		expect(await runIteration()).toBeDefined();
		expect(mode.loopModeEnabled).toBe(true);
		expect(await runIteration()).toBeDefined();
		expect(mode.loopModeEnabled).toBe(true);

		// Third identical reflection trips the no-progress guard: loop stops.
		const third = await runIteration();
		expect(third).toBeUndefined();
		expect(mode.loopModeEnabled).toBe(false);
	});

	it("stops the loop when the synthesizer keeps returning an empty reflection", async () => {
		vi.useFakeTimers();
		// An empty reflection is a first-class synthesizer output, not a pathological
		// one: parseSynthesisPayload coerces a missing or non-string reflection to "",
		// and RESPOND_TOOL is non-strict so `reflection` is advisory. Because
		// composeSpiralPrompt returns the objective unchanged for it, each iteration
		// re-submits a byte-identical prompt: that is a no-progress signal.
		vi.spyOn(loopSynthesis, "runLoopSynthesis").mockResolvedValue({ complete: false, reflection: "" });

		mode.loopModeEnabled = true;
		mode.loopPrompt = "Finish the migration.";

		// Iterations 1 and 2 still submit (stall count 0 then 1).
		expect(await runIteration()).toBeDefined();
		expect(mode.loopModeEnabled).toBe(true);
		expect(await runIteration()).toBeDefined();
		expect(mode.loopModeEnabled).toBe(true);

		// Third consecutive empty reflection trips the no-progress guard: loop stops.
		const third = await runIteration();
		expect(third).toBeUndefined();
		expect(mode.loopModeEnabled).toBe(false);
	});

	it("degrades to a plain re-submit when synthesis fails", async () => {
		vi.useFakeTimers();
		vi.spyOn(loopSynthesis, "runLoopSynthesis").mockRejectedValue(new Error("no api key"));

		mode.loopModeEnabled = true;
		mode.loopPrompt = "Keep going.";

		const submitted = await runIteration();

		// Failure must not silently kill the loop: it re-submits the bare objective.
		expect(submitted?.text).toBe("Keep going.");
		expect(mode.loopModeEnabled).toBe(true);
	});
});

describe("composeSpiralPrompt", () => {
	it("wraps the reflection in a delimited block after the objective", () => {
		const out = loopSynthesis.composeSpiralPrompt("Objective text", "Reflection text");
		expect(out).toBe(
			`Objective text\n\n${loopSynthesis.LOOP_SPIRAL_BLOCK_OPEN}\nReflection text\n${loopSynthesis.LOOP_SPIRAL_BLOCK_CLOSE}`,
		);
	});

	it("returns the objective unchanged when there is no reflection", () => {
		expect(loopSynthesis.composeSpiralPrompt("Objective text", "")).toBe("Objective text");
		expect(loopSynthesis.composeSpiralPrompt("Objective text", "   ")).toBe("Objective text");
	});
});
