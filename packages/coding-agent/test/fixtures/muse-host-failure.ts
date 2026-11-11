import { watch } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
	if (filename?.startsWith("ompk-muse-") && !roots.has(filename)) {
		roots.add(filename);
		observed.resolve();
	}
});
const sharedState = new Map<string, ProviderSessionState>();
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

	const failedRoots = new Set(roots);
	const abort = new AbortController();
	const echoOptions: MuseCodeOptions = {
		...options,
		apiKey: "test-only-key",
		museBin: undefined,
		museProvider: "echo",
		providerSessionState: sharedState,
	};
	const first = streamSimple(model, context, { ...echoOptions, signal: abort.signal }).result();
	const rootDeadline = Date.now() + 10_000;
	let sharedRoot: string | undefined;
	while (!sharedRoot && Date.now() < rootDeadline) {
		sharedRoot = (await readdir(cwd)).find(name => name.startsWith("ompk-muse-") && !failedRoots.has(name));
		if (sharedRoot) roots.add(sharedRoot);
		else await delay(10);
	}
	if (!sharedRoot) throw new Error("Timed out observing the shared Muse host root");
	const secondKey = Promise.withResolvers<string>();
	const secondOptions: MuseCodeOptions = { ...echoOptions, apiKey: () => secondKey.promise };
	const second = streamSimple(model, context, secondOptions).result();
	abort.abort();
	secondKey.resolve("test-only-key");
	const [aborted, completed] = await Promise.all([first, second]);
	if (
		aborted.stopReason !== "aborted" ||
		completed.stopReason !== "stop" ||
		sharedState.size !== 1 ||
		[...roots].length !== 2
	) {
		throw new Error("Aborting the creating caller cancelled its concurrent Muse sibling or created another host");
	}
} finally {
	for (const state of sharedState.values()) await state.close();
	sharedState.clear();
	watcher.close();
}
