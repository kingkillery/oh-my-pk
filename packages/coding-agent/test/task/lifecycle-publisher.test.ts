import { describe, expect, it } from "bun:test";
import type { PublicationInput } from "../../src/task/lifecycle-publisher";
import { publishLifecycleCandidate, publishWithEffects } from "../../src/task/lifecycle-publisher";

function makeInput(overrides: Partial<PublicationInput> = {}): PublicationInput {
	return {
		runId: "run-1",
		attemptId: "att-1",
		manifest: {
			schemaVersion: 1,
			artifactId: "art-1",
			uri: "artifact://att-1.patch",
			sha256: "a".repeat(64),
			bytes: 10,
			mediaType: "text/x-diff",
			provenanceId: "att-1",
		},
		expectedCandidate: { schemaVersion: 1, manifestHash: "c", manifestUri: "artifact://candidate" },
		target: "run-candidate",
		mutation: {
			schemaVersion: 1,
			apply: true,
			allowCommit: false,
			allowPush: false,
			allowMerge: false,
			approvalRef: null,
		},
		approvalRef: null,
		idempotencyKey: "pub-1",
		...overrides,
	};
}

describe("Lifecycle publisher (A10)", () => {
	it("keeps apply=false candidates pending with no workspace mutation", async () => {
		const receipt = await publishLifecycleCandidate(
			makeInput({
				mutation: {
					schemaVersion: 1,
					apply: false,
					allowCommit: false,
					allowPush: false,
					allowMerge: false,
					approvalRef: null,
				},
			}),
		);
		expect(receipt.state).toBe("pending");
		expect(receipt.changesApplied).toBe(false);
		expect(receipt.mutatedRepositories).toHaveLength(0);
	});

	it("rejects user-workspace publication without exact approval", async () => {
		const missing = await publishLifecycleCandidate(makeInput({ target: "user-workspace" }));
		expect(missing.state).toBe("rejected");
		expect(missing.changesApplied).toBe(false);

		const changed = await publishLifecycleCandidate(
			makeInput({
				target: "user-workspace",
				mutation: {
					schemaVersion: 1,
					apply: true,
					allowCommit: false,
					allowPush: false,
					allowMerge: false,
					approvalRef: "approval-A",
				},
				approvalRef: "approval-B",
			}),
		);
		expect(changed.state).toBe("rejected");
		expect(changed.obligationIds.some(id => id.startsWith("approval-changed"))).toBe(true);
	});

	it("integrates approved user-workspace publication", async () => {
		const receipt = await publishLifecycleCandidate(
			makeInput({
				target: "user-workspace",
				mutation: {
					schemaVersion: 1,
					apply: true,
					allowCommit: false,
					allowPush: false,
					allowMerge: false,
					approvalRef: "approval-A",
				},
				approvalRef: "approval-A",
			}),
		);
		expect(receipt.state).toBe("integrated");
		expect(receipt.changesApplied).toBe(true);
	});

	it("records partial when a nested repository fails while root applies", async () => {
		const receipt = await publishWithEffects(makeInput(), {
			applyToTarget: async () => ({ applied: ["root-repo"], failed: ["nested-repo"] }),
		});
		expect(receipt.state).toBe("partial");
		expect(receipt.changesApplied).toBe(false);
		expect(receipt.mutatedRepositories).toContain("root-repo");
		expect(receipt.obligationIds.some(id => id.startsWith("publication-partial"))).toBe(true);
	});

	it("records conflict when nothing applies, preserving both sides", async () => {
		const receipt = await publishWithEffects(makeInput(), {
			applyToTarget: async () => ({ applied: [], failed: ["root-repo"] }),
		});
		expect(receipt.state).toBe("conflicted");
		expect(receipt.changesApplied).toBe(false);
		expect(receipt.recoveryRefs).toContain("artifact://att-1.patch");
	});
});
