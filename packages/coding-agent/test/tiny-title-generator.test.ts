import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import * as ai from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { isSubcommand } from "@pk-nerdsaver-ai/pi-coding-agent/cli-commands";
import { getDefault, getEnumValues, getUi } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings-schema";
import { TinyTitleDownloadProgressComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/tiny-title-download-progress";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import type { RefCountedWorkerHandle } from "@pk-nerdsaver-ai/pi-coding-agent/subprocess/worker-client";
import {
	TINY_MODEL_DEVICE_DEFAULT,
	TINY_MODEL_DEVICE_SETTING_OPTIONS,
	TINY_MODEL_DEVICE_SETTING_VALUES,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/device";
import {
	TINY_MODEL_DTYPE_DEFAULT,
	TINY_MODEL_DTYPE_SETTING_OPTIONS,
	TINY_MODEL_DTYPE_SETTING_VALUES,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/dtype";
import {
	ONLINE_TINY_TITLE_MODEL_KEY,
	TINY_TITLE_MODEL_OPTIONS,
	TINY_TITLE_MODEL_VALUES,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/models";
import {
	boundCompletionPrompt,
	boundTitleMessage,
	MAX_TITLE_INPUT_CHARS,
	truncateToTokenBudget,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/text";
import {
	createTinyTitleSubprocess,
	TinyTitleClient,
	tinyTitleClient,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/title-client";
import type {
	TinyTitleWorkerInbound,
	TinyTitleWorkerOutbound,
} from "@pk-nerdsaver-ai/pi-coding-agent/tiny/title-protocol";
import { generateSessionTitle } from "@pk-nerdsaver-ai/pi-coding-agent/utils/title-generator";
import type { Subprocess } from "bun";

function getModelOrThrow(id: string): Model<Api> {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(model: Model<Api>, tinyModel: string) {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return tinyModel;
			return undefined;
		},
		getModelRole(role: string) {
			return role === "smol" ? `${model.provider}/${model.id}` : undefined;
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		resolver: vi.fn(() => async () => "test-key"),
	} as never;
}

type TinyWorkerSpawnOptions = Bun.SpawnOptions.SpawnOptions<"ignore", "ignore", "ignore">;

type TinyWorkerSpawnCall = {
	options: TinyWorkerSpawnOptions & { cmd: string[] };
};

function createTinyWorkerSpawnMock(calls: TinyWorkerSpawnCall[]) {
	function mockSpawn(options: TinyWorkerSpawnOptions & { cmd: string[] }): Subprocess<"ignore", "ignore", "ignore">;
	function mockSpawn(cmd: string[], options?: TinyWorkerSpawnOptions): Subprocess<"ignore", "ignore", "ignore">;
	function mockSpawn(
		first: string[] | (TinyWorkerSpawnOptions & { cmd: string[] }),
		second?: TinyWorkerSpawnOptions,
	): Subprocess<"ignore", "ignore", "ignore"> {
		const options = Array.isArray(first) ? { ...(second ?? {}), cmd: first } : first;
		calls.push({ options });
		return {
			pid: 12345,
			send: () => undefined,
			kill: () => true,
			unref: () => undefined,
			exited: Promise.resolve(0),
		} as unknown as Subprocess<"ignore", "ignore", "ignore">;
	}

	return mockSpawn;
}

function mockOnlineTitle(title: string | null) {
	return vi.spyOn(ai, "completeSimple").mockResolvedValue({
		stopReason: "stop",
		content: title
			? [
					{
						type: "toolCall",
						id: "call-title",
						name: "set_title",
						arguments: { title },
					},
				]
			: [{ type: "text", text: "" }],
	} as never);
}

beforeAll(() => {
	initTheme();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("tiny title generator routing", () => {
	it("keeps online-only behavior when Tiny Model is Online", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "online"),
		);

		expect(title).toBe("Online Title");
		expect(local).not.toHaveBeenCalled();
		expect(online).toHaveBeenCalledTimes(1);
	});

	it("uses the local client for selected local models", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
		);

		expect(title).toBe("Local Title");
		expect(local).toHaveBeenCalledWith("lfm2-350m", "Investigate routing");
		expect(online).not.toHaveBeenCalled();
	});

	it("passes the resolved TITLE_SYSTEM.md prompt to the local client", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const customPrompt = "Generate lowercase colon-delimited session names.";
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Local Title");
		const online = mockOnlineTitle("Online Title");

		const title = await generateSessionTitle(
			"Investigate routing",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
			undefined,
			undefined,
			undefined,
			customPrompt,
		);

		expect(title).toBe("Local Title");
		expect(local).toHaveBeenCalledWith("lfm2-350m", "Investigate routing", { systemPrompt: customPrompt });
		expect(online).not.toHaveBeenCalled();
	});

	it("does NOT fall back to online when local returns null (issue #3187)", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue(null);
		const online = mockOnlineTitle("Billed Online Title");

		const title = await generateSessionTitle(
			"Investigate fallback",
			createRegistry(model),
			createSettings(model, "lfm2-350m"),
		);

		expect(title).toBeNull();
		expect(local).toHaveBeenCalledTimes(1);
		expect(online).not.toHaveBeenCalled();
	});

	it("does NOT fall back to online when local throws", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		vi.spyOn(tinyTitleClient, "generate").mockRejectedValue(new Error("worker crashed"));
		const online = mockOnlineTitle("Billed Online Title");

		const title = await generateSessionTitle(
			"Investigate crash",
			createRegistry(model),
			createSettings(model, "lfm2-700m"),
		);

		expect(title).toBeNull();
		expect(online).not.toHaveBeenCalled();
	});

	it("does NOT call the local worker or online path for an unknown tinyModel key", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const local = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Late Local");
		const online = mockOnlineTitle("Billed Online Title");

		const title = await generateSessionTitle(
			"Investigate unknown",
			createRegistry(model),
			createSettings(model, "ollama:gpt-oss"),
		);

		expect(title).toBeNull();
		expect(local).not.toHaveBeenCalled();
		expect(online).not.toHaveBeenCalled();
	});
});

