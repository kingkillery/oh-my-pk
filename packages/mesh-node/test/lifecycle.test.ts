import { describe, expect, test } from "bun:test";

import {
	MESH_SCHEMA,
	parseAssignmentLease,
	parseNodeAdvertisement,
	parseTaskContract,
	sha256CanonicalJson,
	type AssignmentLeaseV1,
	type TaskContractV1,
} from "@pk-nerdsaver-ai/mesh-contracts";
import { signAssignmentLease, type MeshEnvelopeSigner, type MeshEnvelopeVerifier } from "@pk-nerdsaver-ai/mesh-auth";
import {
	MeshNodeAgent,
	MeshNodeAgentError,
	projectNodeAdvertisement,
	type MeshExecutionRunResult,
	type MeshNodeExecutionContext,
	type MeshNodeExecutionPort,
	type MeshNodePresence,
} from "../src/index";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const NODE_ID = "node_local-001";
const NODE_PUBKEY = "n".repeat(64);
const SCHEDULER_PUBKEY = "s".repeat(64);
const SIGNATURE_ALGORITHM = "node-test-signature-v1";
const SIGNATURE_KEY_ID = "node-test-scheduler-key";
const signatureEncoder = new TextEncoder();
const signatureDecoder = new TextDecoder();

interface ExecutionCalls {
	start: number;
	run: number;
	heartbeat: number;
	cancel: number;
	cleanup: number;
	contexts: MeshNodeExecutionContext[];
}

function makeTask(overrides: Record<string, unknown> = {}): TaskContractV1 {
	const unsigned = {
		schemaVersion: MESH_SCHEMA.task,
		taskId: "task_lifecycle-001",
		createdAt: "2026-08-31T11:59:00.000Z",
		requester: { pubkey: "r".repeat(64), role: "human" },
		goal: "Run a bounded safe task.",
		mode: "general_tool",
		acceptanceCriteria: [{ id: "criterion-1", description: "Exit safely.", level: "required" }],
		permissions: { tools: ["safe.tool"], externalSideEffects: "none" },
		execution: { profileId: "safe-profile", timeoutSeconds: 30, cpuMax: 1, retriesMax: 0 },
		routing: { requiredCapabilities: ["safe.tool"], trustZoneMin: "private", activeMachineAllowed: false },
		artifactPolicy: {},
		idempotencyKey: "task-lifecycle-key",
		digestAlgorithm: "sha256",
		...overrides,
	};
	return parseTaskContract({ ...unsigned, digest: sha256CanonicalJson(unsigned) });
}

function makeAssignment(task: TaskContractV1, overrides: Record<string, unknown> = {}): AssignmentLeaseV1 {
	return parseAssignmentLease({
		schemaVersion: MESH_SCHEMA.assignment,
		assignmentId: "asg_lifecycle-001",
		taskId: task.taskId,
		taskDigest: task.digest,
		scheduler: { pubkey: SCHEDULER_PUBKEY, role: "scheduler" },
		schedulerEpoch: 1,
		fencingToken: 1,
		workerNodeId: NODE_ID,
		executorPubkey: NODE_PUBKEY,
		executionProfileId: "safe-profile",
		issuedAt: "2026-08-31T11:59:00.000Z",
		leaseExpiresAt: "2026-08-31T12:05:00.000Z",
		renewAfterSeconds: 15,
		permissionsDigest: sha256CanonicalJson(task.permissions),
		placementReason: { source: "test" },
		idempotencyKey: "assignment-lifecycle-key",
		...overrides,
	});
}

function signature(payload: Uint8Array): Uint8Array {
	return signatureEncoder.encode(`${SIGNATURE_ALGORITHM}:${SIGNATURE_KEY_ID}:${signatureDecoder.decode(payload).split("").reverse().join("")}`);
}

function schedulerSigner(actorPubkey = SCHEDULER_PUBKEY): MeshEnvelopeSigner {
	return Object.freeze({
		algorithm: SIGNATURE_ALGORITHM,
		keyId: SIGNATURE_KEY_ID,
		actorPubkey,
		role: "scheduler",
		sign: signature,
	});
}

