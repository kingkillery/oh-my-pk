import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-ai";
import { ModelRegistry } from "../../src/config/model-registry";
import { ModelsConfigFile } from "../../src/config/models-config";
import type { ModelsConfig } from "../../src/config/models-config-schema";
import {
	extractModelIds,
	fetchEndpointModels,
	formatCustomProvider,
	handleInferenceProviderSlashCommand,
	listCustomProviderNames,
	loadModelsConfig,
	modelEndpointCandidates,
	normalizeEndpoint,
	parseProviderCommandArgs,
	removeProviderEntry,
	resolveProviderBaseUrl,
	upsertProviderEntry,
	validateProviderName,
	writeModelsConfig,
} from "../../src/slash-commands/helpers/inference-provider";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

describe("inference provider helpers", () => {
	it("rejects names that collide with built-in providers", () => {
		expect(validateProviderName("anthropic").ok).toBe(false);
		expect(validateProviderName("ollama").ok).toBe(false);
		expect(validateProviderName("").ok).toBe(false);
		expect(validateProviderName("bad name").ok).toBe(false);
		const valid = validateProviderName("my-inference");
		expect(valid.ok).toBe(true);
	});

	it("normalizes endpoints and rejects non-http schemes", () => {
		const ok = normalizeEndpoint("https://api.example.com/v1/");
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.baseUrl).toBe("https://api.example.com/v1");
		expect(normalizeEndpoint("not-a-url").ok).toBe(false);
		expect(normalizeEndpoint("ftp://example.com").ok).toBe(false);
	});

	it("probes the /models endpoint next to the base URL", () => {
		expect(modelEndpointCandidates("https://api.example.com/v1")).toEqual(["https://api.example.com/v1/models"]);
		expect(modelEndpointCandidates("https://api.example.com")).toEqual([
			"https://api.example.com/models",
			"https://api.example.com/v1/models",
		]);
	});

	it("extracts model ids from OpenAI- and Anthropic-style payloads", () => {
		expect(extractModelIds({ data: [{ id: "a" }, { id: "b" }, { id: "a" }] })).toEqual(["a", "b"]);
		expect(extractModelIds({ models: [{ name: "c" }] })).toEqual(["c"]);
		expect(extractModelIds("nope")).toEqual([]);
	});

	it("loads models from a /models endpoint", async () => {
		const fetchImpl = (async (url: string) => {
			expect(url).toBe("https://api.example.com/v1/models");
			return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), { status: 200 });
		}) as unknown as typeof fetch;
		const result = await fetchEndpointModels("https://api.example.com/v1", { fetchImpl });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.models.ids).toEqual(["m1", "m2"]);
			expect(result.models.discoveryBaseUrl).toBe("https://api.example.com/v1");
		}
	});

	it("reports failure when no /models endpoint answers", async () => {
		const fetchImpl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
		const result = await fetchEndpointModels("https://api.example.com/v1", { fetchImpl });
		expect(result.ok).toBe(false);
	});

	it("keeps the /v1 suffix for OpenAI and strips it for Anthropic", () => {
		expect(resolveProviderBaseUrl("https://api.example.com/v1", "openai-completions")).toBe(
			"https://api.example.com/v1",
		);
		expect(resolveProviderBaseUrl("https://api.example.com/v1", "anthropic-messages")).toBe(
			"https://api.example.com",
		);
		expect(resolveProviderBaseUrl("https://api.example.com", "openai-completions")).toBe(
			"https://api.example.com/v1",
		);
	});

	it("parses add/edit argument tails", () => {
		const add = parseProviderCommandArgs("add", "my-api https://api.example.com/v1 --api anthropic --key sk-1");
		expect(add.error).toBeUndefined();
		expect(add.name).toBe("my-api");
		expect(add.endpoint).toBe("https://api.example.com/v1");
		expect(add.api).toBe("anthropic-messages");
		expect(add.apiKey).toBe("sk-1");

		const missing = parseProviderCommandArgs("add", "my-api");
		expect(missing.error).toBeDefined();

		const models = parseProviderCommandArgs("edit", "my-api --models a,b");
		expect(models.models).toEqual(["a", "b"]);

		const unknown = parseProviderCommandArgs("edit", "my-api --bogus");
		expect(unknown.error).toBeDefined();
	});

	it("lists only non built-in providers", () => {
		const config: ModelsConfig = {
			providers: {
				anthropic: { api: "openai-completions" },
				"my-api": { api: "openai-completions" },
			},
		};
		expect(listCustomProviderNames(config)).toEqual(["my-api"]);
	});

	it("upserts and removes provider entries without losing other config", () => {
		const base = {
			providers: { keep: { baseUrl: "https://keep.example.com/v1" } },
			equivalence: { overrides: { "a/b": "c" } },
		};
		const withProvider = upsertProviderEntry(base, {
			name: "my-api",
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			models: ["m1"],
		});
		expect(withProvider.providers?.["my-api"]?.models?.[0]?.id).toBe("m1");
		expect(withProvider.providers?.keep).toBeDefined();
		expect(withProvider.equivalence?.overrides?.["a/b"]).toBe("c");

		const removed = removeProviderEntry(withProvider, "my-api");
		expect(removed.providers?.["my-api"]).toBeUndefined();
		expect(removed.providers?.keep).toBeDefined();
	});

	it("formats a provider summary", () => {
		const text = formatCustomProvider(
			{
				providers: {
					"my-api": { baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [{ id: "m1" }] },
				},
			},
			"my-api",
		);
		expect(text).toContain("my-api");
		expect(text).toContain("https://api.example.com/v1");
		expect(text).toContain("m1");
	});
});

