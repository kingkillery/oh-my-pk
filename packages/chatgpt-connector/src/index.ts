/**
 * Public API for `@pk-nerdsaver-ai/pi-chatgpt-connector`.
 *
 * `createConnector()` wires the whole stack (config → task manager → MCP core →
 * HTTP listener) and is what the `ompk-chatgpt` CLI and embedding hosts use.
 * Everything the MCP protocol layer needs is also exported directly so hosts
 * can compose their own transport or fake a TaskService in tests.
 */
export { type AuthDecision, authorize, authorizeRequest, readBearer, redactToken } from "./auth";
export {
	AuthorizationServerError,
	createJwtVerifier,
	InvalidTokenError,
	type JwksFetcher,
	type JwtVerifier,
	type JwtVerifierOptions,
	type OAuthPrincipal,
} from "./auth-jwt";
export {
	type AskOptions,
	type AskResult,
	ChatGptClient,
	type ChatGptClientOptions,
	createChatGptClient,
} from "./chatgpt/client";
export {
	type AuthConfig,
	type ChatGptClientConfig,
	type ConnectorConfig,
	ConnectorConfigError,
	createConfig,
	DEFAULT_CONFIG_PATH,
	type DefaultsConfig,
	type LimitsConfig,
	type LoadConfigOptions,
	loadChatGptClientConfig,
	loadConfig,
	type OAuthConfig,
	type ServerConfig,
	type WorkspaceConfig,
} from "./config";
export { ConnectorError, type ConnectorErrorCode, isConnectorError } from "./errors";
export {
	JSON_RPC_ERRORS,
	type JsonRpcFailure,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type JsonRpcSuccess,
	LATEST_PROTOCOL_VERSION,
	McpServer,
	type McpServerOptions,
	SUPPORTED_PROTOCOL_VERSIONS,
} from "./mcp/server";
export {
	callTool,
	listToolDefinitions,
	type ToolAnnotations,
	type ToolCallResult,
	type ToolContext,
	type ToolDefinition,
} from "./mcp/tools";
export { type ConnectorServer, type ConnectorServerOptions, startConnectorServer } from "./server/http";
export { createOmpkSessionRunner, type OmpkRunnerOptions, OmpkSessionRunner } from "./session/runner";
export { captureGitSnapshot, truncateText } from "./tasks/git";
export { ABORT_GRACE_MS, isTerminalState, summarizeTask, TaskManager, type TaskManagerOptions } from "./tasks/manager";
export type {
	LaunchTaskInput,
	LaunchTaskResult,
	RunHooks,
	RunOutcome,
	SessionRunner,
	TaskEvent,
	TaskRecord,
	TaskResult,
	TaskService,
	TaskState,
	TaskSummary,
	TaskUsage,
} from "./types";
export { VERSION } from "./version";

import { type ConnectorConfig, type LoadConfigOptions, loadConfig, type WorkspaceConfig } from "./config";
import { McpServer } from "./mcp/server";
import { type ConnectorServer, startConnectorServer } from "./server/http";
import { TaskManager, type TaskManagerOptions } from "./tasks/manager";
import type { SessionRunner, TaskService } from "./types";
import { requireSandboxedRunner } from "./workspace-boundary";

/** Factory for the runner bound to one workspace; injectable for tests/custom sessions. */
export type ConnectorRunnerFactory = (input: {
	workspace: WorkspaceConfig;
	model?: string;
}) => SessionRunner | Promise<SessionRunner>;

export interface CreateConnectorOptions extends LoadConfigOptions {
	/** Version reported by `GET /` and `GET /healthz`. */
	version?: string;
	/** Runner factory override; defaults to one `OmpkSessionRunner` per task. */
	createRunner?: ConnectorRunnerFactory;
	/** Request log sink; defaults to stderr. */
	log?: (line: string) => void;
	/** Fired after a task settles (completed/failed/cancelled/timed_out). */
	onSettled?: TaskManagerOptions["onSettled"];
}

/** A running connector: the pieces plus one `stop()` that drains both. */
export interface Connector {
	config: ConnectorConfig;
	service: TaskService;
	mcp: McpServer;
	server: ConnectorServer;
	/** Stops the HTTP listener first, then drains and disposes task runners. */
	stop(): Promise<void>;
}

/**
 * Load config, build the task manager and MCP core, and bind the HTTP listener.
 * The host must supply a runner backed by an enforced workspace sandbox.
 */
export function createConnector(options: CreateConnectorOptions = {}): Connector {
	const { version, createRunner, log, onSettled, ...loadOptions } = options;
	const sandboxedRunner = requireSandboxedRunner(createRunner);
	const config = loadConfig(loadOptions);
	const service = new TaskManager({
		config,
		onSettled,
		createRunner: sandboxedRunner,
	});
	const mcp = new McpServer({ service, config, version });
	const server = startConnectorServer({ config, service, mcp, version, log });
	return {
		config,
		service,
		mcp,
		server,
		async stop() {
			await server.stop();
			await service.shutdown();
		},
	};
}