const schedulerVerifier: MeshEnvelopeVerifier = Object.freeze({
	algorithm: SIGNATURE_ALGORITHM,
	keyId: SIGNATURE_KEY_ID,
	actorPubkey: SCHEDULER_PUBKEY,
	role: "scheduler",
	verify(payload, signed) {
		const expected = signature(payload);
		return expected.byteLength === signed.byteLength && expected.every((value, index) => value === signed[index]);
	},
});

async function signedAssignment(assignment: AssignmentLeaseV1, signer = schedulerSigner()) {
	return signAssignmentLease(assignment, signer, { signedAt: "2026-08-31T11:59:30.000Z" });
}

function makePresence(overrides: { readonly activeInteractiveUser?: boolean; readonly expiresAt?: string } = {}): MeshNodePresence {
	return projectNodeAdvertisement(
		parseNodeAdvertisement({
			schemaVersion: MESH_SCHEMA.node,
			nodeId: NODE_ID,
			actorPubkey: NODE_PUBKEY,
			generatedAt: "2026-08-31T11:59:00.000Z",
			expiresAt: overrides.expiresAt ?? "2026-08-31T12:10:00.000Z",
			trustZone: "private",
			interactive: true,
			draining: false,
			static: { totalSlots: 1 },
			dynamic: { availableSlots: 1, health: "healthy", activeInteractiveUser: overrides.activeInteractiveUser === true },
			capabilities: { names: ["safe.tool"], executionProfiles: ["safe-profile"] },
			reservations: {},
			profileVersion: "node-profile-1",
		}),
	);
}

function makePort(calls: ExecutionCalls, run: (context: MeshNodeExecutionContext) => Promise<MeshExecutionRunResult> = async () => ({ outcome: "succeeded", exitCode: 0 })): MeshNodeExecutionPort {
	return {
		async start(context) {
			calls.start += 1;
			calls.contexts.push(context);
		},
		async run(context) {
			calls.run += 1;
			calls.contexts.push(context);
			return run(context);
		},
		async heartbeat(context) {
			calls.heartbeat += 1;
			calls.contexts.push(context);
		},
		async cancel(context) {
			calls.cancel += 1;
			calls.contexts.push(context);
		},
		async cleanup(context) {
			calls.cleanup += 1;
			calls.contexts.push(context);
		},
	};
}

function createAgent(presence: MeshNodePresence, port: MeshNodeExecutionPort): MeshNodeAgent {
	return new MeshNodeAgent({
		identity: { nodeId: NODE_ID, pubkey: NODE_PUBKEY },
		execution: port,
		trustedSchedulerVerifiers: [schedulerVerifier],
		getPresence: () => presence,
		now: () => NOW,
	});
}

function calls(): ExecutionCalls {
	return { start: 0, run: 0, heartbeat: 0, cancel: 0, cleanup: 0, contexts: [] };
}

