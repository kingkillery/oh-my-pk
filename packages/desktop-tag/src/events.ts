import { logger } from "@pk-nerdsaver-ai/pi-utils";

import type { AgentEvent } from "./types";

/** A replaying typed channel that lets consumers independently subscribe to {@link AgentEvent}s. */
export class TaskEventChannel {
	readonly #events: AgentEvent[] = [];
	readonly #waiters = new Set<() => void>();
	#closed = false;

	push(event: AgentEvent): void {
		if (this.#closed) return;
		this.#events.push(event);
		this.#wakeWaiters();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#wakeWaiters();
	}

	subscribe(signal?: AbortSignal): AsyncIterable<AgentEvent> {
		const channel = this;
		return {
			async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
				let cursor = 0;
				while (!signal?.aborted) {
					if (cursor < channel.#events.length) {
						yield channel.#events[cursor++];
						continue;
					}
					if (channel.#closed) return;
					await channel.#waitForEvent(signal);
				}
			},
		};
	}

	#waitForEvent(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.resolve();

		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = (): void => {
			this.#waiters.delete(wake);
			signal?.removeEventListener("abort", wake);
			resolve();
		};

		this.#waiters.add(wake);
		signal?.addEventListener("abort", wake, { once: true });
		if (signal?.aborted) wake();
		return promise;
	}

	#wakeWaiters(): void {
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		for (const wake of waiters) wake();
	}
}

/** Backward-compatible name for the task event channel. */
export { TaskEventChannel as AgentEventChannel };

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
		logger.debug("Failed to parse agent event", {
			error: error instanceof Error ? error.message : String(error),
			text,
		});
		return undefined;
	}
}
