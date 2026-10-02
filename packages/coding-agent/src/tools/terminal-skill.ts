import type { Skill } from "../extensibility/skills";
import { SkillProtocolHandler } from "../internal-urls/skill-protocol";
import type { TerminalLaunchSkill } from "../terminal/launch";

/** Resolve only the canonical installed skill selected by this session's discovery settings. */
export async function resolveTerminalLaunchSkill(skills: readonly Skill[] = []): Promise<TerminalLaunchSkill> {
	const skill = skills.find(candidate => candidate.name === "pk-herdr");
	if (!skill || skill.embeddedContent !== undefined) {
		throw new Error(
			"Interactive terminals require the installed pk-herdr skill; resolve skill://pk-herdr before launching.",
		);
	}
	const resource = await new SkillProtocolHandler().resolve(
		Object.assign(new URL("skill://pk-herdr"), { rawHost: "pk-herdr" }),
		{ skills },
	);
	if (resource.contentType !== "text/markdown" || !resource.content.trim()) {
		throw new Error("The installed pk-herdr skill must be a readable, nonempty Markdown file.");
	}
	return { name: "pk-herdr", filePath: skill.filePath, content: resource.content };
}
