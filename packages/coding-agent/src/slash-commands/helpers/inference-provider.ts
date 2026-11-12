/**
 * Custom inference providers for `/inference-provider`.
 *
 * A custom inference provider is an endpoint that is NOT built into base OMPK:
 * any OpenAI- or Anthropic-compatible server the operator points at directly.
 * Providers are persisted in the regular `models.yml` `providers:` map so the
 * model registry, credential resolution, and `/model` selection all treat them
 * exactly like hand-written custom providers.
 *
 * The module owns the side-effect-free parts (validation, endpoint
 * normalization, `/models` probing, config mutation) so both the interactive
 * TUI wizard and the text/ACP dispatcher share one contract.
 */

import { getBundledProviders } from "@pk-nerdsaver-ai/pi-catalog/models";
import type { ConfigFile } from "../../config/config-file";
import { ModelsConfigFile } from "../../config/models-config";
import type { ModelsConfig, ProviderConfig } from "../../config/models-config-schema";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

/** Wire protocols a custom endpoint can speak. */
export const CUSTOM_PROVIDER_APIS = ["openai-completions", "anthropic-messages"] as const;

export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

/**
 * Runtime-discovered engines that OMPK always ships. A `models.yml` entry with
 * one of these ids configures a built-in provider; it is not a custom one.
 */
const BUILTIN_LOCAL_ENGINE_IDS = ["ollama", "llama.cpp", "lm-studio", "9router", "llama.cpp (colab)"] as const;

const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

let builtinProviderIds: Set<string> | undefined;

/** Whether `id` names a provider that ships with OMPK (bundled or local engine). */
export function isBuiltinProviderId(id: string): boolean {
	if (!builtinProviderIds) {
		builtinProviderIds = new Set<string>([...getBundledProviders(), ...BUILTIN_LOCAL_ENGINE_IDS]);
	}
	return builtinProviderIds.has(id);
}

/** Names of every custom (non-built-in) provider declared in `config`. */
export function listCustomProviderNames(config: ModelsConfig): string[] {
	return Object.keys(config.providers ?? {})
		.filter(name => !isBuiltinProviderId(name))
		.sort((left, right) => left.localeCompare(right));
}

/** A provider name that can be used as a `provider/model` selector segment. */
export function validateProviderName(name: string): { ok: true; name: string } | { ok: false; error: string } {
	const trimmed = name.trim();
	if (!trimmed) {
		return { ok: false, error: "Provider name cannot be empty." };
	}
	if (!PROVIDER_NAME_PATTERN.test(trimmed)) {
		return {
			ok: false,
			error: "Provider name must start with a letter or digit and may only contain letters, digits, '.', '_' or '-' (max 64 characters).",
		};
	}
	if (isBuiltinProviderId(trimmed)) {
		return {
			ok: false,
			error: `"${trimmed}" is a provider built into OMPK. Choose a different name for a custom endpoint.`,
		};
	}
	return { ok: true, name: trimmed };
}

/** Absolute http(s) endpoint, normalized without a trailing slash. */
export function normalizeEndpoint(input: string): { ok: true; baseUrl: string } | { ok: false; error: string } {
	const trimmed = input.trim();
	if (!trimmed) {
		return { ok: false, error: "Endpoint cannot be empty." };
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return {
			ok: false,
			error: `Endpoint must be an absolute URL (e.g. https://api.example.com/v1): ${trimmed}`,
		};
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { ok: false, error: "Endpoint must use http or https." };
	}
	return { ok: true, baseUrl: trimmed.replace(/\/+$/, "") };
}

/** Candidate `/models` URLs for an endpoint, most specific first. */
export function modelEndpointCandidates(baseUrl: string): string[] {
	const trimmed = baseUrl.replace(/\/+$/, "");
	const candidates = [`${trimmed}/models`];
	if (!/\/v\d+$/.test(trimmed)) {
		candidates.push(`${trimmed}/v1/models`);
	}
	return candidates;
}

