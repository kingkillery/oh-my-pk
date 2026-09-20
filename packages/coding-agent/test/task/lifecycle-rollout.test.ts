import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";

describe("Lifecycle rollout flags (A18)", () => {
	it("keeps hierarchical lifecycle and new topology off by default", () => {
		const settings = Settings.isolated({});
		expect(settings.get("task.lifecycle.enabled")).toBe(false);
		expect(settings.get("task.topology")).toBe("legacy");
		expect(settings.get("task.lifecycle.observations.enabled")).toBe(false);
		expect(settings.get("task.lifecycle.reducer.enabled")).toBe(false);
		expect(settings.get("task.lifecycle.actionFusion.enabled")).toBe(false);
		expect(settings.get("task.lifecycle.semanticCompaction.enabled")).toBe(false);
	});

	it("allows explicit opt-in without changing defaults for others", () => {
		const settings = Settings.isolated({ "task.lifecycle.enabled": true, "task.topology": "hierarchical" });
		expect(settings.get("task.lifecycle.enabled")).toBe(true);
		expect(settings.get("task.topology")).toBe("hierarchical");
		expect(Settings.isolated({}).get("task.lifecycle.enabled")).toBe(false);
	});
});
