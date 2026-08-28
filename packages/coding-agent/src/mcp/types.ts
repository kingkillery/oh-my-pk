/**
 * MCP (Model Context Protocol) type definitions.
 *
 * Based on MCP specification 2025-11-25:
 * https://modelcontextprotocol.io/specification/2025-11-25/
 */

// =============================================================================
// JSON-RPC 2.0 Types
// =============================================================================

import type { SourceMeta } from "../capability/types";
import type { MCPExtensionRuntime } from "./extensions";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: JsonRpcError;
}

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** JSON values accepted by MCP schemas and structured content. */
export type MCPJsonValue = string | number | boolean | null | MCPJsonValue[] | { [key: string]: MCPJsonValue };

/** Arbitrary MCP metadata; protocol-reserved keys are modeled by the specialized metadata interfaces below. */
export type MCPMeta = Record<string, unknown>;

/** A JSON-RPC request ID, used by operation and subscription handles. */
export type MCPRequestId = string | number;

function asMCPRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

// =============================================================================
// MCP Server Configuration (.mcp.json format)
// =============================================================================

/** Authentication configuration for MCP servers */
export interface MCPAuthConfig {
	/** Authentication type */
	type: "oauth" | "apikey";
	/** Credential ID for OAuth (references agent.db) */
	credentialId?: string;
	/** Token endpoint URL — persisted for proactive token refresh */
	tokenUrl?: string;
	/** Client ID — persisted for token refresh */
	clientId?: string;
	/** Client secret — persisted for token refresh */
	clientSecret?: string;
	/** MCP resource URI — persisted for OAuth resource indicators during refresh */
	resource?: string;
}

/** Encoding used for outgoing JSON-RPC request ids. */
export type MCPRequestIdFormat = "string" | "number";

/** Base server config with shared options */
interface MCPServerConfigBase {
	/** Whether this server is enabled (default: true) */
	enabled?: boolean;
	/** MCP request timeout in milliseconds (default: 30000, 0 to disable) */
	timeout?: number;
	/**
	 * Encoding for outgoing JSON-RPC request ids (default: `"number"`).
	 *
	 * Set `"string"` for servers that need collision-resistant snowflake string
	 * ids instead of per-transport integers. See `RequestIdAllocator` in
	 * `./request-id`.
	 *
	 * OMP-specific, so only the OMP-owned discovery providers parse it (native,
	 * standalone `mcp.json`, OMP plugins). Providers that translate another
	 * tool's config do not, since the key is not part of those formats.
	 */
	requestIdFormat?: MCPRequestIdFormat;
	/** Authentication configuration (optional) */
	auth?: MCPAuthConfig;
	/** OAuth configuration for servers requiring explicit client credentials */
	oauth?: {
		clientId?: string;
		/** HTTPS OAuth Client ID Metadata Document URL used as a URL-form client_id when supported by the authorization server */
		clientMetadataUrl?: string;
		clientSecret?: string;
		scope?: string;
		redirectUri?: string;
		callbackPort?: number;
		callbackPath?: string;
		/** `prompt` param for the authorization request (default "consent"; "" to omit) */
		prompt?: string;
	};
	/** Explicit trusted extension opt-ins; unknown identifiers fail validation when a registry is installed. */
	extensions?: Record<string, MCPServerExtensionConfig>;
}

/** Stdio server configuration */
export interface MCPStdioServerConfig extends MCPServerConfigBase {
	type?: "stdio"; // Default if not specified
	command: string;
	args?: string[];
	env?: Record<string, string>;
	/**
	 * `literal`: env values are opaque plugin package data (Agent Plugins
	 * §§4.1/9.2) — no env-name lookup, no `!command` execution, no dropping of
	 * empty values. The provider already applied the only permitted expansion
	 * (`${PLUGIN_ROOT}`/`${PLUGIN_DATA}`).
	 */
	envPolicy?: "literal";
	cwd?: string;
}

/** HTTP server configuration (Streamable HTTP transport) */
export interface MCPHttpServerConfig extends MCPServerConfigBase {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	/**
	 * `origin-locked`: configured headers are literal package data pinned to the
	 * configured URL's origin (Agent Plugins §7.2.1) — never expanded, never
	 * forwarded cross-origin, and client-generated headers win case-insensitively.
	 */
	headerPolicy?: "origin-locked";
}

/** SSE server configuration (deprecated, use HTTP) */
export interface MCPSseServerConfig extends MCPServerConfigBase {
	type: "sse";
	url: string;
	headers?: Record<string, string>;
	/** See {@link MCPHttpServerConfig.headerPolicy}. */
	headerPolicy?: "origin-locked";
}

export type MCPServerConfig = MCPStdioServerConfig | MCPHttpServerConfig | MCPSseServerConfig;

export const MCP_CONFIG_SCHEMA_URL =
	"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/** Root mcp.json/.mcp.json file structure */
export interface MCPConfigFile {
	$schema?: string;
	mcpServers?: Record<string, MCPServerConfig>;
	/** Names to hide regardless of any source `enabled` flag. Highest precedence. */
	disabledServers?: string[];
	/** Names to force-enable when a non-writable source reports `enabled: false`. */
	enabledServers?: string[];
}

// =============================================================================
// MCP Protocol Types
// =============================================================================

/**
 * Latest MCP protocol revision this client negotiates.
 *
 * Sent as `protocolVersion` in the `initialize` request and, for Streamable
 * HTTP, echoed back to the server in the `MCP-Protocol-Version` header on every
 * subsequent request (per the MCP HTTP transport spec). Must track the current
 * stable revision: AWS Bedrock AgentCore Gateway refuses tool calls on an
 * outbound per-user OAuth (`AUTHORIZATION_CODE`) target below `2025-11-25`, and
 * it checks the version *before* consulting its token vault, so an older client
 * is refused even for a caller whose consent is already stored.
 */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

