/**
 * Pure policy tests for the launch authority dictionary (§14.2).
 *
 * These exercise data and pure predicates only. Nothing here confers
 * authority: rejecting a forged serialized grant is a runtime-seam concern
 * (W2/W3) and is deliberately NOT claimed by this file.
 */

import { describe, expect, it } from "bun:test";
import {
	compareRuntimeGuarantees,
	KNOWN_COMPATIBILITY_CLASSIFICATIONS,
	KNOWN_LAUNCH_CLASSES,
	KNOWN_RESOURCE_OPERATIONS,
	type RuntimeGuaranteesV1,
} from "../../src/task/launch-contract";

/** Weakest legal position on every dimension. */
const AMBIENT: RuntimeGuaranteesV1 = Object.freeze({
	initialContext: "legacy-inherited",
	transcriptAccess: "ambient",
	serviceAccess: "ambient",
	artifactAccess: "ambient",
	memoryAccess: "ambient",
	evalState: "ambient",
	filesystemRead: "ambient",
	filesystemWrite: "ambient",
	process: "ambient",
	network: "ambient",
	credentials: "ambient",
});

/** The strict-worker minimum from §14.4. */
const STRICT: RuntimeGuaranteesV1 = Object.freeze({
	initialContext: "explicit-grants-only",
	transcriptAccess: "principal-scoped",
	serviceAccess: "principal-scoped",
	artifactAccess: "principal-scoped",
	memoryAccess: "principal-scoped",
	evalState: "child-owned",
	filesystemRead: "mediated",
	filesystemWrite: "mediated",
	process: "contained",
	network: "mediated",
	credentials: "brokered",
});

describe("compareRuntimeGuarantees (§14.2)", () => {
	it("accepts an exact match on every dimension", () => {
		expect(compareRuntimeGuarantees(STRICT, STRICT)).toEqual([]);
		expect(compareRuntimeGuarantees(AMBIENT, AMBIENT)).toEqual([]);
	});

	it("reports every shortfall, not just the first", () => {
		const shortfalls = compareRuntimeGuarantees(STRICT, AMBIENT);
		// All eleven dimensions fall short; reporting one at a time would make
		// a caller fix them serially and re-probe each time.
		expect(shortfalls).toHaveLength(11);
		expect([...shortfalls.map(s => String(s.dimension))].sort()).toEqual(
			[
				"artifactAccess",
				"credentials",
				"evalState",
				"filesystemRead",
				"filesystemWrite",
				"initialContext",
				"memoryAccess",
				"network",
				"process",
				"serviceAccess",
				"transcriptAccess",
			].sort(),
		);
	});

	it("treats contained as satisfying a mediated requirement, but never the reverse", () => {
		const contained: RuntimeGuaranteesV1 = { ...STRICT, filesystemWrite: "contained", network: "contained" };
		expect(compareRuntimeGuarantees(STRICT, contained)).toEqual([]);

		const requiresContained: RuntimeGuaranteesV1 = { ...STRICT, filesystemWrite: "contained" };
		const onlyMediated: RuntimeGuaranteesV1 = { ...STRICT, filesystemWrite: "mediated" };
		expect(compareRuntimeGuarantees(requiresContained, onlyMediated)).toEqual([
			{ dimension: "filesystemWrite", required: "contained", actual: "mediated" },
		]);
	});

	it("never lets ambient satisfy mediated or contained", () => {
		for (const dimension of ["filesystemRead", "filesystemWrite", "network"] as const) {
			const actual: RuntimeGuaranteesV1 = { ...STRICT, [dimension]: "ambient" };
			expect(compareRuntimeGuarantees(STRICT, actual)).toEqual([
				{ dimension, required: STRICT[dimension], actual: "ambient" },
			]);
		}
	});

	it("does not accept scoped-shared eval state as child-owned", () => {
		const shared: RuntimeGuaranteesV1 = { ...STRICT, evalState: "scoped-shared" };
		expect(compareRuntimeGuarantees(STRICT, shared)).toEqual([
			{ dimension: "evalState", required: "child-owned", actual: "scoped-shared" },
		]);
		// The reverse direction is fine: child-owned exceeds scoped-shared.
		const requiresShared: RuntimeGuaranteesV1 = { ...STRICT, evalState: "scoped-shared" };
		expect(compareRuntimeGuarantees(requiresShared, STRICT)).toEqual([]);
	});

	it("accepts explicit-grants-only for a legacy-inherited requirement, but not the reverse", () => {
		const requiresLegacy: RuntimeGuaranteesV1 = { ...STRICT, initialContext: "legacy-inherited" };
		expect(compareRuntimeGuarantees(requiresLegacy, STRICT)).toEqual([]);

		const actualLegacy: RuntimeGuaranteesV1 = { ...STRICT, initialContext: "legacy-inherited" };
		expect(compareRuntimeGuarantees(STRICT, actualLegacy)).toEqual([
			{ dimension: "initialContext", required: "explicit-grants-only", actual: "legacy-inherited" },
		]);
	});

	it("compares per dimension rather than as a total ranking", () => {
		// Stronger than required on filesystem, weaker on credentials. A total
		// ranking would let the filesystem strength mask the credential gap.
		const mixed: RuntimeGuaranteesV1 = { ...STRICT, filesystemWrite: "contained", credentials: "ambient" };
		expect(compareRuntimeGuarantees(STRICT, mixed)).toEqual([
			{ dimension: "credentials", required: "brokered", actual: "ambient" },
		]);
	});

	it("rejects an unrecognised required value instead of silently passing it", () => {
		const bogus = { ...STRICT, process: "probably-fine" } as unknown as RuntimeGuaranteesV1;
		// Unknown required value has no satisfying set, so it can never be met.
		expect(compareRuntimeGuarantees(bogus, STRICT)).toEqual([
			{ dimension: "process", required: "probably-fine", actual: "contained" },
		]);
	});

	it("returns a frozen result so a caller cannot edit away a shortfall", () => {
		const shortfalls = compareRuntimeGuarantees(STRICT, AMBIENT);
		expect(Object.isFrozen(shortfalls)).toBe(true);
	});
});

describe("Authority vocabularies (§14.2)", () => {
	it("does not offer the interactive root as a delegated launch class", () => {
		// Root is authorized at host bootstrap. Listing it here would let a
		// child request root as if it were a launch option.
		expect(KNOWN_LAUNCH_CLASSES).not.toContain("interactive-root");
		expect([...KNOWN_LAUNCH_CLASSES].sort()).toEqual([
			"legacy-compatible-worker",
			"privileged-helper",
			"strict-worker",
		]);
	});

	it("keeps invalid and temporarily-unenforced as distinct compatibility outcomes", () => {
		// `invalid` rejects outright; `temporarily-unenforced` blocks only a
		// strict launch that requires the missing guarantee.
		expect(KNOWN_COMPATIBILITY_CLASSIFICATIONS).toContain("invalid");
		expect(KNOWN_COMPATIBILITY_CLASSIFICATIONS).toContain("temporarily-unenforced");
	});

	it("separates observation verbs from peer verbs in the operation vocabulary", () => {
		for (const operation of ["observe-status", "observe-transcript", "observe-artifacts"] as const) {
			expect(KNOWN_RESOURCE_OPERATIONS).toContain(operation);
		}
		for (const operation of ["send", "receive", "wake", "broadcast", "busy-reply"] as const) {
			expect(KNOWN_RESOURCE_OPERATIONS).toContain(operation);
		}
		// Reading a transcript is not the same right as messaging a peer.
		expect(KNOWN_RESOURCE_OPERATIONS as readonly string[]).not.toContain("peer");
	});
});
