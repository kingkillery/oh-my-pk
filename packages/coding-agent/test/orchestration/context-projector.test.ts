import { describe, expect, it } from "bun:test";
import {
	buildFragment,
	parseProjectionManifest,
	projectLifecycleContext,
} from "../../src/orchestration/context-projector";
import { DUMMY_HASH_1, DUMMY_HASH_2 } from "../helpers/lifecycle-fixtures";

describe("Lifecycle context projector (A04)", () => {
	it("admits matching fragments and reports the manifest", () => {
		const allowed = buildFragment("a1", "granted-evidence", "run-1/node-1", "authorized source text");
		const result = projectLifecycleContext({
			launchHash: DUMMY_HASH_1,
			policyHash: DUMMY_HASH_2,
			harnessHash: DUMMY_HASH_1,
			grantGeneration: 1,
			phase: "launch",
			fragments: [allowed],
			tools: [{ source: "builtin", name: "read", schemaHash: DUMMY_HASH_1 }],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.context.messages).toContain("authorized source text");
		expect(result.manifest.admitted).toHaveLength(1);
		expect(result.manifest.admitted[0]?.fragmentId).toBe("a1");

		// Round-trip parse revalidates
		const parsed = parseProjectionManifest(result.manifest);
		expect(parsed.manifestHash).toBe(result.manifest.manifestHash);
	});

	it("excludes tampered content and keeps the audit manifest", () => {
		const good = buildFragment("a1", "granted-evidence", "run-1/node-1", "good text");
		const tampered = { ...good, id: "evil", content: "forged operational canary" };
		const result = projectLifecycleContext({
			launchHash: DUMMY_HASH_1,
			policyHash: DUMMY_HASH_2,
			harnessHash: DUMMY_HASH_1,
			grantGeneration: 1,
			phase: "continue",
			fragments: [good, tampered],
			tools: [],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.context.messages.join("\n")).not.toContain("forged operational canary");
		expect(result.manifest.rejected.map(r => r.fragmentId)).toContain("evil");
	});

	it("blocks the request when a required fragment is denied", () => {
		const good = buildFragment("a1", "mission", "run-1/root", "objective", { required: true });
		const missing = { ...good, id: "req-input", content: "changed without provenance" };
		const result = projectLifecycleContext({
			launchHash: DUMMY_HASH_1,
			policyHash: DUMMY_HASH_2,
			harnessHash: DUMMY_HASH_1,
			grantGeneration: 1,
			phase: "tool-result",
			fragments: [missing],
			tools: [],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("missing_required_input");
		expect(result.fragmentIds).toContain("req-input");
	});
});