export interface EndpointModels {
	/** Model ids advertised by the endpoint. */
	ids: string[];
	/** Base URL that sits next to the discovered `/models` endpoint. */
	discoveryBaseUrl: string;
}

/**
 * Probe an endpoint for a `/models` catalog.
 *
 * Returns `ok: false` when no candidate URL answered with a usable model
 * list; the caller then falls back to manual model entry.
 */
export async function fetchEndpointModels(
	baseUrl: string,
	options?: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<{ ok: true; models: EndpointModels } | { ok: false; error: string }> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (options?.apiKey) {
		headers.Authorization = `Bearer ${options.apiKey}`;
	}
	let lastError = "no /models endpoint responded";
	for (const candidate of modelEndpointCandidates(baseUrl)) {
		try {
			const response = await fetchImpl(candidate, {
				headers,
				signal: AbortSignal.timeout(options?.timeoutMs ?? 8_000),
			});
			if (!response.ok) {
				lastError = `HTTP ${response.status} from ${candidate}`;
				continue;
			}
			const payload = await response.json();
			const ids = extractModelIds(payload);
			if (ids.length === 0) {
				lastError = `${candidate} returned no models`;
				continue;
			}
			return {
				ok: true,
				models: { ids, discoveryBaseUrl: candidate.slice(0, -"/models".length).replace(/\/+$/, "") },
			};
		} catch (error) {
			lastError = errorMessage(error);
		}
	}
	return { ok: false, error: lastError };
}

/** Pull model ids out of an OpenAI- or Anthropic-style `/models` payload. */
export function extractModelIds(payload: unknown): string[] {
	let entries: unknown;
	if (Array.isArray(payload)) {
		entries = payload;
	} else if (payload && typeof payload === "object") {
		const record = payload as { data?: unknown; models?: unknown; result?: unknown };
		entries = record.data ?? record.models ?? record.result;
	}
	if (!Array.isArray(entries)) return [];
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		let id: unknown;
		if (typeof entry === "string") {
			id = entry;
		} else if (entry && typeof entry === "object") {
			const record = entry as { id?: unknown; name?: unknown };
			id = record.id ?? record.name;
		}
		if (typeof id !== "string") continue;
		const trimmed = id.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		ids.push(trimmed);
	}
	return ids;
}

/**
 * The `baseUrl` the provider entry must carry for the given wire protocol.
 *
 * OpenAI-compatible servers expose `<base>/chat/completions` next to
 * `<base>/models`, so the base keeps its `/v1` suffix. Anthropic-compatible
 * servers expose `<root>/v1/messages`, so the `/v1` suffix is stripped.
 */
export function resolveProviderBaseUrl(endpoint: string, api: CustomProviderApi, discoveryBaseUrl?: string): string {
	const source = (discoveryBaseUrl ?? endpoint).replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		return source.replace(/\/v\d+$/, "");
	}
	if (discoveryBaseUrl) {
		return source;
	}
	return /\/v\d+$/.test(source) ? source : `${source}/v1`;
}

/** Everything the config writer needs to materialize a provider. */
export interface CustomProviderDraft {
	name: string;
	baseUrl: string;
	api: CustomProviderApi;
	/** API key (or env-var name). Omitted means the endpoint needs no auth. */
	apiKey?: string;
	models: string[];
}

/** Build the `models.yml` provider entry for a draft. */
export function buildProviderEntry(draft: CustomProviderDraft): ProviderConfig {
	const entry: ProviderConfig = {
		baseUrl: draft.baseUrl,
		api: draft.api,
		auth: draft.apiKey ? "apiKey" : "none",
		models: draft.models.map(id => ({ id, name: id })),
	};
	if (draft.apiKey) {
		entry.apiKey = draft.apiKey;
	}
	return entry;
}

/**
 * Insert or replace a provider, keeping unrelated config intact.
 *
 * `previousName` supports renaming during an edit. Runtime `discovery` is
 * dropped: this command owns the model list explicitly.
 */
