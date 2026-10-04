import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { LaunchAuthorityAdmissionResult } from "../../src/operational/launch-authority-types";
import { LifecycleReadError, LifecycleStore } from "../../src/operational/lifecycle-store";
import { OperationalStore } from "../../src/operational/store";
import {
	authorizeLifecycleAction,
	createHostRootExecutionContext,
	registerLiveBindingValidator,
	resolvePersistedLifecycleContext,
	revokeLifecycleExecutionContext,
} from "../../src/orchestration/lifecycle-authority";
import {
	canonicalJson,
	computeLaunchContractDigest,
	parseCompiledLaunchContract,
} from "../../src/task/launch-contract";
import {
	createStoreRequest,
	createTestArtifactRef,
	createTestCompiledContract,
	createTestEnvelope,
	createTestLaunchAuthority,
	createTestRunLimits,
	createTestRuntimeGuarantees,
	createTestSpawnAuthority,
} from "./fixtures/launch-authority-input";

const directories: string[] = [];
const stores: LifecycleStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	// Finalize transient legacy SQLite statements without changing OperationalStore.close().
	Bun.gc(true);
	for (const directory of directories.splice(0))
		for (let retry = 0; ; retry++) {
			try {
				await rm(directory, { recursive: true, force: true });
				break;
			} catch (error) {
				if (retry >= 39 || !/EBUSY|EPERM|ENOTEMPTY/.test(String(error))) throw error;
				await Bun.sleep(50);
			}
		}
});
async function directory(): Promise<string> {
	const result = await mkdtemp(path.join(tmpdir(), "ompk-lifecycle-store-"));
	directories.push(result);
	return result;
}
async function open(dbPath?: string): Promise<LifecycleStore> {
	const store = await LifecycleStore.open({
		dbPath: dbPath ?? path.join(await directory(), "lifecycle.db"),
		durability: "normal",
	});
	stores.push(store);
	return store;
}
function accepted(result: LaunchAuthorityAdmissionResult) {
	if (!result.ok) throw new Error(`${result.code}: ${result.diagnostics.map(d => d.message).join(", ")}`);
	return result.launch;
}
function code(result: LaunchAuthorityAdmissionResult): string | null {
	return result.ok ? null : result.code;
}
function activate(
	store: LifecycleStore,
	request: ReturnValue,
	bindingId: string,
	expectedState: "authorized" | "bound" = "authorized",
) {
	return store.activateLaunchBinding({
		guard: request.guard,
		bindingId,
		expectedState,
		sessionId: "real-child-session",
		processRef: null,
		serviceBindings: [],
		actualRuntimeGuarantees: createTestRuntimeGuarantees(),
		guaranteeEvidenceRefs: [createTestArtifactRef("probe")],
	});
}
type ReturnValue = Parameters<LifecycleStore["admitLaunchAuthority"]>[0];

