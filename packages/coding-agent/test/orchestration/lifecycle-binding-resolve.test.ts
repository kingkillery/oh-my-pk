/**
 * §4.3 resolve-existing coverage: a revived session or replayed native task
 * must rebind to the SAME persisted launch binding — never a second admission —
 * and a missing, revoked or mismatched record must fail closed.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import type { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createNativeTaskExecutor, getNativeTaskRuntime } from "../../src/operational/native-task-executor";
import { nativeTaskJson, parseNativeTaskJobPayload } from "../../src/operational/native-task-payload";
import type { JobExecutorContext } from "../../src/operational/runner";
import { OperationalStore } from "../../src/operational/store";
import { DEFAULT_AGENT_EXECUTION_PROFILE } from "../../src/orchestration/agent-execution-profile";
import { DEFAULT_COLLABORATION_POLICY } from "../../src/orchestration/collaboration-policy";
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
import type { SingleResult } from "../../src/task/types";
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
function admitAndActivate(
	store: OperationalStore,
	lifecycle: {
		runId: string;
		nodeId: string;
		ownerNodeId: string | null;
		jobId: string;
		attemptId: string;
		leaseEpoch: number;
		cancellationGeneration: number;
		reservationId: string;
	} | null,
) {
	const compiled = createTestCompiledContract(
		{},
		{},
		{ parentPrincipalId: "principal-root", issuerPrincipalId: "principal-root" },
	);
	const guard = { actor: hostActor(), expectedPolicyEpoch: 1, idempotencyKey: `idem-${crypto.randomUUID()}` };
	const admitted = store.admitLaunchAuthority({
		guard,
		compiled,
		reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
		lifecycle,
		restoresBindingId: null,
	});
	expect(admitted.ok).toBe(true);
	const attemptId = lifecycle?.attemptId ?? `attempt-${compiled.contractId}-${compiled.contractRevision}`;
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
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId, attemptId } = admitAndActivate(store, null);
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
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
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
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId } = admitAndActivate(store, {
				runId: "run-1",
				nodeId: "node-1",
				ownerNodeId: null,
				jobId: "job-1",
				attemptId: "att-1",
				leaseEpoch: 1,
				cancellationGeneration: 0,
				reservationId: "res-1",
			});
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
			expect(registration?.runId).toBe("run-1");
			expect(registration?.nodeId).toBe("node-1");
			expect(registration?.attemptId).toBe("att-1");
			expect(registration?.policyEpoch).toBe(1);
			expect(registration?.readableRoots).toEqual(["src/"]);
			expect(registration?.writableRoots).toEqual(["src/"]);
			expect(registration?.allowExternalWrite).toBe(false);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("stands in durable identities for a binding with no scheduler lifecycle", async () => {
		const dir = await tempDir("resolve-direct");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId } = admitAndActivate(store, null);
			const binding = store.getLaunchBinding(bindingId);
			const contract = store.getLaunchContract(binding.contractDigest);
			const context = resolvePersistedLifecycleContext({ binding, contract, repoRoot: "/repo" });
			const registration = getLifecycleRegistration(context);
			expect(registration?.runId).toBe(bindingId);
			expect(registration?.nodeId).toBe(binding.childPrincipalId);
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("fails closed for a binding that never reached a live state", async () => {
		const dir = await tempDir("resolve-authorized");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const compiled = createTestCompiledContract(
				{},
				{},
				{ parentPrincipalId: "principal-root", issuerPrincipalId: "principal-root" },
			);
			const admitted = store.admitLaunchAuthority({
				guard: { actor: hostActor(), expectedPolicyEpoch: 1, idempotencyKey: "idem-authorized" },
				compiled,
				reservation: { requests: 1, runtimeMs: 1000, tokens: null, costMicrounits: null },
				lifecycle: null,
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
		const store = OperationalStore.open({ dbPath });
		try {
			const { bindingId } = admitAndActivate(store, null);
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
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId } = admitAndActivate(store, null);
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
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId } = admitAndActivate(store, null);
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
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId } = admitAndActivate(store, {
				runId: "run-1",
				nodeId: "node-1",
				ownerNodeId: null,
				jobId: "job-1",
				attemptId: "att-revive-1",
				leaseEpoch: 1,
				cancellationGeneration: 0,
				reservationId: "res-1",
			});
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
			expect(registration?.attemptId).toBe("att-revive-1");
			expect(registration?.runId).toBe("run-1");
			expect(registration?.nodeId).toBe("node-1");
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

	it("stays legacy when the session file carries no launch authority", async () => {
		const dir = await tempDir("revive-legacy");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const sessionFile = await writeSessionFile(dir);
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
			await reviver!();
			expect(spy.mock.calls[0]?.[0]?.lifecycleExecutionContext).toBeUndefined();
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("fails closed when the persisted binding was revoked", async () => {
		const dir = await tempDir("revive-revoked");
		const dbPath = path.join(dir, "op.db");
		const store = OperationalStore.open({ dbPath });
		try {
			const { bindingId } = admitAndActivate(store, null);
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

describe("native task replay authority", () => {
	function nativePayload(dir: string, version: 1 | 2, attemptId = "att-native-1") {
		return parseNativeTaskJobPayload(
			nativeTaskJson({
				version,
				cwd: dir,
				agentId: "NativeChild",
				parentSessionId: null,
				taskDepth: 0,
				params: { agent: "task", assignment: "Do the thing. Acceptance: resolves binding." },
				effectiveModel: "mock/mock-model",
				agentDefinition: {
					name: "task",
					description: "worker",
					systemPrompt: "sys",
					source: "bundled",
					tools: ["task"],
					spawns: [],
				},
				policy: {
					isolationMode: "none",
					mergeMode: "patch",
					maxRecursionDepth: 1,
					maxRuntimeMs: 0,
					outputSchema: null,
					executionProfile: DEFAULT_AGENT_EXECUTION_PROFILE,
					toolProfile: null,
					collaborationPolicy: DEFAULT_COLLABORATION_POLICY,
				},
				...(version === 2
					? { runId: "run-n", nodeId: "node-n", attemptId, launchHash: "lh", policyHash: "ph" }
					: {}),
			}),
		);
	}

	function fakeCtx(payload: unknown): JobExecutorContext {
		return {
			job: { id: "job-1", type: "native_task", payload: nativeTaskJson(payload) } as never,
			signal: new AbortController().signal,
			checkpoint: null,
			checkpointWrite: () => {},
			heartbeat: () => true,
		};
	}

	function fakeCreateSession(captured: { options?: Record<string, unknown> }) {
		return async (options: Record<string, unknown>) => {
			captured.options = options;
			const managed = options.nativeTaskExecution as JobExecutorContext;
			const session = {
				getToolByName: (name: string) =>
					name === "task"
						? {
								execute: async () => {
									const result = {
										id: "NativeChild",
										agent: "task",
										index: 0,
										task: "t",
										exitCode: 0,
										output: "done",
										stderr: "",
										truncated: false,
										durationMs: 1,
										tokens: 0,
										requests: 1,
									} as SingleResult;
									await getNativeTaskRuntime(managed).complete(result, null);
									return { content: [{ type: "text", text: "ok" }], details: {} };
								},
							}
						: undefined,
				dispose: async () => {},
			} as unknown as AgentSession;
			return {
				session,
				extensionsResult: { extensions: [], errors: [], runtime: {} } as never,
				setToolUIContext: () => {},
				eventBus: new EventBus(),
			};
		};
	}

	it("rebinds a v2 replay to the same persisted binding", async () => {
		const dir = await tempDir("native-bound");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const { bindingId } = admitAndActivate(store, {
				runId: "run-n",
				nodeId: "node-n",
				ownerNodeId: null,
				jobId: "job-n",
				attemptId: "att-native-1",
				leaseEpoch: 1,
				cancellationGeneration: 0,
				reservationId: "res-n",
			});
			const captured: { options?: Record<string, unknown> } = {};
			const executor = createNativeTaskExecutor({
				store,
				artifactsDir: path.join(dir, "artifacts"),
				heartbeatIntervalMs: 50,
				createSession: fakeCreateSession(captured) as never,
			});
			await executor(fakeCtx(nativePayload(dir, 2)));
			const context = captured.options?.lifecycleExecutionContext;
			expect(context).toBeDefined();
			const registration = getLifecycleRegistration(context as never);
			expect(registration?.attemptId).toBe("att-native-1");
			expect(registration?.runId).toBe("run-n");
			expect(registration?.nodeId).toBe("node-n");
			// The replay must attach the projection binding too — without it the
			// bound context still fails closed `untrusted_context` on every
			// provider request.
			const projection = getLifecycleProjectionBinding(context as never);
			expect(projection?.bindingId).toBe(bindingId);
			expect(typeof projection?.toolSourceOf).toBe("function");
			// A side request now projects instead of throwing untrusted_context.
			const projected = await projectLifecycleSideRequest(
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				"compact",
				context as never,
			);
			expect(getProjectionManifest(projected)?.phase).toBe("side-request");
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("keeps a v1 replay legacy", async () => {
		const dir = await tempDir("native-legacy");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const captured: { options?: Record<string, unknown> } = {};
			const executor = createNativeTaskExecutor({
				store,
				artifactsDir: path.join(dir, "artifacts"),
				heartbeatIntervalMs: 50,
				createSession: fakeCreateSession(captured) as never,
			});
			await executor(fakeCtx(nativePayload(dir, 1)));
			expect(captured.options?.lifecycleExecutionContext).toBeUndefined();
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});

	it("fails closed when the pinned binding is missing", async () => {
		const dir = await tempDir("native-missing");
		const store = OperationalStore.open({ dbPath: path.join(dir, "op.db") });
		try {
			const captured: { options?: Record<string, unknown> } = {};
			const executor = createNativeTaskExecutor({
				store,
				artifactsDir: path.join(dir, "artifacts"),
				heartbeatIntervalMs: 50,
				createSession: fakeCreateSession(captured) as never,
			});
			await expect(executor(fakeCtx(nativePayload(dir, 2, "att-missing")))).rejects.toThrow(/not found/);
			expect(captured.options).toBeUndefined();
		} finally {
			store.close();
			await removeWithRetries(dir);
		}
	});
});
