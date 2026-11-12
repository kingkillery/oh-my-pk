import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addCustomEndpoint, resolveModelsArgs } from "@pk-nerdsaver-ai/pi-coding-agent/cli/models-cli";
import { YAML } from "bun";

interface SavedModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
}

interface SavedProvider {
	baseUrl?: string;
	api?: string;
	auth?: string;
	apiKey?: string;
	models?: SavedModel[];
}

interface SavedConfig {
	providers: Record<string, SavedProvider>;
}

const tempDirs: string[] = [];

afterEach(() => {
	process.exitCode = 0;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function modelsPath(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "omp-models-add-"));
	tempDirs.push(dir);
	return path.join(dir, "models.yml");
}

function readSaved(file: string): SavedConfig {
	return YAML.parse(readFileSync(file, "utf8")) as SavedConfig;
}

describe("omp models add", () => {
	it("recognizes add as its own action", () => {
		expect(resolveModelsArgs("add", undefined)).toEqual({ action: "add", pattern: undefined });
	});

	it("writes a keyless OpenAI-compatible endpoint that can be selected as provider/model", async () => {
		const file = modelsPath();
		await addCustomEndpoint(
			{
				provider: "tailscale",
				baseUrl: "100.69.212.61:8000/v1",
				model: "gemma",
				auth: "none",
			},
			file,
		);

		const saved = readSaved(file);
		expect(saved.providers.tailscale).toMatchObject({
			baseUrl: "http://100.69.212.61:8000/v1",
			api: "openai-completions",
			auth: "none",
			models: [{ id: "gemma" }],
		});
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("normalizes bare hosts and copied chat paths without doubling the slash", async () => {
		const cases: Array<[string, string]> = [
			["localhost:8000", "http://localhost:8000/v1"],
			["https://api.example.com", "https://api.example.com/v1"],
			["https://api.example.com/", "https://api.example.com/v1"],
			["https://api.example.com/v1/", "https://api.example.com/v1"],
			["https://api.example.com/openai", "https://api.example.com/openai/v1"],
			["https://api.example.com/openai/v1", "https://api.example.com/openai/v1"],
			["https://api.example.com/v1/chat/completions", "https://api.example.com/v1"],
			["http://10.0.0.4:11434/v2", "http://10.0.0.4:11434/v2"],
		];

		for (const [index, [input, expected]] of cases.entries()) {
			const file = modelsPath();
			const provider = `host${index}`;
			await addCustomEndpoint({ provider, baseUrl: input, model: "m", auth: "none" }, file);
			expect(process.exitCode ?? 0).toBe(0);
			expect(readSaved(file).providers[provider]?.baseUrl).toBe(expected);
		}
	});

	it("refuses to overwrite an existing provider unless replace is set", async () => {
		const file = modelsPath();
		const flags = {
			provider: "tailscale",
			baseUrl: "http://127.0.0.1:8000/v1",
			model: "gemma",
			auth: "none" as const,
		};
		await addCustomEndpoint(flags, file);
		process.exitCode = 0;
		await addCustomEndpoint(flags, file);
		expect(process.exitCode).toBe(1);

		process.exitCode = 0;
		await addCustomEndpoint({ ...flags, model: "gemma-2", replace: true }, file);
		const saved = readSaved(file);
		expect(saved.providers.tailscale?.models?.[0]?.id).toBe("gemma-2");
	});

	it("keeps unrelated providers when replace rewrites one entry", async () => {
		const file = modelsPath();
		await addCustomEndpoint(
			{ provider: "keep", baseUrl: "http://127.0.0.1:9000/v1", model: "kept", auth: "none" },
			file,
		);
		await addCustomEndpoint(
			{ provider: "swap", baseUrl: "http://127.0.0.1:9100/v1", model: "before", auth: "none" },
			file,
		);
		process.exitCode = 0;
		await addCustomEndpoint(
			{ provider: "swap", baseUrl: "http://127.0.0.1:9200/v1", model: "after", auth: "none", replace: true },
			file,
		);

		const saved = readSaved(file);
		expect(saved.providers.keep?.models?.[0]?.id).toBe("kept");
		expect(saved.providers.keep?.baseUrl).toBe("http://127.0.0.1:9000/v1");
		expect(saved.providers.swap?.models?.map(model => model.id)).toEqual(["after"]);
		expect(saved.providers.swap?.baseUrl).toBe("http://127.0.0.1:9200/v1");
	});

	it("rejects built-in provider names, malformed names, and model ids containing a slash", async () => {
		const file = modelsPath();
		await addCustomEndpoint(
			{ provider: "keep", baseUrl: "http://127.0.0.1:9000/v1", model: "kept", auth: "none" },
			file,
		);
		const before = readFileSync(file, "utf8");

		const rejected: Array<Record<string, unknown>> = [
			{ provider: "anthropic", baseUrl: "http://127.0.0.1:8000", model: "m", auth: "none" },
			{ provider: "my provider", baseUrl: "http://127.0.0.1:8000", model: "m", auth: "none" },
			{ provider: "vendor", baseUrl: "http://127.0.0.1:8000", model: "org/model", auth: "none" },
		];
		for (const flags of rejected) {
			process.exitCode = 0;
			await addCustomEndpoint(flags, file);
			expect(process.exitCode).toBe(1);
		}
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("rejects endpoints carrying a query string instead of persisting the secret", async () => {
		const file = modelsPath();
		await addCustomEndpoint(
			{ provider: "leaky", baseUrl: "https://api.example.com/v1?key=secret", model: "m", auth: "none" },
			file,
		);
		expect(process.exitCode).toBe(1);
		expect(existsSync(file)).toBe(false);
	});

	it("rejects non-http schemes", async () => {
		const file = modelsPath();
		await addCustomEndpoint({ provider: "ftpish", baseUrl: "ftp://example.com/v1", model: "m", auth: "none" }, file);
		expect(process.exitCode).toBe(1);
		expect(existsSync(file)).toBe(false);
	});

	it("persists --api-key as the env var name with apiKey auth", async () => {
		const file = modelsPath();
		await addCustomEndpoint(
			{ provider: "vendor", baseUrl: "https://api.example.com", model: "m", apiKey: "VENDOR_API_KEY" },
			file,
		);

		const entry = readSaved(file).providers.vendor;
		expect(entry?.auth).toBe("apiKey");
		expect(entry?.apiKey).toBe("VENDOR_API_KEY");
		expect(entry?.baseUrl).toBe("https://api.example.com/v1");
	});

	it("requires a key name when auth is apiKey", async () => {
		const file = modelsPath();
		await addCustomEndpoint(
			{ provider: "vendor", baseUrl: "https://api.example.com", model: "m", auth: "apiKey" },
			file,
		);
		expect(process.exitCode).toBe(1);
		expect(existsSync(file)).toBe(false);
	});

	it("applies explicit context-window and max-tokens without hardcoding defaults", async () => {
		const file = modelsPath();
		await addCustomEndpoint(
			{
				provider: "vendor",
				baseUrl: "https://api.example.com",
				model: "m",
				auth: "none",
				contextWindow: 32768,
				maxTokens: 4096,
			},
			file,
		);

		const model = readSaved(file).providers.vendor?.models?.[0];
		expect(model?.contextWindow).toBe(32768);
		expect(model?.maxTokens).toBe(4096);
	});

	it("omits token limits when the flags are not passed", async () => {
		const file = modelsPath();
		await addCustomEndpoint(
			{ provider: "vendor", baseUrl: "https://api.example.com", model: "m", auth: "none" },
			file,
		);

		const model = readSaved(file).providers.vendor?.models?.[0];
		expect(model?.contextWindow).toBeUndefined();
		expect(model?.maxTokens).toBeUndefined();
	});
});
