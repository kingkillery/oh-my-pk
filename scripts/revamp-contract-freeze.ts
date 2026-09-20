/**
 * W1 schema freeze recorder.
 *
 * Emits `docs/revamp/contract-freeze.json`: for every frozen lifecycle wire
 * shape, the module, exported type, strict parser, and a canonical schema
 * descriptor digest.
 *
 * The descriptor digest is derived from the parser's accepted-field allowlist
 * as declared in source, NOT from a hash of the TypeScript text. Reformatting
 * a file must not change a schema digest, and adding or removing an accepted
 * field must.
 *
 * Usage (from repository root):
 *   bun scripts/revamp-contract-freeze.ts --out docs/revamp/contract-freeze.json
 */

import { createHash } from "node:crypto";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CA = path.join(REPO_ROOT, "packages", "coding-agent");

interface FrozenShape {
	/** Exported TypeScript type name. */
	readonly typeName: string;
	/** Package-relative module declaring the type. */
	readonly module: string;
	/** Exported strict parser that gates this shape at a storage boundary. */
	readonly parser: string;
	/** `const` in that module holding the accepted-field allowlist. */
	readonly keysConst: string;
	/** Declared wire version, or null for shapes carrying no version field. */
	readonly schemaVersion: number | null;
}

/**
 * Every shape named in the W1 freeze manifest. A shape listed here without a
 * resolvable allowlist is reported as `unresolved`, never silently skipped:
 * a missing descriptor means the freeze is incomplete, not clean.
 */
const FROZEN_SHAPES: readonly FrozenShape[] = [
	// Launch and policy contract
	{ typeName: "SnapshotRefV1", module: "src/task/launch-contract.ts", parser: "parseSnapshotRefV1", keysConst: "SNAPSHOT_KEYS", schemaVersion: 1 },
	{ typeName: "ArtifactRefV1", module: "src/task/launch-contract.ts", parser: "parseArtifactRefV1", keysConst: "ARTIFACT_KEYS", schemaVersion: 1 },
	{ typeName: "MutationContractV1", module: "src/task/launch-contract.ts", parser: "parseCompiledLaunchContract", keysConst: "MUTATION_KEYS", schemaVersion: 1 },
	{ typeName: "RunLimitsV1", module: "src/task/launch-contract.ts", parser: "parseRunLimitsV1", keysConst: "LIMITS_KEYS", schemaVersion: 1 },
	{ typeName: "ReservationVector", module: "src/task/launch-contract.ts", parser: "parseReservationVector", keysConst: "RESERVATION_KEYS", schemaVersion: null },
	{ typeName: "LifecycleFence", module: "src/task/launch-contract.ts", parser: "parseLifecycleFence", keysConst: "FENCE_KEYS", schemaVersion: null },
	{ typeName: "RuntimePolicySnapshotV1", module: "src/task/launch-contract.ts", parser: "parseLaunchContract", keysConst: "POLICY_KEYS", schemaVersion: 1 },
	{ typeName: "MissionCapsule", module: "src/task/launch-contract.ts", parser: "parseLaunchContract", keysConst: "CAPSULE_KEYS", schemaVersion: 1 },
	{ typeName: "LaunchContract", module: "src/task/launch-contract.ts", parser: "parseLaunchContract", keysConst: "CONTRACT_KEYS", schemaVersion: 1 },
	{ typeName: "LaunchBinding", module: "src/task/launch-contract.ts", parser: "parseLaunchContract", keysConst: "ENVELOPE_KEYS", schemaVersion: null },
	{ typeName: "LifecycleHandoffV1", module: "src/task/launch-contract.ts", parser: "parseLifecycleHandoff", keysConst: "HANDOFF_KEYS", schemaVersion: 1 },
	{ typeName: "ObligationV1", module: "src/task/launch-contract.ts", parser: "parseObligationV1", keysConst: "OBLIGATION_KEYS", schemaVersion: 1 },

	// Persisted lifecycle records
	{ typeName: "LifecycleNodeSnapshot", module: "src/operational/lifecycle-types.ts", parser: "parseLifecycleNodeSnapshot", keysConst: "NODE_SNAPSHOT_KEYS", schemaVersion: null },
	{ typeName: "LifecycleAttemptSnapshot", module: "src/operational/lifecycle-types.ts", parser: "parseLifecycleAttemptSnapshot", keysConst: "ATTEMPT_SNAPSHOT_KEYS", schemaVersion: null },
	{ typeName: "LifecycleDependencySnapshot", module: "src/operational/lifecycle-types.ts", parser: "parseLifecycleDependencySnapshot", keysConst: "DEPENDENCY_SNAPSHOT_KEYS", schemaVersion: null },
	{ typeName: "LifecycleRunSnapshot", module: "src/operational/lifecycle-types.ts", parser: "parseLifecycleRunSnapshot", keysConst: "RUN_SNAPSHOT_KEYS", schemaVersion: 1 },
	{ typeName: "RecoveryCapsuleV1", module: "src/operational/lifecycle-types.ts", parser: "parseRecoveryCapsuleV1", keysConst: "RECOVERY_CAPSULE_KEYS", schemaVersion: 1 },

	// Evidence and projection
	{ typeName: "VerificationReceiptV1", module: "src/orchestration/snapshot-completion.ts", parser: "parseVerificationReceiptV1", keysConst: "VERIFICATION_RECEIPT_KEYS", schemaVersion: 1 },
	{ typeName: "ProjectionManifest", module: "src/orchestration/context-projector.ts", parser: "parseProjectionManifest", keysConst: "PROJECTION_MANIFEST_KEYS", schemaVersion: 1 },
	{ typeName: "HarnessManifestV1", module: "src/orchestration/harness-manifest.ts", parser: "parseHarnessManifestV1", keysConst: "HARNESS_MANIFEST_KEYS", schemaVersion: 1 },
	{ typeName: "PublicationReceipt", module: "src/task/lifecycle-publisher.ts", parser: "parsePublicationReceipt", keysConst: "PUBLICATION_RECEIPT_KEYS", schemaVersion: 1 },
];

