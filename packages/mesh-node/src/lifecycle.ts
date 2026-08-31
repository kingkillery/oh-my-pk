import {
	parseAssignmentLease,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type TaskContractV1,
	type TrustZone,
} from "@pk-nerdsaver-ai/mesh-contracts";

import { isNodePresenceFresh, type MeshNodePresence } from "./node-presence";

export type MeshNodeInteractivePolicy = "deny_when_active" | "deny_all" | "allow_explicit";

export type MeshNodeLifecycleState =
	| "admitted"
	| "starting"
	| "started"
	| "running"
	| "cancelling"
	| "cancelled"
	| "completed"
	| "failed"
	| "lost"
	| "cleaned";

export type MeshNodeLifecycleEventType =
	| "assignment.accepted"
	| "assignment.rejected"
	| "execution.started"
	| "execution.start_failed"
	| "execution.running"
	| "execution.completed"
	| "execution.failed"
	| "execution.heartbeat"
	| "execution.heartbeat_rejected"
	| "execution.heartbeat_failed"
	| "execution.cancelled"
	| "execution.cancel_failed"
	| "execution.cleaned"
	| "execution.cleanup_failed";

export type MeshNodeAgentErrorCode =
	| "active_interactive_local"
	| "assignment_already_known"
	| "assignment_state_invalid"
	| "capacity_exhausted"
	| "execution_adapter_failed"
	| "execution_profile_mismatch"
	| "execution_timeout_exceeds_local_max"
	| "execution_timeout_invalid"
	| "forbidden_node"
	| "invalid_contract"
	| "lease_expired"
	| "lease_future_issued"
	| "lease_invalid_binding"
	| "lease_invalid_fencing"
	| "node_capability_missing"
	| "node_draining"
	| "node_health_unavailable"
	| "node_identity_mismatch"
	| "node_presence_future"
	| "node_presence_stale"
	| "task_disallows_active_machine"
	| "trust_zone_incompatible";

/**
 * Deliberately carries only a stable policy code. It is safe to persist in
 * node-local evidence without exposing an untrusted assignment payload.
 */
export class MeshNodeAgentError extends Error {
	readonly code: MeshNodeAgentErrorCode;

	constructor(code: MeshNodeAgentErrorCode) {
		super(code);
		this.name = "MeshNodeAgentError";
		this.code = code;
	}
}

export interface MeshNodeIdentity {
	readonly nodeId: string;
	readonly pubkey: string;
}

export interface MeshExecutionBounds {
	readonly timeoutSeconds: number;
	readonly cpuMax?: number;
	readonly memoryBytesMax?: number;
	readonly diskBytesMax?: number;
	readonly pidMax?: number;
	readonly networkBytesMax?: number;
	readonly retriesMax?: number;
}

export interface MeshNodeExecutionContext {
	readonly assignmentId: string;
	readonly taskId: string;
	readonly taskDigest: string;
	readonly nodeId: string;
	readonly executorPubkey: string;
	readonly schedulerEpoch: number;
	readonly fencingToken: number;
	readonly executionProfileId: string;
	readonly bounds: MeshExecutionBounds;
	readonly task: TaskContractV1;
	readonly assignment: AssignmentLeaseV1;
}

export interface MeshExecutionRunResult {
	readonly outcome: "succeeded" | "failed";
	readonly exitCode?: number;
}

/**
 * The node agent owns admission and lifecycle safety. A later integration
 * layer supplies this port for an OMPK isolation/workspace backend; this
 * package intentionally does not import Docker or coding-agent internals.
 */
export interface MeshNodeExecutionPort {
	start(context: MeshNodeExecutionContext): Promise<void>;
	run(context: MeshNodeExecutionContext): Promise<MeshExecutionRunResult>;
	heartbeat(context: MeshNodeExecutionContext): Promise<void>;
	cancel(context: MeshNodeExecutionContext): Promise<void>;
	cleanup(context: MeshNodeExecutionContext): Promise<void>;
}

export interface MeshNodeAgentOptions {
	readonly identity: MeshNodeIdentity;
	readonly execution: MeshNodeExecutionPort;
	readonly getPresence: () => MeshNodePresence;
	readonly now?: () => number;
	readonly interactivePolicy?: MeshNodeInteractivePolicy;
	readonly defaultTimeoutSeconds?: number;
	readonly maximumTimeoutSeconds?: number;
}

