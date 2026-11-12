/**
 * `omp models` — list, search, refresh, and add available models.
 *
 * Subcommands:
 * - `ls` (default): list every available model with a canonical + provider view.
 * - `find <substring>`: list models whose provider, id, or name contains the substring.
 * - `refresh`: force an online catalog re-fetch (ignoring the model cache TTL),
 *   then list. This is the supported replacement for `rm -rf ~/.ompk/models.db`
 *   when a provider ships a new model that the 24h cache has not picked up yet.
 * - `add`: register an OpenAI-compatible custom endpoint in `models.yml`.
 *
 * `ls`/`find` use the cache when fresh (`online-if-uncached`); only `refresh`
 * forces the network (`online`).
 */
import type { Api, Effort, Model } from "@pk-nerdsaver-ai/pi-ai";
import { getSupportedEfforts } from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import { APP_NAME, formatNumber, getProjectDir } from "@pk-nerdsaver-ai/pi-utils";
import chalk from "chalk";
import { ModelRegistry } from "../config/model-registry";
import { ModelsConfigFile } from "../config/models-config";
import type { ModelsConfig } from "../config/models-config-schema";
import { Settings } from "../config/settings";
import { discoverAndLoadExtensions, loadExtensions } from "../extensibility/extensions";
import { discoverAuthStorage } from "../sdk";
import {
	CUSTOM_PROVIDER_APIS,
	type CustomProviderApi,
	loadModelsConfig,
	normalizeEndpoint,
	upsertProviderEntry,
	validateProviderName,
	writeModelsConfig,
} from "../slash-commands/helpers/inference-provider";
import { EventBus } from "../utils/event-bus";

export type ModelsAction = "ls" | "find" | "refresh" | "canonical" | "add";

export interface ModelsCommandArgs {
	action: ModelsAction;
	/** Search substring for `find`, or optional filter for `ls`. */
	pattern?: string;
	flags: {
		json?: boolean;
		/** CLI `-e <path>` extension paths to load before listing (issue #905). */
		extensions?: string[];
		/** Skip extension discovery; only load explicit `extensions`. */
		noExtensions?: boolean;
		/** Extra `config.yml` overlays to apply for this invocation. */
		config?: string[];
		/** Provider id for `add`. */
		provider?: string;
		/** OpenAI-compatible base URL for `add`. */
		baseUrl?: string;
		/** Model id served by the custom endpoint. */
		model?: string;
		/** API key env var name. Omit with `--auth none`. */
		apiKey?: string;
		auth?: "apiKey" | "none";
		api?: CustomProviderApi;
		contextWindow?: number;
		maxTokens?: number;
		replace?: boolean;
	};
}

/**
 * Known action keywords. Any other first token (e.g. `openai-codex`) is treated
 * as a provider/substring filter for the default `ls` view, so every provider
 * name doubles as an `omp models <provider>` shortcut.
 */
const KNOWN_ACTIONS: Record<string, ModelsAction> = {
	ls: "ls",
	list: "ls",
	find: "find",
	refresh: "refresh",
	canonical: "canonical",
	add: "add",
};

/** Resolve the two positional args into an action + filter (provider names fall through to `ls`). */
export function resolveModelsArgs(
	first: string | undefined,
	second: string | undefined,
): { action: ModelsAction; pattern: string | undefined } {
	const known = first === undefined ? undefined : KNOWN_ACTIONS[first];
	if (known) {
		return { action: known, pattern: second };
	}
	return { action: "ls", pattern: first };
}

interface ModelJson {
	provider: string;
	id: string;
	selector: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	/** Supported thinking efforts when the model thinks, otherwise null. */
	thinking: readonly Effort[] | null;
	input: ("text" | "image")[];
	cost: Model<Api>["cost"];
}

interface CanonicalJson {
	id: string;
	selected: string;
	variants: number;
	contextWindow: number | null;
	maxTokens: number | null;
}

interface ModelsJson {
	models: ModelJson[];
}