/** Source globs contributing to the candidate manifest digest (§3.7). */
const MANIFEST_GLOBS = [
	"packages/coding-agent/src/**/*.ts",
	"packages/coding-agent/src/**/*.md",
	"packages/coding-agent/test/**/*.ts",
	"packages/coding-agent/package.json",
	"scripts/*.ts",
];

/** Never hashed: secrets, build output, local state, and receipts. */
const MANIFEST_EXCLUDE = /(^|[\\/])(\.env|node_modules|dist|docs[\\/]revamp)([\\/]|$)/;

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		// Code-unit ordering, not locale-dependent compare.
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function sha256(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Extract a `const NAME = [...] as const;` string-literal allowlist. Returns
 * null when the declaration is absent or not a flat literal list, so the
 * caller can record the shape as unresolved rather than guess its fields.
 */
function extractKeys(source: string, constName: string): readonly string[] | null {
	const start = source.indexOf(`const ${constName}`);
	if (start === -1) return null;
	const open = source.indexOf("[", start);
	const close = source.indexOf("]", open);
	if (open === -1 || close === -1) return null;
	const body = source.slice(open + 1, close);
	const keys = [...body.matchAll(/"([^"]+)"/g)].map(m => m[1] as string);
	return keys.length > 0 ? keys : null;
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = path.resolve(
	REPO_ROOT,
	outIndex !== -1 && args[outIndex + 1] ? (args[outIndex + 1] as string) : "docs/revamp/contract-freeze.json",
);

const sourceCache = new Map<string, string>();
const shapes = [];
const unresolved: string[] = [];

for (const shape of FROZEN_SHAPES) {
	const abs = path.join(CA, shape.module);
	let source = sourceCache.get(abs);
	if (source === undefined) {
		source = await Bun.file(abs).text();
		sourceCache.set(abs, source);
	}
	const acceptedFields = extractKeys(source, shape.keysConst);
	if (acceptedFields === null) unresolved.push(`${shape.typeName} (${shape.keysConst})`);
	const descriptor = {
		typeName: shape.typeName,
		module: `packages/coding-agent/${shape.module.replaceAll("\\", "/")}`,
		schemaVersion: shape.schemaVersion,
		// Sorted: field ORDER is not part of the contract, field SET is.
		acceptedFields: acceptedFields === null ? null : [...acceptedFields].sort(),
	};
	shapes.push({
		...descriptor,
		parser: shape.parser,
		status: acceptedFields === null ? ("unresolved" as const) : ("frozen" as const),
		descriptorDigest: acceptedFields === null ? null : sha256(canonicalJson(descriptor)),
	});
}

// Candidate manifest digest: sorted relative paths + exact content hashes.
const manifestEntries: { path: string; sha256: string; bytes: number }[] = [];
for (const pattern of MANIFEST_GLOBS) {
	for await (const entry of new Bun.Glob(pattern).scan({ cwd: REPO_ROOT, onlyFiles: true })) {
		const rel = entry.replaceAll("\\", "/");
		if (MANIFEST_EXCLUDE.test(rel)) continue;
		const bytes = await Bun.file(path.join(REPO_ROOT, entry)).arrayBuffer();
		manifestEntries.push({
			path: rel,
			sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
			bytes: bytes.byteLength,
		});
	}
}
manifestEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const record = {
	schemaVersion: 1,
	wave: "W1-checkpoint",
	generatedBy: "scripts/revamp-contract-freeze.ts",
	candidateManifestDigest: sha256(canonicalJson(manifestEntries)),
	candidateManifestFileCount: manifestEntries.length,
	shapes,
	unresolvedShapes: unresolved,
	complete: unresolved.length === 0,
};

await Bun.write(outPath, `${JSON.stringify(record, null, "\t")}\n`);
console.log(`contract-freeze: ${shapes.length} shapes, ${unresolved.length} unresolved`);
console.log(`candidate manifest: ${manifestEntries.length} files, digest ${record.candidateManifestDigest}`);
if (unresolved.length > 0) {
	console.error(`unresolved allowlists: ${unresolved.join(", ")}`);
	process.exit(1);
}