/** Optionally-sized icon for MCP UI metadata (implementation, tools, resources). */
export interface MCPIcon {
	src: string;
	mimeType?: string;
	sizes?: string[];
	theme?: "light" | "dark";
}

/** MCP implementation info (`InitializeRequest.params.clientInfo` / `InitializeResult.serverInfo`). */
export interface MCPImplementation {
	name: string;
	title?: string;
	version: string;
	description?: string;
	websiteUrl?: string;
	icons?: MCPIcon[];
}

/**
 * Legacy client capabilities sent once during `initialize`.
 *
 * These deprecated primitives must not be advertised in modern request
 * metadata. They remain here for compatibility with initialize-based servers.
 */
export interface MCPClientCapabilities {
	roots?: { listChanged?: boolean };
	sampling?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

/**
 * Extension settings carried on the wire. Server offers remain pass-through
 * unless they intersect an explicitly registered client extension provider.
 */
export type MCPExtensionCapabilities = Record<string, Record<string, unknown>>;

/** Per-request modern client capabilities. Empty means no optional modern capabilities are implemented. */
export interface MCPModernClientCapabilities {
	/** Support for server-requested user elicitation. */
	elicitation?: { form?: Record<string, never>; url?: Record<string, never> };
	/** Support for server-requested model sampling. */
	sampling?: { tools?: Record<string, never>; context?: Record<string, never> };
	/** Support for server-requested roots. */
	roots?: Record<string, never>;
	extensions?: MCPExtensionCapabilities;
}

/** The only modern protocol revision implemented by this client. */
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28" as const;

export type MCPModernProtocolVersion = typeof MCP_MODERN_PROTOCOL_VERSION;

/** Ordered client preference list for mutually supported modern revisions. */
export const MCP_SUPPORTED_MODERN_PROTOCOL_VERSIONS = [MCP_MODERN_PROTOCOL_VERSION] as const;

/** Legacy protocol revision retained for the current initialize lifecycle. */
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-03-26" as const;

/** Client identity included in every modern request and in legacy initialization. */
export const MCP_CLIENT_INFO: MCPImplementation = {
	name: "omp-coding-agent",
	version: "1.0.0",
};

/** MCP metadata required on every modern request. */
export interface MCPModernRequestMetadata extends MCPMeta {
	"io.modelcontextprotocol/protocolVersion": MCPModernProtocolVersion;
	"io.modelcontextprotocol/clientCapabilities": MCPModernClientCapabilities;
	"io.modelcontextprotocol/clientInfo": MCPImplementation;
}

/** Params emitted for a modern request after reserved metadata has been installed. */
export interface MCPModernRequestParams extends Record<string, unknown> {
	_meta: MCPModernRequestMetadata;
}

/**
 * Central modern request parameter builder.
 *
 * Callers may add metadata, but cannot replace protocol version, client
 * capabilities, or client identity. The builder copies rather than mutates
 * caller parameters and metadata so one request cannot contaminate another.
 */
export function buildModernRequestParams(
	params: Record<string, unknown> | undefined,
	context: { version: MCPModernProtocolVersion; clientCapabilities: MCPModernClientCapabilities },
	metadata?: MCPMeta,
	clientInfo: MCPImplementation = MCP_CLIENT_INFO,
): MCPModernRequestParams {
	const callerMeta = asMCPRecord(params?._meta) ?? {};
	// Required metadata must describe this request as it is constructed, not
	// retain mutable references to a caller's shared connection configuration.
	const reservedClientCapabilities = structuredClone(context.clientCapabilities);
	const reservedClientInfo: MCPImplementation = {
		name: clientInfo.name,
		version: clientInfo.version,
	};
	return {
		...params,
		_meta: {
			...callerMeta,
			...metadata,
			"io.modelcontextprotocol/protocolVersion": context.version,
			"io.modelcontextprotocol/clientCapabilities": reservedClientCapabilities,
			"io.modelcontextprotocol/clientInfo": reservedClientInfo,
		},
	};
}

/** Shared capability shape used by a connection, independent of its protocol era. */
export interface MCPNormalizedServerCapabilities {
	tools?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	prompts?: { listChanged?: boolean };
	/** Argument completion through completion/complete. */
	completions?: Record<string, never>;
	/** Server extension settings remain pass-through unless a registered provider negotiates them. */
	extensions?: MCPExtensionCapabilities;
}

/**
 * Legacy initialize capability shape. It adds only deprecated legacy fields
 * to the normalized capability surface.
 */
export interface MCPServerCapabilities extends MCPNormalizedServerCapabilities {
	logging?: Record<string, never>;
	experimental?: Record<string, unknown>;
}

/**
 * Modern discovery capability shape from the 2026-07-28 schema.
 *
 * `resources.subscribe` advertises resource-update delivery through
 * `subscriptions/listen`; it does not re-enable the removed resource RPCs.
 */
export interface MCPModernServerCapabilities {
	tools?: { listChanged?: boolean };
	resources?: { subscribe?: boolean; listChanged?: boolean };
	prompts?: { listChanged?: boolean };
	/** Argument completion through completion/complete. */
	completions?: Record<string, never>;
	extensions?: MCPExtensionCapabilities;
}

function normalizeExtensions(value: unknown): MCPExtensionCapabilities | undefined {
	const record = asMCPRecord(value);
	if (!record) return undefined;

	const extensions: MCPExtensionCapabilities = {};
	for (const [identifier, settings] of Object.entries(record)) {
		const extensionSettings = asMCPRecord(settings);
		if (extensionSettings) extensions[identifier] = extensionSettings;
	}
	return Object.keys(extensions).length > 0 ? extensions : undefined;
}

/**
 * Converts discovery/initialize capability data to the surface safe for
 * downstream feature gates. Unknown capability families are deliberately not
 * surfaced as implemented features; extension settings remain pass-through.
 */
export function normalizeMCPServerCapabilities(value: unknown): MCPNormalizedServerCapabilities {
	const capabilities = asMCPRecord(value) ?? {};
	const tools = asMCPRecord(capabilities.tools);
	const resources = asMCPRecord(capabilities.resources);
	const prompts = asMCPRecord(capabilities.prompts);
	const completions = asMCPRecord(capabilities.completions);
	const extensions = normalizeExtensions(capabilities.extensions);

	return {
		...(tools ? { tools: { listChanged: tools.listChanged === true } } : {}),
		...(resources
			? {
					resources: {
						subscribe: resources.subscribe === true,
						listChanged: resources.listChanged === true,
					},
				}
			: {}),
		...(prompts ? { prompts: { listChanged: prompts.listChanged === true } } : {}),
		...(extensions ? { extensions } : {}),
		...(completions ? { completions: {} } : {}),
	};
}

/** Normalize the exact modern notification flags; they authorize `subscriptions/listen`, never legacy resource RPCs. */
export function normalizeModernMCPServerCapabilities(value: unknown): MCPNormalizedServerCapabilities {
	const capabilities = asMCPRecord(value) ?? {};
	const tools = asMCPRecord(capabilities.tools);
	const resources = asMCPRecord(capabilities.resources);
	const prompts = asMCPRecord(capabilities.prompts);
	const completions = asMCPRecord(capabilities.completions);
	const extensions = normalizeExtensions(capabilities.extensions);

	return {
		...(tools ? { tools: { listChanged: tools.listChanged === true } } : {}),
		...(resources
			? {
					resources: {
						subscribe: resources.subscribe === true,
						listChanged: resources.listChanged === true,
					},
				}
			: {}),
		...(prompts ? { prompts: { listChanged: prompts.listChanged === true } } : {}),
		...(extensions ? { extensions } : {}),
		...(completions ? { completions: {} } : {}),
	};
}

/** Initialize request params for initialization-based protocol revisions. */
export interface MCPInitializeParams {
	protocolVersion: string;
	capabilities: MCPClientCapabilities;
	clientInfo: MCPImplementation;
}

/** Initialize response result for initialization-based protocol revisions. */
export interface MCPInitializeResult {
	protocolVersion: string;
	capabilities: MCPServerCapabilities;
	serverInfo: MCPImplementation;
	instructions?: string;
}

/** Tool annotations from the 2025-11-25 tools spec. */
export interface MCPToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/** Execution metadata from the 2025-11-25 tools spec. */
export interface MCPToolExecution {
	taskSupport?: "forbidden" | "optional" | "required";
}

/** MCP tool definition */
export interface MCPToolDefinition {
	name: string;
	title?: string;
	description?: string;
	icons?: MCPIcon[];
	inputSchema: {
		type: "object";
		properties?: Record<string, unknown>;
		required?: string[];
		[key: string]: unknown;
	};
	outputSchema?: Record<string, unknown>;
	execution?: MCPToolExecution;
	annotations?: MCPToolAnnotations;
	_meta?: Record<string, unknown>;
}

/** Primitive JSON-schema types that may be safely mirrored into MCP HTTP headers. */
export type MCPToolHeaderValueType = "string" | "integer" | "boolean";

/** One statically reachable `x-mcp-header` parameter annotation. */
export interface MCPToolHeaderParameter {
	/** Property path beneath `tools/call.arguments`. */
	path: readonly string[];
	/** `x-mcp-header` value, used as the suffix of `Mcp-Param-{headerName}`. */
	headerName: string;
	valueType: MCPToolHeaderValueType;
}

/** Validated tool header metadata registered by the modern HTTP client path. */
export interface MCPToolHeaderMetadata {
	toolName: string;
	parameters: readonly MCPToolHeaderParameter[];
}

/** Validation result for one tool's `x-mcp-header` annotations. */
export type MCPToolHeaderValidationResult =
	| { valid: true; metadata: MCPToolHeaderMetadata }
	| { valid: false; reason: string };

/** A fully encoded custom header value that an HTTP transport can mirror safely. */
export interface MCPToolHeaderValue {
	name: string;
	value: string;
	path: readonly string[];
}

const MCP_HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MCP_HEADER_VALUE_PATTERN = /^[\t\x20-\x7e]*$/;
const MCP_BASE64_SENTINEL_PATTERN = /^=\?base64\?.*\?=$/;

/**
 * Validates and normalizes `x-mcp-header` annotations. Annotation discovery
 * walks arbitrary schema content so an annotation outside an all-properties
 * path is rejected rather than silently ignored.
 */
export function validateMCPToolHeaderMetadata(tool: MCPToolDefinition): MCPToolHeaderValidationResult {
	const parameters: MCPToolHeaderParameter[] = [];
	const headerNames = new Set<string>();
	let reason: string | undefined;

	const visit = (value: unknown, path: string[], isStaticallyReachable: boolean): void => {
		if (reason) return;
		const schema = asMCPRecord(value);
		if (!schema) {
			if (Array.isArray(value)) {
				for (const item of value) visit(item, path, false);
			}
			return;
		}

		if (Object.hasOwn(schema, "x-mcp-header")) {
			const annotation = schema["x-mcp-header"];
			if (!isStaticallyReachable) {
				reason = "x-mcp-header must be reachable using only properties";
				return;
			}
			if (typeof annotation !== "string" || annotation.length === 0 || !MCP_HTTP_TOKEN_PATTERN.test(annotation)) {
				reason = "x-mcp-header must be a non-empty HTTP field-name token";
				return;
			}
			const valueType = schema.type;
			if (valueType !== "string" && valueType !== "integer" && valueType !== "boolean") {
				reason = "x-mcp-header is limited to string, integer, or boolean properties";
				return;
			}
			if (path.length === 0) {
				reason = "x-mcp-header must annotate a property, not the schema root";
				return;
			}
			const normalizedHeaderName = annotation.toLowerCase();
			if (headerNames.has(normalizedHeaderName)) {
				reason = `x-mcp-header "${annotation}" duplicates another header name`;
				return;
			}
			headerNames.add(normalizedHeaderName);
			parameters.push({ path: [...path], headerName: annotation, valueType });
		}

		for (const [keyword, nestedValue] of Object.entries(schema)) {
			if (keyword === "x-mcp-header") continue;
			if (keyword === "properties") {
				const properties = asMCPRecord(nestedValue);
				if (!properties) {
					visit(nestedValue, path, false);
					continue;
				}
				for (const [propertyName, propertySchema] of Object.entries(properties)) {
					visit(propertySchema, [...path, propertyName], isStaticallyReachable);
				}
				continue;
			}
			visit(nestedValue, path, false);
		}
	};

	visit(tool.inputSchema, [], true);
	return reason
		? { valid: false, reason }
		: {
				valid: true,
				metadata: {
					toolName: tool.name,
					parameters,
				},
			};
}

/** Encodes a field value using the 2026-07-28 MCP HTTP Base64 sentinel when required. */
export function encodeMCPHeaderValue(value: string): string {
	const hasUnsafeCharacters = !MCP_HEADER_VALUE_PATTERN.test(value);
	const hasBoundaryWhitespace = /^[\t ]|[\t ]$/.test(value);
	if (!hasUnsafeCharacters && !hasBoundaryWhitespace && !MCP_BASE64_SENTINEL_PATTERN.test(value)) {
		return value;
	}
	return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** Extracts and safely encodes custom headers for one validated tools/call definition. */
export function extractMCPToolHeaderValues(
	metadata: MCPToolHeaderMetadata,
	argumentsValue: Record<string, unknown> | undefined,
): MCPToolHeaderValue[] {
	const values: MCPToolHeaderValue[] = [];
	for (const parameter of metadata.parameters) {
		let value: unknown = argumentsValue;
		for (const segment of parameter.path) {
			const object = asMCPRecord(value);
			if (!object || !Object.hasOwn(object, segment)) {
				value = undefined;
				break;
			}
			value = object[segment];
		}

		let stringValue: string | undefined;
		if (parameter.valueType === "string" && typeof value === "string") {
			stringValue = value;
		} else if (parameter.valueType === "integer" && typeof value === "number" && Number.isSafeInteger(value)) {
			stringValue = String(value);
		} else if (parameter.valueType === "boolean" && typeof value === "boolean") {
			stringValue = value ? "true" : "false";
		}
		if (stringValue === undefined) continue;
		values.push({
			name: `Mcp-Param-${parameter.headerName}`,
			value: encodeMCPHeaderValue(stringValue),
			path: parameter.path,
		});
	}
	return values;
}

/** tools/list response, with optional fields for legacy compatibility. */
export interface MCPToolsListResult extends MCPCacheableResultFields {
	tools: MCPToolDefinition[];
	nextCursor?: string;
}

/** tools/call params. */
export interface MCPToolCallParams extends MCPInputResponseParams {
	name: string;
	arguments?: Record<string, unknown>;
}

/** Content types in tool results. */
export interface MCPTextContent {
	type: "text";
	text: string;
}

export interface MCPImageContent {
	type: "image";
	data: string; // base64
	mimeType: string;
}

export interface MCPResourceContent {
	type: "resource";
	resource: {
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
	};
}

export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

/** Structured authentication challenge returned in a tool result. */
export interface MCPAuthChallenge {
	/** Values from `_meta["mcp/www_authenticate"]`. */
	readonly wwwAuthenticate: readonly string[];
}

/** tools/call response */
export interface MCPToolCallResult {
	content: MCPContent[];
	isError?: boolean;
	_meta?: Record<string, unknown>;
}

/** Modern tools/call response, including the MRTR interim alternative. */
export type MCPToolCallOperationResult = (MCPCompleteResult & MCPToolCallResult) | MCPInputRequiredResult;

// =============================================================================
// Transport Types
// =============================================================================

/** Persisted protocol era and negotiated version for one MCP connection. */
export interface MCPModernConnectionProtocol {
	era: "modern";
	version: MCPModernProtocolVersion;
	/** Versions reported by `server/discover`, retained for diagnostics. */
	supportedVersions: readonly string[];
	clientCapabilities: MCPModernClientCapabilities;
	capabilities: MCPNormalizedServerCapabilities;
	serverInfo?: MCPImplementation;
}

/** Persisted descriptor for an initialize-based legacy connection. */
export interface MCPLegacyConnectionProtocol {
	era: "legacy";
	version: string;
	capabilities: MCPNormalizedServerCapabilities;
}

export type MCPConnectionProtocol = MCPModernConnectionProtocol | MCPLegacyConnectionProtocol;

/**
 * Protocol state supplied to a transport before a probe and after negotiation.
 * HTTP writers can mirror the modern version into headers; stdio writers can
 * decide whether cancellation is the modern `notifications/cancelled` form.
 */
export type MCPTransportProtocolConfiguration =
	| {
			era: "modern";
			phase: "probing" | "connected";
			version: MCPModernProtocolVersion;
			clientInfo: MCPImplementation;
			clientCapabilities: MCPModernClientCapabilities;
	  }
	| {
			era: "legacy";
			phase: "connected";
			version: string;
	  };

/**
 * A transport-specific classification of an unsuccessful modern probe.
 *
 * Stdio uses the default legacy outcome for unrecognized errors. HTTP must
 * opt into `legacy` only after its stricter status/body validation.
 */
export type MCPModernProbeFallbackDecision =
	| { kind: "legacy" }
	| { kind: "modern-error"; error: JsonRpcError }
	| { kind: "reject" };

/** Request-scoped operation contract for future transport implementations. */
export interface MCPOperationHandle<TResult> {
	requestId: MCPRequestId;
	result: Promise<TResult>;
	cancel(): Promise<void>;
}

/** Notification filters accepted by the modern `subscriptions/listen` operation. */
export interface MCPSubscriptionNotificationFilter {
	toolsListChanged?: boolean;
	promptsListChanged?: boolean;
	resourcesListChanged?: boolean;
	resourceSubscriptions?: string[];
}

/** Params for a modern `subscriptions/listen` transport implementation. */
export interface MCPListenParams {
	notifications: MCPSubscriptionNotificationFilter;
}

/** Reserved metadata key used to demultiplex modern subscription notifications. */
export const MCP_SUBSCRIPTION_ID_META_KEY = "io.modelcontextprotocol/subscriptionId" as const;

/** A malformed or unauthorized message on one modern subscription stream. */
export class MCPSubscriptionProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MCPSubscriptionProtocolError";
	}
}

