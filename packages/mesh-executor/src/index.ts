import {
	canonicalizeJson,
	parseAssignmentLease,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type ExecutorInvocationSpec,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";
import type { MeshExecutionRunResult, MeshNodeExecutionContext, MeshNodeExecutionPort } from "@pk-nerdsaver-ai/mesh-node";

export const EXECUTOR_MCP_EXECUTION_PROFILE = "executor-mcp-v1";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export type ExecutorMeshExecutionErrorCode =
	| "approval_required"
	| "cancellation_uncertain"
	| "catalog_fingerprint_mismatch"
	| "context_binding_mismatch"
	| "endpoint_untrusted"
	| "execution_profile_mismatch"
	| "gateway_result_invalid"
	| "input_digest_mismatch"
	| "invocation_invalid"
	| "invocation_missing"
	| "tool_permission_denied";

/** Safe, stable error codes only; invocation arguments and credentials never appear here. */
export class ExecutorMeshExecutionError extends Error {
	readonly code: ExecutorMeshExecutionErrorCode;

	constructor(code: ExecutorMeshExecutionErrorCode) {
		super(`executor_mesh_execution_${code}`);
		this.name = "ExecutorMeshExecutionError";
		this.code = code;
	}
}

export interface TrustedExecutorEndpoint {
	readonly endpointId: string;
	readonly catalogFingerprint: string;
}

export interface ExecutorMcpInvocationMetadata {
	readonly taskId: string;
	readonly taskDigest: string;
	readonly assignmentId: string;
	readonly schedulerEpoch: number;
	readonly fencingToken: number;
	readonly inputDigest: string;
	readonly catalogFingerprint: string;
	readonly toolPermission: string;
}

export interface ExecutorMcpGatewayRequest {
	readonly endpointId: string;
	readonly code: string;
	readonly metadata: ExecutorMcpInvocationMetadata;
}

export type ExecutorMcpGatewayResult =
	| { readonly status: "succeeded"; readonly exitCode?: number }
	| { readonly status: "failed"; readonly exitCode?: number }
	| { readonly status: "approval_required" };

/**
 * The only bridge to a locally configured Executor MCP endpoint. A host owns
 * authentication, process lifetime, and networking; this package supplies no
 * SDK, endpoint, credentials, or automatic approval/resume behavior.
 */
export interface ExecutorMcpGateway {
	invoke(request: ExecutorMcpGatewayRequest): Promise<ExecutorMcpGatewayResult>;
}

export interface ExecutorMeshExecutionPortOptions {
	readonly gateway: ExecutorMcpGateway;
	readonly trustedEndpoints: readonly TrustedExecutorEndpoint[];
}

interface PreparedInvocation {
	readonly endpointId: string;
	readonly code: string;
	readonly metadata: ExecutorMcpInvocationMetadata;
}

function assertSafeIdentifier(value: string, code: ExecutorMeshExecutionErrorCode): void {
	if (!SAFE_IDENTIFIER.test(value) || FORBIDDEN_PATH_SEGMENTS.has(value)) throw new ExecutorMeshExecutionError(code);
}

function assertToolPath(path: readonly string[], code: ExecutorMeshExecutionErrorCode): void {
	if (path.length === 0) throw new ExecutorMeshExecutionError(code);
	for (const segment of path) assertSafeIdentifier(segment, code);
}

/**
 * Canonical, exact-only permission naming. Wildcards are not interpreted by
 * this port: a task must grant the exact returned string to invoke a tool.
 */
export function canonicalExecutorToolPermission(endpointId: string, toolPath: readonly string[]): string {
	assertSafeIdentifier(endpointId, "invocation_invalid");
	assertToolPath(toolPath, "invocation_invalid");
	return `executor:${endpointId}:tools.${toolPath.join(".")}`;
}

function checkedExitCode(value: number | undefined): number | undefined {
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A transport-neutral MeshNodeExecutionPort for Executor's MCP surface. It
 * accepts a signed data invocation, then constructs one fixed await statement
 * from identifier segments and canonical JSON only.
 */
export class ExecutorMeshExecutionPort implements MeshNodeExecutionPort {
	readonly #gateway: ExecutorMcpGateway;
	readonly #trustedEndpoints: ReadonlyMap<string, TrustedExecutorEndpoint>;

	constructor(options: ExecutorMeshExecutionPortOptions) {
		this.#gateway = options.gateway;
		const endpoints = new Map<string, TrustedExecutorEndpoint>();
		for (const endpoint of options.trustedEndpoints) {
			assertSafeIdentifier(endpoint.endpointId, "endpoint_untrusted");
			if (!SHA256.test(endpoint.catalogFingerprint) || endpoints.has(endpoint.endpointId)) throw new ExecutorMeshExecutionError("endpoint_untrusted");
			endpoints.set(endpoint.endpointId, Object.freeze({ ...endpoint }));
		}
		this.#trustedEndpoints = endpoints;
	}

	async start(context: MeshNodeExecutionContext): Promise<void> {
		this.#prepare(context);
	}

	async run(context: MeshNodeExecutionContext): Promise<MeshExecutionRunResult> {
		const invocation = this.#prepare(context);
		let result: ExecutorMcpGatewayResult;
		try {
			result = await this.#gateway.invoke(
				Object.freeze({
					endpointId: invocation.endpointId,
					code: invocation.code,
					metadata: invocation.metadata,
				}),
			);
		} catch {
			return Object.freeze({ outcome: "failed" });
		}

		if (result.status === "approval_required") throw new ExecutorMeshExecutionError("approval_required");
		if (result.status === "succeeded") {
			const exitCode = checkedExitCode(result.exitCode);
			return exitCode === undefined ? Object.freeze({ outcome: "succeeded" }) : Object.freeze({ outcome: "succeeded", exitCode });
		}
		if (result.status === "failed") {
			const exitCode = checkedExitCode(result.exitCode);
			return exitCode === undefined ? Object.freeze({ outcome: "failed" }) : Object.freeze({ outcome: "failed", exitCode });
		}
		throw new ExecutorMeshExecutionError("gateway_result_invalid");
	}

	async heartbeat(context: MeshNodeExecutionContext): Promise<void> {
		this.#prepare(context);
	}

	async cancel(context: MeshNodeExecutionContext): Promise<void> {
		this.#prepare(context);
		// Executor may have accepted the call already; claiming cancellation would be unsafe.
		throw new ExecutorMeshExecutionError("cancellation_uncertain");
	}

	async cleanup(context: MeshNodeExecutionContext): Promise<void> {
		this.#prepare(context);
	}

	#prepare(context: MeshNodeExecutionContext): PreparedInvocation {
		let task: TaskContractV1;
		let assignment: AssignmentLeaseV1;
		try {
			task = parseTaskContract(context.task);
			assignment = parseAssignmentLease(context.assignment);
		} catch {
			throw new ExecutorMeshExecutionError("invocation_invalid");
		}
		if (
			context.executionProfileId !== EXECUTOR_MCP_EXECUTION_PROFILE ||
			assignment.executionProfileId !== EXECUTOR_MCP_EXECUTION_PROFILE ||
			task.execution.profileId !== EXECUTOR_MCP_EXECUTION_PROFILE
		) {
			throw new ExecutorMeshExecutionError("execution_profile_mismatch");
		}
		if (
			task.taskId !== context.taskId ||
			task.digest !== context.taskDigest ||
			assignment.assignmentId !== context.assignmentId ||
			assignment.taskId !== task.taskId ||
			assignment.taskDigest !== task.digest ||
			assignment.schedulerEpoch !== context.schedulerEpoch ||
			assignment.fencingToken !== context.fencingToken
		) {
			throw new ExecutorMeshExecutionError("context_binding_mismatch");
		}

		const spec = task.executorInvocation;
		if (spec === undefined) throw new ExecutorMeshExecutionError("invocation_missing");
		this.#assertInvocation(spec);
		const endpoint = this.#trustedEndpoints.get(spec.endpointId);
		if (endpoint === undefined) throw new ExecutorMeshExecutionError("endpoint_untrusted");
		if (endpoint.catalogFingerprint !== spec.catalogFingerprint) throw new ExecutorMeshExecutionError("catalog_fingerprint_mismatch");

		const permission = canonicalExecutorToolPermission(spec.endpointId, spec.toolPath);
		if (!task.permissions.tools.includes(permission)) throw new ExecutorMeshExecutionError("tool_permission_denied");

		const metadata: ExecutorMcpInvocationMetadata = Object.freeze({
			taskId: task.taskId,
			taskDigest: task.digest,
			assignmentId: context.assignmentId,
			schedulerEpoch: context.schedulerEpoch,
			fencingToken: context.fencingToken,
			inputDigest: spec.inputDigest,
			catalogFingerprint: spec.catalogFingerprint,
			toolPermission: permission,
		});
		return Object.freeze({
			endpointId: spec.endpointId,
			code: `return await tools.${spec.toolPath.join(".")}(${canonicalizeJson(spec.args)});`,
			metadata,
		});
	}

	#assertInvocation(spec: ExecutorInvocationSpec): void {
		if (spec.protocol !== EXECUTOR_MCP_EXECUTION_PROFILE) throw new ExecutorMeshExecutionError("invocation_invalid");
		assertSafeIdentifier(spec.endpointId, "invocation_invalid");
		assertToolPath(spec.toolPath, "invocation_invalid");
		if (!SHA256.test(spec.catalogFingerprint)) throw new ExecutorMeshExecutionError("invocation_invalid");
		if (sha256CanonicalJson(spec.args) !== spec.inputDigest) throw new ExecutorMeshExecutionError("input_digest_mismatch");
	}
}
