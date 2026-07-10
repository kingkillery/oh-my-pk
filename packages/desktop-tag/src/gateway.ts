import * as path from "node:path";

import { logger } from "@pk-nerdsaver-ai/pi-utils";

import { CaptureService } from "./context";
import { parseAgentEvent, serializeAgentEvent } from "./events";
import { type CapabilityRegistry, createDefaultRegistry, routeContext, updateAvailability } from "./router";
import type { AgentEvent, AgentWorker, ApprovalDecision, CaptureMode, ContextPacket } from "./types";
import { PiWorker } from "./worker";

export interface ServerOptions {
	port: number;
	hostname?: string;
	overlayHtmlPath?: string;
	captureService?: CaptureService;
	registry?: CapabilityRegistry;
	worker?: AgentWorker;
}

interface SocketData {
	taskId?: string;
	pumpAbort?: AbortController;
}

const LOOPBACK_HOSTNAMES: Readonly<Record<string, true>> = { "127.0.0.1": true, localhost: true, "::1": true };

/** Local gateway that serves the overlay and wires it to an {@link AgentWorker}. */
export class TagGatewayServer {
	readonly captureService: CaptureService;
	readonly registry: CapabilityRegistry;
	readonly worker: AgentWorker;
	readonly #options: ServerOptions;
	readonly #activeTasks = new Map<string, { socket: Bun.ServerWebSocket<SocketData>; pumpAbort: AbortController }>();
	#server?: Bun.Server<SocketData>;
	#overlayHtml?: string;
	constructor(options: ServerOptions) {
		this.#options = options;
		this.captureService = options.captureService ?? new CaptureService();
		this.registry = options.registry ?? createDefaultRegistry();
		this.worker = options.worker ?? new PiWorker();
	}

	start(): Bun.Server<SocketData> {
		const hostname = this.#options.hostname ?? "127.0.0.1";
		if (!isLoopbackHostname(hostname)) {
			throw new Error(`Desktop tag gateway must bind to a loopback host, received: ${hostname}`);
		}
		const server = Bun.serve<SocketData>({
			port: this.#options.port,
			hostname,
			fetch: (req, server) => this.#handleFetch(req, server),
			websocket: {
				open: ws => {
					logger.debug("Overlay connected");
					ws.data = {} as SocketData;
				},
				message: (ws, message) => this.#handleSocketMessage(ws, message),
				close: (ws, code, reason) => void this.#handleSocketClose(ws, code, reason),
			},
		});

		this.#server = server;
		logger.info("Tag gateway listening", { url: this.url });
		return server;
	}

	stop(): void {
		for (const { socket } of this.#activeTasks.values()) void this.#closeTask(socket);
		this.#server?.stop(true);
		this.#server = undefined;
	}

	get url(): string {
		if (!this.#server) return "";
		return `http://${formatUrlHostname(this.#server.hostname ?? this.#options.hostname ?? "127.0.0.1")}:${this.#server.port ?? this.#options.port}`;
	}

	async #handleFetch(req: Request, server: Bun.Server<SocketData>): Promise<Response | undefined> {
		const url = new URL(req.url);
		const serverPort = server.port;
		if (serverPort === undefined) return new Response("Gateway port unavailable", { status: 503 });

		if (url.pathname === "/ws") {
			if (!isAllowedWebSocketOrigin(req.headers.get("Origin"), serverPort)) {
				return new Response("WebSocket origin forbidden", { status: 403 });
			}
			const upgraded = server.upgrade(req, { data: {} as SocketData });
			if (upgraded) return undefined;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		if (url.pathname.startsWith("/api/")) {
			if (!isAllowedWebSocketOrigin(req.headers.get("Origin"), serverPort)) {
				return new Response("Origin forbidden", { status: 403 });
			}
			return this.#handleApi(req, url.pathname);
		}

		const html = await this.#getOverlayHtml();
		return new Response(html, { headers: { "Content-Type": "text/html" } });
	}

	async #handleApi(req: Request, pathname: string): Promise<Response> {
		if (req.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return new Response("Invalid JSON", { status: 400 });
		}

		if (pathname === "/api/capture") {
			const result = await this.#runCapture(body);
			return Response.json(result, { status: result.ok ? 200 : 400 });
		}

		return new Response("Not found", { status: 404 });
	}

	async #handleSocketMessage(ws: Bun.ServerWebSocket<SocketData>, raw: string | Buffer): Promise<void> {
		const message = typeof raw === "string" ? parseClientMessage(raw) : undefined;
		if (!message) {
			ws.send(JSON.stringify({ type: "protocol_error", error: "expected JSON text message" }));
			return;
		}

		switch (message.type) {
			case "capture": {
				const { mode, userRequest, includeClipboard } = message;
				const taskId = crypto.randomUUID();
				await this.#startTask(ws, taskId, mode, userRequest, includeClipboard ?? true);
				break;
			}
			case "message": {
				if (!ws.data.taskId) return;
				await this.worker.sendMessage(ws.data.taskId, message.text);
				break;
			}
			case "approve": {
				if (!ws.data.taskId) return;
				const decision: ApprovalDecision = {
					allowed: message.allowed,
					scope: message.scope,
					editedArguments: message.editedArguments,
				};
				await this.worker.approve(ws.data.taskId, message.actionId, decision);
				break;
			}
			case "cancel": {
				if (!ws.data.taskId) return;
				await this.worker.cancel(ws.data.taskId);
				break;
			}
			default:
				send(ws, { type: "task.failed", taskId: ws.data.taskId ?? "", error: "Unknown message type" });
		}
	}

