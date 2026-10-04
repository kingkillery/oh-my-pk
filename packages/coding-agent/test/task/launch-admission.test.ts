import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import { type } from "arktype";
import { Settings } from "../../src/config/settings";
import { LifecycleStore } from "../../src/operational/lifecycle-store";
import { getLifecycleRegistration } from "../../src/orchestration/lifecycle-authority";
import { authorizeToolInvocation, guardLifecycleTool } from "../../src/orchestration/lifecycle-tool-guard";
import {
	activateLifecycleLaunch,
	type PendingLifecycleLaunch,
	terminateLifecycleLaunch,
} from "../../src/task/launch-admission";
import { createLifecycleRootIssuer } from "../../src/task/lifecycle-session";
import {
	admitBoundChildLaunch,
	captureLaunchBaseline,
	LAUNCH_ENTRY_POINTS,
	prepareSessionChildLaunch,
} from "../../src/task/spawn-admission";
import { createSpawnPlan } from "../../src/task/spawn-plan";
import { resolveToolProfile } from "../../src/tools/tool-profiles";
import {
	createTestCollaborationPolicy,
	createTestExecutionProfile,
} from "../operational/fixtures/launch-authority-input";

const directories: string[] = [];
const stores: LifecycleStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
	const directory = await mkdtemp(path.join(tmpdir(), "ompk-launch-admission-"));
	directories.push(directory);
	const settings = Settings.isolated();
	settings.override("task.maxConcurrency", 1);
	const store = await LifecycleStore.open({ dbPath: path.join(directory, "authority.db") });
	stores.push(store);
	const capabilities = [
		{ source: "custom" as const, name: "probe" },
		{ source: "builtin" as const, name: "read" },
	];
	const issuer = createLifecycleRootIssuer("root-session", settings, capabilities);
	const profile = { ...createTestExecutionProfile(), tier: "frontier" as const, autonomy: "independent" as const };
	const toolProfile = resolveToolProfile({ execution: profile, declaredCapabilities: capabilities });
	const plan = createSpawnPlan({
		correlationId: "test-call",
		agentName: "task",
		assignment: "Verify admission",
		profile,
	});
	if (!plan.ok) throw new Error(plan.diagnostics.map(item => item.message).join("; "));
	const baseline = await captureLaunchBaseline(directory, path.join(directory, "evidence"));
	const admit = async (
		key: string,
		owner: { readonly store?: LifecycleStore; readonly issuer?: typeof issuer } = {},
	): Promise<PendingLifecycleLaunch> => {
		const result = await admitBoundChildLaunch({
			issuer: owner.issuer ?? issuer,
			store: owner.store ?? store,
			spawnPlan: plan.plan,
			entryPoint: LAUNCH_ENTRY_POINTS.taskSpawn,
			reason: "Contract test",
			agentName: "task",
			assignment: "Verify admission",
			agentDefinition: {
				name: "task",
				description: "Worker",
				systemPrompt: "Complete assignment",
				source: "bundled",
			},
			executionProfile: profile,
			toolProfile,
			collaborationPolicy: createTestCollaborationPolicy(),
			repoRoot: directory,
			baseline,
			evidenceDir: path.join(directory, "evidence"),
			idempotencyKey: key,
		});
		if (!result.ok) throw new Error(`${result.code}: ${result.diagnostics.map(item => item.message).join("; ")}`);
		return result.pending;
	};
	return { directory, settings, capabilities, store, issuer, admit };
}

describe("launch baseline evidence", () => {
	it("pins workspace state by digest without persisting file contents", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "ompk-launch-baseline-"));
		directories.push(directory);
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" });
			if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		};
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		await Bun.write(path.join(directory, "tracked.txt"), "tracked\n");
		git("add", "tracked.txt");
		git("commit", "-q", "-m", "init");
		await Bun.write(path.join(directory, "tracked.txt"), "tracked\nEDITED-CONTENT-MARKER\n");
		await Bun.write(path.join(directory, "secret.env"), "API_TOKEN=UNTRACKED-SECRET-MARKER\n");

		const ref = await captureLaunchBaseline(directory, path.join(directory, "evidence"));
		const manifest = await Bun.file(fileURLToPath(ref.manifestUri)).text();
		expect(manifest).not.toContain("UNTRACKED-SECRET-MARKER");
		expect(manifest).not.toContain("EDITED-CONTENT-MARKER");
		const parsed = JSON.parse(manifest) as {
			root: { untracked: string[]; unstagedDigest: string; untrackedPatchDigest: string };
		};
		expect(parsed.root.untracked).toContain("secret.env");
		expect(parsed.root.unstagedDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(parsed.root.untrackedPatchDigest).toMatch(/^[0-9a-f]{64}$/);
		// The ref still identifies the exact state: changing the file changes it.
		await Bun.write(path.join(directory, "secret.env"), "API_TOKEN=ROTATED\n");
		const after = await captureLaunchBaseline(directory, path.join(directory, "evidence"));
		expect(after.manifestHash).not.toBe(ref.manifestHash);
	});
});

