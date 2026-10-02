import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	clearDecisionEndpointCache,
	discoverDecisionEndpoint,
} from "./decision-endpoint-discovery";

const ENV_KEYS = [
	"OMP_DECISION_DISCOVERY",
	"OMP_DECISION_ENDPOINT",
	"OMP_DECISION_HOSTNAME",
	"OMP_DECISION_MODEL",
	"OMP_DECISION_PORT",
] as const;

let savedEnv: Record<string, string | undefined>;

function health(model = "clef-flash"): Response {
	return Response.json({ status: "ok", model, model_id: `Cloudflare/${model}`, tailnet_only: true });
}

beforeEach(() => {
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	clearDecisionEndpointCache();
});

afterEach(() => {
	clearDecisionEndpointCache();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

describe("discoverDecisionEndpoint", () => {
	it("discovers a live clef-inference peer from Tailscale status", async () => {
		const seen: string[] = [];
		const endpoint = await discoverDecisionEndpoint({
			readTailscaleStatus: async () => ({
				Peer: {
					peer1: {
						HostName: "clef-inference-1",
						DNSName: "clef-inference-1.example.ts.net.",
						Online: true,
						TailscaleIPs: ["100.90.80.70"],
					},
				},
			}),
			fetch: (async input => {
				seen.push(String(input));
				return health();
			}) as typeof fetch,
		});

		expect(endpoint).toMatchObject({
			baseUrl: "https://clef-inference-1.example.ts.net/v1",
			model: "clef-flash",
			source: "tailscale",
		});
		expect(seen).toEqual(["https://clef-inference-1.example.ts.net/healthz"]);
	});

	it("supports an explicit decision endpoint without Tailscale discovery", async () => {
		process.env.OMP_DECISION_DISCOVERY = "off";
		process.env.OMP_DECISION_ENDPOINT = "http://100.90.80.70:8000";
		process.env.OMP_DECISION_MODEL = "clef";
		const endpoint = await discoverDecisionEndpoint({
			readTailscaleStatus: async () => {
				throw new Error("should not inspect Tailscale");
			},
			fetch: (async () => health("clef-flash")) as typeof fetch,
		});

		expect(endpoint).toMatchObject({
			baseUrl: "http://100.90.80.70:8000/v1",
			model: "clef",
			source: "explicit",
		});
	});

	it("ignores an offline matching peer without probing it", async () => {
		let probes = 0;
		const endpoint = await discoverDecisionEndpoint({
			readTailscaleStatus: async () => ({
				Peer: {
					peer1: {
						HostName: "clef-inference",
						DNSName: "clef-inference.example.ts.net.",
						Online: false,
					},
				},
			}),
			fetch: (async () => {
				probes++;
				return health();
			}) as typeof fetch,
		});

		expect(endpoint).toBeUndefined();
		expect(probes).toBe(0);
	});
});
