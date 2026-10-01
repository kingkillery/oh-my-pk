import { expect, test } from "bun:test";
import { assertColabModelReadiness, buildRemoteSetupScript } from "../src/slash-commands/helpers/colab-model";

const config = {
	accelerator: "T4" as const,
	reference: { repoId: "bartowski/gemma-2-2b-it-GGUF", revision: "main" },
	artifact: {
		primaryFile: "gemma-2-2b-it-Q4_K_M.gguf",
		files: ["gemma-2-2b-it-Q4_K_M.gguf"],
		quantization: "Q4_K_M",
		totalSize: 1_500_000_000,
	},
	contextWindow: 8192,
	remotePort: 8081,
};
const ready = { modelId: "gemma2", modelName: "Gemma 2", port: 8081, contextWindow: 8192, toolCallReady: false };

test("chat launch is explicit and requires its visible readiness proof", () => {
	expect(() => assertColabModelReadiness(ready, "upstream")).toThrow("tool-call");
	expect(() => assertColabModelReadiness(ready, "upstream", "chat")).toThrow("visible chat");
	expect(() => assertColabModelReadiness({ ...ready, chatReady: true }, "upstream", "chat")).toThrow();
	expect(() =>
		assertColabModelReadiness(
			{ ...ready, readinessMode: "chat", chatReady: true, toolCallReady: true },
			"upstream",
			"chat",
		),
	).toThrow();
	expect(() =>
		assertColabModelReadiness({ ...ready, readinessMode: "chat", chatReady: true }, "upstream", "chat"),
	).not.toThrow();
	expect(() => assertColabModelReadiness({ ...ready, toolCallReady: true }, "upstream")).not.toThrow();
	expect(() => assertColabModelReadiness(ready, "diffusion")).not.toThrow();
	expect(() => assertColabModelReadiness(undefined, "upstream", "chat")).toThrow("validated readiness");
});
test("invalid readiness mode is rejected before a remote setup is generated", () => {
	expect(() => buildRemoteSetupScript({ ...config, readinessMode: "invalid" as "chat" })).toThrow(
		"Invalid Colab readiness mode",
	);
});

test("generated chat warmup requires visible text and healthy API while default tools stay strict", async () => {
	const setup = buildRemoteSetupScript({ ...config, readinessMode: "chat" });
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python 3 required");
	const exercise = `import contextlib, io, json, sys
from pathlib import Path
from types import SimpleNamespace
ns = {"__name__": "chat_readiness_contract"}
exec(compile(sys.stdin.read(), "<colab-setup>", "exec"), ns)
target = SimpleNamespace(commit="pinned", server=Path("/tmp/llama-server"), source="source-build")
requests = []
def exercise(mode, completion, health="ok", tool_valid=False):
    output = io.StringIO()
    requests.clear()
    ns["CONFIG"]["readinessMode"] = mode
    def request(url, payload=None, timeout=30):
        requests.append((url, payload))
        if url.endswith("/props"):
            return {"default_generation_settings": {"n_ctx": 8192}}
        if url.endswith("/health"):
            return {"status": health}
        if payload and "tools" in payload:
            if not tool_valid:
                return {"choices": [{"message": {"content": "prose"}}]}
            return {"choices": [{"message": {"tool_calls": [{"type": "function", "function": {"name": "ompk_tool_readiness_probe", "arguments": json.dumps({"lane": "task"})}}]}}]}
        return {"choices": [{"message": completion}]}
    ns["request_json"] = request
    with contextlib.redirect_stdout(output):
        ns["announce_ready"]("gemma2", "gemma2.gguf", "http://fixture", target)
    lines = [line for line in output.getvalue().splitlines() if line.startswith(ns["READY_PREFIX"])]
    assert len(lines) == 1
    return json.loads(lines[0].removeprefix(ns["READY_PREFIX"]))
result = exercise("chat", {"content": "4"})
assert result["chatReady"] is True and result["toolCallReady"] is False
assert result["readinessMode"] == "chat" and result["runtimeCommit"] == "pinned"
assert [url for url, payload in requests] == ["http://fixture/props", "http://fixture/v1/chat/completions", "http://fixture/health"]
assert not any(payload and "tools" in payload for url, payload in requests)
for bad in [{"content": ""}, {"content": "  "}, {"content": None}, {"reasoning_content": "hidden"}, {"tool_calls": []}, {"content": ["4"]}]:
    try:
        exercise("chat", bad)
        raise AssertionError("non-visible completion was accepted")
    except RuntimeError as error:
        assert "visible" in str(error)
try:
    exercise("chat", {"content": "4"}, health="loading")
    raise AssertionError("unhealthy API accepted")
except RuntimeError as error:
    assert "healthy" in str(error)
try:
    exercise("tools", {"content": "4"})
    raise AssertionError("default tool probe was bypassed")
except RuntimeError as error:
    assert "tool call" in str(error)
result = exercise("tools", {"content": "4"}, tool_valid=True)
assert result["toolCallReady"] is True and result["readinessMode"] == "tools"
print("CHAT_READINESS_CONTRACT_OK")
`;
	const child = Bun.spawn([python, "-c", exercise], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	child.stdin.write(setup);
	child.stdin.end();
	try {
		const [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exit, stderr).toBe(0);
		expect(stdout).toContain("CHAT_READINESS_CONTRACT_OK");
	} finally {
		child.kill();
	}
}, 10_000);