describe("MeshNodeAgent", () => {
	test("rejects stale and adversarial lease bindings before an adapter sees them", async () => {
		const task = makeTask();
		const stale = makeAssignment(task, { leaseExpiresAt: "2026-08-31T11:59:59.000Z" });
		const executionCalls = calls();
		const agent = createAgent(makePresence(), makePort(executionCalls));

		await expect(agent.accept({ task, signedAssignment: await signedAssignment(stale) })).rejects.toMatchObject({ code: "lease_expired" });
		expect(agent.events().at(-1)).toMatchObject({ type: "assignment.rejected", code: "lease_expired" });

		const adversarial = makeAssignment(task, { assignmentId: "asg_adversarial-001", executorPubkey: "x".repeat(64) });
		await expect(agent.accept({ task, signedAssignment: await signedAssignment(adversarial) })).rejects.toMatchObject({ code: "lease_invalid_binding" });
		expect(agent.events().at(-1)).toMatchObject({ type: "assignment.rejected", code: "lease_invalid_binding" });
		expect(executionCalls).toMatchObject({ start: 0, run: 0, heartbeat: 0, cancel: 0, cleanup: 0 });
	});

	test("local active-interactive policy remains final even when a task opts in", async () => {
		const task = makeTask({ routing: { requiredCapabilities: ["safe.tool"], trustZoneMin: "private", activeMachineAllowed: true } });
		const agent = createAgent(makePresence({ activeInteractiveUser: true }), makePort(calls()));

		await expect(agent.accept({ task, signedAssignment: await signedAssignment(makeAssignment(task)) })).rejects.toMatchObject({ code: "active_interactive_local" });
		expect(agent.events().at(-1)).toMatchObject({ type: "assignment.rejected", code: "active_interactive_local" });
	});

	test("runs through an injected bounded adapter, emits heartbeat, and prevents a second concurrent run", async () => {
		const runGate = Promise.withResolvers<MeshExecutionRunResult>();
		const executionCalls = calls();
		const task = makeTask();
		const assignment = makeAssignment(task);
		const agent = createAgent(makePresence(), makePort(executionCalls, async () => runGate.promise));

		await agent.accept({ task, signedAssignment: await signedAssignment(assignment) });
		await agent.start(assignment.assignmentId);
		const execution = agent.run(assignment.assignmentId);
		await Promise.resolve();
		expect(agent.state(assignment.assignmentId)).toBe("running");
		await expect(agent.run(assignment.assignmentId)).rejects.toMatchObject({ code: "assignment_state_invalid" });

		const heartbeat = await agent.heartbeat(assignment.assignmentId);
		expect(heartbeat).toMatchObject({ type: "execution.heartbeat", state: "running" });
		expect(executionCalls.heartbeat).toBe(1);
		expect(executionCalls.contexts[0]?.bounds).toEqual({ timeoutSeconds: 30, cpuMax: 1, retriesMax: 0 });

		runGate.resolve({ outcome: "succeeded", exitCode: 0 });
		await expect(execution).resolves.toMatchObject({ type: "execution.completed", outcome: "succeeded", exitCode: 0, state: "completed" });
	});

	test("does not append a late heartbeat after a concurrent terminal result", async () => {
		const runGate = Promise.withResolvers<MeshExecutionRunResult>();
		const heartbeatGate = Promise.withResolvers<void>();
		const executionCalls = calls();
		const task = makeTask();
		const assignment = makeAssignment(task);
		const port = makePort(executionCalls, async () => runGate.promise);
		port.heartbeat = async context => {
			executionCalls.heartbeat += 1;
			executionCalls.contexts.push(context);
			await heartbeatGate.promise;
		};
		const agent = createAgent(makePresence(), port);

		await agent.accept({ task, signedAssignment: await signedAssignment(assignment) });
		await agent.start(assignment.assignmentId);
		const execution = agent.run(assignment.assignmentId);
		await Promise.resolve();
		const heartbeat = agent.heartbeat(assignment.assignmentId);
		await Promise.resolve();
		runGate.resolve({ outcome: "succeeded", exitCode: 0 });
		await expect(execution).resolves.toMatchObject({ type: "execution.completed", state: "completed" });
		heartbeatGate.resolve();
		await expect(heartbeat).resolves.toMatchObject({ type: "execution.completed", state: "completed" });
		expect(agent.assignmentEvents(assignment.assignmentId).filter(event => event.type === "execution.heartbeat")).toHaveLength(0);
	});

	test("cancellation and cleanup are idempotent and invoke an adapter at most once", async () => {
		const executionCalls = calls();
		const task = makeTask();
		const assignment = makeAssignment(task);
		const port = makePort(executionCalls);
		const cancelGate = Promise.withResolvers<void>();
		const cleanupGate = Promise.withResolvers<void>();
		port.cancel = async context => {
			executionCalls.cancel += 1;
			executionCalls.contexts.push(context);
			await cancelGate.promise;
		};
		port.cleanup = async context => {
			executionCalls.cleanup += 1;
			executionCalls.contexts.push(context);
			await cleanupGate.promise;
		};
		const agent = createAgent(makePresence(), port);

		await agent.accept({ task, signedAssignment: await signedAssignment(assignment) });
		await agent.start(assignment.assignmentId);
		const firstCancel = agent.cancel(assignment.assignmentId);
		const duplicateCancel = agent.cancel(assignment.assignmentId);
		expect(executionCalls.cancel).toBe(1);
		cancelGate.resolve();
		const [cancelled, duplicateCancelled] = await Promise.all([firstCancel, duplicateCancel]);
		expect(duplicateCancelled).toBe(cancelled);

		const firstCleanup = agent.cleanup(assignment.assignmentId);
		const duplicateCleanup = agent.cleanup(assignment.assignmentId);
		expect(executionCalls.cleanup).toBe(1);
		cleanupGate.resolve();
		const [cleaned, duplicateCleaned] = await Promise.all([firstCleanup, duplicateCleanup]);
		expect(duplicateCleaned).toBe(cleaned);

		expect(executionCalls).toMatchObject({ start: 1, cancel: 1, cleanup: 1 });
		expect(agent.state(assignment.assignmentId)).toBe("cleaned");
		expect(agent.assignmentEvents(assignment.assignmentId).map(event => event.type)).toEqual([
			"assignment.accepted",
			"execution.starting",
			"execution.started",
			"execution.cancelling",
			"execution.cancelled",
			"execution.cleaning",
			"execution.cleaned",
		]);
	});

	test("rejects unsigned, altered, and untrusted scheduler deliveries before admission", async () => {
		const executionCalls = calls();
		const task = makeTask();
		const assignment = makeAssignment(task);
		const agent = createAgent(makePresence(), makePort(executionCalls));

		await expect(agent.accept({ task, signedAssignment: assignment })).rejects.toMatchObject({ code: "assignment_signature_unverified" });
		const signed = await signedAssignment(assignment);
		await expect(agent.accept({ task, signedAssignment: { ...signed, payloadDigest: "0".repeat(64) } })).rejects.toMatchObject({ code: "assignment_signature_unverified" });
		const alteredSignatureBase64 = `${signed.signature.signatureBase64.startsWith("A") ? "B" : "A"}${signed.signature.signatureBase64.slice(1)}`;
		await expect(agent.accept({ task, signedAssignment: { ...signed, signature: { ...signed.signature, signatureBase64: alteredSignatureBase64 } } })).rejects.toMatchObject({
			code: "assignment_signature_unverified",
		});

		const untrustedPubkey = "u".repeat(64);
		const untrustedAssignment = makeAssignment(task, {
			assignmentId: "asg_untrusted-scheduler-001",
			scheduler: { pubkey: untrustedPubkey, role: "scheduler" },
		});
		await expect(agent.accept({ task, signedAssignment: await signedAssignment(untrustedAssignment, schedulerSigner(untrustedPubkey)) })).rejects.toMatchObject({
			code: "scheduler_verifier_unavailable",
		});
		expect(executionCalls).toMatchObject({ start: 0, run: 0, heartbeat: 0, cancel: 0, cleanup: 0 });
	});

	test("deduplicates a verified delivery but rejects the same assignment id with a different signed payload", async () => {
		const executionCalls = calls();
		const task = makeTask();
		const firstAssignment = makeAssignment(task);
		const agent = createAgent(makePresence(), makePort(executionCalls));
		const signedFirstAssignment = await signedAssignment(firstAssignment);
		const first = await agent.accept({ task, signedAssignment: signedFirstAssignment });
		const duplicate = await agent.accept({ task, signedAssignment: signedFirstAssignment });

		expect(duplicate).toBe(first);
		expect(agent.assignmentEvents(firstAssignment.assignmentId)).toHaveLength(1);
		const differentTask = makeTask({ taskId: "task_lifecycle-duplicate-mismatch", idempotencyKey: "task-lifecycle-duplicate-mismatch" });
		await expect(agent.accept({ task: differentTask, signedAssignment: signedFirstAssignment })).rejects.toMatchObject({ code: "lease_invalid_binding" });
		const conflictingAssignment = makeAssignment(task, { leaseExpiresAt: "2026-08-31T12:06:00.000Z" });
		await expect(agent.accept({ task, signedAssignment: await signedAssignment(conflictingAssignment) })).rejects.toMatchObject({ code: "assignment_already_known" });
		expect(executionCalls).toMatchObject({ start: 0, run: 0, heartbeat: 0, cancel: 0, cleanup: 0 });
	});
});