interface CanonicalModelsJson {
	canonical: CanonicalJson[];
}

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function formatLimit(n: number | null): string {
	return n === null ? "-" : formatNumber(n);
}

function byProviderThenId(left: Model<Api>, right: Model<Api>): number {
	const providerCmp = left.provider.localeCompare(right.provider);
	if (providerCmp !== 0) return providerCmp;
	return left.id.localeCompare(right.id);
}

function toModelJson(model: Model<Api>): ModelJson {
	return {
		provider: model.provider,
		id: model.id,
		selector: `${model.provider}/${model.id}`,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		thinking: model.thinking ? getSupportedEfforts(model) : null,
		input: model.input,
		cost: model.cost,
	};
}

type ColumnAlign = "left" | "right";

interface BoxColumn {
	header: string;
	align?: ColumnAlign;
}

/** Right- or left-pad a plain (ANSI-free) cell to `width` display columns. */
function padCell(text: string, width: number, align: ColumnAlign = "left"): string {
	const space = width - Bun.stringWidth(text);
	if (space <= 0) return text;
	const fill = " ".repeat(space);
	return align === "right" ? fill + text : text + fill;
}

/**
 * Render `rows` as a box-drawing table. Cells must be plain text (no ANSI); the
 * header row is bolded and the borders dimmed (both no-ops on non-TTY output).
 */
function boxTable(columns: BoxColumn[], rows: string[][]): string[] {
	const widths = columns.map((column, index) =>
		Math.max(Bun.stringWidth(column.header), ...rows.map(row => Bun.stringWidth(row[index] ?? ""))),
	);
	const bar = chalk.dim("│");
	const segments = widths.map(width => "─".repeat(width + 2));
	const renderRow = (cells: string[], bold: boolean): string => {
		const padded = columns.map((column, index) => {
			const cell = padCell(cells[index] ?? "", widths[index]!, column.align);
			return bold ? chalk.bold(cell) : cell;
		});
		return `${bar} ${padded.join(` ${bar} `)} ${bar}`;
	};
	const lines = [chalk.dim(`┌${segments.join("┬")}┐`)];
	lines.push(
		renderRow(
			columns.map(column => column.header),
			true,
		),
	);
	lines.push(chalk.dim(`├${segments.join("┼")}┤`));
	for (const row of rows) {
		lines.push(renderRow(row, false));
	}
	lines.push(chalk.dim(`└${segments.join("┴")}┘`));
	return lines;
}

/** `omp models ls`/`find`: provider-grouped listing (one box table per provider). */
function renderProviderModels(
	modelRegistry: ModelRegistry,
	action: ModelsAction,
	pattern: string | undefined,
	json: boolean,
): void {
	const available = modelRegistry.getAvailable();
	const needle = pattern?.toLowerCase();
	let filtered = available;

	if (needle) {
		let exactFound = false;
		if (action !== "find") {
			const exact = available.filter(m => m.provider.toLowerCase() === needle);
			if (exact.length > 0) {
				filtered = exact;
				exactFound = true;
			}
		}
		if (!exactFound) {
			filtered = available.filter(
				model =>
					model.id.toLowerCase().includes(needle) ||
					model.provider.toLowerCase().includes(needle) ||
					`${model.provider}/${model.id}`.toLowerCase().includes(needle) ||
					model.name.toLowerCase().includes(needle),
			);
		}
	}

	if (json) {
		const output: ModelsJson = { models: filtered.slice().sort(byProviderThenId).map(toModelJson) };
		writeLine(JSON.stringify(output));
		return;
	}

	if (available.length === 0) {
		writeLine("No models available. Set API keys in environment variables.");
		return;
	}
	if (filtered.length === 0) {
		writeLine(`No models matching "${pattern}"`);
		return;
	}

	// One section per provider: bold heading + a box table of that provider's models.
	const byProvider = new Map<string, Model<Api>[]>();
	for (const model of filtered.slice().sort(byProviderThenId)) {
		let group = byProvider.get(model.provider);
		if (!group) {
			group = [];
			byProvider.set(model.provider, group);
		}
		group.push(model);
	}

	let firstProvider = true;
	for (const [provider, models] of byProvider) {
		if (!firstProvider) writeLine();
		firstProvider = false;
		writeLine(`${chalk.bold.cyan(provider)} ${chalk.dim(`(${models.length})`)}`);
		const rows = models.map(model => [
			model.id,
			formatLimit(model.contextWindow),
			formatLimit(model.maxTokens),
			model.thinking ? getSupportedEfforts(model).join(",") : model.reasoning ? "yes" : "-",
			model.input.includes("image") ? "yes" : "no",
		]);
		for (const line of boxTable(
			[
				{ header: "model" },
				{ header: "context", align: "right" },
				{ header: "max-out", align: "right" },
				{ header: "thinking" },
				{ header: "images" },
			],
			rows,
		)) {
			writeLine(line);
		}
	}
}