export interface MeshNodeLifecycleRecord {
	readonly sequence: number;
	readonly type: MeshNodeLifecycleEventType;
	readonly occurredAt: string;
	readonly nodeId: string;
	readonly assignmentId?: string;
	readonly taskId?: string;
	readonly schedulerEpoch?: number;
	readonly fencingToken?: number;
	readonly state: MeshNodeLifecycleState;
	readonly code?: MeshNodeAgentErrorCode;
	readonly outcome?: MeshExecutionRunResult["outcome"];
	readonly exitCode?: number;
}

interface AcceptedAssignment {
	readonly task: TaskContractV1;
	readonly assignment: AssignmentLeaseV1;
	readonly bounds: MeshExecutionBounds;
	state: MeshNodeLifecycleState;
	cancelRecord?: MeshNodeLifecycleRecord;
	cancelPromise?: Promise<MeshNodeLifecycleRecord>;
	cleanupRecord?: MeshNodeLifecycleRecord;
	cleanupPromise?: Promise<MeshNodeLifecycleRecord>;
}

const TRUST_ZONE_EXPOSURE: Readonly<Record<TrustZone, number>> = Object.freeze({
	local: 0,
	private: 1,
	partner: 2,
	public: 3,
});

const TERMINAL_STATES = new Set<MeshNodeLifecycleState>(["cancelled", "completed", "failed", "lost", "cleaned"]);
const ACTIVE_STATES = new Set<MeshNodeLifecycleState>(["admitted", "starting", "started", "running", "cancelling"]);

function freezeRecord(record: MeshNodeLifecycleRecord): MeshNodeLifecycleRecord {
	return Object.freeze(record);
}

function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value > 0;
}

function trustZoneSupports(nodeZone: TrustZone, requiredZone: TrustZone | undefined): boolean {
	return requiredZone === undefined || TRUST_ZONE_EXPOSURE[nodeZone] <= TRUST_ZONE_EXPOSURE[requiredZone];
}

/**
 * A local, memory-backed node lifecycle guard. Durable orchestration remains
 * outside this class; the agent only executes currently valid leases and
 * records its own safe, replayable local transition facts.
 */
export class MeshNodeAgent {
	readonly #identity: MeshNodeIdentity;
	readonly #execution: MeshNodeExecutionPort;
	readonly #getPresence: () => MeshNodePresence;
	readonly #now: () => number;
	readonly #interactivePolicy: MeshNodeInteractivePolicy;
	readonly #defaultTimeoutSeconds: number;
	readonly #maximumTimeoutSeconds: number;
	readonly #assignments = new Map<string, AcceptedAssignment>();
	readonly #events: MeshNodeLifecycleRecord[] = [];
	#sequence = 0;

