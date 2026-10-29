/**
 * Typed errors shared by every gateway surface.
 *
 * Tool calls translate these into protocol-shaped failures, so a model sees a
 * stable, actionable code instead of a stack trace fragment.
 */

export type GatewayErrorCode =
	| "not_found"
	| "job_state_conflict"
	| "request_id_conflict"
	| "start_disabled"
	| "host_unreachable"
	| "host_unauthorized"
	| "unknown_task"
	| "invalid_request"
	| "insufficient_scope"
	| "task_lost"
	| "internal_error";

export class GatewayError extends Error {
	readonly code: GatewayErrorCode;
	/** Extra protocol-safe context (never credentials). */
	readonly details?: Record<string, unknown>;

	constructor(code: GatewayErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "GatewayError";
		this.code = code;
		this.details = details;
	}
}

export function isGatewayError(value: unknown): value is GatewayError {
	return value instanceof GatewayError;
}

/** Map any thrown value onto a stable code and a safe message. */
export function describeError(error: unknown): { code: GatewayErrorCode; message: string } {
	if (error instanceof GatewayError) return { code: error.code, message: error.message };
	if (error instanceof HostToolError) return { code: mapHostError(error.code), message: error.message };
	if (error instanceof HostTransportError) {
		return error.delivery === "not_delivered"
			? { code: "host_unreachable", message: error.message }
			: { code: "host_unreachable", message: error.message };
	}
	return { code: "internal_error", message: "The gateway hit an unexpected error." };
}

/** A connector answered isError or a JSON-RPC error — the call reached the host. */
export class HostToolError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "HostToolError";
		this.code = code;
	}
}

/**
 * The call did not reach a definite answer.
 * `not_delivered`: nothing was sent or nothing was accepted (safe to re-queue).
 * `unknown`: the request may have landed (timeout, reset, 5xx after send).
 */
export class HostTransportError extends Error {
	readonly delivery: "not_delivered" | "unknown";
	constructor(delivery: "not_delivered" | "unknown", message: string) {
		super(message);
		this.name = "HostTransportError";
		this.delivery = delivery;
	}
}

function mapHostError(code: string): GatewayErrorCode {
	switch (code) {
		case "unknown_task":
			return "unknown_task";
		case "unknown_workspace":
			return "not_found";
		case "invalid_request":
			return "invalid_request";
		case "unauthorized":
			return "host_unauthorized";
		default:
			return "internal_error";
	}
}
