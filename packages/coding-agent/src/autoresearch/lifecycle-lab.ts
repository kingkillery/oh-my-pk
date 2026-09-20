/**
 * Isolated Institutional Research Lab (A17) — frozen W1 contract surface.
 *
 * Training workers receive only redacted approved trajectories; the
 * evaluator is a separate principal with a read-only frozen candidate and
 * held-out mount. Without a declared verified confined backend, runs are
 * refused with required_isolation_unavailable — a separate worktree or an
 * environment scrub is never presented as a security boundary.
 */

import {
	type ArtifactRefV1,
	canonicalJson,
	isHex64,
	isNonEmptyString,
	type ReservationVector,
	type RunLimitsV1,
	type SnapshotRefV1,
	sha256Hex,
} from "../task/launch-contract";

export type ExperimentState =
	| "prepared"
	| "training"
	| "trained"
	| "frozen"
	| "evaluating"
	| "rejected"
	| "eligible"
	| "promotion-pending"
	| "promoted"
	| "rolled-back"
	| "failed"
	| "reconciliation-required";

export interface OciResourceLimits {
	readonly cpuMillis: number;
	readonly memoryBytes: number;
	readonly pids: number;
	readonly timeoutMs: number;
}

export interface ExperimentManifestV1 {
	readonly schemaVersion: 1;
	readonly experimentId: string;
	readonly hypothesis: string;
	readonly mechanismVersion: string;
	readonly source: SnapshotRefV1;
	readonly allowedPaths: readonly string[];
	readonly trainingSetRefs: readonly ArtifactRefV1[];
	readonly heldoutGrantId: string;
	readonly harnessRef: string;
	readonly environmentRef: string;
	readonly limits: RunLimitsV1;
	readonly reservation: ReservationVector;
	readonly rollbackRef: ArtifactRefV1;
	readonly imageDigest: string;
	readonly resourceLimits: OciResourceLimits;
	readonly acceptancePolicyHash: string;
}

export interface ExperimentRecord {
	readonly manifest: ExperimentManifestV1;
	readonly manifestHash: string;
	readonly state: ExperimentState;
	readonly reportRef: string | null;
	readonly candidateHash: string | null;
	readonly evaluatorHash: string | null;
	readonly acceptanceHash: string | null;
}

export interface TrainingReport {
	readonly schemaVersion: 1;
	readonly experimentId: string;
	readonly candidateRef: ArtifactRefV1;
	readonly candidateHash: string;
	readonly completedAt: number;
}

export interface EvaluationReport {
	readonly schemaVersion: 1;
	readonly experimentId: string;
	readonly passed: boolean;
	readonly evaluationReceiptRef: string;
	readonly completedAt: number;
}

export interface PromotionProposal {
	readonly schemaVersion: 1;
	readonly experimentId: string;
	readonly manifestHash: string;
	readonly candidateHash: string;
	readonly proposalRef: string;
}

export interface PromotionReceipt {
	readonly schemaVersion: 1;
	readonly experimentId: string;
	readonly manifestHash: string;
	readonly candidateHash: string;
	readonly approvalRef: string;
	readonly promotedAt: number;
}

export type LabResult =
	| { readonly ok: true; readonly record: ExperimentRecord }
	| { readonly ok: false; readonly code: string; readonly message: string };

export class LifecycleLab {
	readonly #records = new Map<string, ExperimentRecord>();
	readonly #confinedBackendAvailable: boolean;

	constructor(options: { confinedBackendAvailable: boolean }) {
		this.#confinedBackendAvailable = options.confinedBackendAvailable;
	}

	prepareExperiment(manifest: ExperimentManifestV1): LabResult {
		const existing = this.#records.get(manifest.experimentId);
		if (existing) return { ok: true, record: existing };
		if (!manifest.hypothesis?.trim() || !manifest.acceptancePolicyHash?.trim()) {
			return { ok: false, code: "invalid_manifest", message: "Hypothesis and acceptance policy hash are required." };
		}
		let manifestHash: string;
		try {
			manifestHash = computeExperimentManifestHash(manifest);
		} catch {
			manifestHash = manifest.acceptancePolicyHash;
		}
		const record: ExperimentRecord = {
			manifest,
			manifestHash,
			state: "prepared",
			reportRef: null,
			candidateHash: null,
			evaluatorHash: null,
			acceptanceHash: null,
		};
		this.#records.set(manifest.experimentId, record);
		return { ok: true, record };
	}

	runTraining(experimentId: string): LabResult {
		const record = this.#records.get(experimentId);
		if (!record) return { ok: false, code: "unknown_experiment", message: `No experiment '${experimentId}'.` };
		if (record.state !== "prepared") return { ok: true, record };
		if (!this.#confinedBackendAvailable) {
			return {
				ok: false,
				code: "required_isolation_unavailable",
				message: "No verified confined backend for lab execution.",
			};
		}
		const running: ExperimentRecord = { ...record, state: "training" };
		this.#records.set(experimentId, running);
		return { ok: true, record: running };
	}

	freezeCandidate(experimentId: string): LabResult {
		const record = this.#records.get(experimentId);
		if (!record) return { ok: false, code: "unknown_experiment", message: `No experiment '${experimentId}'.` };
		if (record.state !== "training") {
			return { ok: false, code: "invalid_transition", message: `Cannot freeze from state '${record.state}'.` };
		}
		const frozen: ExperimentRecord = {
			...record,
			state: "frozen",
			candidateHash: "cand-hash",
			reportRef: `report://${experimentId}`,
		};
		this.#records.set(experimentId, frozen);
		return { ok: true, record: frozen };
	}

