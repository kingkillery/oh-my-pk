import { afterEach, describe, expect, it } from "bun:test";
import type { MnemopiBackendConfig } from "@pk-nerdsaver-ai/pi-coding-agent/mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState } from "@pk-nerdsaver-ai/pi-coding-agent/mnemopi/state";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const twoDaysAgo = () => new Date(Date.now() - 48 * 3_600_000).toISOString();

let tempDir: TempDir | undefined;
afterEach(async () => {
	await tempDir?.remove();
	tempDir = undefined;
});

function openState(dbPath: string): MnemopiSessionState {
	const sessionId = "stale-consolidation-session";
	const config: MnemopiBackendConfig = {
		dbPath,
		bank: "test-bank",
		autoRecall: false,
		autoRetain: false,
		polyphonicRecall: false,
		enhancedRecall: false,
		proactiveLinking: false,
		retainEveryNTurns: 3,
		recallLimit: 10,
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		injectionTokenLimit: 1024,
		debug: false,
		providerOptions: { noEmbeddings: true, llm: false },
		llmMode: "none",
	};
	return new MnemopiSessionState({
		sessionId,
		config,
		session: {
			sessionId,
			sessionManager: { getEntries: () => [], getCwd: () => "/tmp" },
			emitNotice: () => {},
			getHindsightSessionState: () => undefined,
		} as never,
	});
}

function seedStaleMemory(state: MnemopiSessionState, content: string): string {
	const id = state.rememberScoped(content);
	if (!id) throw new Error("seed retain failed");
	state.memory.beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id = ?", [twoDaysAgo(), id]);
	return id;
}

function consolidatedAt(state: MnemopiSessionState, id: string): string | null | undefined {
	const row = state.memory.beam.db.query("SELECT consolidated_at FROM working_memory WHERE id = ?").get(id) as {
		consolidated_at: string | null;
	} | null;
	return row === null ? undefined : row.consolidated_at;
}

describe("Mnemopi stale working memory", () => {
	it("consolidates a killed session's memories when the bank is next opened", async () => {
		tempDir = TempDir.createSync(`@mnemopi-stale-open-${Date.now()}-`);
		const killed = openState(tempDir.join("mnemopi.db"));
		const id = seedStaleMemory(killed, "the deploy script needs the staging token");
		await killed.dispose({ consolidate: false });

		const next = openState(tempDir.join("mnemopi.db"));
		try {
			expect(consolidatedAt(next, id)).toBeString();
		} finally {
			await next.dispose({ consolidate: false });
		}
	});

	it("consolidates stale memories before a write would trim them", async () => {
		tempDir = TempDir.createSync(`@mnemopi-stale-write-${Date.now()}-`);
		const state = openState(tempDir.join("mnemopi.db"));
		try {
			const id = seedStaleMemory(state, "the deploy script needs the staging token");
			state.rememberScoped("a fresh turn");
			expect(consolidatedAt(state, id)).toBeString();
		} finally {
			await state.dispose({ consolidate: false });
		}
	});
});
