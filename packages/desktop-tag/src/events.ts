import { logger } from "@pk-nerdsaver-ai/pi-utils";

import type { AgentEvent } from "./types";

/** A typed channel that lets one or more consumers subscribe to {@link AgentEvent}s. */
export class AgentEventChannel {
	readonly #pending: AgentEvent[] = [];
	readonly #waiters: Array<(event: AgentEvent) => void> = [];
	#closed = false;

	push(event: AgentEvent): void {
		if (this.#closed) return;
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter(event);
		} else {
			this.#pending.push(event);
		}
	}

	close(): void {
		this.#closed = true;
		while (this.#waiters.length > 0) {
			const waiter = this.#waiters.shift();
			if (waiter) waiter({ type: "task.completed", taskId: "", summary: "" });
		}
	}

	subscribe(): AsyncIterable<AgentEvent> {
		const pending = this.#pending;
		const waiters = this.#waiters;
		const closed = () => this.#closed;
		return {
			async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
				while (true) {
					if (pending.length > 0) {
						yield pending.shift()!;
						continue;
					}
					if (closed()) return;
					const { promise, resolve } = Promise.withResolvers<AgentEvent>();
					waiters.push(resolve);
					try {
						yield await promise;
					} catch (error) {
						logger.error("Agent event channel iterator error", { error: String(error) });
						return;
					}
				}
			},
		};
	}
}

/** Serialize an event for wire transport. */
export function serializeAgentEvent(event: AgentEvent): string {
	return JSON.stringify(event);
}

/** Parse an event received over the wire. */
export function parseAgentEvent(text: string): AgentEvent | undefined {
	try {
		const parsed = JSON.parse(text) as AgentEvent;
		if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return undefined;
		return parsed;
	} catch (error) {
		logger.debug("Failed to parse agent event", { error: error instanceof Error ? error.message : String(error), text });
		return undefined;
	}
}
