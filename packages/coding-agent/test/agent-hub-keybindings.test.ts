import { describe, expect, it } from "bun:test";
import type { AgentRef, AgentRegistry } from "../src/registry/agent-registry";

function createMockRegistry(agents: AgentRef[] = []): AgentRegistry {
	const refs = new Map(agents.map(a => [a.id, { ...a }]));
	const observers: Array<() => void> = [];

	return {
		get: (id: string) => refs.get(id),
		list: () => Array.from(refs.values()),
		setDisplayName: (id: string, name: string) => {
			const ref = refs.get(id);
			if (ref) ref.displayName = name;
		},
		subscribe: (fn: () => void) => {
			observers.push(fn);
			return () => {
				const idx = observers.indexOf(fn);
				if (idx >= 0) observers.splice(idx, 1);
			};
		},
	} as unknown as AgentRegistry;
}

function createTestAgent(overrides: Partial<AgentRef> = {}): AgentRef {
	return {
		id: "test-agent",
		displayName: "Test Agent",
		kind: "sub",
		status: "running",
		session: null,
		sessionFile: null,
		createdAt: Date.now(),
		collaborationScopeId: "test-scope",
		lastActivity: Date.now(),
		...overrides,
	};
}

function createHub(options: { registry?: AgentRegistry } = {}) {
	const registry = options.registry || createMockRegistry([]);
	let isOpen = true;
	let selectedAgentId: string | null = null;
	let renameMode = false;
	let renameBuffer = "";
	let filterMode = false;
	let filterQuery = "";
	let filteredIds: string[] | null = null;

	return {
		isOpen: () => isOpen,
		isRenameMode: () => renameMode,
		isFilterMode: () => filterMode,
		getRenameBuffer: () => renameBuffer,
		getFilterQuery: () => filterQuery,

		handleKey: (key: string) => {
			if (renameMode) {
				if (key === "escape") {
					renameMode = false;
					return;
				}
				if (key === "enter") {
					if (renameBuffer.trim()) {
						if (selectedAgentId) {
							registry.setDisplayName(selectedAgentId, renameBuffer);
						}
						renameMode = false;
						return;
					}
					return;
				}
				if (key === "backspace") {
					renameBuffer = renameBuffer.slice(0, -1);
					return;
				}
				if (key.length === 1) {
					renameBuffer += key;
				}
				return;
			}

			if (filterMode) {
				if (key === "escape") {
					filterMode = false;
					filterQuery = "";
					filteredIds = null;
					return;
				}
				if (key === "enter") {
					const q = filterQuery.toLowerCase();
					filteredIds = registry
						.list()
						.filter(
							a =>
								a.id.toLowerCase().includes(q) ||
								a.displayName.toLowerCase().includes(q) ||
								a.activity?.toLowerCase().includes(q),
						)
						.map(a => a.id);
					filterMode = false;
					return;
				}
				if (key === "backspace") {
					filterQuery = filterQuery.slice(0, -1);
					return;
				}
				if (key.length === 1) {
					filterQuery += key;
				}
				return;
			}

			switch (key) {
				case "q":
					isOpen = false;
					return;
				case "j": {
					const agents = filteredIds ? registry.list().filter(a => filteredIds?.includes(a.id)) : registry.list();
					if (agents.length > 0) {
						const idx = selectedAgentId ? agents.findIndex(a => a.id === selectedAgentId) : -1;
						const next = (idx + 1) % agents.length;
						selectedAgentId = agents[next].id;
					}
					return;
				}
				case "x":
				case "ctrl+x":
					return selectedAgentId;
				case "R":
					return selectedAgentId;
				case "r":
					if (selectedAgentId) {
						renameMode = true;
						const agent = registry.get(selectedAgentId);
						renameBuffer = agent?.displayName ?? "";
					}
					return;
				case "/":
					filterMode = true;
					filterQuery = "";
					return;
				case "c":
					return selectedAgentId;
				case "enter":
					if (selectedAgentId) {
						const agent = registry.get(selectedAgentId);
						if (!agent) return;

						if (agent.kind === "advisor") {
							return { chat: selectedAgentId };
						}
						if (agent.status === "parked") {
							return { revived: selectedAgentId, focused: selectedAgentId };
						}
						return { focused: selectedAgentId };
					}
					return;
			}
		},

		selectAgent: (id: string) => {
			selectedAgentId = id;
		},

		getHints: () => {
			if (!selectedAgentId) return "";
			const agent = registry.get(selectedAgentId);
			if (!agent) return "";

			const hints: string[] = [];
			if (agent.status === "parked") hints.push("R:revive");
			if (agent.status === "running") hints.push("x:kill");
			if (agent.kind === "advisor") hints.push("Enter:view");
			return hints.join(" ");
		},

		getFilteredAgents: () => {
			if (!filterMode || !filterQuery) return registry.list();
			const q = filterQuery.toLowerCase();
			return registry
				.list()
				.filter(
					a =>
						a.id.toLowerCase().includes(q) ||
						a.displayName.toLowerCase().includes(q) ||
						a.activity?.toLowerCase().includes(q),
				);
		},

		getVisibleAgents: () => {
			if (filteredIds) {
				return registry.list().filter(a => filteredIds?.includes(a.id));
			}
			return registry.list();
		},
	};
}

