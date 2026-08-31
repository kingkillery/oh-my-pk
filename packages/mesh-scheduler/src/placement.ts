import type { TaskContractV1, TrustZone } from "@pk-nerdsaver-ai/mesh-contracts";

/** Scheduler-facing, normalized node state. Node agents own how this is derived. */
export interface PlacementNode {
	readonly nodeId: string;
	readonly actorPubkey: string;
	readonly trustZone: TrustZone;
	readonly observedAt: string;
	readonly expiresAt: string;
	readonly interactive: boolean;
	readonly activeInteractiveUser: boolean;
	readonly draining: boolean;
	readonly healthy: boolean;
	readonly capabilities: readonly string[];
	readonly executionProfiles: readonly string[];
	readonly availableSlots: number;
	readonly cpuPressure: number;
	readonly memoryPressure: number;
	readonly estimatedCostUsd?: number;
}

/** Local operator policy. A task can narrow this authority but cannot widen it. */
export interface PlacementPolicy {
	/** Requires an explicit local operator setting, even if a task permits active machines. */
	readonly allowActiveInteractiveNodes?: boolean;
	readonly requireFreshPresence?: boolean;
}

export type PlacementRejectionCode =
	| "draining"
	| "unhealthy"
	| "stale_presence"
	| "no_available_slots"
	| "forbidden_node"
	| "interactive_node_protected"
	| "active_interactive_node_protected"
	| "trust_zone_exceeds_task_limit"
	| "missing_capabilities"
	| "execution_profile_unavailable"
	| "cost_ceiling_exceeded"
	| "cost_unknown";

export interface PlacementEvaluation {
	readonly nodeId: string;
	readonly eligible: boolean;
	readonly reasons: readonly PlacementRejectionCode[];
	readonly score?: number;
}

export interface PlacementDecision {
	readonly taskId: string;
	readonly selectedNodeId?: string;
	readonly placementReason: readonly string[];
	readonly evaluations: readonly PlacementEvaluation[];
}

export interface PlacementRequest {
	readonly task: TaskContractV1;
	readonly nodes: readonly PlacementNode[];
	readonly nowEpochMs: number;
	readonly policy?: PlacementPolicy;
}

const EXPOSURE_RANK: Readonly<Record<TrustZone, number>> = Object.freeze({
	// Local is the highest-trust zone. Increasing values are increasingly exposed.
	local: 0,
	private: 1,
	partner: 2,
	public: 3,
});

function freezeStrings(values: readonly string[]): readonly string[] {
	return Object.freeze([...values]);
}

function stableUnique(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values)].sort());
}