	constructor(options: MeshNodeAgentOptions) {
		if (!options.identity.nodeId || !options.identity.pubkey) throw new Error("A node identity is required.");
		this.#identity = Object.freeze({ ...options.identity });
		this.#execution = options.execution;
		this.#getPresence = options.getPresence;
		this.#now = options.now ?? Date.now;
		this.#interactivePolicy = options.interactivePolicy ?? "deny_when_active";
		this.#defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? 300;
		this.#maximumTimeoutSeconds = options.maximumTimeoutSeconds ?? 3_600;
		if (!isPositiveInteger(this.#defaultTimeoutSeconds) || !isPositiveInteger(this.#maximumTimeoutSeconds) || this.#defaultTimeoutSeconds > this.#maximumTimeoutSeconds) {
			throw new Error("Node execution timeout configuration is invalid.");
		}
	}

	/**
	 * Validates an assignment at the execution boundary and reserves a local
	 * capacity slot. Validation is repeated before start, run, and heartbeat.
	 */
	accept(input: { readonly task: unknown; readonly assignment: unknown }): MeshNodeLifecycleRecord {
		let task: TaskContractV1;
		let assignment: AssignmentLeaseV1;
		try {
			task = parseTaskContract(input.task);
			assignment = parseAssignmentLease(input.assignment);
		} catch {
			return this.#reject("invalid_contract", "admitted");
		}

		if (this.#assignments.has(assignment.assignmentId)) return this.#reject("assignment_already_known", "admitted", task, assignment);

		try {
			const presence = this.#getPresence();
			const bounds = this.#validateAdmission(task, assignment, presence, true);
			const tracked: AcceptedAssignment = { task, assignment, bounds, state: "admitted" };
			this.#assignments.set(assignment.assignmentId, tracked);
			return this.#record("assignment.accepted", tracked);
		} catch (error) {
			return this.#reject(this.#toCode(error), "admitted", task, assignment);
		}
	}

	async start(assignmentId: string): Promise<MeshNodeLifecycleRecord> {
		const tracked = this.#assignmentFor(assignmentId);
		this.#requireState(tracked, "admitted");
		this.#revalidateForOperation(tracked, "execution.start_failed");
		tracked.state = "starting";
		try {
			await this.#execution.start(this.#contextFor(tracked));
			tracked.state = "started";
			return this.#record("execution.started", tracked);
		} catch {
			tracked.state = "failed";
			this.#record("execution.start_failed", tracked, "execution_adapter_failed");
			throw new MeshNodeAgentError("execution_adapter_failed");
		}
	}

	async run(assignmentId: string): Promise<MeshNodeLifecycleRecord> {
		const tracked = this.#assignmentFor(assignmentId);
		this.#requireState(tracked, "started");
		this.#revalidateForOperation(tracked, "execution.failed");
		tracked.state = "running";
		this.#record("execution.running", tracked);
		try {
			const result = await this.#execution.run(this.#contextFor(tracked));
			if (tracked.state === "cancelled") return tracked.cancelRecord ?? this.#record("execution.cancelled", tracked);
			if (tracked.state === "cancelling" && tracked.cancelPromise !== undefined) return tracked.cancelPromise;
			if (result.outcome === "succeeded") {
				tracked.state = "completed";
				return this.#record("execution.completed", tracked, undefined, result);
			}
			tracked.state = "failed";
			return this.#record("execution.failed", tracked, undefined, result);
		} catch {
			if (tracked.state === "cancelled") return tracked.cancelRecord ?? this.#record("execution.cancelled", tracked);
			if (tracked.state === "cancelling" && tracked.cancelPromise !== undefined) return tracked.cancelPromise;
			tracked.state = "failed";
			this.#record("execution.failed", tracked, "execution_adapter_failed");
			throw new MeshNodeAgentError("execution_adapter_failed");
		}
	}

	async heartbeat(assignmentId: string): Promise<MeshNodeLifecycleRecord> {
		const tracked = this.#assignmentFor(assignmentId);
		if (tracked.state !== "started" && tracked.state !== "running") throw new MeshNodeAgentError("assignment_state_invalid");
		this.#revalidateForOperation(tracked, "execution.heartbeat_rejected");
		try {
			await this.#execution.heartbeat(this.#contextFor(tracked));
			return this.#record("execution.heartbeat", tracked);
		} catch {
			tracked.state = "lost";
			this.#record("execution.heartbeat_failed", tracked, "execution_adapter_failed");
			throw new MeshNodeAgentError("execution_adapter_failed");
		}
	}

	cancel(assignmentId: string): Promise<MeshNodeLifecycleRecord> {
		const tracked = this.#assignmentFor(assignmentId);
		if (tracked.cancelRecord !== undefined) return Promise.resolve(tracked.cancelRecord);
		if (tracked.cancelPromise !== undefined) return tracked.cancelPromise;
		if (TERMINAL_STATES.has(tracked.state)) throw new MeshNodeAgentError("assignment_state_invalid");
		const cancellation = this.#cancelAssignment(tracked);
		tracked.cancelPromise = cancellation;
		return cancellation;
	}

	async #cancelAssignment(tracked: AcceptedAssignment): Promise<MeshNodeLifecycleRecord> {
		const started = tracked.state !== "admitted";
		tracked.state = "cancelling";
		try {
			if (started) await this.#execution.cancel(this.#contextFor(tracked));
			tracked.state = "cancelled";
			const record = this.#record("execution.cancelled", tracked);
			tracked.cancelRecord = record;
			return record;
		} catch {
			tracked.state = "lost";
			this.#record("execution.cancel_failed", tracked, "execution_adapter_failed");
			throw new MeshNodeAgentError("execution_adapter_failed");
		}
	}

	cleanup(assignmentId: string): Promise<MeshNodeLifecycleRecord> {
		const tracked = this.#assignmentFor(assignmentId);
		if (tracked.cleanupRecord !== undefined) return Promise.resolve(tracked.cleanupRecord);
		if (tracked.cleanupPromise !== undefined) return tracked.cleanupPromise;
		if (!TERMINAL_STATES.has(tracked.state) || tracked.state === "cleaned") throw new MeshNodeAgentError("assignment_state_invalid");
		const cleanup = this.#cleanupAssignment(tracked);
		tracked.cleanupPromise = cleanup;
		return cleanup;
	}

	async #cleanupAssignment(tracked: AcceptedAssignment): Promise<MeshNodeLifecycleRecord> {
		try {
			await this.#execution.cleanup(this.#contextFor(tracked));
			tracked.state = "cleaned";
			const record = this.#record("execution.cleaned", tracked);
			tracked.cleanupRecord = record;
			return record;
		} catch {
			this.#record("execution.cleanup_failed", tracked, "execution_adapter_failed");
			throw new MeshNodeAgentError("execution_adapter_failed");
		}
	}