describe("tiny title subprocess", () => {
	it("does not inherit worker output into the interactive terminal", async () => {
		const calls: TinyWorkerSpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createTinyWorkerSpawnMock(calls));

		const worker = createTinyTitleSubprocess();

		expect(calls).toHaveLength(1);
		expect(calls[0]?.options.stdout).toBe("ignore");
		expect(calls[0]?.options.stderr).toBe("ignore");
		await worker.proc.exited;
	});
});

describe("providers.tinyModel schema", () => {
	it("keeps enum values and UI options in sync with the tiny model registry", () => {
		expect(getEnumValues("providers.tinyModel")).toEqual([...TINY_TITLE_MODEL_VALUES]);
		expect(getUi("providers.tinyModel")?.options).toEqual(TINY_TITLE_MODEL_OPTIONS);
		expect(getDefault("providers.tinyModel")).toBe(ONLINE_TINY_TITLE_MODEL_KEY);
	});
});

describe("tiny model acceleration schema", () => {
	it("keeps the device setting in sync with the device module constants", () => {
		expect(getEnumValues("providers.tinyModelDevice")).toEqual([...TINY_MODEL_DEVICE_SETTING_VALUES]);
		expect(getUi("providers.tinyModelDevice")?.options).toEqual(TINY_MODEL_DEVICE_SETTING_OPTIONS);
		expect(getDefault("providers.tinyModelDevice")).toBe(TINY_MODEL_DEVICE_DEFAULT);
	});

	it("keeps the precision setting in sync with the dtype module constants", () => {
		expect(getEnumValues("providers.tinyModelDtype")).toEqual([...TINY_MODEL_DTYPE_SETTING_VALUES]);
		expect(getUi("providers.tinyModelDtype")?.options).toEqual(TINY_MODEL_DTYPE_SETTING_OPTIONS);
		expect(getDefault("providers.tinyModelDtype")).toBe(TINY_MODEL_DTYPE_DEFAULT);
	});
});

describe("tiny title download progress UI", () => {
	it("renders progress updates and completion state", () => {
		const component = new TinyTitleDownloadProgressComponent("lfm2-700m");
		component.update({
			modelKey: "lfm2-700m",
			status: "progress_total",
			name: "onnx-community/LFM2-700M-ONNX",
			progress: 50,
			loaded: 50,
			total: 100,
			files: {},
		});
		expect(component.render(80).join("\n")).toContain("LFM2 700M");
		expect(component.isComplete()).toBe(false);
		component.update({ modelKey: "lfm2-700m", status: "ready", task: "text-generation", model: "repo" });
		expect(component.isComplete()).toBe(true);
	});
});

describe("tiny-models CLI", () => {
	it("registers tiny-models as a top-level subcommand", () => {
		expect(isSubcommand("tiny-models")).toBe(true);
	});
});

