import {
	MESH_SCHEMA,
	parseAssignmentLease,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type TaskContractV1,
	type TrustZone,
} from "@pk-nerdsaver-ai/mesh-contracts";
import {
	parseSignedMeshEnvelope,
	verifySignedAssignmentLease,
	type MeshEnvelopeVerifier,
	type SignedMeshEnvelopeV1,
} from "@pk-nerdsaver-ai/mesh-auth";

import { isNodePresenceFresh, type MeshNodePresence } from "./node-presence";
import {
	InMemoryMeshNodeStateRepository,
	type MeshNodeDurableAssignment,
	type MeshNodeStateRepository,
	type MeshNodeStateSnapshot,
	type MeshNodeTerminalOutboxMessage,
	type MeshNodeTerminalOutboxPublication,
} from "./node-state";

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
	| "reconciliation_required"
	| "cleaning"
	| "cleaned";

export type MeshNodeLifecycleEventType =
	| "assignment.accepted"
	| "assignment.rejected"
	| "execution.starting"
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
	| "execution.cancelling"
	| "execution.cleaning"
	| "execution.cleaned"
	| "execution.cleanup_failed"
	| "execution.reconciliation_required"
	| "execution.reconciliation_resolved_as_lost";

export type MeshNodeAgentErrorCode =
	| "active_interactive_local"
	| "assignment_already_known"
	| "assignment_reconciliation_required"
	| "assignment_signature_unverified"
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
	| "lease_insufficient_for_execution"
	| "lease_invalid_binding"
	| "lease_invalid_fencing"
	| "node_capability_missing"
	| "node_draining"
	| "node_health_unavailable"
	| "node_identity_mismatch"
	| "node_presence_future"
	| "node_presence_stale"
	| "node_state_conflict"
	| "node_state_corrupt"
	| "node_state_identity_mismatch"
	| "node_state_unavailable"
	| "scheduler_verifier_unavailable"
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

/**
 * A caller-provided delivery boundary for committed node-local terminal facts.
 * It receives no controller authority, receipt material, or delivery state.
 */
export interface MeshNodeTerminalOutboxPublisher {
	publish(message: Readonly<MeshNodeTerminalOutboxPublication>): Promise<void>;
}

export interface MeshNodeTerminalOutboxDrainOptions {
	/** Maximum facts to attempt in this explicit drain. Defaults to all eligible facts. */
	readonly maxMessages?: number;
}

export interface MeshNodeTerminalOutboxDrainResult {
	/** Facts durably marked delivered after their publisher resolved. */
	readonly delivered: readonly string[];
	/** Facts whose publisher rejected and therefore remain pending. */
	readonly failed: readonly string[];
}

export interface MeshNodeAgentOptions {
	readonly identity: MeshNodeIdentity;
	readonly execution: MeshNodeExecutionPort;
	/** A node-owned scheduler allow-list. Assignment envelope metadata only selects within this fixed set. */
	readonly trustedSchedulerVerifiers: readonly MeshEnvelopeVerifier[];
	readonly getPresence: () => MeshNodePresence;
	readonly now?: () => number;
	readonly interactivePolicy?: MeshNodeInteractivePolicy;
	readonly defaultTimeoutSeconds?: number;
	readonly maximumTimeoutSeconds?: number;
	/** Defaults to memory for tests only; production nodes inject a durable local repository. */
	readonly stateRepository?: MeshNodeStateRepository;
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
	/** Retained so a durable restart can cryptographically re-establish admission. */
	readonly signedAssignment: SignedMeshEnvelopeV1<AssignmentLeaseV1>;
	/** The verified signed-envelope digest, used only for idempotent redelivery. */
	readonly assignmentPayloadDigest: string;
	readonly bounds: MeshExecutionBounds;
	state: MeshNodeLifecycleState;
	admissionRecord?: MeshNodeLifecycleRecord;
	cancelRecord?: MeshNodeLifecycleRecord;
	cancelPromise?: Promise<MeshNodeLifecycleRecord>;
	cleanupRecord?: MeshNodeLifecycleRecord;
	cleanupPromise?: Promise<MeshNodeLifecycleRecord>;
	terminalRecord?: MeshNodeLifecycleRecord;
	cleanupOriginState?: MeshNodeLifecycleState;
}

type LifecycleRecordAssignment = Pick<AcceptedAssignment, "assignment" | "state" | "task">;

interface VerifiedAssignmentDelivery {
	readonly assignment: AssignmentLeaseV1;
	readonly payloadDigest: string;
	readonly signedAssignment: SignedMeshEnvelopeV1<AssignmentLeaseV1>;
}

const TRUST_ZONE_EXPOSURE: Readonly<Record<TrustZone, number>> = Object.freeze({
	local: 0,
	private: 1,
	partner: 2,
	public: 3,
});

const TERMINAL_STATES = new Set<MeshNodeLifecycleState>(["cancelled", "completed", "failed", "lost", "cleaned"]);
const CLEANUP_ELIGIBLE_STATES = new Set<MeshNodeLifecycleState>(["cancelled", "completed", "failed", "lost"]);
const ACTIVE_STATES = new Set<MeshNodeLifecycleState>(["admitted", "starting", "started", "running", "cancelling", "cleaning", "reconciliation_required"]);
const RECOVERY_STATES = new Set<MeshNodeLifecycleState>(["starting", "started", "running", "cancelling", "cleaning"]);

function freezeRecord(record: MeshNodeLifecycleRecord): MeshNodeLifecycleRecord {
	return Object.freeze(record);
}

function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownState(value: unknown): value is MeshNodeLifecycleState {
	return (
		value === "admitted" ||
		value === "starting" ||
		value === "started" ||
		value === "running" ||
		value === "cancelling" ||
		value === "cancelled" ||
		value === "completed" ||
		value === "failed" ||
		value === "lost" ||
		value === "reconciliation_required" ||
		value === "cleaning" ||
		value === "cleaned"
	);
}

