/**
 * MCP HTTP transport (Streamable HTTP).
 *
 * Implements JSON-RPC 2.0 over HTTP POST with optional SSE streaming.
 * The negotiated protocol revision is carried in the `MCP-Protocol-Version`
 * header on every request (see `MCP_PROTOCOL_VERSION`).
 */
import * as AIError from "@pk-nerdsaver-ai/pi-ai/error";
import { logger, postmortem, readSseEvents, readSseJson } from "@pk-nerdsaver-ai/pi-utils";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPHttpServerConfig,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import { RequestIdAllocator } from "../request-id";
import { createMCPTimeout, getNeverAbortSignal, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";
import { type MCPFetchInit, mcpFetch, withoutHeader } from "./header-policy";

const HTTP_SSE_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_SSE_RETRY_MS = 3_000;

interface SSEResumeState {
	lastEventId: string | null;
	retryMs: number;
}

/**
 * Failure resuming an accepted request's logical SSE stream. Carries a
 * never-replay contract: by resume time the server has accepted (and possibly
 * executed) the originating POST, so auth-retry paths must not re-send it.
 */
class SSEResumeError extends Error {}

/** Wait for the server-provided SSE retry interval while remaining abortable. */
async function waitForSSERetry(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw signal.reason;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	const onAbort = (): void => reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await promise;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}
/**
 * Best-effort startup deadline for the optional Streamable HTTP GET SSE listener.
 *
 * Returns `0` (disabled) when the operator has explicitly disabled MCP client-side
 * timeouts via `timeout: 0` or `OMP_MCP_TIMEOUT_MS=0`, mirroring the rest of the
 * MCP timeout surface. Otherwise caps the wait at one second and scales below
 * short request timeouts so connect-time never exceeds the request budget.
 */
export function resolveSSEConnectTimeoutMs(configTimeout?: number): number {
	const requestTimeout = resolveMCPTimeoutMs(configTimeout);
	if (!isMCPTimeoutEnabled(requestTimeout)) return 0;
	const boundedTimeout = Math.min(HTTP_SSE_CONNECT_TIMEOUT_MS, Math.floor(requestTimeout / 4));
	return Math.max(1, boundedTimeout);
}

const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_HEADER_VALUE_PATTERN = /^[\t\x20-\x7e]*$/;
const MODERN_RESERVED_HEADER_NAMES = new Set([
	"accept",
	"content-type",
	"last-event-id",
	"mcp-method",
	"mcp-name",
	"mcp-protocol-version",
	"mcp-session-id",
]);
const MODERN_PROTOCOL_ERROR_CODES = new Set([-32020, -32021, -32022]);

function isModernReservedHeader(name: string): boolean {
	const normalized = name.toLowerCase();
	return MODERN_RESERVED_HEADER_NAMES.has(normalized) || normalized.startsWith("mcp-param-");
}

function applyConfiguredModernHeaders(
	headers: Record<string, string>,
	configuredHeaders: Record<string, string> | undefined,
): void {
	for (const [name, value] of Object.entries(configuredHeaders ?? {})) {
		if (!HTTP_HEADER_NAME_PATTERN.test(name) || !HTTP_HEADER_VALUE_PATTERN.test(value)) {
			throw new Error(`Invalid configured HTTP header "${name}"`);
		}
		if (isModernReservedHeader(name)) {
			throw new Error(`Configured HTTP header "${name}" is reserved by modern MCP`);
		}
		headers[name] = value;
	}
}

function requiredMcpName(method: string, params: Record<string, unknown>): string | undefined {
	const sourceField =
		method === "tools/call" || method === "prompts/get" ? "name" : method === "resources/read" ? "uri" : undefined;
	if (!sourceField) return undefined;
	const value = params[sourceField];
	if (typeof value !== "string") {
		throw new Error(`Modern ${method} requests require string params.${sourceField} for Mcp-Name`);
	}
	return encodeMCPHeaderValue(value);
}

/**
 * Builds the complete MCP-owned modern request header set. Configured headers
 * are copied only after rejecting every header whose value is derived from the
 * JSON-RPC body, so neither configuration nor tool schemas can override them.
 */
export function buildModernMCPHttpHeaders(
	method: string,
	params: Record<string, unknown>,
	context: { version: MCPModernProtocolVersion },
	options?: {
		headers?: Record<string, string>;
		toolHeaderMetadata?: MCPToolHeaderMetadata;
	},
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	applyConfiguredModernHeaders(headers, options?.headers);
	headers["MCP-Protocol-Version"] = context.version;
	headers["Mcp-Method"] = method;

	const name = requiredMcpName(method, params);
	if (name !== undefined) headers["Mcp-Name"] = name;

	if (method !== "tools/call" || !options?.toolHeaderMetadata) return headers;
	const toolName = params.name;
	if (typeof toolName !== "string" || options.toolHeaderMetadata.toolName !== toolName) {
		throw new Error("Tool header metadata does not match tools/call params.name");
	}
	const argumentsValue = params.arguments;
	const argumentsRecord =
		typeof argumentsValue === "object" && argumentsValue !== null && !Array.isArray(argumentsValue)
			? (argumentsValue as Record<string, unknown>)
			: undefined;
	for (const header of extractMCPToolHeaderValues(options.toolHeaderMetadata, argumentsRecord)) {
		if (!HTTP_HEADER_NAME_PATTERN.test(header.name)) {
			throw new Error(`Invalid tool parameter header "${header.name}"`);
		}
		headers[header.name] = header.value;
	}
	return headers;
}

function parseJsonRpcErrorBody(body: string): JsonRpcError | undefined {
	try {
		const value = JSON.parse(body) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const response = value as Record<string, unknown>;
		if (response.jsonrpc !== "2.0" || typeof response.error !== "object" || response.error === null) return undefined;
		const error = response.error as Record<string, unknown>;
		if (!Number.isInteger(error.code) || typeof error.message !== "string") return undefined;
		return {
			code: error.code as number,
			message: error.message,
			...(error.data === undefined ? {} : { data: error.data }),
		};
	} catch {
		return undefined;
	}
}

/**
 * Retains the transport-level status and response body alongside a JSON-RPC
 * error when one was actually emitted. The modern-probe classifier deliberately
 * consumes only this representation, so local/auth/network failures cannot
 * accidentally select a legacy lifecycle.
 */
export class MCPHttpResponseError extends Error {
	readonly code?: number;
	readonly data?: unknown;

	constructor(
		readonly status: number,
		readonly responseBody: string,
		readonly jsonRpcError?: JsonRpcError,
		readonly authHints?: string,
	) {
		super(
			jsonRpcError
				? `MCP error ${jsonRpcError.code}: ${jsonRpcError.message}`
				: `HTTP ${status}: ${responseBody}${authHints ? ` [${authHints}]` : ""}`,
		);
		this.name = "MCPHttpResponseError";
		if (jsonRpcError) {
			this.code = jsonRpcError.code;
			this.data = jsonRpcError.data;
		}
	}
}

function responseError(response: Response, body: string): MCPHttpResponseError {
	const authHints = [
		response.headers.get("WWW-Authenticate") ? `WWW-Authenticate: ${response.headers.get("WWW-Authenticate")}` : null,
		response.headers.get("Mcp-Auth-Server") ? `Mcp-Auth-Server: ${response.headers.get("Mcp-Auth-Server")}` : null,
	]
		.filter((value): value is string => value !== null)
		.join("; ");
	return new MCPHttpResponseError(response.status, body, parseJsonRpcErrorBody(body), authHints || undefined);
}

function jsonRpcResponseError(error: JsonRpcError): Error {
	return Object.assign(new Error(`MCP error ${error.code}: ${error.message}`), {
		code: error.code,
		...(error.data === undefined ? {} : { data: error.data }),
	});
}

function isRecognizedModernProtocolError(error: JsonRpcError): boolean {
	return MODERN_PROTOCOL_ERROR_CODES.has(error.code);
}

const IDENTITY_BEARING_AUTH_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"api-key",
	"x-api-key",
	"x-auth-token",
	"x-access-token",
]);

