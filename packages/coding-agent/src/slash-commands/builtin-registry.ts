import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Markdown, Spacer, type AutocompleteItem } from "@pk-nerdsaver-ai/pi-tui";
import { getProjectDir } from "@pk-nerdsaver-ai/pi-utils";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "../collab/guest";
import type { Settings } from "../config/settings";
import { type NineRouterRoutingResult, applyNineRouterRouting } from "../config/nine-router-controller";
import { getMarkdownTheme } from "../modes/theme/tui-adapters";
import { BUILTIN_COLLABORATION_SLASH_COMMANDS } from "./builtin-collaboration";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildMcpArgumentCompletions,
	buildStaticInlineHint,
	buildSubcommandInlineHint,
} from "./builtin-completions";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "./builtin-control";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "./builtin-lifecycle";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS, reloadTuiPluginState } from "./builtin-marketplace";
import { BUILTIN_MODE_SLASH_COMMANDS } from "./builtin-modes";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "./builtin-session";
import { errorMessage, parseSlashCommand } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

function resolveMoveCompletionBase(base: string, cwd: string): string {
	if (!base) return cwd;
	if (base === "~" || base === "~/") return os.homedir();
	if (base.startsWith("~/")) return path.join(os.homedir(), base.slice(2));
	if (path.isAbsolute(base)) return base;
	return path.resolve(cwd, base);
}

async function listMoveDirectoryCompletions(
	dir: string,
	displayPrefix: string,
	query: string,
): Promise<AutocompleteItem[] | null> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return null;
	}
	const includeHidden = query.startsWith(".");
	const lower = query.toLowerCase();
	const items: AutocompleteItem[] = [];
	for (const name of names.sort((a, b) => a.localeCompare(b))) {
		if (!includeHidden && name.startsWith(".")) continue;
		if (query && !name.toLowerCase().startsWith(lower)) continue;
		try {
			if (!(await fs.stat(path.join(dir, name))).isDirectory()) continue;
		} catch {
			continue;
		}
		items.push({ value: `${displayPrefix}${name}/`, label: `${name}/` });
	}
	return items.length > 0 ? items : null;
}

/** Directory completions for `/move <path>`: `~`, absolute, and cwd-relative prefixes. */
function completeMoveDirectories(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
	const cwd = getProjectDir();
	const normalized = argumentPrefix.replace(/\\/g, "/");
	const slashIdx = normalized.lastIndexOf("/");
	const base = slashIdx === -1 ? "" : normalized.slice(0, slashIdx + 1);
	const query = slashIdx === -1 ? normalized : normalized.slice(slashIdx + 1);
	// A bare navigation token (".", "..", "~") means "list that directory's
	// children", not "filter the current listing by it".
	if (query === "." || query === ".." || query === "~") {
		const asBase = `${normalized}/`;
		return listMoveDirectoryCompletions(resolveMoveCompletionBase(asBase, cwd), asBase, "");
	}
	return listMoveDirectoryCompletions(resolveMoveCompletionBase(base, cwd), base, query);
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	...BUILTIN_MODE_SLASH_COMMANDS,
	...BUILTIN_COLLABORATION_SLASH_COMMANDS,
	...BUILTIN_SESSION_SLASH_COMMANDS,
	...BUILTIN_LIFECYCLE_SLASH_COMMANDS,
	...BUILTIN_MARKETPLACE_SLASH_COMMANDS,
	...BUILTIN_CONTROL_SLASH_COMMANDS,
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
		icon: command.icon,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.subcommands) {
		materialized.getArgumentCompletions =
			cmd.name === "mcp" && runtime
				? buildMcpArgumentCompletions(cmd.subcommands, runtime)
				: buildArgumentCompletions(cmd.subcommands);
		materialized.getInlineHint = buildSubcommandInlineHint(cmd.subcommands);
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;
/** Whether editor prompt history may persist this builtin invocation. */
export function shouldPersistBuiltinSlashCommand(text: string): boolean {
	const parsed = parseSlashCommand(text);
	if (!parsed) return true;
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name)?.persistInHistory !== false;
}

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		runtime.ctx.editor.setText("");
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: () => reloadTuiPluginState(ctx),
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };

function renderNineRouterRoutes(result: NineRouterRoutingResult): string {
	const lines = result.routes.map(
		route =>
			`${route.role}: ${route.selected ?? "unrouted"} (${route.available.length}/${route.candidates.length} available, ${route.probed.length} probed)`,
	);
	if (result.errors.length > 0) {
		lines.push(...result.errors.map(error => `error: ${error}`));
	}
	if (result.routes.some(r => r.selected === null)) {
		lines.push("Some roles could not be routed. Check that 9router is running and the combo names are configured.");
	}
	return lines.join("\n");
}

async function runNineRouterSlashCommand(
	settings: Settings,
	mode: "list" | "probe",
	output: (text: string) => void | Promise<void>,
): Promise<void> {
	const result = await applyNineRouterRouting(settings, { mode });
	await output(renderNineRouterRoutes(result));
}

async function handleCatGptCommand(
	promptText: string,
	intensity: string,
	runtime: SlashCommandRuntime | BuiltinSlashCommandRuntime,
	isTui: boolean,
): Promise<void> {
	const gatewayUrl = "http://127.0.0.1:8000";
	const token = "dummy123";

	if (isTui && "ctx" in runtime) {
		runtime.ctx.showStatus(`CatGPT (${intensity}): communicating...`);
	} else if ("output" in runtime) {
		await runtime.output(`CatGPT (${intensity}): communicating...`);
	}

	try {
		if (!promptText) {
			// No prompt, just switch the browser model picker
			const response = await fetch(`${gatewayUrl}/model/select`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					model: "catgpt-browser",
					intensity,
				}),
			});
			if (!response.ok) {
				const errText = await response.text();
				throw new Error(`Gateway returned HTTP ${response.status}: ${errText}`);
			}
			const data = (await response.json()) as { selected?: string };
			const selected = data.selected || "default";
			const msg = `CatGPT intensity switched to: ${intensity} (${selected})`;
			if (isTui && "ctx" in runtime) {
				runtime.ctx.showStatus(msg);
			} else if ("output" in runtime) {
				await runtime.output(msg);
			}
			return;
		}

		// Prompt is present, request completion
		const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				model: "catgpt-browser",
				messages: [{ role: "user", content: promptText }],
				intensity,
			}),
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error(`Gateway returned HTTP ${response.status}: ${errText}`);
		}

		const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
		const reply = data.choices?.[0]?.message?.content;
		if (!reply) {
			throw new Error("No response content received from CatGPT.");
		}

		if (isTui && "ctx" in runtime) {
			runtime.ctx.showStatus(`CatGPT (${intensity}) complete.`);
			runtime.ctx.present([new Spacer(1), new Markdown(reply, 1, 0, getMarkdownTheme()), new Spacer(1)]);
		} else if ("output" in runtime) {
			await runtime.output(reply);
		}
	} catch (err: unknown) {
		const errMsg = `CatGPT Error: ${errorMessage(err)}`;
		if (isTui && "ctx" in runtime) {
			runtime.ctx.showError(errMsg);
		} else if ("output" in runtime) {
			await runtime.output(errMsg);
		}
	}
}