describe("/inference-provider command lifecycle", () => {
	let directory: string;
	let modelsPath: string;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let outputs: string[];
	let runtime: SlashCommandRuntime;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "inference-provider-"));
		modelsPath = join(directory, "models.json");
		await Bun.write(modelsPath, JSON.stringify({ providers: {} }));
		authStorage = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(authStorage, modelsPath);
		outputs = [];
		runtime = {
			output: async (text: string) => {
				outputs.push(text);
			},
			session: { modelRegistry: registry },
		} as unknown as SlashCommandRuntime;
	});

	afterEach(async () => {
		authStorage.close();
		await rm(directory, { recursive: true, force: true });
	});

	async function run(args: string) {
		return handleInferenceProviderSlashCommand(
			{ name: "inference-provider", args, text: `/inference-provider ${args}` },
			runtime,
		);
	}

	it("adds a provider with explicit models", async () => {
		await run("add my-api https://api.example.com/v1 --models m1,m2");
		const written = JSON.parse(await Bun.file(modelsPath).text());
		expect(written.providers["my-api"].baseUrl).toBe("https://api.example.com/v1");
		expect(written.providers["my-api"].api).toBe("openai-completions");
		expect(written.providers["my-api"].models.map((m: { id: string }) => m.id)).toEqual(["m1", "m2"]);
		expect(outputs.join("\n")).toContain("Added custom inference provider");
	});

	it("rejects a name that collides with a built-in provider", async () => {
		await run("add anthropic https://api.example.com/v1 --models m1");
		expect(outputs.join("\n")).toContain("built into OMPK");
		const written = JSON.parse(await Bun.file(modelsPath).text());
		expect(written.providers.anthropic).toBeUndefined();
	});

	it("refuses to add a duplicate provider", async () => {
		await run("add my-api https://api.example.com/v1 --models m1");
		outputs = [];
		await run("add my-api https://other.example.com/v1 --models m2");
		expect(outputs.join("\n")).toContain("already exists");
	});

	it("edits an existing provider without dropping its models", async () => {
		await run("add my-api https://api.example.com/v1 --models m1");
		outputs = [];
		await run("edit my-api --endpoint https://other.example.com/v1");
		const written = JSON.parse(await Bun.file(modelsPath).text());
		expect(written.providers["my-api"].baseUrl).toBe("https://other.example.com/v1");
		expect(written.providers["my-api"].models.map((m: { id: string }) => m.id)).toEqual(["m1"]);
		expect(outputs.join("\n")).toContain("Updated custom inference provider");
	});

	it("removes a provider", async () => {
		await run("add my-api https://api.example.com/v1 --models m1");
		outputs = [];
		await run("remove my-api");
		const written = JSON.parse(await Bun.file(modelsPath).text());
		expect(written.providers["my-api"]).toBeUndefined();
		expect(outputs.join("\n")).toContain("Removed custom inference provider");
	});

	it("lists custom providers", async () => {
		await run("add my-api https://api.example.com/v1 --models m1");
		outputs = [];
		await run("list");
		expect(outputs.join("\n")).toContain("my-api");
	});

	it("refuses to write when the configuration is broken", async () => {
		await Bun.write(modelsPath, JSON.stringify({ providers: { bad: { api: "not-an-api" } } }));
		const before = await Bun.file(modelsPath).text();
		outputs = [];
		await run("add my-api https://api.example.com/v1 --models m1");
		expect(outputs.join("\n")).toContain("Cannot update the models configuration");
		expect(await Bun.file(modelsPath).text()).toBe(before);
	});

	it("round-trips a provider through the models config file", async () => {
		const file = ModelsConfigFile.relocate(modelsPath);
		const loaded = await loadModelsConfig(file);
		expect(loaded.ok).toBe(true);
		await writeModelsConfig(file, {
			providers: {
				"my-api": {
					baseUrl: "https://api.example.com/v1",
					api: "openai-completions",
					auth: "none",
					models: [{ id: "m1" }],
				},
			},
		});
		const reread = await loadModelsConfig(file);
		expect(reread.ok).toBe(true);
		expect(reread.config.providers?.["my-api"]?.models?.[0]?.id).toBe("m1");
	});
});