function changedIdentityBearingAuthHeaders(
	currentHeaders: Record<string, string> | undefined,
	nextHeaders: Record<string, string>,
): boolean {
	const normalized = (headers: Record<string, string> | undefined) => {
		const result = new Map<string, string>();
		for (const [name, value] of Object.entries(headers ?? {})) {
			const normalizedName = name.toLowerCase();
			if (IDENTITY_BEARING_AUTH_HEADERS.has(normalizedName)) result.set(normalizedName, value);
		}
		return result;
	};
	const current = normalized(currentHeaders);
	const next = normalized(nextHeaders);
	if (current.size !== next.size) return true;
	for (const [name, value] of current) {
		if (next.get(name) !== value) return true;
	}
	return false;
}

function incrementAuthenticationContextRevision(revision: number): number {
	if (revision >= Number.MAX_SAFE_INTEGER) {
		throw new Error("MCP authentication context revision exhausted");
	}
	return revision + 1;
}

/**
 * HTTP transport for MCP servers.
 * Uses POST for requests, supports SSE responses.
 */
export class HttpTransport implements MCPTransport {
	#connected = false;
	#sessionId: string | null = null;
	#sseConnection: AbortController | null = null;
	readonly #requestIds = new RequestIdAllocator();
	#lifecycleController = new AbortController();
	readonly #activeRequests = new Set<Promise<unknown>>();
	readonly #activeFetches = new Set<Promise<Response>>();
	readonly #backgroundDrains = new Set<Promise<void>>();
	#closePromise: Promise<void> | null = null;
	/**
	 * Protocol version echoed in the `MCP-Protocol-Version` header. `null` until
	 * the `initialize` response is negotiated (via {@link setProtocolVersion}):
	 * the MCP spec requires the header only on requests *after* `initialize`, and
	 * a server that supports only an older revision may reject a header carrying
	 * a newer version sent before negotiation completes.
	 */
	#protocolVersion: string | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(private config: MCPHttpServerConfig | MCPSseServerConfig) {}