	/** Immutable records only; adapters and assignment payloads are never exposed. */
	events(): readonly MeshNodeLifecycleRecord[] {
		return Object.freeze([...this.#events]);
	}

	assignmentEvents(assignmentId: string): readonly MeshNodeLifecycleRecord[] {
		return Object.freeze(this.#events.filter(event => event.assignmentId === assignmentId));
	}

	state(assignmentId: string): MeshNodeLifecycleState | undefined {
		return this.#assignments.get(assignmentId)?.state;
	}

	#assignmentFor(assignmentId: string): AcceptedAssignment {
		const tracked = this.#assignments.get(assignmentId);
		if (tracked === undefined) throw new MeshNodeAgentError("assignment_state_invalid");
		return tracked;
	}

	#requireState(tracked: AcceptedAssignment, expected: MeshNodeLifecycleState): void {
		if (tracked.state !== expected) throw new MeshNodeAgentError("assignment_state_invalid");
	}

	#revalidateForOperation(tracked: AcceptedAssignment, rejectedEvent: MeshNodeLifecycleEventType): void {
		try {
			this.#validateAdmission(tracked.task, tracked.assignment, this.#getPresence(), false);
		} catch (error) {
			tracked.state = "lost";
			this.#record(rejectedEvent, tracked, this.#toCode(error));
			throw new MeshNodeAgentError(this.#toCode(error));
		}
	}

	#validateAdmission(task: TaskContractV1, assignment: AssignmentLeaseV1, presence: MeshNodePresence, reserveCapacity: boolean): MeshExecutionBounds {
		const now = this.#now();
		this.#validateLease(task, assignment, now);
		this.#validatePresence(task, assignment, presence, now, reserveCapacity);
		return this.#executionBounds(task);
	}

	#validateLease(task: TaskContractV1, assignment: AssignmentLeaseV1, now: number): void {
		if (assignment.taskId !== task.taskId || assignment.taskDigest !== task.digest || assignment.permissionsDigest !== sha256CanonicalJson(task.permissions)) {
			throw new MeshNodeAgentError("lease_invalid_binding");
		}
		if (assignment.workerNodeId !== this.#identity.nodeId || assignment.executorPubkey !== this.#identity.pubkey) throw new MeshNodeAgentError("lease_invalid_binding");
		if (!isPositiveInteger(assignment.schedulerEpoch) || !isPositiveInteger(assignment.fencingToken) || !isPositiveInteger(assignment.renewAfterSeconds)) {
			throw new MeshNodeAgentError("lease_invalid_fencing");
		}
		const issuedAt = Date.parse(assignment.issuedAt);
		const expiresAt = Date.parse(assignment.leaseExpiresAt);
		if (!Number.isFinite(issuedAt) || issuedAt > now) throw new MeshNodeAgentError("lease_future_issued");
		if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new MeshNodeAgentError("lease_expired");
	}

