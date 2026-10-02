// Tool-call gate: one SystemOne round trip classifies a bash command before it runs.
// Opt-in via OMP_JEV_BASH_GATE: "1" enforces, "shadow" logs only. The judgment
// backend can be an auto-discovered tailnet decision endpoint, TypeSafe, or OpenRouter.
// Shadow mode is useful to collect real-traffic data before
// enforcing. Fail-open: any timeout, API error, or low-confidence answer allows
// the command, so this can only ever add a block — it never becomes a new way
// for bash to break. The command is model-authored, untrusted text; Jev has no
// adversarial resistance, so this is a second opinion layered on existing
// policy, not a security boundary.

import { $env, logger } from "@pk-nerdsaver-ai/pi-utils";
import bashGateQuestions from "../prompts/tools/jev-bash-gate.md" with { type: "text" };
import { resolveToCwd } from "../tools/path-utils";
import { decisionEndpointIdentityHint } from "./decision-endpoint-discovery";
import { resolveTypeSafeBaseUrl, resolveTypeSafeModelId, systemOne, type TypeSafeQuestion } from "./typesafe-http";

export const BLOCK_CONFIDENCE = 0.85;
export const DESTRUCTIVE_NOUL = 0.9;
const GATE_TIMEOUT_MS = 2_500;
const QUESTIONS = JSON.parse(bashGateQuestions) as Record<string, TypeSafeQuestion>;

/** Identity of the actual judgment inputs; threshold sweeps deliberately reuse verdicts. */
export function getBashJudgmentCacheKey(command: string, cwd: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify({
				version: 2,
				state: { command, working_directory: cwd },
				decisionEndpoint: decisionEndpointIdentityHint(),
				externalBaseUrl: resolveTypeSafeBaseUrl(),
				externalModel: resolveTypeSafeModelId(),
				questions: QUESTIONS,
			}),
		)
		.digest("hex");
}

export interface BashVerdict {
	choice: string;
	confidence: number;
	destructive: number;
	latencyMs: number;
}

function gateMode(): "off" | "shadow" | "enforce" {
	const flag = $env.OMP_JEV_BASH_GATE;
	return flag === "1" ? "enforce" : flag === "shadow" ? "shadow" : "off";
}

/** Raw Jev verdict for one command, or undefined on any failure. Never throws. */
export async function judgeBashCommand(
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<BashVerdict | undefined> {
	const start = performance.now();
	try {
		const { answers } = await systemOne({ command, working_directory: cwd }, QUESTIONS, {
			timeoutMs: GATE_TIMEOUT_MS,
			signal,
		});
		const { action, destructive } = answers;
		if (action?.type !== "choice" || destructive?.type !== "noul") return undefined;
		return {
			choice: action.choice,
			confidence: action.confidence,
			destructive: destructive.noul,
			latencyMs: Math.round(performance.now() - start),
		};
	} catch (error) {
		logger.debug(`[JevBashGate] failed open: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/** Block reason for a verdict, or undefined to allow. Shared by the gate and the replay eval. */
export function verdictBlockReason(verdict: BashVerdict | undefined): string | undefined {
	if (!verdict) return undefined;
	if (verdict.choice === "block" && verdict.confidence >= BLOCK_CONFIDENCE) {
		return "Blocked by Jev bash gate: command classified as destructive or out of scope. Ask the user before retrying.";
	}
	if (verdict.destructive >= DESTRUCTIVE_NOUL) {
		return "Blocked by Jev bash gate: command looks irreversible. Ask the user before retrying.";
	}
	return undefined;
}

/** Returns a block reason, or undefined to allow. Never throws. */
export async function getJevBashBlockReason(
	command: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const mode = gateMode();
	if (mode === "off") return undefined;
	const verdict = await judgeBashCommand(command, cwd, signal);
	const reason = verdictBlockReason(verdict);
	if (mode === "shadow") {
		logger.info("[JevBashGate] shadow verdict", { command: command.slice(0, 500), verdict, wouldBlock: !!reason });
		return undefined;
	}
	return reason;
}

/** Adapter shared by the SDK and contract tests; relative paths use BashTool's resolver. */
export async function getJevBashToolBlockReason(
	args: Record<string, unknown>,
	sessionCwd: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (typeof args.command !== "string") return undefined;
	const cwd = typeof args.cwd === "string" && args.cwd ? resolveToCwd(args.cwd, sessionCwd) : sessionCwd;
	return getJevBashBlockReason(args.command, cwd, signal);
}
