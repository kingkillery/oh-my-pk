import * as fs from "node:fs/promises";

import type { ImageContent } from "@pk-nerdsaver-ai/pi-ai";
import { createAgentSession, type CreateAgentSessionOptions } from "@pk-nerdsaver-ai/pi-coding-agent";
import { AgentSessionGateway } from "@pk-nerdsaver-ai/pi-coding-agent/gateway/agent-session-gateway";
import type { GatewayEvent } from "@pk-nerdsaver-ai/pi-coding-agent/gateway/types";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import type {
	ClientBridge,
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "@pk-nerdsaver-ai/pi-coding-agent/session/client-bridge";
import { getProjectDir, logger } from "@pk-nerdsaver-ai/pi-utils";

import { AgentEventChannel } from "./events";
import type {
	ActionLevel,
	AgentEvent,
	AgentWorker,
	ApprovalDecision,
	ApprovalRequest,
	ContextPacket,
	RoutingDecision,
	SessionHandle,
	TaskInput,
} from "./types";

interface ActiveSession {
	gateway: AgentSessionGateway;
	channel: AgentEventChannel;
	bridge: DesktopTagClientBridge;
	taskId: string;
}

/** Bridges permission requests from the agent into the overlay approval flow. */
class DesktopTagClientBridge implements ClientBridge {
	readonly capabilities = { requestPermission: true };
	readonly #channel: AgentEventChannel;
	readonly #pending = new Map<string, (outcome: ClientBridgePermissionOutcome) => void>();
	readonly #taskId: string;

	constructor(taskId: string, channel: AgentEventChannel) {
		this.#taskId = taskId;
		this.#channel = channel;
	}

	async requestPermission(
		toolCall: ClientBridgePermissionToolCall,
		options: ClientBridgePermissionOption[],
		signal?: AbortSignal,
	): Promise<ClientBridgePermissionOutcome> {
		const { promise, resolve } = Promise.withResolvers<ClientBridgePermissionOutcome>();
		this.#pending.set(toolCall.toolCallId, resolve);

		const allowedOptions = options.map(o => o.optionId).filter(id => id.startsWith("allow"));
		const scope: ApprovalRequest["scope"] = allowedOptions.includes("allow_always") ? "session" : "once";
		const level: ActionLevel = scope === "session" ? 2 : 1;

		const request: ApprovalRequest = {
			actionId: toolCall.toolCallId,
			stepId: toolCall.toolCallId,
			toolName: toolCall.toolName,
			arguments: (toolCall.rawInput as Record<string, unknown>) ?? {},
			effects: toolCall.title,
			level,
			scope,
		};

		this.#channel.push({
			type: "approval.requested",
			request,
		});

		if (signal) {
			signal.addEventListener("abort", () => this.resolve(toolCall.toolCallId, { outcome: "cancelled" }), { once: true });
		}

		try {
			return await promise;
		} finally {
			this.#pending.delete(toolCall.toolCallId);
		}
	}

	resolve(toolCallId: string, outcome: ClientBridgePermissionOutcome): void {
		const resolver = this.#pending.get(toolCallId);
		if (resolver) resolver(outcome);
	}

	get actionIds(): string[] {
		return [...this.#pending.keys()];
	}
}

/** A worker that delegates tasks to a local {@link AgentSession} through the gateway. */
export class PiWorker implements AgentWorker {
	readonly #sessions = new Map<string, ActiveSession>();

	async createSession(taskId: string, input: TaskInput): Promise<SessionHandle> {
		const { contextPacket, preferredExecutor } = input;
		const routing = input.routing;

		const promptLines = [
			"You are operating in desktop-tag mode.",
			"A screenshot or selected context has been captured from the user's desktop.",
			"Use the provided context to answer or act. Prefer non-destructive, reversible actions.",
		];
		if (preferredExecutor) {
			promptLines.push(`Preferred executor for this task: ${preferredExecutor}.`);
		}

		const options: CreateAgentSessionOptions = {
			cwd: getProjectDir(),
			hasUI: true,
			toolNames: routing.tools,
			appendSystemPrompt: promptLines.join("\n"),
		};

		const { session } = await createAgentSession(options);

		const channel = new AgentEventChannel();
		const bridge = new DesktopTagClientBridge(taskId, channel);
		session.setClientBridge(bridge);

		const gateway = new AgentSessionGateway(session as AgentSession);
		const active: ActiveSession = { gateway, channel, bridge, taskId };
		this.#sessions.set(taskId, active);

		this.#attachListener(active, gateway);

		const message = buildInitialMessage(contextPacket, routing);
		const images = contextPacket.visual.screenshotPath ? [await loadImage(contextPacket.visual.screenshotPath)] : [];

		await gateway.dispatch({
			id: crypto.randomUUID(),
			type: "prompt",
			identity: { channelId: "desktop-tag", sessionKey: taskId },
			message,
			images,
		});

		return { sessionId: taskId };
	}

