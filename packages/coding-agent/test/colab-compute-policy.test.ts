import { expect, test } from "bun:test";
import { launchApprovedColab } from "../../../scripts/colab-compute";
import { parseComputeAccount } from "../src/slash-commands/helpers/colab-compute-identity";
import {
	assertComputeLease,
	ColabComputePolicy,
	type ComputeRequest,
	computeMinutes,
} from "../src/slash-commands/helpers/colab-compute-policy";

const request: ComputeRequest = {
	taskId: "fixture-task",
	account: "fixture@example.test",
	model: "fixture-model",
	accelerator: "T4",
	sessionName: "fixture-session",
};
const arm = async (_session: string, cutoffAt: string) => ({ cutoffAt });
test("asks by default, absent UI and denial make no allocation or guard changes", async () => {
	for (const confirm of [undefined, async () => "deny" as const]) {
		const calls: string[] = [];
		await expect(
			launchApprovedColab(request, {
				policy: new ColabComputePolicy(),
				confirm,
				arm: async (s, c) => {
					calls.push("arm");
					return arm(s, c);
				},
				run: async args => {
					calls.push(args[0]!);
					return { exitCode: 0, stdout: "Session 'fixture-session' not found.", stderr: "" };
				},
			}),
		).rejects.toThrow("explicit user approval");
		expect(calls).toEqual(["status"]);
	}
});
test("approved CLI launch arms exact cutoff before allocation; no provider or hardware fallback", async () => {
	const now = 1000000;
	const policy = new ColabComputePolicy(() => now);
	const calls: string[] = [];
	const result = await launchApprovedColab(request, {
		policy,
		confirm: async () => {
			calls.push("confirm");
			return "once";
		},
		arm: async (s, c) => {
			calls.push("arm");
			return arm(s, c);
		},
		run: async args => {
			calls.push(args[0]!);
			expect(args).not.toContain("A100");
			return {
				exitCode: 0,
				stdout: args[0] === "status" ? "Session 'fixture-session' not found." : "Hardware: T4",
				stderr: "",
			};
		},
	});
	expect(calls).toEqual(["status", "confirm", "arm", "new"]);
	expect(result.cutoffAt).toBe(new Date(now + 55 * 60000).toISOString());
	expect(result.hardDeadlineAt).toBe(new Date(now + 60 * 60000).toISOString());
});
test("experiment retries and relaunches share one deadline; scope changes ask again", async () => {
	let now = 1000000;
	let prompts = 0;
	const policy = new ColabComputePolicy(() => now);
	const confirm = async () => {
		prompts++;
		return "window" as const;
	};
	const first = await policy.authorize(request, confirm, arm);
	now += 60000;
	expect(await policy.authorize(request, confirm, arm)).toBe(first);
	expect(() => policy.confirmReleased(first, false)).toThrow("not confirmed");
	policy.confirmReleased(first, true);
	const second = await policy.authorize({ ...request, sessionName: "retry" }, confirm, arm);
	expect(second.hardDeadlineAt).toBe(first.hardDeadlineAt);
	expect(prompts).toBe(1);
	policy.confirmReleased(second, true);
	await policy.authorize({ ...request, model: "another-model" }, confirm, arm);
	expect(prompts).toBe(2);
});
test("120-minute ceiling, expiry, forged records and mismatching guard fail closed", async () => {
	expect(computeMinutes()).toBe(60);
	expect(computeMinutes(120)).toBe(120);
	for (const n of [121, 240, NaN, Infinity, 0, 59.5]) expect(() => computeMinutes(n)).toThrow();
	let now = 1000000;
	const policy = new ColabComputePolicy(() => now);
	await expect(
		policy.authorize(
			request,
			async () => "once",
			async () => ({ cutoffAt: new Date(now + 1).toISOString() }),
		),
	).rejects.toThrow("immutable deadline");
	const lease = await policy.authorize(request, async () => "once", arm);
	expect(() => assertComputeLease({ ...lease }, request, now)).toThrow();
	expect(() => assertComputeLease(lease, { ...request, account: "different" }, now)).toThrow();
	now = Date.parse(lease.cutoffAt);
	expect(() => assertComputeLease(lease, request, now)).toThrow("expired");
});
test("concurrency is one and incompatible existing runtimes are not allocated over", async () => {
	const policy = new ColabComputePolicy();
	await policy.authorize(request, async () => "window", arm);
	await expect(policy.authorize({ ...request, sessionName: "parallel" }, async () => "once", arm)).rejects.toThrow(
		"concurrency",
	);
	const calls: string[] = [];
	expect(
		await launchApprovedColab(request, {
			policy,
			arm,
			run: async args => {
				calls.push(args[0]!);
				return { exitCode: 0, stdout: "Hardware: T4", stderr: "" };
			},
		}),
	).toEqual({ reused: true });
	expect(calls).toEqual(["status"]);
});
test("unknown allocation outcome never retries on another accelerator", async () => {
	const calls: string[] = [];
	await expect(
		launchApprovedColab(request, {
			policy: new ColabComputePolicy(),
			arm,
			confirm: async () => "once",
			run: async args => {
				calls.push(args[0]!);
				return {
					exitCode: args[0] === "status" ? 0 : 1,
					stdout: "Session 'fixture-session' not found.",
					stderr: "",
				};
			},
		}),
	).rejects.toThrow("original cutoff");
	expect(calls).toEqual(["status", "new"]);
});

test("identity parsing requires an explicit email field, never a substring or arbitrary mention", () => {
	expect(parseComputeAccount('{"email":"Owner@Example.test"}')).toBe("owner@example.test");
	expect(parseComputeAccount("Email: owner@example.test\nScopes: read")).toBe("owner@example.test");
	expect(() => parseComputeAccount("unrelated owner@example.test in a log")).toThrow("identity");
});

test("relaunch re-verifies original guard and never accepts a changed cutoff", async () => {
	let now = 1000000;
	const policy = new ColabComputePolicy(() => now);
	const first = await policy.authorize(request, async () => "window", arm);
	now += 60000;
	await expect(
		policy.authorize(request, undefined, async () => ({ cutoffAt: new Date(now + 60 * 60000).toISOString() })),
	).rejects.toThrow("original deadline");
	policy.confirmReleased(first, true);
	now = Date.parse(first.hardDeadlineAt) + 1;
	let prompts = 0;
	await policy.authorize(
		request,
		async () => {
			prompts++;
			return "once";
		},
		arm,
	);
	expect(prompts).toBe(1);
});

test("deadline expiry alone is never proof that a cloud runtime was released", async () => {
	let now = 1000000;
	const policy = new ColabComputePolicy(() => now);
	const first = await policy.authorize(request, async () => "window", arm);
	now = Date.parse(first.hardDeadlineAt) + 60000;
	await expect(policy.authorize({ ...request, sessionName: "other" }, async () => "once", arm)).rejects.toThrow(
		"Confirm release",
	);
	policy.confirmReleased(first, true);
	await expect(policy.authorize({ ...request, sessionName: "other" }, async () => "once", arm)).resolves.toBeDefined();
});
