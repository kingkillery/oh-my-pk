/**
 * TokenEconomizer for OMPK (oh-my-pk / ompk-connector-to-gpt).
 *
 * Port of `plugin/pi/tokeneconomizer.ts` (TokenEconomizer) to OMPK's ExtensionAPI.
 * Every lifecycle event becomes one dispatcher call (`vendor/.../plugin/scripts/te-hook`
 * with `--host ompk`, JSON in, JSON out) and the answer is applied with OMPK's levers.
 *
 *   session_start       -> SessionStart       the learned manual, kept for the session;
 *                                            a resumed session keeps the manual it carries
 *   before_agent_start  -> UserPromptSubmit  opens a prompt-turn; the manual is returned as
 *                                            `systemPrompt` for this turn (OMPK merges via
 *                                            `ExtensionRunner.emitBeforeAgentStart`)
 *   tool_result         -> PostToolUse       the loopguard; a redirect is delivered as a
 *                                            steering message, a still-stuck notice as a UI notice
 *   agent_end           -> Stop              closes the turn
 *   session_shutdown    -> SessionEnd        hands the session to a detached fold
 *
 * Fails open: a dispatcher that is missing, slow or broken answers "no change".
 * Does nothing under TE_SIDECALL=1 or TE_DISABLE=1. `/te <command>` runs the `te` CLI
 * for this repository.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../extensibility/extensions/types.js";

const HERE: string = (() => {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		// Fallback for environments where import.meta.url is unavailable.
		return typeof __dirname !== "undefined" ? __dirname : process.cwd();
	}
})();

// OMPK vendor layout: packages/coding-agent/vendor/tokeneconomizer/plugin/scripts
// From src/tokeneconomizer/extension.ts that's ../../vendor/tokeneconomizer/plugin/scripts
const SCRIPTS = join(HERE, "..", "..", "vendor", "tokeneconomizer", "plugin", "scripts");
const HOOK_TIMEOUT_MS = 60_000;
const SECTION = "tokeneconomizer";

const truthy = (v: string | undefined): boolean =>
	["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());

interface DispatcherResult {
	hookSpecificOutput?: {
		additionalContext?: string;
	};
	systemMessage?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDispatcherOutput(raw: string): DispatcherResult {
	const text = raw.trim();
	if (text.length === 0) return {};
	const lastLine = text.split("\n").pop() ?? "";
	if (lastLine.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(lastLine);
	} catch {
		return {};
	}
	if (!isRecord(parsed)) return {};
	const out: DispatcherResult = {};
	if ("systemMessage" in parsed && typeof parsed.systemMessage === "string") {
		out.systemMessage = parsed.systemMessage;
	}
	if ("hookSpecificOutput" in parsed && isRecord(parsed.hookSpecificOutput)) {
		const hoc = parsed.hookSpecificOutput;
		if ("additionalContext" in hoc && typeof hoc.additionalContext === "string") {
			out.hookSpecificOutput = { additionalContext: hoc.additionalContext };
		} else if (Object.keys(hoc).length === 0) {
			out.hookSpecificOutput = {};
		}
	}
	return out;
}

/**
 * The program and arguments that run a launcher. The launchers are POSIX `sh`,
 * which Windows cannot start; there the bootstrap they run is started with
 * Python itself (`TE_PYTHON`, else `python`).
 */
export function launch(
	script: string,
	args: string[],
	platform: string = process.platform,
): [string, string[]] {
	if (platform !== "win32") return [join(SCRIPTS, script), args];
	const mode = script === "te-hook" ? "hook" : "cli";
	const python = process.env.TE_PYTHON ?? "python";
	return [python, [join(SCRIPTS, "te_bootstrap.py"), mode, ...args]];
}

/**
 * Run one of the plugin's launchers with `input` on stdin; resolve to its stdout.
 */
function run(
	script: string,
	args: string[],
	input: string,
	mode: string,
	extra: Record<string, string> = {},
): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	let out = "";
	let child: ReturnType<typeof spawn> | undefined;
	try {
		const [program, argv] = launch(script, args);
		child = spawn(program, argv, {
			env: { ...process.env, PYTHONUTF8: "1", TE_OMPK_MODE: mode, ...extra },
			stdio: ["pipe", "pipe", "ignore"],
		});
	} catch {
		resolve("");
		return promise;
	}
	const timer = setTimeout(() => {
		if (child) child.kill("SIGKILL");
		resolve("");
	}, HOOK_TIMEOUT_MS);
	if (child.stdout) {
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (d: string) => {
			out += d;
		});
	}
	child.on("error", () => {
		clearTimeout(timer);
		resolve("");
	});
	child.on("close", () => {
		clearTimeout(timer);
		resolve(out);
	});
	child.stdin?.on("error", () => {});
	child.stdin?.end(input);
	return promise;
}

