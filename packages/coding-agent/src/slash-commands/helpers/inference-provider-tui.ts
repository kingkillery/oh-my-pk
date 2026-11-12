/**
 * Interactive `/inference-provider` menu.
 *
 * The TUI flow mirrors the text-mode contract but drives the operator through
 * the wizard: name, endpoint, wire protocol, credentials, then models. Models
 * auto-load from the endpoint's `/models` catalog when it exposes one; when it
 * does not, the operator types model ids one by one until the list is done.
 */

import type { ExtensionUISelectItem } from "../../extensibility/extensions";
import type { InteractiveModeContext } from "../../modes/types";
import type { ParsedSlashCommand, SlashCommandResult } from "../types";
import {
	CUSTOM_PROVIDER_APIS,
	type CustomProviderApi,
	fetchEndpointModels,
	formatCustomProvider,
	handleInferenceProviderSlashCommand,
	listCustomProviderNames,
	loadModelsConfig,
	normalizeEndpoint,
	removeProviderEntry,
	resolveModelsConfigFileForPath,
	resolveProviderBaseUrl,
	upsertProviderEntry,
	validateProviderName,
	writeModelsConfig,
} from "./inference-provider";

/** Sentinel used by the model-entry loop to stop collecting ids. */
const DONE_SENTINEL = "(done)";

const API_LABELS: Record<CustomProviderApi, string> = {
	"openai-completions": "openai",
	"anthropic-messages": "anthropic",
};

/**
 * Collect model ids one at a time until the operator finishes.
 *
 * Returns the ids in entry order, or `undefined` when the operator aborted.
 */
async function collectModelsInteractively(
	ctx: InteractiveModeContext,
	existing: readonly string[] = [],
): Promise<string[] | undefined> {
	const models = [...existing];
	for (;;) {
		const label = models.length === 0 ? "Model id" : `Model id (${models.length} added)`;
		const answer = await ctx.showHookInput(
			models.length === 0 ? "Enter the first model id" : "Enter another model id",
			label,
		);
		if (answer === undefined) return undefined;
		const trimmed = answer.trim();
		if (!trimmed) continue;
		if (trimmed.toLowerCase() === DONE_SENTINEL || trimmed.toLowerCase() === "done") {
			return models;
		}
		if (models.includes(trimmed)) continue;
		models.push(trimmed);
	}
}

/**
 * Resolve the model list for a provider in the TUI.
 *
 * Tries the endpoint's `/models` catalog first. When the endpoint has no such
 * catalog, the operator enters the models one by one.
 */
async function resolveModelsInTui(
	ctx: InteractiveModeContext,
	endpoint: string,
	apiKey: string | undefined,
	existing: readonly string[],
): Promise<string[] | undefined> {
	const discovered = await fetchEndpointModels(endpoint, { apiKey });
	if (discovered.ok) {
		ctx.showStatus(
			`Loaded ${discovered.models.ids.length} model(s) from ${endpoint}/models: ${discovered.models.ids.join(", ")}`,
		);
		return discovered.models.ids;
	}
	ctx.showStatus(`No /models endpoint found (${discovered.error}). Enter the models manually.`);
	return collectModelsInteractively(ctx, existing);
}

/** Ask for the wire protocol of a custom endpoint. */
async function pickApi(
	ctx: InteractiveModeContext,
	current?: CustomProviderApi,
): Promise<CustomProviderApi | undefined> {
	const items: ExtensionUISelectItem[] = CUSTOM_PROVIDER_APIS.map(api => ({
		label: API_LABELS[api],
		description:
			api === "openai-completions"
				? "OpenAI-compatible endpoint (/chat/completions)"
				: "Anthropic-compatible endpoint (/v1/messages)",
	}));
	const selected = await ctx.showHookSelector("Wire protocol", items, {
		initialIndex: current ? CUSTOM_PROVIDER_APIS.indexOf(current) : 0,
	});
	if (!selected) return undefined;
	const match = CUSTOM_PROVIDER_APIS.find(api => API_LABELS[api] === selected);
	return match;
}

/** Shared add/edit wizard. `previousName` is set when editing an existing entry. */
async function runProviderWizard(ctx: InteractiveModeContext, previousName?: string): Promise<void> {
	const file = resolveModelsConfigFileForPath(ctx.session.modelRegistry.modelsConfigPath);
	const loaded = await loadModelsConfig(file);
	if (!loaded.ok) {
		ctx.showStatus(`Cannot read the models configuration: ${loaded.error}`);
		return;
	}
	const existing = previousName ? loaded.config.providers?.[previousName] : undefined;
	const currentApi = existing?.api === "anthropic-messages" ? "anthropic-messages" : undefined;

	const nameAnswer = await ctx.showHookInput(
		previousName ? `Rename "${previousName}" (empty keeps the name)` : "Provider name",
		previousName ?? "e.g. my-inference",
	);
	if (nameAnswer === undefined) return;
	const name = nameAnswer.trim() || previousName;
	if (!name) {
		ctx.showStatus("Provider name cannot be empty.");
		return;
	}
	const nameCheck = validateProviderName(name);
	if (!nameCheck.ok) {
		ctx.showStatus(nameCheck.error);
		return;
	}
	if (!previousName && loaded.config.providers?.[nameCheck.name]) {
		ctx.showStatus(`A provider named "${nameCheck.name}" already exists.`);
		return;
	}

	const endpointAnswer = await ctx.showHookInput("Endpoint URL", existing?.baseUrl ?? "https://api.example.com/v1");
	if (endpointAnswer === undefined) return;
	const endpoint = normalizeEndpoint(endpointAnswer);
	if (!endpoint.ok) {
		ctx.showStatus(endpoint.error);
		return;
	}

	const api = await pickApi(ctx, currentApi);
	if (!api) return;

	const keyAnswer = await ctx.showHookInput("API key (empty for no authentication)", existing?.apiKey ?? "sk-...");
	if (keyAnswer === undefined) return;
	const apiKey = keyAnswer.trim() || undefined;

	const models = await resolveModelsInTui(ctx, endpoint.baseUrl, apiKey, existing?.models?.map(m => m.id) ?? []);
	if (!models) return;
	if (models.length === 0) {
		ctx.showStatus("A provider needs at least one model.");
		return;
	}

	const draft = {
		name: nameCheck.name,
		baseUrl: resolveProviderBaseUrl(endpoint.baseUrl, api),
		api,
		...(apiKey ? { apiKey } : {}),
		models,
	};
	await writeModelsConfig(file, upsertProviderEntry(loaded.config, draft, previousName));
	await ctx.session.modelRegistry.refresh("offline");
	ctx.showStatus(
		`${previousName ? "Updated" : "Added"} custom inference provider "${draft.name}" with ${models.length} model(s).`,
	);
}