function isKnownOutboxState(value: unknown): value is MeshNodeTerminalOutboxMessage["state"] {
	return value === "pending" || value === "delivered";
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameLifecycleRecord(left: MeshNodeLifecycleRecord, right: MeshNodeLifecycleRecord): boolean {
	return (
		left.sequence === right.sequence &&
		left.type === right.type &&
		left.occurredAt === right.occurredAt &&
		left.nodeId === right.nodeId &&
		left.assignmentId === right.assignmentId &&
		left.taskId === right.taskId &&
		left.schedulerEpoch === right.schedulerEpoch &&
		left.fencingToken === right.fencingToken &&
		left.state === right.state &&
		left.code === right.code &&
		left.outcome === right.outcome &&
		left.exitCode === right.exitCode
	);
}

function isTerminalLifecycleRecord(record: MeshNodeLifecycleRecord): boolean {
	return (
		(record.type === "execution.cancelled" && record.state === "cancelled") ||
		(record.type === "execution.completed" && record.state === "completed") ||
		(record.type === "execution.failed" && record.state === "failed") ||
		(record.type === "execution.reconciliation_resolved_as_lost" && record.state === "lost")
	);
}

function isKnownEventType(value: unknown): value is MeshNodeLifecycleEventType {
	return (
		value === "assignment.accepted" ||
		value === "assignment.rejected" ||
		value === "execution.starting" ||
		value === "execution.started" ||
		value === "execution.start_failed" ||
		value === "execution.running" ||
		value === "execution.completed" ||
		value === "execution.failed" ||
		value === "execution.heartbeat" ||
		value === "execution.heartbeat_rejected" ||
		value === "execution.heartbeat_failed" ||
		value === "execution.cancelled" ||
		value === "execution.cancel_failed" ||
		value === "execution.cancelling" ||
		value === "execution.cleaning" ||
		value === "execution.cleaned" ||
		value === "execution.cleanup_failed" ||
		value === "execution.reconciliation_required" ||
		value === "execution.reconciliation_resolved_as_lost"
	);
}

function trustZoneSupports(nodeZone: TrustZone, requiredZone: TrustZone | undefined): boolean {
	return requiredZone === undefined || TRUST_ZONE_EXPOSURE[nodeZone] <= TRUST_ZONE_EXPOSURE[requiredZone];
}

/**
 * A local node lifecycle guard with an injected state boundary. Controller
 * orchestration remains separate; this agent persists its own safe local
 * transition facts before execution-port calls and never replays uncertainty.
 */
export class MeshNodeAgent {
	readonly #identity: MeshNodeIdentity;
	readonly #execution: MeshNodeExecutionPort;
	readonly #trustedSchedulerVerifiers: readonly MeshEnvelopeVerifier[];
	readonly #getPresence: () => MeshNodePresence;
	readonly #now: () => number;
	readonly #interactivePolicy: MeshNodeInteractivePolicy;
	readonly #defaultTimeoutSeconds: number;
	readonly #maximumTimeoutSeconds: number;
	readonly #assignments = new Map<string, AcceptedAssignment>();
	readonly #events: MeshNodeLifecycleRecord[] = [];
	readonly #outbox = new Map<string, MeshNodeTerminalOutboxMessage>();
	/** Prevents two drain calls in this node process from publishing one fact twice. */
	readonly #drainingOutbox = new Set<string>();
	/**
	 * A write failure after an execution-port boundary cannot be safely retried
	 * in this process. The durable snapshot will recover conservatively on a
	 * restart; this local guard closes the live-process gap if that recovery
	 * fact could not itself be committed.
	 */
	readonly #volatileReconciliation = new Set<string>();
	#stateRepository: MeshNodeStateRepository;
	#sequence = 0;
	#revision = 0;

	constructor(options: MeshNodeAgentOptions) {
		if (options.stateRepository !== undefined) {
			throw new Error("Use await MeshNodeAgent.create(options) when a durable node state repository is configured.");
		}
		if (!options.identity.nodeId || !options.identity.pubkey) throw new Error("A node identity is required.");
		this.#identity = Object.freeze({ ...options.identity });
		this.#execution = options.execution;
		this.#trustedSchedulerVerifiers = Object.freeze(options.trustedSchedulerVerifiers.map(verifier => Object.freeze({ ...verifier })));
		this.#getPresence = options.getPresence;
		this.#now = options.now ?? Date.now;
		this.#interactivePolicy = options.interactivePolicy ?? "deny_when_active";
		this.#defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? 300;
		this.#maximumTimeoutSeconds = options.maximumTimeoutSeconds ?? 3_600;
		if (!isPositiveInteger(this.#defaultTimeoutSeconds) || !isPositiveInteger(this.#maximumTimeoutSeconds) || this.#defaultTimeoutSeconds > this.#maximumTimeoutSeconds) {
			throw new Error("Node execution timeout configuration is invalid.");
		}
		this.#stateRepository = new InMemoryMeshNodeStateRepository();
		const stored = this.#stateRepository.read(snapshot => snapshot);
		this.#restoreTrusted(stored);
		if (stored.identity === undefined) this.#mutate(() => undefined);
	}

	/**
	 * Durable state may contain a signed assignment from an earlier process, so
	 * its fixed local verifier allow-list is re-applied before it becomes live.
	 */
	static async create(options: MeshNodeAgentOptions): Promise<MeshNodeAgent> {
		if (options.stateRepository === undefined) return new MeshNodeAgent(options);
		const agent = new MeshNodeAgent({ ...options, stateRepository: undefined });
		agent.#stateRepository = options.stateRepository;
		await agent.#initializeDurableState();
		return agent;
	}

	/**
	 * Validates an assignment at the execution boundary and reserves a local
	 * capacity slot. Validation is repeated before start, run, and heartbeat.
	 */
	async accept(input: { readonly task: unknown; readonly signedAssignment: unknown }): Promise<MeshNodeLifecycleRecord> {
		let task: TaskContractV1;
		try {
			task = parseTaskContract(input.task);
		} catch {
			return this.#reject("invalid_contract", "admitted");
		}
		let verifiedAssignment: VerifiedAssignmentDelivery;
		try {
			verifiedAssignment = await this.#verifySignedAssignment(input.signedAssignment);
		} catch (error) {
			return this.#reject(this.#toCode(error), "admitted", task);
		}
		const { assignment } = verifiedAssignment;

		const existing = this.#assignments.get(assignment.assignmentId);
		if (existing !== undefined) {
			if (existing.assignmentPayloadDigest === verifiedAssignment.payloadDigest && existing.admissionRecord !== undefined) {
				if (task.taskId === existing.task.taskId && task.digest === existing.task.digest) return existing.admissionRecord;
				return this.#reject("lease_invalid_binding", "admitted", task, assignment);
			}
			return this.#reject("assignment_already_known", "admitted", task, assignment);
		}

		try {
			const presence = this.#getPresence();
			const bounds = this.#validateAdmission(task, assignment, presence, true, true);
			const tracked: AcceptedAssignment = {
				task,
				assignment,
				signedAssignment: verifiedAssignment.signedAssignment,
				assignmentPayloadDigest: verifiedAssignment.payloadDigest,
				bounds,
				state: "admitted",
			};
			return this.#mutate(() => {
				this.#assignments.set(assignment.assignmentId, tracked);
				const admission = this.#appendRecord("assignment.accepted", tracked);
				tracked.admissionRecord = admission;
				return admission;
			});
		} catch (error) {
			return this.#reject(this.#toCode(error), "admitted", task, assignment);
		}
	}

	async start(assignmentId: string): Promise<MeshNodeLifecycleRecord> {
		const tracked = this.#assignmentFor(assignmentId);
		this.#requireState(tracked, "admitted");
		this.#revalidateForOperation(tracked, "execution.start_failed", true);
		this.#transition(tracked, "starting", "execution.starting");
		try {
			await this.#execution.start(this.#contextFor(tracked));
		} catch {
			return this.#reconcileAfterPort(assignmentId, "execution.start_failed", "execution_adapter_failed", "execution_adapter_failed");
		}
		const current = this.#assignmentFor(assignmentId);
		if (current.state === "cancelled") {
			if (current.cancelRecord === undefined) throw new MeshNodeAgentError("node_state_corrupt");
			return current.cancelRecord;
		}
		if (current.state === "cancelling" && current.cancelPromise !== undefined) return current.cancelPromise;
		this.#revalidateAfterPort(current, "execution.start_failed", true);
		this.#requireNotReconciliation(current);
		try {
			return this.#transition(current, "started", "execution.started");
		} catch {
			return this.#reconcileAfterPort(assignmentId, "execution.reconciliation_required", "node_state_unavailable");
		}
	}

	async run(assignmentId: string): Promise<MeshNodeLifecycleRecord> {
		const tracked = this.#assignmentFor(assignmentId);
		this.#requireState(tracked, "started");
		this.#revalidateForOperation(tracked, "execution.failed", true);
		this.#transition(tracked, "running", "execution.running");
		let result: MeshExecutionRunResult;
		try {
			result = await this.#execution.run(this.#contextFor(tracked));
		} catch {
			return this.#reconcileAfterPort(assignmentId, "execution.failed", "execution_adapter_failed", "execution_adapter_failed");
		}
		const current = this.#assignmentFor(assignmentId);
		if (current.state === "cancelled") {
			if (current.cancelRecord === undefined) throw new MeshNodeAgentError("node_state_corrupt");
			return current.cancelRecord;
		}
		if (current.state === "cancelling" && current.cancelPromise !== undefined) return current.cancelPromise;
		this.#revalidateAfterPort(current, "execution.failed");
		this.#requireNotReconciliation(current);
		try {
			if (result.outcome === "succeeded") {
				return this.#terminal(current, "completed", "execution.completed", undefined, result);
			}
			return this.#terminal(current, "failed", "execution.failed", undefined, result);
		} catch {
			return this.#reconcileAfterPort(assignmentId, "execution.reconciliation_required", "node_state_unavailable");
		}
	}

	async heartbeat(assignmentId: string): Promise<MeshNodeLifecycleRecord> {
		const tracked = this.#assignmentFor(assignmentId);
		this.#requireNotReconciliation(tracked);
		if (tracked.state !== "started" && tracked.state !== "running") throw new MeshNodeAgentError("assignment_state_invalid");
		this.#revalidateForOperation(tracked, "execution.heartbeat_rejected");
		try {
			await this.#execution.heartbeat(this.#contextFor(tracked));
		} catch {
			return this.#reconcileAfterPort(assignmentId, "execution.heartbeat_failed", "execution_adapter_failed", "execution_adapter_failed");
		}
		const current = this.#assignmentFor(assignmentId);
		if (current.state === "started" || current.state === "running") {
			this.#requireNotReconciliation(current);
			try {
				return this.#record("execution.heartbeat", current);
			} catch {
				return this.#reconcileAfterPort(assignmentId, "execution.reconciliation_required", "node_state_unavailable");
			}
		}
		if (current.terminalRecord !== undefined) return current.terminalRecord;
		if (current.state === "cancelling" && current.cancelPromise !== undefined) return current.cancelPromise;
		throw new MeshNodeAgentError("assignment_reconciliation_required");
		}

	cancel(assignmentId: string): Promise<MeshNodeLifecycleRecord> {
		const tracked = this.#assignmentFor(assignmentId);
		this.#requireNotReconciliation(tracked);
		if (tracked.cancelRecord !== undefined) return Promise.resolve(tracked.cancelRecord);
		if (tracked.cancelPromise !== undefined) return tracked.cancelPromise;
		if (TERMINAL_STATES.has(tracked.state)) throw new MeshNodeAgentError("assignment_state_invalid");
		const cancellation = this.#cancelAssignment(tracked);
		tracked.cancelPromise = cancellation;
		return cancellation;
	}

	async #cancelAssignment(tracked: AcceptedAssignment): Promise<MeshNodeLifecycleRecord> {
		const started = tracked.state !== "admitted";
		this.#transition(tracked, "cancelling", "execution.cancelling");
		try {
			if (started) await this.#execution.cancel(this.#contextFor(tracked));
		} catch {
			return this.#reconcileAfterPort(tracked.assignment.assignmentId, "execution.cancel_failed", "execution_adapter_failed", "execution_adapter_failed");
		}
		let current: AcceptedAssignment;
		try {
			current = this.#assignmentFor(tracked.assignment.assignmentId);
			this.#requireNotReconciliation(current);
		} catch {
			return this.#reconcileAfterPort(tracked.assignment.assignmentId, "execution.reconciliation_required", "node_state_unavailable");
		}
		try {
			const record = this.#terminal(current, "cancelled", "execution.cancelled");
			current.cancelRecord = record;
			return record;
		} catch {
			return this.#reconcileAfterPort(tracked.assignment.assignmentId, "execution.reconciliation_required", "node_state_unavailable");
		}
	}

	cleanup(assignmentId: string): Promise<MeshNodeLifecycleRecord> {
		const tracked = this.#assignmentFor(assignmentId);
		this.#requireNotReconciliation(tracked);
		if (tracked.cleanupRecord !== undefined) return Promise.resolve(tracked.cleanupRecord);
		if (tracked.cleanupPromise !== undefined) return tracked.cleanupPromise;
		if (!CLEANUP_ELIGIBLE_STATES.has(tracked.state)) throw new MeshNodeAgentError("assignment_state_invalid");
		const cleanup = this.#cleanupAssignment(tracked);
		tracked.cleanupPromise = cleanup;
		return cleanup;
	}

	async #cleanupAssignment(tracked: AcceptedAssignment): Promise<MeshNodeLifecycleRecord> {
		this.#mutate(() => {
			tracked.cleanupOriginState = tracked.state;
			tracked.state = "cleaning";
			this.#appendRecord("execution.cleaning", tracked);
		});
		try {
			await this.#execution.cleanup(this.#contextFor(tracked));
		} catch {
			return this.#reconcileAfterPort(tracked.assignment.assignmentId, "execution.cleanup_failed", "execution_adapter_failed", "execution_adapter_failed");
		}
		let current: AcceptedAssignment;
		try {
			current = this.#assignmentFor(tracked.assignment.assignmentId);
			this.#requireNotReconciliation(current);
		} catch {
			return this.#reconcileAfterPort(tracked.assignment.assignmentId, "execution.reconciliation_required", "node_state_unavailable");
		}
		try {
			const record = this.#mutate(() => {
				current.cleanupOriginState = undefined;
				current.state = "cleaned";
				return this.#appendRecord("execution.cleaned", current);
			});
			current.cleanupRecord = record;
			return record;
		} catch {
			return this.#reconcileAfterPort(tracked.assignment.assignmentId, "execution.reconciliation_required", "node_state_unavailable");
		}
	}

	/**
	 * Local-operator-only escape hatch for work whose external outcome cannot
	 * be proven after an interruption. It never calls the execution port and
	 * does not create a worker receipt or controller completion decision.
	 *
	 * The composition root must expose this only behind local operator
	 * authentication after the workload has been stopped/contained, or after
	 * the operator consciously accepts that it is detached from this node.
	 */
	resolveReconciliationAsLost(assignmentId: string): MeshNodeLifecycleRecord {
		const tracked = this.#assignmentFor(assignmentId);
		if (tracked.state === "lost" && tracked.terminalRecord?.type === "execution.reconciliation_resolved_as_lost") {
			return tracked.terminalRecord;
		}
		if (!this.#isReconciliationRequired(tracked)) throw new MeshNodeAgentError("assignment_state_invalid");
		try {
			const record = this.#terminal(
				tracked,
				"lost",
				"execution.reconciliation_resolved_as_lost",
				"assignment_reconciliation_required",
				undefined,
				true,
			);
			this.#volatileReconciliation.delete(assignmentId);
			return record;
		} catch (error) {
			this.#volatileReconciliation.add(assignmentId);
			if (error instanceof MeshNodeAgentError) throw error;
			throw new MeshNodeAgentError("node_state_unavailable");
		}
	}

	/** Immutable records only; adapters and assignment payloads are never exposed. */
	events(): readonly MeshNodeLifecycleRecord[] {
		return Object.freeze([...this.#events]);
	}

	assignmentEvents(assignmentId: string): readonly MeshNodeLifecycleRecord[] {
		return Object.freeze(this.#events.filter(event => event.assignmentId === assignmentId));
	}

	/** Auditable node-local terminal facts and their local delivery state. */
	outbox(): readonly MeshNodeTerminalOutboxMessage[] {
		return Object.freeze([...this.#outbox.values()].map(message => this.#publicOutboxMessage(message)));
	}

	/**
	 * Explicitly delivers already-committed node-local terminal facts. This does
	 * not execute work, sign a receipt, or change controller state.
	 */
	async drainTerminalOutbox(
		publisher: MeshNodeTerminalOutboxPublisher,
		options: MeshNodeTerminalOutboxDrainOptions = {},
	): Promise<MeshNodeTerminalOutboxDrainResult> {
		if (publisher === null || typeof publisher !== "object" || typeof publisher.publish !== "function") {
			throw new TypeError("A terminal outbox publisher is required.");
		}
		const maxMessages = options.maxMessages ?? Number.POSITIVE_INFINITY;
		if (maxMessages !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxMessages) || maxMessages < 0)) {
			throw new TypeError("Terminal outbox maxMessages must be a non-negative safe integer.");
		}
		const delivered: string[] = [];
		const failed: string[] = [];
		const attempted = new Set<string>();
		while (delivered.length + failed.length < maxMessages) {
			const message = this.#nextPendingTerminalOutbox(attempted);
			if (message === undefined) break;
			attempted.add(message.outboxId);
			this.#drainingOutbox.add(message.outboxId);
			try {
				try {
					await publisher.publish(this.#publicationFor(message));
				} catch {
					failed.push(message.outboxId);
					continue;
				}
				this.#markTerminalOutboxDelivered(message.outboxId);
				delivered.push(message.outboxId);
			} finally {
				this.#drainingOutbox.delete(message.outboxId);
			}
		}
		return Object.freeze({ delivered: Object.freeze(delivered), failed: Object.freeze(failed) });
	}

	state(assignmentId: string): MeshNodeLifecycleState | undefined {
		const tracked = this.#assignments.get(assignmentId);
		if (tracked === undefined) return undefined;
		return this.#isReconciliationRequired(tracked) ? "reconciliation_required" : tracked.state;
	}

	#assignmentFor(assignmentId: string): AcceptedAssignment {
		const tracked = this.#assignments.get(assignmentId);
		if (tracked === undefined) throw new MeshNodeAgentError("assignment_state_invalid");
		return tracked;
	}

	async #verifySignedAssignment(input: unknown): Promise<VerifiedAssignmentDelivery> {
		let candidate: AssignmentLeaseV1;
		let candidateSignature: { readonly algorithm: string; readonly keyId: string };
		try {
			const envelope = parseSignedMeshEnvelope(input);
			if (envelope.payload.schemaVersion !== MESH_SCHEMA.assignment) throw new MeshNodeAgentError("assignment_signature_unverified");
			candidate = envelope.payload;
			candidateSignature = envelope.signature;
		} catch {
			throw new MeshNodeAgentError("assignment_signature_unverified");
		}

		const verifiers = this.#trustedSchedulerVerifiers.filter(
			verifier =>
				verifier.actorPubkey === candidate.scheduler.pubkey &&
				verifier.role === "scheduler" &&
				verifier.algorithm === candidateSignature.algorithm &&
				verifier.keyId === candidateSignature.keyId,
		);
		if (verifiers.length !== 1) throw new MeshNodeAgentError("scheduler_verifier_unavailable");
		const verifier = verifiers[0];

		const verified = await verifySignedAssignmentLease(input, verifier);
		if (!verified.ok) throw new MeshNodeAgentError("assignment_signature_unverified");
		return Object.freeze({
			assignment: verified.payload,
			payloadDigest: verified.envelope.payloadDigest,
			signedAssignment: verified.envelope,
		});
	}

	#requireState(tracked: AcceptedAssignment, expected: MeshNodeLifecycleState): void {
		this.#requireNotReconciliation(tracked);
		if (tracked.state !== expected) throw new MeshNodeAgentError("assignment_state_invalid");
	}

	#requireNotReconciliation(tracked: AcceptedAssignment): void {
		if (this.#isReconciliationRequired(tracked)) throw new MeshNodeAgentError("assignment_reconciliation_required");
	}

	#isReconciliationRequired(tracked: AcceptedAssignment): boolean {
		return tracked.state === "reconciliation_required" || this.#volatileReconciliation.has(tracked.assignment.assignmentId);
	}

	/** Never mutate an assignment object that a failed transaction may have replaced. */
	#requireCurrentAssignment(tracked: AcceptedAssignment, allowReconciliation = false): AcceptedAssignment {
		const current = this.#assignmentFor(tracked.assignment.assignmentId);
		if (current !== tracked) throw new MeshNodeAgentError("assignment_reconciliation_required");
		if (!allowReconciliation) this.#requireNotReconciliation(current);
		return current;
	}

	#revalidateForOperation(tracked: AcceptedAssignment, rejectedEvent: MeshNodeLifecycleEventType, requireFullExecutionWindow = false): void {
		try {
			this.#validateAdmission(tracked.task, tracked.assignment, this.#getPresence(), false, requireFullExecutionWindow);
		} catch (error) {
			this.#markReconciliation(tracked, rejectedEvent, this.#toCode(error));
			throw new MeshNodeAgentError(this.#toCode(error));
		}
	}

	/**
	 * A port may have launched work before its promise settles. If the deadline
	 * or local admission conditions changed while it was awaited, quarantine the
	 * ticket rather than emitting a success or releasing the reservation.
	 */
	#revalidateAfterPort(tracked: AcceptedAssignment, rejectedEvent: MeshNodeLifecycleEventType, requireFullExecutionWindow = false): void {
		try {
			this.#validateAdmission(tracked.task, tracked.assignment, this.#getPresence(), false, requireFullExecutionWindow);
		} catch (error) {
			const code = this.#toCode(error);
			return this.#reconcileAfterPort(tracked.assignment.assignmentId, rejectedEvent, code, code);
		}
	}

	#validateAdmission(
		task: TaskContractV1,
		assignment: AssignmentLeaseV1,
		presence: MeshNodePresence,
		reserveCapacity: boolean,
		requireFullExecutionWindow: boolean,
	): MeshExecutionBounds {
		const now = this.#now();
		const bounds = this.#executionBounds(task);
		this.#validateLease(task, assignment, now, bounds, requireFullExecutionWindow);
		this.#validatePresence(task, assignment, presence, now, reserveCapacity);
		return bounds;
	}

	#validateLease(task: TaskContractV1, assignment: AssignmentLeaseV1, now: number, bounds: MeshExecutionBounds, requireFullExecutionWindow: boolean): void {
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
		if (requireFullExecutionWindow && expiresAt - now <= bounds.timeoutSeconds * 1_000) {
			throw new MeshNodeAgentError("lease_insufficient_for_execution");
		}
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

	#record(
		type: MeshNodeLifecycleEventType,
		tracked?: LifecycleRecordAssignment,
		code?: MeshNodeAgentErrorCode,
		result?: MeshExecutionRunResult,
	): MeshNodeLifecycleRecord {
		return this.#mutate(() => this.#appendRecord(type, tracked, code, result));
	}

	#appendRecord(
		type: MeshNodeLifecycleEventType,
		tracked?: LifecycleRecordAssignment,
		code?: MeshNodeAgentErrorCode,
		result?: MeshExecutionRunResult,
	): MeshNodeLifecycleRecord {
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

	#transition(tracked: AcceptedAssignment, state: MeshNodeLifecycleState, type: MeshNodeLifecycleEventType): MeshNodeLifecycleRecord {
		const current = this.#requireCurrentAssignment(tracked);
		return this.#mutate(() => {
			current.state = state;
			return this.#appendRecord(type, current);
		});
	}

	#terminal(
		tracked: AcceptedAssignment,
		state: Extract<MeshNodeLifecycleState, "cancelled" | "completed" | "failed" | "lost">,
		type: MeshNodeLifecycleEventType,
		code?: MeshNodeAgentErrorCode,
		result?: MeshExecutionRunResult,
		allowReconciliation = false,
	): MeshNodeLifecycleRecord {
		const current = this.#requireCurrentAssignment(tracked, allowReconciliation);
		if (current.terminalRecord !== undefined) return current.terminalRecord;
		return this.#mutate(() => {
			current.state = state;
			const record = this.#appendRecord(type, current, code, result);
			current.terminalRecord = record;
			this.#queueTerminalOutbox(current, record);
			return record;
		});
	}

	#queueTerminalOutbox(tracked: AcceptedAssignment, record: MeshNodeLifecycleRecord): void {
		const outboxId = `node-terminal:${tracked.assignment.assignmentId}:${tracked.assignment.schedulerEpoch}:${tracked.assignment.fencingToken}`;
		if (this.#outbox.has(outboxId)) throw new MeshNodeAgentError("node_state_conflict");
		this.#outbox.set(
			outboxId,
			Object.freeze({
				outboxId,
				assignmentId: tracked.assignment.assignmentId,
				taskId: tracked.task.taskId,
				type: "node.lifecycle.terminal",
				idempotencyKey: `node.lifecycle.terminal:${tracked.assignment.assignmentId}:${tracked.assignment.schedulerEpoch}:${tracked.assignment.fencingToken}`,
				record,
				state: "pending",
			}),
		);
	}

	#nextPendingTerminalOutbox(attempted: ReadonlySet<string>): MeshNodeTerminalOutboxMessage | undefined {
		return [...this.#outbox.values()]
			.sort((left, right) => left.outboxId.localeCompare(right.outboxId))
			.find(message => message.state === "pending" && !attempted.has(message.outboxId) && !this.#drainingOutbox.has(message.outboxId));
	}

	#publicationFor(message: MeshNodeTerminalOutboxMessage): MeshNodeTerminalOutboxPublication {
		return Object.freeze({
			outboxId: message.outboxId,
			assignmentId: message.assignmentId,
			taskId: message.taskId,
			type: "node.lifecycle.terminal",
			idempotencyKey: message.idempotencyKey,
			record: Object.freeze({ ...message.record }),
		});
	}

	#publicOutboxMessage(message: MeshNodeTerminalOutboxMessage): MeshNodeTerminalOutboxMessage {
		return Object.freeze({
			...this.#publicationFor(message),
			state: message.state,
			...(message.deliveredAt === undefined ? {} : { deliveredAt: message.deliveredAt }),
		});
	}

	#markTerminalOutboxDelivered(outboxId: string): void {
		const current = this.#outbox.get(outboxId);
		if (current === undefined || current.state !== "pending") throw new MeshNodeAgentError("node_state_conflict");
		this.#mutate(() => {
			const pending = this.#outbox.get(outboxId);
			if (pending === undefined || pending.state !== "pending") throw new MeshNodeAgentError("node_state_conflict");
			this.#outbox.set(
				outboxId,
				Object.freeze({
					...pending,
					state: "delivered",
					deliveredAt: this.#timestampNow(),
				}),
			);
		});
	}

	#timestampNow(): string {
		try {
			const now = this.#now();
			if (!Number.isFinite(now)) throw new Error("node clock is invalid");
			return new Date(now).toISOString();
		} catch {
			throw new MeshNodeAgentError("node_state_unavailable");
		}
	}

	#markReconciliation(tracked: AcceptedAssignment, type: MeshNodeLifecycleEventType, code: MeshNodeAgentErrorCode): MeshNodeLifecycleRecord {
		if (tracked.state === "reconciliation_required") {
			for (let index = this.#events.length - 1; index >= 0; index -= 1) {
				const record = this.#events[index];
				if (record.assignmentId === tracked.assignment.assignmentId) {
					this.#volatileReconciliation.delete(tracked.assignment.assignmentId);
					return record;
				}
			}
		}
		const record = this.#mutate(() => {
			tracked.cancelPromise = undefined;
			tracked.cleanupPromise = undefined;
			tracked.cleanupOriginState = undefined;
			tracked.state = "reconciliation_required";
			return this.#appendRecord(type, tracked, code);
		});
		this.#volatileReconciliation.delete(tracked.assignment.assignmentId);
		return record;
	}

	/**
	 * Once an execution port may have observed a command, a failed follow-up
	 * write is an uncertainty boundary. First try to persist that uncertainty;
	 * if storage is unavailable, quarantine the live assignment by stable ID so
	 * later calls cannot reach the port before restart or local resolution.
	 */
	#reconcileAfterPort(
		assignmentId: string,
		type: MeshNodeLifecycleEventType,
		code: MeshNodeAgentErrorCode,
		callerCode: MeshNodeAgentErrorCode = "assignment_reconciliation_required",
	): never {
		try {
			this.#markReconciliation(this.#assignmentFor(assignmentId), type, code);
		} catch {
			this.#volatileReconciliation.add(assignmentId);
		}
		throw new MeshNodeAgentError(callerCode);
	}

	#snapshotFromMemory(): MeshNodeStateSnapshot {
		const assignments: Record<string, MeshNodeDurableAssignment> = {};
		for (const [assignmentId, tracked] of this.#assignments) {
			assignments[assignmentId] = {
				task: tracked.task,
				signedAssignment: tracked.signedAssignment,
				state: tracked.state,
				admissionRecord: tracked.admissionRecord,
				cancelRecord: tracked.cancelRecord,
				cleanupRecord: tracked.cleanupRecord,
				terminalRecord: tracked.terminalRecord,
				cleanupOriginState: tracked.cleanupOriginState,
			};
		}
		const outbox: Record<string, MeshNodeTerminalOutboxMessage> = {};
		for (const [outboxId, message] of this.#outbox) outbox[outboxId] = message;
		return structuredClone({
			revision: this.#revision,
			identity: this.#identity,
			assignments,
			events: this.#events,
			outbox,
		});
	}

	#mutate<T>(operation: () => T): T {
		const before = this.#snapshotFromMemory();
		let result: T;
		try {
			result = operation();
		} catch (error) {
			this.#restoreTrusted(before);
			throw error;
		}
		try {
			const next = this.#snapshotFromMemory();
			this.#stateRepository.transaction(({ snapshot }) => {
				if (snapshot.revision !== before.revision) throw new MeshNodeAgentError("node_state_conflict");
				snapshot.identity = next.identity;
				snapshot.assignments = next.assignments;
				snapshot.events = next.events;
				snapshot.outbox = next.outbox;
			});
			this.#revision = before.revision + 1;
			return result;
		} catch (error) {
			this.#restoreTrusted(before);
			if (error instanceof MeshNodeAgentError) throw error;
			throw new MeshNodeAgentError("node_state_unavailable");
		}
	}

	async #initializeDurableState(): Promise<void> {
		let stored: MeshNodeStateSnapshot;
		try {
			stored = this.#stateRepository.read(snapshot => snapshot);
		} catch {
			throw new MeshNodeAgentError("node_state_unavailable");
		}
		if (stored.identity !== undefined && (stored.identity.nodeId !== this.#identity.nodeId || stored.identity.pubkey !== this.#identity.pubkey)) {
			throw new MeshNodeAgentError("node_state_identity_mismatch");
		}
		await this.#restoreVerified(stored);
		if (stored.identity === undefined) this.#mutate(() => undefined);
		this.#recoverAfterRestart();
	}

	#restoreTrusted(snapshot: MeshNodeStateSnapshot): void {
		try {
			const events = this.#parsePersistedEvents(snapshot);
			const assignments = new Map<string, AcceptedAssignment>();
			for (const [assignmentId, stored] of Object.entries(snapshot.assignments)) {
				assignments.set(assignmentId, this.#parsePersistedAssignmentUnchecked(assignmentId, stored));
			}
			this.#applyRestoredState(snapshot, events, assignments);
		} catch (error) {
			if (error instanceof MeshNodeAgentError) throw error;
			throw new MeshNodeAgentError("node_state_corrupt");
		}
	}

	async #restoreVerified(snapshot: MeshNodeStateSnapshot): Promise<void> {
		try {
			const events = this.#parsePersistedEvents(snapshot);
			const assignments = new Map<string, AcceptedAssignment>();
			for (const [assignmentId, stored] of Object.entries(snapshot.assignments)) {
				assignments.set(assignmentId, await this.#parsePersistedAssignmentVerified(assignmentId, stored));
			}
			this.#applyRestoredState(snapshot, events, assignments);
		} catch (error) {
			if (error instanceof MeshNodeAgentError) throw error;
			throw new MeshNodeAgentError("node_state_corrupt");
		}
	}

	#parsePersistedEvents(snapshot: MeshNodeStateSnapshot): readonly MeshNodeLifecycleRecord[] {
		if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new MeshNodeAgentError("node_state_corrupt");
		const events = snapshot.events.map(event => this.#parsePersistedRecord(event));
		if (events.some((event, index) => event.sequence !== index)) throw new MeshNodeAgentError("node_state_corrupt");
		return events;
	}

	#applyRestoredState(
		snapshot: MeshNodeStateSnapshot,
		events: readonly MeshNodeLifecycleRecord[],
		assignments: ReadonlyMap<string, AcceptedAssignment>,
	): void {
		const outbox = new Map<string, MeshNodeTerminalOutboxMessage>();
		for (const [outboxId, stored] of Object.entries(snapshot.outbox)) {
			outbox.set(outboxId, this.#parsePersistedOutbox(outboxId, stored, assignments));
		}
		for (const tracked of assignments.values()) {
			const terminalRecord = tracked.terminalRecord;
			if (terminalRecord === undefined) continue;
			if (
				!isTerminalLifecycleRecord(terminalRecord) ||
				(tracked.state !== "cleaned" && tracked.state !== terminalRecord.state) ||
				!events.some(event => sameLifecycleRecord(event, terminalRecord))
			) {
				throw new MeshNodeAgentError("node_state_corrupt");
			}
			const outboxId = `node-terminal:${tracked.assignment.assignmentId}:${tracked.assignment.schedulerEpoch}:${tracked.assignment.fencingToken}`;
			const message = outbox.get(outboxId);
			if (message === undefined || !sameLifecycleRecord(message.record, terminalRecord)) {
				throw new MeshNodeAgentError("node_state_corrupt");
			}
		}
		this.#assignments.clear();
		for (const [assignmentId, tracked] of assignments) this.#assignments.set(assignmentId, tracked);
		this.#events.splice(0, this.#events.length, ...events);
		this.#outbox.clear();
		for (const [outboxId, message] of outbox) this.#outbox.set(outboxId, message);
		this.#sequence = events.length;
		this.#revision = snapshot.revision;
	}

	#parsePersistedAssignmentUnchecked(assignmentId: string, value: unknown): AcceptedAssignment {
		const parsed = this.#parsePersistedAssignmentShape(assignmentId, value);
		return this.#buildPersistedAssignment(parsed.task, parsed.assignment, parsed.signedAssignment, parsed.state, parsed.value);
	}

	async #parsePersistedAssignmentVerified(assignmentId: string, value: unknown): Promise<AcceptedAssignment> {
		const parsed = this.#parsePersistedAssignmentShape(assignmentId, value);
		const verified = await this.#verifySignedAssignment(parsed.signedAssignment);
		if (
			verified.assignment.assignmentId !== parsed.assignment.assignmentId ||
			verified.payloadDigest !== parsed.signedAssignment.payloadDigest
		) {
			throw new MeshNodeAgentError("node_state_corrupt");
		}
		return this.#buildPersistedAssignment(parsed.task, verified.assignment, verified.signedAssignment, parsed.state, parsed.value);
	}

	#parsePersistedAssignmentShape(
		assignmentId: string,
		value: unknown,
	): {
		readonly assignment: AssignmentLeaseV1;
		readonly signedAssignment: SignedMeshEnvelopeV1<AssignmentLeaseV1>;
		readonly state: MeshNodeLifecycleState;
		readonly task: TaskContractV1;
		readonly value: Record<string, unknown>;
	} {
		if (!isRecord(value)) throw new MeshNodeAgentError("node_state_corrupt");
		let task: TaskContractV1;
		let signedAssignment: SignedMeshEnvelopeV1<AssignmentLeaseV1>;
		let assignment: AssignmentLeaseV1;
		try {
			task = parseTaskContract(value.task);
			const envelope = parseSignedMeshEnvelope(value.signedAssignment);
			if (envelope.payload.schemaVersion !== MESH_SCHEMA.assignment) throw new MeshNodeAgentError("node_state_corrupt");
			signedAssignment = envelope as SignedMeshEnvelopeV1<AssignmentLeaseV1>;
			assignment = parseAssignmentLease(signedAssignment.payload);
		} catch {
			throw new MeshNodeAgentError("node_state_corrupt");
		}
		if (
			assignment.assignmentId !== assignmentId ||
			assignment.taskId !== task.taskId ||
			assignment.taskDigest !== task.digest ||
			assignment.permissionsDigest !== sha256CanonicalJson(task.permissions) ||
			assignment.workerNodeId !== this.#identity.nodeId ||
			assignment.executorPubkey !== this.#identity.pubkey ||
			!isKnownState(value.state)
		) {
			throw new MeshNodeAgentError("node_state_corrupt");
		}
		return Object.freeze({ assignment, signedAssignment, state: value.state, task, value });
	}

	#buildPersistedAssignment(
		task: TaskContractV1,
		assignment: AssignmentLeaseV1,
		signedAssignment: SignedMeshEnvelopeV1<AssignmentLeaseV1>,
		state: MeshNodeLifecycleState,
		value: Record<string, unknown>,
	): AcceptedAssignment {
		const tracked: AcceptedAssignment = {
			task,
			assignment,
			signedAssignment,
			assignmentPayloadDigest: signedAssignment.payloadDigest,
			bounds: this.#executionBounds(task),
			state,
		};
		tracked.admissionRecord = this.#parseOptionalPersistedRecord(value.admissionRecord, tracked);
		tracked.cancelRecord = this.#parseOptionalPersistedRecord(value.cancelRecord, tracked);
		tracked.cleanupRecord = this.#parseOptionalPersistedRecord(value.cleanupRecord, tracked);
		tracked.terminalRecord = this.#parseOptionalPersistedRecord(value.terminalRecord, tracked);
		if (value.cleanupOriginState !== undefined) {
			if (!isKnownState(value.cleanupOriginState)) throw new MeshNodeAgentError("node_state_corrupt");
			tracked.cleanupOriginState = value.cleanupOriginState;
		}
		if (tracked.admissionRecord === undefined) throw new MeshNodeAgentError("node_state_corrupt");
		if ((tracked.state === "cancelled" || tracked.state === "completed" || tracked.state === "failed" || tracked.state === "lost" || tracked.state === "cleaned") && tracked.terminalRecord === undefined) {
			throw new MeshNodeAgentError("node_state_corrupt");
		}
		return tracked;
	}

	#parseOptionalPersistedRecord(value: unknown, tracked: AcceptedAssignment): MeshNodeLifecycleRecord | undefined {
		if (value === undefined) return undefined;
		const record = this.#parsePersistedRecord(value);
		if (
			record.assignmentId !== tracked.assignment.assignmentId ||
			record.taskId !== tracked.task.taskId ||
			record.schedulerEpoch !== tracked.assignment.schedulerEpoch ||
			record.fencingToken !== tracked.assignment.fencingToken
		) {
			throw new MeshNodeAgentError("node_state_corrupt");
		}
		return record;
	}

	#parsePersistedRecord(value: unknown): MeshNodeLifecycleRecord {
		if (!isRecord(value)) throw new MeshNodeAgentError("node_state_corrupt");
		if (
			typeof value.sequence !== "number" ||
			!Number.isSafeInteger(value.sequence) ||
			value.sequence < 0 ||
			!isKnownEventType(value.type) ||
			typeof value.occurredAt !== "string" ||
			!Number.isFinite(Date.parse(value.occurredAt)) ||
			typeof value.nodeId !== "string" ||
			value.nodeId !== this.#identity.nodeId ||
			!isKnownState(value.state)
		) {
			throw new MeshNodeAgentError("node_state_corrupt");
		}
		const record: MeshNodeLifecycleRecord = {
			sequence: value.sequence,
			type: value.type,
			occurredAt: value.occurredAt,
			nodeId: value.nodeId,
			state: value.state,
		};
		if (value.assignmentId !== undefined || value.taskId !== undefined || value.schedulerEpoch !== undefined || value.fencingToken !== undefined) {
			if (
				typeof value.assignmentId !== "string" ||
				typeof value.taskId !== "string" ||
				typeof value.schedulerEpoch !== "number" ||
				!isPositiveInteger(value.schedulerEpoch) ||
				typeof value.fencingToken !== "number" ||
				!isPositiveInteger(value.fencingToken)
			) {
				throw new MeshNodeAgentError("node_state_corrupt");
			}
			Object.assign(record, {
				assignmentId: value.assignmentId,
				taskId: value.taskId,
				schedulerEpoch: value.schedulerEpoch,
				fencingToken: value.fencingToken,
			});
		}
		if (value.code !== undefined) {
			if (typeof value.code !== "string") throw new MeshNodeAgentError("node_state_corrupt");
			Object.assign(record, { code: value.code as MeshNodeAgentErrorCode });
		}
		if (value.outcome !== undefined) {
			if (value.outcome !== "succeeded" && value.outcome !== "failed") throw new MeshNodeAgentError("node_state_corrupt");
			Object.assign(record, { outcome: value.outcome });
		}
		if (value.exitCode !== undefined) {
			if (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode) || value.exitCode < 0) {
				throw new MeshNodeAgentError("node_state_corrupt");
			}
			Object.assign(record, { exitCode: value.exitCode });
		}
		return freezeRecord(record);
	}

	#parsePersistedOutbox(
		outboxId: string,
		value: unknown,
		assignments: ReadonlyMap<string, AcceptedAssignment>,
	): MeshNodeTerminalOutboxMessage {
		if (!isRecord(value) || value.outboxId !== outboxId || typeof value.assignmentId !== "string" || typeof value.taskId !== "string") {
			throw new MeshNodeAgentError("node_state_corrupt");
		}
		const tracked = assignments.get(value.assignmentId);
		if (
			tracked === undefined ||
			value.taskId !== tracked.task.taskId ||
			value.type !== "node.lifecycle.terminal" ||
			!isKnownOutboxState(value.state) ||
			typeof value.idempotencyKey !== "string"
		) {
			throw new MeshNodeAgentError("node_state_corrupt");
		}
		const expectedOutboxId = `node-terminal:${tracked.assignment.assignmentId}:${tracked.assignment.schedulerEpoch}:${tracked.assignment.fencingToken}`;
		const expectedIdempotencyKey = `node.lifecycle.terminal:${tracked.assignment.assignmentId}:${tracked.assignment.schedulerEpoch}:${tracked.assignment.fencingToken}`;
		const record = this.#parsePersistedRecord(value.record);
		if (
			outboxId !== expectedOutboxId ||
			value.idempotencyKey !== expectedIdempotencyKey ||
			tracked.terminalRecord === undefined ||
			!sameLifecycleRecord(tracked.terminalRecord, record)
		) {
			throw new MeshNodeAgentError("node_state_corrupt");
		}
		const message = {
			outboxId,
			assignmentId: value.assignmentId,
			taskId: value.taskId,
			type: "node.lifecycle.terminal",
			idempotencyKey: value.idempotencyKey,
			record,
		};
		if (value.state === "delivered") {
			const deliveredAt = value.deliveredAt;
			if (!isTimestamp(deliveredAt)) throw new MeshNodeAgentError("node_state_corrupt");
			return Object.freeze({ ...message, state: "delivered", deliveredAt });
		}
		if (value.deliveredAt !== undefined) throw new MeshNodeAgentError("node_state_corrupt");
		return Object.freeze({ ...message, state: "pending" });
	}

	#recoverAfterRestart(): void {
		const recovering = [...this.#assignments.values()].filter(tracked => RECOVERY_STATES.has(tracked.state));
		if (recovering.length === 0) return;
		this.#mutate(() => {
			for (const tracked of recovering) {
				tracked.cancelPromise = undefined;
				tracked.cleanupPromise = undefined;
				tracked.cleanupOriginState = undefined;
				tracked.state = "reconciliation_required";
				this.#appendRecord("execution.reconciliation_required", tracked, "assignment_reconciliation_required");
			}
		});
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
