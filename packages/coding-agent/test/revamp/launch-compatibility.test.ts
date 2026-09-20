import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import { resolveTopologyKind } from "../../src/orchestration/topology-policy";

describe("Acceptance 1 — default selection", () => {
	it("keeps legacy for new delegated work until rollout; explicit values resolve", () => {
		const settings = Settings.isolated({});
		expect(settings.get("task.lifecycle.enabled")).toBe(false);
		expect(settings.get("task.topology")).toBe("legacy");

		const hierarchical = resolveTopologyKind({ requestedTopology: "hierarchical" });
		expect(hierarchical.ok).toBe(true);

		const direct = resolveTopologyKind({ isMultiAgent: false });
		expect(direct.ok).toBe(true);
		if (direct.ok) expect(direct.topology).toBe("direct");
	});
});

describe("Acceptance 2 — historical resume", () => {
	it("pins the recorded policy over changed defaults", () => {
		const resumed = resolveTopologyKind({
			historicalPolicy: "legacy",
			requestedTopology: "hierarchical",
			config: { defaultTopology: "hierarchical" },
		});
		expect(resumed.ok).toBe(true);
		if (resumed.ok) expect(resumed.topology).toBe("legacy");
	});

	it("rejects unknown requested topologies instead of defaulting", () => {
		const result = resolveTopologyKind({ requestedTopology: "mesh" });
		expect(result.ok).toBe(false);
	});
});