/** Edit flow: pick a provider, then change only the requested fields. */
async function runEditWizard(ctx: InteractiveModeContext): Promise<void> {
	const file = resolveModelsConfigFileForPath(ctx.session.modelRegistry.modelsConfigPath);
	const loaded = await loadModelsConfig(file);
	if (!loaded.ok) {
		ctx.showStatus(`Cannot read the models configuration: ${loaded.error}`);
		return;
	}
	const names = listCustomProviderNames(loaded.config);
	if (names.length === 0) {
		ctx.showStatus("No custom inference providers are configured.");
		return;
	}
	const selected = await ctx.showHookSelector(
		"Custom inference provider to edit",
		names.map(name => ({ label: name, description: loaded.config.providers?.[name]?.baseUrl })),
	);
	if (!selected) return;
	await runProviderWizard(ctx, selected);
}

/** Remove flow: pick a provider and confirm the removal. */
async function runRemoveWizard(ctx: InteractiveModeContext): Promise<void> {
	const file = resolveModelsConfigFileForPath(ctx.session.modelRegistry.modelsConfigPath);
	const loaded = await loadModelsConfig(file);
	if (!loaded.ok) {
		ctx.showStatus(`Cannot read the models configuration: ${loaded.error}`);
		return;
	}
	const names = listCustomProviderNames(loaded.config);
	if (names.length === 0) {
		ctx.showStatus("No custom inference providers are configured.");
		return;
	}
	const selected = await ctx.showHookSelector(
		"Custom inference provider to remove",
		names.map(name => ({ label: name, description: loaded.config.providers?.[name]?.baseUrl })),
	);
	if (!selected) return;
	const confirmed = await ctx.showHookConfirm(
		`Remove "${selected}"?`,
		`This deletes the provider and its models from the models configuration.`,
	);
	if (!confirmed) return;
	await writeModelsConfig(file, removeProviderEntry(loaded.config, selected));
	await ctx.session.modelRegistry.refresh("offline");
	ctx.showStatus(`Removed custom inference provider "${selected}".`);
}

/** List flow: print every custom provider with its endpoint and models. */
async function runListWizard(ctx: InteractiveModeContext): Promise<void> {
	const file = resolveModelsConfigFileForPath(ctx.session.modelRegistry.modelsConfigPath);
	const loaded = await loadModelsConfig(file);
	if (!loaded.ok) {
		ctx.showStatus(`Cannot read the models configuration: ${loaded.error}`);
		return;
	}
	const names = listCustomProviderNames(loaded.config);
	if (names.length === 0) {
		ctx.showStatus("No custom inference providers are configured.");
		return;
	}
	ctx.showStatus(names.map(name => formatCustomProvider(loaded.config, name)).join("\n\n"));
}

/** Main menu loop for `/inference-provider`. */
export async function showInferenceProviderMenu(ctx: InteractiveModeContext): Promise<void> {
	for (;;) {
		const selected = await ctx.showHookSelector("Custom inference providers", [
			{ label: "Add", description: "Register a new custom endpoint" },
			{ label: "Edit", description: "Change an existing custom endpoint" },
			{ label: "Remove", description: "Delete a custom endpoint" },
			{ label: "List", description: "Show every custom endpoint" },
		]);
		if (!selected) return;
		switch (selected) {
			case "Add":
				await runProviderWizard(ctx);
				break;
			case "Edit":
				await runEditWizard(ctx);
				break;
			case "Remove":
				await runRemoveWizard(ctx);
				break;
			case "List":
				await runListWizard(ctx);
				break;
			default:
				return;
		}
	}
}

/**
 * TUI handler for `/inference-provider`.
 *
 * With no arguments it opens the menu; with arguments it delegates to the
 * shared text-mode command so both dispatchers agree on the contract.
 */
export async function handleInferenceProviderCommandTui(
	command: ParsedSlashCommand,
	ctx: InteractiveModeContext,
): Promise<SlashCommandResult> {
	ctx.editor.setText("");
	if (!command.args.trim()) {
		await showInferenceProviderMenu(ctx);
		return { consumed: true };
	}
	return handleInferenceProviderSlashCommand(command, {
		session: ctx.session,
		sessionManager: ctx.sessionManager,
		settings: ctx.settings,
		cwd: ctx.sessionManager.getCwd(),
		output: text => ctx.showStatus(text),
		refreshCommands: () => ctx.refreshSlashCommandState(),
		reloadPlugins: async () => {},
	});
}