/** One dispatcher call; `{}` (no change) on any failure. */
async function callHook(payload: Record<string, unknown>, mode: string): Promise<DispatcherResult> {
	if (truthy(process.env.TE_SIDECALL) || truthy(process.env.TE_DISABLE)) return {};
	const out = await run("te-hook", ["--host", "ompk"], JSON.stringify(payload), mode);
	return parseDispatcherOutput(out);
}

/** A notice in the UI; on stderr in print/json/rpc modes which have no UI. */
function notify(ctx: ExtensionContext, text: unknown): void {
	if (typeof text !== "string" || text.length === 0) return;
	if (ctx.hasUI) ctx.ui.notify(text, "info");
	else console.error(text);
}

const SOURCE: Record<string, string> = {
	startup: "startup",
	new: "clear",
	resume: "resume",
	fork: "resume",
	reload: "resume",
};

function readStringField(obj: unknown, key: string): string | undefined {
	if (isRecord(obj) && key in obj && typeof obj[key] === "string") return obj[key];
	return undefined;
}

/**
 * The section a conversation that already holds messages carries.
 * OMPK replays system entries similarly to Pi, so resumed sessions must keep
 * the same section text to preserve prompt-cache stability.
 */
export function carriedSection(entries: unknown[]): string {
	let text = "";
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const entryType = readStringField(entry, "type");
		if (entryType === "compaction" && isRecord(entry.systemMessage) && isRecord(entry.systemMessage.sections)) {
			const sec = entry.systemMessage.sections[SECTION];
			if (typeof sec === "string") text = sec;
			else if (sec === null || sec === undefined) text = "";
		} else if (entryType === "message" && isRecord(entry.message)) {
			const role = readStringField(entry.message, "role");
			if (role === "system" && isRecord(entry.message.sections) && SECTION in entry.message.sections) {
				const sec = entry.message.sections[SECTION];
				if (typeof sec === "string") text = sec;
				else if (sec === null || sec === undefined) text = "";
			}
		}
	}
	const open = `<${SECTION}>\n`;
	const close = `\n</${SECTION}>`;
	return text.startsWith(open) && text.endsWith(close)
		? text.slice(open.length, text.length - close.length)
		: text;
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
	return isRecord(part) && part.type === "text" && typeof part.text === "string";
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (isTextPart(part)) texts.push(part.text);
	}
	return texts.join("\n");
}

function getExitCode(details: unknown): number | undefined {
	if (!isRecord(details)) return undefined;
	if ("exitCode" in details) {
		const candidate = details.exitCode;
		if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
	}
	if ("exit_code" in details) {
		const candidate = details.exit_code;
		if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
	}
	return undefined;
}

function readReason(event: unknown): string | undefined {
	if (isRecord(event) && "reason" in event && typeof event.reason === "string") return event.reason;
	return undefined;
}

function vendorRootForCommand(): string {
	try {
		const d = dirname(fileURLToPath(import.meta.url));
		return join(d, "..", "..", "vendor", "tokeneconomizer");
	} catch {
		return join(process.cwd(), "packages", "coding-agent", "vendor", "tokeneconomizer");
	}
}