export function upsertProviderEntry(
	config: ModelsConfig,
	draft: CustomProviderDraft,
	previousName?: string,
): ModelsConfig {
	const providers = { ...(config.providers ?? {}) };
	if (previousName && previousName !== draft.name) {
		delete providers[previousName];
	}
	const existing = providers[draft.name];
	const merged: ProviderConfig = { ...existing, ...buildProviderEntry(draft) };
	delete merged.discovery;
	providers[draft.name] = merged;
	return { ...config, providers };
}

/** Remove a provider entry, keeping the rest of the config intact. */
export function removeProviderEntry(config: ModelsConfig, name: string): ModelsConfig {
	const providers = { ...(config.providers ?? {}) };
	delete providers[name];
	return { ...config, providers };
}

export interface LoadedModelsConfig {
	ok: boolean;
	config: ModelsConfig;
	error?: string;
}

/** Read `models.yml`, tolerating a missing file but never a broken one. */
export async function loadModelsConfig(file: ConfigFile<ModelsConfig>): Promise<LoadedModelsConfig> {
	file.invalidate();
	const result = await file.tryLoadAsync();
	if (result.status === "error") {
		return { ok: false, config: {}, error: result.error.message };
	}
	return { ok: true, config: result.value ?? {} };
}

/** Persist `models.yml` through the validated, atomic config writer. */
export async function writeModelsConfig(file: ConfigFile<ModelsConfig>, config: ModelsConfig): Promise<void> {
	file.save(config);
}

/** The models-config file the active session reads from. */
export function resolveModelsConfigFile(runtime: SlashCommandRuntime): ConfigFile<ModelsConfig> {
	return ModelsConfigFile.relocate(runtime.session.modelRegistry.modelsConfigPath);
}

/**
 * The models-config file the active TUI session reads from.
 *
 * Accepts the registry path directly so both dispatchers resolve the same
 * file without constructing a full {@link SlashCommandRuntime}.
 */
export function resolveModelsConfigFileForPath(modelsConfigPath: string | undefined): ConfigFile<ModelsConfig> {
	return ModelsConfigFile.relocate(modelsConfigPath);
}

const USAGE = [
	"Usage:",
	"  /inference-provider add <name> <endpoint> [--api openai|anthropic] [--key <key>] [--models id1,id2]",
	"  /inference-provider edit <name> [--endpoint <url>] [--api openai|anthropic] [--key <key>] [--models id1,id2]",
	"  /inference-provider remove <name>",
	"  /inference-provider list",
	"",
	"Run /inference-provider without arguments for the interactive menu.",
].join("\n");

interface ProviderCommandArgs {
	name?: string;
	endpoint?: string;
	api?: CustomProviderApi;
	apiKey?: string;
	models?: string[];
	/** False when the user explicitly opted out of endpoint probing. */
	discover: boolean;
	error?: string;
}

/**
 * Parse `add`/`edit` argument tails.
 *
 * `add` takes `<name> <endpoint>`; `edit` takes `<name>` and then only the
 * fields that should change.
 */
