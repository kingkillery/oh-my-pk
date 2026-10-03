import type { TaskContractV1 } from "@pk-nerdsaver-ai/mesh-contracts";

export type ModelWorkloadRole = "planner" | "coding" | "review" | "inference" | "utility";

/** Sanitized handoff to the already-authoritative OMPK model router. */
export interface OmpkModelRouteRequest {
	readonly taskId: string;
	readonly taskDigest: string;
	readonly nodeId: string;
	readonly workloadRole: ModelWorkloadRole;
	readonly requestedModel?: string;
}

export type OmpkModelRouteResolution =
	| {
			readonly status: "selected";
			readonly providerId: string;
			readonly modelId: string;
			readonly selectionSource: string;
			readonly policyRevision: string;
		}
	| {
			readonly status: "unavailable";
			readonly reason: string;
			readonly policyRevision: string;
		};

/** OMPK remains the only component that interprets model policy and provider availability. */
export interface OmpkModelRouteDelegate {
	resolve(request: OmpkModelRouteRequest, signal: AbortSignal): Promise<OmpkModelRouteResolution>;
}

export interface ModelRouteRequest {
	readonly task: TaskContractV1;
	readonly nodeId: string;
	readonly workloadRole: ModelWorkloadRole;
	readonly requestedModel?: string;
	readonly decidedAt: string;
}

export interface ModelRouteProvenance {
	readonly authority: "ompk-model-router";
	readonly selectionSource?: string;
	readonly policyRevision: string;
	readonly decidedAt: string;
}

export type ModelRouteDecision =
	| {
			readonly status: "selected";
			readonly taskId: string;
			readonly taskDigest: string;
			readonly nodeId: string;
			readonly workloadRole: ModelWorkloadRole;
			readonly providerId: string;
			readonly modelId: string;
			readonly provenance: ModelRouteProvenance;
		}
	| {
			readonly status: "unavailable";
			readonly taskId: string;
			readonly taskDigest: string;
			readonly nodeId: string;
			readonly workloadRole: ModelWorkloadRole;
			readonly reason: string;
			readonly provenance: ModelRouteProvenance;
		};

export interface ModelRouteBroker {
	route(request: ModelRouteRequest, signal: AbortSignal): Promise<ModelRouteDecision>;
}

function freezeProvenance(
	resolution: OmpkModelRouteResolution,
	decidedAt: string,
): ModelRouteProvenance {
	if (resolution.status === "selected") {
		return Object.freeze({
			authority: "ompk-model-router" as const,
			selectionSource: resolution.selectionSource,
			policyRevision: resolution.policyRevision,
			decidedAt,
		});
	}
	return Object.freeze({
		authority: "ompk-model-router" as const,
		policyRevision: resolution.policyRevision,
		decidedAt,
	});
}

/**
 * The broker records a model selection receipt without trying to choose a
 * model itself. An unavailable delegate decision stays unavailable; it never
 * silently falls through to a different provider.
 */
export function createModelRouteBroker(delegate: OmpkModelRouteDelegate): ModelRouteBroker {
	return Object.freeze({
		async route(request: ModelRouteRequest, signal: AbortSignal): Promise<ModelRouteDecision> {
			const resolution = await delegate.resolve(
				Object.freeze({
					taskId: request.task.taskId,
					taskDigest: request.task.digest,
					nodeId: request.nodeId,
					workloadRole: request.workloadRole,
					requestedModel: request.requestedModel,
				}),
				signal,
			);
			const base = {
				taskId: request.task.taskId,
				taskDigest: request.task.digest,
				nodeId: request.nodeId,
				workloadRole: request.workloadRole,
				provenance: freezeProvenance(resolution, request.decidedAt),
			};
			if (resolution.status === "selected") {
				return Object.freeze({
					status: "selected" as const,
					...base,
					providerId: resolution.providerId,
					modelId: resolution.modelId,
				});
			}
			return Object.freeze({
				status: "unavailable" as const,
				...base,
				reason: resolution.reason,
			});
		},
	});
}
