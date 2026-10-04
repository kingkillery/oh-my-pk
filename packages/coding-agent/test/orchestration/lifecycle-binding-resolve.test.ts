/**
 * §4.3 resolve-existing coverage: a revived session must rebind to the SAME
 * persisted launch binding — never a second admission —
 * and a missing, revoked or mismatched record must fail closed.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, removeWithRetries, setAgentDir } from "@pk-nerdsaver-ai/pi-utils";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { LifecycleAuthorityStore } from "../../src/operational/lifecycle-authority-store";
import {
	getLifecycleProjectionBinding,
	getProjectionManifest,
	projectLifecycleSideRequest,
} from "../../src/orchestration/context-projector";
import {
	createHostRootExecutionContext,
	getLifecycleRegistration,
	resolvePersistedLifecycleContext,
} from "../../src/orchestration/lifecycle-authority";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as sdkModule from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import type { SessionLaunchAuthorityV1 } from "../../src/session/session-entries";
import type { LaunchBinding } from "../../src/task/launch-contract";
import { createPersistedSubagentReviverFactory } from "../../src/task/persisted-revive";
import { EventBus } from "../../src/utils/event-bus";
import {
	createTestArtifactRef,
	createTestCompiledContract,
	createTestEnvelope,
	createTestPolicy,
	createTestRuntimeGuarantees,
	createTestSpawnAuthority,
} from "../helpers/lifecycle-fixtures";

function tempDir(label: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), `omp-${label}-`));
}

function hostActor() {
	return createHostRootExecutionContext({
		sessionId: "session-root",
		rootPrincipalId: "principal-root",
		policy: createTestPolicy({ role: "root-planner" }),
		authority: createTestEnvelope({
			usableCapabilities: [
				{ source: "builtin", name: "read" },
				{ source: "builtin", name: "edit" },
			],
			delegableCapabilities: [
				{ source: "builtin", name: "read" },
				{ source: "builtin", name: "edit" },
			],
			spawn: createTestSpawnAuthority({ maySpawn: true, mayDelegateSpawn: true, maxDepth: 4, maxChildren: 16 }),
		}),
	});
}

/** Admit + activate a binding so it reaches the live `bound` state. */
function admitAndActivate(store: LifecycleAuthorityStore) {
	const compiled = createTestCompiledContract(
		{},
		{},
		{ parentPrincipalId: "principal-root", issuerPrincipalId: "principal-root" },
	);
	const guard = { actor: hostActor(), expectedPolicyEpoch: 1, idempotencyKey: `idem-${crypto.randomUUID()}` };
	const admitted = store.admitLaunchAuthority({
		guard,
		compiled,
		restoresBindingId: null,
	});
	expect(admitted.ok).toBe(true);
	const attemptId = `attempt-${compiled.contractId}-${compiled.contractRevision}`;
	const bindingId = `binding-${compiled.contractId}-${compiled.contractRevision}-${attemptId}`;
	const activated = store.activateLaunchBinding({
		guard,
		bindingId,
		expectedState: "authorized",
		sessionId: "session-1",
		processRef: null,
		serviceBindings: [],
		actualRuntimeGuarantees: createTestRuntimeGuarantees(),
		guaranteeEvidenceRefs: [createTestArtifactRef("evidence-1")],
	});
	expect(activated.ok).toBe(true);
	return { compiled, bindingId, attemptId };
}

function pinFor(binding: LaunchBinding): SessionLaunchAuthorityV1 {
	return {
		schemaVersion: 1,
		kind: "delegated-child",
		bindingId: binding.bindingId,
		principalId: binding.childPrincipalId,
		attemptId: binding.attemptId,
		contractId: binding.contractId,
		contractRevision: binding.contractRevision,
		contractDigest: binding.contractDigest,
		policyEpoch: binding.policyEpoch,
		contextGeneration: binding.contextGeneration,
	};
}

