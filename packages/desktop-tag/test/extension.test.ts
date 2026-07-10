import { describe, expect, it, mock } from "bun:test";

import desktopTagExtension from "../src/extension";
import type { ExtensionAPI } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";

function createFakeApi(): ExtensionAPI {
	return {
		setLabel: mock(() => {}),
		registerCommand: mock(() => {}),
		registerShortcut: mock(() => {}),
		registerTool: mock(() => {}),
		registerFlag: mock(() => {}),
		getFlag: mock(() => undefined),
		on: mock(() => {}),
		sendMessage: mock(() => {}),
		sendUserMessage: mock(() => {}),
		appendEntry: mock(() => {}),
		getActiveTools: mock(() => []),
		setActiveTools: mock(() => {}),
	} as unknown as ExtensionAPI;
}

describe("desktopTagExtension", () => {
	it("registers command and shortcut", () => {
		const api = createFakeApi();
		desktopTagExtension(api);

		expect(api.setLabel).toHaveBeenCalledWith("Desktop Tag");
		expect(api.registerCommand).toHaveBeenCalled();
		expect(api.registerShortcut).toHaveBeenCalled();
	});
});
