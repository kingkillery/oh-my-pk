/**
 * Library surface for embedding the gateway (tests, a future ompk plugin).
 * The operator binary lives in `cli.ts`.
 */

export type { Scope } from "./auth/scopes";
export { formatScopes, parseScopes, permits, permitsAny, permittedHosts } from "./auth/scopes";
export { defaultConfigPath, defaultDataDir, GatewayConfigError, loadConfig, parseConfig } from "./config";
export { Store } from "./db/store";
export { describeError, GatewayError, HostToolError, HostTransportError, isGatewayError } from "./errors";
export { ConnectorClient } from "./host/client";
export { GatewayHttpServer } from "./http/server";
export type { EngineHost, TickHooks } from "./jobs/engine";
export { JobEngine, jobTitle, launchMessage, newJobId, requestInputHash } from "./jobs/engine";
export type { Caller } from "./jobs/service";
export { JobService } from "./jobs/service";
export type { ToolListEntry, ToolResult } from "./mcp/server";
export { McpServer } from "./mcp/server";
export { buildToolList, callTool } from "./mcp/tools";
export { newApprovalCode, normalizeApprovalCode } from "./oauth/crypto";
export type { ClientIdentity } from "./oauth/server";
export { OAuthServer } from "./oauth/server";
export { loadOrCreateSigningKey } from "./oauth/signing-key";
export type * from "./types";
export { SERVER_NAME, VERSION } from "./version";