/** `omp models canonical`: the coalesced canonical view (one row per canonical id). */
function renderCanonicalModels(modelRegistry: ModelRegistry, pattern: string | undefined, json: boolean): void {
	const selections = modelRegistry.getCanonicalModelSelections({ availableOnly: true });
	const needle = pattern?.toLowerCase();
	const filtered = needle
		? selections.filter(
				({ record, model }) =>
					record.id.toLowerCase().includes(needle) ||
					`${model.provider}/${model.id}`.toLowerCase().includes(needle),
			)
		: selections;

	if (json) {
		const output: CanonicalModelsJson = {
			canonical: filtered
				.map(({ record, model }) => ({
					id: record.id,
					selected: `${model.provider}/${model.id}`,
					variants: record.variants.length,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				}))
				.sort((left, right) => left.id.localeCompare(right.id)),
		};
		writeLine(JSON.stringify(output));
		return;
	}

	if (selections.length === 0) {
		writeLine("No models available. Set API keys in environment variables.");
		return;
	}
	if (filtered.length === 0) {
		writeLine(`No canonical models matching "${pattern}"`);
		return;
	}

	const rows = filtered
		.slice()
		.sort((left, right) => left.record.id.localeCompare(right.record.id))
		.map(({ record, model }) => [
			record.id,
			`${model.provider}/${model.id}`,
			String(record.variants.length),
			formatLimit(model.contextWindow),
			formatLimit(model.maxTokens),
		]);
	for (const line of boxTable(
		[
			{ header: "canonical" },
			{ header: "selected" },
			{ header: "variants", align: "right" },
			{ header: "context", align: "right" },
			{ header: "max-out", align: "right" },
		],
		rows,
	)) {
		writeLine(line);
	}
}

/**
 * Options for {@link runModelsListing}: render the catalog from a caller-supplied
 * registry. Loads extensions (CLI `-e` paths and configured `settings.extensions`)
 * and discovers their providers before rendering so extension-contributed models
 * appear (issue #905). The caller is responsible for refreshing built-in providers.
 */
export interface RunModelsListingOptions {
	modelRegistry: ModelRegistry;
	cwd: string;
	action?: ModelsAction;
	pattern?: string;
	json?: boolean;
	/** CLI-supplied extension paths (e.g. from `-e <path>`). */
	additionalExtensionPaths?: string[];
	/** Extension paths configured under `extensions:` in user settings. */
	settingsExtensions?: string[];
	/** Disabled extension ids from settings (`disabledExtensions`). */
	disabledExtensionIds?: string[];
	/** When true, skip discovery and only load `additionalExtensionPaths`. */
	disableExtensionDiscovery?: boolean;
}

