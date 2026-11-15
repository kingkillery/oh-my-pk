import { normalizeTools } from "@pk-nerdsaver-ai/pi-agent-core";
import { completeSimple, type Tool, type ToolCall } from "@pk-nerdsaver-ai/pi-ai";
import { discoverAuthStorage } from "@pk-nerdsaver-ai/pi-ai/auth-broker/discover";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import hashlineDescription from "../../packages/hashline/src/prompt.md" with { type: "text" };
import { hashlineEditParamsSchema } from "../../packages/coding-agent/src/edit/hashline/params.ts";
import { getCaseById } from "./cases.ts";
import { buildSeededContext } from "./fixtures.ts";

export interface WorkerRequest {
	provider: string;
	modelId: string;
	caseId: string;
	temperature?: number;
	maxTokens?: number;
}

export interface WorkerResponse {
	provider: string;
	modelId: string;
	caseId: string;
	toolCalls: ToolCall[];
	text: string;
	stopReason: string;
	errorMessage?: string;
	usage?: unknown;
}

export function buildRealEditTool(): Tool {
	const rawTool: Tool = {
		name: "edit",
		description: prompt.render(hashlineDescription),
		parameters: hashlineEditParamsSchema,
	};
	const [normalized] = normalizeTools([rawTool], true);
	if (!normalized) {
		throw new Error("normalizeTools([editTool], true) returned empty array");
	}
	return normalized;
}

export async function runWorkerTurn(req: WorkerRequest): Promise<WorkerResponse> {
	const model = getBundledModel(req.provider as never, req.modelId as never);
	if (!model) {
		throw new Error(`Model not found in catalog: ${req.provider}/${req.modelId}`);
	}

	const auth = await discoverAuthStorage();
	const apiKey = await auth.getApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No credentials/OAuth token available for provider: ${model.provider}`);
	}

	const testCase = getCaseById(req.caseId);
	const editTool = buildRealEditTool();
	const systemPrompt =
		"You are a precise coding assistant. Apply the requested file edit using a single `edit` tool call. Do not reply with prose instead of calling `edit`.";
	const context = buildSeededContext(testCase, systemPrompt);
	context.tools = [editTool];

	const response = await completeSimple(model, context, {
		apiKey,
		temperature: req.temperature ?? 0,
		maxTokens: req.maxTokens ?? 2048,
	});

	const toolCalls: ToolCall[] = [];
	const textParts: string[] = [];
	for (const block of response.content) {
		if (block.type === "toolCall") toolCalls.push(block);
		else if (block.type === "text") textParts.push(block.text);
	}

	return {
		provider: req.provider,
		modelId: req.modelId,
		caseId: req.caseId,
		toolCalls,
		text: textParts.join("\n"),
		stopReason: response.stopReason,
		errorMessage: response.errorMessage,
		usage: response.usage,
	};
}

if (import.meta.main) {
	const rawInput = process.env.EDIT_MATRIX_PAYLOAD ?? (await Bun.stdin.text());
	const req = JSON.parse(rawInput) as WorkerRequest;
	const res = await runWorkerTurn(req);
	process.stdout.write(JSON.stringify(res));
}
