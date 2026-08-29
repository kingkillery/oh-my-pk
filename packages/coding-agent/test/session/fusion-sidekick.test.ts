import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import {
	ensureFusionSidekick,
	type FusionSidekickHost,
	reconcileFusionSidekickModel,
} from "../../src/session/fusion-sidekick";
import * as taskDiscovery from "../../src/task/discovery";
import type { ExecutorOptions } from "../../src/task/executor";
import * as taskExecutor from "../../src/task/executor";
import type { SingleResult } from "../../src/task/types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeSettings(initial?: Record<string, unknown>): SettingsLike {
	const map = new Map<string, unknown>(Object.entries(initial ?? {}));
	return {
		get(key: string) {
			return map.get(key);
		},
	};
}

function makeModelRegistry(): ModelRegistryLike {
	return {
		getAvailable: () => [],
		hasConfiguredAuth: () => true,
		authStorage: {},
	};
}

function makeMockAgentSession(overrides?: Partial<AgentSessionLike>): AgentSessionLike {
	return {
		settings: makeSettings(),
		modelRegistry: makeModelRegistry(),
		sessionManager: makeMockSessionManager(),
		getFusionSidekickId: () => undefined,
		setFusionSidekickId: () => {},
		refreshBaseSystemPrompt: async () => {},
		getPlanModeState: () => ({ enabled: true }),
		getPlanReferencePath: () => undefined,
		getAgentId: () => undefined,
		skills: [],
		promptTemplates: [],
		model: undefined,
		...overrides,
	};
}

function makeMockSessionManager(): SessionManagerLike {
	return {
		getCwd: () => "/test/cwd",
		ensureOnDisk: () => Promise.resolve(),
		getSessionFile: () => null,
		getArtifactsDir: () => undefined,
		getSessionId: () => "session-id",
		getArtifactManager: () => undefined,
	};
}

interface FusionSidekickHostLike {
	session: AgentSessionLike;
	settings: SettingsLike;
	sessionManager: SessionManagerLike;
	mcpManager?: FusionSidekickHost["mcpManager"];
	eventBus?: FusionSidekickHost["eventBus"];
}

function makeHost(overrides?: Partial<FusionSidekickHostLike>): FusionSidekickHost {
	return {
		session: makeMockAgentSession(),
		settings: makeSettings(),
		sessionManager: makeMockSessionManager(),
		...overrides,
	} as unknown as FusionSidekickHost;
}

// ---------------------------------------------------------------------------
// Spy references (restored after each test)
// ---------------------------------------------------------------------------

let agentRegistrySpy: ReturnType<typeof spyOn>;
let lifecycleSpy: ReturnType<typeof spyOn>;
let discoverAgentsSpy: ReturnType<typeof spyOn>;
let runSubprocessSpy: ReturnType<typeof spyOn>;

// ---------------------------------------------------------------------------
// Mocks & types
// ---------------------------------------------------------------------------

interface SettingsLike {
	get(key: string): unknown;
}

interface ModelRegistryLike {
	getAvailable(): Array<Model<Api>>;
	hasConfiguredAuth(model: Model<Api>): boolean;
	authStorage?: unknown;
}

interface AgentRefLike {
	id: string;
	session: unknown;
	status: string;
}

interface AgentSessionLike {
	settings: SettingsLike;
	modelRegistry: ModelRegistryLike;
	sessionManager: SessionManagerLike;
	getFusionSidekickId(): string | undefined;
	setFusionSidekickId(id: string | undefined): void;
	refreshBaseSystemPrompt(): Promise<void>;
	getPlanModeState?: () => unknown;
	getPlanReferencePath?: () => unknown;
	getAgentId?: () => string | undefined;
	skills?: unknown[];
	promptTemplates?: unknown[];
	isStreaming?: boolean;
	model?: Model<Api>;
	setModelTemporary?(model: Model<Api>, thinkingLevel?: unknown, options?: unknown): Promise<void>;
}

interface SessionManagerLike {
	getCwd(): string;
	ensureOnDisk(): Promise<void>;
	getSessionFile(): string | null;
	getArtifactsDir(): string | undefined;
	getSessionId(): string;
	getArtifactManager?(): unknown;
}

