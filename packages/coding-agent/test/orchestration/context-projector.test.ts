/**
 * Real-store coverage for the lifecycle context projector (A04/W3).
 *
 * Every projection runs against an actual temporary SQLite launch-authority
 * store: fragments resolve through `launch_context_inbox`/`launch_deliveries`
 * admission rows, contract-pinned refs and live grants — never through
 * caller-supplied digests alone.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { Tool } from "@pk-nerdsaver-ai/pi-ai";
import { toolWireSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { OperationalStore } from "../../src/operational/store";
import {
	bindLifecycleProjection,
	type ContextFragment,
	getProjectionManifest,
	parseProjectionManifest,
	projectLifecycleContext,
	projectLifecycleSideRequest,
	unbindLifecycleProjection,
} from "../../src/orchestration/context-projector";
import { createStoreRecordSource } from "../../src/orchestration/context-record-loader";
import {
	createHostRootExecutionContext,
	type LifecycleExecutionContext,
	registerLifecycleExecutionContext,
} from "../../src/orchestration/lifecycle-authority";
import {
	type ArtifactRefV1,
	type CompiledLaunchContract,
	canonicalJson,
	sha256Hex,
} from "../../src/task/launch-contract";
import {
	createTestCompiledContract,
	createTestEnvelope,
	createTestHarnessManifest,
	createTestLaunchAuthority,
	createTestPolicy,
	createTestRuntimeGuarantees,
	createTestSpawnAuthority,
} from "../helpers/lifecycle-fixtures";

const rootActor = createHostRootExecutionContext({
	sessionId: "test-session",
	rootPrincipalId: "principal-root",
	policy: createTestPolicy({ role: "root-planner" }),
	authority: createTestEnvelope({
		usableCapabilities: [
			{ source: "builtin", name: "read" },
			{ source: "builtin", name: "edit" },
			{ source: "builtin", name: "bash" },
		],
		delegableCapabilities: [
			{ source: "builtin", name: "read" },
			{ source: "builtin", name: "edit" },
			{ source: "builtin", name: "bash" },
		],
		spawn: createTestSpawnAuthority({ maySpawn: true, mayDelegateSpawn: true, maxDepth: 4, maxChildren: 16 }),
	}),
});
const GUARD = { actor: rootActor, expectedPolicyEpoch: 1, idempotencyKey: "guard-1" };

function tempPath(label: string): string {
	return path.join(os.tmpdir(), `projector-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function artifactRef(id: string, uri: string, content: string): ArtifactRefV1 {
	return Object.freeze({
		schemaVersion: 1 as const,
		artifactId: id,
		uri,
		sha256: sha256Hex(content),
		bytes: Buffer.byteLength(content, "utf8"),
		mediaType: "text/plain",
		provenanceId: "test",
	});
}

interface Fixture {
	readonly store: OperationalStore;
	readonly db: Database;
	readonly bindingId: string;
	readonly attemptId: string;
	readonly contract: CompiledLaunchContract;
	readonly lifecycle: LifecycleExecutionContext;
	readonly contents: Map<string, string>;
	readonly resolveContent: (ref: { uri: string }) => Promise<string>;
	close(): void;
}

function seedFixture(label: string, authorityOverrides: Parameters<typeof createTestLaunchAuthority>[0] = {}): Fixture {
	const store = OperationalStore.open({ dbPath: tempPath(label) });
	const capabilities = Object.freeze([
		{ source: "builtin" as const, name: "read" },
		{ source: "builtin" as const, name: "edit" },
		{ source: "builtin" as const, name: "bash" },
	]);
	const envelopes = createTestEnvelope({
		usableCapabilities: capabilities,
		delegableCapabilities: capabilities,
	});
	const compiled = createTestCompiledContract(
		{},
		{},
		{
			requestedAuthority: createTestLaunchAuthority({
				usableCapabilities: Object.freeze([
					{ source: "builtin" as const, name: "read" },
					{ source: "builtin" as const, name: "edit" },
				]),
				...authorityOverrides,
			}),
			parentDelegable: envelopes,
			hostMaximum: envelopes,
			agentMaximum: envelopes,
			workflowMaximum: envelopes,
			parentPrincipalId: "principal-root",
			issuerPrincipalId: "principal-root",
		},
	);
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
		sessionId: `session-${label}`,
		processRef: null,
		serviceBindings: [],
		actualRuntimeGuarantees: createTestRuntimeGuarantees(),
		guaranteeEvidenceRefs: [artifactRef(`probe-${label}`, `file:///probe-${label}`, "probe")],
	});
	if (!activated.ok) throw new Error(`fixture activation failed: ${activated.code}`);
	const binding = activated.launch.binding;
	const contract = activated.launch.compiled;
	const lifecycle = registerLifecycleExecutionContext({
		mode: "hierarchical-v1",
		role: "worker",
		runId: "run-1",
		nodeId: "node-1",
		attemptId: binding.attemptId,
		policyEpoch: binding.policyEpoch,
		usableCapabilities: [],
		repoRoot: "/repo",
		readableRoots: [],
		writableRoots: [],
		allowExternalWrite: false,
	});
	const contents = new Map<string, string>();
	return {
		store,
		db: new Database(store.dbPath),
		bindingId,
		attemptId: binding.attemptId,
		contract,
		lifecycle,
		contents,
		resolveContent: async ({ uri }) => {
			const content = contents.get(uri);
			if (content === undefined) throw new Error(`unresolvable: ${uri}`);
			return content;
		},
		close() {
			this.db.close();
			this.store.close();
		},
	};
}

function fragment(
	id: string,
	contextClass: ContextFragment["contextClass"],
	contentRef: string,
	content: string,
	options: { ownerScope?: string; required?: boolean; parents?: readonly string[] } = {},
): ContextFragment {
	return Object.freeze({
		id,
		contextClass,
		sourceRef: `src://${id}`,
		sourceHash: sha256Hex(content),
		ownerScope: options.ownerScope ?? "owner",
		contentRef,
		required: options.required ?? false,
		parentProvenanceIds: Object.freeze([...(options.parents ?? [])]),
	});
}

function seedChannel(fixture: Fixture, channelId: string, domains: readonly string[]): void {
	fixture.db.run(
		`INSERT OR IGNORE INTO launch_channels (binding_id, channel_id, canonical_json, policy_epoch, created_at, updated_at)
		 VALUES (?, ?, ?, 1, 1, 1)`,
		[
			fixture.bindingId,
			channelId,
			JSON.stringify({ maxMessageBytes: 8192, maxTotalBytes: 65536, maxMessages: 16, domains }),
		],
	);
}

function admitDelivery(
	fixture: Fixture,
	deliveryId: string,
	payloadUri: string,
	payloadContent: string,
	domains: readonly ("public-task" | "parent-private" | "credential-sensitive")[] = ["public-task"],
): void {
	seedChannel(fixture, "chan-1", ["public-task", "parent-private", "credential-sensitive"]);
	const result = fixture.store.admitLaunchDelivery({
		guard: GUARD,
		request: {
			deliveryId,
			channelId: "chan-1",
			recipientBindingId: fixture.bindingId,
			expectedPolicyEpoch: 1,
			attemptId: fixture.attemptId,
			contractRevision: fixture.contract.contractRevision,
			contextGeneration: 0,
			grantRefs: [],
			payloadRef: artifactRef(`art-${deliveryId}`, payloadUri, payloadContent),
			resourceRefs: [],
			domains,
			kind: "assignment",
		},
		senderPrincipalId: fixture.contract.parentPrincipalId,
		bytes: Buffer.byteLength(payloadContent, "utf8"),
	});
	if (!result.ok) throw new Error(`delivery fixture failed: ${result.code}`);
}

function baseInput(fixture: Fixture) {
	return {
		lifecycle: fixture.lifecycle,
		bindingId: fixture.bindingId,
		recordSource: createStoreRecordSource(fixture.store, fixture.db),
		resolveContent: fixture.resolveContent,
		grantGeneration: 0,
		phase: "launch" as const,
		tools: [],
	};
}

const READ_TOOL: Tool = {
	name: "read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const BASH_TOOL: Tool = {
	name: "bash",
	description: "Run a shell command",
	parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

describe("lifecycle context projector (A04/W3)", () => {
	it("projects an admitted delivery into a real provider Context", async () => {
		const fixture = seedFixture("delivery-admit");
		try {
			const payload = "authorized mission text";
			admitDelivery(fixture, "d-1", "artifact://payload-d1", payload);
			fixture.contents.set("artifact://payload-d1", payload);

			const result = await projectLifecycleContext({
				...baseInput(fixture),
				fragments: [fragment("f-1", "mission", "delivery:d-1", payload, { ownerScope: "parent" })],
			});
			expect(result.ok).toBe(true);
			if (!result.ok || result.kind !== "projected") return;
			expect(result.context.messages).toHaveLength(1);
			expect(result.context.messages[0]).toMatchObject({ role: "user", content: payload });
			expect(result.manifest.admitted.map(a => a.fragmentId)).toEqual(["f-1"]);
			expect(result.manifest.launchHash).toBe(fixture.contract.contractDigest);
			expect(parseProjectionManifest(result.manifest).manifestHash).toBe(result.manifest.manifestHash);
		} finally {
			fixture.close();
		}
	});

	it("fails closed when durable binding state is not executable", async () => {
		for (const state of ["authorized", "suspended", "terminal"] as const) {
			const fixture = seedFixture(`binding-${state}`);
			try {
				fixture.db.run("UPDATE launch_bindings SET state = ? WHERE binding_id = ?", [state, fixture.bindingId]);
				const result = await projectLifecycleContext({
					...baseInput(fixture),
					fragments: [],
				});
				expect(result).toMatchObject({ ok: false, code: "untrusted_context" });
			} finally {
				fixture.close();
			}
		}
	});

	it("fails closed on a delivery that was never admitted", async () => {
		const fixture = seedFixture("delivery-missing");
		try {
			const result = await projectLifecycleContext({
				...baseInput(fixture),
				fragments: [fragment("f-req", "mission", "delivery:never-admitted", "ghost", { required: true })],
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("missing_required_input");
			expect(result.fragmentIds).toContain("f-req");
		} finally {
			fixture.close();
		}
	});

	it("rejects a delivery whose domains exceed the channel's authorized domains", async () => {
		const fixture = seedFixture("delivery-domains");
		try {
			// The channel only authorizes public-task; the delivery was admitted
			// under a domain the channel never granted.
			fixture.db.run(
				`INSERT OR IGNORE INTO launch_channels (binding_id, channel_id, canonical_json, policy_epoch, created_at, updated_at)
				 VALUES (?, 'chan-1', ?, 1, 1, 1)`,
				[
					fixture.bindingId,
					JSON.stringify({
						maxMessageBytes: 8192,
						maxTotalBytes: 65536,
						maxMessages: 16,
						domains: ["public-task"],
					}),
				],
			);
			const payload = "restricted evidence";
			const admitted = fixture.store.admitLaunchDelivery({
				guard: GUARD,
				request: {
					deliveryId: "d-dom",
					channelId: "chan-1",
					recipientBindingId: fixture.bindingId,
					expectedPolicyEpoch: 1,
					attemptId: fixture.attemptId,
					contractRevision: fixture.contract.contractRevision,
					contextGeneration: 0,
					grantRefs: [],
					payloadRef: artifactRef("art-dom", "artifact://payload-dom", payload),
					resourceRefs: [],
					domains: ["credential-sensitive"],
					kind: "selected-context",
				},
				senderPrincipalId: fixture.contract.parentPrincipalId,
				bytes: Buffer.byteLength(payload, "utf8"),
			});
			expect(admitted.ok).toBe(true);
			fixture.contents.set("artifact://payload-dom", payload);

			const result = await projectLifecycleContext({
				...baseInput(fixture),
				fragments: [fragment("f-dom", "granted-evidence", "delivery:d-dom", payload)],
			});
			expect(result.ok).toBe(true);
			if (!result.ok || result.kind !== "projected") return;
			expect(result.context.messages).toHaveLength(0);
			expect(result.manifest.rejected).toContainEqual({ fragmentId: "f-dom", code: "record_outside_scope" });
		} finally {
			fixture.close();
		}
	});

	it("rejects a delivery whose stored payload was tampered with", async () => {
		const fixture = seedFixture("delivery-tamper");
		try {
			const payload = "original payload";
			admitDelivery(fixture, "d-1", "artifact://payload-d1", payload);
			fixture.contents.set("artifact://payload-d1", payload);
			// Tamper with the recorded payload: the recomputed request digest no
			// longer matches the recorded one, so the record is unreadable.
			fixture.db.run("UPDATE launch_deliveries SET payload_json = ? WHERE binding_id = ? AND delivery_id = 'd-1'", [
				JSON.stringify({ forged: true }),
				fixture.bindingId,
			]);
			const result = await projectLifecycleContext({
				...baseInput(fixture),
				fragments: [fragment("f-1", "mission", "delivery:d-1", payload)],
			});
			expect(result.ok).toBe(true);
			if (!result.ok || result.kind !== "projected") return;
			expect(result.manifest.rejected).toContainEqual({ fragmentId: "f-1", code: "record_not_found" });
		} finally {
			fixture.close();
		}
	});

	it("assembles systemPrompt from contract-pinned base segments and capsule mission", async () => {
		const safety = "safety segment text";
		const fixture = seedFixture("contract-refs", {
			baseContextManifest: Object.freeze({
				schemaVersion: 1 as const,
				manifestHash: "0".repeat(64),
				segments: Object.freeze([
					{
						segmentId: "safety",
						kind: "safety" as const,
						contentRef: artifactRef("seg-safety", "artifact://seg-safety", safety),
					},
				]),
			}),
		});
		try {
			const capsuleText = canonicalJson(fixture.contract.capsule);
			fixture.contents.set("artifact://seg-safety", safety);
			fixture.contents.set("contract://capsule", capsuleText);
			const result = await projectLifecycleContext({
				...baseInput(fixture),
				fragments: [
					fragment("f-base", "project-invariant", "contract://base-context/safety", safety),
					fragment("f-mission", "mission", "contract://capsule", capsuleText, { required: true }),
				],
			});
			expect(result.ok).toBe(true);
			if (!result.ok || result.kind !== "projected") return;
			expect(result.context.systemPrompt).toEqual([safety]);
			expect(result.context.messages[0]).toMatchObject({ role: "user", content: capsuleText });
			expect(result.manifest.admitted).toHaveLength(2);
		} finally {
			fixture.close();
		}
	});

	it("projects only authorized tools with their real parameter schemas", async () => {
		const fixture = seedFixture("tools");
		try {
			const result = await projectLifecycleContext({
				...baseInput(fixture),
				harness: createTestHarnessManifest({
					maxTools: Object.freeze([{ source: "builtin" as const, name: "read" }]),
				}),
				fragments: [],
				tools: [
					{ source: "builtin", tool: READ_TOOL },
					{ source: "builtin", tool: BASH_TOOL },
					{ source: "builtin", tool: { name: "edit", description: "Edit", parameters: { type: "object" } } },
				],
			});
			expect(result.ok).toBe(true);
			if (!result.ok || result.kind !== "projected") return;
			// read: contract + harness allow. edit: contract allows but harness
			// ceiling drops it. bash: never in the contract's usable set.
			expect(result.context.tools).toHaveLength(1);
			expect(result.context.tools?.[0]?.name).toBe("read");
			expect(result.context.tools?.[0]?.parameters).toEqual(READ_TOOL.parameters);
			expect(result.manifest.tools).toEqual([
				{
					source: "builtin",
					name: "read",
					schemaHash: sha256Hex(canonicalJson(toolWireSchema(READ_TOOL))),
				},
			]);
			const rejectedIds = result.manifest.rejected.map(r => r.fragmentId);
			expect(rejectedIds).toContain("tool:builtin:bash");
			expect(rejectedIds).toContain("tool:builtin:edit");
		} finally {
			fixture.close();
		}
	});

	it("returns an explicit legacy passthrough when no binding is supplied", async () => {
		const existing = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
		const result = await projectLifecycleContext({
			lifecycle: null,
			bindingId: null,
			grantGeneration: 0,
			phase: "continue",
			fragments: [],
			tools: [],
			existingContext: existing,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.kind).toBe("legacy-passthrough");
		expect(result.context).toBe(existing);
		expect(result.manifest).toBeNull();
	});

	it("denies an unregistered (forged) execution context", async () => {
		const fixture = seedFixture("forged");
		try {
			const result = await projectLifecycleContext({
				...baseInput(fixture),
				lifecycle: {} as LifecycleExecutionContext,
				fragments: [],
			});
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.code).toBe("untrusted_context");
		} finally {
			fixture.close();
		}
	});

	it("excludes held-out and institutional content from a strict worker", async () => {
		const fixture = seedFixture("classes");
		try {
			const result = await projectLifecycleContext({
				...baseInput(fixture),
				fragments: [
					fragment("f-held", "held-out", "delivery:none", "secret"),
					fragment("f-inst", "institutional", "delivery:none", "org history"),
				],
			});
			expect(result.ok).toBe(true);
			if (!result.ok || result.kind !== "projected") return;
			expect(result.context.messages).toHaveLength(0);
			expect(result.manifest.rejected).toContainEqual({ fragmentId: "f-held", code: "held_out_excluded" });
			expect(result.manifest.rejected).toContainEqual({ fragmentId: "f-inst", code: "class_not_authorized" });
		} finally {
			fixture.close();
		}
	});

	it("rejects a fragment whose provenance parent was denied", async () => {
		const fixture = seedFixture("provenance");
		try {
			const result = await projectLifecycleContext({
				...baseInput(fixture),
				fragments: [
					fragment("f-parent", "granted-evidence", "delivery:missing", "x"),
					fragment("f-child", "granted-evidence", "delivery:also-missing", "y", { parents: ["f-parent"] }),
				],
			});
			expect(result.ok).toBe(true);
			if (!result.ok || result.kind !== "projected") return;
			expect(result.manifest.rejected).toContainEqual({ fragmentId: "f-child", code: "provenance_parent_denied" });
		} finally {
			fixture.close();
		}
	});

	it("admits same-lifecycle local trajectory and denies foreign trajectory", async () => {
		const fixture = seedFixture("trajectory");
		try {
			const note = "working note from this attempt";
			fixture.contents.set("local://note-1", note);
			const result = await projectLifecycleContext({
				...baseInput(fixture),
				fragments: [
					fragment("f-local", "local-trajectory", "local://note-1", note, { ownerScope: fixture.bindingId }),
					fragment("f-foreign", "local-trajectory", "local://other", "sibling notes", {
						ownerScope: "run-1/node-9",
					}),
				],
			});
			expect(result.ok).toBe(true);
			if (!result.ok || result.kind !== "projected") return;
			expect(result.context.messages).toHaveLength(1);
			expect(result.context.messages[0]).toMatchObject({ role: "user", content: note });
			expect(result.manifest.rejected).toContainEqual({ fragmentId: "f-foreign", code: "foreign_trajectory" });
		} finally {
			fixture.close();
		}
	});

	it("resolves grant-backed records and denies revoked grants", async () => {
		const fixture = seedFixture("grants");
		try {
			const content = "granted artifact bytes";
			fixture.contents.set("artifact://art-grant", content);
			const issued = fixture.store.appendLaunchGrant({
				guard: GUARD,
				request: {
					idempotencyKey: "grant-fixture-1",
					issuerPrincipalId: fixture.contract.parentPrincipalId,
					recipientPrincipalId: fixture.contract.childPrincipalId,
					recipientBindingId: fixture.bindingId,
					resource: {
						kind: "artifact",
						resourceId: "artifact://art-grant",
						versionDigest: sha256Hex(content),
						scope: { roots: [], exactIds: ["artifact://art-grant"], maxBytes: null, range: null },
					},
					operations: ["read"],
					delegableOperations: [],
					recipientConstraints: [],
					remainingDelegationDepth: 0,
					domains: ["public-task"],
					sourceGrantIds: [],
					contractRevision: fixture.contract.contractRevision,
					attemptId: fixture.attemptId,
					expiresAt: null,
					purpose: "evidence grant",
				},
			});
			expect(issued.ok).toBe(true);
			if (!issued.ok) return;
			const grantId = issued.grant.grantId;

			const result = await projectLifecycleContext({
				...baseInput(fixture),
				fragments: [fragment("f-grant", "granted-evidence", `grant:${grantId}`, content)],
			});
			expect(result.ok).toBe(true);
			if (!result.ok || result.kind !== "projected") return;
			expect(result.context.messages[0]).toMatchObject({ role: "user", content });

			fixture.store.revokeLaunchGrant({ guard: GUARD, grantId, reason: "test revocation" });
			const revoked = await projectLifecycleContext({
				...baseInput(fixture),
				fragments: [fragment("f-grant2", "granted-evidence", `grant:${grantId}`, content)],
			});
			expect(revoked.ok).toBe(true);
			if (!revoked.ok || revoked.kind !== "projected") return;
			expect(revoked.manifest.rejected).toContainEqual({ fragmentId: "f-grant2", code: "record_revoked" });
		} finally {
			fixture.close();
		}
	});
});

describe("projectLifecycleSideRequest (§5.1–5.2)", () => {
	it("passes the caller context through unchanged for a null lifecycle", async () => {
		const context = { systemPrompt: ["sys"], messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
		const result = await projectLifecycleSideRequest(context, "completion", null);
		expect(result).toBe(context);
		expect(getProjectionManifest(result)).toBeUndefined();
	});

	it("fails closed when a bound lifecycle has no projection binding", async () => {
		const fixture = seedFixture("side-unbound");
		try {
			const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
			await expect(projectLifecycleSideRequest(context, "completion", fixture.lifecycle)).rejects.toMatchObject({
				code: "untrusted_context",
			});
		} finally {
			fixture.close();
		}
	});

	const bind = (fixture: Fixture) =>
		bindLifecycleProjection(fixture.lifecycle, {
			bindingId: fixture.bindingId,
			recordSource: createStoreRecordSource(fixture.store, fixture.db),
			resolveContent: fixture.resolveContent,
			grantGeneration: 0,
			toolSourceOf: name => (name === "read" || name === "edit" || name === "bash" ? "builtin" : undefined),
			issueFragment: ({ id, content }) => {
				const uri = `session://test/${id}`;
				fixture.contents.set(uri, content);
				return { contentRef: uri, sourceHash: sha256Hex(content) };
			},
		});

	it("projects a bound context, intersects tools with the contract, and records the manifest", async () => {
		const fixture = seedFixture("side-projected");
		try {
			bind(fixture);
			const context = {
				systemPrompt: ["stable prefix"],
				messages: [
					{ role: "user" as const, content: "do the thing", timestamp: 1 },
					{
						role: "assistant" as const,
						content: [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "a" } }],
						api: "anthropic-messages" as never,
						provider: "anthropic" as never,
						model: "m",
						usage: {} as never,
						stopReason: "toolUse" as never,
						timestamp: 2,
					},
					{
						role: "toolResult" as const,
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text" as const, text: "file bytes" }],
						isError: false,
						timestamp: 3,
					},
				],
				tools: [READ_TOOL, BASH_TOOL],
			};
			const projected = await projectLifecycleSideRequest(context, "advisor", fixture.lifecycle);
			// bash is outside the contract's usableCapabilities (read/edit only).
			expect(projected.tools?.map(t => t.name)).toEqual(["read"]);
			expect(projected.messages).toBe(context.messages);
			expect(projected.systemPrompt).toBe(context.systemPrompt);
			const manifest = getProjectionManifest(projected);
			expect(manifest).toBeDefined();
			expect(manifest?.phase).toBe("side-request");
			expect(manifest?.admitted.length).toBe(4); // 1 system block + 3 messages
			expect(manifest?.rejected).toContainEqual({ fragmentId: "tool:builtin:bash", code: "tool_not_authorized" });
			expect(manifest?.tools.map(t => t.name)).toEqual(["read"]);
		} finally {
			unbindLifecycleProjection(fixture.lifecycle);
			fixture.close();
		}
	});

	it("rejects a toolResult whose tool call is absent rather than emit malformed history", async () => {
		const fixture = seedFixture("side-orphan");
		try {
			bind(fixture);
			const context = {
				messages: [
					{
						role: "toolResult" as const,
						toolCallId: "missing-call",
						toolName: "read",
						content: [{ type: "text" as const, text: "orphan" }],
						isError: false,
						timestamp: 1,
					},
				],
			};
			await expect(projectLifecycleSideRequest(context, "compact", fixture.lifecycle)).rejects.toMatchObject({
				code: "missing_required_input",
				fragmentIds: ["msg:toolResult:missing-call"],
			});
		} finally {
			unbindLifecycleProjection(fixture.lifecycle);
			fixture.close();
		}
	});

	it("fails closed when tools are present but no toolSourceOf can qualify them", async () => {
		const fixture = seedFixture("side-no-source");
		try {
			bindLifecycleProjection(fixture.lifecycle, {
				bindingId: fixture.bindingId,
				recordSource: createStoreRecordSource(fixture.store, fixture.db),
				resolveContent: fixture.resolveContent,
				grantGeneration: 0,
			});
			const context = {
				messages: [{ role: "user" as const, content: "hi", timestamp: 1 }],
				tools: [READ_TOOL],
			};
			await expect(projectLifecycleSideRequest(context, "completion", fixture.lifecycle)).rejects.toMatchObject({
				code: "untrusted_context",
			});
		} finally {
			unbindLifecycleProjection(fixture.lifecycle);
			fixture.close();
		}
	});

	it("denies a tool whose source cannot be resolved", async () => {
		const fixture = seedFixture("side-unknown-tool");
		try {
			bind(fixture);
			const context = {
				messages: [{ role: "user" as const, content: "hi", timestamp: 1 }],
				tools: [{ name: "mystery", description: "?", parameters: { type: "object" } }],
			};
			await expect(projectLifecycleSideRequest(context, "completion", fixture.lifecycle)).rejects.toMatchObject({
				code: "untrusted_context",
				fragmentIds: ["tool:mystery"],
			});
		} finally {
			unbindLifecycleProjection(fixture.lifecycle);
			fixture.close();
		}
	});
});