/** True when a filter opts in to at least one notification type. */
export function hasMCPSubscriptionNotifications(filter: MCPSubscriptionNotificationFilter): boolean {
	return (
		filter.toolsListChanged === true ||
		filter.promptsListChanged === true ||
		filter.resourcesListChanged === true ||
		(filter.resourceSubscriptions?.length ?? 0) > 0
	);
}

/** Compare normalized subscription filters, including URI order. */
export function areMCPSubscriptionFiltersEqual(
	left: MCPSubscriptionNotificationFilter,
	right: MCPSubscriptionNotificationFilter,
): boolean {
	return (
		left.toolsListChanged === right.toolsListChanged &&
		left.promptsListChanged === right.promptsListChanged &&
		left.resourcesListChanged === right.resourcesListChanged &&
		(left.resourceSubscriptions?.length ?? 0) === (right.resourceSubscriptions?.length ?? 0) &&
		(left.resourceSubscriptions ?? []).every((uri, index) => uri === right.resourceSubscriptions?.[index])
	);
}

/** Read and validate a subscription ID from notification params metadata. */
export function getMCPNotificationSubscriptionId(params: unknown): MCPRequestId | undefined {
	const record = asMCPRecord(params);
	const metadata = asMCPRecord(record?._meta);
	const requestId = metadata?.[MCP_SUBSCRIPTION_ID_META_KEY];
	return typeof requestId === "string" || typeof requestId === "number" ? requestId : undefined;
}

