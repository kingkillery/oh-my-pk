/**
 * Loop spiral synthesis: the verifier/synthesis step that runs between `/loop`
 * iterations when `loop.mode` is `"spiral"`.
 *
 * After an iteration completes, a single stateless completion grades the latest
 * transcript against the immutable objective and emits a focusing reflection.
 * The reflection is fed additively into the next iteration's prompt (the
 * objective itself never changes), so context compounds the way Self-Refine
 * (arXiv:2303.17651) and Reflexion (arXiv:2303.11366) describe. The call runs in
 * its own context — it never saw the generation it grades — which is the
 * adversarial-independence property a verifier needs.
 */
import { instrumentedCompleteSimple, resolveTelemetry, serializeConversation } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Tool } from "@pk-nerdsaver-ai/pi-ai";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import loopSynthesisSystemPrompt from "../prompts/loop/loop-synthesis-system.md" with { type: "text" };
import loopSynthesisUserPrompt from "../prompts/loop/loop-synthesis-user.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { convertToLlm } from "../session/messages";
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";

const RESPOND_TOOL_NAME = "respond";

const RESPOND_TOOL: Tool = {
	name: RESPOND_TOOL_NAME,
	description: "Return the loop completeness verdict and the focusing reflection for the next iteration.",
	parameters: {
		type: "object",
		properties: {
			complete: {
				type: "boolean",
				description: "True only when the objective is fully satisfied with evidence in the transcript.",
			},
			reflection: {
				type: "string",
				description: "Concise focusing context for the next iteration: progress, remaining, lessons, next focus.",
			},
		},
		required: ["complete", "reflection"],
		additionalProperties: false,
	},
	strict: false,
};

/** Marker wrapping the synthesized reflection injected into the next iteration prompt. */
export const LOOP_SPIRAL_BLOCK_OPEN = "<loop-progress>";
export const LOOP_SPIRAL_BLOCK_CLOSE = "</loop-progress>";

/** Default cap on serialized transcript characters fed to the synthesizer. */
export const LOOP_SPIRAL_TRANSCRIPT_CHAR_BUDGET = 12_000;

export interface LoopSynthesisResult {
	/** Whether the objective is fully satisfied (loop should stop). */
	complete: boolean;
	/** Focusing reflection for the next iteration. Empty when nothing to add. */
	reflection: string;
}

export interface LoopSynthesisOptions {
	/** The immutable loop objective. */
	objective: string;
	signal?: AbortSignal;
	/** Override the serialized transcript char budget (tests). */
	transcriptCharBudget?: number;
}

/**
 * Compose the next iteration prompt: the immutable objective followed by the
 * synthesized reflection in a delimited block. Returns the objective unchanged
 * when there is no reflection to add.
 */
export function composeSpiralPrompt(objective: string, reflection: string): string {
	const trimmed = reflection.trim();
	if (!trimmed) return objective;
	return `${objective}\n\n${LOOP_SPIRAL_BLOCK_OPEN}\n${trimmed}\n${LOOP_SPIRAL_BLOCK_CLOSE}`;
}

/** Serialize the tail of the current conversation to bounded text for the synthesizer. */
function buildTranscript(session: AgentSession, charBudget: number): string {
	const messages = session.buildDisplaySessionContext().messages;
	const text = serializeConversation(convertToLlm(messages)).trim();
	if (text.length <= charBudget) return text;
	const tail = text.slice(text.length - charBudget);
	return `[... earlier transcript truncated]\n${tail}`;
}

export interface LoopVerifierResolution {
	role: "plan" | "slow" | "session";
	resolved: ReturnType<AgentSession["resolveRoleModelWithThinking"]>;
}

export function resolveLoopVerifier(session: AgentSession): LoopVerifierResolution | undefined {
	const plan = session.resolveRoleModelWithThinking("plan");
	if (plan.model) return { role: "plan", resolved: plan };
	const slow = session.resolveRoleModelWithThinking("slow");
	if (slow.model) return { role: "slow", resolved: slow };
	if (!session.model) return undefined;
	return {
		role: "session",
		resolved: {
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			explicitThinkingLevel: false,
			warning: undefined,
		},
	};
}

export function formatLoopVerifierLabel(verifier: LoopVerifierResolution): string {
	const model = verifier.resolved.model;
	if (!model) return verifier.role;
	const thinkingSuffix =
		verifier.resolved.explicitThinkingLevel && verifier.resolved.thinkingLevel !== "off"
			? `:${verifier.resolved.thinkingLevel}`
			: "";
	return `${verifier.role}: ${model.provider}/${model.id}${thinkingSuffix}`;
}

/**
 * Run one verifier/synthesis pass. Returns `{ complete, reflection }`. When the
 * transcript is empty (nothing to grade), returns a no-op result so the caller
 * re-submits the bare objective.
 */
export async function runLoopSynthesis(
	session: AgentSession,
	options: LoopSynthesisOptions,
): Promise<LoopSynthesisResult> {
	const transcript = buildTranscript(session, options.transcriptCharBudget ?? LOOP_SPIRAL_TRANSCRIPT_CHAR_BUDGET);
	if (!transcript) return { complete: false, reflection: "" };

	const verifier = resolveLoopVerifier(session);
	const resolved = verifier?.resolved;
	if (!resolved?.model) {
		throw new Error("No plan, slow, or current session model is available for loop synthesis.");
	}

	const apiKey = await session.modelRegistry.getApiKey(resolved.model, session.sessionId);
	if (!apiKey) {
		throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
	}

	const userPrompt = prompt.render(loopSynthesisUserPrompt, { objective: options.objective, transcript });
	// Route the objective + transcript through the session obfuscator so secrets
	// typed into the objective or surfaced in the transcript are never sent
	// verbatim to the plan/slow provider. The reflection is deobfuscated below.
	const obfuscator = session.obfuscator;
	const promptText = obfuscator?.hasSecrets() ? obfuscator.obfuscate(userPrompt) : userPrompt;

	const response = await instrumentedCompleteSimple(
		resolved.model,
		{
			systemPrompt: [prompt.render(loopSynthesisSystemPrompt)],
			messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
			tools: [RESPOND_TOOL],
		},
		{
			apiKey: session.modelRegistry.resolver(resolved.model, session.sessionId),
			signal: options.signal,
			reasoning: toReasoningEffort(resolved.thinkingLevel),
			disableReasoning: shouldDisableReasoning(resolved.thinkingLevel),
			toolChoice: { type: "tool", name: RESPOND_TOOL_NAME },
		},
		{ telemetry: resolveTelemetry(session.agent.telemetry, session.sessionId), oneshotKind: "loop_synthesis" },
	);

	if (response.stopReason === "error") {
		throw new Error(response.errorMessage ?? "loop synthesis request failed");
	}
	if (response.stopReason === "aborted") {
		throw new Error("loop synthesis request aborted");
	}

	const call = extractToolCall(response, RESPOND_TOOL_NAME);
	const payload = call
		? typeof call.arguments === "string"
			? parseJsonPayload(call.arguments)
			: call.arguments
		: parseJsonPayload(extractTextContent(response));
	const result = parseSynthesisPayload(payload);

	if (!obfuscator?.hasSecrets()) return result;
	return { complete: result.complete, reflection: obfuscator.deobfuscate(result.reflection) };
}

function parseSynthesisPayload(value: unknown): LoopSynthesisResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("loop synthesis returned an invalid response");
	}
	const payload = value as Record<string, unknown>;
	const reflection = typeof payload.reflection === "string" ? payload.reflection.trim() : "";
	return { complete: payload.complete === true, reflection };
}