export async function runModelsListing(options: RunModelsListingOptions): Promise<void> {
	const {
		modelRegistry,
		cwd,
		action = "ls",
		pattern,
		json = false,
		additionalExtensionPaths = [],
		settingsExtensions = [],
		disabledExtensionIds = [],
		disableExtensionDiscovery = false,
	} = options;

	const eventBus = new EventBus();
	const extensionsResult = disableExtensionDiscovery
		? await loadExtensions(additionalExtensionPaths, cwd, eventBus)
		: await discoverAndLoadExtensions(
				[...additionalExtensionPaths, ...settingsExtensions],
				cwd,
				eventBus,
				disabledExtensionIds,
			);

	for (const { path: extPath, error } of extensionsResult.errors) {
		process.stderr.write(`Failed to load extension: ${extPath}: ${error}\n`);
	}

	// Mirror sdk.ts: drain pending provider registrations into the registry.
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	// Discover runtime (extension) provider catalogs now that they are registered.
	await modelRegistry.refreshRuntimeProviders(action === "refresh" ? "online" : "online-if-uncached");

	if (action === "canonical") {
		renderCanonicalModels(modelRegistry, pattern, json);
	} else {
		renderProviderModels(modelRegistry, action, pattern, json);
	}
}

function failAdd(message: string, json: boolean): void {
	process.stderr.write(`${json ? JSON.stringify({ error: message }) : message}\n`);
	process.exitCode = 1;
}

/**
 * Normalize a CLI `--base-url` into the base an OpenAI-compatible adapter
 * needs. Convenience over {@link normalizeEndpoint}: bare hosts get `http://`,
 * a copied `/chat/completions` suffix is stripped, and a missing API version
 * gets `/v1` — without ever emitting a doubled slash.
 */
function resolveBaseUrl(raw: string): { ok: true; baseUrl: string } | { ok: false; error: string } {
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
	const normalized = normalizeEndpoint(withScheme);
	if (!normalized.ok) return normalized;
	const url = new URL(normalized.baseUrl);
	if (url.search || url.hash) {
		return { ok: false, error: `Endpoint must not carry a query string or fragment: ${raw}` };
	}
	const pathname = url.pathname
		.replace(/\/+$/, "")
		.replace(/\/chat\/completions$/, "")
		.replace(/\/+$/, "");
	url.pathname = /\/v\d+$/.test(pathname) ? pathname : `${pathname}/v1`;
	return { ok: true, baseUrl: url.toString().replace(/\/+$/, "") };
}

/** Apply explicit `--context-window` / `--max-tokens` to one provider’s models. */
function withModelLimits(config: ModelsConfig, name: string, flags: ModelsCommandArgs["flags"]): ModelsConfig {
	const entry = config.providers?.[name];
	if (!entry || (!flags.contextWindow && !flags.maxTokens)) return config;
	return {
		...config,
		providers: {
			...config.providers,
			[name]: {
				...entry,
				models: (entry.models ?? []).map(model => ({
					...model,
					...(flags.contextWindow ? { contextWindow: flags.contextWindow } : {}),
					...(flags.maxTokens ? { maxTokens: flags.maxTokens } : {}),
				})),
			},
		},
	};
}

/** Narrow a validated `--auth` flag value without a cast. */
export function parseAuthFlag(raw: string | undefined): "apiKey" | "none" | undefined {
	return raw === "apiKey" || raw === "none" ? raw : undefined;
}

/** Narrow a validated `--api` flag value without a cast. */
export function parseCustomProviderApi(raw: string | undefined): CustomProviderApi | undefined {
	return CUSTOM_PROVIDER_APIS.find(api => api === raw);
}

/**
 * Register one custom endpoint in `models.yml`.
 *
 * Shares provider-name validation, entry shape, and the atomic config writer
 * with `/inference-provider`, so the CLI and the slash command produce
 * identical provider records. Select the result as `<provider>/<model>`.
 */