async function race(directoryPath: string, mode: "same" | "different"): Promise<LaunchAuthorityAdmissionResult[]> {
	const fixture = path.join(import.meta.dir, "fixtures", "lifecycle-store-contender.ts");
	const children = ["a", "b", "c", "d"].map(id =>
		Bun.spawn([process.execPath, fixture, directoryPath, id, mode], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			cwd: path.resolve(import.meta.dir, "../.."),
		}),
	);
	const outputs = children.map(child => ({
		stdout: new Response(child.stdout).text(),
		stderr: new Response(child.stderr).text(),
	}));
	const exitCodes: (number | null)[] = children.map(() => null);
	const exits = children.map((child, index) =>
		child.exited.then(exit => {
			exitCodes[index] = exit;
			return exit;
		}),
	);
	try {
		const deadline = Date.now() + 15_000;
		while ((await readdir(directoryPath)).filter(name => name.startsWith("ready-")).length !== 4) {
			const earlyExit = exitCodes.findIndex(exit => exit !== null);
			if (earlyExit >= 0)
				throw new Error(
					`contender ${earlyExit} exited ${exitCodes[earlyExit]} before readiness: ${await outputs[earlyExit].stderr}`,
				);
			if (Date.now() > deadline) throw new Error("children did not reach readiness barrier");
			await Bun.sleep(10);
		}
		await Bun.write(path.join(directoryPath, "start"), "start");
		return await Promise.all(
			children.map(async (_, index) => {
				const [stdout, stderr, exit] = await Promise.all([
					outputs[index].stdout,
					outputs[index].stderr,
					exits[index],
				]);
				expect(stderr).toBe("");
				expect(exit).toBe(0);
				return JSON.parse(stdout) as LaunchAuthorityAdmissionResult;
			}),
		);
	} catch (error) {
		children.forEach((child, index) => {
			if (exitCodes[index] === null) child.kill();
		});
		await Promise.all(exits);
		const diagnostics = await Promise.all(
			outputs.map(async (output, index) => `contender ${index} exit ${exitCodes[index]}: ${await output.stderr}`),
		);
		throw new Error(`${error}\n${diagnostics.join("\n")}`);
	} finally {
		children.forEach((child, index) => {
			if (exitCodes[index] === null) child.kill();
		});
		await Promise.all(exits);
	}
}
describe("separate lifecycle authority database", () => {
	it("leaves legacy operational v1 readable and never migrates its file", async () => {
		const root = await directory();
		const operationalPath = path.join(root, "operational.db");
		const lifecyclePath = path.join(root, "lifecycle.db");
		const legacy = OperationalStore.open({ dbPath: operationalPath, durability: "normal" });
		try {
			legacy.setState({ kind: "user" }, "sentinel", { kept: true });
			const job = legacy.createJob({ type: "legacy", payload: { keep: 1 } });
			expect(await Bun.file(lifecyclePath).exists()).toBe(false);
			await expect(LifecycleStore.open({ dbPath: operationalPath })).rejects.toThrow("dedicated database");
			expect(legacy.getJob(job.id)?.payload).toEqual({ keep: 1 });
			const store = await open(lifecyclePath);
			accepted(await store.admitLaunchAuthority(createStoreRequest()));
			store.close();
			expect(legacy.getState({ kind: "user" }, "sentinel")).toEqual({ kept: true });
		} finally {
			legacy.close();
		}
		const reopened = OperationalStore.open({ dbPath: operationalPath, durability: "normal" });
		try {
			expect(reopened.getState({ kind: "user" }, "sentinel")).toEqual({ kept: true });
		} finally {
			reopened.close();
		}
		const inspector = new Database(operationalPath, { readonly: true });
		try {
			expect(inspector.query("SELECT version FROM schema_version").get()).toEqual({ version: 1 });
			expect(inspector.query("SELECT name FROM sqlite_master WHERE name LIKE 'launch_%'").all()).toEqual([]);
		} finally {
			inspector.close();
		}
	});

	it("rejects a future authority schema and closes a failed opening", async () => {
		const dbPath = path.join(await directory(), "lifecycle.db");
		const db = new Database(dbPath, { create: true });
		db.run("CREATE TABLE lifecycle_schema_version (version INTEGER NOT NULL)");
		db.run("INSERT INTO lifecycle_schema_version VALUES (2)");
		db.close();
		await expect(LifecycleStore.open({ dbPath })).rejects.toThrow("Unsupported lifecycle schema version 2");
		await rm(dbPath);
	});

	it("persists immutable contract, principal and binding through reopen and close", async () => {
		const dbPath = path.join(await directory(), "lifecycle.db");
		const request = createStoreRequest();
		let store = await open(dbPath);
		const launch = accepted(await store.admitLaunchAuthority(request));
		expect(launch.binding.state).toBe("authorized");
		expect(launch.binding.sessionId).toBeNull();
		expect(store.getLaunchPrincipal("principal-root")?.parentPrincipalId).toBeNull();
		expect(store.getLaunchPrincipal("child-one")?.parentPrincipalId).toBe("principal-root");
		expect(Object.isFrozen(store.getLaunchContract(launch.compiled.contractDigest))).toBe(true);
		expect(Object.isFrozen(launch.binding.serviceBindings)).toBe(true);
		store.close();
		store.close();
		expect(() => store.getLaunchBinding(launch.binding.bindingId)).toThrow("closed");
		store = await open(dbPath);
		expect(store.getLaunchBindingByAttempt(launch.binding.attemptId)).toEqual(launch.binding);
		expect(store.getLaunchContract(launch.compiled.contractDigest)).toEqual(launch.compiled);
	});

	it("does not demote a concurrent holder's WAL journal on close", async () => {
		const dbPath = path.join(await directory(), "lifecycle.db");
		const first = await open(dbPath);
		const second = await open(dbPath);
		first.close();
		const request = createStoreRequest();
		accepted(await second.admitLaunchAuthority(request));
		const inspector = new Database(dbPath, { readonly: true });
		try {
			expect(inspector.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
		} finally {
			inspector.close();
		}
	});
});

describe("authenticated admission, activation and terminalization", () => {
	it("replays the recorded binding after activation and rejects changed input under the same key", async () => {
		const store = await open();
		const request = createStoreRequest("one", { maxChildren: 1 });
		const launch = accepted(await store.admitLaunchAuthority(request));
		const bound = accepted(activate(store, request, launch.binding.bindingId));
		const replay = await store.admitLaunchAuthority(request);
		expect(replay.ok && replay.replayed).toBe(true);
		expect(accepted(replay).binding).toEqual(bound.binding);
		const changed = createStoreRequest("two");
		expect(
			code(await store.admitLaunchAuthority({ ...changed, guard: { ...changed.guard, idempotencyKey: "one" } })),
		).toBe("admission_conflict");
		expect(store.countLiveChildBindings("principal-root")).toBe(1);
	});

	it("denies forged, foreign-lineage, revoked and stale issuers before any child exists", async () => {
		const store = await open();
		const request = createStoreRequest();
		expect(
			code(
				await store.admitLaunchAuthority({
					...request,
					guard: { ...request.guard, actor: {} as typeof request.guard.actor },
				}),
			),
		).toBe("unauthenticated_actor");
		const other = createStoreRequest("other", { root: "other-root" });
		expect(code(await store.admitLaunchAuthority({ ...request, guard: other.guard }))).toBe("unauthenticated_actor");
		revokeLifecycleExecutionContext(other.guard.actor);
		expect(code(await store.admitLaunchAuthority(other))).toBe("unauthenticated_actor");
		expect(
			code(await store.admitLaunchAuthority({ ...request, guard: { ...request.guard, expectedPolicyEpoch: 2 } })),
		).toBe("stale_launch_authority");
		expect(store.countLiveChildBindings("principal-root")).toBe(0);
		expect(store.getLaunchPrincipal("principal-root")).toBeNull();
	});

	it("checks real root capabilities and spawn depth against inflated compiler snapshots", async () => {
		const store = await open();
		const request = createStoreRequest();
		const compilerEnvelope = createTestEnvelope({
			spawn: createTestSpawnAuthority({
				maySpawn: true,
				mayDelegateSpawn: true,
				maxDepth: 4,
				maxChildren: 16,
				allowedAgentTypes: ["*"],
				allowedLaunchClasses: ["strict-worker"],
			}),
		});
		const restrictiveRoot = (authority: typeof compilerEnvelope) =>
			createHostRootExecutionContext({
				sessionId: "restrictive-root",
				rootPrincipalId: "principal-root",
				policy: { role: "root-planner", topology: "hierarchical" },
				authority,
			});
		const compiled = createTestCompiledContract({ inputs: [] }, undefined, {
			contractId: "inflated-compiler",
			childPrincipalId: "inflated-child",
			issuerPrincipalId: "principal-root",
			parentPrincipalId: "principal-root",
			rootPrincipalId: "principal-root",
			parentDelegable: compilerEnvelope,
			hostMaximum: compilerEnvelope,
			agentMaximum: compilerEnvelope,
			workflowMaximum: compilerEnvelope,
		});
		const actual = createTestEnvelope({ ...compilerEnvelope, delegableCapabilities: [] });
		expect(
			code(
				await store.admitLaunchAuthority({
					...request,
					compiled,
					guard: { ...request.guard, actor: restrictiveRoot(actual) },
				}),
			),
		).toBe("capability_not_delegable");
		const onward = createTestCompiledContract({ inputs: [] }, undefined, {
			contractId: "inflated-onward",
			childPrincipalId: "onward-child",
			issuerPrincipalId: "principal-root",
			parentPrincipalId: "principal-root",
			rootPrincipalId: "principal-root",
			requestedAuthority: createTestLaunchAuthority({
				usableCapabilities: [],
				delegableCapabilities: [{ source: "builtin", name: "read" }],
			}),
			parentDelegable: compilerEnvelope,
			hostMaximum: compilerEnvelope,
			agentMaximum: compilerEnvelope,
			workflowMaximum: compilerEnvelope,
		});
		expect(
			code(
				await store.admitLaunchAuthority({
					...request,
					compiled: onward,
					guard: { ...request.guard, actor: restrictiveRoot(actual) },
				}),
			),
		).toBe("capability_not_issuable");
		const spawning = createTestCompiledContract({ inputs: [] }, undefined, {
			contractId: "inflated-spawn",
			childPrincipalId: "spawning-child",
			issuerPrincipalId: "principal-root",
			parentPrincipalId: "principal-root",
			rootPrincipalId: "principal-root",
			requestedAuthority: createTestLaunchAuthority({
				spawn: createTestSpawnAuthority({
					maySpawn: true,
					maxDepth: 2,
					maxChildren: 1,
					allowedLaunchClasses: ["strict-worker"],
				}),
			}),
			parentDelegable: compilerEnvelope,
			hostMaximum: compilerEnvelope,
			agentMaximum: compilerEnvelope,
			workflowMaximum: compilerEnvelope,
		});
		const shortRoot = createTestEnvelope({ ...compilerEnvelope, spawn: { ...compilerEnvelope.spawn, maxDepth: 1 } });
		expect(
			code(
				await store.admitLaunchAuthority({
					...request,
					compiled: spawning,
					guard: { ...request.guard, actor: restrictiveRoot(shortRoot) },
				}),
			),
		).toBe("spawn_depth_not_decreasing");
		const classRoot = createTestEnvelope({
			...compilerEnvelope,
			spawn: { ...compilerEnvelope.spawn, allowedLaunchClasses: [] },
		});
		expect(
			code(
				await store.admitLaunchAuthority({
					...request,
					compiled,
					guard: { ...request.guard, actor: restrictiveRoot(classRoot) },
				}),
			),
		).toBe("spawn_launch_class_not_permitted");
		expect(store.countLiveChildBindings("principal-root")).toBe(0);
		expect(store.getLaunchPrincipal("principal-root")).toBeNull();
	});

	it("lets an authentic planner delegate a tool it cannot invoke itself", async () => {
		const store = await open();
		const request = createStoreRequest();
		const actor = createHostRootExecutionContext({
			sessionId: "delegation-only-root",
			rootPrincipalId: "principal-root",
			policy: { role: "root-planner", topology: "hierarchical" },
			authority: createTestEnvelope({
				usableCapabilities: [],
				spawn: createTestSpawnAuthority({
					maySpawn: true,
					maxDepth: 2,
					maxChildren: 1,
					allowedLaunchClasses: ["strict-worker"],
				}),
			}),
		});
		const launch = accepted(await store.admitLaunchAuthority({ ...request, guard: { ...request.guard, actor } }));
		expect(launch.compiled.authority.usableCapabilities).toEqual([{ source: "builtin", name: "read" }]);
		expect(
			authorizeLifecycleAction(actor, {
				tool: { source: "builtin", name: "read" },
				action: "invoke_tool",
				effect: "control",
				targets: [],
				invocationId: "planner-read",
			}).allowed,
		).toBe(false);
	});

	it("checks durable bound-parent delegation rather than the proposed compiler parent", async () => {
		const store = await open();
		const request = createStoreRequest("planner");
		const envelope = createTestEnvelope({
			spawn: createTestSpawnAuthority({
				maySpawn: true,
				mayDelegateSpawn: true,
				maxDepth: 4,
				maxChildren: 2,
				allowedAgentTypes: ["*"],
				allowedLaunchClasses: ["strict-worker"],
			}),
		});
		const compiled = createTestCompiledContract(
			{ inputs: [] },
			{ role: "subplanner" },
			{
				contractId: "planner-contract",
				childPrincipalId: "principal-planner",
				issuerPrincipalId: "principal-root",
				parentPrincipalId: "principal-root",
				rootPrincipalId: "principal-root",
				requestedAuthority: createTestLaunchAuthority({
					usableCapabilities: [],
					delegableCapabilities: [],
					spawn: createTestSpawnAuthority({
						maySpawn: true,
						mayDelegateSpawn: true,
						maxDepth: 2,
						maxChildren: 1,
						allowedLaunchClasses: ["strict-worker"],
					}),
				}),
				parentDelegable: envelope,
				hostMaximum: envelope,
				agentMaximum: envelope,
				workflowMaximum: envelope,
			},
		);
		const planner = { ...request, compiled };
		const admitted = accepted(await store.admitLaunchAuthority(planner));
		const bound = accepted(activate(store, planner, admitted.binding.bindingId));
		const actor = resolvePersistedLifecycleContext({
			binding: bound.binding,
			contract: bound.compiled,
			repoRoot: process.cwd(),
		});
		registerLiveBindingValidator(actor, id => store.getLaunchBinding(id));
		const proposed = createTestCompiledContract({ inputs: [] }, undefined, {
			contractId: "grandchild-contract",
			childPrincipalId: "principal-grandchild",
			issuerPrincipalId: "principal-planner",
			parentPrincipalId: "principal-planner",
			rootPrincipalId: "principal-root",
			parentDelegable: envelope,
			hostMaximum: envelope,
			agentMaximum: envelope,
			workflowMaximum: envelope,
		});
		expect(
			code(
				await store.admitLaunchAuthority({
					...request,
					compiled: proposed,
					guard: { actor, expectedPolicyEpoch: 1, idempotencyKey: "grandchild" },
				}),
			),
		).toBe("capability_not_delegable");
		expect(store.countLiveChildBindings("principal-planner")).toBe(0);
	});
	it("denies root registration epoch drift even before lazy principal persistence", async () => {
		const store = await open();
		const request = createStoreRequest();
		const actor = createHostRootExecutionContext({
			sessionId: "epoch-two",
			rootPrincipalId: "principal-root",
			policy: { role: "root-planner", topology: "hierarchical" },
			authority: createTestEnvelope(),
			policyEpoch: 2,
		});
		expect(
			code(
				await store.admitLaunchAuthority({
					...request,
					guard: { ...request.guard, actor, expectedPolicyEpoch: 1 },
				}),
			),
		).toBe("stale_launch_authority");
		expect(store.getLaunchPrincipal("principal-root")).toBeNull();
	});

	it("conflicts on altered attempt facts and permits equivalent new-key replay at full capacity", async () => {
		const store = await open();
		const original = createStoreRequest("one", { maxChildren: 1 });
		const lifecycle = {
			runId: "run-one",
			nodeId: "node-one",
			ownerNodeId: null,
			jobId: "legacy-job",
			attemptId: "attempt-one",
			leaseEpoch: 1,
			cancellationGeneration: 0,
			reservationId: "reservation-one",
		};
		const request = { ...original, lifecycle };
		const launch = accepted(await store.admitLaunchAuthority(request));
		for (const [key, changed] of Object.entries({
			run: { ...lifecycle, runId: "other-run" },
			node: { ...lifecycle, nodeId: "other-node" },
			reservation: { ...lifecycle, reservationId: "other-reservation" },
			lease: { ...lifecycle, leaseEpoch: 2 },
		})) {
			expect(
				code(
					await store.admitLaunchAuthority({
						...request,
						lifecycle: changed,
						guard: { ...request.guard, idempotencyKey: key },
					}),
				),
			).toBe("admission_conflict");
		}
		expect(
			code(
				await store.admitLaunchAuthority({
					...request,
					restoresBindingId: "other-binding",
					guard: { ...request.guard, idempotencyKey: "restore" },
				}),
			),
		).toBe("admission_conflict");
		const replay = await store.admitLaunchAuthority({
			...request,
			guard: { ...request.guard, idempotencyKey: "equivalent-new-key" },
		});
		expect(replay.ok && replay.replayed).toBe(true);
		expect(accepted(replay).binding.bindingId).toBe(launch.binding.bindingId);
		expect(store.countLiveChildBindings("principal-root")).toBe(1);
		expect(
			code(await store.admitLaunchAuthority({ ...request, reservation: { ...request.reservation, requests: 2 } })),
		).toBe("inconsistent_reservation");
	});

	it("does not reinterpret a finite issuer ceiling as a legacy unlimited child budget", async () => {
		const store = await open();
		const request = createStoreRequest();
		const envelope = createTestEnvelope({
			spawn: createTestSpawnAuthority({
				maySpawn: true,
				mayDelegateSpawn: true,
				maxDepth: 4,
				maxChildren: 4,
				allowedAgentTypes: ["*"],
				allowedLaunchClasses: ["privileged-helper"],
			}),
		});
		const actor = createHostRootExecutionContext({
			sessionId: "finite-root",
			rootPrincipalId: "principal-root",
			policy: { role: "root-planner", topology: "hierarchical" },
			authority: envelope,
		});
		const limits = { ...createTestRunLimits(), maxRequests: 0, maxRuntimeMs: 0 };
		const compiled = createTestCompiledContract({ inputs: [] }, undefined, {
			contractId: "legacy-unlimited",
			childPrincipalId: "legacy-child",
			issuerPrincipalId: "principal-root",
			parentPrincipalId: "principal-root",
			rootPrincipalId: "principal-root",
			requestedAuthority: createTestLaunchAuthority({
				launchClass: "privileged-helper",
				budget: {
					kind: "legacy",
					limits,
					reservation: request.reservation,
					zeroMeansUnlimited: true,
					authorityRef: "proposed-legacy-budget",
				},
			}),
			parentDelegable: envelope,
			hostMaximum: envelope,
			agentMaximum: envelope,
			workflowMaximum: envelope,
		});
		expect(code(await store.admitLaunchAuthority({ ...request, compiled, guard: { ...request.guard, actor } }))).toBe(
			"budget_exceeds_issuer",
		);
		expect(store.countLiveChildBindings("principal-root")).toBe(0);
	});
	it("rejects tampered compiled bytes and typed missing reads", async () => {
		const store = await open();
		const request = createStoreRequest();
		const compiled = { ...request.compiled, capsule: { ...request.compiled.capsule, objective: "tampered" } };
		expect(code(await store.admitLaunchAuthority({ ...request, compiled }))).toBe("digest_mismatch");
		expect(store.countLiveChildBindings("principal-root")).toBe(0);
		expect(() => store.getLaunchBinding("missing")).toThrow(LifecycleReadError);
		expect(() => store.getLaunchContract("missing")).toThrow(LifecycleReadError);
	});

	it("rejects persisted contract tampering rather than trusting stored JSON", async () => {
		const store = await open();
		const launch = accepted(await store.admitLaunchAuthority(createStoreRequest()));
		const db = new Database(store.dbPath);
		try {
			db.query("UPDATE launch_contracts SET canonical_json = ? WHERE digest = ?").run(
				canonicalJson({ ...launch.compiled, missionHash: "0".repeat(64) }),
				launch.compiled.contractDigest,
			);
		} finally {
			db.close();
		}
		expect(() => store.getLaunchContract(launch.compiled.contractDigest)).toThrow("missionHash");
	});

	it("requires measured guarantees and evidence before authorized becomes bound", async () => {
		const store = await open();
		const request = createStoreRequest();
		const launch = accepted(await store.admitLaunchAuthority(request));
		const input = {
			guard: request.guard,
			bindingId: launch.binding.bindingId,
			expectedState: "authorized" as const,
			sessionId: "actual-session",
			processRef: null,
			serviceBindings: [],
			actualRuntimeGuarantees: createTestRuntimeGuarantees({ filesystemWrite: "ambient" }),
			guaranteeEvidenceRefs: [createTestArtifactRef()],
		};
		expect(code(store.activateLaunchBinding(input))).toBe("required_isolation_unavailable");
		expect(
			code(
				store.activateLaunchBinding({
					...input,
					actualRuntimeGuarantees: createTestRuntimeGuarantees(),
					guaranteeEvidenceRefs: [],
				}),
			),
		).toBe("guarantee_evidence_required");
		expect(store.getLaunchBinding(launch.binding.bindingId).state).toBe("authorized");
		const bound = accepted(activate(store, request, launch.binding.bindingId));
		expect(bound.binding.sessionId).toBe("real-child-session");
		expect(bound.binding.state).toBe("bound");
		expect(accepted(activate(store, request, launch.binding.bindingId, "bound")).binding.state).toBe("active");
		expect(code(activate(store, request, launch.binding.bindingId))).toBe("launch_binding_state_conflict");
	});

	it("terminalizes once, frees capacity, and refuses future activation or dispatch", async () => {
		const store = await open();
		const request = createStoreRequest("one", { maxChildren: 1 });
		const launch = accepted(await store.admitLaunchAuthority(request));
		const bound = accepted(activate(store, request, launch.binding.bindingId));
		const context = resolvePersistedLifecycleContext({
			binding: bound.binding,
			contract: bound.compiled,
			repoRoot: process.cwd(),
		});
		registerLiveBindingValidator(context, id => store.getLaunchBinding(id));
		const read = {
			tool: { source: "builtin" as const, name: "read" },
			action: "invoke_tool" as const,
			effect: "control" as const,
			targets: [],
			invocationId: "read-one",
		};
		expect(authorizeLifecycleAction(context, read).allowed).toBe(true);
		const terminated = store.terminateLaunchBinding({
			guard: request.guard,
			bindingId: launch.binding.bindingId,
			targetState: "revoked",
			reason: "operator cancellation",
		});
		expect(terminated).toEqual({ ok: true, bindingId: launch.binding.bindingId, state: "revoked", policyEpoch: 2 });
		expect(
			store.terminateLaunchBinding({ guard: request.guard, bindingId: launch.binding.bindingId, reason: "repeat" }),
		).toEqual(terminated);
		expect(store.countLiveChildBindings("principal-root")).toBe(0);
		expect(authorizeLifecycleAction(context, read).allowed).toBe(false);
		expect(code(activate(store, request, launch.binding.bindingId))).toBe("launch_binding_state_conflict");
		accepted(await store.admitLaunchAuthority(createStoreRequest("next", { maxChildren: 1 })));
		const inspector = new Database(store.dbPath, { readonly: true });
		try {
			expect(inspector.query("SELECT kind, reason FROM launch_binding_events WHERE kind = 'revoked'").all()).toEqual(
				[{ kind: "revoked", reason: "operator cancellation" }],
			);
		} finally {
			inspector.close();
		}
	});

	it("refuses a stored identity collision even under a different idempotency key", async () => {
		const store = await open();
		const request = createStoreRequest();
		accepted(await store.admitLaunchAuthority(request));
		const alteredBody = {
			...request.compiled,
			provenance: { ...request.compiled.provenance, reason: "different intent" },
		};
		const { contractDigest: _oldDigest, ...body } = alteredBody;
		const compiled = parseCompiledLaunchContract({ ...body, contractDigest: computeLaunchContractDigest(body) });
		expect(
			code(
				await store.admitLaunchAuthority({
					...request,
					compiled,
					guard: { ...request.guard, idempotencyKey: "different-key" },
				}),
			),
		).toBe("admission_conflict");
		expect(store.countLiveChildBindings("principal-root")).toBe(1);
	});
});

describe("real independent process contention", () => {
	it("admits one binding across four identical admission requests", async () => {
		const root = await directory();
		const initial = await open(path.join(root, "lifecycle.db"));
		initial.close();
		const results = await race(root, "same");
		expect(results.every(result => result.ok)).toBe(true);
		expect(results.filter(result => result.ok && !result.replayed)).toHaveLength(1);
		expect(new Set(results.map(result => accepted(result).binding.bindingId)).size).toBe(1);
		expect((await open(path.join(root, "lifecycle.db"))).countLiveChildBindings("principal-root")).toBe(1);
	}, 30_000);

	it("atomically keeps distinct concurrent children within the issuer ceiling", async () => {
		const root = await directory();
		const initial = await open(path.join(root, "lifecycle.db"));
		initial.close();
		const results = await race(root, "different");
		expect(results.filter(result => result.ok)).toHaveLength(1);
		expect(results.filter(result => !result.ok).map(code)).toEqual([
			"spawn_children_exhausted",
			"spawn_children_exhausted",
			"spawn_children_exhausted",
		]);
		expect((await open(path.join(root, "lifecycle.db"))).countLiveChildBindings("principal-root")).toBe(1);
	}, 30_000);
});
