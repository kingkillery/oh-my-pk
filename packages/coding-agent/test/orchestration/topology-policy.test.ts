import { describe, expect, it } from "bun:test";
import { checkRoleAuthority, resolveTopologyKind } from "../../src/orchestration/topology-policy";

describe("Topology and Role Policy (A03)", () => {
	it("resolves historical policy as top priority", () => {
		const res = resolveTopologyKind({
			historicalPolicy: "legacy",
			requestedTopology: "hierarchical",
		});
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.topology).toBe("legacy");
	});

	it("resolves requested topology when valid", () => {
		const res = resolveTopologyKind({
			requestedTopology: "hierarchical",
		});
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.topology).toBe("hierarchical");
	});

	it("rejects unknown requested topology", () => {
		const res = resolveTopologyKind({
			requestedTopology: "bogus-mesh",
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.code).toBe("invalid_topology");
	});

	it("resolves direct when multi-agent is false", () => {
		const res = resolveTopologyKind({
			isMultiAgent: false,
		});
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.topology).toBe("direct");
	});

	it("denies worker from spawning subagents", () => {
		const check = checkRoleAuthority("worker", "spawn_agent");
		expect(check.allowed).toBe(false);
		if (!check.allowed) {
			expect(check.violation.code).toBe("leaf_delegation_denied");
		}
	});

	it("denies worker from peer messaging or self-promotion", () => {
		const peerCheck = checkRoleAuthority("worker", "peer_message");
		expect(peerCheck.allowed).toBe(false);
		if (!peerCheck.allowed) {
			expect(peerCheck.violation.code).toBe("leaf_peer_authority_denied");
		}

		const promoCheck = checkRoleAuthority("worker", "change_role");
		expect(promoCheck.allowed).toBe(false);
		if (!promoCheck.allowed) {
			expect(promoCheck.violation.code).toBe("leaf_self_promotion_denied");
		}
	});

	it("denies verifier from mutating candidate or modifying acceptance", () => {
		const mutateCheck = checkRoleAuthority("verifier", "mutate_target");
		expect(mutateCheck.allowed).toBe(false);
		if (!mutateCheck.allowed) {
			expect(mutateCheck.violation.code).toBe("verifier_mutation_denied");
		}

		const acceptCheck = checkRoleAuthority("verifier", "modify_acceptance");
		expect(acceptCheck.allowed).toBe(false);
		if (!acceptCheck.allowed) {
			expect(acceptCheck.violation.code).toBe("verifier_acceptance_denied");
		}
	});

	it("returns conflicting_topology_request for simultaneous direct and hierarchical requests", () => {
		const res = resolveTopologyKind({
			requestedTopology: "hierarchical",
			isMultiAgent: false,
		});
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.code).toBe("conflicting_topology_request");
		}
	});

	it("denies verifier from publishing, changing role, or changing owner", () => {
		const pubCheck = checkRoleAuthority("verifier", "publish");
		expect(pubCheck.allowed).toBe(false);
		if (!pubCheck.allowed) expect(pubCheck.violation.code).toBe("leaf_self_promotion_denied");

		const roleCheck = checkRoleAuthority("verifier", "change_role");
		expect(roleCheck.allowed).toBe(false);
		if (!roleCheck.allowed) expect(roleCheck.violation.code).toBe("leaf_self_promotion_denied");

		const ownerCheck = checkRoleAuthority("verifier", "change_owner");
		expect(ownerCheck.allowed).toBe(false);
		if (!ownerCheck.allowed) expect(ownerCheck.violation.code).toBe("leaf_self_promotion_denied");
	});

	it("denies subplanner from publishing or changing role", () => {
		const pubCheck = checkRoleAuthority("subplanner", "publish");
		expect(pubCheck.allowed).toBe(false);
		if (!pubCheck.allowed) expect(pubCheck.violation.code).toBe("subplanner_scope_escape");

		const roleCheck = checkRoleAuthority("subplanner", "change_role");
		expect(roleCheck.allowed).toBe(false);
		if (!roleCheck.allowed) expect(roleCheck.violation.code).toBe("subplanner_scope_escape");
	});

	it("fails closed on unknown actions and unknown roles", () => {
		const unknownAction = checkRoleAuthority("worker", "unknown_bogus_action" as any);
		expect(unknownAction.allowed).toBe(false);
		if (!unknownAction.allowed) expect(unknownAction.violation.code).toBe("unauthorized_action");

		const unknownRole = checkRoleAuthority("super-admin" as any, "invoke_tool");
		expect(unknownRole.allowed).toBe(false);
		if (!unknownRole.allowed) expect(unknownRole.violation.code).toBe("unknown_role");
	});

	it("allows root-planner full coordination actions", () => {
		expect(checkRoleAuthority("root-planner", "spawn_agent").allowed).toBe(true);
		expect(checkRoleAuthority("root-planner", "mutate_target").allowed).toBe(true);
		expect(checkRoleAuthority("root-planner", "modify_acceptance").allowed).toBe(true);
		expect(checkRoleAuthority("root-planner", "publish").allowed).toBe(true);
	});
});
