import { describe, expect, test } from "bun:test";
import { selectGeneratedSnapshot } from "../scripts/scoped-snapshot";

describe("scoped catalog generation", () => {
	const previous = { openrouter: { existing: 1, retired: 2 }, other: { stable: 3 } };
	const generated = { openrouter: { existing: 4, flash: 5 }, other: { stable: 6 } };

	test("refreshes only the requested model without mutating either snapshot", () => {
		const result = selectGeneratedSnapshot(previous, generated, new Set(["openrouter"]), new Set(["flash"]));
		expect(result).toEqual({ openrouter: { existing: 1, retired: 2, flash: 5 }, other: { stable: 3 } });
		expect(previous.openrouter).toEqual({ existing: 1, retired: 2 });
		expect(generated.openrouter).toEqual({ existing: 4, flash: 5 });
	});

	test("refreshes the whole selected provider when no model filter is supplied", () => {
		expect(selectGeneratedSnapshot(previous, generated, new Set(["openrouter"]))).toEqual({
			openrouter: { existing: 4, flash: 5 },
			other: { stable: 3 },
		});
	});

	test("retains full generation when no selection is supplied", () => {
		expect(selectGeneratedSnapshot(previous, generated, new Set())).toEqual(generated);
	});

	test("rejects missing models and providers instead of silently accepting a stale snapshot", () => {
		expect(() => selectGeneratedSnapshot(previous, generated, new Set(["openrouter"]), new Set(["missing"]))).toThrow(
			"No generated model for openrouter/missing",
		);
		expect(() => selectGeneratedSnapshot(previous, generated, new Set(["missing"]))).toThrow(
			"No generated models for missing",
		);
		expect(() => selectGeneratedSnapshot(previous, generated, new Set(), new Set(["flash"]))).toThrow(
			"--models requires --providers",
		);
	});
});
