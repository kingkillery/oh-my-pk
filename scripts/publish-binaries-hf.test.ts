import { describe, expect, it } from "bun:test";
import { parseRequestedBinaryTargets, planBinaryPublish } from "./publish-binaries-hf";

describe("parseRequestedBinaryTargets", () => {
	it("maps target ids to the omp + ompk-collector file pair", () => {
		expect(parseRequestedBinaryTargets("win32-x64, linux-x64")).toEqual([
			{ id: "win32-x64", files: ["omp-windows-x64.exe", "ompk-collector-win32-x64.exe"] },
			{ id: "linux-x64", files: ["omp-linux-x64", "ompk-collector-linux-x64"] },
		]);
	});

	it("rejects unknown targets before building", () => {
		expect(() => parseRequestedBinaryTargets("linux-riscv64")).toThrow("Unknown target");
	});
});

describe("planBinaryPublish", () => {
	it("skips a target only when both files are present under the tag", () => {
		const existing = new Set([
			"omp-darwin-arm64",
			"ompk-collector-darwin-arm64",
			"omp-darwin-x64",
			"ompk-collector-darwin-x64",
			"omp-linux-arm64",
			"ompk-collector-linux-arm64",
			"omp-linux-x64",
			"ompk-collector-linux-x64",
			// win32 pair deliberately incomplete below.
		]);

		const plan = planBinaryPublish("win32-x64,linux-x64", existing, false);

		expect(plan.skippedExisting).toEqual([{ id: "linux-x64", files: ["omp-linux-x64", "ompk-collector-linux-x64"] }]);
		expect(plan.toBuild).toEqual([
			{ id: "win32-x64", files: ["omp-windows-x64.exe", "ompk-collector-win32-x64.exe"] },
		]);
		expect(plan.missingRequiredAfterBuild).toEqual([]);
	});

	it("rebuilds a target when only its collector helper is missing", () => {
		const existing = new Set([
			"omp-windows-x64.exe",
			// ompk-collector-win32-x64.exe absent.
		]);

		const plan = planBinaryPublish("win32-x64", existing, false);

		expect(plan.skippedExisting).toEqual([]);
		expect(plan.toBuild).toEqual([
			{ id: "win32-x64", files: ["omp-windows-x64.exe", "ompk-collector-win32-x64.exe"] },
		]);
	});

	it("forces rebuilds even when both files are already present", () => {
		const existing = new Set(["omp-windows-x64.exe", "ompk-collector-win32-x64.exe"]);

		const plan = planBinaryPublish("win32-x64", existing, true);

		expect(plan.skippedExisting).toEqual([]);
		expect(plan.toBuild).toEqual([
			{ id: "win32-x64", files: ["omp-windows-x64.exe", "ompk-collector-win32-x64.exe"] },
		]);
	});

	it("reports missing helper binaries as required gaps after build", () => {
		const existing = new Set(["omp-windows-x64.exe", "ompk-collector-win32-x64.exe"]);

		const plan = planBinaryPublish("win32-x64", existing, false);

		expect(plan.missingRequiredAfterBuild).toContain("ompk-collector-darwin-arm64");
		expect(plan.missingRequiredAfterBuild).toContain("omp-linux-x64");
	});
});
