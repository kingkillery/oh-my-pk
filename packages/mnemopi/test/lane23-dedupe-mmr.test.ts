import { afterEach, describe, expect, it } from "bun:test";
import { dedupeBank } from "@pk-nerdsaver-ai/pi-mnemopi/core/beam/dedupe";
import { recall } from "@pk-nerdsaver-ai/pi-mnemopi/core/beam/recall";
import { initBeam } from "@pk-nerdsaver-ai/pi-mnemopi/core/beam/schema";
import { remember } from "@pk-nerdsaver-ai/pi-mnemopi/core/beam/store";
import type { BeamEvent, BeamMemoryState } from "@pk-nerdsaver-ai/pi-mnemopi/core/beam/types";
import { mmrDiversify } from "@pk-nerdsaver-ai/pi-mnemopi/core/mmr";
import { openDatabase } from "@pk-nerdsaver-ai/pi-mnemopi/db";

const states: BeamMemoryState[] = [];

function makeState(sessionId = "session-a", events: BeamEvent[] = []): BeamMemoryState {
	const db = openDatabase(":memory:");
	initBeam(db);
	const state: BeamMemoryState = {
		db,
		dbPath: ":memory:",
		sessionId,
		authorId: "author-a",
		authorType: "user",
		channelId: "channel-a",
		useCloud: false,
		eventEmitter: event => {
			events.push(event);
		},
		pluginManager: {
			emit: event => {
				events.push({ ...event, type: `plugin:${event.type}` });
			},
		},
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
	};
	states.push(state);
	return state;
}

afterEach(() => {
	while (states.length > 0) states.pop()?.db.close();
});

const TRANSCRIPT_PREFIX =
	"[role: user] please implement the resource lock module with named mutexes for serialized checks " +
	"[role: assistant] I will add scripts/lib/resource-lock.ts that acquires a named mutex before running tsgo";

function tombstoneOf(state: BeamMemoryState, id: string): string | null {
	const row = state.db.query("SELECT dup_superseded_by FROM working_memory WHERE id = ?").get(id) as {
		dup_superseded_by: string | null;
	} | null;
	return row?.dup_superseded_by ?? null;
}

describe("write-path prefix subsumption", () => {
	it("tombstones an older shorter snapshot when a longer rolling snapshot arrives", async () => {
		const state = makeState("session-1");
		const first = await remember(state, TRANSCRIPT_PREFIX, { source: "transcript" });
		const second = await remember(state, `${TRANSCRIPT_PREFIX} and then bounded every native check`, {
			source: "transcript",
		});
		expect(first).not.toBe(second);
		expect(tombstoneOf(state, first)).toBe(second);
		expect(tombstoneOf(state, second)).toBeNull();
	});

	it("self-tombstones a shorter snapshot that lands after the canonical one", async () => {
		const state = makeState("session-1");
		const canonical = await remember(state, `${TRANSCRIPT_PREFIX} plus the full tail of the exchange`, {
			source: "transcript",
		});
		const stale = await remember(state, TRANSCRIPT_PREFIX, { source: "transcript" });
		expect(tombstoneOf(state, stale)).toBe(canonical);
		expect(tombstoneOf(state, canonical)).toBeNull();
	});

	it("subsumes rolling snapshots across sessions, not just within one", async () => {
		const state = makeState("session-1");
		const first = await remember(state, TRANSCRIPT_PREFIX, { source: "transcript" });
		state.sessionId = "session-2";
		const second = await remember(state, `${TRANSCRIPT_PREFIX} continued further into the implementation`, {
			source: "transcript",
		});
		expect(tombstoneOf(state, first)).toBe(second);
	});

	it("excludes tombstoned rows from recall while keeping raw rows for history", async () => {
		const state = makeState("session-1");
		const first = await remember(state, TRANSCRIPT_PREFIX, { source: "transcript" });
		const second = await remember(state, `${TRANSCRIPT_PREFIX} and verified the mutex serializes checks`, {
			source: "transcript",
		});
		const results = await recall(state, "resource lock named mutex", 10, { ignoreSessionScope: true });
		const ids = results.map(r => r.id);
		expect(ids).toContain(second);
		expect(ids).not.toContain(first);
		const rawCount = state.db.query("SELECT COUNT(*) AS c FROM working_memory").get() as { c: number };
		expect(rawCount.c).toBe(2);
	});

	it("does not tombstone genuinely distinct content sharing no prefix", async () => {
		const state = makeState("session-1");
		const first = await remember(state, TRANSCRIPT_PREFIX, { source: "transcript" });
		const other = await remember(
			state,
			"[role: user] now explain reranker score normalization [role: assistant] min-max scales logits to zero one",
			{ source: "transcript" },
		);
		expect(tombstoneOf(state, first)).toBeNull();
		expect(tombstoneOf(state, other)).toBeNull();
	});
});

describe("dedupe sweep", () => {
	it("backfills prefix_hash and char_length on legacy rows", async () => {
		const state = makeState("session-1");
		state.db.run(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, ?, ?, ?)",
			["legacy-1", TRANSCRIPT_PREFIX, "transcript", new Date().toISOString(), "session-1"],
		);
		dedupeBank(state);
		const row = state.db
			.query("SELECT prefix_hash, char_length FROM working_memory WHERE id = 'legacy-1'")
			.get() as { prefix_hash: string | null; char_length: number | null };
		expect(row.prefix_hash).not.toBeNull();
		expect(row.char_length).toBe(TRANSCRIPT_PREFIX.length);
	});
});

describe("post-rerank MMR with interference decay", () => {
	function vec(overrides: Record<number, number>): Float32Array {
		const out = new Float32Array(4);
		for (const [idx, value] of Object.entries(overrides)) out[Number(idx)] = value;
		return out;
	}

	it("keeps distinct documents over near-duplicate high scorers", () => {
		const candidates = [
			{ id: "dup-a", content: "resource lock mutex alpha", score: 0.95, timestamp: "2026-01-01T00:00:00Z", embedding: vec({ 0: 1 }) },
			{ id: "dup-b", content: "resource lock mutex alpha beta", score: 0.94, timestamp: "2026-01-01T00:01:00Z", embedding: vec({ 0: 0.999, 1: 0.045 }) },
			{ id: "distinct", content: "embedding pipeline batch sizing", score: 0.80, timestamp: "2026-01-01T00:00:30Z", embedding: vec({ 2: 1 }) },
		];
		const out = mmrDiversify(candidates, 2, { lambda: 0.65 });
		const ids = out.map(c => c.id);
		expect(ids).toContain("distinct");
		expect(new Set(ids).size).toBe(2);
	});

	it("retroactive decay lets the newer rolling snapshot outrank the older one", () => {
		const candidates = [
			{ id: "old", content: "snapshot prefix", score: 0.90, timestamp: "2026-01-01T00:00:00Z", embedding: vec({ 0: 1 }) },
			{ id: "new", content: "snapshot prefix extended", score: 0.89, timestamp: "2026-01-01T00:05:00Z", embedding: vec({ 0: 0.999, 1: 0.045 }) },
		];
		const withDecay = mmrDiversify(candidates, 1, { lambda: 0.65, wRetro: 0.6, interferenceThreshold: 0.82 });
		expect(withDecay[0]?.id).toBe("new");
		const withoutDecay = mmrDiversify(candidates, 1, { lambda: 0.65, wRetro: 0 });
		expect(withoutDecay[0]?.id).toBe("old");
	});
});