export function parseProviderCommandArgs(verb: string, rest: string): ProviderCommandArgs {
	const tokens = rest.split(/\s+/).filter(Boolean);
	const parsed: ProviderCommandArgs = { discover: true };
	let index = 0;
	if (tokens[index] && !tokens[index]!.startsWith("--")) {
		parsed.name = tokens[index];
		index += 1;
	}
	if (verb === "add") {
		if (tokens[index] && !tokens[index]!.startsWith("--")) {
			parsed.endpoint = tokens[index];
			index += 1;
		} else {
			parsed.error = "An endpoint is required: /inference-provider add <name> <endpoint>";
			return parsed;
		}
	}
	while (index < tokens.length) {
		const token = tokens[index]!;
		const value = tokens[index + 1];
		switch (token) {
			case "--endpoint":
			case "--url":
				if (!value) {
					parsed.error = `${token} requires a URL`;
					return parsed;
				}
				parsed.endpoint = value;
				index += 2;
				break;
			case "--api": {
				if (!value) {
					parsed.error = "--api requires openai or anthropic";
					return parsed;
				}
				const api = value.toLowerCase();
				if (api === "openai" || api === "openai-completions") {
					parsed.api = "openai-completions";
				} else if (api === "anthropic" || api === "anthropic-messages") {
					parsed.api = "anthropic-messages";
				} else {
					parsed.error = `Unknown --api value: ${value} (expected openai or anthropic)`;
					return parsed;
				}
				index += 2;
				break;
			}
			case "--key":
			case "--api-key":
				if (value === undefined) {
					parsed.error = "--key requires a value";
					return parsed;
				}
				parsed.apiKey = value;
				index += 2;
				break;
			case "--models":
				if (!value) {
					parsed.error = "--models requires at least one model id";
					return parsed;
				}
				parsed.models = value
					.split(",")
					.map(id => id.trim())
					.filter(Boolean);
				index += 2;
				break;
			case "--no-discover":
				parsed.discover = false;
				index += 1;
				break;
			default:
				parsed.error = `Unknown option: ${token}`;
				return parsed;
		}
	}
	return parsed;
}

/** Text-mode summary of one custom provider. */
export function formatCustomProvider(config: ModelsConfig, name: string): string {
	const entry = config.providers?.[name];
	if (!entry) return `${name}: (not configured)`;
	const models = entry.models ?? [];
	const lines = [
		`${name}`,
		`  endpoint: ${entry.baseUrl ?? "(none)"}`,
		`  api: ${entry.api ?? "openai-completions"}`,
		`  auth: ${entry.auth ?? (entry.apiKey ? "apiKey" : "none")}`,
	];
	if (models.length > 0) {
		lines.push(`  models: ${models.map(model => model.id).join(", ")}`);
	}
	return lines.join("\n");
}

/**
 * Resolve the model list for a provider.
 *
 * Explicit `--models` wins. Otherwise the endpoint's `/models` catalog is
 * probed, and the provider's current model list is the fallback when the
 * endpoint has no catalog. When neither is available the caller is told to
 * supply models explicitly.
 */
export async function resolveProviderModels(
	endpoint: string,
	explicitModels: readonly string[] | undefined,
	discover: boolean,
	apiKey?: string,
	fallbackModels: readonly string[] = [],
): Promise<{ ok: true; ids: string[]; discoveryBaseUrl?: string } | { ok: false; error: string }> {
	if (explicitModels && explicitModels.length > 0) {
		return { ok: true, ids: [...explicitModels] };
	}
	if (discover) {
		const result = await fetchEndpointModels(endpoint, { apiKey });
		if (result.ok) {
			return { ok: true, ids: result.models.ids, discoveryBaseUrl: result.models.discoveryBaseUrl };
		}
		if (fallbackModels.length > 0) {
			return { ok: true, ids: [...fallbackModels] };
		}
		return {
			ok: false,
			error: `No /models endpoint found (${result.error}). Pass --models id1,id2 to list the models manually.`,
		};
	}
	if (fallbackModels.length > 0) {
		return { ok: true, ids: [...fallbackModels] };
	}
	return { ok: false, error: "Model discovery is disabled. Pass --models id1,id2 to list the models." };
}

