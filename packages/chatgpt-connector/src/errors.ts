/**
 * Typed errors shared by every connector surface.
 *
 * The MCP and REST layers translate these into protocol-shaped failures, so a
 * model sees a stable, actionable code instead of a stack trace fragment.
 */

export type ConnectorErrorCode =
	| "unknown_workspace"
	| "unknown_task"
	| "task_busy"
	| "task_not_running"
	| "invalid_request"
	| "not_configured"
	| "chatgpt_error"
	| "internal_error";

export class ConnectorError extends Error {
	readonly code: ConnectorErrorCode;
	/** Extra protocol-safe context (never credentials). */
	readonly details?: Record<string, unknown>;

	constructor(code: ConnectorErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "ConnectorError";
		this.code = code;
		this.details = details;
	}
}

/** True when a value is a connector error (works across module copies). */
export function isConnectorError(value: unknown): value is ConnectorError {
	if (value instanceof ConnectorError) return true;
	if (!(value instanceof Error) || value.name !== "ConnectorError") return false;
	return "code" in value && typeof value.code === "string";
}
