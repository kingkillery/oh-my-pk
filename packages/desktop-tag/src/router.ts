import { logger } from "@pk-nerdsaver-ai/pi-utils";

import type { ActionLevel, Capability, ContextPacket, Executor, RoutingDecision } from "./types";

/** Registry of available executors and their declared capabilities. */
export class CapabilityRegistry {
	readonly #executors = new Map<string, Executor>();

	register(executor: Executor): void {
		this.#executors.set(executor.id, executor);
	}

	getExecutor(id: string): Executor | undefined {
		return this.#executors.get(id);
	}

	listExecutors(): Executor[] {
		return [...this.#executors.values()];
	}

	findMatching(capabilityName: string, application?: string): Executor | undefined {
		for (const executor of this.#executors.values()) {
			if (!executor.available) continue;
			if (executor.capabilities.some(c => c.name === capabilityName)) {
				if (application && executor.applications && !executor.applications.includes(application)) continue;
				return executor;
			}
		}
		return undefined;
	}
}

/** Default executor definitions shipped with the desktop-tag extension. */
export function createDefaultRegistry(): CapabilityRegistry {
	const registry = new CapabilityRegistry();

	registry.register({
		id: "answer-only",
		name: "Vision answer",
		location: "local",
		riskLevel: "low",
		available: true,
		capabilities: [
			{ name: "answer", description: "Answer from a screenshot or selected context", sideEffect: false, reversible: true, approval: "none" },
		],
	});

	registry.register({
		id: "local-pi",
		name: "Local pi session",
		location: "local",
		riskLevel: "medium",
		available: true,
		capabilities: [
			{ name: "filesystem.read", sideEffect: false, reversible: true, approval: "none" },
			{ name: "filesystem.write", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "terminal.execute", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "codebase.edit", sideEffect: true, reversible: true, approval: "per-action" },
		],
	});

	registry.register({
		id: "ix-bridge",
		name: "IX Bridge browser executor",
		location: "local",
		riskLevel: "medium",
		available: true,
		applications: ["salesforce", "powerclerk", "xcel-portal"],
		capabilities: [
			{ name: "browser.navigate", sideEffect: false, reversible: true, approval: "none" },
			{ name: "browser.inspect_dom", sideEffect: false, reversible: true, approval: "none" },
			{ name: "browser.click", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "browser.type", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "browser.capture_trace", sideEffect: false, reversible: true, approval: "none" },
		],
	});

	registry.register({
		id: "gmail-mcp",
		name: "Gmail connector",
		location: "remote",
		riskLevel: "high",
		available: false,
		applications: ["gmail"],
		capabilities: [
			{ name: "email.search", sideEffect: false, reversible: true, approval: "none" },
			{ name: "email.read", sideEffect: false, reversible: true, approval: "none" },
			{ name: "email.draft", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "email.send", sideEffect: true, reversible: false, approval: "per-action" },
		],
	});

	registry.register({
		id: "remote-hub",
		name: "Remote hub worker",
		location: "remote",
		riskLevel: "high",
		available: false,
		capabilities: [
			{ name: "remote.execute", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "server.run", sideEffect: true, reversible: true, approval: "per-action" },
		],
	});

	registry.register({
		id: "computer-use",
		name: "Computer-use vision executor",
		location: "local",
		riskLevel: "high",
		available: false,
		capabilities: [
			{ name: "screen.click", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "screen.type", sideEffect: true, reversible: true, approval: "per-action" },
			{ name: "screen.keypress", sideEffect: true, reversible: true, approval: "per-action" },
		],
	});

	return registry;
}

/** Route a captured context packet to an executor and a constrained tool set. */
export function routeContext(registry: CapabilityRegistry, packet: ContextPacket): RoutingDecision {
	const request = packet.userRequest.toLowerCase();
	const url = packet.browser.url?.toLowerCase() ?? "";
	const title = packet.browser.title?.toLowerCase() ?? "";
	const app = packet.foregroundApp.processName?.toLowerCase() ?? "";

	if (request.match(/\bemail\b|\bmail\b|\bgmail\b/)) {
		return decision("gmail-mcp", ["email.search", "email.read", "email.draft"], 2);
	}

	if (request.match(/\bserver\b|\bremote\b|\bssh\b|\brun on the server\b/)) {
		return decision("remote-hub", ["remote.execute", "ssh"], 2);
	}

	if (request.match(/\bclick\b|\bpress\b|\btype in\b|\bscreen\b/)) {
		return decision("computer-use", ["screen.click", "screen.type", "screen.keypress"], 3);
	}

	if (request.match(/\bsalesforce\b/) || url.includes("salesforce.com") || title.includes("salesforce")) {
		return decision("ix-bridge", ["ix_bridge", "browser", "web_search"], 2);
	}

	if (request.match(/\bportal\b|\bpowerclerk\b|\bxcel\b/)) {
		return decision("ix-bridge", ["ix_bridge", "browser"], 2);
	}

	if (request.match(/\bfix\b|\bcode\b|\bedit\b|\brefactor\b|\btest\b|\bbuild\b/)) {
		return decision("local-pi", ["bash", "read", "edit", "write", "search", "find", "lsp"], 2);
	}

	if (request.match(/\bupdate\b|\bchange\b|\bsave\b|\bcreate\b|\bdelete\b/)) {
		return decision("local-pi", ["bash", "read", "write", "edit"], 2);
	}

	if (request.match(/\bwhat\b|\bwhy\b|\bhow\b|\bexplain\b|\berror\b|\bmean\b/) || !packet.visual.screenshotPath) {
		return decision("answer-only", ["inspect_image", "web_search", "ask"], 0);
	}

	return decision("answer-only", ["inspect_image", "web_search", "ask"], 0);
}

function decision(executorId: string, tools: string[], level: ActionLevel): RoutingDecision {
	return {
		executorId,
		tools,
		message: `Routing to ${executorId} with tools [${tools.join(", ")}]`,
		level,
	};
}

/** Set executor availability based on runtime probes (e.g. IX Bridge reachable). */
export async function updateAvailability(registry: CapabilityRegistry): Promise<void> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1_500);
		const response = await fetch("http://127.0.0.1:18086/ix-bridge/status", { signal: controller.signal });
		clearTimeout(timer);
		const ix = registry.getExecutor("ix-bridge");
		if (ix) {
			ix.available = response.ok;
		}
	} catch (error) {
		logger.debug("IX Bridge availability probe failed", { error: error instanceof Error ? error.message : String(error) });
		const ix = registry.getExecutor("ix-bridge");
		if (ix) ix.available = false;
	}
}