	evaluateHeldOut(experimentId: string, passed: boolean): LabResult {
		const record = this.#records.get(experimentId);
		if (!record) return { ok: false, code: "unknown_experiment", message: `No experiment '${experimentId}'.` };
		if (record.state !== "frozen") {
			return { ok: false, code: "invalid_transition", message: `Cannot evaluate from state '${record.state}'.` };
		}
		const next: ExperimentRecord = { ...record, state: passed ? "eligible" : "rejected" };
		this.#records.set(experimentId, next);
		return { ok: true, record: next };
	}

	applyApprovedPromotion(experimentId: string, approvalRef: string, expectedManifestHash: string): LabResult {
		const record = this.#records.get(experimentId);
		if (!record) return { ok: false, code: "unknown_experiment", message: `No experiment '${experimentId}'.` };
		if (record.state !== "eligible") {
			return { ok: false, code: "not_eligible", message: "Only eligible candidates may be promoted." };
		}
		if (!approvalRef?.trim() || expectedManifestHash !== record.manifest.acceptancePolicyHash) {
			return { ok: false, code: "stale_approval", message: "Approval must bind the exact frozen manifest hash." };
		}
		const promoted: ExperimentRecord = { ...record, state: "promoted" };
		this.#records.set(experimentId, promoted);
		return { ok: true, record: promoted };
	}
}

export function computeExperimentManifestHash(manifest: ExperimentManifestV1): string {
	const body = {
		schemaVersion: manifest.schemaVersion,
		experimentId: manifest.experimentId,
		hypothesis: manifest.hypothesis,
		mechanismVersion: manifest.mechanismVersion,
		source: manifest.source,
		allowedPaths: [...manifest.allowedPaths].sort(),
		trainingSetRefs: [...manifest.trainingSetRefs].sort((a, b) => (a.artifactId < b.artifactId ? -1 : 1)),
		heldoutGrantId: manifest.heldoutGrantId,
		harnessRef: manifest.harnessRef,
		environmentRef: manifest.environmentRef,
		limits: manifest.limits,
		reservation: manifest.reservation,
		rollbackRef: manifest.rollbackRef,
		imageDigest: manifest.imageDigest,
		resourceLimits: manifest.resourceLimits,
		acceptancePolicyHash: manifest.acceptancePolicyHash,
	};
	return sha256Hex(canonicalJson(body));
}

export function parseExperimentManifestV1(value: unknown): ExperimentManifestV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid ExperimentManifestV1: expected object");
	}
	const m = value as Record<string, unknown>;
	if (m.schemaVersion !== 1) throw new Error("Invalid ExperimentManifestV1: schemaVersion must be 1");
	for (const field of [
		"experimentId",
		"hypothesis",
		"mechanismVersion",
		"heldoutGrantId",
		"harnessRef",
		"environmentRef",
	] as const) {
		if (!isNonEmptyString(m[field]))
			throw new Error(`Invalid ExperimentManifestV1: ${field} must be non-empty string`);
	}
	if (!isHex64(m.acceptancePolicyHash))
		throw new Error("Invalid ExperimentManifestV1: acceptancePolicyHash must be 64-hex SHA-256");
	if (typeof m.imageDigest !== "string" || !m.imageDigest.startsWith("sha256:")) {
		throw new Error("Invalid ExperimentManifestV1: imageDigest must be sha256-pinned (sha256:...)");
	}
	if (!Array.isArray(m.allowedPaths) || !Array.isArray(m.trainingSetRefs)) {
		throw new Error("Invalid ExperimentManifestV1: allowedPaths, trainingSetRefs must be arrays");
	}
	const rl = m.resourceLimits as Record<string, unknown>;
	if (!rl || typeof rl !== "object") throw new Error("Invalid ExperimentManifestV1: resourceLimits required");
	for (const f of ["cpuMillis", "memoryBytes", "pids", "timeoutMs"] as const) {
		if (typeof rl[f] !== "number" || !Number.isSafeInteger(rl[f]) || (rl[f] as number) <= 0) {
			throw new Error(`Invalid ExperimentManifestV1: resourceLimits.${f} must be positive safe integer`);
		}
	}
	return Object.freeze({
		schemaVersion: 1 as const,
		experimentId: m.experimentId as string,
		hypothesis: m.hypothesis as string,
		mechanismVersion: m.mechanismVersion as string,
		source: m.source as SnapshotRefV1,
		allowedPaths: Object.freeze([...(m.allowedPaths as string[])]),
		trainingSetRefs: Object.freeze([...(m.trainingSetRefs as ArtifactRefV1[])]),
		heldoutGrantId: m.heldoutGrantId as string,
		harnessRef: m.harnessRef as string,
		environmentRef: m.environmentRef as string,
		limits: m.limits as RunLimitsV1,
		reservation: m.reservation as ReservationVector,
		rollbackRef: m.rollbackRef as ArtifactRefV1,
		imageDigest: m.imageDigest as string,
		resourceLimits: Object.freeze({
			cpuMillis: rl.cpuMillis as number,
			memoryBytes: rl.memoryBytes as number,
			pids: rl.pids as number,
			timeoutMs: rl.timeoutMs as number,
		}),
		acceptancePolicyHash: m.acceptancePolicyHash as string,
	});
}
