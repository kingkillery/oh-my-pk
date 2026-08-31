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
	readonly timeoutSeconds: number;
	readonly metadata: ExecutorMcpInvocationMetadata;
}

export type ExecutorMcpGatewayResult =
	| { readonly status: "succeeded"; readonly exitCode?: number }
	| { readonly status: "failed"; readonly exitCode?: number }
	| { readonly status: "approval_required" };

/**
 * The only bridge to a locally configured Executor execution surface. A host
 * owns authentication, process lifetime, and networking; this package
 * supplies no SDK, endpoint, credentials, or automatic approval/resume.
 */
export interface ExecutorMcpGateway {
	invoke(request: ExecutorMcpGatewayRequest): Promise<ExecutorMcpGatewayResult>;
}

/**
 * A host-configured Executor origin. The task contract can select only the
 * endpoint ID that the execution port has already authorized; it never
 * supplies a URL or credentials.
 */
export interface ExecutorHttpEndpoint {
	readonly endpointId: string;
	readonly origin: string;
	readonly authorization?: string;
}

export interface ExecutorHttpTransportRequest {
	readonly method: "POST";
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	/** Redirects must be rejected so canonical code never leaves the registered origin. */
	readonly redirect: "error";
	/** Aborts at the LocalMesh-approved task timeout. */
	readonly signal: AbortSignal;
}

export interface ExecutorHttpTransportResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

/**
 * The small transport seam keeps host networking policy and test doubles out
 * of the mesh policy port. The default implementation uses the platform
 * fetch API; hosts may inject a transport with their own mTLS or proxy rules.
 * Implementations must honor the signal and reject redirects.
 */
export interface ExecutorHttpTransport {
	send(request: ExecutorHttpTransportRequest): Promise<ExecutorHttpTransportResponse>;
}

export class FetchExecutorHttpTransport implements ExecutorHttpTransport {
	async send(request: ExecutorHttpTransportRequest): Promise<ExecutorHttpTransportResponse> {
		const response = await fetch(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			redirect: request.redirect,
			signal: request.signal,
		});
		return Object.freeze({
			ok: response.ok,
			status: response.status,
			json: () => response.json(),
		});
	}
}

export type ExecutorHttpGatewayErrorCode =
	| "endpoint_configuration_invalid"
	| "endpoint_not_registered"
	| "request_invalid"
	| "response_invalid"
	| "transport_timed_out"
	| "transport_unavailable";

/** Safe, stable HTTP-adapter errors that never embed endpoint or response data. */
export class ExecutorHttpGatewayError extends Error {
	readonly code: ExecutorHttpGatewayErrorCode;

	constructor(code: ExecutorHttpGatewayErrorCode) {
		super(`executor_http_gateway_${code}`);
		this.name = "ExecutorHttpGatewayError";
		this.code = code;
	}
}

export interface ExecutorHttpCodeGatewayOptions {
	readonly endpoints: readonly ExecutorHttpEndpoint[];
	readonly transport?: ExecutorHttpTransport;
}

interface RegisteredExecutorHttpEndpoint {
	readonly executionUrl: string;
	readonly authorization?: string;
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

function isSafeIdentifier(value: string): boolean {
	return SAFE_IDENTIFIER.test(value) && !FORBIDDEN_PATH_SEGMENTS.has(value);
}

function normalizeExecutorExecutionUrl(origin: string): string {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new ExecutorHttpGatewayError("endpoint_configuration_invalid");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username.length > 0 ||
		url.password.length > 0 ||
		url.pathname !== "/" ||
		url.search.length > 0 ||
		url.hash.length > 0
	) {
		throw new ExecutorHttpGatewayError("endpoint_configuration_invalid");
	}
	return `${url.origin}/api/executions`;
}

function parseExecutorHttpResult(value: unknown): ExecutorMcpGatewayResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ExecutorHttpGatewayError("response_invalid");
	const response = value as Readonly<Record<string, unknown>>;
	const hasStructured = Object.hasOwn(response, "structured");
	if (response.status === "paused" && typeof response.text === "string" && hasStructured) return Object.freeze({ status: "approval_required" });
	if (response.status === "completed" && typeof response.text === "string" && hasStructured && typeof response.isError === "boolean") {
		return response.isError ? Object.freeze({ status: "failed" }) : Object.freeze({ status: "succeeded" });
	}
	throw new ExecutorHttpGatewayError("response_invalid");
}

interface ExecutorRequestDeadline {
	readonly signal: AbortSignal;
	cancel(): void;
}