/**
 * Validate the acknowledged filter and return its normalized subset.
 * Acknowledgment never expands what the client requested.
 */
export function validateMCPSubscriptionAcknowledgement(
	requested: MCPSubscriptionNotificationFilter,
	params: unknown,
): MCPSubscriptionNotificationFilter {
	const record = asMCPRecord(params);
	const notifications = asMCPRecord(record?.notifications);
	if (!notifications) {
		throw new MCPSubscriptionProtocolError(
			"Invalid subscriptions/listen acknowledgment: missing notifications filter",
		);
	}

	const acknowledged: MCPSubscriptionNotificationFilter = {};
	for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"] as const) {
		const value = notifications[key];
		if (value !== undefined && typeof value !== "boolean") {
			throw new MCPSubscriptionProtocolError(
				`Invalid subscriptions/listen acknowledgment: ${key} must be a boolean`,
			);
		}
		if (value === true) {
			if (requested[key] !== true) {
				throw new MCPSubscriptionProtocolError(
					`Invalid subscriptions/listen acknowledgment: ${key} was not requested`,
				);
			}
			acknowledged[key] = true;
		}
	}

	const resourceSubscriptions = notifications.resourceSubscriptions;
	if (resourceSubscriptions !== undefined) {
		if (!Array.isArray(resourceSubscriptions) || resourceSubscriptions.some(uri => typeof uri !== "string")) {
			throw new MCPSubscriptionProtocolError(
				"Invalid subscriptions/listen acknowledgment: resourceSubscriptions must be an array of strings",
			);
		}
		const requestedUris = new Set(requested.resourceSubscriptions ?? []);
		const acknowledgedUris = [...new Set(resourceSubscriptions as string[])];
		if (acknowledgedUris.some(uri => !requestedUris.has(uri))) {
			throw new MCPSubscriptionProtocolError(
				"Invalid subscriptions/listen acknowledgment: resourceSubscriptions contains an unrequested URI",
			);
		}
		if (acknowledgedUris.length > 0) acknowledged.resourceSubscriptions = acknowledgedUris;
	}
	return acknowledged;
}