	async #startTask(
		ws: Bun.ServerWebSocket<SocketData>,
		taskId: string,
		mode: CaptureMode,
		userRequest: string,
		includeClipboard: boolean,
	): Promise<void> {
		const previousTaskId = this.#detachTask(ws);
		const abortController = new AbortController();
		ws.data.taskId = taskId;
		ws.data.pumpAbort = abortController;
		this.#activeTasks.set(taskId, { socket: ws, pumpAbort: abortController });
		if (previousTaskId) await this.#cancelWorkerTask(previousTaskId);

		try {
			const packet = await this.captureService.capture({ mode, userRequest, includeClipboard });
			if (!this.#isCurrentTask(ws, taskId)) return;
			await updateAvailability(this.registry);
			if (!this.#isCurrentTask(ws, taskId)) return;
			const routing = routeContext(this.registry, packet);

			send(ws, { type: "task.started", taskId });
			send(ws, { type: "agent.message.delta", text: routing.message });

			await this.worker.createSession(taskId, { contextPacket: packet, routing });
			if (!this.#isCurrentTask(ws, taskId)) {
				await this.#cancelWorkerTask(taskId);
				return;
			}

			void this.#pumpEvents(ws, taskId, abortController.signal);
		} catch (error) {
			if (!this.#isCurrentTask(ws, taskId)) return;
			logger.error("Failed to start desktop task", {
				error: error instanceof Error ? error.message : String(error),
			});
			send(ws, { type: "task.failed", taskId, error: error instanceof Error ? error.message : String(error) });
			await this.#closeTask(ws);
		}
	}

	async #closeTask(ws: Bun.ServerWebSocket<SocketData>): Promise<void> {
		const taskId = this.#detachTask(ws);
		if (taskId) await this.#cancelWorkerTask(taskId);
	}

	#detachTask(ws: Bun.ServerWebSocket<SocketData>): string | undefined {
		const taskId = ws.data.taskId;
		if (!taskId) return undefined;

		ws.data.pumpAbort?.abort();
		ws.data.taskId = undefined;
		ws.data.pumpAbort = undefined;
		this.#activeTasks.delete(taskId);
		return taskId;
	}

	#isCurrentTask(ws: Bun.ServerWebSocket<SocketData>, taskId: string): boolean {
		return ws.data.taskId === taskId && !ws.data.pumpAbort?.signal.aborted;
	}

	async #cancelWorkerTask(taskId: string): Promise<void> {
		try {
			await this.worker.cancel(taskId);
		} catch (error) {
			logger.debug("Failed to cancel desktop task", {
				taskId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #pumpEvents(ws: Bun.ServerWebSocket<SocketData>, taskId: string, signal: AbortSignal): Promise<void> {
		try {
			for await (const event of this.worker.subscribe(taskId)) {
				if (signal.aborted) return;
				send(ws, event);
			}
		} catch (error) {
			if (signal.aborted) return;
			logger.error("Event pump error", { error: error instanceof Error ? error.message : String(error) });
		} finally {
			this.#activeTasks.delete(taskId);
			if (ws.data.taskId === taskId) {
				ws.data.taskId = undefined;
				ws.data.pumpAbort = undefined;
			}
		}
	}

	async #handleSocketClose(ws: Bun.ServerWebSocket<SocketData>, code: number, reason: string): Promise<void> {
		logger.debug("Overlay disconnected", { code, reason });
		await this.#closeTask(ws);
	}

	async #runCapture(body: unknown): Promise<{ ok: boolean; taskId?: string; error?: string; packet?: ContextPacket }> {
		const parsed = parseCaptureBody(body);
		if (!parsed.ok) return { ok: false, error: parsed.error };

		try {
			const packet = await this.captureService.capture(parsed.options);
			await updateAvailability(this.registry);
			const routing = routeContext(this.registry, packet);
			const taskId = crypto.randomUUID();
			return { ok: true, taskId, packet, routing: routing as unknown as Record<string, unknown> } as {
				ok: boolean;
				taskId?: string;
				error?: string;
				packet?: ContextPacket;
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async #getOverlayHtml(): Promise<string> {
		if (this.#overlayHtml) return this.#overlayHtml;
		const filePath = this.#options.overlayHtmlPath ?? path.join(import.meta.dir, "overlay.html");
		const file = Bun.file(filePath);
		this.#overlayHtml = await file.text();
		return this.#overlayHtml;
	}
}

function formatUrlHostname(hostname: string): string {
	return hostname.includes(":") ? `[${hostname}]` : hostname;
}

export function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return LOOPBACK_HOSTNAMES[normalized.toLowerCase()] === true;
}

export function isAllowedWebSocketOrigin(origin: string | null, port: number): boolean {
	if (origin === null) return true;

	try {
		const parsed = new URL(origin);
		if (parsed.origin !== origin || parsed.protocol !== "http:" || !isLoopbackHostname(parsed.hostname)) return false;
		const originPort = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
		return originPort === port;
	} catch {
		return false;
	}
}

function send(ws: Bun.ServerWebSocket<SocketData>, event: AgentEvent): void {
	try {
		ws.send(serializeAgentEvent(event));
	} catch (error) {
		logger.debug("Failed to send event to overlay", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

interface ClientCaptureMessage {
	type: "capture";
	mode: CaptureMode;
	userRequest: string;
	includeClipboard?: boolean;
}

interface ClientTextMessage {
	type: "message";
	text: string;
}

interface ClientApproveMessage {
	type: "approve";
	actionId: string;
	allowed: boolean;
	scope?: "once" | "group" | "session" | "application";
	editedArguments?: Record<string, unknown>;
}

interface ClientCancelMessage {
	type: "cancel";
}

type ClientMessage = ClientCaptureMessage | ClientTextMessage | ClientApproveMessage | ClientCancelMessage;

function parseClientMessage(raw: string): ClientMessage | undefined {
	const parsed = parseAgentEvent(raw) as ClientMessage | undefined;
	if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return undefined;
	return parsed;
}

function parseCaptureBody(
	body: unknown,
):
	| { ok: true; options: { mode: CaptureMode; userRequest: string; includeClipboard: boolean } }
	| { ok: false; error: string } {
	if (!body || typeof body !== "object") return { ok: false, error: "body must be an object" };
	const record = body as Record<string, unknown>;
	const mode = record.mode;
	if (typeof mode !== "string" || !["screen", "window", "region", "browser"].includes(mode)) {
		return { ok: false, error: "mode must be one of screen, window, region, browser" };
	}
	const userRequest = record.userRequest;
	if (typeof userRequest !== "string" || !userRequest.trim()) {
		return { ok: false, error: "userRequest must be a non-empty string" };
	}
	const includeClipboard = record.includeClipboard ?? true;
	if (typeof includeClipboard !== "boolean") return { ok: false, error: "includeClipboard must be a boolean" };
	return { ok: true, options: { mode: mode as CaptureMode, userRequest, includeClipboard } };
}
