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
	compileLaunchAuthority,
	computeLaunchContractDigest,
	type GrantRecordV1,
	KNOWN_COMPATIBILITY_CLASSIFICATIONS,
	KNOWN_LAUNCH_CLASSES,
	KNOWN_RESOURCE_OPERATIONS,
	type LaunchBinding,
	parseGrantRecordV1,
	parseResourceSelectorV1,
	type ResourceSelectorV1,
	type RuntimeGuaranteesV1,
	validateLaunchBindingGuarantees,
} from "../../src/task/launch-contract";
import {
	createTestArtifactRef,
	createTestAuthorizationSnapshot,
	createTestEnvelope,
	createTestLaunchAuthority,
	createTestResultAuthority,
	createTestRunLimits,
	createTestSpawnAuthority,
} from "../helpers/lifecycle-fixtures";

const DIGEST_A = "a".repeat(64);

const SELECTOR: ResourceSelectorV1 = Object.freeze({
	kind: "workspace",
	resourceId: "repo:main",
	versionDigest: null,
	scope: Object.freeze({
		roots: Object.freeze(["src/"]),
		exactIds: Object.freeze([]),
		maxBytes: null,
		range: null,
	}),
});

const GRANT: GrantRecordV1 = Object.freeze({
	schemaVersion: 1,
	grantId: "grant-1",
	recordDigest: DIGEST_A,
	issuerPrincipalId: "principal-parent",
	recipientPrincipalId: "principal-child",
	recipientBindingId: "binding-1",
	attemptId: "att-1",
	contractRevision: 1,
	policyEpoch: 1,
	resource: SELECTOR,
	operations: Object.freeze(["read", "write"] as const),
	delegableOperations: Object.freeze(["read"] as const),
	recipientConstraints: Object.freeze([]),
	remainingDelegationDepth: 1,
	domains: Object.freeze(["public-task"] as const),
	sourceGrantIds: Object.freeze([]),
	expiresAt: null,
	purpose: "edit the worker's own source scope",
});

const BINDING_BASE: LaunchBinding = Object.freeze({
	schemaVersion: 1,
	bindingId: "binding-1",
	contractId: "contract-1",
	contractRevision: 1,
	contractDigest: DIGEST_A,
	rootPrincipalId: "principal-root",
	parentPrincipalId: "principal-parent",
	childPrincipalId: "principal-child",
	attemptId: "att-1",
	sessionId: null,
	processRef: null,
	policyEpoch: 1,
	contextGeneration: 0,
	state: "authorized",
	grantBindings: Object.freeze([]),
	serviceBindings: Object.freeze([]),
	actualRuntimeGuarantees: null,
	guaranteeEvidenceRefs: Object.freeze([]),
	reservationId: null,
	lifecycle: null,
	expiresAt: null,
	restoresBindingId: null,
});

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