describe("getLaunchBindingByAttempt", () => {
	it("returns the binding recorded for an attempt", async () => {
		const dir = await tempDir("by-attempt");
		const store = LifecycleAuthorityStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId, attemptId } = admitAndActivate(store);
			const binding = store.getLaunchBindingByAttempt(attemptId);
			expect(binding.bindingId).toBe(bindingId);
			expect(binding.state).toBe("bound");
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("throws for an unknown attempt", async () => {
		const dir = await tempDir("by-attempt-missing");
		const store = LifecycleAuthorityStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			expect(() => store.getLaunchBindingByAttempt("att-nope")).toThrow(/not found/);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});
});

describe("resolvePersistedLifecycleContext", () => {
	it("re-registers the same authority for a live binding", async () => {
		const dir = await tempDir("resolve-live");
		const store = LifecycleAuthorityStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId } = admitAndActivate(store);
			const binding = store.getLaunchBinding(bindingId);
			const contract = store.getLaunchContract(binding.contractDigest);
			const context = resolvePersistedLifecycleContext({
				binding,
				contract,
				repoRoot: "/repo",
				pin: pinFor(binding),
			});
			const registration = getLifecycleRegistration(context);
			expect(registration?.mode).toBe("hierarchical-v1");
			expect(registration?.role).toBe("worker");
			// Authority-only bindings carry no scheduler lifecycle, so the
			// registration stands in durable identities for run and node.
			expect(registration?.runId).toBe(bindingId);
			expect(registration?.nodeId).toBe(binding.childPrincipalId);
			expect(registration?.attemptId).toBe(binding.attemptId);
			expect(registration?.policyEpoch).toBe(1);
			expect(registration?.readableRoots).toEqual(["src/"]);
			expect(registration?.writableRoots).toEqual(["src/"]);
			expect(registration?.allowExternalWrite).toBe(false);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("fails closed for a binding that never reached a live state", async () => {
		const dir = await tempDir("resolve-authorized");
		const store = LifecycleAuthorityStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const compiled = createTestCompiledContract(
				{},
				{},
				{ parentPrincipalId: "principal-root", issuerPrincipalId: "principal-root" },
			);
			const admitted = store.admitLaunchAuthority({
				guard: { actor: hostActor(), expectedPolicyEpoch: 1, idempotencyKey: "idem-authorized" },
				compiled,
				restoresBindingId: null,
			});
			expect(admitted.ok).toBe(true);
			const attemptId = `attempt-${compiled.contractId}-${compiled.contractRevision}`;
			const binding = store.getLaunchBindingByAttempt(attemptId);
			expect(binding.state).toBe("authorized");
			expect(() => resolvePersistedLifecycleContext({ binding, contract: compiled, repoRoot: "/repo" })).toThrow(
				/missing_lifecycle_binding/,
			);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("fails closed for a revoked binding", async () => {
		const dir = await tempDir("resolve-revoked");
		const dbPath = path.join(dir, "op.db");
		const store = LifecycleAuthorityStore.open({ dbPath });
		try {
			const { bindingId } = admitAndActivate(store);
			const binding = store.getLaunchBinding(bindingId);
			const contract = store.getLaunchContract(binding.contractDigest);
			const raw = new Database(dbPath);
			try {
				raw.run("UPDATE launch_bindings SET state = 'revoked' WHERE binding_id = ?", [bindingId]);
			} finally {
				raw.close();
			}
			const revoked = store.getLaunchBinding(bindingId);
			expect(() => resolvePersistedLifecycleContext({ binding: revoked, contract, repoRoot: "/repo" })).toThrow(
				/missing_lifecycle_binding/,
			);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("fails closed when the persisted pin disagrees with the binding", async () => {
		const dir = await tempDir("resolve-pin");
		const store = LifecycleAuthorityStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId } = admitAndActivate(store);
			const binding = store.getLaunchBinding(bindingId);
			const contract = store.getLaunchContract(binding.contractDigest);
			expect(() =>
				resolvePersistedLifecycleContext({
					binding,
					contract,
					repoRoot: "/repo",
					pin: { ...pinFor(binding), contractDigest: "forged-digest" },
				}),
			).toThrow(/lifecycle_authority_mismatch/);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("fails closed when the contract is not the binding's admitted contract", async () => {
		const dir = await tempDir("resolve-contract");
		const store = LifecycleAuthorityStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId } = admitAndActivate(store);
			const binding = store.getLaunchBinding(bindingId);
			const other = createTestCompiledContract({ objective: "a different mission" });
			expect(() => resolvePersistedLifecycleContext({ binding, contract: other, repoRoot: "/repo" })).toThrow(
				/lifecycle_authority_mismatch/,
			);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});
});

describe("persisted subagent revive authority", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	function mockSession(): AgentSession {
		return {
			sessionManager: { getArtifactManager: () => undefined },
			setActiveToolsByName: async () => {},
			setCollaborationPolicy: () => {},
			subscribe: () => () => {},
			dispose: async () => {},
		} as unknown as AgentSession;
	}

	function topSession(cwd: string): AgentSession {
		return {
			sessionManager: { getCwd: () => cwd, getArtifactManager: () => undefined },
			clientBridge: undefined,
		} as unknown as AgentSession;
	}

	function mockCreateSession() {
		return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: mockSession(),
			extensionsResult: { extensions: [], errors: [], runtime: {} } as never,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		});
	}

	async function writeSessionFile(dir: string, launchAuthority?: SessionLaunchAuthorityV1) {
		const sessionFile = path.join(dir, "Child.jsonl");
		await Bun.write(
			sessionFile,
			[
				JSON.stringify({ type: "session", id: "child", timestamp: new Date().toISOString(), cwd: dir }),
				JSON.stringify({
					type: "session_init",
					id: "init",
					parentId: null,
					timestamp: new Date().toISOString(),
					systemPrompt: "system",
					task: "task",
					tools: ["yield"],
					...(launchAuthority ? { launchAuthority } : {}),
				}),
			].join("\n"),
		);
		return sessionFile;
	}

	it("rebinds a revived session to its persisted launch authority", async () => {
		const dir = await tempDir("revive-bound");
		const store = LifecycleAuthorityStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId } = admitAndActivate(store);
			const binding = store.getLaunchBinding(bindingId);
			const sessionFile = await writeSessionFile(dir, pinFor(binding));
			const spy = mockCreateSession();
			const factory = createPersistedSubagentReviverFactory({
				session: topSession(dir),
				authStorage: {} as unknown as AuthStorage,
				modelRegistry: {} as unknown as ModelRegistry,
				settings: Settings.isolated(),
				enableLsp: false,
				store,
			});
			const reviver = await factory({
				id: "Child",
				kind: "agent",
				status: "parked",
				displayName: "Child",
				sessionFile,
				parentId: "Main",
			} as never);
			expect(reviver).toBeDefined();
			await reviver!();
			const options = spy.mock.calls[0]?.[0];
			expect(options?.lifecycleExecutionContext).toBeDefined();
			const registration = getLifecycleRegistration(options!.lifecycleExecutionContext!);
			expect(registration?.attemptId).toBe(binding.attemptId);
			expect(registration?.runId).toBe(bindingId);
			expect(registration?.nodeId).toBe(binding.childPrincipalId);
			// The revive must attach the projection binding too — without it the
			// bound context still fails closed `untrusted_context` on every
			// provider request.
			const projection = getLifecycleProjectionBinding(options!.lifecycleExecutionContext!);
			expect(projection?.bindingId).toBe(bindingId);
			expect(projection?.grantGeneration).toBe(binding.policyEpoch);
			expect(typeof projection?.toolSourceOf).toBe("function");
			// A side request now projects instead of throwing untrusted_context.
			const projected = await projectLifecycleSideRequest(
				{ systemPrompt: ["sys"], messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				"compact",
				options!.lifecycleExecutionContext!,
			);
			expect(getProjectionManifest(projected)?.phase).toBe("side-request");
			expect(projected.messages).toHaveLength(1);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("stays legacy, without opening the authority store, when the session file carries no pin", async () => {
		const dir = await tempDir("revive-legacy");
		const originalAgentDir = getAgentDir();
		setAgentDir(dir);
		try {
			const sessionFile = await writeSessionFile(dir);
			const spy = mockCreateSession();
			// No injected store: a pinless revive must not reach the default one.
			const factory = createPersistedSubagentReviverFactory({
				session: topSession(dir),
				authStorage: {} as unknown as AuthStorage,
				modelRegistry: {} as unknown as ModelRegistry,
				settings: Settings.isolated(),
				enableLsp: false,
			});
			const reviver = await factory({
				id: "Child",
				kind: "agent",
				status: "parked",
				displayName: "Child",
				sessionFile,
				parentId: "Main",
			} as never);
			await reviver!();
			expect(spy.mock.calls[0]?.[0]?.lifecycleExecutionContext).toBeUndefined();
			expect(await Bun.file(path.join(dir, "lifecycle-authority.db")).exists()).toBe(false);
		} finally {
			setAgentDir(originalAgentDir);
			await removeWithRetries(dir);
		}
	});

	it("fails closed when the persisted binding was revoked", async () => {
		const dir = await tempDir("revive-revoked");
		const dbPath = path.join(dir, "op.db");
		const store = LifecycleAuthorityStore.open({ dbPath });
		try {
			const { bindingId } = admitAndActivate(store);
			const binding = store.getLaunchBinding(bindingId);
			const sessionFile = await writeSessionFile(dir, pinFor(binding));
			const raw = new Database(dbPath);
			try {
				raw.run("UPDATE launch_bindings SET state = 'revoked' WHERE binding_id = ?", [bindingId]);
			} finally {
				raw.close();
			}
			mockCreateSession();
			const factory = createPersistedSubagentReviverFactory({
				session: topSession(dir),
				authStorage: {} as unknown as AuthStorage,
				modelRegistry: {} as unknown as ModelRegistry,
				settings: Settings.isolated(),
				enableLsp: false,
				store,
			});
			const reviver = await factory({
				id: "Child",
				kind: "agent",
				status: "parked",
				displayName: "Child",
				sessionFile,
				parentId: "Main",
			} as never);
			await expect(reviver!()).rejects.toThrow(/missing_lifecycle_binding/);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});
});