describe("tiny worker input bounding", () => {
	const countChars = (text: string) => text.length;

	it("truncateToTokenBudget keeps input that fits", () => {
		expect(truncateToTokenBudget("short message", 20, countChars)).toBe("short message");
	});

	it("truncateToTokenBudget keeps the head and stays within budget", () => {
		const input = "a".repeat(500);
		const result = truncateToTokenBudget(input, 100, countChars);
		expect(countChars(result)).toBeLessThanOrEqual(100);
		expect(result.endsWith("…")).toBe(true);
		expect(input.startsWith(result.slice(0, -1))).toBe(true);
	});

	it("truncateToTokenBudget keeps head and tail when a tail window is requested", () => {
		const input = `${"h".repeat(300)}${"m".repeat(400)}${"t".repeat(300)}`;
		const result = truncateToTokenBudget(input, 200, countChars, 80);
		expect(result.startsWith("h".repeat(50))).toBe(true);
		expect(result.endsWith("t".repeat(50))).toBe(true);
		expect(result).toContain("[…]");
		expect(result.length).toBeLessThan(input.length);
	});

	it("truncateToTokenBudget never splits a surrogate pair", () => {
		const input = `ab${"😀".repeat(100)}`;
		const result = truncateToTokenBudget(input, 5, countChars);
		expect(result).toBe("ab😀…");
		expect(result).not.toContain("\uFFFD");
		expect(/[\uD800-\uDBFF]$/.test(result.slice(0, -1))).toBe(false);
	});
	it("truncateToTokenBudget degrades to a char bound when the counter throws", () => {
		const input = "x".repeat(1000);
		const result = truncateToTokenBudget(input, 10, () => {
			throw new Error("tokenizer exploded");
		});
		expect(result.length).toBeLessThanOrEqual(41);
		expect(result.endsWith("…")).toBe(true);
	});

	it("boundTitleMessage leaves normal messages untouched", () => {
		expect(boundTitleMessage("Investigate the flaky test", countChars)).toBe("Investigate the flaky test");
	});

	it("boundTitleMessage bounds oversized input and keeps the substantive head", () => {
		const input = `Refactor the tokenizer pipeline ${"z".repeat(50_000)}`;
		const result = boundTitleMessage(input, countChars);
		expect(result.length).toBeLessThanOrEqual(MAX_TITLE_INPUT_CHARS + 1);
		expect(result.startsWith("Refactor the tokenizer pipeline")).toBe(true);
	});

	it("boundCompletionPrompt bounds oversized prompts and keeps head plus tail", () => {
		const input = `HEAD-INSTRUCTIONS ${"y".repeat(50_000)} TAIL-CONTEXT`;
		const result = boundCompletionPrompt(input, countChars);
		expect(result.length).toBeLessThanOrEqual(8192 + 32);
		expect(result.startsWith("HEAD-INSTRUCTIONS")).toBe(true);
		expect(result.endsWith("TAIL-CONTEXT")).toBe(true);
		expect(result).toContain("[…]");
	});
});

