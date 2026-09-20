import { type Context, type Model, stream, type } from "@pk-nerdsaver-ai/pi-ai";
import { ModelRegistry } from "../packages/coding-agent/src/config/model-registry.ts";
import { AuthStorage } from "../packages/coding-agent/src/session/auth-storage.ts";

// Operator-invoked, sequential only: never launches, restarts, or reconfigures Colab.
const auth = await AuthStorage.create(":memory:");
try {
	const registry = new ModelRegistry(auth);
	const found = registry.find("llama.cpp (colab)", process.argv[2] ?? "Ternary-Bonsai-2-27B-PQ2_0");
	if (found?.api !== "openai-completions") throw new Error("Configured Colab OpenAI model not found");
	const registeredModel = found as Model<"openai-completions">;
	const candidateBaseUrl = Bun.env.OMPK_COLAB_SMOKE_BASE_URL?.trim();
	const model = candidateBaseUrl ? { ...registeredModel, baseUrl: candidateBaseUrl } : registeredModel;
	const endpoint = new URL(model.baseUrl);
	if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:" || endpoint.username || endpoint.password) {
		throw new Error("Smoke test requires an unauthenticated loopback HTTP bridge");
	}
	process.stdout.write(
		`${JSON.stringify({ stage: "registry", scope: candidateBaseUrl ? "isolated-candidate-override" : "configured-provider", provider: model.provider, model: model.id, endpoint: model.baseUrl, contextWindow: model.contextWindow, maxTokens: model.maxTokens })}\n`,
	);

	async function run(
		label: string,
		context: Context,
		options: { cancel?: boolean; tool?: boolean; maxTokens?: number } = {},
	) {
		const started = performance.now();
		const controller = new AbortController();
		let firstDeltaMs: number | null = null;
		let firstUsefulTextMs: number | null = null;
		let abortedAt: number | null = null;
		let textDeltas = 0;
		let toolDeltas = 0;
		const events = stream(model, context, {
			apiKey: "N/A",
			maxTokens: options.maxTokens ?? 96,
			temperature: 0,
			toolChoice: options.tool ? "required" : undefined,
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
		});
		for await (const event of events) {
			if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
				firstDeltaMs ??= performance.now() - started;
				if (event.type === "text_delta" && event.delta.trim()) {
					textDeltas++;
					if (firstUsefulTextMs === null) {
						firstUsefulTextMs = performance.now() - started;
						process.stdout.write(
							`${JSON.stringify({ stage: label, event: "first_visible_delta", elapsedMs: firstUsefulTextMs })}\n`,
						);
					}
				}
				if (event.type === "toolcall_delta") toolDeltas++;
				if (options.cancel && abortedAt === null) {
					abortedAt = performance.now();
					controller.abort();
				}
			}
		}
		const result = await events.result();
		const ended = performance.now();
		const metrics = {
			stage: label,
			stopReason: result.stopReason,
			errorStatus: result.errorStatus ?? null,
			errorId: result.errorId ?? null,
			firstDeltaMs,
			firstUsefulTextMs,
			totalMs: ended - started,
			textDeltas,
			toolDeltas,
			usage: result.usage,
			// First delta includes transport + queue + prefill. It is NOT isolated prompt processing.
			promptProcessingMs: null,
			decodeTokensPerSecond:
				firstDeltaMs !== null && result.usage.output > 1
					? ((result.usage.output - 1) * 1000) / Math.max(1, ended - started - firstDeltaMs)
					: null,
			abortCompletionMs: abortedAt === null ? null : ended - abortedAt,
		};
		process.stdout.write(`${JSON.stringify(metrics)}\n`);
		if (options.cancel) {
			if (abortedAt === null || result.stopReason !== "aborted")
				throw new Error(`${label}: cancellation not observed (HTTP ${result.errorStatus ?? "unknown"})`);
		} else if (result.stopReason === "error" || result.stopReason === "aborted") {
			throw new Error(`${label}: transport failed (${result.stopReason}, HTTP ${result.errorStatus ?? "unknown"})`);
		}
		return { result, metrics, abortedAt };
	}
	const cancellationOnly = Bun.env.OMPK_SMOKE_CANCEL_ONLY === "1";
	if (!cancellationOnly) {
		const messages: Context["messages"] = [
			{
				role: "user",
				content:
					"Call report_status with status ready. After its result, answer with the returned receipt exactly.",
				timestamp: Date.now(),
			},
		];
		const tools: Context["tools"] = [
			{ name: "report_status", description: "Return a readiness receipt", parameters: type({ status: "'ready'" }) },
		];
		const call = await run("tool_call", { messages, tools }, { tool: true, maxTokens: 128 });
		const calls = call.result.content.filter(block => block.type === "toolCall");
		if (
			call.result.stopReason !== "toolUse" ||
			calls.length !== 1 ||
			calls[0]?.name !== "report_status" ||
			calls[0].arguments.status !== "ready" ||
			call.metrics.toolDeltas === 0
		)
			throw new Error("Tool-call contract failed");
		const receipt = "COLAB_READY_42";
		messages.push(call.result, {
			role: "toolResult",
			toolCallId: calls[0].id,
			toolName: calls[0].name,
			content: [{ type: "text", text: receipt }],
			isError: false,
			timestamp: Date.now(),
		});
		const answer = await run("tool_final", { messages, tools });
		const answerText = answer.result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
		if (!answerText.includes(receipt) || answer.metrics.textDeltas < 1)
			throw new Error("Tool result/final visible answer contract failed");
	}
	const cancelled = await run(
		"cancel",
		{
			messages: [
				{
					role: "user",
					content: "Count upward from one, spelling each number on its own line, up to fifty.",
					timestamp: Date.now(),
				},
			],
		},
		{ cancel: true, maxTokens: 96 },
	);
	// This is an explicit bounded observation of cancellation cleanup, NOT a generation retry.
	const releaseStarted = cancelled.abortedAt;
	if (releaseStarted === null) throw new Error("Missing cancellation timestamp");
	let slotReleaseUpperBoundMs: number | null = null;
	let busyObservations = 0;
	while (performance.now() - releaseStarted < 2_000) {
		const probe = await fetch(new URL("models", `${model.baseUrl.replace(/\/$/, "")}/`), {
			signal: AbortSignal.timeout(Math.max(1, Math.ceil(2_000 - (performance.now() - releaseStarted)))),
		});
		await probe.arrayBuffer();
		if (probe.ok) {
			slotReleaseUpperBoundMs = performance.now() - releaseStarted;
			break;
		}
		if (probe.status !== 429) throw new Error(`Cancellation release probe failed: HTTP ${probe.status}`);
		busyObservations++;
		await Bun.sleep(100);
	}
	process.stdout.write(`${JSON.stringify({ stage: "slot_release", slotReleaseUpperBoundMs, busyObservations })}\n`);
	if (slotReleaseUpperBoundMs === null || slotReleaseUpperBoundMs >= 2_000)
		throw new Error("Cancellation did not release the bridge within two seconds");
	// Exactly one following generation; no automatic replay on 429 or another error.
	const followup = await run(
		"after_cancel",
		{ messages: [{ role: "user", content: "Reply with the word READY only.", timestamp: Date.now() }] },
		{ maxTokens: 32 },
	);
	const followupText = followup.result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("");
	if (!followupText.includes("READY")) throw new Error("Following request did not complete visibly");
	process.stdout.write(
		`${JSON.stringify({ stage: "acceptance", toolRoundTrip: cancellationOnly ? "not-run" : true, cancellation: true, followingRequest: true, abortToFollowingCompletionMs: performance.now() - releaseStarted, slotReleaseUpperBoundMs, note: "Release bound includes polling and model-list transport latency. Decode rate is client-observed, not GPU-only." })}\n`,
	);
} finally {
	auth.close();
}
