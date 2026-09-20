/**
 * Topology and Role Policy (A03).
 *
 * Implements the role authority model and topology resolution:
 * - Topologies: "hierarchical" (opt-in until rollout acceptance), "legacy" (default), "direct".
 * - Roles: "root-planner", "subplanner", "worker" (leaf), "verifier".
 * - Authority boundaries (Section 3 of Revamp Plan & Decision D03):
 *     * root-planner: owns user objective, decomposition, cross-scope decisions; may spawn subplanners/workers.
 *     * subplanner: owns delegated outcome; may spawn children only within parent scope and budgets.
 *     * worker (leaf): bounded mission with appropriate tools; CANNOT spawn agents, broadcast, list siblings,
 *       wake peers, change ownership, or promote itself. Escalate to owning planner instead.
 *     * verifier: checks candidate & evidence contract; CANNOT edit candidate or weaken acceptance criteria.
 */

import type { AgentRole, TopologyKind } from "../task/launch-contract";

export type RoleAuthorityErrorCode =
	| "unknown_role"
	| "leaf_delegation_denied"
	| "leaf_peer_authority_denied"
	| "leaf_self_promotion_denied"
	| "verifier_mutation_denied"
	| "verifier_acceptance_denied"
	| "invalid_role_transition"
	| "subplanner_scope_escape"
	| "unauthorized_action";

export interface RoleAuthorityViolation {
	readonly code: RoleAuthorityErrorCode;
	readonly role: AgentRole;
	readonly action: string;
	readonly message: string;
}

export type RoleAuthorityCheckResult =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly violation: RoleAuthorityViolation };

export interface TopologyPolicyConfig {
	readonly defaultTopology?: TopologyKind;
	readonly allowedTopologies?: readonly TopologyKind[];
}

export const DEFAULT_TOPOLOGY_CONFIG: TopologyPolicyConfig = Object.freeze({
	defaultTopology: "legacy",
	allowedTopologies: Object.freeze(["hierarchical", "legacy", "direct"] as const),
});

export type TopologyResolutionResult =
	| { readonly ok: true; readonly topology: TopologyKind }
	| {
			readonly ok: false;
			readonly code: "invalid_topology" | "topology_not_allowed" | "conflicting_topology_request";
			readonly message: string;
	  };

const KNOWN_TOPOLOGIES: Record<string, true> = {
	hierarchical: true,
	legacy: true,
	direct: true,
};

const KNOWN_ROLES: Record<AgentRole, true> = {
	"root-planner": true,
	subplanner: true,
	worker: true,
	verifier: true,
};

/**
 * Resolves the effective topology for a run, honoring explicit overrides,
 * configuration, and returning typed diagnostics for invalid inputs.
 * Precedence:
 * 1. Validated recorded run policy (historicalPolicy)
 * 2. Explicit authorized request (requestedTopology)
 * 3. Explicit direct/no-delegation (isMultiAgent === false)
 * 4. Configured default topology (config.defaultTopology ?? "legacy")
 */
export function resolveTopologyKind(options?: {
	readonly requestedTopology?: string;
	readonly isMultiAgent?: boolean;
	readonly config?: TopologyPolicyConfig;
	readonly historicalPolicy?: TopologyKind;
}): TopologyResolutionResult {
	const allowed = options?.config?.allowedTopologies ??
		DEFAULT_TOPOLOGY_CONFIG.allowedTopologies ?? ["hierarchical", "legacy", "direct"];

	if (options?.historicalPolicy) {
		if (!allowed.includes(options.historicalPolicy)) {
			return {
				ok: false,
				code: "topology_not_allowed",
				message: `Historical topology '${options.historicalPolicy}' is not permitted by current policy.`,
			};
		}
		return { ok: true, topology: options.historicalPolicy };
	}

	if (options?.requestedTopology === "hierarchical" && options?.isMultiAgent === false) {
		return {
			ok: false,
			code: "conflicting_topology_request",
			message:
				"Simultaneous direct (isMultiAgent: false) and explicit hierarchical topology request is conflicting.",
		};
	}

	const requested = options?.requestedTopology;
	if (requested !== undefined) {
		if (!KNOWN_TOPOLOGIES[requested]) {
			return {
				ok: false,
				code: "invalid_topology",
				message: `Requested topology '${requested}' is not a valid TopologyKind.`,
			};
		}
		const kind = requested as TopologyKind;
		if (!allowed.includes(kind)) {
			return {
				ok: false,
				code: "topology_not_allowed",
				message: `Requested topology '${requested}' is not in the allowed topologies set.`,
			};
		}
		return { ok: true, topology: kind };
	}

	if (options?.isMultiAgent === false) {
		return { ok: true, topology: "direct" };
	}

	const def = options?.config?.defaultTopology ?? "legacy";
	return { ok: true, topology: def };
}

