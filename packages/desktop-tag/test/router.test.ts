import { describe, expect, it } from "bun:test";

import { CapabilityRegistry, createDefaultRegistry, routeContext } from "../src/router";
import type { ContextPacket } from "../src/types";

function makePacket(overrides: Partial<ContextPacket> = {}): ContextPacket {
	return {
		timestamp: Date.now(),
		captureMode: "screen",
		userRequest: "explain this",
		visual: { screenshotPath: undefined },
		foregroundApp: { processName: undefined, windowTitle: undefined, bounds: undefined },
		browser: { url: undefined, title: undefined, domSnapshot: undefined, activeElement: undefined },
		selection: { clipboardText: undefined, selectedText: undefined, region: undefined },
		availableCapabilities: [],
		...overrides,
	};
}

describe("CapabilityRegistry", () => {
	it("registers and queries executors", () => {
		const registry = new CapabilityRegistry();
		registry.register({
			id: "test",
			name: "Test executor",
			location: "local",
			riskLevel: "low",
			available: true,
			capabilities: [{ name: "greet", approval: "none" }],
		});

		expect(registry.getExecutor("test")?.name).toBe("Test executor");
		expect(registry.listExecutors()).toHaveLength(1);
		expect(registry.findMatching("greet")?.id).toBe("test");
	});

	it("respects application filters", () => {
		const registry = new CapabilityRegistry();
		registry.register({
			id: "app-a",
			name: "App A executor",
			location: "local",
			riskLevel: "low",
			available: true,
			applications: ["a"],
			capabilities: [{ name: "save" }],
		});
		registry.register({
			id: "app-b",
			name: "App B executor",
			location: "local",
			riskLevel: "low",
			available: true,
			applications: ["b"],
			capabilities: [{ name: "save" }],
		});

		expect(registry.findMatching("save", "a")?.id).toBe("app-a");
		expect(registry.findMatching("save", "b")?.id).toBe("app-b");
	});
});

describe("routeContext", () => {
	it("routes general questions to answer-only", () => {
		const registry = createDefaultRegistry();
		const decision = routeContext(registry, makePacket({ userRequest: "what does this error mean?" }));

		expect(decision.executorId).toBe("answer-only");
		expect(decision.tools).toContain("inspect_image");
		expect(decision.level).toBe(0);
	});

	it("routes code tasks to local-pi", () => {
		const registry = createDefaultRegistry();
		const decision = routeContext(registry, makePacket({ userRequest: "fix this test" }));

		expect(decision.executorId).toBe("local-pi");
		expect(decision.tools).toContain("bash");
		expect(decision.tools).toContain("edit");
	});

	it("routes email requests to gmail-mcp", () => {
		const registry = createDefaultRegistry();
		const decision = routeContext(registry, makePacket({ userRequest: "email this to the team" }));

		expect(decision.executorId).toBe("gmail-mcp");
		expect(decision.tools).toContain("email.draft");
	});

	it("routes screen control to computer-use", () => {
		const registry = createDefaultRegistry();
		const decision = routeContext(registry, makePacket({ userRequest: "click the submit button" }));

		expect(decision.executorId).toBe("computer-use");
		expect(decision.tools).toContain("screen.click");
	});

	it("uses browser URL/title to detect Salesforce", () => {
		const registry = createDefaultRegistry();
		const decision = routeContext(registry, makePacket({ userRequest: "look at this", browser: { url: "https://myorg.lightning.force.com/", title: "Salesforce" } }));

		expect(decision.executorId).toBe("ix-bridge");
		expect(decision.tools).toContain("ix_bridge");
	});
});
