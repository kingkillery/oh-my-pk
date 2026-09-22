/**
 * Foundation-slice coverage for the in-memory↔durable authority unification:
 *
 * - `LifecycleAuthorityRegistration.authority` carries the §14.2
 *   LaunchAuthorityRefV1 for a persisted binding and stays null for
 *   in-memory contexts.
 * - `createHostRootExecutionContext` mints an issuer-only root context that
 *   can never answer a dispatch check.
 * - `ensureLaunchPrincipal` writes root/parent/child rows inside
 *   `admitLaunchAuthority`'s transaction.
 * - `createSessionRecordResolver` resolves artifact://, delivery:, grant:
 *   and contract://capsule refs against real store rows + ArtifactManager,
 *   and fails closed on anything else.
 * - `activateBoundSessionAuthority` performs resolve + projection bind in
 *   one seam so a bound session's provider requests project instead of
 *   failing `untrusted_context`.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { OperationalStore } from "../../src/operational/store";
import {
	activateBoundSessionAuthority,
	getLifecycleProjectionBinding,
	projectLifecycleSideRequest,
} from "../../src/orchestration/context-projector";
import { createSessionRecordResolver } from "../../src/orchestration/context-record-loader";
import {
	authorizeLifecycleAction,
	createHostRootExecutionContext,
	deriveChildLifecycleContext,
	getLifecycleRegistration,
	registerLifecycleExecutionContext,
	resolvePersistedLifecycleContext,
} from "../../src/orchestration/lifecycle-authority";
import { ArtifactManager } from "../../src/session/artifacts";
import { canonicalJson, type LaunchBinding, sha256Hex } from "../../src/task/launch-contract";
import {
	createTestArtifactRef,
	createTestCompiledContract,
	createTestEnvelope,
	createTestPolicy,
	createTestRuntimeGuarantees,
} from "../helpers/lifecycle-fixtures";

const rootActor = createHostRootExecutionContext({
	sessionId: "foundation-root",
	rootPrincipalId: "principal-root",
	policy: createTestPolicy({ role: "root-planner" }),
	authority: createTestEnvelope(),
});
const GUARD = { actor: rootActor, expectedPolicyEpoch: 1, idempotencyKey: "guard-1" };

function rootIssuedContract() {
	return createTestCompiledContract(
		{},
		{},
		{ issuerPrincipalId: "principal-root", parentPrincipalId: "principal-root" },
	);
}

function tempDir(label: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), `omp-foundation-${label}-`));
}

/** Admit + activate a binding so it reaches the live `bound` state. */
function admitAndActivate(store: OperationalStore): { bindingId: string; binding: LaunchBinding } {
	const compiled = rootIssuedContract();
	const admitted = store.admitLaunchAuthority({
		guard: GUARD,
		compiled,
		reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
		lifecycle: null,
		restoresBindingId: null,
	});
	if (!admitted.ok) throw new Error(`fixture admission failed: ${admitted.code}`);
	const bindingId = admitted.launch.binding.bindingId;
	const activated = store.activateLaunchBinding({
		guard: GUARD,
		bindingId,
		expectedState: "authorized",
		sessionId: "session-1",
		processRef: null,
		serviceBindings: [],
		actualRuntimeGuarantees: createTestRuntimeGuarantees(),
		guaranteeEvidenceRefs: [createTestArtifactRef("evidence-1")],
	});
	if (!activated.ok) throw new Error(`fixture activation failed: ${activated.code}`);
	return { bindingId, binding: store.getLaunchBinding(bindingId) };
}

