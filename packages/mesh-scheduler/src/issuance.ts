import {
	MESH_SCHEMA,
	isMeshId,
	parseAssignmentLease,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type JsonRecord,
} from "@pk-nerdsaver-ai/mesh-contracts";
import { signAssignmentLease, verifySignedAssignmentLease, type MeshEnvelopeSigner, type MeshEnvelopeVerifier, type SignedMeshEnvelopeV1 } from "@pk-nerdsaver-ai/mesh-auth";
import {
	FencingViolationError,
	IdempotencyConflictError,
	MeshOrchestrator,
	SchedulerLeaseConflictError,
	type RuntimeAssignmentRecord,
} from "@pk-nerdsaver-ai/mesh-orchestrator";

import { placeTask, type PlacementDecision, type PlacementNode, type PlacementPolicy } from "./placement";

export type SchedulerIssuanceErrorCode =
	| "assignment_id_invalid"
	| "assignment_invalid"
	| "assignment_lease_insufficient"
	| "clock_unavailable"
	| "execution_profile_required"
	| "execution_timeout_required"
	| "fencing_token_unavailable"
	| "lease_policy_invalid"
	| "no_eligible_node"
	| "presence_window_insufficient"
	| "recovery_assignment_missing"
	| "recovery_assignment_mismatch"
	| "scheduler_lease_insufficient"
	| "selected_node_ambiguous"
	| "signer_invalid"
	| "signing_failed"
	| "signature_unverified"
	| "task_not_found"
	| "task_not_queued";

/** Stable, non-secret rejections for the scheduler composition boundary. */
export class SchedulerIssuanceError extends Error {
	readonly code: SchedulerIssuanceErrorCode;

	constructor(code: SchedulerIssuanceErrorCode) {
		super(`scheduler_issuance_${code}`);
		this.name = "SchedulerIssuanceError";
		this.code = code;
	}
}

export interface SchedulerIssuanceClock {
	nowEpochMs(): number;
}

export interface SchedulerIssuanceRequest {
	/** Caller-stable ID. Reusing it after a restart asks for exact-current replay only. */
	readonly assignmentId: string;
	readonly taskId: string;
	readonly nodes: readonly PlacementNode[];
	readonly schedulerLeaseDurationMs: number;
	readonly assignmentLeaseDurationMs: number;
	readonly renewAfterSeconds: number;
	readonly policy?: PlacementPolicy;
}

export interface SchedulerIssuedAssignment {
	readonly record: RuntimeAssignmentRecord;
	readonly signedAssignment: SignedMeshEnvelopeV1<AssignmentLeaseV1>;
	readonly replayed: boolean;
}

export interface MeshSchedulerIssuanceCoordinatorOptions {
	readonly runtime: MeshOrchestrator;
	readonly signer: MeshEnvelopeSigner;
	/** Trusted public verifier for the exact scheduler signer used for issuance. */
	readonly verifier: MeshEnvelopeVerifier;
	readonly clock: SchedulerIssuanceClock;
}

function iso(now: number): string {
	try {
		return new Date(now).toISOString();
	} catch {
		throw new SchedulerIssuanceError("clock_unavailable");
	}
}

function positiveFinite(value: number): boolean {
	return Number.isFinite(value) && value > 0;
}

function positiveInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0;
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function assertSigner(signer: MeshEnvelopeSigner): void {
	if (
		signer.role !== "scheduler" ||
		!nonEmpty(signer.actorPubkey) ||
		!nonEmpty(signer.algorithm) ||
		!nonEmpty(signer.keyId) ||
		typeof signer.sign !== "function"
	) {
		throw new SchedulerIssuanceError("signer_invalid");
	}
}

function assertVerifier(verifier: MeshEnvelopeVerifier, signer: MeshEnvelopeSigner): void {
	if (
		verifier.role !== "scheduler" ||
		!nonEmpty(verifier.actorPubkey) ||
		!nonEmpty(verifier.algorithm) ||
		!nonEmpty(verifier.keyId) ||
		typeof verifier.verify !== "function" ||
		verifier.algorithm !== signer.algorithm ||
		verifier.keyId !== signer.keyId ||
		verifier.actorPubkey !== signer.actorPubkey ||
		verifier.role !== signer.role
	) {
		throw new SchedulerIssuanceError("signer_invalid");
	}
}