function compareNodeIds(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function finiteNumber(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback;
}

function hasExpiredPresence(node: PlacementNode, nowEpochMs: number): boolean {
	const expiresAt = Date.parse(node.expiresAt);
	return !Number.isFinite(expiresAt) || expiresAt <= nowEpochMs;
}

function isCapabilityMismatch(task: TaskContractV1, node: PlacementNode): boolean {
	const available = new Set(node.capabilities);
	return (task.routing.requiredCapabilities ?? []).some(capability => !available.has(capability));
}

function profileUnavailable(task: TaskContractV1, node: PlacementNode): boolean {
	const profileId = task.execution.profileId;
	return typeof profileId === "string" && profileId.length > 0 && !node.executionProfiles.includes(profileId);
}

function taskDisallowsNode(task: TaskContractV1, node: PlacementNode): boolean {
	return (task.routing.forbiddenNodes ?? []).includes(node.nodeId);
}

function exceedsTrustZone(task: TaskContractV1, node: PlacementNode): boolean {
	const maximumExposure = task.routing.trustZoneMin;
	return maximumExposure !== undefined && EXPOSURE_RANK[node.trustZone] > EXPOSURE_RANK[maximumExposure];
}

function costCode(task: TaskContractV1, node: PlacementNode): PlacementRejectionCode | undefined {
	const ceiling = task.routing.costCeilingUsd;
	if (ceiling === undefined) return undefined;
	if (node.estimatedCostUsd === undefined || !Number.isFinite(node.estimatedCostUsd)) return "cost_unknown";
	return node.estimatedCostUsd > ceiling ? "cost_ceiling_exceeded" : undefined;
}

function scoreNode(task: TaskContractV1, node: PlacementNode): number {
	const preferred = new Set(task.routing.preferredNodes ?? []);
	const preferencePenalty = preferred.has(node.nodeId) ? 0 : 1_000_000;
	const cpuPenalty = Math.round(Math.min(1, Math.max(0, finiteNumber(node.cpuPressure, 1))) * 10_000);
	const memoryPenalty = Math.round(Math.min(1, Math.max(0, finiteNumber(node.memoryPressure, 1))) * 10_000);
	const costPenalty = Math.round(Math.max(0, finiteNumber(node.estimatedCostUsd ?? 0, 1_000_000)) * 100);
	return preferencePenalty + cpuPenalty + memoryPenalty + costPenalty;
}

function evaluateNode(request: PlacementRequest, node: PlacementNode): PlacementEvaluation {
	const { policy, task } = request;
	const reasons: PlacementRejectionCode[] = [];
	if (node.draining) reasons.push("draining");
	if (!node.healthy) reasons.push("unhealthy");
	if (policy?.requireFreshPresence !== false && hasExpiredPresence(node, request.nowEpochMs)) reasons.push("stale_presence");
	if (!Number.isFinite(node.availableSlots) || node.availableSlots < 1) reasons.push("no_available_slots");
	if (taskDisallowsNode(task, node)) reasons.push("forbidden_node");
	if (node.interactive && task.routing.activeMachineAllowed !== true) reasons.push("interactive_node_protected");
	if (node.activeInteractiveUser && policy?.allowActiveInteractiveNodes !== true) {
		reasons.push("active_interactive_node_protected");
	}
	if (exceedsTrustZone(task, node)) reasons.push("trust_zone_exceeds_task_limit");
	if (isCapabilityMismatch(task, node)) reasons.push("missing_capabilities");
	if (profileUnavailable(task, node)) reasons.push("execution_profile_unavailable");
	const nodeCostCode = costCode(task, node);
	if (nodeCostCode) reasons.push(nodeCostCode);

	const stableReasons = stableUnique(reasons);
	return Object.freeze({
		nodeId: node.nodeId,
		eligible: stableReasons.length === 0,
		reasons: stableReasons,
		score: stableReasons.length === 0 ? scoreNode(task, node) : undefined,
	});
}

/**
 * Pure, deterministic placement. It neither acquires a lease nor emits an
 * event: the durable orchestrator performs those authority-bearing actions
 * after it accepts this recommendation.
 */
export function placeTask(request: PlacementRequest): PlacementDecision {
	const evaluations = request.nodes.map(node => evaluateNode(request, node));
	const candidates = evaluations
		.filter((evaluation): evaluation is PlacementEvaluation & { readonly score: number } => evaluation.eligible)
		.sort((left, right) => left.score - right.score || compareNodeIds(left.nodeId, right.nodeId));
	const selected = candidates[0];
	const selectedNode = selected ? request.nodes.find(node => node.nodeId === selected.nodeId) : undefined;
	const placementReason = selected
		? [
				"eligible_capability_match",
				request.task.routing.preferredNodes?.includes(selected.nodeId)
					? "preferred_node"
					: "lowest_deterministic_score",
				`score:${selected.score}`,
			]
		: ["no_eligible_node"];

	return Object.freeze({
		taskId: request.task.taskId,
		selectedNodeId: selectedNode?.nodeId,
		placementReason: freezeStrings(placementReason),
		evaluations: Object.freeze([...evaluations].sort((left, right) => compareNodeIds(left.nodeId, right.nodeId))),
	});
}
