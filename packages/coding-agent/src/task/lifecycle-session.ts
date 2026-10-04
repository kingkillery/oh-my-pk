import type { Settings } from "../config/settings";
import { resolveCollaborationPolicy } from "../orchestration/collaboration-policy";
import {
	createHostRootExecutionContext,
	getLifecycleRegistration,
	type LifecycleExecutionContext,
	type RootExecutionContext,
} from "../orchestration/lifecycle-authority";
import type { SessionManager } from "../session/session-manager";
import type { ToolCapability } from "../tools/tool-profiles";
import type { AuthorityEnvelopeV1, RunLimitsV1 } from "./launch-contract";

export const LIFECYCLE_SESSION_ENTRY = "lifecycle-launch-binding-v1";

export interface LifecycleSessionRef {
	readonly bindingId: string;
	readonly contractDigest: string;
	readonly policyEpoch: number;
}

/** Session metadata is a locator only. This foreground slice refuses persisted restoration. */
export function lifecycleSessionRef(sessionManager: SessionManager): LifecycleSessionRef | undefined {
	const entry = sessionManager
		.getEntries()
		.findLast(item => item.type === "custom" && item.customType === LIFECYCLE_SESSION_ENTRY);
	if (entry?.type !== "custom") return undefined;
	const data = entry.data;
	if (
		!data ||
		typeof data !== "object" ||
		!("bindingId" in data) ||
		typeof data.bindingId !== "string" ||
		!("contractDigest" in data) ||
		typeof data.contractDigest !== "string" ||
		!("policyEpoch" in data) ||
		typeof data.policyEpoch !== "number"
	)
		throw new Error("invalid_lifecycle_session_binding: persisted launch locator is malformed");
	return { bindingId: data.bindingId, contractDigest: data.contractDigest, policyEpoch: data.policyEpoch };
}

/** Root authority is host policy plus the concrete source-qualified catalog visible at creation. */
export function createLifecycleRootIssuer(
	sessionId: string,
	settings: Settings,
	capabilities: readonly ToolCapability[],
): RootExecutionContext {
	const principalId = `principal-root-${sessionId}`;
	const maxChildren = Math.max(1, settings.get("task.maxConcurrency") || 32);
	const maxDepth = Math.max(0, settings.get("task.maxRecursionDepth") ?? 2);
	const limits: RunLimitsV1 = {
		schemaVersion: 1,
		maxNodes: maxChildren,
		maxDepth,
		maxAttemptsPerNode: 4,
		maxOutstanding: maxChildren,
		maxActiveCompute: maxChildren,
		maxRequests: 0,
		maxRuntimeMs: 0,
		maxComputeRuntimeMs: 0,
		maxTokens: null,
		maxCostMicrounits: null,
		currency: null,
		maxHandoffBytes: 1_048_576,
		maxInboxEvents: 256,
	};
	const authority: AuthorityEnvelopeV1 = {
		schemaVersion: 1,
		usableCapabilities: capabilities,
		delegableCapabilities: capabilities,
		resources: [],
		collaboration: {
			policy: resolveCollaborationPolicy({ mode: "self-coordinate" }),
			visiblePrincipalIds: [principalId],
			sendPrincipalIds: [principalId],
			receivePrincipalIds: [principalId],
			wakePrincipalIds: [],
			broadcastPrincipalIds: [],
			busyReplyPrincipalIds: [],
			controlPrincipalIds: [],
			delegablePrincipalIds: [],
			channelIds: [],
		},
		spawn: {
			maySpawn: true,
			mayDelegateSpawn: false,
			allowedAgentTypes: ["*"],
			allowedLaunchClasses: ["legacy-compatible-worker"],
			maxDepth,
			maxChildren,
			delegableResourceGrantIds: [],
		},
		budget: {
			kind: "legacy",
			zeroMeansUnlimited: true,
			authorityRef: "host-root-policy",
			limits,
			reservation: { requests: 0, runtimeMs: 0, tokens: null, costMicrounits: null },
		},
		result: {
			outputSchemaRef: null,
			maxOutputBytes: 1_048_576,
			requiredCriterionIds: [],
			publicationRequired: false,
			mutation: {
				schemaVersion: 1,
				apply: true,
				allowCommit: false,
				allowPush: false,
				allowMerge: false,
				approvalRef: null,
			},
			publicationGrantIds: [],
			acceptedRecipientPrincipalIds: [principalId],
		},
	};
	return createHostRootExecutionContext({
		sessionId,
		policy: { role: "root-planner", topology: "hierarchical" },
		authority,
	});
}

export function lifecycleRefOf(context: LifecycleExecutionContext): LifecycleSessionRef {
	const authority = getLifecycleRegistration(context)?.authority;
	if (!authority) throw new Error("missing_lifecycle_session_binding: context has no persisted binding");
	return {
		bindingId: authority.bindingId,
		contractDigest: authority.contractDigest,
		policyEpoch: authority.policyEpoch,
	};
}