/** Normalizes percent triplets within one URI component without decoding reserved delimiters. */
function normalizeMCPResourceUriComponent(component: string): string {
	return component.replace(/%([0-9a-fA-F]{2})/g, (match, hex: string) => {
		const code = Number.parseInt(hex, 16);
		const char = String.fromCharCode(code);
		return /^[A-Za-z0-9\-._~]$/.test(char) ? char : match.toUpperCase();
	});
}

/**
 * Returns whether `candidateUri` is an exact acknowledged resource URI or a
 * descendant of one. URI components are parsed before comparing paths so a
 * prefix such as `file:///ab` can never escape an acknowledgment for
 * `file:///a`.
 */
export function isMCPResourceUriOrSubresource(acknowledgedUri: string, candidateUri: string): boolean {
	if (acknowledgedUri === candidateUri) return true;
	try {
		const parent = new URL(acknowledgedUri);
		const candidate = new URL(candidateUri);
		if (
			normalizeMCPResourceUriComponent(parent.protocol) !== normalizeMCPResourceUriComponent(candidate.protocol) ||
			normalizeMCPResourceUriComponent(parent.username) !== normalizeMCPResourceUriComponent(candidate.username) ||
			normalizeMCPResourceUriComponent(parent.password) !== normalizeMCPResourceUriComponent(candidate.password) ||
			normalizeMCPResourceUriComponent(parent.host) !== normalizeMCPResourceUriComponent(candidate.host) ||
			normalizeMCPResourceUriComponent(parent.search) !== normalizeMCPResourceUriComponent(candidate.search) ||
			normalizeMCPResourceUriComponent(parent.hash) !== normalizeMCPResourceUriComponent(candidate.hash)
		) {
			return false;
		}
		const parentPath = normalizeMCPResourceUriComponent(parent.pathname);
		const candidatePath = normalizeMCPResourceUriComponent(candidate.pathname);
		const boundary = parentPath === "/" ? "/" : `${parentPath.replace(/\/+$/, "")}/`;
		return candidatePath.startsWith(boundary);
	} catch {
		return false;
	}
}

