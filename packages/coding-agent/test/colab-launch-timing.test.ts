import { expect, test } from "bun:test";
import {
	buildRemoteSetupScript,
	type ColabLaunchStageEvent,
	createProgressParser,
} from "../src/slash-commands/helpers/colab-model";

const prefix = "__OMPK_COLAB_TIMING__";
test("remote timing survives fragmented transport and strips untrusted fields", async () => {
	const events: ColabLaunchStageEvent[] = [];
	const messages: string[] = [];
	const parser = createProgressParser(
		message => {
			messages.push(message);
		},
		event => {
			events.push(event);
		},
	);
	const payload =
		prefix +
		JSON.stringify({
			stage: "load-compile",
			event: "end",
			source: "remote",
			durationMs: 12.5,
			remoteElapsedMs: 48.5,
			token: "private",
			error: "secret",
		}) +
		"\r\n";
	await parser(payload.slice(0, 23));
	expect(events).toHaveLength(0);
	await parser(payload.slice(23));
	expect(events).toEqual([
		{ stage: "load-compile", event: "end", source: "remote", durationMs: 12.5, remoteElapsedMs: 48.5 },
	]);
	expect(messages).toHaveLength(0);
});
test("invalid timing cannot enter evidence and ordinary progress still arrives", async () => {
	const events: ColabLaunchStageEvent[] = [];
	const messages: string[] = [];
	const parser = createProgressParser(
		message => {
			messages.push(message);
		},
		event => {
			events.push(event);
		},
	);
	const valid = { stage: "allocation", event: "end", source: "remote", durationMs: 1, remoteElapsedMs: 2 };
	for (const changed of [
		{ durationMs: -1 },
		{ remoteElapsedMs: null },
		{ source: "local" },
		{ stage: "secret?token=value" },
		{ event: "retry" },
	]) {
		await parser(`${prefix}${JSON.stringify({ ...valid, ...changed })}\n`);
	}
	await parser('__OMPK_COLAB_PROGRESS__{"message":"loading model"}\n');
	expect(events).toHaveLength(0);
	expect(messages).toHaveLength(1);
	expect(messages[0]).toContain("Colab: loading model");
});
test("generated runtime records failures without leaking exception text or changing propagation", async () => {
	const setup = buildRemoteSetupScript({
		accelerator: "T4",
		reference: { repoId: "prism-ml/Ternary-Bonsai-2-27B-gguf", revision: "main" },
		artifact: {
			primaryFile: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
			files: ["Ternary-Bonsai-2-27B-PQ2_0.gguf"],
			quantization: "PQ2_0",
			totalSize: 7_206_168_928,
		},
		contextWindow: 32768,
		remotePort: 8081,
	});
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python 3 required");
	const exercise = `import contextlib, io, json, sys
ns = {"__name__": "timing_contract"}
exec(compile(sys.stdin.read(), "<colab-setup>", "exec"), ns)
output = io.StringIO()
@ns["measured"]("load-compile")
def fails():
    raise RuntimeError("SECRET_EXCEPTION")
with contextlib.redirect_stdout(output):
    try:
        fails()
        raise AssertionError("failure was swallowed")
    except RuntimeError as error:
        assert str(error) == "SECRET_EXCEPTION"
assert "SECRET_EXCEPTION" not in output.getvalue()
events = [json.loads(line.removeprefix(ns["TIMING_PREFIX"])) for line in output.getvalue().splitlines()]
assert [event["event"] for event in events] == ["begin", "error"]
assert all(event["source"] == "remote" and event["durationMs"] >= 0 for event in events)
assert events[1]["remoteElapsedMs"] >= events[0]["remoteElapsedMs"]
print("TIMING_FAILURE_CONTRACT_OK")
`;
	const child = Bun.spawn([python, "-c", exercise], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	child.stdin.write(setup);
	child.stdin.end();
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout).toContain("TIMING_FAILURE_CONTRACT_OK");
	} finally {
		child.kill();
	}
}, 10_000);
