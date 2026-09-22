import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { OperationalStore } from "../../src/operational/store";
import {
	createHostRootExecutionContext,
	getLifecycleRegistration,
	type LifecycleExecutionContext,
	type RootExecutionContext,
} from "../../src/orchestration/lifecycle-authority";
import { type LaunchAdmissionRequest, prepareLifecycleLaunch } from "../../src/task/launch-admission";
import {
	compileLaunchContract,
	type MissionCapsule,
	type RuntimePolicySnapshotV1,
} from "../../src/task/launch-contract";
import { createSpawnPlan, type SpawnPlan } from "../../src/task/spawn-plan";
import {
	createTestArtifactRef,
	createTestAuthorizationSnapshot,
	createTestCapsule,
	createTestEnvelope,
	createTestGrantRecord,
	createTestPolicy,
	createTestRunLimits,
	createTestRuntimeGuarantees,
} from "../helpers/lifecycle-fixtures";

// Scenario-specific budget: room for a root plus the admitted child.
const ADMISSION_LIMITS = Object.freeze({
	...createTestRunLimits(),
	maxNodes: 4,
	maxDepth: 2,
	maxAttemptsPerNode: 2,
	maxOutstanding: 4,
	maxActiveCompute: 2,
	maxRequests: 10,
	maxRuntimeMs: 60_000,
	maxComputeRuntimeMs: 30_000,
	maxTokens: null,
	maxCostMicrounits: null,
	currency: null,
	maxHandoffBytes: 16_384,
	maxInboxEvents: 20,
});

function makeSpawnPlan(): SpawnPlan {
	const planned = createSpawnPlan({
		correlationId: "corr-admit-1",
		agentName: "oracle",
		assignment: "Admit a bounded child mission",
		modelPatterns: ["pi/smol"],
		softRequestBudget: 2,
		maxRuntimeMs: 10_000,
	});
	if (!planned.ok) throw new Error("SpawnPlan fixture failed to compile");
	return planned.plan;
}

function makeCapsule(): MissionCapsule {
	return createTestCapsule({
		objective: "Admit a bounded child mission",
		writableScope: Object.freeze(["src/child.ts"]),
	});
}

function makePolicy(): RuntimePolicySnapshotV1 {
	return createTestPolicy({ limits: ADMISSION_LIMITS });
}

/** Issuer holds exactly the grants the child policy asks for. */
function makeAuthorization(policy: RuntimePolicySnapshotV1) {
	return createTestAuthorizationSnapshot({
		// The root actor issues for itself: parent IS the root principal.
		issuerPrincipalId: "principal-root",
		parentPrincipalId: "principal-root",
		sourceGrants: policy.grantRefs.map(grantId => createTestGrantRecord({ grantId })),
	});
}

function makeOwner(): RootExecutionContext {
	return createHostRootExecutionContext({
		sessionId: "owner-1",
		policy: makePolicy(),
		authority: createTestEnvelope(),
		rootPrincipalId: "principal-root",
	});
}

function makeRequest(overrides?: {
	capsule?: MissionCapsule;
	owner?: LifecycleExecutionContext | RootExecutionContext | null;
	services?: LaunchAdmissionRequest["services"];
}): LaunchAdmissionRequest {
	const policy = makePolicy();
	return {
		spawnPlan: makeSpawnPlan(),
		compileInput: {
			capsule: overrides?.capsule ?? makeCapsule(),
			policy,
			authorization: makeAuthorization(policy),
			requiredInputIds: [],
		},
		owner: overrides === undefined || overrides.owner === undefined ? makeOwner() : overrides.owner,
		idempotencyKey: "key-child-1",
		reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
		prerequisiteIds: [],
		services: overrides?.services ?? {
			confinedBackend: null,
			measuredGuarantees: createTestRuntimeGuarantees(),
			guaranteeEvidenceRefs: [createTestArtifactRef("artifact-probe")],
			sessionId: "session-child-1",
		},
	};
}

function openStore(label: string): OperationalStore {
	return OperationalStore.open({ dbPath: path.join(os.tmpdir(), `admit-${label}-${Date.now()}.db`) });
}