/** True when a delivered notification belongs to the acknowledged subset. */
export function isMCPSubscriptionNotificationAcknowledged(
	acknowledged: MCPSubscriptionNotificationFilter,
	method: string,
	params: unknown,
): boolean {
	switch (method) {
		case "notifications/tools/list_changed":
			return acknowledged.toolsListChanged === true;
		case "notifications/prompts/list_changed":
			return acknowledged.promptsListChanged === true;
		case "notifications/resources/list_changed":
			return acknowledged.resourcesListChanged === true;
		case "notifications/resources/updated": {
			const uri = asMCPRecord(params)?.uri;
			return (
				typeof uri === "string" &&
				acknowledged.resourceSubscriptions?.some(acknowledgedUri =>
					isMCPResourceUriOrSubresource(acknowledgedUri, uri),
				) === true
			);
		}
		default:
			return false;
	}
}

/** Options scoped to one modern listener rather than the transport-wide notification callback. */
export interface MCPListenOptions extends MCPRequestOptions {
	onNotification?: (method: string, params: unknown) => void;
}

/** Lifecycle of one long-lived modern subscription request. */
export interface MCPListenHandle {
	requestId: MCPRequestId;
	requestedNotifications: MCPSubscriptionNotificationFilter;
	/** Set synchronously before the acknowledgment promise resolves. */
	acknowledgedNotifications?: MCPSubscriptionNotificationFilter;
	acknowledged: Promise<MCPSubscriptionNotificationFilter>;
	completion: Promise<void>;
	cancel(): Promise<void>;
}

/** Hooks an era-aware transport may implement without changing request callers. */
export interface MCPTransportProtocolHooks {
	configureProtocol?(configuration: MCPTransportProtocolConfiguration): void | Promise<void>;
	getProtocolConfiguration?(): MCPTransportProtocolConfiguration | undefined;
	classifyModernProbeFailure?(error: unknown): MCPModernProbeFallbackDecision;
	/**
	 * Replaces the modern tools/list header-annotation snapshot. Metadata has
	 * already passed `validateMCPToolHeaderMetadata`; HTTP writers use it to
	 * mirror tools/call arguments without reparsing untrusted schemas.
	 */
	registerToolHeaderMetadata?(metadata: readonly MCPToolHeaderMetadata[]): void | Promise<void>;
	/**
	 * Returns the opaque non-negative safe-integer revision of the active
	 * authentication context. Implement when request authentication can rotate;
	 * increment before dispatching with the new context.
	 */
	getAuthenticationContextRevision?(): MCPAuthenticationContextRevision | undefined;
	listen?(params: MCPListenParams, options?: MCPListenOptions): Promise<MCPListenHandle>;
}

export interface MCPRequestOptions {
	/** Abort signal (e.g. Escape-to-interrupt) */
	signal?: AbortSignal;
	/**
	 * Additional modern request metadata. Reserved MCP identity/version keys are
	 * overwritten by `buildModernRequestParams`.
	 */
	metadata?: MCPMeta;
	/** Trusted extension runtime; used to validate custom result envelope types. */
	extensionRuntime?: MCPExtensionRuntime;
}

/** Transport interface - abstracts stdio/http. */
export interface MCPTransport extends MCPTransportProtocolHooks {
	/** Send a request and wait for response. */
	request<T = unknown>(method: string, params?: Record<string, unknown>, options?: MCPRequestOptions): Promise<T>;

