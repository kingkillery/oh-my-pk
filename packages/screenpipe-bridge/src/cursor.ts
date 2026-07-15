import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface BridgeCursorStore {
	read(): Promise<number>;
	write(lastFrameId: number): Promise<void>;
}

/** Tracks the highest screenpipe frame id already handed to the gopk sink, so restarts don't re-import it. */
export function createFileCursorStore(captureRoot: string): BridgeCursorStore {
	const cursorPath = path.join(path.resolve(captureRoot), "cursor.json");
	return {
		async read(): Promise<number> {
			try {
				const raw = await fs.readFile(cursorPath, "utf8");
				const parsed: unknown = JSON.parse(raw);
				const lastFrameId =
					typeof parsed === "object" && parsed !== null
						? (parsed as Record<string, unknown>).lastFrameId
						: undefined;
				return typeof lastFrameId === "number" && Number.isSafeInteger(lastFrameId) ? lastFrameId : 0;
			} catch {
				return 0;
			}
		},
		async write(lastFrameId: number): Promise<void> {
			await fs.mkdir(path.dirname(cursorPath), { recursive: true });
			await fs.writeFile(cursorPath, JSON.stringify({ lastFrameId }));
		},
	};
}