/** Text/ACP dispatcher for `/inference-provider`. */
export async function handleInferenceProviderSlashCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	const file = resolveModelsConfigFile(runtime);

	if (verb === "list") {
		const loaded = await loadModelsConfig(file);
		if (!loaded.ok) {
			return usage(`Cannot read the models configuration: ${loaded.error}`, runtime);
		}
		const names = listCustomProviderNames(loaded.config);
		if (names.length === 0) {
			await runtime.output("No custom inference providers are configured.");
			return commandConsumed();
		}
		await runtime.output(names.map(name => formatCustomProvider(loaded.config, name)).join("\n\n"));
		return commandConsumed();
	}

	if (verb === "remove" || verb === "rm" || verb === "delete") {
		const name = rest.trim();
		if (!name) {
			return usage("Usage: /inference-provider remove <name>", runtime);
		}
		const loaded = await loadModelsConfig(file);
		if (!loaded.ok) {
			return usage(`Cannot update the models configuration: ${loaded.error}`, runtime);
		}
		if (!loaded.config.providers?.[name]) {
			return usage(`No custom inference provider named "${name}".`, runtime);
		}
		await writeModelsConfig(file, removeProviderEntry(loaded.config, name));
		await runtime.session.modelRegistry.refresh("offline");
		await runtime.output(`Removed custom inference provider "${name}".`);
		return commandConsumed();
	}

	if (verb !== "add" && verb !== "edit") {
		return usage(USAGE, runtime);
	}

	const parsed = parseProviderCommandArgs(verb, rest);
	if (parsed.error) {
		return usage(parsed.error, runtime);
	}
	if (!parsed.name) {
		return usage(verb === "add" ? USAGE : "Usage: /inference-provider edit <name> [...]", runtime);
	}

	const loaded = await loadModelsConfig(file);
	if (!loaded.ok) {
		return usage(`Cannot update the models configuration: ${loaded.error}`, runtime);
	}

	const nameCheck = validateProviderName(parsed.name);
	if (!nameCheck.ok) {
		return usage(nameCheck.error, runtime);
	}

	const existing = loaded.config.providers?.[nameCheck.name];
	if (verb === "edit" && !existing) {
		return usage(`No custom inference provider named "${nameCheck.name}".`, runtime);
	}
	if (verb === "add" && existing) {
		return usage(
			`A provider named "${nameCheck.name}" already exists. Use /inference-provider edit ${nameCheck.name} to change it.`,
			runtime,
		);
	}

	const requestedApi = parsed.api ?? existing?.api ?? "openai-completions";
	if (!CUSTOM_PROVIDER_APIS.includes(requestedApi as CustomProviderApi)) {
		return usage(
			`Unsupported api "${requestedApi}". Custom inference providers support ${CUSTOM_PROVIDER_APIS.join(" and ")}.`,
			runtime,
		);
	}
	const api: CustomProviderApi = requestedApi as CustomProviderApi;

	const endpointInput = parsed.endpoint ?? existing?.baseUrl;
	if (!endpointInput) {
		return usage("An endpoint is required: /inference-provider add <name> <endpoint>", runtime);
	}
	const endpoint = normalizeEndpoint(endpointInput);
	if (!endpoint.ok) {
		return usage(endpoint.error, runtime);
	}

	const apiKey = parsed.apiKey ?? existing?.apiKey;
	const fallbackModels = (existing?.models ?? []).map(model => model.id);
	const models = await resolveProviderModels(endpoint.baseUrl, parsed.models, parsed.discover, apiKey, fallbackModels);
	if (!models.ok) {
		return usage(models.error, runtime);
	}

	const draft: CustomProviderDraft = {
		name: nameCheck.name,
		baseUrl: resolveProviderBaseUrl(endpoint.baseUrl, api, models.discoveryBaseUrl),
		api,
		...(apiKey ? { apiKey } : {}),
		models: models.ids,
	};

	await writeModelsConfig(file, upsertProviderEntry(loaded.config, draft));
	await runtime.session.modelRegistry.refresh("offline");

	const verbLabel = verb === "add" ? "Added" : "Updated";
	await runtime.output(
		[
			`${verbLabel} custom inference provider "${draft.name}".`,
			`  endpoint: ${draft.baseUrl}`,
			`  api: ${draft.api}`,
			`  models: ${draft.models.join(", ")}`,
			`Select one with /model ${draft.name}/${draft.models[0] ?? "<model-id>"}.`,
		].join("\n"),
	);
	return commandConsumed();
}