	/**
	 * Fetch the configured endpoint with header precedence and origin policy.
	 *
	 * The transport fully owns `MCP-Protocol-Version`: it is stripped from
	 * configured headers so a user's `mcp.json` can never inject it, and added
	 * only once a version is negotiated (required by the MCP Streamable HTTP spec
	 * after `initialize`). Before negotiation — the `initialize` request itself —
	 * no protocol-version header is sent from either source.
	 */
	#fetch(init: MCPFetchInit, generated: Record<string, string>): Promise<Response> {
		const configured = withoutHeader(this.config.headers, "MCP-Protocol-Version");
		const withVersion =
			this.#protocolVersion === null ? generated : { "MCP-Protocol-Version": this.#protocolVersion, ...generated };
		const request = mcpFetch(
			this.config.url,
			init,
			{ generated: withVersion, configured },
			this.config.headerPolicy === "origin-locked",
		);
		this.#activeFetches.add(request);
		void request.then(
			() => this.#activeFetches.delete(request),
			() => this.#activeFetches.delete(request),
		);
		return request;
	}

	/** Combine caller cancellation with transport shutdown for every HTTP operation. */
	#operationSignal(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, this.#lifecycleController.signal]) : this.#lifecycleController.signal;
	}

	/**
	 * Keep a rejection observer on public requests even if a timeout wrapper
	 * abandons the returned promise. The original promise is returned unchanged,
	 * so callers still observe its normal result or error.
	 */
	#trackRequest<T>(request: Promise<T>): Promise<T> {
		this.#activeRequests.add(request);
		void request.then(
			() => this.#activeRequests.delete(request),
			() => this.#activeRequests.delete(request),
		);
		return request;
	}

	/** Own a fire-and-forget body drain until it settles. */
	#trackBackgroundDrain(drain: Promise<void>): void {
		const handled = drain.catch(error => {
			if (error instanceof Error && error.name === "AbortError") return;
			logger.debug("MCP HTTP background drain failed", {
				url: this.config.url,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		this.#backgroundDrains.add(handled);
		void handled.then(
			() => this.#backgroundDrains.delete(handled),
			() => this.#backgroundDrains.delete(handled),
		);
	}

	/** Record the protocol version negotiated during `initialize`. */
	setProtocolVersion(version: string): void {
		this.#protocolVersion = version;
	}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.config.url;
	}

	/**
	 * Stores the era selected by the connection owner. HTTP never guesses an
	 * era from configuration or a response: a modern probe is configured before
	 * its POST and the legacy adapter is configured only after accepted fallback.
	 */
	configureProtocol(configuration: MCPTransportProtocolConfiguration): void {
		if (configuration.era === "modern") {
			this.#sessionId = null;
			if (this.#sseConnection) {
				this.#sseConnection.abort();
				this.#sseConnection = null;
			}
		}
		this.#protocol = configuration;
	}

	getProtocolConfiguration(): MCPTransportProtocolConfiguration | undefined {
		return this.#protocol;
	}

	/**
	 * Opaque identity context version for modern private-result cache isolation.
	 * It intentionally exposes no credential material.
	 */
	getAuthenticationContextRevision(): number {
		return this.#authenticationContextRevision;
	}

	#applyRefreshedHeaders(headers: Record<string, string>): void {
		if (changedIdentityBearingAuthHeaders(this.config.headers, headers)) {
			this.#authenticationContextRevision = incrementAuthenticationContextRevision(
				this.#authenticationContextRevision,
			);
		}
		this.config = { ...this.config, headers };
	}

	/**
	 * Replaces, rather than extends, the validated tools/list snapshot supplied
	 * by the core client. Defensive validation keeps an accidental external
	 * caller from turning a header annotation into an injection primitive.
	 */
	registerToolHeaderMetadata(metadata: readonly MCPToolHeaderMetadata[]): void {
		const snapshot = new Map<string, MCPToolHeaderMetadata>();
		for (const tool of metadata) {
			if (typeof tool.toolName !== "string" || tool.toolName.length === 0 || snapshot.has(tool.toolName)) {
				throw new Error("Invalid duplicate tool header metadata");
			}
			const headerNames = new Set<string>();
			const parameters = tool.parameters.map(parameter => {
				if (
					!HTTP_HEADER_NAME_PATTERN.test(parameter.headerName) ||
					headerNames.has(parameter.headerName.toLowerCase()) ||
					parameter.path.length === 0 ||
					parameter.path.some(segment => typeof segment !== "string" || segment.length === 0) ||
					(parameter.valueType !== "string" &&
						parameter.valueType !== "integer" &&
						parameter.valueType !== "boolean")
				) {
					throw new Error(`Invalid header metadata for tool "${tool.toolName}"`);
				}
				headerNames.add(parameter.headerName.toLowerCase());
				return {
					path: [...parameter.path],
					headerName: parameter.headerName,
					valueType: parameter.valueType,
				};
			});
			snapshot.set(tool.toolName, { toolName: tool.toolName, parameters });
		}
		this.#toolHeaderMetadata = snapshot;
	}

	/**
	 * HTTP is allowed to select legacy only for an unrecognized body on a 400
	 * response to a configured modern probe. In particular, network, timeout,
	 * authentication, and all non-400 failures remain errors instead of an
	 * unsafe downgrade signal.
	 */
	classifyModernProbeFailure(error: unknown): MCPModernProbeFallbackDecision {
		if (this.#protocol?.era !== "modern" || !(error instanceof MCPHttpResponseError) || error.status !== 400) {
			return { kind: "reject" };
		}
		if (error.jsonRpcError && isRecognizedModernProtocolError(error.jsonRpcError)) {
			return { kind: "modern-error", error: error.jsonRpcError };
		}
		return { kind: "legacy" };
	}

	/**
	 * Mark transport as connected.
	 * HTTP doesn't need a persistent connection, but we track state.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;
		if (this.#closePromise) await this.#closePromise;
		if (this.#lifecycleController.signal.aborted) {
			this.#lifecycleController = new AbortController();
		}
		this.#closePromise = null;
		this.#connected = true;
	}

	/**
	 * Legacy Streamable HTTP's independent GET listener. Modern 2026-07-28
	 * traffic has no such endpoint, so an accidental call is a no-op rather
	 * than a GET that could select obsolete stateful behavior.
	 */
	async startSSEListener(): Promise<void> {
		if (!this.#connected || this.#protocol?.era !== "legacy") return;
		if (this.#sseConnection) return;

		this.#sseConnection = new AbortController();
		const generated: Record<string, string> = {
			Accept: "text/event-stream",
		};

		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}

		let response: Response | null;
		let timedOut = false;
		let startupFinished = false;
		const connection = this.#sseConnection;
		const startupTimeoutMs = resolveSSEConnectTimeoutMs(this.config.timeout);
		const fetchPromise = this.#fetch({ method: "GET", signal: connection.signal }, generated);
		const timeoutPromise =
			startupTimeoutMs > 0
				? new Promise<null>(resolve => {
						setTimeout(() => {
							if (!startupFinished) {
								timedOut = true;
								connection.abort();
							}
							resolve(null);
						}, startupTimeoutMs);
					})
				: null;
		try {
			response = timeoutPromise === null ? await fetchPromise : await Promise.race([fetchPromise, timeoutPromise]);
		} catch (error) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			if (error instanceof Error && error.name !== "AbortError" && !timedOut) this.onError?.(error);
			return;
		} finally {
			startupFinished = true;
		}
		if (response === null) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			void fetchPromise.then(lateResponse => lateResponse.body?.cancel()).catch(() => {});
			return;
		}
		if (this.#sseConnection !== connection) {
			await response.body?.cancel();
			return;
		}
		if (response.status === 405 || !response.ok || !response.body) {
			await response.body?.cancel();
			if (this.#sseConnection === connection) this.#sseConnection = null;
			return;
		}

		const signal = connection.signal;
		this.#trackBackgroundDrain(
			this.#runSSEListener(response.body, signal).finally(() => {
				const wasConnected = this.#connected;
				if (this.#sseConnection === connection) this.#sseConnection = null;
				if (wasConnected) this.onClose?.();
			}),
		);
	}

	async #readSSEStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		try {
			for await (const message of readSseJson<JsonRpcMessage>(body, signal)) {
				if (!this.#connected) break;
				this.#dispatchSSEMessage(message);
			}
		} catch (error) {
			if (error instanceof Error && error.name !== "AbortError") {
				logger.debug("HTTP SSE stream error", { url: this.config.url, error: error.message });
				this.onError?.(error);
			}
		}
	}

	/**
	 * Read the long-lived GET SSE stream, resuming with `Last-Event-ID` when
	 * the server closes the physical connection mid-stream (2025-11-25 permits
	 * polling-style servers). Returns only when the logical stream ends — the
	 * caller fires `onClose` and the manager's reconnect path takes over. A
	 * resume cycle that delivers no events before dropping again ends the
	 * stream rather than retrying forever against a broken server.
	 */
	async #runSSEListener(initialBody: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		const resume: SSEResumeState = { lastEventId: null, retryMs: DEFAULT_SSE_RETRY_MS };
		let body = initialBody;
		let progressed = true;
		for (;;) {
			try {
				for await (const event of readSseEvents(body, signal)) {
					progressed = true;
					if (event.id !== undefined) resume.lastEventId = event.id || null;
					if (event.retry !== undefined) resume.retryMs = event.retry;
					if (event.data === "") continue;
					if (!this.#connected) return;
					this.#dispatchSSEMessage(JSON.parse(event.data) as JsonRpcMessage | JsonRpcMessage[]);
				}
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") return;
				logger.debug("HTTP SSE stream error", {
					url: this.config.url,
					error: error instanceof Error ? error.message : String(error),
				});
				if (resume.lastEventId === null) {
					if (error instanceof Error) this.onError?.(error);
					return;
				}
			}
			if (!this.#connected || signal.aborted || resume.lastEventId === null || !progressed) return;
			progressed = false;
			try {
				const response = await this.#fetchSSEResume(resume, signal);
				body = response.body as ReadableStream<Uint8Array>;
			} catch (error) {
				if (!(error instanceof Error && error.name === "AbortError")) {
					logger.debug("HTTP SSE listener resume failed", {
						url: this.config.url,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
		}
	}

	/**
	 * Resume a logical SSE stream via GET + `Last-Event-ID`, honoring the
	 * server-provided retry interval and refreshing auth once on 401/403.
	 * Failures throw {@link SSEResumeError} so `request()` never replays the
	 * originating POST in response.
	 */
	async #fetchSSEResume(resume: SSEResumeState, signal: AbortSignal): Promise<Response> {
		if (resume.lastEventId === null) {
			throw new SSEResumeError("SSE stream ended without a resumable event ID");
		}
		await waitForSSERetry(resume.retryMs, signal);
		const generated: Record<string, string> = {
			Accept: "text/event-stream",
			"Last-Event-ID": resume.lastEventId,
		};
		if (this.#sessionId) generated["Mcp-Session-Id"] = this.#sessionId;
		let response = await this.#fetch({ method: "GET", signal }, generated);
		if (this.onAuthError && (response.status === 401 || response.status === 403)) {
			await response.body?.cancel();
			const newHeaders = await this.onAuthError();
			if (!newHeaders) {
				throw new SSEResumeError(`HTTP ${response.status} resuming MCP SSE stream: auth refresh failed`);
			}
			// Persist refreshed headers so subsequent requests use them directly
			this.config = { ...this.config, headers: newHeaders };
			response = await this.#fetch({ method: "GET", signal }, generated);
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new SSEResumeError(`HTTP ${response.status} resuming MCP SSE stream: ${text}`);
		}
		const contentType = response.headers.get("Content-Type") ?? "";
		if (!contentType.includes("text/event-stream") || !response.body) {
			await response.body?.cancel();
			throw new SSEResumeError(`MCP SSE resume returned unsupported Content-Type: ${contentType || "(missing)"}`);
		}
		return response;
	}

	/** Route an SSE message (or batch) to the appropriate handler. */
	#dispatchSSEMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const item of message) this.#dispatchSSEMessage(item);
			return;
		}
		if ("method" in message && "id" in message && message.id != null) {
			if (this.#protocol?.era === "legacy") void this.#handleServerRequest(message as JsonRpcRequest);
			else logger.warn("Ignoring invalid server-initiated request on modern HTTP", { method: message.method });
			return;
		}
		if ("method" in message && !("id" in message)) {
			this.onNotification?.(message.method, message.params);
		}
	}

	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T> {
		return this.#trackRequest(this.#requestWithAuthRetry<T>(method, params, options));
	}

	async #requestWithAuthRetry<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		try {
			return await this.#executeRequest<T>(method, params, options);
		} catch (error) {
			// Retry once on auth failure if onAuthError is wired. Never replay
			// after an SSE resume failure: the server already accepted the
			// original POST and may have executed it — replaying could run a
			// state-changing tool twice.
			const status = error instanceof Error ? AIError.status(error) : undefined;
			if (!(error instanceof SSEResumeError) && this.onAuthError && (status === 401 || status === 403)) {
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.#applyRefreshedHeaders(newHeaders);
					return this.#executeRequest<T>(method, params, options);
				}
			}
			throw error;
		}
	}

	async #executeRequest<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		if (!this.#connected) throw new Error("Transport not connected");

		const id = this.#requestIds.next(this.config.requestIdFormat);
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};

		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal(options?.signal));

		try {
			const response = await this.#fetch(
				{ method: "POST", body: JSON.stringify(body), signal: operation.signal },
				generated,
			);

			// Check for session ID in response
			const newSessionId = response.headers.get("Mcp-Session-Id");
			if (newSessionId) {
				this.#sessionId = newSessionId;
			}

			if (!response.ok) {
				const text = await response.text();
				throw responseError(response, text);
			}
			if (request.protocol.era === "legacy") {
				const sessionId = response.headers.get("Mcp-Session-Id");
				if (sessionId) this.#sessionId = sessionId;
			}

			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream")) {
				operation.clear();
				return this.#parseSSEResponse<T>(response, id, options);
			}
			const value = await response.json();
			operation.clear();
			return this.#parseJsonResponse<T>(value, id);
		} catch (error) {
			if (operation.isTimeoutAbort(error) || operation.timedOut()) {
				throw new Error(`Request timeout after ${timeout}ms`);
			}
			throw error;
		} finally {
			operation.clear();
		}
	}

	#parseSSEResponse<T>(response: Response, expectedId: string | number, options?: MCPRequestOptions): Promise<T> {
		if (!response.body) throw new Error("No response body");

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal(options?.signal));
		const signal = operation.signal ?? getNeverAbortSignal();
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		// The transport owns this promise until the physical stream drain exits.
		// Keep a rejection observer attached even when a caller-side timeout
		// abandons the request before the drain notices its abort.
		void promise.catch(() => {});
		const resume: SSEResumeState = { lastEventId: null, retryMs: DEFAULT_SSE_RETRY_MS };
		let captured = false;

		// Drain each physical SSE connection without leaving its iterator early.
		// A server may close a connection without terminating the logical stream;
		// when it supplied an event ID, resume that stream via GET + Last-Event-ID.
		const drain = async (): Promise<void> => {
			let current = response;
			try {
				for (;;) {
					if (!current.body) throw new Error("SSE response did not include a body");
					try {
						for await (const event of readSseEvents(current.body, signal)) {
							if (event.id !== undefined) resume.lastEventId = event.id || null;
							if (event.retry !== undefined) resume.retryMs = event.retry;
							if (event.data === "") continue;
							const raw = JSON.parse(event.data) as JsonRpcMessage | JsonRpcMessage[];
							const messages = Array.isArray(raw) ? raw : [raw];
							for (const message of messages) {
								if (
									!captured &&
									"id" in message &&
									message.id === expectedId &&
									("result" in message || "error" in message)
								) {
									captured = true;
									operation.clear();
									if (message.error) {
										reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
									} else {
										resolve(message.result as T);
									}
									continue;
								}
								if (!this.#connected) continue;
								this.#dispatchSSEMessage(message);
							}
						}
					} catch (error) {
						// An abrupt drop (socket reset, body-read failure) is as
						// resumable as a server-initiated close once an event ID
						// exists; the request timeout still bounds the total wait.
						if (captured) return;
						if (signal.aborted || resume.lastEventId === null) throw error;
						logger.debug("MCP SSE response stream dropped; resuming", {
							url: this.config.url,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					if (captured) return;
					if (signal.aborted) {
						throw signal.reason ?? new DOMException("MCP SSE response aborted", "AbortError");
					}
					if (resume.lastEventId === null) {
						throw new Error(`No response received for request ID ${expectedId}`);
					}
					current = await this.#fetchSSEResume(resume, signal);
				}
			} catch (error) {
				if (captured) return;
				if (operation.isTimeoutAbort(error)) reject(new Error(`SSE response timeout after ${timeout}ms`));
				else reject(error as Error);
			} finally {
				operation.clear();
				await current.body?.cancel().catch(() => {});
			}
		};

		this.#trackBackgroundDrain(drain());
		return promise;
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		if (this.#protocol?.era !== "legacy") return;
		if (!this.onRequest) {
			await this.#sendServerResponse(request.id, undefined, { code: -32601, message: "Method not found" });
			return;
		}
		try {
			const result = await this.onRequest(request.method, request.params);
			await this.#sendServerResponse(request.id, result);
		} catch (error) {
			await this.#sendServerResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	/** Legacy-only response POST for server-to-client JSON-RPC requests. */
	async #sendServerResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected || this.#protocol?.era !== "legacy") return;
		const body = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}
		const payload = JSON.stringify(body);
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal());
		try {
			const resp = await this.#fetch({ method: "POST", body: payload, signal: operation.signal }, generated);
			// Retry once on auth failure if onAuthError is wired
			if (this.onAuthError && (resp.status === 401 || resp.status === 403)) {
				await resp.body?.cancel();
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config.headers ??= {};
					Object.assign(this.config.headers, newHeaders);
					operation.clear();
					const retryOperation = createMCPTimeout(timeout, this.#operationSignal());
					try {
						const retry = await this.#fetch(
							{ method: "POST", body: payload, signal: retryOperation.signal },
							generated,
						);
						await retry.body?.cancel();
					} finally {
						retryOperation.clear();
					}
					return;
				}
			}
			await response.body?.cancel();
		} catch {
			// Best-effort response delivery — server may have disconnected
		} finally {
			operation.clear();
		}
	}

	notify(method: string, params?: Record<string, unknown>): Promise<void> {
		return this.#trackRequest(this.#sendNotification(method, params));
	}

	async #sendNotification(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) {
			throw new Error("Transport not connected");
		}

		const body = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};

		if (this.#sessionId) {
			generated["Mcp-Session-Id"] = this.#sessionId;
		}

		const request = this.#requestParts(method, params, undefined);
		const body = { jsonrpc: "2.0" as const, method, params: request.params };
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal());

		try {
			const response = await this.#fetch(
				{ method: "POST", body: JSON.stringify(body), signal: operation.signal },
				generated,
			);

			// 202 Accepted is success for notifications
			if (!response.ok && response.status !== 202) {
				const text = await response.text();
				throw responseError(response, text);
			}
			operation.clear();

			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream") && response.body) {
				if (this.#sseConnection) {
					this.#trackBackgroundDrain(
						this.#readSSEStream(response.body, this.#operationSignal(this.#sseConnection.signal)),
					);
				} else {
					const readOperation = createMCPTimeout(timeout, this.#operationSignal());
					const signal = readOperation.signal ?? getNeverAbortSignal();
					this.#trackBackgroundDrain(
						this.#readSSEStream(response.body, signal).finally(() => readOperation.clear()),
					);
				}
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			if (operation.isTimeoutAbort(error)) {
				throw new Error(`Notify timeout after ${timeout}ms`);
			}
			throw error;
		} finally {
			operation.clear();
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		if (!this.#connected) return Promise.resolve();
		this.#closePromise = this.#closeTransport();
		// `close()` is commonly fire-and-forget during process teardown.
		void this.#closePromise.catch(() => {});
		return this.#closePromise;
	}

	async #closeTransport(): Promise<void> {
		this.#connected = false;
		const closeReason = postmortem.markExpectedCleanupError(
			new DOMException("MCP HTTP transport closed", "AbortError"),
		);
		this.#lifecycleController.abort(closeReason);

		if (this.#sseConnection) {
			this.#sseConnection.abort(closeReason);
			this.#sseConnection = null;
		}

		// Aborting is only the cancellation request. Wait until fetches and body
		// readers have actually observed it before session/process teardown can
		// close their sockets underneath still-running promise continuations.
		while (this.#activeFetches.size > 0 || this.#activeRequests.size > 0 || this.#backgroundDrains.size > 0) {
			await Promise.allSettled([...this.#activeFetches, ...this.#activeRequests, ...this.#backgroundDrains]);
		}

		if (this.#sessionId) {
			const timeout = resolveMCPTimeoutMs(this.config.timeout);
			const operation = createMCPTimeout(timeout);
			try {
				const response = await this.#fetch(
					{ method: "DELETE", signal: operation.signal },
					{ "Mcp-Session-Id": this.#sessionId },
				);
				await response.body?.cancel();
			} catch {
				// Session termination is best-effort.
			} finally {
				operation.clear();
			}
			this.#sessionId = null;
		}

		const onClose = this.onClose;
		this.onClose = undefined;
		try {
			onClose?.();
		} catch (error) {
			logger.debug("MCP HTTP onClose callback failed during transport teardown", {
				url: this.config.url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

/**
 * Create and connect an HTTP transport.
 */
export async function createHttpTransport(config: MCPHttpServerConfig | MCPSseServerConfig): Promise<HttpTransport> {
	const transport = new HttpTransport(config);
	await transport.connect();
	return transport;
}
