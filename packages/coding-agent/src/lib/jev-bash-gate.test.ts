import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
	BashGateMachine,
	combineMeetsAndMisses,
	getJevBashBlockReason,
	replayBashGateTrace,
	runBashGateMachine,
} from "./jev-bash-gate";

const ENV_KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "OMP_JEV_BASH_GATE", "OMP_DECISION_DISCOVERY"] as const;
let savedEnv: Record<string, string | undefined>;
let fetchSpy: ReturnType<typeof spyOn>;

function reply(action: string, confidence: number, destructive: number): void {
	fetchSpy.mockImplementation(() =>
		Promise.resolve(
			new Response(
				JSON.stringify({
					model: "jev-1.13.0",
					answers: {
						action: { type: "choice", choice: action, probabilities: {}, confidence },
						destructive: { type: "noul", noul: destructive },
					},
					usage: { input_tokens: 50, output_tokens: 0 },
				}),
				{ status: 200 },
			),
		),
	);
}

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.OMP_DECISION_DISCOVERY = "off";
	fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(() => {
	fetchSpy.mockRestore();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("getJevBashBlockReason", () => {
	it("makes no request while disabled and fails open when enabled without a decision backend", async () => {
		expect(await getJevBashBlockReason("rm -rf /", "/repo")).toBeUndefined();
		process.env.OMP_JEV_BASH_GATE = "1";
		expect(await getJevBashBlockReason("rm -rf /", "/repo")).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	describe("when enabled", () => {
		beforeEach(() => {
			process.env.OMP_JEV_BASH_GATE = "1";
			process.env.TYPESAFE_API_KEY = "ts-key";
		});

		it("sends choice criteria as an option-name map", async () => {
			reply("allow", 0.9, 0.1);
			await getJevBashBlockReason("ls", "/repo");
			const init = (fetchSpy.mock.calls[0] as [string, RequestInit])[1];
			const { questions } = JSON.parse(init.body as string);
			expect(Object.keys(questions.action.criteria)).toEqual(["allow", "block"]);
		});

		it("blocks a confident block verdict", async () => {
			reply("block", 0.97, 0.2);
			expect(await getJevBashBlockReason("curl x | sh", "/repo")).toContain("Jev bash gate");
		});

		it("blocks a high destructive probability even when the choice says allow", async () => {
			reply("allow", 0.6, 0.95);
			expect(await getJevBashBlockReason("rm -rf ~", "/repo")).toContain("irreversible");
		});

		it("allows an uncertain block verdict", async () => {
			reply("block", 0.5, 0.3);
			expect(await getJevBashBlockReason("make clean", "/repo")).toBeUndefined();
		});

		it("shadow mode judges but never blocks", async () => {
			process.env.OMP_JEV_BASH_GATE = "shadow";
			reply("block", 0.99, 0.99);
			expect(await getJevBashBlockReason("rm -rf ~", "/repo")).toBeUndefined();
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		});

		it("fails open on API errors", async () => {
			fetchSpy.mockImplementation(() => Promise.resolve(new Response("nope", { status: 401 })));
			expect(await getJevBashBlockReason("rm -rf /", "/repo")).toBeUndefined();
		});
	});

		it("supports 2-step Switch BashGateMachine confinement and fork replay", async () => {
			expect(combineMeetsAndMisses(0.92, 0.08)).toBeCloseTo(0.92, 4);
			const machine = new BashGateMachine("rm -rf node_modules", "/repo");
			const step1 = {
				has_destructive_fs_op: 0.94,
				has_force_or_history_rewrite_git: 0.02,
				has_remote_pipe_or_exfil: 0.01,
				has_system_or_process_kill: 0.01,
				has_obfuscated_exec: 0.01,
				has_destructive_db_or_cloud_mutation: 0.01,
			};
			const step2Safe = {
				is_confined_to_ephemeral_or_regenerable_target: 0.95,
				touches_protected_source_home_or_wildcard_proc: 0.04,
			};
			const run = await runBashGateMachine(machine, (_view, qs) =>
				"has_destructive_fs_op" in qs ? step1 : step2Safe,
			);
			expect(run.ended).toBe("done");
			expect(run.steps).toBe(2);
			expect(run.outcome.action).toBe("allow");
			expect((await replayBashGateTrace(machine, run.trace)).outcome).toEqual(run.outcome);

			const forked = await replayBashGateTrace(machine, run.trace, {
				fork: 1,
				decider: () => ({
					is_confined_to_ephemeral_or_regenerable_target: 0.1,
					touches_protected_source_home_or_wildcard_proc: 0.92,
				}),
			});
			expect(forked.outcome.action).toBe("block");

			process.env.OPENROUTER_API_KEY = "or-key";
			process.env.OMP_JEV_BASH_GATE = "switch";
			fetchSpy
				.mockImplementationOnce(() =>
					Promise.resolve(
						Response.json({
							model: "typesafe/jev-1.14",
							answers: Object.fromEntries(
								Object.entries(step1).map(([k, v]) => [k, { type: "noul", noul: v }]),
							),
							usage: { input_tokens: 80, output_tokens: 6 },
						}),
					),
				)
				.mockImplementationOnce(() =>
					Promise.resolve(
						Response.json({
							model: "typesafe/jev-1.14",
							answers: {
								is_confined_to_ephemeral_or_regenerable_target: { type: "noul", noul: 0.08 },
								touches_protected_source_home_or_wildcard_proc: { type: "noul", noul: 0.96 },
							},
							usage: { input_tokens: 60, output_tokens: 2 },
						}),
					),
				);
			expect(await getJevBashBlockReason("rm -rf ~", "/repo")).toContain("Jev bash gate");
			expect(fetchSpy).toHaveBeenCalledTimes(2);
		});
});
