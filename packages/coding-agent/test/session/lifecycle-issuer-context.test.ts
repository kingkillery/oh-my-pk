/**
 * Issuer-context seam (W3 §14.6): AgentSession.getLifecycleIssuerContext and
 * the root bootstrap's install path.
 *
 * Semantics under test:
 * - legacy session: no issuer context, no bound context → both accessors
 *   return undefined (legacy spawn path unchanged);
 * - bound child session: issuer for ITS children is its own bound context;
 * - root session: issuer is the root-branded context installed via config or
 *   post-construction install — and it NEVER leaks into
 *   lifecycleExecutionContext (the root stays unbound/fail-open for its own
 *   requests);
 * - installLifecycleIssuerContext is first-writer-wins.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	createHostRootExecutionContext,
	registerLifecycleExecutionContext,
} from "@pk-nerdsaver-ai/pi-coding-agent/orchestration/lifecycle-authority";
import { AgentSession, type AgentSessionConfig } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { createTestEnvelope, createTestPolicy } from "../helpers/lifecycle-fixtures";

let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let model: Model;

beforeAll(async () => {
	sharedDir = TempDir.createSync("@pi-issuer-ctx-shared-");
	authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected built-in anthropic model to exist");
	model = bundled;
});

afterAll(async () => {
	authStorage.close();
	try {
		await sharedDir.remove();
	} catch {}
});

let tempDir: TempDir | undefined;
const sessions: AgentSession[] = [];

function createSession(config: Partial<AgentSessionConfig>): AgentSession {
	tempDir ??= TempDir.createSync("@pi-issuer-ctx-");
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const agent = new Agent({
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		advisorReadOnlyTools: [],
		...config,
	});
	sessions.push(session);
	return session;
}

afterEach(async () => {
	while (sessions.length > 0) await sessions.pop()?.dispose();
	try {
		await tempDir?.remove();
	} catch {}
	tempDir = undefined;
});

function boundChildContext() {
	return registerLifecycleExecutionContext({
		mode: "hierarchical-v1",
		role: "worker",
		runId: "run-1",
		nodeId: "node-1",
		attemptId: "attempt-1",
		policyEpoch: 1,
		usableCapabilities: Object.freeze([{ source: "builtin" as const, name: "read" }]),
		repoRoot: "/repo",
		readableRoots: Object.freeze(["src"]),
		writableRoots: Object.freeze(["src"]),
		allowExternalWrite: false,
	});
}

function rootContext(sessionId: string) {
	return createHostRootExecutionContext({
		sessionId,
		policy: createTestPolicy({ role: "root-planner" }),
		authority: createTestEnvelope(),
	});
}

describe("AgentSession.getLifecycleIssuerContext", () => {
	it("legacy session: both accessors return undefined", () => {
		const session = createSession({});
		expect(session.getLifecycleExecutionContext()).toBeUndefined();
		expect(session.getLifecycleIssuerContext()).toBeUndefined();
	});

	it("bound child: issuer falls back to its own bound context", () => {
		const bound = boundChildContext();
		const session = createSession({ lifecycleExecutionContext: bound });
		expect(session.getLifecycleExecutionContext()).toBe(bound);
		expect(session.getLifecycleIssuerContext()).toBe(bound);
	});

	it("root via config: issuer is the root context, bound context stays undefined", () => {
		const root = rootContext("sess-config");
		const session = createSession({ lifecycleIssuerContext: root });
		expect(session.getLifecycleIssuerContext()).toBe(root);
		// CRITICAL: the root context must never land in lifecycleExecutionContext.
		expect(session.getLifecycleExecutionContext()).toBeUndefined();
	});

	it("root via post-construction install (bootstrap path)", () => {
		const session = createSession({});
		expect(session.getLifecycleIssuerContext()).toBeUndefined();
		const root = rootContext(session.sessionManager.getSessionId());
		session.installLifecycleIssuerContext(root);
		expect(session.getLifecycleIssuerContext()).toBe(root);
		expect(session.getLifecycleExecutionContext()).toBeUndefined();
	});

	it("install is first-writer-wins: config and later installs are not overwritten", () => {
		const first = rootContext("sess-first");
		const second = rootContext("sess-second");
		const session = createSession({ lifecycleIssuerContext: first });
		session.installLifecycleIssuerContext(second);
		expect(session.getLifecycleIssuerContext()).toBe(first);
	});

	it("explicit issuer context wins over the bound-context fallback", () => {
		const bound = boundChildContext();
		const issuer = boundChildContext();
		const session = createSession({ lifecycleExecutionContext: bound, lifecycleIssuerContext: issuer });
		expect(session.getLifecycleExecutionContext()).toBe(bound);
		expect(session.getLifecycleIssuerContext()).toBe(issuer);
	});
});