	async sendMessage(sessionId: string, message: string, images?: ImageContent[]): Promise<void> {
		const active = this.#sessions.get(sessionId);
		if (!active) throw new Error(`Session ${sessionId} not found`);
		await active.gateway.dispatch({
			id: crypto.randomUUID(),
			type: "prompt",
			identity: { channelId: "desktop-tag", sessionKey: sessionId },
			message,
			images,
		});
	}

	async approve(sessionId: string, actionId: string, decision: ApprovalDecision): Promise<void> {
		const active = this.#sessions.get(sessionId);
		if (!active) throw new Error(`Session ${sessionId} not found`);
		if (decision.allowed) {
			const optionId = decision.scope === "session" || decision.scope === "application" ? "allow_always" : "allow_once";
			active.bridge.resolve(actionId, { outcome: "selected", optionId });
		} else {
			active.bridge.resolve(actionId, { outcome: "cancelled" });
		}
	}

	async cancel(sessionId: string): Promise<void> {
		const active = this.#sessions.get(sessionId);
		if (!active) return;
		await active.gateway.dispatch({
			id: crypto.randomUUID(),
			type: "abort",
			identity: { channelId: "desktop-tag", sessionKey: sessionId },
		});
	}

	subscribe(sessionId: string): AsyncIterable<AgentEvent> {
		const active = this.#sessions.get(sessionId);
		if (!active) throw new Error(`Session ${sessionId} not found`);
		return active.channel.subscribe();
	}

	#attachListener(active: ActiveSession, gateway: AgentSessionGateway): void {
		gateway.subscribe(event => {
			const translated = translateGatewayEvent(active.taskId, event);
			for (const e of translated) {
				active.channel.push(e);
			}
		});
	}
}

async function loadImage(path: string): Promise<ImageContent> {
	const bytes = await fs.readFile(path);
	return {
		type: "image",
		data: bytes.toString("base64"),
		mimeType: "image/png",
		detail: "high",
	};
}

function buildInitialMessage(packet: ContextPacket, routing: RoutingDecision): string {
	const lines = [
		`The user asked: ${packet.userRequest}`,
		`Capture mode: ${packet.captureMode}`,
		`Routing: ${routing.message}`,
	];
	if (packet.foregroundApp.processName) {
		lines.push(`Foreground app: ${packet.foregroundApp.processName} - ${packet.foregroundApp.windowTitle ?? "unknown window"}`);
	}
	if (packet.browser.url) {
		lines.push(`Active browser tab: ${packet.browser.title ?? ""} (${packet.browser.url})`);
	}
	if (packet.selection.clipboardText) {
		lines.push(`Clipboard/selection text: ${packet.selection.clipboardText}`);
	}
	lines.push("Use the attached screenshot and context to answer or act.");
	return lines.join("\n");
}

function translateGatewayEvent(taskId: string, event: GatewayEvent): AgentEvent[] {
	switch (event.type) {
		case "ready":
			return [];
		case "session_event": {
			const ev = event.event;
			switch (ev.type) {
				case "agent_start":
					return [{ type: "task.started", taskId }];
				case "agent_end":
					return [];
				case "assistant_text_delta":
					return [{ type: "agent.message.delta", text: ev.text }];
				case "assistant_end":
					return ev.hasError
						? [{ type: "task.failed", taskId, error: "Assistant turn ended with an error." }]
						: [{ type: "task.completed", taskId, summary: "" }];
				case "tool_start":
					return [{ type: "tool.started", callId: ev.toolCallId, toolName: ev.toolName }];
				case "tool_end":
					return [{ type: "tool.completed", callId: ev.toolCallId, result: null, isError: ev.isError }];
				case "notice":
					return [{ type: "agent.message.delta", text: `[${ev.level}] ${ev.message}` }];
				case "thinking_level_changed":
					return [];
				default:
					return [];
			}
		}
		case "response": {
			if (event.success) return [];
			return [{ type: "task.failed", taskId, error: event.error }];
		}
		case "protocol_error":
			return [{ type: "task.failed", taskId, error: event.error }];
		default:
			logger.debug("Unhandled gateway event", { type: (event as { type: string }).type });
			return [];
	}
}
