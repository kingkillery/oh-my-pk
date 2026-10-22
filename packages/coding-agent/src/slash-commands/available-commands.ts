import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { SkillsSettings } from "../config/settings";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { ExtensionRunner } from "../extensibility/extensions";
import { getSkillSlashCommandName, type Skill } from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands } from "../extensibility/slash-commands";
import { ACP_BUILTIN_RESERVED_NAMES, isAcpBuiltinShadowedName } from "./acp-builtins";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "./builtin-registry";

export type AvailableSlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

export interface InternalAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface AvailableCommandsSession {
	readonly extensionRunner?: ExtensionRunner;
	readonly customCommands: ReadonlyArray<LoadedCustomCommand>;
	readonly mcpPromptCommands?: ReadonlyArray<LoadedCustomCommand>;
	readonly skills: ReadonlyArray<Skill>;
	readonly skillsSettings?: SkillsSettings;
	setSlashCommands(slashCommands: FileSlashCommand[]): void;
	sessionManager: { getCwd(): string };
}

export async function buildAvailableSlashCommands(
	session: AvailableCommandsSession,
	loadFileCommands: (cwd: string) => Promise<FileSlashCommand[]> = cwd => loadSlashCommands({ cwd }),
): Promise<InternalAvailableSlashCommand[]> {
	const commands: InternalAvailableSlashCommand[] = [];
	const seenNames = new Set<string>();
	const appendCommand = (command: InternalAvailableSlashCommand): void => {
		if (seenNames.has(command.name)) return;
		seenNames.add(command.name);
		commands.push(command);
	};

	for (const command of BUILTIN_SLASH_COMMANDS_INTERNAL) {
		if (!command.handle) continue;
		const hint = command.acpInputHint ?? command.inlineHint;
		appendCommand({
			name: command.name,
			aliases: command.aliases,
			description: command.acpDescription ?? command.description,
			input: hint ? { hint } : undefined,
			subcommands: command.subcommands,
			source: "builtin",
		});
	}

	const runner = session.extensionRunner;
	if (runner) {
		for (const command of runner.getRegisteredCommands(ACP_BUILTIN_RESERVED_NAMES)) {
			if (isAcpBuiltinShadowedName(command.name)) continue;
			appendCommand({
				name: command.name,
				description: command.description ?? "(extension command)",
				input: { hint: "arguments" },
				source: "extension",
			});
		}
	}

	for (const command of session.customCommands) {
		const source: AvailableSlashCommandSource = command.path?.startsWith("mcp:") ? "mcp_prompt" : "custom";
		appendCommand({
			name: command.command.name,
			description: command.command.description,
			input: { hint: "arguments" },
			source,
		});
	}

	const fileCommands = await loadFileCommands(session.sessionManager.getCwd());
	session.setSlashCommands(fileCommands);
	for (const command of fileCommands) {
		appendCommand({ name: command.name, description: command.description, source: "file" });
	}

	// Skills are advertised last: ACP clients with a bounded command budget
	// (T3 Code accepts 128 entries across slash commands and skills) otherwise
	// truncate project, extension, and custom commands, which are far scarcer
	// and more specific than the skill catalog.
	if (session.skillsSettings?.enableSkillCommands) {
		for (const skill of session.skills) {
			appendCommand({
				name: getSkillSlashCommandName(skill),
				description: skill.description || `Run ${skill.name} skill`,
				input: { hint: "arguments" },
				source: "skill",
			});
		}
	}

	return commands;
}

const ACP_SKILL_PREFIX = "$";

export function toAcpAvailableCommands(commands: readonly InternalAvailableSlashCommand[]): AvailableCommand[] {
	return commands.map(command => ({
		name: toAcpCommandName(command),
		description: command.description ?? "",
		input: command.input,
	}));
}

/**
 * ACP clients that model skills separately (T3 Code) only recognise the
 * `$skill` form: a `skill:name` entry is treated as an ordinary slash command
 * and never reaches the skill menu. Internal `skill:` names stay intact for
 * RPC and extension consumers, so the translation lives at the ACP boundary.
 */
function toAcpCommandName(command: InternalAvailableSlashCommand): string {
	if (command.source !== "skill") {
		return command.name;
	}
	const skillName = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
	return `${ACP_SKILL_PREFIX}${skillName}`;
}