export type AuthorizedCapabilityAction =
	| "invoke_tool"
	| "read_resource"
	| "write_resource"
	| "spawn_agent"
	| "peer_message"
	| "list_peers"
	| "peer_wake"
	| "peer_broadcast"
	| "change_owner"
	| "change_role"
	| "mutate_target"
	| "modify_acceptance"
	| "publish"
	| "request_completion"
	| "escalate_owner";

const KNOWN_ACTIONS: Record<AuthorizedCapabilityAction, true> = {
	invoke_tool: true,
	read_resource: true,
	write_resource: true,
	spawn_agent: true,
	peer_message: true,
	list_peers: true,
	peer_wake: true,
	peer_broadcast: true,
	change_owner: true,
	change_role: true,
	mutate_target: true,
	modify_acceptance: true,
	publish: true,
	request_completion: true,
	escalate_owner: true,
};

/**
 * Checks whether an agent with a given role has authority to perform a target action.
 * Fails closed on unknown roles or disallowed actions.
 */
export function checkRoleAuthority(role: AgentRole, action: AuthorizedCapabilityAction): RoleAuthorityCheckResult {
	if (!KNOWN_ROLES[role]) {
		return {
			allowed: false,
			violation: {
				code: "unknown_role",
				role,
				action,
				message: `Role '${role}' is not a recognized AgentRole.`,
			},
		};
	}

	if (!KNOWN_ACTIONS[action]) {
		return {
			allowed: false,
			violation: {
				code: "unauthorized_action",
				role,
				action,
				message: `Action '${String(action)}' is not recognized.`,
			},
		};
	}
	switch (role) {
		case "worker": {
			if (action === "spawn_agent") {
				return {
					allowed: false,
					violation: {
						code: "leaf_delegation_denied",
						role,
						action,
						message: "Leaf worker cannot spawn subagents. Escalate to the owning planner instead.",
					},
				};
			}
			if (
				action === "peer_message" ||
				action === "list_peers" ||
				action === "peer_wake" ||
				action === "peer_broadcast"
			) {
				return {
					allowed: false,
					violation: {
						code: "leaf_peer_authority_denied",
						role,
						action,
						message: `Leaf worker cannot perform peer action '${action}'.`,
					},
				};
			}
			if (
				action === "change_owner" ||
				action === "change_role" ||
				action === "modify_acceptance" ||
				action === "publish"
			) {
				return {
					allowed: false,
					violation: {
						code: "leaf_self_promotion_denied",
						role,
						action,
						message: `Leaf worker cannot perform administrative or self-promotion action '${action}'.`,
					},
				};
			}
			return { allowed: true };
		}

		case "verifier": {
			if (action === "spawn_agent") {
				return {
					allowed: false,
					violation: {
						code: "leaf_delegation_denied",
						role,
						action,
						message: "Verifier cannot spawn subagents.",
					},
				};
			}
			if (action === "mutate_target") {
				return {
					allowed: false,
					violation: {
						code: "verifier_mutation_denied",
						role,
						action,
						message: "Verifier cannot edit the candidate under verification.",
					},
				};
			}
			if (action === "modify_acceptance") {
				return {
					allowed: false,
					violation: {
						code: "verifier_acceptance_denied",
						role,
						action,
						message: "Verifier cannot alter or weaken mission acceptance criteria.",
					},
				};
			}
			if (
				action === "peer_message" ||
				action === "list_peers" ||
				action === "peer_wake" ||
				action === "peer_broadcast"
			) {
				return {
					allowed: false,
					violation: {
						code: "leaf_peer_authority_denied",
						role,
						action,
						message: `Verifier cannot perform peer action '${action}'.`,
					},
				};
			}
			if (action === "change_owner" || action === "change_role" || action === "publish") {
				return {
					allowed: false,
					violation: {
						code: "leaf_self_promotion_denied",
						role,
						action,
						message: `Verifier cannot perform administrative or publication action '${action}'.`,
					},
				};
			}
			return { allowed: true };
		}

		case "subplanner": {
			if (
				action === "modify_acceptance" ||
				action === "change_owner" ||
				action === "change_role" ||
				action === "publish"
			) {
				return {
					allowed: false,
					violation: {
						code: "subplanner_scope_escape",
						role,
						action,
						message: `Subplanner cannot perform root-only action '${action}'.`,
					},
				};
			}
			return { allowed: true };
		}

		case "root-planner": {
			return { allowed: true };
		}
	}
}
