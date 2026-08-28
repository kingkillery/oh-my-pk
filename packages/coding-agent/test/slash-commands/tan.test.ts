import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { InteractiveModeContext } from "@pk-nerdsaver-ai/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime() {
	const handleTanCommand = vi.fn(async () => {});
	const setText = vi.fn();
	const addToHistory = vi.fn();
	return {
		handleTanCommand,
		setText,
		addToHistory,
		runtime: {
			ctx: {
				editor: { setText, addToHistory } as unknown as InteractiveModeContext["editor"],
				handleTanCommand,
				sessionManager: {
					getCwd: vi.fn(() => process.cwd()),
				} as unknown as InteractiveModeContext["sessionManager"],
				showError: vi.fn(),
				showStatus: vi.fn(),
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/tan slash command", () => {
	it("routes the full work item through the tan handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/tan add a changelog note", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleTanCommand).toHaveBeenCalledWith("add a changelog note", undefined);
	});

	it("preserves the raw multi-word suffix after /tan", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand(
			"/tan    investigate why prompt cache reuse matters here",
			harness.runtime,
		);

		expect(handled).toBe(true);
		expect(harness.handleTanCommand).toHaveBeenCalledWith(
			"investigate why prompt cache reuse matters here",
			undefined,
		);
	});

	it("resolves --cwd before routing to the tan handler", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/tan --cwd . check nearby files", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.handleTanCommand).toHaveBeenCalledWith("check nearby files", path.resolve(process.cwd(), "."));
	});

	it("handles a blank /tan invocation without error", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/tan   ", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.handleTanCommand).toHaveBeenCalledWith("");
	});
});