	#validatePresence(task: TaskContractV1, assignment: AssignmentLeaseV1, presence: MeshNodePresence, now: number, reserveCapacity: boolean): void {
		if (presence.nodeId !== this.#identity.nodeId || presence.actorPubkey !== this.#identity.pubkey) throw new MeshNodeAgentError("node_identity_mismatch");
		if (Date.parse(presence.observedAt) > now) throw new MeshNodeAgentError("node_presence_future");
		if (!isNodePresenceFresh(presence, now)) throw new MeshNodeAgentError("node_presence_stale");
		if (presence.draining) throw new MeshNodeAgentError("node_draining");
		if (presence.health !== "healthy") throw new MeshNodeAgentError("node_health_unavailable");
		if (!presence.executionProfiles.includes(assignment.executionProfileId)) throw new MeshNodeAgentError("execution_profile_mismatch");
		if (task.execution.profileId !== undefined && task.execution.profileId !== assignment.executionProfileId) throw new MeshNodeAgentError("execution_profile_mismatch");
		if (task.routing.forbiddenNodes?.includes(this.#identity.nodeId)) throw new MeshNodeAgentError("forbidden_node");
		if (!trustZoneSupports(presence.trustZone, task.routing.trustZoneMin)) throw new MeshNodeAgentError("trust_zone_incompatible");
		for (const capability of task.routing.requiredCapabilities ?? []) if (!presence.capabilities.includes(capability)) throw new MeshNodeAgentError("node_capability_missing");
		this.#validateInteractivePolicy(task, presence);
		if (reserveCapacity && (presence.capacity.availableSlots < 1 || this.#activeAssignmentCount() >= presence.capacity.availableSlots)) {
			throw new MeshNodeAgentError("capacity_exhausted");
		}
	}

	#validateInteractivePolicy(task: TaskContractV1, presence: MeshNodePresence): void {
		if (presence.interactive && this.#interactivePolicy === "deny_all") throw new MeshNodeAgentError("active_interactive_local");
		if (!presence.activeInteractiveUser) return;
		if (task.routing.activeMachineAllowed !== true) throw new MeshNodeAgentError("task_disallows_active_machine");
		if (this.#interactivePolicy !== "allow_explicit") throw new MeshNodeAgentError("active_interactive_local");
	}

	#executionBounds(task: TaskContractV1): MeshExecutionBounds {
		const requestedTimeout = task.execution.timeoutSeconds;
		if (requestedTimeout !== undefined && !isPositiveInteger(requestedTimeout)) throw new MeshNodeAgentError("execution_timeout_invalid");
		const timeoutSeconds = requestedTimeout ?? this.#defaultTimeoutSeconds;
		if (timeoutSeconds > this.#maximumTimeoutSeconds) throw new MeshNodeAgentError("execution_timeout_exceeds_local_max");

		const bounds: { -readonly [Key in keyof MeshExecutionBounds]: MeshExecutionBounds[Key] } = { timeoutSeconds };
		for (const field of ["cpuMax", "memoryBytesMax", "diskBytesMax", "pidMax", "networkBytesMax", "retriesMax"] as const) {
			const value = task.execution[field];
			if (value === undefined) continue;
			if (!Number.isFinite(value) || value < 0) throw new MeshNodeAgentError("execution_timeout_invalid");
			bounds[field] = value;
		}
		return Object.freeze(bounds);
	}

	#activeAssignmentCount(): number {
		let count = 0;
		for (const tracked of this.#assignments.values()) if (ACTIVE_STATES.has(tracked.state)) count += 1;
		return count;
	}

	#contextFor(tracked: AcceptedAssignment): MeshNodeExecutionContext {
		const { assignment, bounds, task } = tracked;
		return Object.freeze({
			assignmentId: assignment.assignmentId,
			taskId: task.taskId,
			taskDigest: task.digest,
			nodeId: this.#identity.nodeId,
			executorPubkey: this.#identity.pubkey,
			schedulerEpoch: assignment.schedulerEpoch,
			fencingToken: assignment.fencingToken,
			executionProfileId: assignment.executionProfileId,
			bounds,
			task,
			assignment,
		});
	}

	#record(type: MeshNodeLifecycleEventType, tracked?: AcceptedAssignment, code?: MeshNodeAgentErrorCode, result?: MeshExecutionRunResult): MeshNodeLifecycleRecord {
		const event: MeshNodeLifecycleRecord = {
			sequence: this.#sequence,
			type,
			occurredAt: new Date(this.#now()).toISOString(),
			nodeId: this.#identity.nodeId,
			state: tracked?.state ?? "admitted",
		};
		this.#sequence += 1;
		if (tracked !== undefined) {
			Object.assign(event, {
				assignmentId: tracked.assignment.assignmentId,
				taskId: tracked.task.taskId,
				schedulerEpoch: tracked.assignment.schedulerEpoch,
				fencingToken: tracked.assignment.fencingToken,
			});
		}
		if (code !== undefined) Object.assign(event, { code });
		if (result !== undefined) {
			Object.assign(event, { outcome: result.outcome });
			if (Number.isInteger(result.exitCode) && result.exitCode >= 0) Object.assign(event, { exitCode: result.exitCode });
		}
		const frozen = freezeRecord(event);
		this.#events.push(frozen);
		return frozen;
	}

	#reject(code: MeshNodeAgentErrorCode, state: MeshNodeLifecycleState, task?: TaskContractV1, assignment?: AssignmentLeaseV1): never {
		const tracked = task !== undefined && assignment !== undefined ? { task, assignment, bounds: Object.freeze({ timeoutSeconds: this.#defaultTimeoutSeconds }), state } : undefined;
		this.#record("assignment.rejected", tracked, code);
		throw new MeshNodeAgentError(code);
	}

	#toCode(error: unknown): MeshNodeAgentErrorCode {
		return error instanceof MeshNodeAgentError ? error.code : "invalid_contract";
	}
}