describe("registration authority ref (§14.2)", () => {
	it("populates the durable identity on a persisted-binding context", async () => {
		const dir = await tempDir("authority-ref");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { binding } = admitAndActivate(store);
			const contract = store.getLaunchContract(binding.contractDigest);
			const context = resolvePersistedLifecycleContext({ binding, contract, repoRoot: "/repo" });
			const registration = getLifecycleRegistration(context);
			expect(registration?.authority).toEqual({
				bindingId: binding.bindingId,
				principalId: binding.childPrincipalId,
				attemptId: binding.attemptId,
				contractId: binding.contractId,
				contractRevision: binding.contractRevision,
				contractDigest: binding.contractDigest,
				policyEpoch: binding.policyEpoch,
			});
			expect(registration?.root).toBeNull();
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("keeps authority null for in-memory registrations and derivations", () => {
		const parent = registerLifecycleExecutionContext({
			mode: "hierarchical-v1",
			role: "root-planner",
			runId: "run-1",
			nodeId: "node-1",
			attemptId: "att-1",
			policyEpoch: 1,
			usableCapabilities: [],
			repoRoot: "/repo",
			readableRoots: [],
			writableRoots: [],
			allowExternalWrite: false,
		});
		expect(getLifecycleRegistration(parent)?.authority).toBeNull();
		const child = deriveChildLifecycleContext(parent, { role: "worker", nodeId: "n2", attemptId: "a2" });
		expect(getLifecycleRegistration(child)?.authority).toBeNull();
	});
});

describe("createHostRootExecutionContext (§14.6)", () => {
	it("registers an issuer record with a stable root principal", () => {
		const root = createHostRootExecutionContext({
			sessionId: "sess-1",
			policy: createTestPolicy({ role: "root-planner" }),
			authority: createTestEnvelope(),
			policyEpoch: 3,
		});
		const registration = getLifecycleRegistration(root);
		expect(registration?.root?.rootPrincipalId).toBe("principal-root-sess-1");
		expect(registration?.root?.issuerPolicyEpoch).toBe(3);
		expect(registration?.root?.authorityEnvelope.schemaVersion).toBe(1);
		expect(registration?.authority).toBeNull();
		expect(registration?.role).toBe("root-planner");
	});

	it("fails closed on dispatch: a root is an issuer, never a bound child", () => {
		const root = createHostRootExecutionContext({
			sessionId: "sess-2",
			policy: createTestPolicy({ role: "root-planner" }),
			authority: createTestEnvelope(),
		});
		const decision = authorizeLifecycleAction(root, {
			tool: { source: "builtin", name: "read" },
			action: "read_resource",
			targets: ["src/x.ts"],
			effect: "read",
			invocationId: "inv-1",
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe("missing_lifecycle_binding");
	});

	it("snapshots the envelope so caller mutation cannot rewrite issuer authority", () => {
		// Mutable copies: the fixture ships frozen, so spread to get objects
		// the caller could plausibly mutate after registration.
		const envelope = {
			...createTestEnvelope(),
			spawn: { ...createTestEnvelope().spawn, maySpawn: false },
		};
		const root = createHostRootExecutionContext({
			sessionId: "sess-3",
			policy: createTestPolicy({ role: "root-planner" }),
			authority: envelope,
		});
		envelope.spawn.maySpawn = true;
		const registration = getLifecycleRegistration(root);
		expect(registration?.root?.authorityEnvelope.spawn.maySpawn).toBe(false);
	});
});

describe("ensureLaunchPrincipal (§14.5)", () => {
	it("writes root, parent and child principal rows inside admission", async () => {
		const dir = await tempDir("principals");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const compiled = rootIssuedContract();
			const admitted = store.admitLaunchAuthority({
				guard: GUARD,
				compiled,
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				lifecycle: null,
				restoresBindingId: null,
			});
			expect(admitted.ok).toBe(true);

			const root = store.getLaunchPrincipal(compiled.rootPrincipalId);
			expect(root?.rootPrincipalId).toBe(compiled.rootPrincipalId);
			expect(root?.parentPrincipalId).toBeNull();

			const parent = store.getLaunchPrincipal(compiled.parentPrincipalId);
			expect(parent?.rootPrincipalId).toBe(compiled.rootPrincipalId);

			const child = store.getLaunchPrincipal(compiled.childPrincipalId);
			expect(child?.rootPrincipalId).toBe(compiled.rootPrincipalId);
			expect(child?.parentPrincipalId).toBe(compiled.parentPrincipalId);
			expect(child?.authorityEnvelopeRef).toBe(compiled.contractDigest);
			expect(child?.launchClass).toBe(compiled.authority.launchClass);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("is idempotent: a replayed admission never duplicates or rewrites rows", async () => {
		const dir = await tempDir("principals-idem");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const compiled = rootIssuedContract();
			const input = {
				guard: GUARD,
				compiled,
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				lifecycle: null,
				restoresBindingId: null,
			};
			expect(store.admitLaunchAuthority(input).ok).toBe(true);
			expect(store.admitLaunchAuthority(input).ok).toBe(true);
			const db = new Database(store.dbPath, { readonly: true });
			try {
				const rows = db
					.prepare("SELECT COUNT(*) AS n FROM launch_principals WHERE principal_id = ?")
					.get(compiled.childPrincipalId) as { n: number };
				expect(rows.n).toBe(1);
			} finally {
				db.close();
			}
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});
});

describe("createSessionRecordResolver", () => {
	it("resolves artifact:// refs through the ArtifactManager", async () => {
		const dir = await tempDir("resolver-artifact");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const artifacts = new ArtifactManager(path.join(dir, "artifacts"));
			const content = "spilled tool output bytes";
			const id = await artifacts.save(content, "read");
			const resolve = createSessionRecordResolver({ artifactManager: artifacts, store });
			await expect(resolve({ uri: `artifact://${id}`, sha256: sha256Hex(content), bytes: null })).resolves.toBe(
				content,
			);
			await expect(
				resolve({ uri: "artifact://missing-999", sha256: sha256Hex(content), bytes: null }),
			).rejects.toThrow(/artifact_not_found/);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("resolves delivery: and grant: payload refs through store rows", async () => {
		const dir = await tempDir("resolver-records");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		const db = new Database(store.dbPath);
		try {
			const { binding } = admitAndActivate(store);
			const artifacts = new ArtifactManager(path.join(dir, "artifacts"));
			const payload = "delivered mission payload";
			const payloadId = await artifacts.save(payload, "task");
			// Issue the grant BEFORE the delivery: delivery admission bumps the
			// binding's policy epoch, which would stale the grant guard.
			const granted = store.appendLaunchGrant({
				guard: GUARD,
				request: {
					idempotencyKey: "grant-resolver-1",
					issuerPrincipalId: binding.parentPrincipalId,
					recipientPrincipalId: binding.childPrincipalId,
					recipientBindingId: binding.bindingId,
					resource: {
						kind: "artifact",
						resourceId: `artifact://${payloadId}`,
						versionDigest: sha256Hex(payload),
						scope: { roots: [], exactIds: [`artifact://${payloadId}`], maxBytes: null, range: null },
					},
					operations: ["read"],
					delegableOperations: [],
					recipientConstraints: [],
					remainingDelegationDepth: 0,
					domains: ["public-task"],
					sourceGrantIds: [],
					contractRevision: binding.contractRevision,
					attemptId: binding.attemptId,
					expiresAt: null,
					purpose: "evidence grant",
				},
			});
			expect(granted).toMatchObject({ ok: true });
			if (!granted.ok) return;

			db.run(
				`INSERT OR IGNORE INTO launch_channels (binding_id, channel_id, canonical_json, policy_epoch, created_at, updated_at)
				 VALUES (?, 'chan-1', ?, 1, 1, 1)`,
				[
					binding.bindingId,
					JSON.stringify({
						maxMessageBytes: 8192,
						maxTotalBytes: 65536,
						maxMessages: 16,
						domains: ["public-task"],
					}),
				],
			);
			const delivered = store.admitLaunchDelivery({
				guard: GUARD,
				request: {
					deliveryId: "d-1",
					channelId: "chan-1",
					recipientBindingId: binding.bindingId,
					expectedPolicyEpoch: 1,
					attemptId: binding.attemptId,
					contractRevision: binding.contractRevision,
					contextGeneration: 0,
					grantRefs: [],
					payloadRef: createTestArtifactRef("art-d1", sha256Hex(payload), `artifact://${payloadId}`),
					resourceRefs: [],
					domains: ["public-task"],
					kind: "assignment",
				},
				senderPrincipalId: binding.parentPrincipalId,
				bytes: Buffer.byteLength(payload, "utf8"),
			});
			expect(delivered.ok).toBe(true);

			const resolve = createSessionRecordResolver({
				artifactManager: artifacts,
				store,
				bindingId: binding.bindingId,
				db,
			});
			await expect(resolve({ uri: "delivery:d-1", sha256: sha256Hex(payload), bytes: null })).resolves.toBe(payload);
			await expect(
				resolve({ uri: `grant:${granted.grant.grantId}`, sha256: sha256Hex(payload), bytes: null }),
			).resolves.toBe(payload);
		} finally {
			db.close();
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("resolves contract://capsule by pinned digest and fails closed elsewhere", async () => {
		const dir = await tempDir("resolver-capsule");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		const db = new Database(store.dbPath);
		try {
			const { binding } = admitAndActivate(store);
			const contract = store.getLaunchContract(binding.contractDigest);
			const artifacts = new ArtifactManager(path.join(dir, "artifacts"));
			const resolve = createSessionRecordResolver({ artifactManager: artifacts, store, db });
			const capsuleText = canonicalJson(contract.capsule);
			await expect(
				resolve({ uri: "contract://capsule", sha256: sha256Hex(capsuleText), bytes: null }),
			).resolves.toBe(capsuleText);
			await expect(resolve({ uri: "contract://capsule", sha256: "0".repeat(64), bytes: null })).rejects.toThrow(
				/contract_capsule_not_found/,
			);
			await expect(resolve({ uri: "memory://note-1", sha256: "0".repeat(64), bytes: null })).rejects.toThrow(
				/unsupported_record_uri/,
			);
		} finally {
			db.close();
			store.close();
		}
	});
});

describe("activateBoundSessionAuthority", () => {
	it("resolves the context and binds projection in one seam", async () => {
		const dir = await tempDir("activate-bound");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { binding } = admitAndActivate(store);
			const contract = store.getLaunchContract(binding.contractDigest);
			const artifacts = new ArtifactManager(path.join(dir, "artifacts"));
			const lifecycle = activateBoundSessionAuthority({
				store,
				binding,
				contract,
				repoRoot: "/repo",
				artifactManager: artifacts,
				toolSourceOf: name => (name === "read" ? "builtin" : undefined),
			});
			const registration = getLifecycleRegistration(lifecycle);
			expect(registration?.authority?.bindingId).toBe(binding.bindingId);
			expect(getLifecycleProjectionBinding(lifecycle)?.bindingId).toBe(binding.bindingId);
			// A bound session's provider request projects instead of failing
			// untrusted_context.
			const projected = await projectLifecycleSideRequest(
				{ messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] },
				"completion",
				lifecycle,
			);
			expect(projected.messages).toHaveLength(1);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});
});