describe("parseResourceSelectorV1 (§14.2)", () => {
	it("round-trips a valid selector", () => {
		expect(parseResourceSelectorV1(JSON.parse(JSON.stringify(SELECTOR)))).toEqual(SELECTOR);
	});

	it("rejects a selector that names nothing", () => {
		// A grant with no root and no exact id reads as "authorized" while
		// identifying nothing, which is what silently widens at the use seam.
		const empty = { ...SELECTOR, scope: { roots: [], exactIds: [], maxBytes: null, range: null } };
		expect(() => parseResourceSelectorV1(empty)).toThrow(/at least one root or exact id/);
	});

	it("rejects unknown kinds, unknown fields and bad digests", () => {
		expect(() => parseResourceSelectorV1({ ...SELECTOR, kind: "quantum" })).toThrow(/known resource kind/);
		expect(() => parseResourceSelectorV1({ ...SELECTOR, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseResourceSelectorV1({ ...SELECTOR, versionDigest: "nope" })).toThrow(/versionDigest/);
	});

	it("rejects an inverted byte range", () => {
		const inverted = { ...SELECTOR, scope: { ...SELECTOR.scope, range: { start: 10, end: 2 } } };
		expect(() => parseResourceSelectorV1(inverted)).toThrow(/must not precede start/);
	});
});

describe("parseGrantRecordV1 (§14.3)", () => {
	it("round-trips a valid grant", () => {
		expect(parseGrantRecordV1(JSON.parse(JSON.stringify(GRANT)))).toEqual(GRANT);
	});

	it("refuses to let a grant delegate an operation it does not hold", () => {
		// Handing onward what you cannot use is the core escalation this
		// record exists to prevent.
		const overreach = { ...GRANT, operations: ["read"], delegableOperations: ["read", "write"] };
		expect(() => parseGrantRecordV1(overreach)).toThrow(/delegable operation 'write' is not held/);
	});

	it("refuses delegable operations at delegation depth zero", () => {
		const exhausted = { ...GRANT, remainingDelegationDepth: 0 };
		expect(() => parseGrantRecordV1(exhausted)).toThrow(/depth 0 forbids delegable operations/);
		// Depth zero with no delegable operations is legitimate.
		expect(parseGrantRecordV1({ ...GRANT, remainingDelegationDepth: 0, delegableOperations: [] })).toBeDefined();
	});

	it("rejects unknown operations and unknown disclosure domains", () => {
		expect(() => parseGrantRecordV1({ ...GRANT, operations: ["read", "sudo"] })).toThrow(
			/not a known resource operation/,
		);
		expect(() => parseGrantRecordV1({ ...GRANT, domains: ["everyone"] })).toThrow(/not a known disclosure domain/);
	});

	it("accepts a structured artifact-scope domain", () => {
		const scoped = { ...GRANT, domains: [{ kind: "artifact-scope", artifactId: "artifact-7" }] };
		expect(parseGrantRecordV1(scoped).domains).toEqual([{ kind: "artifact-scope", artifactId: "artifact-7" }]);
	});

	it("rejects missing, extra and non-integral fields", () => {
		const { purpose: _purpose, ...missing } = GRANT;
		expect(() => parseGrantRecordV1(missing)).toThrow(/purpose/);
		expect(() => parseGrantRecordV1({ ...GRANT, extra: 1 })).toThrow(/unknown_field/);
		expect(() => parseGrantRecordV1({ ...GRANT, policyEpoch: 1.5 })).toThrow(/policyEpoch/);
		expect(() => parseGrantRecordV1({ ...GRANT, recordDigest: "short" })).toThrow(/recordDigest/);
	});
});

describe("validateLaunchBindingGuarantees (§14.2)", () => {
	it("allows an authorized binding to have no measured guarantees yet", () => {
		expect(() => validateLaunchBindingGuarantees(BINDING_BASE)).not.toThrow();
	});

	it("allows a terminal binding that was cancelled before probing", () => {
		// Pre-probe cancellation must stay an honest audit row rather than
		// being backfilled with guarantees nobody measured.
		for (const state of ["failed", "revoked", "superseded", "terminal"] as const) {
			expect(() => validateLaunchBindingGuarantees({ ...BINDING_BASE, state })).not.toThrow();
		}
	});

	it("refuses a live binding that advertises unmeasured guarantees", () => {
		for (const state of ["bound", "active", "suspended"] as const) {
			expect(() => validateLaunchBindingGuarantees({ ...BINDING_BASE, state })).toThrow(
				/requires measured runtime guarantees/,
			);
		}
	});
});

describe("computeLaunchContractDigest (§14.2)", () => {
	it("excludes the digest field so a contract can verify itself", () => {
		const body = { contractId: "c-1", contractRevision: 1, missionHash: DIGEST_A };
		const digest = computeLaunchContractDigest(body);
		expect(computeLaunchContractDigest({ ...body, contractDigest: digest })).toBe(digest);
	});

	it("changes when any hashed field changes", () => {
		const body = { contractId: "c-1", contractRevision: 1 };
		expect(computeLaunchContractDigest({ ...body, contractRevision: 2 })).not.toBe(computeLaunchContractDigest(body));
	});
});

describe("compileLaunchAuthority (§14.3)", () => {
	it("keeps a capability that every ancestor ceiling allows", () => {
		const result = compileLaunchAuthority(createTestAuthorizationSnapshot());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.authority.usableCapabilities).toEqual([{ source: "builtin", name: "read" }]);
	});

	it("drops a capability the parent cannot delegate and says so", () => {
		// `edit` is in the parent's usable set but the child requests it while
		// an intermediate ceiling withholds it.
		const snapshot = createTestAuthorizationSnapshot({
			requestedAuthority: createTestLaunchAuthority({
				usableCapabilities: [
					{ source: "builtin", name: "read" },
					{ source: "builtin", name: "bash" },
				],
			}),
		});
		const result = compileLaunchAuthority(snapshot);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(d => d.code === "capability_not_delegable")).toBe(true);
	});

	it("distinguishes the tool source, so a same-named tool from elsewhere is not admitted", () => {
		const snapshot = createTestAuthorizationSnapshot({
			requestedAuthority: createTestLaunchAuthority({
				usableCapabilities: [{ source: "mcp", name: "read" }],
			}),
		});
		const result = compileLaunchAuthority(snapshot);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics[0]?.code).toBe("capability_not_delegable");
	});

	it("lets a planner delegate a tool it cannot itself invoke", () => {
		// delegable is compiled against the issuer's delegable ceiling, not
		// derived from usable. Deriving it would strip this planner.
		const snapshot = createTestAuthorizationSnapshot({
			requestedAuthority: createTestLaunchAuthority({
				usableCapabilities: [],
				delegableCapabilities: [{ source: "builtin", name: "read" }],
			}),
		});
		const result = compileLaunchAuthority(snapshot);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.authority.usableCapabilities).toEqual([]);
		expect(result.authority.delegableCapabilities).toEqual([{ source: "builtin", name: "read" }]);
	});

	it("refuses onward rights the issuer may use but may not hand on", () => {
		// The fixture parent can USE edit but only delegates read.
		const snapshot = createTestAuthorizationSnapshot({
			requestedAuthority: createTestLaunchAuthority({
				delegableCapabilities: [{ source: "builtin", name: "edit" }],
			}),
		});
		const result = compileLaunchAuthority(snapshot);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(d => d.code === "capability_not_issuable")).toBe(true);
	});

	it("requires spawn depth to strictly decrease", () => {
		const parentDelegable = createTestEnvelope({
			spawn: createTestSpawnAuthority({ maySpawn: true, mayDelegateSpawn: true, maxDepth: 2, maxChildren: 4 }),
		});
		const equalDepth = compileLaunchAuthority(
			createTestAuthorizationSnapshot({
				parentDelegable,
				requestedAuthority: createTestLaunchAuthority({
					spawn: createTestSpawnAuthority({ maySpawn: true, maxDepth: 2, maxChildren: 1 }),
				}),
			}),
		);
		expect(equalDepth.ok).toBe(false);
		if (equalDepth.ok) return;
		expect(equalDepth.diagnostics.some(d => d.code === "spawn_depth_not_decreasing")).toBe(true);

		const decreasing = compileLaunchAuthority(
			createTestAuthorizationSnapshot({
				parentDelegable,
				requestedAuthority: createTestLaunchAuthority({
					spawn: createTestSpawnAuthority({ maySpawn: true, maxDepth: 1, maxChildren: 1 }),
				}),
			}),
		);
		expect(decreasing.ok).toBe(true);
	});

	it("refuses to let a non-delegating parent confer spawn rights", () => {
		const result = compileLaunchAuthority(
			createTestAuthorizationSnapshot({
				requestedAuthority: createTestLaunchAuthority({
					spawn: createTestSpawnAuthority({ maySpawn: true, maxDepth: 1 }),
				}),
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(d => d.code === "spawn_not_delegable")).toBe(true);
	});

	it("refuses legacy unlimited budgeting for a strict worker", () => {
		const result = compileLaunchAuthority(
			createTestAuthorizationSnapshot({
				requestedAuthority: createTestLaunchAuthority({
					budget: {
						kind: "legacy",
						limits: createTestRunLimits(),
						reservation: { requests: 0, runtimeMs: 0, tokens: null, costMicrounits: null },
						zeroMeansUnlimited: true,
						authorityRef: "legacy-authz",
					},
				}),
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(d => d.code === "budget_required")).toBe(true);
	});

	it("refuses a privileged fork on a non-privileged launch class", () => {
		const result = compileLaunchAuthority(
			createTestAuthorizationSnapshot({
				requestedAuthority: createTestLaunchAuthority({
					launchClass: "strict-worker",
					contextMode: {
						kind: "privileged-fork",
						parentSnapshotRef: createTestArtifactRef("artifact-fork"),
						parentSnapshotGrantIntentId: "intent-fork",
						snapshotVersion: 1,
						reason: "resume parent reasoning",
					},
				}),
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(d => d.code === "fork_requires_privileged_helper")).toBe(true);
	});

	it("refuses a blind child that would expose its transcript", () => {
		const result = compileLaunchAuthority(
			createTestAuthorizationSnapshot({
				requestedAuthority: createTestLaunchAuthority({
					contextMode: { kind: "fresh", strategy: "blind", independence: "independent-verifier" },
					observation: { observers: [{ principalId: "principal-parent", rights: ["transcript"] }] },
				}),
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(d => d.code === "blind_context_transcript_observer")).toBe(true);
	});

	it("refuses a contract requiring publication it may not apply", () => {
		const result = compileLaunchAuthority(
			createTestAuthorizationSnapshot({
				requestedAuthority: createTestLaunchAuthority({
					result: createTestResultAuthority({
						publicationRequired: true,
						// Demanding publication while forbidding apply is the
						// contradiction: the child could never satisfy it.
						mutation: {
							schemaVersion: 1,
							apply: false,
							allowCommit: false,
							allowPush: false,
							allowMerge: false,
							approvalRef: null,
						},
					}),
				}),
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.some(d => d.code === "inconsistent_launch_policy")).toBe(true);
	});

	it("accepts required publication when the mutation contract permits apply", () => {
		const result = compileLaunchAuthority(
			createTestAuthorizationSnapshot({
				requestedAuthority: createTestLaunchAuthority({
					result: createTestResultAuthority({ publicationRequired: true }),
				}),
			}),
		);
		expect(result.ok).toBe(true);
	});

	it("rejects an unsupported authorization snapshot version before doing any work", () => {
		const result = compileLaunchAuthority({
			...createTestAuthorizationSnapshot(),
			schemaVersion: 2 as unknown as 1,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.code).toBe("unsupported_authorization_version");
	});

	it("deduplicates a repeated capability request", () => {
		const result = compileLaunchAuthority(
			createTestAuthorizationSnapshot({
				requestedAuthority: createTestLaunchAuthority({
					usableCapabilities: [
						{ source: "builtin", name: "read" },
						{ source: "builtin", name: "read" },
					],
				}),
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.authority.usableCapabilities).toHaveLength(1);
	});
});