function createExecutorRequestDeadline(timeoutSeconds: number): ExecutorRequestDeadline {
	const timeoutMs = timeoutSeconds * 1_000;
	if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutMs > 2_147_483_647) {
		throw new ExecutorHttpGatewayError("request_invalid");
	}
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	return Object.freeze({
		signal: controller.signal,
		cancel: () => clearTimeout(timeout),
	});
}

function awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	const pending = Promise.withResolvers<T>();
	const settle = (callback: () => void) => {
		signal.removeEventListener("abort", rejectOnAbort);
		callback();
	};
	const rejectOnAbort = () => settle(() => pending.reject(new ExecutorHttpGatewayError("transport_timed_out")));
	if (signal.aborted) {
		rejectOnAbort();
		return pending.promise;
	}
	signal.addEventListener("abort", rejectOnAbort, { once: true });
	void operation.then(
		value => {
			settle(() => pending.resolve(value));
		},
		error => {
			settle(() => pending.reject(error));
		},
	);
	return pending.promise;
}

/**
 * Concrete, host-owned bridge to Useful Executor's documented local HTTP
 * execution endpoint. It posts the already-validated canonical code as
 * `{ code }`; task metadata stays in LocalMesh and no request can opt into
 * auto-approval or resume a paused upstream execution.
 */
export class ExecutorHttpCodeGateway implements ExecutorMcpGateway {
	readonly #endpoints: ReadonlyMap<string, RegisteredExecutorHttpEndpoint>;
	readonly #transport: ExecutorHttpTransport;

	constructor(options: ExecutorHttpCodeGatewayOptions) {
		const endpoints = new Map<string, RegisteredExecutorHttpEndpoint>();
		for (const endpoint of options.endpoints) {
			if (
				!isSafeIdentifier(endpoint.endpointId) ||
				endpoints.has(endpoint.endpointId) ||
				(endpoint.authorization !== undefined && endpoint.authorization.trim().length === 0) ||
				(endpoint.authorization?.includes("\n") ?? false) ||
				(endpoint.authorization?.includes("\r") ?? false)
			) {
				throw new ExecutorHttpGatewayError("endpoint_configuration_invalid");
			}
			endpoints.set(
				endpoint.endpointId,
				Object.freeze({
					executionUrl: normalizeExecutorExecutionUrl(endpoint.origin),
					...(endpoint.authorization === undefined ? {} : { authorization: endpoint.authorization }),
				}),
			);
		}
		this.#endpoints = endpoints;
		this.#transport = options.transport ?? new FetchExecutorHttpTransport();
	}

	async invoke(request: ExecutorMcpGatewayRequest): Promise<ExecutorMcpGatewayResult> {
		const endpoint = this.#endpoints.get(request.endpointId);
		if (endpoint === undefined) throw new ExecutorHttpGatewayError("endpoint_not_registered");
		const deadline = createExecutorRequestDeadline(request.timeoutSeconds);
		const headers: Record<string, string> = {
			accept: "application/json",
			"content-type": "application/json",
			...(endpoint.authorization === undefined ? {} : { authorization: endpoint.authorization }),
		};
		try {
			let response: ExecutorHttpTransportResponse;
			try {
				response = await awaitAbortable(
					this.#transport.send(
						Object.freeze({
							method: "POST",
							url: endpoint.executionUrl,
							headers: Object.freeze(headers),
							body: JSON.stringify({ code: request.code }),
							redirect: "error",
							signal: deadline.signal,
						}),
					),
					deadline.signal,
				);
			} catch (error) {
				if (error instanceof ExecutorHttpGatewayError) throw error;
				throw new ExecutorHttpGatewayError("transport_unavailable");
			}

			try {
				if (!response.ok) throw new ExecutorHttpGatewayError("transport_unavailable");
				return parseExecutorHttpResult(await awaitAbortable(response.json(), deadline.signal));
			} catch (error) {
				if (error instanceof ExecutorHttpGatewayError) throw error;
				throw new ExecutorHttpGatewayError("response_invalid");
			}
		} finally {
			deadline.cancel();
		}
	}
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
 * A transport-neutral MeshNodeExecutionPort for Executor's code-execution
 * surface. It accepts a signed data invocation, then constructs one fixed await
 * statement from identifier segments and canonical JSON only.
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
		// A rejected gateway call can follow an accepted POST. It is not evidence of
		// a known remote failure, so the node must reconcile instead of terminally
		// recording failure and releasing its reservation.
		const result = await this.#gateway.invoke(
			Object.freeze({
				endpointId: invocation.endpointId,
				code: invocation.code,
				timeoutSeconds: context.bounds.timeoutSeconds,
				metadata: invocation.metadata,
			}),
		);

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