describe("fusion-sidekick", () => {
	beforeEach(() => {
		agentRegistrySpy = spyOn(AgentRegistry, "global");
		lifecycleSpy = spyOn(AgentLifecycleManager, "global");
		discoverAgentsSpy = spyOn(taskDiscovery, "discoverAgents");
		runSubprocessSpy = spyOn(taskExecutor, "runSubprocess").mockImplementation(async () => undefined as never);
	});

	afterEach(() => {
		agentRegistrySpy.mockRestore();
		lifecycleSpy.mockRestore();
		discoverAgentsSpy.mockRestore();
		runSubprocessSpy.mockRestore();
	});

	// ---------------------------------------------------------------------------
	// ensureFusionSidekick
	// ---------------------------------------------------------------------------

	describe("ensureFusionSidekick", () => {
		it("no-ops when fusion.enabled is not true", async () => {
			const host = makeHost({
				settings: makeSettings({ "fusion.enabled": false }),
			});

			await ensureFusionSidekick(host);

			expect(discoverAgentsSpy).not.toHaveBeenCalled();
		});

		it("force:true does not spawn when fusion is disabled", async () => {
			let recordedId: string | undefined = "stale-id";
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
				}),
				settings: makeSettings({ "fusion.enabled": false }),
			});

			await ensureFusionSidekick(host, { force: true });

			expect(recordedId).toBeUndefined();
			expect(discoverAgentsSpy).not.toHaveBeenCalled();
		});

		it("no-ops when fusion.mode is 'off'", async () => {
			const host = makeHost({
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "off" }),
			});

			await ensureFusionSidekick(host);

			expect(discoverAgentsSpy).not.toHaveBeenCalled();
		});

		it("no-ops when a sidekick id is already recorded", async () => {
			const existingRef: AgentRefLike = { id: "existing-id", session: {}, status: "idle" };
			const registryMock = { get: (_id: string) => existingRef };
			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);

			const session = makeMockAgentSession({
				getFusionSidekickId: () => "existing-id",
			});
			const refreshSpy = spyOn(session, "refreshBaseSystemPrompt");
			const host = makeHost({
				session,
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "delegate" }),
			});

			await ensureFusionSidekick(host);

			expect(discoverAgentsSpy).not.toHaveBeenCalled();
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});

		it("clears a stale recorded id and respawns", async () => {
			const refs = new Map<string, AgentRefLike>();
			const registryMock = {
				get: (id: string) => refs.get(id),
			};
			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);
			lifecycleSpy.mockImplementation(() => ({ release: async () => {} }) as unknown as AgentLifecycleManager);
			discoverAgentsSpy.mockImplementation(async () => ({
				agents: [{ id: "task", name: "task", kind: "task", path: "/test" }],
				projectAgentsDir: null,
			}));
			runSubprocessSpy.mockImplementation(async (options: { id: string }) => {
				refs.set(options.id, { id: options.id, session: {}, status: "running" });
				return undefined as never;
			});

			let recordedId: string | undefined = "stale-missing-id";
			const session = makeMockAgentSession({
				getFusionSidekickId: () => recordedId,
				setFusionSidekickId: id => {
					recordedId = id;
				},
			});
			const refreshSpy = spyOn(session, "refreshBaseSystemPrompt");
			const host = makeHost({
				session,
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "delegate" }),
			});

			await ensureFusionSidekick(host);

			expect(discoverAgentsSpy).toHaveBeenCalled();
			expect(runSubprocessSpy).toHaveBeenCalled();
			expect(recordedId).toBeTruthy();
			expect(recordedId).not.toBe("stale-missing-id");
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});

		it("joins concurrent startup ensures so only one Sidekick row is allocated", async () => {
			const refs = new Map<string, AgentRefLike>();
			agentRegistrySpy.mockImplementation(() => ({ get: (id: string) => refs.get(id) }) as unknown as AgentRegistry);
			lifecycleSpy.mockImplementation(() => ({ release: async () => true }) as unknown as AgentLifecycleManager);

			const discoveryStarted = Promise.withResolvers<void>();
			const releaseDiscovery = Promise.withResolvers<void>();
			discoverAgentsSpy.mockImplementation(async () => {
				discoveryStarted.resolve();
				await releaseDiscovery.promise;
				return {
					agents: [{ id: "task", name: "task", kind: "task", path: "/test" }],
					projectAgentsDir: null,
				};
			});
			runSubprocessSpy.mockImplementation(async (options: { id: string }) => {
				refs.set(options.id, { id: options.id, session: {}, status: "running" });
				return undefined as never;
			});

			let recordedId: string | undefined;
			let promptRefreshes = 0;
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
					refreshBaseSystemPrompt: async () => {
						promptRefreshes++;
					},
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "delegate" }),
			});

			const first = ensureFusionSidekick(host);
			await discoveryStarted.promise;
			const second = ensureFusionSidekick(host);
			releaseDiscovery.resolve();
			await Promise.all([first, second]);

			expect(discoverAgentsSpy).toHaveBeenCalledTimes(1);
			expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
			expect(refs.size).toBe(1);
			expect(recordedId).toBe([...refs.keys()][0]);
			expect(promptRefreshes).toBe(1);
		});

		it("deduplicates forced transition ensures queued behind startup", async () => {
			const refs = new Map<string, AgentRefLike>();
			agentRegistrySpy.mockImplementation(() => ({ get: (id: string) => refs.get(id) }) as unknown as AgentRegistry);
			const lifecycle = {
				release: async (id: string, expected: AgentRefLike) => {
					if (refs.get(id) === expected) refs.delete(id);
					return true;
				},
			};
			const releaseSpy = spyOn(lifecycle, "release");
			lifecycleSpy.mockImplementation(() => lifecycle as unknown as AgentLifecycleManager);

			const firstDiscoveryStarted = Promise.withResolvers<void>();
			const releaseFirstDiscovery = Promise.withResolvers<void>();
			let discoveryCount = 0;
			discoverAgentsSpy.mockImplementation(async () => {
				discoveryCount++;
				if (discoveryCount === 1) {
					firstDiscoveryStarted.resolve();
					await releaseFirstDiscovery.promise;
				}
				return {
					agents: [{ id: "task", name: "task", kind: "task", path: "/test" }],
					projectAgentsDir: null,
				};
			});
			runSubprocessSpy.mockImplementation(async (options: { id: string }) => {
				refs.set(options.id, { id: options.id, session: {}, status: "running" });
				return undefined as never;
			});

			let recordedId: string | undefined;
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "delegate" }),
			});

			const startup = ensureFusionSidekick(host);
			await firstDiscoveryStarted.promise;
			const firstTransition = ensureFusionSidekick(host, { force: true });
			const secondTransition = ensureFusionSidekick(host, { force: true });
			releaseFirstDiscovery.resolve();
			await Promise.all([startup, firstTransition, secondTransition]);

			expect(runSubprocessSpy).toHaveBeenCalledTimes(2);
			expect(releaseSpy).toHaveBeenCalledTimes(1);
			expect(refs.size).toBe(1);
			expect(recordedId).toBe([...refs.keys()][0]);
		});

		it("counts the initial failure and exhausts the configured Fusion pool once", async () => {
			const registryMock = { get: () => undefined };
			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);
			lifecycleSpy.mockImplementation(() => ({ release: async () => {} }) as unknown as AgentLifecycleManager);
			discoverAgentsSpy.mockImplementation(async () => ({
				agents: [{ id: "task", name: "task", kind: "task", path: "/test" }],
				projectAgentsDir: null,
			}));
			const attemptedSelectors: string[] = [];
			runSubprocessSpy.mockImplementation(async (options: ExecutorOptions) => {
				const override = options.modelOverride;
				attemptedSelectors.push(Array.isArray(override) ? (override[0] ?? "") : (override ?? ""));
				return {
					index: options.index,
					id: options.id,
					agent: options.agent.name,
					agentSource: options.agent.source,
					task: options.task,
					exitCode: 1,
					output: "",
					stderr: "terminated before registration",
					truncated: false,
					durationMs: 1,
					tokens: 0,
					requests: 1,
					error: "terminated before registration",
				} satisfies SingleResult;
			});

			const session = makeMockAgentSession();
			const refreshSpy = spyOn(session, "refreshBaseSystemPrompt");
			const host = makeHost({
				session,
				settings: makeSettings({
					"fusion.enabled": true,
					"fusion.mode": "delegate",
					"fusion.sidekickModel": "fallback/sidekick",
					"fusion.modelPool": ["1=pool/first", "2=pool/second", "3=pool/third"],
				}),
			});

			await ensureFusionSidekick(host);

			expect(attemptedSelectors).toEqual(["pool/first", "pool/second", "pool/third"]);
			expect(runSubprocessSpy).toHaveBeenCalledTimes(3);
			expect(refreshSpy).toHaveBeenCalledTimes(1);
		});

		it("force:true releases stale ref and respawns", async () => {
			const releaseMock = { release: async (_id: string, _expected: AgentRefLike) => true };
			const releaseSpy = spyOn(releaseMock, "release");

			const staleRef: AgentRefLike = { id: "stale-id", session: {}, status: "idle" };
			const refs = new Map<string, AgentRefLike>([["stale-id", staleRef]]);
			const registryMock = {
				get: (id: string) => refs.get(id),
			};
			const lifecycleMock = {
				release: releaseSpy.mockImplementation(async (staleId: string, expected: AgentRefLike) => {
					if (refs.get(staleId) === expected) refs.delete(staleId);
					return true;
				}),
			};

			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);
			lifecycleSpy.mockImplementation(() => lifecycleMock as unknown as AgentLifecycleManager);

			// discoverAgents returns a task agent so spawn proceeds
			discoverAgentsSpy.mockImplementation(async () => ({
				agents: [{ id: "task", name: "task", kind: "task", path: "/test" }],
				projectAgentsDir: null,
			}));
			runSubprocessSpy.mockImplementation(async (options: { id: string }) => {
				refs.set(options.id, { id: options.id, session: {}, status: "running" });
				return undefined as never;
			});

			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => "stale-id",
					setFusionSidekickId: () => {},
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "delegate" }),
			});

			await ensureFusionSidekick(host, { force: true });

			expect(releaseSpy).toHaveBeenCalledWith("stale-id", staleRef);
			expect(runSubprocessSpy).toHaveBeenCalled();
		});

		it("force:true preserves a concurrent replacement after stale release succeeds", async () => {
			const staleRef: AgentRefLike = { id: "stale-id", session: null, status: "parked" };
			const replacementRef: AgentRefLike = { id: "stale-id", session: {}, status: "running" };
			const refs = new Map<string, AgentRefLike>([["stale-id", staleRef]]);
			const releaseMock = { release: async (_id: string, _expected: AgentRefLike) => true };
			const releaseSpy = spyOn(releaseMock, "release").mockImplementation(async () => {
				refs.set("stale-id", replacementRef);
				return true;
			});
			agentRegistrySpy.mockImplementation(() => ({ get: (id: string) => refs.get(id) }) as unknown as AgentRegistry);
			lifecycleSpy.mockImplementation(() => releaseMock as unknown as AgentLifecycleManager);

			let recordedId: string | undefined = "stale-id";
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "delegate" }),
			});

			await ensureFusionSidekick(host, { force: true });

			expect(releaseSpy).toHaveBeenCalledWith("stale-id", staleRef);
			expect(discoverAgentsSpy).not.toHaveBeenCalled();
			expect(runSubprocessSpy).not.toHaveBeenCalled();
			expect(recordedId).toBe("stale-id");
			expect(refs.get("stale-id")).toBe(replacementRef);
		});
	});

	// ---------------------------------------------------------------------------
	// reconcileFusionSidekickModel
	// ---------------------------------------------------------------------------

	describe("reconcileFusionSidekickModel", () => {
		it("returns early when fusion is disabled", async () => {
			const host = makeHost({
				settings: makeSettings({ "fusion.enabled": false }),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(result).toEqual({ note: "", sidekickLive: false });
		});

		it("retargets a live idle sidekick via setModelTemporary", async () => {
			const targetModel: Model<Api> = { provider: "test", id: "model-x", contextWindow: 128000 } as Model<Api>;

			const liveSession: AgentSessionLike = {
				settings: makeSettings(),
				modelRegistry: {
					getAvailable: () => [targetModel],
					hasConfiguredAuth: () => true,
				},
				sessionManager: makeMockSessionManager(),
				getFusionSidekickId: () => "live-id",
				setFusionSidekickId: () => {},
				refreshBaseSystemPrompt: async () => {},
				model: { provider: "test", id: "old-model", contextWindow: 128000 } as Model<Api>,
				isStreaming: false,
				setModelTemporary: async () => {},
			};
			const setModelTemporarySpy = spyOn(liveSession, "setModelTemporary");

			const liveRef: AgentRefLike = {
				id: "live-id",
				session: liveSession as unknown as AgentSession,
				status: "idle",
			};
			const registryMock = { get: (_id: string) => liveRef };
			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);

			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => "live-id",
					modelRegistry: {
						getAvailable: () => [targetModel],
						hasConfiguredAuth: () => true,
					},
				}),
				settings: makeSettings({
					"fusion.enabled": true,
					"fusion.mode": "delegate",
					"fusion.sidekickModel": "test/model-x",
				}),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(setModelTemporarySpy).toHaveBeenCalled();
			expect(result.sidekickLive).toBe(true);
		});

		it("leaves mid-turn sidekick alone — setModelTemporary not called", async () => {
			const targetModel: Model<Api> = { provider: "test", id: "model-y", contextWindow: 128000 } as Model<Api>;

			const liveSession: AgentSessionLike = {
				settings: makeSettings(),
				modelRegistry: {
					getAvailable: () => [targetModel],
					hasConfiguredAuth: () => true,
				},
				sessionManager: makeMockSessionManager(),
				getFusionSidekickId: () => "streaming-id",
				setFusionSidekickId: () => {},
				refreshBaseSystemPrompt: async () => {},
				model: { provider: "test", id: "old-model", contextWindow: 128000 } as Model<Api>,
				isStreaming: true,
				setModelTemporary: async () => {},
			};
			const setModelTemporarySpy = spyOn(liveSession, "setModelTemporary");

			const liveRef: AgentRefLike = {
				id: "streaming-id",
				session: liveSession as unknown as AgentSession,
				status: "idle",
			};
			const registryMock = { get: (_id: string) => liveRef };
			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);

			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => "streaming-id",
					modelRegistry: {
						getAvailable: () => [targetModel],
						hasConfiguredAuth: () => true,
					},
				}),
				settings: makeSettings({
					"fusion.enabled": true,
					"fusion.mode": "delegate",
					"fusion.sidekickModel": "test/model-y",
				}),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(setModelTemporarySpy).not.toHaveBeenCalled();
			expect(result.note).toContain("mid-turn");
			expect(result.sidekickLive).toBe(true);
		});

		it("releases parked sidekick and calls ensureFusionSidekick to respawn", async () => {
			const releaseMock = { release: async (_id: string, _expected: AgentRefLike) => true };
			const releaseSpy = spyOn(releaseMock, "release");

			const parkedRef: AgentRefLike = { id: "parked-id", session: null, status: "parked" };
			const refs = new Map<string, AgentRefLike>([["parked-id", parkedRef]]);
			const registryMock = {
				get: (id: string) => refs.get(id),
			};
			const lifecycleMock = {
				release: releaseSpy.mockImplementation(async (parkedId: string, expected: AgentRefLike) => {
					if (refs.get(parkedId) === expected) refs.delete(parkedId);
					return true;
				}),
			};

			agentRegistrySpy.mockImplementation(() => registryMock as unknown as AgentRegistry);
			lifecycleSpy.mockImplementation(() => lifecycleMock as unknown as AgentLifecycleManager);

			discoverAgentsSpy.mockImplementation(async () => ({
				agents: [{ id: "task", name: "task", kind: "task", path: "/test" }],
				projectAgentsDir: null,
			}));
			runSubprocessSpy.mockImplementation(async (options: { id: string }) => {
				refs.set(options.id, { id: options.id, session: {}, status: "running" });
				return undefined as never;
			});

			let recordedId: string | undefined = "parked-id";
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
				}),
				settings: makeSettings({
					"fusion.enabled": true,
					"fusion.mode": "delegate",
				}),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(releaseSpy).toHaveBeenCalledWith("parked-id", parkedRef);
			expect(result.note).not.toBe("");
			expect(result.sidekickLive).toBe(true);
			expect(recordedId).toBeTruthy();
			expect(recordedId).not.toBe("parked-id");
		});

		it("keeps a concurrent parked-id replacement after stale release succeeds", async () => {
			const parkedRef: AgentRefLike = { id: "parked-id", session: null, status: "parked" };
			const replacementRef: AgentRefLike = { id: "parked-id", session: {}, status: "running" };
			const refs = new Map<string, AgentRefLike>([["parked-id", parkedRef]]);
			const releaseMock = { release: async (_id: string, _expected: AgentRefLike) => true };
			const releaseSpy = spyOn(releaseMock, "release").mockImplementation(async () => {
				refs.set("parked-id", replacementRef);
				return true;
			});
			agentRegistrySpy.mockImplementation(() => ({ get: (id: string) => refs.get(id) }) as unknown as AgentRegistry);
			lifecycleSpy.mockImplementation(() => releaseMock as unknown as AgentLifecycleManager);

			let recordedId: string | undefined = "parked-id";
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "delegate" }),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(releaseSpy).toHaveBeenCalledWith("parked-id", parkedRef);
			expect(result).toEqual({
				note: "Sidekick changed concurrently; keeping the current registered generation.",
				sidekickLive: true,
			});
			expect(discoverAgentsSpy).not.toHaveBeenCalled();
			expect(runSubprocessSpy).not.toHaveBeenCalled();
			expect(recordedId).toBe("parked-id");
			expect(refs.get("parked-id")).toBe(replacementRef);
		});
	});
});