export async function addCustomEndpoint(flags: ModelsCommandArgs["flags"], modelsPath?: string): Promise<void> {
	const json = flags.json ?? false;
	const fail = (message: string) => failAdd(message, json);

	if (!flags.provider?.trim() || !flags.model?.trim() || !flags.baseUrl?.trim()) {
		fail(
			`\`${APP_NAME} models add\` requires --provider, --base-url, and --model.\nExample: ${APP_NAME} models add --provider tailscale --base-url http://100.69.212.61:8000/v1 --model gemma --auth none`,
		);
		return;
	}

	const named = validateProviderName(flags.provider);
	if (!named.ok) {
		fail(named.error);
		return;
	}
	const model = flags.model.trim();
	if (model.includes("/")) {
		fail(
			`Model ids cannot contain '/': OMPK splits \`<provider>/<model>\` selectors on the first slash. Use the id exactly as the endpoint serves it.`,
		);
		return;
	}

	const endpoint = resolveBaseUrl(flags.baseUrl.trim());
	if (!endpoint.ok) {
		fail(`Invalid --base-url. ${endpoint.error}`);
		return;
	}

	const auth = flags.auth ?? (flags.apiKey?.trim() ? "apiKey" : "none");
	const apiKey = auth === "apiKey" ? flags.apiKey?.trim() : undefined;
	if (auth === "apiKey" && !apiKey) {
		fail("Pass --api-key <ENV_VAR> or --auth none.");
		return;
	}
	if (auth === "none" && flags.apiKey?.trim()) {
		writeLine("Ignoring --api-key because --auth is none.");
	}

	const file = modelsPath ? ModelsConfigFile.relocate(modelsPath) : ModelsConfigFile;
	const loaded = await loadModelsConfig(file);
	if (!loaded.ok) {
		fail(loaded.error ?? `Could not read ${file.path()}.`);
		return;
	}
	if (loaded.config.providers?.[named.name] && !flags.replace) {
		fail(`Provider '${named.name}' already exists. Pass --replace to overwrite it.`);
		return;
	}

	const next = withModelLimits(
		upsertProviderEntry(loaded.config, {
			name: named.name,
			baseUrl: endpoint.baseUrl,
			api: flags.api ?? "openai-completions",
			apiKey,
			models: [model],
		}),
		named.name,
		flags,
	);
	try {
		await writeModelsConfig(file, next);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
		return;
	}

	const selector = `${named.name}/${model}`;
	if (json) {
		writeLine(
			JSON.stringify({
				provider: named.name,
				model,
				baseUrl: endpoint.baseUrl,
				auth,
				selector,
				path: file.path(),
			}),
		);
		return;
	}
	writeLine(`Added ${selector}`);
	writeLine(`Endpoint: ${endpoint.baseUrl}`);
	writeLine(`Config: ${file.path()}`);
}

/**
 * Entry point for the standalone `omp models` command: bootstraps auth storage,
 * settings, and the model registry, force/cache-refreshes built-in providers per
 * the chosen action, then delegates to {@link runModelsListing}.
 */
export async function runModelsCommand(command: ModelsCommandArgs): Promise<void> {
	const { action, pattern } = command;
	const json = command.flags.json ?? false;
	if (action === "add") {
		await addCustomEndpoint(command.flags);
		return;
	}
	if (action === "find" && (!pattern || pattern.trim().length === 0)) {
		process.stderr.write(
			`\`${APP_NAME} models find\` requires a search substring, e.g. \`${APP_NAME} models find minimax\`\n`,
		);
		process.exitCode = 1;
		return;
	}

	const cwd = getProjectDir();
	const authStorage = await discoverAuthStorage();
	try {
		const settings = await Settings.init({ cwd, configFiles: command.flags.config });
		const modelRegistry = new ModelRegistry(authStorage);

		if (action === "refresh" && !json && process.stderr.isTTY) {
			process.stderr.write("Refreshing models from all providers…\n");
		}
		await modelRegistry.refresh(action === "refresh" ? "online" : "online-if-uncached");

		const cliExtensionPaths = command.flags.noExtensions ? [] : (command.flags.extensions ?? []);
		await runModelsListing({
			modelRegistry,
			cwd,
			action,
			pattern,
			json,
			additionalExtensionPaths: cliExtensionPaths,
			settingsExtensions: settings.get("extensions") ?? [],
			disabledExtensionIds: settings.get("disabledExtensions") ?? [],
			disableExtensionDiscovery: Boolean(command.flags.noExtensions),
		});
	} finally {
		authStorage.close();
	}
}