describe("host launch admission and executable dispatch", () => {
	it("replays at full capacity and refuses a distinct admission without duplicating the child", async () => {
		const { store, issuer, admit } = await fixture();
		const original = await admit("replay-at-capacity");
		const replay = await admit("replay-at-capacity");
		expect(replay.launch.binding.bindingId).toBe(original.launch.binding.bindingId);
		expect(store.countLiveChildBindings(getLifecycleRegistration(issuer)!.root!.rootPrincipalId)).toBe(1);
		await expect(admit("over-capacity")).rejects.toThrow("spawn_children_exhausted");
	});

	it("releases children a previous process left live before its first admission", async () => {
		const { directory, settings, capabilities, store, issuer, admit } = await fixture();
		const principal = getLifecycleRegistration(issuer)!.root!.rootPrincipalId;
		// A live child, then the process exits without settling it.
		const orphan = await admit("before-exit");
		await activateLifecycleLaunch(
			orphan,
			"exited-child-session",
			directory,
			{ child: "exited-eval", parent: "parent-eval" },
			path.join(directory, "evidence"),
		);
		// Within one process a live child is never released: the one-child
		// ceiling holds.
		await expect(admit("same-process")).rejects.toThrow("spawn_children_exhausted");
		store.close();
		stores.splice(stores.indexOf(store), 1);

		// The resumed session reopens the store in a new process and mints its
		// root issuer for the same session again. Its first admission releases
		// the orphan instead of failing at the ceiling.
		const reopened = await LifecycleStore.open({ dbPath: store.dbPath });
		stores.push(reopened);
		const resumedIssuer = createLifecycleRootIssuer("root-session", settings, capabilities);
		expect(getLifecycleRegistration(resumedIssuer)!.root!.rootPrincipalId).toBe(principal);
		const resumed = await admit("after-exit", { store: reopened, issuer: resumedIssuer });
		expect(reopened.getLaunchBinding(orphan.launch.binding.bindingId).state).toBe("failed");
		expect(reopened.getLaunchBinding(resumed.launch.binding.bindingId).state).toBe("authorized");
		expect(reopened.countLiveChildBindings(principal)).toBe(1);
	});

	it("does not terminalize the live owner when a replay attempts a foreign activation", async () => {
		const { directory, store, admit } = await fixture();
		const owner = await admit("owner");
		const replay = await admit("owner");
		await activateLifecycleLaunch(
			owner,
			"owned-session",
			directory,
			{ child: "owned-eval", parent: "parent-eval" },
			path.join(directory, "evidence"),
		);
		await expect(
			activateLifecycleLaunch(
				replay,
				"foreign-session",
				directory,
				{ child: "foreign-eval", parent: "parent-eval" },
				path.join(directory, "evidence"),
			),
		).rejects.toThrow();
		expect(store.getLaunchBinding(owner.launch.binding.bindingId).state).toBe("bound");
		expect(store.getLaunchBinding(owner.launch.binding.bindingId).sessionId).toBe("owned-session");
	});

	it("terminalizes evidence-persistence failure and allows the next real admission", async () => {
		const { directory, store, admit } = await fixture();
		const pending = await admit("evidence-failure");
		const blockedDirectory = path.join(directory, "not-a-directory");
		await Bun.write(blockedDirectory, "file");
		await expect(
			activateLifecycleLaunch(
				pending,
				"failed-session",
				directory,
				{ child: "owned-eval", parent: "parent-eval" },
				blockedDirectory,
			),
		).rejects.toThrow();
		expect(store.getLaunchBinding(pending.launch.binding.bindingId).state).toBe("failed");
		await admit("after-evidence-failure");
	});
	it("binds actual session identity, contains path targets to the workspace and observes durable revocation", async () => {
		const { directory, store, admit } = await fixture();
		const pending = await admit("first");
		expect(store.getLaunchBinding(pending.launch.binding.bindingId).state).toBe("authorized");
		const context = await activateLifecycleLaunch(
			pending,
			"actual-child-session",
			directory,
			{ child: "session:child.jsonl:cwd:workspace", parent: "session:parent.jsonl:cwd:workspace" },
			path.join(directory, "evidence"),
		);
		expect(store.getLaunchBinding(pending.launch.binding.bindingId).sessionId).toBe("actual-child-session");
		let calls = 0;
		const tool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read",
			parameters: type({ path: "string" }),
			approval: "read",
			async execute() {
				calls++;
				return { content: [{ type: "text", text: "executed" }], details: {} };
			},
		};
		const guarded = guardLifecycleTool(tool, context, "builtin");
		// The worker's scope is its working directory: inside it the tool runs,
		// outside it the call is denied before the tool body.
		await guarded.execute("read-1", { path: "src/file.ts" });
		expect(calls).toBe(1);
		expect(() => guarded.execute("read-outside", { path: "../escape.ts" })).toThrow("target_outside_scope");
		expect(calls).toBe(1);
		terminateLifecycleLaunch(pending, "revoked", "Test durable revocation");
		expect(() => guarded.execute("read-2", { path: "src/file.ts" })).toThrow("launch_authority_revoked");
		expect(calls).toBe(1);
	});

	it("rejects shared eval activation, records failure and releases real capacity", async () => {
		const { directory, store, issuer, admit } = await fixture();
		const pending = await admit("bad-eval");
		await expect(
			activateLifecycleLaunch(
				pending,
				"real-child",
				directory,
				{ child: "same-eval-state", parent: "same-eval-state" },
				path.join(directory, "evidence"),
			),
		).rejects.toThrow("required_eval_ownership_unavailable");
		expect(store.getLaunchBinding(pending.launch.binding.bindingId).state).toBe("failed");
		const principal = getLifecycleRegistration(issuer)?.root?.rootPrincipalId;
		expect(store.countLiveChildBindings(principal!)).toBe(0);
		const allowed = await admit("next-child");
		expect(allowed.launch.binding.bindingId).not.toBe(pending.launch.binding.bindingId);
	});

	it("checks retained and replaced same-name executables against their captured registration sources", async () => {
		const { directory, admit } = await fixture();
		const pending = await admit("sources");
		const context = await activateLifecycleLaunch(
			pending,
			"source-child",
			directory,
			{ child: "child-eval", parent: "parent-eval" },
			path.join(directory, "evidence"),
		);
		let calls = 0;
		const createTool = (): AgentTool => ({
			name: "probe",
			label: "Probe",
			description: "Probe",
			parameters: type({}),
			approval: "exec",
			async execute() {
				calls++;
				return { content: [{ type: "text", text: "executed" }], details: {} };
			},
		});
		const registry = new Map<string, AgentTool>();
		const retained = guardLifecycleTool(createTool(), context, "custom");
		registry.set("probe", retained);
		registry.set("probe", guardLifecycleTool(createTool(), context, "mcp"));
		expect(() => registry.get("probe")!.execute("replacement", {})).toThrow("capability_not_granted");
		await retained.execute("retained", {});
		expect(calls).toBe(1);
	});

	it("leaves an unbound executable identical on the default-off path", async () => {
		const tool: AgentTool = {
			name: "legacy",
			label: "Legacy",
			description: "Legacy",
			parameters: type({}),
			async execute() {
				return { content: [{ type: "text", text: "legacy" }], details: {} };
			},
		};
		expect(guardLifecycleTool(tool, undefined, undefined)).toBe(tool);
		expect((await tool.execute("legacy-call", {})).content).toEqual([{ type: "text", text: "legacy" }]);
	});

	it("requires declared targets for nonbuiltin same-name tools and rejects malformed declarations", async () => {
		const { directory, admit } = await fixture();
		const pending = await admit("target-semantics");
		const context = await activateLifecycleLaunch(
			pending,
			"target-child",
			directory,
			{ child: "child-eval", parent: "parent-eval" },
			path.join(directory, "evidence"),
		);
		for (const source of ["custom", "mcp"] as const) {
			for (const name of ["read", "write", "irc"]) {
				expect(() =>
					authorizeToolInvocation(context, source, { name, approval: "read" }, "same-name", {
						path: "src/file.ts",
					}),
				).toThrow("undeclared_tool_targets");
			}
		}
		for (const matcherPaths of [42, () => 42, () => ["src/file.ts", 42], () => [""]]) {
			expect(() =>
				authorizeToolInvocation(
					context,
					"custom",
					{ name: "probe", approval: "read", matcherPaths },
					"malformed",
					{},
				),
			).toThrow("invalid_tool_targets");
		}
	});

	it("default-off spawn admission creates neither the authority database nor evidence", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "ompk-launch-disabled-"));
		directories.push(directory);
		const pending = await prepareSessionChildLaunch({
			settings: Settings.isolated(),
			issuer: undefined,
			agentDir: directory,
			cwd: directory,
			agentDefinition: {
				name: "task",
				description: "Worker",
				systemPrompt: "Complete assignment",
				source: "bundled",
			},
			assignment: "Ordinary task",
			idempotencyKey: "ordinary",
			entryPoint: LAUNCH_ENTRY_POINTS.taskSpawn,
		});
		expect(pending).toBeUndefined();
		expect(await Bun.file(path.join(directory, "lifecycle-authority.db")).exists()).toBe(false);
		expect(await Bun.file(path.join(directory, "launch-evidence")).exists()).toBe(false);
	});
});
