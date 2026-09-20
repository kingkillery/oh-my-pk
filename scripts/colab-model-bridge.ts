import { startPersistentColabBridge } from "../packages/coding-agent/src/slash-commands/helpers/colab-persistent-bridge.ts";

// Existing runtime only. A candidate port (e.g. 18083) leaves 18082 untouched.
const bridge = await startPersistentColabBridge({
	sessionName: process.argv[2] ?? "ompk-colab-model",
	localPort: Number(process.argv[3] ?? "18082"),
	remotePort: Number(process.argv[4] ?? "8081"),
	modelId: process.argv[5] ?? "Ternary-Bonsai-2-27B-PQ2_0",
});
process.stdout.write(`${JSON.stringify({ apiBaseUrl: bridge.apiBaseUrl, reused: bridge.reused })}\n`);
if (!bridge.reused) {
	const stopped = Promise.withResolvers<void>();
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stopped.resolve());
	await stopped.promise;
	await bridge.stop();
}