	/** Send a notification (no response expected). */
	notify(method: string, params?: Record<string, unknown>): Promise<void>;

	/** Close the transport. */
	close(): Promise<void>;

	/**
	 * Record the protocol version negotiated in the `initialize` response.
	 * Streamable HTTP transports echo it in the `MCP-Protocol-Version` header on
	 * every subsequent request; transports that need no per-request version
	 * (stdio) omit this.
	 */
	setProtocolVersion?(version: string): void;

	/** Whether the transport is connected */
	readonly connected: boolean;

	/** Event handlers. */
	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	/** Legacy handler for server-to-client requests (e.g. roots/list). */
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

/** Transport factory function */
export type TransportFactory = (config: MCPServerConfig) => Promise<MCPTransport>;

// =============================================================================
// MCP Client Types
// =============================================================================

/** Retained cache-hint state for connection-local cacheable operations. */
export interface MCPConnectionResultHints {
	discovery?: MCPResultCacheHint;
	tools?: MCPResultCacheHint;
	resources?: MCPResultCacheHint;
	resourceTemplates?: MCPResultCacheHint;
	prompts?: MCPResultCacheHint;
	resourceReads?: Map<string, MCPResultCacheHint>;
}

/** Connected MCP server state */
export interface MCPServerConnection {
	/** Server name from config */
	name: string;
	/** Original config */
	config: MCPServerConfig;
	/** Transport instance */
	transport: MCPTransport;
	/**
	 * Server identity. Modern discovery normally provides it in result metadata;
	 * a compatibility display fallback is used when a server omits that SHOULD.
	 */
	serverInfo: MCPImplementation;
	/** Normalized capability view used by all client feature gates. */
	capabilities: MCPNormalizedServerCapabilities;
	/**
	 * Negotiated protocol descriptor. Connections made by `connectToServer`
	 * always carry it; optionality preserves compatibility for externally
	 * constructed legacy test connections.
	 */
	protocol?: MCPConnectionProtocol;
	/** Immutable intersection of enabled trusted providers and server capabilities. */
	extensions?: ReadonlyMap<string, MCPNegotiatedExtensionState>;
	/** Trusted extension runtime; sole owner of extension state and custom result type validators. */
	extensionRuntime?: MCPExtensionRuntime;
	/** Exact server result/cache metadata retained separately from projected payload arrays. */
	resultHints?: MCPConnectionResultHints;
	/** Cached tools (populated on demand) */
	tools?: MCPToolDefinition[];
	/** Source metadata (for display) */
	_source?: SourceMeta;
	/** Cached resources (populated on demand) */
	resources?: MCPResource[];
	/** Cached resource templates (populated on demand) */
	resourceTemplates?: MCPResourceTemplate[];
	/** Server instructions from initialize */
	instructions?: string;
	/** Cached prompts (populated on demand) */
	prompts?: MCPPrompt[];
	/** Fresh resources/read results, isolated to this negotiated connection and exact URI. */
	resourceReads?: Map<string, MCPResourceReadResult>;
}

/** MCP tool with server context */
export interface MCPToolWithServer {
	server: MCPServerConnection;
	tool: MCPToolDefinition;
}

// =============================================================================
// MCP Completion Types
// =============================================================================

/** A prompt whose named argument is being completed. */
export interface MCPPromptReference {
	type: "ref/prompt";
	name: string;
}

/** A resource template whose named argument is being completed. */
export interface MCPResourceTemplateReference {
	type: "ref/resource";
	uri: string;
}

/** The protocol references that can request argument completion. */
export type MCPCompletionReference = MCPPromptReference | MCPResourceTemplateReference;

/** The partial named argument sent to completion/complete. */
export interface MCPCompletionArgument {
	name: string;
	value: string;
}

/** Previously resolved prompt or resource-template arguments, when available. */
export interface MCPCompletionContext {
	arguments?: Record<string, string>;
}

/** Completion candidates returned by a server. */
export interface MCPCompletion {
	values: string[];
	total?: number;
	hasMore?: boolean;
}

/** Parameters for one completion/complete request. */
export interface MCPCompleteParams {
	ref: MCPCompletionReference;
	argument: MCPCompletionArgument;
	context?: MCPCompletionContext;
}

/** Completion response, compatible with legacy and modern result envelopes. */
export interface MCPCompletionResult extends MCPResultEnvelope {
	completion: MCPCompletion;
}

// MCP Resource Types
// =============================================================================

/** Annotations for resources, templates, and content blocks */
export interface MCPAnnotations {
	audience?: ("user" | "assistant")[];
	priority?: number;
	lastModified?: string;
}

/** A concrete resource exposed by an MCP server */
export interface MCPResource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
	annotations?: MCPAnnotations;
}

/** A parameterized resource template (RFC 6570 URI template) */
export interface MCPResourceTemplate {
	uriTemplate: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
	annotations?: MCPAnnotations;
}

/** resources/list response, with optional fields for legacy compatibility. */
export interface MCPResourcesListResult extends MCPCacheableResultFields {
	resources: MCPResource[];
	nextCursor?: string;
}

/** resources/templates/list response, with optional fields for legacy compatibility. */
export interface MCPResourceTemplatesListResult extends MCPCacheableResultFields {
	resourceTemplates: MCPResourceTemplate[];
	nextCursor?: string;
}

