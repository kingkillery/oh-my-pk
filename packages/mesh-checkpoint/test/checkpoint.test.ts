import { describe, expect, test } from "bun:test";

import { CheckpointSafetyError, createCheckpointManifest } from "../src";

const createdBy = Object.freeze({ pubkey: "0123456789abcdef0123456789abcdef", role: "worker" as const, nodeId: "node_worker" });

function input(): Record<string, unknown> {
	return {
		checkpointId: "cp_alpha",
		workspaceId: "workspace-alpha",
		createdAt: "2026-08-31T12:00:00.000Z",
		createdBy,
		sourceNodeId: "node_worker",
		repository: { branch: "feature/alpha", headCommit: "abc123", remote: "github.com/kingkillery/oh-my-pk" },
		gitState: { dirty: true, stagedCount: 1, unstagedCount: 1, untrackedCount: 0 },
		files: [
			{ path: "packages/mesh-eventbus/src/store.ts", status: "modified", sha256: "a".repeat(64), sizeBytes: 1234 },
		],
		excluded: [{ path: ".env", reason: "secret policy" }],
		secretScan: { status: "passed", scanner: "local-policy", findingCount: 0 },
		artifactManifestId: "art_alpha",
	};
}

describe("createCheckpointManifest", () => {
	test("creates a metadata-only manifest for a dirty workspace", () => {
		const manifest = createCheckpointManifest(input() as never);
		const serialized = JSON.stringify(manifest);

		expect(manifest.gitState.dirty).toBe(true);
		expect(manifest.contentDigest).toHaveLength(64);
		expect(serialized).not.toContain("workspace file body");
		expect(serialized).not.toContain("super-secret-token");
	});

	test("rejects raw file content and credential-bearing metadata", () => {
		const rawContent = input();
		(rawContent.files as Array<Record<string, unknown>>)[0].contents = "workspace file body";
		expect(() => createCheckpointManifest(rawContent as never)).toThrow(CheckpointSafetyError);
		const nestedContent = input();
		(nestedContent.files as Array<Record<string, unknown>>)[0].metadata = { provenance: { diff: "workspace file body" } };
		expect(() => createCheckpointManifest(nestedContent as never)).toThrow(CheckpointSafetyError);
		const nestedBytes = input();
		(nestedBytes.excluded as Array<Record<string, unknown>>)[0].metadata = [{ hashes: { bytes: "workspace file body" } }];
		expect(() => createCheckpointManifest(nestedBytes as never)).toThrow(CheckpointSafetyError);

		const secret = input();
		(secret.gitState as Record<string, unknown>).apiToken = "super-secret-token";
		expect(() => createCheckpointManifest(secret as never)).toThrow(CheckpointSafetyError);
	});
});