function assertRequest(request: SchedulerIssuanceRequest): void {
	if (!isMeshId(request.assignmentId, "assignment")) throw new SchedulerIssuanceError("assignment_id_invalid");
	if (!isMeshId(request.taskId, "task")) throw new SchedulerIssuanceError("task_not_found");
	if (!positiveFinite(request.schedulerLeaseDurationMs) || !positiveFinite(request.assignmentLeaseDurationMs)) {
		throw new SchedulerIssuanceError("lease_policy_invalid");
	}
	if (request.schedulerLeaseDurationMs <= request.assignmentLeaseDurationMs) {
		throw new SchedulerIssuanceError("lease_policy_invalid");
	}
	if (!positiveInteger(request.renewAfterSeconds) || request.renewAfterSeconds * 1_000 >= request.assignmentLeaseDurationMs) {
		throw new SchedulerIssuanceError("lease_policy_invalid");
	}
}

function nextFencingToken(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
		throw new SchedulerIssuanceError("fencing_token_unavailable");
	}
	return value + 1;
}

function selectedNode(decision: PlacementDecision, nodes: readonly PlacementNode[]): PlacementNode {
	if (decision.selectedNodeId === undefined) throw new SchedulerIssuanceError("no_eligible_node");
	const candidates = nodes.filter(node => node.nodeId === decision.selectedNodeId);
	if (candidates.length !== 1 || !isMeshId(candidates[0]?.nodeId, "node") || !nonEmpty(candidates[0]?.actorPubkey)) {
		throw new SchedulerIssuanceError("selected_node_ambiguous");
	}
	return candidates[0];
}

function placementReason(decision: PlacementDecision, node: PlacementNode): JsonRecord {
	return Object.freeze({
		selectedNodeId: node.nodeId,
		reasons: Object.freeze([...decision.placementReason]),
	});
}

function assignmentFor(input: {
	readonly assignmentId: string;
	readonly task: SchedulerIssuedTask;
	readonly node: PlacementNode;
	readonly decision: PlacementDecision;
	readonly schedulerPubkey: string;
	readonly schedulerEpoch: number;
	readonly fencingToken: number;
	readonly issuedAt: string;
	readonly leaseExpiresAt: string;
	readonly renewAfterSeconds: number;
}): AssignmentLeaseV1 {
	try {
		return parseAssignmentLease({
			schemaVersion: MESH_SCHEMA.assignment,
			assignmentId: input.assignmentId,
			taskId: input.task.taskId,
			taskDigest: input.task.digest,
			scheduler: { pubkey: input.schedulerPubkey, role: "scheduler" },
			schedulerEpoch: input.schedulerEpoch,
			fencingToken: input.fencingToken,
			workerNodeId: input.node.nodeId,
			executorPubkey: input.node.actorPubkey,
			executionProfileId: input.task.executionProfileId,
			issuedAt: input.issuedAt,
			leaseExpiresAt: input.leaseExpiresAt,
			renewAfterSeconds: input.renewAfterSeconds,
			permissionsDigest: input.task.permissionsDigest,
			placementReason: placementReason(input.decision, input.node),
			idempotencyKey: `scheduler-issuance:${input.assignmentId}`,
		});
	} catch {
		throw new SchedulerIssuanceError("assignment_invalid");
	}
}

interface SchedulerIssuedTask {
	readonly taskId: string;
	readonly digest: string;
	readonly executionProfileId: string;
	readonly permissionsDigest: string;
}

/**
 * Composes deterministic placement, injected scheduler signing, and the durable
 * control-plane authority. It deliberately does not deliver or execute work.
 */
export class MeshSchedulerIssuanceCoordinator {
	readonly #runtime: MeshOrchestrator;
	readonly #signer: MeshEnvelopeSigner;
	readonly #verifier: MeshEnvelopeVerifier;
	readonly #schedulerPubkey: string;
	readonly #clock: SchedulerIssuanceClock;