export function createTokeneconomizerExtension(): ExtensionFactory {
	return (api: ExtensionAPI): void => {
		let manual = "";
		let prompts = 0;
		let turn = "";

		const base = (ctx: ExtensionContext): Record<string, unknown> => ({
			session_id: ctx.sessionManager.getSessionId(),
			transcript_path: ctx.sessionManager.getSessionFile() ?? "",
			cwd: ctx.cwd,
		});

		api.on("session_start", async (event, ctx) => {
			prompts = 0;
			const entries: unknown[] = ctx.sessionManager.getBranch() as unknown as unknown[];
			const carried = entries.some((entry) => isRecord(entry) && entry.type === "message");
			const reason = readReason(event);
			const source = carried ? "resume" : (reason !== undefined ? (SOURCE[reason] ?? "startup") : "startup");
			const mode = ctx.hasUI ? "tui" : "print";
			const out = await callHook({ ...base(ctx), hook_event_name: "SessionStart", source }, mode);
			if (carried) {
				manual = carriedSection(entries);
			} else {
				const ctx2 = out.hookSpecificOutput?.additionalContext;
				manual = typeof ctx2 === "string" ? ctx2 : "";
			}
			notify(ctx, out.systemMessage);
		});

		api.on("before_agent_start", async (event, ctx) => {
			prompts += 1;
			turn = `${ctx.sessionManager.getSessionId()}:${prompts}`;
			const mode = ctx.hasUI ? "tui" : "print";
			const out = await callHook(
				{ ...base(ctx), hook_event_name: "UserPromptSubmit", prompt_id: turn, prompt: event.prompt },
				mode,
			);
			const extra = out.hookSpecificOutput?.additionalContext;
			if (typeof extra === "string" && extra.length > 0) {
				manual = manual.length > 0 ? `${manual}\n\n${extra}` : extra;
			}
			notify(ctx, out.systemMessage);
			// `systemPrompt` REPLACES the current prompt in emitBeforeAgentStart — the
			// event carries the incoming array, so the manual must be appended to it,
			// never returned alone (that would wipe the agent's whole system prompt).
			if (manual.length > 0) return { systemPrompt: [...event.systemPrompt, manual] };
			return undefined;
		});

		api.on("tool_result", async (event, ctx) => {
			const content = extractTextContent(event.content);
			const exitCode = getExitCode(event.details);
			const toolResponse: Record<string, unknown> = {
				content,
				isError: event.isError,
			};
			if (exitCode !== undefined) toolResponse.exit_code = exitCode;
			const mode = ctx.hasUI ? "tui" : "print";
			const out = await callHook(
				{
					...base(ctx),
					hook_event_name: "PostToolUse",
					prompt_id: turn,
					tool_name: event.toolName,
					tool_use_id: event.toolCallId,
					tool_input: event.input ?? {},
					tool_response: toolResponse,
				},
				mode,
			);
			const nudge = out.hookSpecificOutput?.additionalContext;
			if (typeof nudge === "string" && nudge.length > 0) {
				api.sendMessage({ customType: SECTION, content: nudge, display: true }, { deliverAs: "steer" });
			}
			notify(ctx, out.systemMessage);
		});

		// OMPK fires agent_end, session_stop and turn_end for the same settle point;
		// the dispatcher's Stop must be sent exactly once per prompt-turn or the
		// loopguard would over-record. `stopsSent` dedupes on the turn key.
		let stopsSent = "";
		const sendStop = async (ctx: ExtensionContext, stopHookActive: boolean): Promise<void> => {
			if (turn === "" || stopsSent === turn) return;
			stopsSent = turn;
			const mode = ctx.hasUI ? "tui" : "print";
			await callHook({ ...base(ctx), hook_event_name: "Stop", prompt_id: turn, stop_hook_active: stopHookActive }, mode);
		};

		api.on("agent_end", async (_event, ctx) => {
			await sendStop(ctx, false);
		});

		api.on("session_stop", async (event, ctx) => {
			await sendStop(ctx, event.stop_hook_active === true);
		});

		api.on("turn_end", async (_event, ctx) => {
			await sendStop(ctx, false);
		});

		api.on("session_shutdown", async (event, ctx) => {
			const mode = ctx.hasUI ? "tui" : "print";
			const reason = readReason(event) ?? "exit";
			await callHook({ ...base(ctx), hook_event_name: "SessionEnd", reason }, mode);
		});

		api.registerCommand("te", {
			description: "TokenEconomizer: status | microskills | config | repos",
			handler: async (args, ctx) => {
				const argv = (args ?? "status").trim().split(/\s+/).filter((s) => s.length > 0);
				const mode = ctx.hasUI ? "tui" : "print";
				const out = await run(
					"te",
					["--host", "ompk", "--cwd", ctx.cwd, ...argv],
					"",
					mode,
					{
						TE_SESSION_ID: ctx.sessionManager.getSessionId(),
						TE_CORE_PATH: vendorRootForCommand(),
					},
				);
				notify(ctx, out.trim() || "te: no output (is Python 3.10+ on PATH?)");
			},
		});
	};
}
