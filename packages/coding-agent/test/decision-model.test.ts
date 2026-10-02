import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	buildClefRemoteBootstrap,
	launchClefDecisionModel,
	parseDecisionModelArgs,
	type DecisionModelLaunchRequest,
} from "../src/slash-commands/helpers/decision-model";

const SESSION = "ompk-clef-decision";
let savedTsAuthKey: string | undefined;

function request(overrides: Partial<DecisionModelLaunchRequest> = {}): DecisionModelLaunchRequest {
	return {
		action: "launch",
		accelerator: "T4",
		hostname: "clef-inference",
		model: "clef-flash",
		sessionName: SESSION,
		ttlMinutes: 60,
		...overrides,
	};
}

beforeEach(() => {
	savedTsAuthKey = process.env.TS_AUTHKEY;
	process.env.TS_AUTHKEY = "tskey-auth-test";
});

afterEach(() => {
	if (savedTsAuthKey === undefined) delete process.env.TS_AUTHKEY;
	else process.env.TS_AUTHKEY = savedTsAuthKey;
});

describe("decision-model command parsing", () => {
	it("defaults launch to Clef Flash on T4 with a 60-minute cutoff", () => {
		expect(parseDecisionModelArgs("launch")).toEqual(request());
	});

	it("accepts bounded TTL and accelerator overrides", () => {
		expect(parseDecisionModelArgs("launch --ttl 2h --gpu L4 --model clef")).toMatchObject({
			ttlMinutes: 120,
			accelerator: "L4",
			model: "clef",
		});
	});

	it("never permits a launch without a cutoff", () => {
		expect(() => parseDecisionModelArgs("launch --no-ttl")).toThrow("always require a natural shutoff timer");
		expect(() => parseDecisionModelArgs("launch --ttl 5m")).toThrow("10-240");
	});
});

describe("Clef bootstrap", () => {
	it("uses native SystemOne, private Tailscale Serve, and the Pillow repair", () => {
		const script = buildClefRemoteBootstrap(request(), "tskey-api-test");
		expect(script).toContain("/v1/systemone");
		expect(script).toContain("tailscale serve");
		expect(script).toContain("pillow==12.3.0");
		expect(script).toContain("api.tailscale.com/api/v2/tailnet/-/keys");
		expect(script).toContain("set +x");
		expect(script).not.toContain("echo $TS_AUTHKEY");
	});
});

describe("Clef launch lifecycle", () => {
	it("verifies the cutoff before allocating Colab compute", async () => {
		const events: string[] = [];
		let discoveryCalls = 0;
		const endpoint = {
			baseUrl: "https://clef-inference.example.ts.net/v1",
			healthUrl: "https://clef-inference.example.ts.net/healthz",
			identity: "tailscale:clef-inference:clef-flash",
			model: "clef-flash",
			source: "tailscale" as const,
		};
		const result = await launchClefDecisionModel(request(), {
			readState: async () => undefined,
			writeState: async () => {
				events.push("state");
			},
			removeState: async () => {
				events.push("remove-state");
			},
			discover: async () => {
				discoveryCalls++;
				return discoveryCalls === 1 ? undefined : endpoint;
			},
			armCutoff: async () => {
				events.push("arm");
				return { cutoffAt: "2026-10-02T22:00:00.000Z", scriptPath: "stop.ps1", taskName: "OMPK-Clef-test" };
			},
			runColab: async args => {
				const action = args[0] ?? "";
				events.push(action);
				if (action === "status") {
					return { exitCode: 0, stdout: "[colab] Session 'ompk-clef-decision' not found.", stderr: "" };
				}
				if (action === "new") return { exitCode: 0, stdout: "Hardware: T4", stderr: "" };
				if (action === "exec") return { exitCode: 0, stdout: "__OMPK_CLEF_READY__", stderr: "" };
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			cancelCutoff: async () => {
				events.push("cancel");
			},
			now: () => Date.parse("2026-10-02T21:00:00.000Z"),
		});

		expect(result.endpoint).toEqual(endpoint);
		expect(events.indexOf("arm")).toBeLessThan(events.indexOf("new"));
		expect(events).not.toContain("cancel");
	});

	it("retains the cutoff when failed setup cannot prove immediate release", async () => {
		const events: string[] = [];
		let statusCalls = 0;
		let cancelled = false;
		await expect(
			launchClefDecisionModel(request(), {
				readState: async () => undefined,
				writeState: async () => {
					events.push("state");
				},
				removeState: async () => {
					events.push("remove-state");
				},
				discover: async () => undefined,
				armCutoff: async () => {
					events.push("arm");
					return { cutoffAt: "2026-10-02T22:00:00.000Z", scriptPath: "stop.ps1", taskName: "OMPK-Clef-test" };
				},
				runColab: async args => {
					const action = args[0] ?? "";
					events.push(action);
					if (action === "status") {
						statusCalls++;
						return statusCalls === 1
							? { exitCode: 0, stdout: "[colab] Session 'ompk-clef-decision' not found.", stderr: "" }
							: { exitCode: 0, stdout: "[ompk-clef-decision] endpoint | Hardware: T4", stderr: "" };
					}
					if (action === "new") return { exitCode: 0, stdout: "Hardware: T4", stderr: "" };
					if (action === "exec") return { exitCode: 1, stdout: "", stderr: "bootstrap failed" };
					if (action === "stop") return { exitCode: 1, stdout: "", stderr: "release failed" };
					return { exitCode: 1, stdout: "", stderr: "unexpected" };
				},
				cancelCutoff: async () => {
					cancelled = true;
				},
			}),
		).rejects.toThrow("bootstrap failed");

		expect(cancelled).toBeFalse();
		expect(events).toContain("stop");
	});
});
