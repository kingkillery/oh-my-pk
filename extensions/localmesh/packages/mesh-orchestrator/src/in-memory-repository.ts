import type { MeshRuntimeRepository, MeshRuntimeSnapshot, MeshRuntimeTransaction } from "./types";
import { createEmptyRuntimeSnapshot } from "./types";

function cloneSnapshot(snapshot: MeshRuntimeSnapshot): MeshRuntimeSnapshot {
	return structuredClone(snapshot);
}

/**
 * A serialisable, transactionally-isolated reference repository. It gives tests
 * the same atomicity boundary required of the future SQLite/Postgres adapters.
 */
export class InMemoryMeshRuntimeRepository implements MeshRuntimeRepository {
	#snapshot: MeshRuntimeSnapshot;
	#tail: Promise<void> = Promise.resolve();

	constructor(initial?: MeshRuntimeSnapshot) {
		this.#snapshot = cloneSnapshot(initial ?? createEmptyRuntimeSnapshot());
	}

	async read<T>(select: (snapshot: MeshRuntimeSnapshot) => T | Promise<T>): Promise<T> {
		return this.#exclusive(async snapshot => select(snapshot), false);
	}

	async transaction<T>(operation: (transaction: MeshRuntimeTransaction) => T | Promise<T>): Promise<T> {
		return this.#exclusive(async snapshot => operation({ snapshot }), true);
	}

	async #exclusive<T>(operation: (snapshot: MeshRuntimeSnapshot) => T | Promise<T>, commit: boolean): Promise<T> {
		const preceding = this.#tail;
		const released = Promise.withResolvers<void>();
		this.#tail = preceding.then(
			() => released.promise,
			() => released.promise,
		);
		await preceding;
		const working = cloneSnapshot(this.#snapshot);
		try {
			const result = await operation(working);
			if (commit) {
				working.revision = this.#snapshot.revision + 1;
				this.#snapshot = working;
			}
			return result;
		} finally {
			released.resolve();
		}
	}
}
