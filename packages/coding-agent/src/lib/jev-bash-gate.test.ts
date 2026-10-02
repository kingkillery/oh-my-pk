import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { getJevBashBlockReason } from "./jev-bash-gate";

const ENV_KEYS = [
	"TYPESAFE_API_KEY",
	"OPENROUTER_API_KEY",
	"OMP_JEV_BASH_GATE",
	"OMP_DECISION_DISCOVERY",
] as const;
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
});
