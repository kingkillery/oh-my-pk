import { describe, expect, it } from "bun:test";

import { assertCaptureOptions, captureScreenshot } from "../src/context";
import type { CaptureRegion } from "../src/types";

const invalidRegions: Array<[keyof CaptureRegion, CaptureRegion]> = [
	["x", { x: 0, y: 1, width: 10, height: 10 }],
	["y", { x: 1, y: Number.NaN, width: 10, height: 10 }],
	["width", { x: 1, y: 1, width: -1, height: 10 }],
	["height", { x: 1, y: 1, width: 10, height: Number.POSITIVE_INFINITY }],
];

describe("capture validation", () => {
	it("requires a region for region captures", () => {
		expect(() => assertCaptureOptions({ mode: "region", userRequest: "inspect this" })).toThrow(
			"Region capture requires a region",
		);
	});

	it("rejects unknown capture modes", () => {
		expect(() => assertCaptureOptions({ mode: "desktop", userRequest: "inspect this" })).toThrow(
			"Unsupported capture mode",
		);
	});

	it.each(invalidRegions)("rejects an invalid %s before screenshot capture", async (field, region) => {
		await expect(captureScreenshot("unused.png", region)).rejects.toThrow(
			`Capture region ${field} must be a finite positive number`,
		);
	});

	it("rejects a malformed region supplied for a non-region mode", () => {
		expect(() =>
			assertCaptureOptions({
				mode: "screen",
				userRequest: "inspect this",
				region: { x: 1, y: 1, width: 0, height: 10 },
			}),
		).toThrow("Capture region width must be a finite positive number");
	});
});
