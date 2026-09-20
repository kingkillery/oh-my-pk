import { expect, test } from "bun:test";
import { buildRemoteHttpScript } from "../src/slash-commands/helpers/colab-model";

test("Colab HTTP bridge stops at SSE DONE without waiting for upstream connection close", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\ndata: [DONE]\n\n'));
						// The upstream keeps the connection alive after its terminal event.
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) {
		server.stop(true);
		throw new Error("Python 3 required");
	}
	const child = Bun.spawn(
		[
			python,
			"-c",
			buildRemoteHttpScript({
				bodyBase64: "",
				headers: {},
				method: "GET",
				path: "/v1/chat/completions",
				remotePort: server.port!,
			}),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	let timedOut = false;
	// External Python blocks on a real socket: fake timers cannot interrupt it.
	// This is a failure watchdog, not a synchronization delay on the passing path.
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, 5_000);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(timedOut).toBe(false);
		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toContain("data: [DONE]");
	} finally {
		clearTimeout(timer);
		child.kill();
		server.stop(true);
	}
}, 10_000);
