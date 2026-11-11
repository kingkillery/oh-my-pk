import { watch } from "node:fs";
import * as path from "node:path";
import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { type ProviderSessionState, streamSimple } from "@pk-nerdsaver-ai/pi-ai";
import type { MuseCodeOptions } from "@pk-nerdsaver-ai/pi-ai/providers/muse-code";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { CursorExecHandlers } from "@pk-nerdsaver-ai/pi-coding-agent/cursor";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";
import { ReadTool } from "@pk-nerdsaver-ai/pi-coding-agent/tools/read";

const cwd = process.cwd();
const toolSession: ToolSession = {
	cwd,
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated(),
};
const read = new ReadTool(toolSession);
const executableRead: AgentTool = read as unknown as AgentTool;
const handlers = new CursorExecHandlers({ cwd, tools: new Map([["read", executableRead]]) });
const model = getBundledModel("meta-muse-code", "muse-wonder-full-1.0");
if (!model) throw new Error("Muse test model is missing");
const providerSessionState = new Map<string, ProviderSessionState>();
let resolutions = 0;
const options: MuseCodeOptions = {
	apiKey: () => {
		resolutions++;
		return "test-only-key";
	},
	museBin: path.join(cwd, "missing-muse-executable"),
	cursorExecHandlers: handlers,
	providerSessionState,
	cwd,
};
const roots = new Set<string>();
const observed = Promise.withResolvers<void>();
const watcher = watch(cwd, (_event, filename) => {
	if (filename?.startsWith("ompk-muse-")) {
		roots.add(filename);
		observed.resolve();
	}
});
try {
	const context = {
		systemPrompt: [],
		messages: [{ role: "user" as const, content: "test", timestamp: Date.now() }],
		tools: [read],
	};
	const results = await Promise.all([
		streamSimple(model, context, options).result(),
		streamSimple(model, context, options).result(),
	]);
	await observed.promise;
	if (
		results.some(result => result.stopReason !== "error") ||
		providerSessionState.size !== 0 ||
		resolutions !== 2 ||
		roots.size !== 1
	) {
		throw new Error("Concurrent failed Muse starts did not share one host or clean their session state");
	}
} finally {
	watcher.close();
}
