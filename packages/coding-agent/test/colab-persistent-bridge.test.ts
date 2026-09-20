import { describe, expect, test } from "bun:test";
import { startPersistentColabBridge } from "../src/slash-commands/helpers/colab-persistent-bridge";

describe("persistent Colab bridge ownership", () => {
	test("verified listener is reused and stop does not terminate a foreign bridge", async () => {
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				requests.push(path);
				return Response.json(path === "/health" ? { status: "ok" } : { data: [{ id: "bonsai" }] });
			},
		});
		try {
			const bridge = await startPersistentColabBridge({
				sessionName: "unused",
				modelId: "bonsai",
				remotePort: 8081,
				localPort: server.port,
			});
			expect(bridge.reused).toBe(true);
			expect(bridge.apiBaseUrl).toBe(`http://127.0.0.1:${server.port}/v1`);
			expect(requests).toEqual(["/health", "/v1/models"]);
			await bridge.stop();
			expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
		} finally {
			server.stop(true);
		}
	});

	test("a different model is rejected without replacing the listener", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ data: [{ id: "other-model" }] }),
		});
		try {
			await expect(
				startPersistentColabBridge({
					sessionName: "unused",
					modelId: "bonsai",
					remotePort: 8081,
					localPort: server.port,
				}),
			).rejects.toThrow("different model");
			expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
		} finally {
			server.stop(true);
		}
	});

	test("an unhealthy or busy listener fails immediately without takeover", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy", { status: 429 }) });
		try {
			await expect(
				startPersistentColabBridge({
					sessionName: "unused",
					modelId: "bonsai",
					remotePort: 8081,
					localPort: server.port,
				}),
			).rejects.toThrow("HTTP 429");
			expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(429);
		} finally {
			server.stop(true);
		}
	});
});