/** A single content item from resources/read */
export interface MCPResourceContentItem {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

/** resources/read completed response, compatible with legacy result shapes. */
export interface MCPResourceReadResult extends MCPCacheableResultFields {
	contents: MCPResourceContentItem[];
}

/** Params for resources/read, including a possible MRTR retry. */
export interface MCPResourceReadParams extends MCPInputResponseParams {
	uri: string;
}

/** Modern resources/read response, including the MRTR interim alternative. */
export type MCPResourceReadOperationResult = (MCPCacheableResult & MCPResourceReadResult) | MCPInputRequiredResult;

/** Params for resources/subscribe and resources/unsubscribe */
export interface MCPResourceSubscribeParams {
	uri: string;
}

// =============================================================================
// MCP Prompt Types
// =============================================================================

/** An argument definition for an MCP prompt */
export interface MCPPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** A prompt definition exposed by an MCP server */
export interface MCPPrompt {
	name: string;
	title?: string;
	description?: string;
	arguments?: MCPPromptArgument[];
}

/** prompts/list response, with optional fields for legacy compatibility. */
export interface MCPPromptsListResult extends MCPCacheableResultFields {
	prompts: MCPPrompt[];
	nextCursor?: string;
}

/** Audio content in prompt messages */
export interface MCPAudioContent {
	type: "audio";
	data: string;
	mimeType: string;
}

/** Content type union for prompt messages */
export type MCPPromptContent = MCPTextContent | MCPImageContent | MCPAudioContent | MCPResourceContent;

/** A single message in a prompt result */
export interface MCPPromptMessage {
	role: "user" | "assistant";
	content: MCPPromptContent | MCPPromptContent[];
}

/** Params for prompts/get, including a possible MRTR retry. */
export interface MCPGetPromptParams extends MCPInputResponseParams {
	name: string;
	arguments?: Record<string, string>;
}

/** prompts/get completed response, compatible with legacy result shapes. */
export interface MCPGetPromptResult extends MCPResultEnvelope {
	description?: string;
	messages: MCPPromptMessage[];
}

/** Modern prompts/get response, including the MRTR interim alternative. */
export type MCPGetPromptOperationResult = (MCPCompleteResult & MCPGetPromptResult) | MCPInputRequiredResult;

/** A request-scoped token carried in _meta to receive progress notifications. */
export type MCPProgressToken = string | number;

/** One server-to-client progress update for the request carrying the same token. */
export interface MCPProgressNotification {
	progressToken: MCPProgressToken;
	progress: number;
	total?: number;
	message?: string;
}

/** Host callback for a validated request-scoped progress update. */
export type MCPProgressHandler = (notification: Readonly<MCPProgressNotification>) => void;

// =============================================================================
// MCP Notification Method Names
// =============================================================================

export const MCPNotificationMethods = {
	SUBSCRIPTIONS_ACKNOWLEDGED: "notifications/subscriptions/acknowledged",
	CANCELLED: "notifications/cancelled",
	TOOLS_LIST_CHANGED: "notifications/tools/list_changed",
	RESOURCES_LIST_CHANGED: "notifications/resources/list_changed",
	RESOURCES_UPDATED: "notifications/resources/updated",
	PROGRESS: "notifications/progress",
	PROMPTS_LIST_CHANGED: "notifications/prompts/list_changed",
} as const;

/** Data attached to the modern unsupported-protocol-version error (-32022). */
export interface MCPUnsupportedProtocolVersionData {
	supported: string[];
	requested?: string;
}

/** Parsed modern unsupported-protocol-version error. */
export interface MCPUnsupportedProtocolVersionError extends JsonRpcError {
	code: -32022;
	data?: MCPUnsupportedProtocolVersionData;
}

/** Error used when a modern server is recognized but no mutual version exists. */
export class MCPModernProtocolNegotiationError extends Error {
	constructor(
		message: string,
		public readonly protocolError?: JsonRpcError,
	) {
		super(message);
		this.name = "MCPModernProtocolNegotiationError";
	}
}

/**
 * Extract a JSON-RPC error from a thrown value.
 *
 * The parser preserves `.code` and `.data` on Error instances and plain
 * objects, and recognizes the error text produced by the current transports.
 */
export function toJsonRpcError(error: unknown): JsonRpcError {
	if (error instanceof Error) {
		const candidate = error as Error & { code?: unknown; data?: unknown };
		const code =
			typeof candidate.code === "number"
				? candidate.code
				: /^MCP error (-?\d+):/.exec(error.message)?.[1]
					? Number(/^MCP error (-?\d+):/.exec(error.message)?.[1])
					: -32603;
		return {
			code,
			message: error.message,
			...(candidate.data === undefined ? {} : { data: candidate.data }),
		};
	}
	const obj = asMCPRecord(error);
	if (obj && typeof obj.code === "number" && typeof obj.message === "string") {
		return {
			code: obj.code,
			message: obj.message,
			...(obj.data === undefined ? {} : { data: obj.data }),
		};
	}
	return { code: -32603, message: "Internal error" };
}

/**
 * Recognizes the modern version error without treating unrelated failures as
 * modern. A malformed -32022 remains recognized so callers never downgrade it
 * to a legacy initialize lifecycle.
 */
export function parseUnsupportedProtocolVersionError(error: unknown): MCPUnsupportedProtocolVersionError | undefined {
	const protocolError = toJsonRpcError(error);
	if (protocolError.code !== -32022) return undefined;

	const data = asMCPRecord(protocolError.data);
	const supported = Array.isArray(data?.supported)
		? data.supported.filter((version): version is string => typeof version === "string")
		: undefined;
	const requested = typeof data?.requested === "string" ? data.requested : undefined;
	return {
		code: -32022,
		message: protocolError.message,
		...(supported === undefined ? {} : { data: { supported, ...(requested === undefined ? {} : { requested }) } }),
	};
}