describe("tiny client pre-IPC bounding", () => {
	function createFakeWorker(
		sent: TinyTitleWorkerInbound[],
		respond?: (message: TinyTitleWorkerInbound, reply: (outbound: TinyTitleWorkerOutbound) => void) => void,
	): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
		let handler: ((message: TinyTitleWorkerOutbound) => void) | undefined;
		return {
			send(message) {
				sent.push(message);
				if (handler && respond) respond(message, outbound => handler?.(outbound));
			},
			onMessage(h) {
				handler = h;
				return () => {
					handler = undefined;
				};
			},
			onError() {
				return () => undefined;
			},
			async terminate() {},
		};
	}

	it("bounds an oversized title message before it reaches the worker", async () => {
		const sent: TinyTitleWorkerInbound[] = [];
		const client = new TinyTitleClient(() =>
			createFakeWorker(sent, (message, reply) => {
				if (message.type === "generate") reply({ type: "title", id: message.id, title: "Bounded Title" });
			}),
		);
		try {
			const input = `Summarize the migration plan ${"q".repeat(200_000)}`;
			const title = await client.generate("lfm2-350m", input);
			expect(title).toBe("Bounded Title");
			expect(sent).toHaveLength(1);
			const request = sent[0];
			if (request?.type !== "generate") throw new Error("expected a generate request");
			expect(request.message.length).toBeLessThanOrEqual(MAX_TITLE_INPUT_CHARS + 1);
			expect(request.message.length).toBeLessThan(input.length);
			expect(request.message.startsWith("Summarize the migration plan")).toBe(true);
		} finally {
			await client.terminate();
		}
	});

	it("bounds an oversized completion prompt before it reaches the worker", async () => {
		const sent: TinyTitleWorkerInbound[] = [];
		const client = new TinyTitleClient(() =>
			createFakeWorker(sent, (message, reply) => {
				if (message.type === "complete") reply({ type: "completion", id: message.id, text: "done" });
			}),
		);
		try {
			const input = `HEAD-INSTRUCTIONS ${"y".repeat(200_000)} TAIL-CONTEXT`;
			const text = await client.complete("lfm2-1.2b", input);
			expect(text).toBe("done");
			expect(sent).toHaveLength(1);
			const request = sent[0];
			if (request?.type !== "complete") throw new Error("expected a complete request");
			expect(request.prompt.length).toBeLessThan(60_000);
			expect(request.prompt.startsWith("HEAD-INSTRUCTIONS")).toBe(true);
			expect(request.prompt.endsWith("TAIL-CONTEXT")).toBe(true);
		} finally {
			await client.terminate();
		}
	});

	it("resolves null instead of throwing when the worker reports an error", async () => {
		const sent: TinyTitleWorkerInbound[] = [];
		const client = new TinyTitleClient(() =>
			createFakeWorker(sent, (message, reply) => {
				if (message.type === "generate") reply({ type: "error", id: message.id, error: "boom" });
			}),
		);
		try {
			const title = await client.generate("lfm2-350m", "Investigate the outage");
			expect(title).toBeNull();
		} finally {
			await client.terminate();
		}
	});

	it("resolves null instead of throwing when worker send fails", async () => {
		const client = new TinyTitleClient(() => ({
			send() {
				throw new Error("worker gone");
			},
			onMessage() {
				return () => undefined;
			},
			onError() {
				return () => undefined;
			},
			async terminate() {},
		}));
		try {
			const title = await client.generate("lfm2-350m", "Investigate the outage");
			expect(title).toBeNull();
		} finally {
			await client.terminate();
		}
	});

	it("spawns a fresh worker after a worker error and never replays the failed request", async () => {
		const spawns: { sent: TinyTitleWorkerInbound[]; fireError: (error: Error) => void }[] = [];
		const client = new TinyTitleClient(() => {
			const sent: TinyTitleWorkerInbound[] = [];
			const spawn = { sent, fireError: (_error: Error) => {} };
			spawns.push(spawn);
			let messageHandler: ((message: TinyTitleWorkerOutbound) => void) | undefined;
			let errorHandler: ((error: Error) => void) | undefined;
			spawn.fireError = error => errorHandler?.(error);
			return {
				send(message) {
					sent.push(message);
					if (spawns.length === 2 && message.type === "generate") {
						messageHandler?.({ type: "title", id: message.id, title: "Recovered Title" });
					}
				},
				onMessage(handler) {
					messageHandler = handler;
					return () => {
						messageHandler = undefined;
					};
				},
				onError(handler) {
					errorHandler = handler;
					return () => {
						errorHandler = undefined;
					};
				},
				async terminate() {},
			};
		});
		try {
			const first = client.generate("lfm2-350m", "first request");
			expect(spawns).toHaveLength(1);
			expect(spawns[0]?.sent).toHaveLength(1);
			spawns[0]?.fireError(new Error("daemon socket closed"));
			expect(await first).toBeNull();

			expect(await client.generate("lfm2-350m", "second request")).toBe("Recovered Title");
			expect(spawns).toHaveLength(2);
			expect(spawns[1]?.sent.map(m => (m.type === "generate" ? m.message : m.type))).toEqual(["second request"]);
		} finally {
			await client.terminate();
		}
	});

	it("handles empty and whitespace-only input without throwing", async () => {
		const sent: TinyTitleWorkerInbound[] = [];
		const client = new TinyTitleClient(() =>
			createFakeWorker(sent, (message, reply) => {
				if (message.type === "generate") reply({ type: "title", id: message.id, title: null });
			}),
		);
		try {
			expect(await client.generate("lfm2-350m", "")).toBeNull();
			expect(await client.generate("lfm2-350m", "   \n\t  ")).toBeNull();
		} finally {
			await client.terminate();
		}
	});
});
