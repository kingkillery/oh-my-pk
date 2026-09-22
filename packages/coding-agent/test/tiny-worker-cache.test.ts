import { describe, expect, it } from "bun:test";
import { SinglePipelineCache } from "@pk-nerdsaver-ai/pi-coding-agent/tiny/worker";

type FakePipeline = { name: string; disposed: boolean; dispose(): Promise<void> };

function fakePipeline(name: string, events?: string[]): FakePipeline {
	const pipeline: FakePipeline = {
		name,
		disposed: false,
		dispose: async () => {
			pipeline.disposed = true;
			events?.push(`dispose:${name}`);
		},
	};
	return pipeline;
}

function collectingDisposer(sink: [string, unknown][]): (key: string, error: unknown) => void {
	return (key, error) => {
		sink.push([key, error]);
	};
}

describe("SinglePipelineCache", () => {
	it("returns the resident pipeline for the same key without disposing or reloading", async () => {
		const cache = new SinglePipelineCache<string, FakePipeline>();
		const disposeErrors: [string, unknown][] = [];
		let factoryCalls = 0;
		const a = fakePipeline("a");

		const first = await cache.load(
			"a",
			async () => {
				factoryCalls += 1;
				return a;
			},
			collectingDisposer(disposeErrors),
		);
		const second = await cache.load(
			"a",
			async () => {
				factoryCalls += 1;
				return fakePipeline("a-again");
			},
			collectingDisposer(disposeErrors),
		);

		expect(first).toBe(a);
		expect(second).toBe(a);
		expect(factoryCalls).toBe(1);
		expect(a.disposed).toBe(false);
		expect(disposeErrors).toEqual([]);
	});

	it("disposes the resident pipeline before loading a different key, then reloads the evicted key", async () => {
		const cache = new SinglePipelineCache<string, FakePipeline>();
		const events: string[] = [];
		const disposeErrors: [string, unknown][] = [];
		const factory = (key: string) => async (): Promise<FakePipeline> => {
			events.push(`factory:${key}`);
			return fakePipeline(key, events);
		};

		const a = await cache.load("a", factory("a"), collectingDisposer(disposeErrors));
		const b = await cache.load("b", factory("b"), collectingDisposer(disposeErrors));
		expect(events).toEqual(["factory:a", "dispose:a", "factory:b"]);
		expect(a.disposed).toBe(true);

		const aAgain = await cache.load("a", factory("a"), collectingDisposer(disposeErrors));
		expect(events).toEqual(["factory:a", "dispose:a", "factory:b", "dispose:b", "factory:a"]);
		expect(b.disposed).toBe(true);
		expect(aAgain).not.toBe(a);
		expect(aAgain.name).toBe("a");
		expect(disposeErrors).toEqual([]);
	});

	it("reports a dispose rejection through onDisposeError and still loads the replacement", async () => {
		const cache = new SinglePipelineCache<string, FakePipeline>();
		const disposeErrors: [string, unknown][] = [];
		const broken: FakePipeline = {
			name: "a",
			disposed: false,
			dispose: async () => {
				throw new Error("dispose blew up");
			},
		};
		await cache.load("a", async () => broken, collectingDisposer(disposeErrors));

		const b = fakePipeline("b");
		const loaded = await cache.load("b", async () => b, collectingDisposer(disposeErrors));

		expect(loaded).toBe(b);
		expect(b.disposed).toBe(false);
		expect(disposeErrors).toHaveLength(1);
		const [evictedKey, disposeError] = disposeErrors[0]!;
		expect(evictedKey).toBe("a");
		expect((disposeError as Error).message).toBe("dispose blew up");
	});

	it("does not cache a rejected load and lets the same key retry", async () => {
		const cache = new SinglePipelineCache<string, FakePipeline>();
		const disposeErrors: [string, unknown][] = [];
		let attempts = 0;
		const failing = async (): Promise<FakePipeline> => {
			attempts += 1;
			throw new Error("load failed");
		};

		await expect(cache.load("a", failing, collectingDisposer(disposeErrors))).rejects.toThrow("load failed");
		expect(cache.get("a")).toBeUndefined();

		const a = fakePipeline("a");
		const loaded = await cache.load(
			"a",
			async () => {
				attempts += 1;
				return a;
			},
			collectingDisposer(disposeErrors),
		);
		expect(loaded).toBe(a);
		expect(attempts).toBe(2);

		const cached = await cache.load(
			"a",
			async () => {
				attempts += 1;
				return fakePipeline("other");
			},
			collectingDisposer(disposeErrors),
		);
		expect(cached).toBe(a);
		expect(attempts).toBe(2);
		expect(disposeErrors).toEqual([]);
	});
});