describe("Agent Hub Keybindings", () => {
	describe("Phase 1: Keybinding Overhaul", () => {
		it("q key closes the hub", () => {
			const hub = createHub();
			expect(hub.isOpen()).toBe(true);
			hub.handleKey("q");
			expect(hub.isOpen()).toBe(false);
		});

		it("x key removes the selected agent", () => {
			const agent = createTestAgent({ id: "agent1" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			const removed = hub.handleKey("x");
			expect(removed).toBe("agent1");
		});

		it("ctrl+x still works for backward compatibility", () => {
			const agent = createTestAgent({ id: "agent1" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			const removed = hub.handleKey("ctrl+x");
			expect(removed).toBe("agent1");
		});

		it("R (shift-r) revives parked agent", () => {
			const agent = createTestAgent({ id: "agent1", status: "parked" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			const revived = hub.handleKey("R");
			expect(revived).toBe("agent1");
		});

		it("lowercase r does not revive", () => {
			const agent = createTestAgent({ id: "agent1", status: "parked" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			hub.handleKey("r");
			expect(hub.isRenameMode()).toBe(true);
		});
	});

	describe("Phase 2: Rename Flow", () => {
		it("r key enters rename mode", () => {
			const agent = createTestAgent({ id: "agent1", displayName: "Agent 1" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			hub.handleKey("r");
			expect(hub.isRenameMode()).toBe(true);
			expect(hub.getRenameBuffer()).toBe("Agent 1");
		});

		it("typing appends to the rename buffer", () => {
			const agent = createTestAgent({ id: "agent1", displayName: "" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			hub.handleKey("r");
			hub.handleKey("N");
			hub.handleKey("e");
			hub.handleKey("w");
			expect(hub.getRenameBuffer()).toBe("New");
		});

		it("backspace deletes from rename buffer", () => {
			const agent = createTestAgent({ id: "agent1", displayName: "Agent 1" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			hub.handleKey("r");
			hub.handleKey("backspace");
			expect(hub.getRenameBuffer()).toBe("Agent ");
		});

		it("Enter saves the rename", () => {
			const agent = createTestAgent({ id: "agent1", displayName: "" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			hub.handleKey("r");
			for (const char of "NewName") {
				hub.handleKey(char);
			}
			hub.handleKey("enter");

			expect(hub.isRenameMode()).toBe(false);
			expect(registry.get("agent1")?.displayName).toBe("NewName");
		});

		it("Esc cancels rename without saving", () => {
			const agent = createTestAgent({ id: "agent1", displayName: "Agent 1" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			hub.handleKey("r");
			hub.handleKey("N");
			hub.handleKey("e");
			hub.handleKey("w");
			hub.handleKey("escape");

			expect(hub.isRenameMode()).toBe(false);
			expect(registry.get("agent1")?.displayName).toBe("Agent 1");
		});

		it("empty rename is rejected", () => {
			const agent = createTestAgent({ id: "agent1", displayName: "Agent 1" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			hub.handleKey("r");
			for (let i = 0; i < 20; i++) {
				hub.handleKey("backspace");
			}
			hub.handleKey("enter");

			expect(hub.isRenameMode()).toBe(true);
		});
	});

	describe("Phase 3: Adaptive Hints", () => {
		it("shows revive hint for parked agents", () => {
			const agent = createTestAgent({ id: "agent1", status: "parked" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });
			hub.selectAgent(agent.id);

			expect(hub.getHints()).toContain("R:revive");
		});

		it("shows kill hint for running agents", () => {
			const agent = createTestAgent({ id: "agent1", status: "running" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });
			hub.selectAgent(agent.id);

			expect(hub.getHints()).toContain("x:kill");
		});

		it("shows view hint for advisor agents", () => {
			const agent = createTestAgent({ id: "agent1", kind: "advisor" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });
			hub.selectAgent(agent.id);

			expect(hub.getHints()).toContain("Enter:view");
		});

		it("hides revive for running agents", () => {
			const agent = createTestAgent({ id: "agent1", status: "running" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });
			hub.selectAgent(agent.id);

			expect(hub.getHints()).not.toContain("R:revive");
		});
	});

	describe("Phase 4: Filter Mode", () => {
		it("/ key enters filter mode", () => {
			const hub = createHub();
			hub.handleKey("/");
			expect(hub.isFilterMode()).toBe(true);
		});

		it("typing filters the agent list", () => {
			const agents = [
				createTestAgent({ id: "agent1", displayName: "Alpha" }),
				createTestAgent({ id: "agent2", displayName: "Beta" }),
				createTestAgent({ id: "agent3", displayName: "Gamma" }),
			];
			const registry = createMockRegistry(agents);
			const hub = createHub({ registry });

			hub.handleKey("/");
			hub.handleKey("B");
			hub.handleKey("e");
			hub.handleKey("t");
			hub.handleKey("a");

			expect(hub.getFilteredAgents()).toHaveLength(1);
			expect(hub.getFilteredAgents()[0].displayName).toBe("Beta");
		});

		it("filter matches on id", () => {
			const agents = [
				createTestAgent({ id: "frontend-dev", displayName: "Developer" }),
				createTestAgent({ id: "backend-api", displayName: "API" }),
			];
			const registry = createMockRegistry(agents);
			const hub = createHub({ registry });

			hub.handleKey("/");
			for (const char of "frontend") {
				hub.handleKey(char);
			}

			expect(hub.getFilteredAgents()).toHaveLength(1);
			expect(hub.getFilteredAgents()[0].id).toBe("frontend-dev");
		});

		it("filter matches on activity", () => {
			const agents = [
				createTestAgent({ id: "agent1", activity: "Running tests" }),
				createTestAgent({ id: "agent2", activity: "Writing code" }),
			];
			const registry = createMockRegistry(agents);
			const hub = createHub({ registry });

			hub.handleKey("/");
			for (const char of "tests") {
				hub.handleKey(char);
			}

			expect(hub.getFilteredAgents()).toHaveLength(1);
			expect(hub.getFilteredAgents()[0].id).toBe("agent1");
		});

		it("filter is case-insensitive", () => {
			const agents = [
				createTestAgent({ id: "Agent1", displayName: "Alpha" }),
				createTestAgent({ id: "agent2", displayName: "Beta" }),
			];
			const registry = createMockRegistry(agents);
			const hub = createHub({ registry });

			hub.handleKey("/");
			for (const char of "ALPHA") {
				hub.handleKey(char);
			}

			expect(hub.getFilteredAgents()).toHaveLength(1);
		});

		it("Enter in filter mode applies filter and exits", () => {
			const agents = [
				createTestAgent({ id: "agent1", displayName: "Alpha" }),
				createTestAgent({ id: "agent2", displayName: "Beta" }),
			];
			const registry = createMockRegistry(agents);
			const hub = createHub({ registry });

			hub.handleKey("/");
			for (const char of "Alpha") {
				hub.handleKey(char);
			}
			hub.handleKey("enter");

			expect(hub.isFilterMode()).toBe(false);
			expect(hub.getVisibleAgents()).toHaveLength(1);
		});

		it("Esc clears filter and shows all agents", () => {
			const agents = [
				createTestAgent({ id: "agent1", displayName: "Alpha" }),
				createTestAgent({ id: "agent2", displayName: "Beta" }),
			];
			const registry = createMockRegistry(agents);
			const hub = createHub({ registry });

			hub.handleKey("/");
			for (const char of "Alpha") {
				hub.handleKey(char);
			}
			hub.handleKey("escape");

			expect(hub.isFilterMode()).toBe(false);
			expect(hub.getVisibleAgents()).toHaveLength(2);
		});

		it("backspace removes last character from filter", () => {
			const hub = createHub();
			hub.handleKey("/");
			hub.handleKey("t");
			hub.handleKey("e");
			hub.handleKey("s");
			hub.handleKey("t");
			hub.handleKey("backspace");
			expect(hub.getFilterQuery()).toBe("tes");
		});
	});

	describe("Phase 5: Chat Decouple", () => {
		it("c key opens chat for selected agent", () => {
			const agent = createTestAgent({ id: "agent1" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			const chatAgent = hub.handleKey("c");
			expect(chatAgent).toBe("agent1");
		});

		it("c key works for parked agents", () => {
			const agent = createTestAgent({ id: "agent1", status: "parked" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			const chatAgent = hub.handleKey("c");
			expect(chatAgent).toBe("agent1");
		});

		it("c key works for advisor agents", () => {
			const agent = createTestAgent({ id: "agent1", kind: "advisor" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			const chatAgent = hub.handleKey("c");
			expect(chatAgent).toBe("agent1");
		});

		it("Enter on parked agent revives it first", () => {
			const agent = createTestAgent({ id: "agent1", status: "parked" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			const result = hub.handleKey("enter");

			expect(result).toEqual({ revived: "agent1", focused: "agent1" });
		});

		it("Enter on running agent just focuses", () => {
			const agent = createTestAgent({ id: "agent1", status: "running" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			const result = hub.handleKey("enter");

			expect(result).toEqual({ focused: "agent1" });
		});

		it("Enter on advisor agent opens chat", () => {
			const agent = createTestAgent({ id: "agent1", kind: "advisor" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			const result = hub.handleKey("enter");

			expect(result).toEqual({ chat: "agent1" });
		});
	});

	describe("Mode Interactions", () => {
		it("filter mode takes precedence over normal keys", () => {
			const hub = createHub();
			hub.handleKey("/");
			hub.handleKey("j");
			expect(hub.getFilterQuery()).toBe("j");
		});

		it("rename mode takes precedence over filter mode", () => {
			const agent = createTestAgent({ id: "agent1" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("/");
			hub.handleKey("j");
			hub.handleKey("escape");
			hub.handleKey("j");
			hub.handleKey("r");

			expect(hub.isRenameMode()).toBe(true);
			expect(hub.isFilterMode()).toBe(false);
		});

		it("Esc exits filter mode before closing hub", () => {
			const hub = createHub();
			hub.handleKey("/");
			hub.handleKey("t");
			hub.handleKey("e");
			hub.handleKey("s");
			hub.handleKey("t");
			hub.handleKey("escape");

			expect(hub.isFilterMode()).toBe(false);
			expect(hub.isOpen()).toBe(true);
		});

		it("Esc in rename mode exits to normal mode", () => {
			const agent = createTestAgent({ id: "agent1" });
			const registry = createMockRegistry([agent]);
			const hub = createHub({ registry });

			hub.handleKey("j");
			hub.handleKey("r");
			hub.handleKey("escape");

			expect(hub.isRenameMode()).toBe(false);
			expect(hub.isOpen()).toBe(true);
		});

		it("q closes hub from normal mode", () => {
			const hub = createHub();
			hub.handleKey("q");
			expect(hub.isOpen()).toBe(false);
		});

		it("q in filter mode adds to filter, not close", () => {
			const hub = createHub();
			hub.handleKey("/");
			hub.handleKey("q");
			expect(hub.isOpen()).toBe(true);
			expect(hub.getFilterQuery()).toBe("q");
		});
	});
});