describe("Lifecycle launch admission (B1)", () => {
	it("rejects invalid scope with diagnostics and zero allocations", () => {
		const store = openStore("invalid");
		try {
			const result = prepareLifecycleLaunch(
				store,
				makeRequest({ capsule: { ...makeCapsule(), writableScope: ["../escape.ts"] } }),
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.diagnostics.length).toBeGreaterThan(0);
			// Compile failure must not have admitted any authority record.
			expect(() => store.getLaunchBindingByAttempt("attempt-contract-1-1")).toThrowError(/not found/);
		} finally {
			store.close();
		}
	});

	it("creates a root run through the authenticated ownerless factory", () => {
		const store = openStore("root");
		try {
			const result = prepareLifecycleLaunch(store, makeRequest({ owner: null }));
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.job?.id).toBeTruthy();
			expect(result.plan.agentName).toBe("oracle");
			expect(result.launch.binding.lifecycle?.runId).toBe("run-contract-1");
		} finally {
			store.close();
		}
	});

	it("admits and binds a delegated child: compile → admit → activate", () => {
		const store = openStore("child");
		try {
			const owner = makeOwner();
			const result = prepareLifecycleLaunch(store, makeRequest({ owner }));
			expect(result.ok).toBe(true);
			if (!result.ok) return;

			const bindingId = result.launch.binding.bindingId;
			const binding = store.getLaunchBinding(bindingId);
			// The wire already carries the post-activation row; the store read
			// must agree with it exactly.
			expect(result.launch.binding).toEqual(binding);
			// Activation ran: the binding is bound with measured guarantees, not
			// left authorized, and carries the pre-allocated session identity.
			expect(binding.state).toBe("bound");
			expect(binding.sessionId).toBe("session-child-1");
			expect(binding.actualRuntimeGuarantees).not.toBeNull();
			expect(binding.guaranteeEvidenceRefs.length).toBe(1);
			expect(binding.policyEpoch).toBe(getLifecycleRegistration(owner)?.policyEpoch ?? Number.NaN);

			// §14.6: authority-only admission carries no scheduler job — the
			// durable binding row is the execution record.
			expect(result.job).toBeNull();
		} finally {
			store.close();
		}
	});

	it("replays admission idempotently instead of double-binding", () => {
		const store = openStore("replay");
		try {
			const request = makeRequest();
			const first = prepareLifecycleLaunch(store, request);
			expect(first.ok).toBe(true);
			// Second admission with the same attempt identity replays the recorded
			// allocation; activation then CAS-fails because the binding is bound.
			const second = prepareLifecycleLaunch(store, request);
			expect(second.ok).toBe(false);
			if (second.ok) return;
			expect(second.code).toBe("launch_binding_state_conflict");
		} finally {
			store.close();
		}
	});

	it("fails closed on an unregistered owner context", () => {
		const store = openStore("unregistered");
		try {
			const forged = {} as LifecycleExecutionContext;
			const result = prepareLifecycleLaunch(store, makeRequest({ owner: forged }));
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("missing_lifecycle_binding");
		} finally {
			store.close();
		}
	});

	it("refuses a delegated launch without host-measured guarantees", () => {
		const store = openStore("no-probe");
		try {
			const result = prepareLifecycleLaunch(store, makeRequest({ services: { confinedBackend: null } }));
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("missing_required_input");
		} finally {
			store.close();
		}
	});

	it("terminalizes the binding when activation is refused", () => {
		const store = openStore("shortfall");
		try {
			const result = prepareLifecycleLaunch(
				store,
				makeRequest({
					services: {
						confinedBackend: null,
						// Ambient everywhere: cannot satisfy the strict requirements.
						measuredGuarantees: {
							initialContext: "legacy-inherited",
							transcriptAccess: "ambient",
							serviceAccess: "ambient",
							artifactAccess: "ambient",
							memoryAccess: "ambient",
							evalState: "ambient",
							filesystemRead: "ambient",
							filesystemWrite: "ambient",
							process: "ambient",
							network: "ambient",
							credentials: "ambient",
						},
						guaranteeEvidenceRefs: [createTestArtifactRef("artifact-probe")],
						sessionId: "session-child-1",
					},
				}),
			);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("required_isolation_unavailable");
			// The failed attempt's audit row survives: terminalized, never bound.
			const compiled = compileLaunchContract({
				capsule: makeCapsule(),
				policy: makePolicy(),
				authorization: makeAuthorization(makePolicy()),
				requiredInputIds: [],
			});
			if (!compiled.ok) throw new Error("recompile failed");
			const binding = store.getLaunchBindingByAttempt(
				`attempt-${compiled.compiled.contractId}-${compiled.compiled.contractRevision}`,
			);
			expect(binding.state).toBe("failed");
		} finally {
			store.close();
		}
	});

	it("honors a pre-aborted signal without touching the store", () => {
		const store = openStore("aborted");
		try {
			const controller = new AbortController();
			controller.abort();
			const result = prepareLifecycleLaunch(store, makeRequest(), controller.signal);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("launch_aborted");
		} finally {
			store.close();
		}
	});

	it("terminalizes the binding when the signal aborts after admission", () => {
		const store = openStore("post-abort");
		try {
			const controller = new AbortController();
			// Abort inside the admission call so the post-commit check fires.
			const proxied = new Proxy(store, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (prop === "admitLaunchAuthority") {
						return (input: Parameters<OperationalStore["admitLaunchAuthority"]>[0]) => {
							const result = store.admitLaunchAuthority(input);
							controller.abort();
							return result;
						};
					}
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const result = prepareLifecycleLaunch(proxied, makeRequest(), controller.signal);
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("launch_aborted");
			const compiled = compileLaunchContract({
				capsule: makeCapsule(),
				policy: makePolicy(),
				authorization: makeAuthorization(makePolicy()),
				requiredInputIds: [],
			});
			if (!compiled.ok) throw new Error("recompile failed");
			const binding = store.getLaunchBindingByAttempt(
				`attempt-${compiled.compiled.contractId}-${compiled.compiled.contractRevision}`,
			);
			expect(binding.state).toBe("failed");
		} finally {
			store.close();
		}
	});
});
