import type { Settings } from "../config/settings";

interface SpawnWaiter {
	readonly promise: Promise<void>;
	readonly resolve: (value: void | PromiseLike<void>) => void;
	readonly reject: (reason?: unknown) => void;
}

interface SpawnState {
	active: number;
	waiters: SpawnWaiter[];
}

const spawnStates = new WeakMap<Settings, SpawnState>();

export function simpleAgentLimit(settings: Settings): number {
	const configured = settings.get("task.simpleMaxAgents");
	return Number.isFinite(configured) ? Math.min(32, Math.max(0, Math.floor(configured))) : 0;
}

export function simpleSpawnError(settings: Settings, depth: number): string | undefined {
	if (!settings.get("task.simpleMode")) return undefined;
	if (depth > 0) return "Simple mode does not allow nested subagents.";
	if (simpleAgentLimit(settings) === 0) return "Simple mode has subagents turned off. Use /simple 1 to enable one.";
	return undefined;
}

/** Share a live concurrency ceiling across parallel task calls in a parent session. */
export async function withSimpleSpawnPermit<T>(settings: Settings, run: () => Promise<T>): Promise<T> {
	if (!settings.get("task.simpleMode")) return run();
	const state = spawnStates.get(settings) ?? { active: 0, waiters: [] };
	spawnStates.set(settings, state);
	if (simpleAgentLimit(settings) === 0) throw new Error("Simple mode has subagents turned off.");
	if (state.active >= simpleAgentLimit(settings)) {
		const waiter = Promise.withResolvers<void>();
		state.waiters.push(waiter);
		await waiter.promise;
	} else {
		state.active++;
	}
	try {
		return await run();
	} finally {
		state.active--;
		while (state.waiters.length > 0) {
			const waiter = state.waiters.shift()!;
			if (settings.get("task.simpleMode") && simpleAgentLimit(settings) === 0) {
				waiter.reject(new Error("Simple mode has subagents turned off."));
				continue;
			}
			if (settings.get("task.simpleMode") && state.active >= simpleAgentLimit(settings)) {
				state.waiters.unshift(waiter);
				break;
			}
			state.active++;
			waiter.resolve();
		}
	}
}
