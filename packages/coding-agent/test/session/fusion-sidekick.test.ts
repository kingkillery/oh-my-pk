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
	refreshBaseSystemPrompt?(): Promise<void>;
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

			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => "existing-id",
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "print" }),
			});

			await ensureFusionSidekick(host);

			expect(discoverAgentsSpy).not.toHaveBeenCalled();
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
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "print" }),
			});

			await ensureFusionSidekick(host);

			expect(discoverAgentsSpy).toHaveBeenCalled();
			expect(runSubprocessSpy).toHaveBeenCalled();
			expect(recordedId).toBeTruthy();
			expect(recordedId).not.toBe("stale-missing-id");
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

			const host = makeHost({
				settings: makeSettings({
					"fusion.enabled": true,
					"fusion.mode": "print",
					"fusion.sidekickModel": "fallback/sidekick",
					"fusion.modelPool": ["1=pool/first", "2=pool/second", "3=pool/third"],
				}),
			});

			await ensureFusionSidekick(host);

			expect(attemptedSelectors).toEqual(["pool/first", "pool/second", "pool/third"]);
			expect(runSubprocessSpy).toHaveBeenCalledTimes(3);
		});

		it("force:true releases stale ref and respawns", async () => {
			const releaseMock = { release: async (_id: string) => {} };
			const releaseSpy = spyOn(releaseMock, "release");

			const refs = new Map<string, AgentRefLike>([["stale-id", { id: "stale-id", session: {}, status: "idle" }]]);
			const registryMock = {
				get: (id: string) => refs.get(id),
			};
			const lifecycleMock = {
				release: releaseSpy.mockImplementation(async (staleId: string) => {
					refs.delete(staleId);
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
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "print" }),
			});

			await ensureFusionSidekick(host, { force: true });

			expect(releaseSpy).toHaveBeenCalled();
		});
	});

	// ---------------------------------------------------------------------------
	// Concurrency: one ensure in flight per main session
	// ---------------------------------------------------------------------------

	describe("sidekick lifecycle concurrency", () => {
		/** Registry + spawn fakes where every spawn registers its allocated id. */
		function makeWorld(initial: AgentRefLike[] = [], extraSettings: Record<string, unknown> = {}) {
			const refs = new Map(initial.map(ref => [ref.id, ref]));
			agentRegistrySpy.mockImplementation(() => ({ get: (id: string) => refs.get(id) }) as unknown as AgentRegistry);
			discoverAgentsSpy.mockImplementation(async () => ({
				agents: [{ id: "task", name: "task", kind: "task", path: "/test" }],
				projectAgentsDir: null,
			}));
			runSubprocessSpy.mockImplementation(async (options: { id: string }) => {
				refs.set(options.id, { id: options.id, session: {}, status: "running" });
				return undefined as never;
			});
			const releases: string[] = [];
			lifecycleSpy.mockImplementation(
				() =>
					({
						release: async (id: string, expected?: AgentRefLike) => {
							releases.push(id);
							if (expected === undefined || refs.get(id) === expected) refs.delete(id);
						},
					}) as unknown as AgentLifecycleManager,
			);
			let recordedId: string | undefined = initial[0]?.id;
			const prompts: Array<string | undefined> = [];
			const host = makeHost({
				session: makeMockAgentSession({
					getFusionSidekickId: () => recordedId,
					setFusionSidekickId: id => {
						recordedId = id;
					},
					refreshBaseSystemPrompt: async () => {
						prompts.push(recordedId);
					},
				}),
				settings: makeSettings({ "fusion.enabled": true, "fusion.mode": "print", ...extraSettings }),
			});
			return { refs, releases, prompts, host, recordedId: () => recordedId };
		}

		it("joins concurrent ensures into one spawn", async () => {
			const world = makeWorld();

			await Promise.all([ensureFusionSidekick(world.host), ensureFusionSidekick(world.host)]);

			expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
			expect(world.refs.has(world.recordedId() ?? "")).toBe(true);
		});

		it("queues a forced replacement behind an ordinary ensure and joins later forced hooks", async () => {
			const world = makeWorld();

			await Promise.all([
				ensureFusionSidekick(world.host),
				ensureFusionSidekick(world.host, { force: true }),
				ensureFusionSidekick(world.host, { force: true }),
			]);

			// The ordinary ensure spawns; the one forced replacement releases that
			// sidekick and spawns its successor.
			expect(runSubprocessSpy).toHaveBeenCalledTimes(2);
			expect(world.releases).toHaveLength(1);
			expect(world.refs.has(world.recordedId() ?? "")).toBe(true);
		});

		it("makes model reconciliation wait for an in-flight ensure", async () => {
			const world = makeWorld([], { "fusion.sidekickModel": "test/sidekick" });

			const ensuring = ensureFusionSidekick(world.host);
			const result = await reconcileFusionSidekickModel(world.host);
			await ensuring;

			expect(runSubprocessSpy).toHaveBeenCalledTimes(1);
			expect(result.sidekickLive).toBe(true);
		});

		it("keeps a same-id replacement that registers while a forced release runs", async () => {
			const stale: AgentRefLike = { id: "Sidekick", session: {}, status: "idle" };
			const world = makeWorld([stale]);
			lifecycleSpy.mockImplementation(
				() =>
					({
						// A concurrent replacement wins the id; the expected-ref release must skip it.
						release: async (id: string, expected?: AgentRefLike) => {
							world.refs.set(id, { id, session: {}, status: "running" });
							if (world.refs.get(id) === expected) world.refs.delete(id);
						},
					}) as unknown as AgentLifecycleManager,
			);

			await ensureFusionSidekick(world.host, { force: true });

			expect(world.recordedId()).toBe("Sidekick");
			expect(world.refs.get("Sidekick")).not.toBe(stale);
			expect(runSubprocessSpy).not.toHaveBeenCalled();
		});

		it("refreshes the base prompt after the sidekick is created", async () => {
			const world = makeWorld();

			await ensureFusionSidekick(world.host);

			expect(world.prompts.at(-1)).toBe(world.recordedId());
			expect(world.recordedId()).toBeTruthy();
		});

		it("refreshes the base prompt when the sidekick cannot be created", async () => {
			const world = makeWorld();
			discoverAgentsSpy.mockImplementation(async () => ({ agents: [], projectAgentsDir: null }));

			await ensureFusionSidekick(world.host);

			expect(world.prompts).toHaveLength(1);
			expect(world.prompts[0]).toBeUndefined();
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
					"fusion.mode": "print",
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
					"fusion.mode": "print",
					"fusion.sidekickModel": "test/model-y",
				}),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(setModelTemporarySpy).not.toHaveBeenCalled();
			expect(result.note).toContain("mid-turn");
			expect(result.sidekickLive).toBe(true);
		});

		it("releases parked sidekick and calls ensureFusionSidekick to respawn", async () => {
			const releaseMock = { release: async (_id: string) => {} };
			const releaseSpy = spyOn(releaseMock, "release");

			const refs = new Map<string, AgentRefLike>([
				["parked-id", { id: "parked-id", session: null, status: "parked" }],
			]);
			const registryMock = {
				get: (id: string) => refs.get(id),
			};
			const lifecycleMock = {
				release: releaseSpy.mockImplementation(async (parkedId: string) => {
					refs.delete(parkedId);
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
					"fusion.mode": "print",
				}),
			});

			const result = await reconcileFusionSidekickModel(host);

			expect(releaseSpy).toHaveBeenCalledWith("parked-id", { id: "parked-id", session: null, status: "parked" });
			expect(result.note).not.toBe("");
			expect(result.sidekickLive).toBe(true);
			expect(recordedId).toBeTruthy();
			expect(recordedId).not.toBe("parked-id");
		});
	});
});