	constructor(options: MeshSchedulerIssuanceCoordinatorOptions) {
		this.#runtime = options.runtime;
		assertSigner(options.signer);
		assertVerifier(options.verifier, options.signer);
		this.#signer = Object.freeze({
			algorithm: options.signer.algorithm,
			keyId: options.signer.keyId,
			actorPubkey: options.signer.actorPubkey,
			role: options.signer.role,
			sign: options.signer.sign.bind(options.signer),
		});
		this.#verifier = Object.freeze({
			algorithm: options.verifier.algorithm,
			keyId: options.verifier.keyId,
			actorPubkey: options.verifier.actorPubkey,
			role: options.verifier.role,
			verify: options.verifier.verify.bind(options.verifier),
		});
		this.#schedulerPubkey = this.#signer.actorPubkey;
		this.#clock = options.clock;
	}

	async issue(request: SchedulerIssuanceRequest): Promise<SchedulerIssuedAssignment> {
		assertRequest(request);
		const taskRecord = await this.#runtime.getTask(request.taskId);
		if (taskRecord === undefined) throw new SchedulerIssuanceError("task_not_found");

		// A caller-stable assignment ID is never reusable across task attempts.
		// Check it before changing scheduler authority, including cross-task reuse.
		if ((await this.#runtime.getAssignment(request.assignmentId)) !== undefined) {
			// A recovery caller may have learned that the worker is unavailable
			// since the original lease. Ingest its current observed capacity before
			// considering any fresh signed delivery envelope.
			await this.#observeNodeCapacities(request.nodes);
			return this.#replay(request.assignmentId, taskRecord.task.taskId);
		}
		if (taskRecord.state !== "queued") throw new SchedulerIssuanceError("task_not_queued");

		const executionProfileId = taskRecord.task.execution.profileId;
		if (!nonEmpty(executionProfileId)) throw new SchedulerIssuanceError("execution_profile_required");
		const timeoutSeconds = taskRecord.task.execution.timeoutSeconds;
		const executionTimeoutMs = typeof timeoutSeconds === "number" ? timeoutSeconds * 1_000 : Number.NaN;
		if (!positiveInteger(timeoutSeconds) || !Number.isSafeInteger(executionTimeoutMs)) {
			throw new SchedulerIssuanceError("execution_timeout_required");
		}
		// v1 has no fenced assignment-renewal protocol. The original ticket must
		// therefore remain valid through the task's declared execution bound.
		if (request.assignmentLeaseDurationMs <= executionTimeoutMs) {
			throw new SchedulerIssuanceError("lease_policy_invalid");
		}
		const task: SchedulerIssuedTask = Object.freeze({
			taskId: taskRecord.task.taskId,
			digest: taskRecord.task.digest,
			executionProfileId,
			permissionsDigest: sha256CanonicalJson(taskRecord.task.permissions),
		});
		// Persist every well-formed node capacity before placement. In particular,
		// a zero-slot advertisement must close an older higher-capacity window even
		// when it cannot itself be selected for this task.
		await this.#observeNodeCapacities(request.nodes);
		const placementNow = this.#now();
		const initialDecision = placeTask({ task: taskRecord.task, nodes: request.nodes, nowEpochMs: placementNow, policy: request.policy });
		const initialNode = selectedNode(initialDecision, request.nodes);
		const fencingToken = nextFencingToken(taskRecord.latestFencingToken);
		const initialIssuedAt = iso(placementNow);
		const initialLeaseExpiresAt = iso(placementNow + request.assignmentLeaseDurationMs);

		// Fail contract construction before mutating scheduler ownership.
		assignmentFor({
			assignmentId: request.assignmentId,
			task,
			node: initialNode,
			decision: initialDecision,
			schedulerPubkey: this.#schedulerPubkey,
			schedulerEpoch: 1,
			fencingToken,
			issuedAt: initialIssuedAt,
			leaseExpiresAt: initialLeaseExpiresAt,
			renewAfterSeconds: request.renewAfterSeconds,
		});

		const scheduler = await this.#runtime.acquireSchedulerLease({
			schedulerId: this.#schedulerPubkey,
			durationMs: request.schedulerLeaseDurationMs,
			now: placementNow,
		});
		// A competing process may have committed the same caller-stable ID while
		// this process was acquiring scheduler authority. Refresh current capacity
		// before considering delivery of its durable lease.
		if ((await this.#runtime.getAssignment(request.assignmentId)) !== undefined) {
			await this.#observeNodeCapacities(request.nodes);
			return this.#replay(request.assignmentId, task.taskId);
		}
		// Presence is advisory and may age while authority is acquired. Bind a ticket
		// only to the currently safe placement, never to an earlier observation.
		const assignmentNow = this.#now();
		const decision = placeTask({ task: taskRecord.task, nodes: request.nodes, nowEpochMs: assignmentNow, policy: request.policy });
		const node = selectedNode(decision, request.nodes);
		const issuedAt = iso(assignmentNow);
		const leaseExpiresAt = iso(assignmentNow + request.assignmentLeaseDurationMs);
		if (Date.parse(scheduler.leaseExpiresAt) <= Date.parse(leaseExpiresAt)) {
			throw new SchedulerIssuanceError("scheduler_lease_insufficient");
		}
		const assignment = assignmentFor({
			assignmentId: request.assignmentId,
			task,
			node,
			decision,
			schedulerPubkey: this.#schedulerPubkey,
			schedulerEpoch: scheduler.epoch,
			fencingToken,
			issuedAt,
			leaseExpiresAt,
			renewAfterSeconds: request.renewAfterSeconds,
		});
		const signedAssignment = await this.#sign(assignment, issuedAt);
		let record: RuntimeAssignmentRecord;
		try {
			// Signing is asynchronous. Recheck the exact target at commit time so an
			// expired presence never becomes a durable ticket for a rejecting node.
			const commitNow = this.#now();
			await this.#observeNodeCapacities(request.nodes);
			const commitDecision = placeTask({ task: taskRecord.task, nodes: request.nodes, nowEpochMs: commitNow, policy: request.policy });
			const commitNode = selectedNode(commitDecision, request.nodes);
			if (commitNode.nodeId !== node.nodeId || commitNode.actorPubkey !== node.actorPubkey) {
				throw new SchedulerIssuanceError("no_eligible_node");
			}
			if (Date.parse(commitNode.expiresAt) - commitNow <= executionTimeoutMs) {
				throw new SchedulerIssuanceError("presence_window_insufficient");
			}
			if (Date.parse(leaseExpiresAt) - commitNow <= executionTimeoutMs) {
				throw new SchedulerIssuanceError("assignment_lease_insufficient");
			}
			// Re-read trusted time after async signing: an expired authority may not commit.
			record = await this.#runtime.assign({ assignment, now: commitNow });
		} catch (error) {
			if (!(error instanceof IdempotencyConflictError)) throw error;
			return this.#replay(request.assignmentId, task.taskId);
		}
		return Object.freeze({ record, signedAssignment, replayed: false });
	}

	async #observeNodeCapacities(nodes: readonly PlacementNode[]): Promise<void> {
		for (const node of nodes) {
			if (
				!isMeshId(node.nodeId, "node") ||
				!nonEmpty(node.actorPubkey) ||
				!Number.isSafeInteger(node.availableSlots) ||
				node.availableSlots < 0
			) {
				continue;
			}
			const observedAt = Date.parse(node.observedAt);
			const expiresAt = Date.parse(node.expiresAt);
			if (!Number.isSafeInteger(observedAt) || !Number.isSafeInteger(expiresAt)) continue;
			await this.#runtime.observeWorkerCapacity({
				workerNodeId: node.nodeId,
				actorPubkey: node.actorPubkey,
				availableSlots: node.availableSlots,
				observedAt,
				expiresAt,
			});
		}
	}

	async #replay(assignmentId: string, taskId: string): Promise<SchedulerIssuedAssignment> {
		const existing = await this.#runtime.getAssignment(assignmentId);
		if (existing === undefined) throw new SchedulerIssuanceError("recovery_assignment_missing");
		if (
			existing.lease.taskId !== taskId ||
			existing.lease.scheduler.pubkey !== this.#schedulerPubkey ||
			existing.lease.scheduler.role !== "scheduler"
		) {
			throw new SchedulerIssuanceError("recovery_assignment_mismatch");
		}
		const replayNow = this.#now();
		if (Date.parse(existing.lease.leaseExpiresAt) <= replayNow) throw new FencingViolationError(existing.lease.assignmentId);
		const scheduler = await this.#runtime.getSchedulerLease();
		if (
			scheduler === undefined ||
			scheduler.schedulerId !== this.#schedulerPubkey ||
			Date.parse(scheduler.leaseExpiresAt) <= replayNow
		) {
			throw new SchedulerLeaseConflictError();
		}
		if (scheduler.epoch !== existing.lease.schedulerEpoch) throw new FencingViolationError(existing.lease.assignmentId);
		// Exact-current assign is read-only but revalidates capacity. Do this before
		// signing so a known zero/offline worker receives no fresh envelope.
		await this.#runtime.assign({ assignment: existing.lease, now: replayNow });
		const signedAssignment = await this.#sign(existing.lease, iso(replayNow));
		const record = await this.#runtime.assign({ assignment: existing.lease, now: this.#now() });
		return Object.freeze({ record, signedAssignment, replayed: true });
	}

	#now(): number {
		let now: number;
		try {
			now = this.#clock.nowEpochMs();
		} catch {
			throw new SchedulerIssuanceError("clock_unavailable");
		}
		if (!Number.isFinite(now)) throw new SchedulerIssuanceError("clock_unavailable");
		iso(now);
		return now;
	}

	async #sign(assignment: AssignmentLeaseV1, signedAt: string): Promise<SignedMeshEnvelopeV1<AssignmentLeaseV1>> {
		let signedAssignment: SignedMeshEnvelopeV1<AssignmentLeaseV1>;
		try {
			signedAssignment = await signAssignmentLease(assignment, this.#signer, { signedAt });
		} catch {
			throw new SchedulerIssuanceError("signing_failed");
		}
		try {
			if (!(await verifySignedAssignmentLease(signedAssignment, this.#verifier)).ok) {
				throw new Error("signature_unverified");
			}
		} catch {
			throw new SchedulerIssuanceError("signature_unverified");
		}
		return signedAssignment;
	}
}
