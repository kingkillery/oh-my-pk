import { expect, test } from "bun:test";
import {
	buildColabModelCacheStageScript,
	ensureCpuColabSession,
	parseColabModelCacheCommandArgs,
	resolveImmutableHuggingFaceRevision,
} from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/helpers/colab-model-cache";
import { buildRemoteSetupScript } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/helpers/colab-model";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";

async function runPythonScript(source: string, exercise: string): Promise<{ exitCode: number; stderr: string; stdout: string }> {
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python 3 is required to exercise the Colab cache staging script");
	const processHandle = Bun.spawn(
		[python, "-c", `import sys\nns = {"__name__": "colab_cache_test"}\nexec(compile(sys.stdin.read(), "<colab-model-cache-stage>", "exec"), ns)\n${exercise}`],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	processHandle.stdin.write(source);
	processHandle.stdin.end();
	const [exitCode, stderr, stdout] = await Promise.all([
		processHandle.exited,
		new Response(processHandle.stderr).text(),
		new Response(processHandle.stdout).text(),
	]);
	return { exitCode, stderr, stdout };
}

test("/colab-model-cache stage requires an explicit GGUF and defaults its target runtime to L4", () => {
	expect(parseColabModelCacheCommandArgs("stage --file Qwen3.5-4B-Base-Q4_K_M.gguf owner/Qwen3.5-4B-Base-GGUF")).toEqual({
		accelerator: "L4",
		file: "Qwen3.5-4B-Base-Q4_K_M.gguf",
		modelReference: "owner/Qwen3.5-4B-Base-GGUF",
		sessionName: undefined,
	});
	expect(() => parseColabModelCacheCommandArgs("stage owner/Qwen3.5-4B-Base-GGUF")).toThrow("--file is required");
	expect(() => parseColabModelCacheCommandArgs("stage --gpu V100 --file model.gguf owner/model")).toThrow("Unsupported Colab GPU");
	expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("colab-model-cache")).toBe(true);
});

test("cache staging resolves a mutable model ref to an immutable Hugging Face revision", async () => {
	const revision = "0123456789abcdef0123456789abcdef01234567";
	const resolved = await resolveImmutableHuggingFaceRevision(
		{ repoId: "owner/Qwen3.5-4B-Base-GGUF", revision: "main" },
		async url => {
			expect(String(url)).toContain("/owner/Qwen3.5-4B-Base-GGUF/revision/main");
			return Response.json({ sha: revision });
		},
	);
	expect(resolved).toEqual({ repoId: "owner/Qwen3.5-4B-Base-GGUF", revision });
});

interface ColabCommandStep {
	command: "status" | "new";
	exitCode: number;
	stdout: string;
	stderr: string;
}

// Replay CLI transcripts through real child-process streams, without calling Colab or changing global mocks/env.
function colabSessionFixture(steps: readonly ColabCommandStep[]) {
	const calls: string[][] = [];
	const messages: string[] = [];
	let staged = false;
	return {
		calls,
		messages,
		get staged() {
			return staged;
		},
		async stage() {
			await ensureCpuColabSession(
				"cache-contract",
				message => { messages.push(message); },
				async (args, options) => {
					const step = steps[calls.length];
					calls.push([...args]);
					if (!step) throw new Error(`Unexpected Colab command: ${args.join(" ")}`);
					expect(args).toEqual([step.command, "--session", "cache-contract"]);
					expect(options.timeoutMs).toBe(step.command === "new" ? 5 * 60_000 : 60_000);
					const child = Bun.spawn([
						process.execPath,
						"--eval",
						'const result = JSON.parse(process.argv[1]); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.exitCode;',
						JSON.stringify(step),
					], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000 });
					const [exitCode, stdout, stderr] = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					return { exitCode, stdout, stderr };
				},
			);
			staged = true;
		},
	};
}

const missingCacheSession: ColabCommandStep = { command: "status", exitCode: 1, stdout: "", stderr: "No active session" };
const launchedCacheSession: ColabCommandStep = { command: "new", exitCode: 0, stdout: "Session ready", stderr: "" };
const cpuCacheSession: ColabCommandStep = { command: "status", exitCode: 0, stdout: "Accelerator: CPU", stderr: "" };

test("cache staging reuses a CPU session without launching another runtime", async () => {
	const fixture = colabSessionFixture([cpuCacheSession]);
	await fixture.stage();
	expect(fixture.calls).toEqual([["status", "--session", "cache-contract"]]);
	expect(fixture.messages).toEqual(["Colab cache: reusing CPU session cache-contract."]);
	expect(fixture.staged).toBe(true);
});

test("cache staging launches without a GPU flag and verifies the acquired session before continuing", async () => {
	const fixture = colabSessionFixture([missingCacheSession, launchedCacheSession, cpuCacheSession]);
	await fixture.stage();
	expect(fixture.calls).toEqual([
		["status", "--session", "cache-contract"],
		["new", "--session", "cache-contract"],
		["status", "--session", "cache-contract"],
	]);
	expect(fixture.messages).toEqual([
		"Colab cache: requesting CPU session cache-contract…",
		"Colab cache: acquired CPU session cache-contract.",
	]);
	expect(fixture.staged).toBe(true);
});

for (const stream of ["stdout", "stderr"] as const) {
	for (const accelerator of ["T4", "L4", "A100", "H100", "G4"] as const) {
		test(`cache staging refuses an existing ${accelerator} runtime reported on ${stream}`, async () => {
			const fixture = colabSessionFixture([
				{ command: "status", exitCode: 0, stdout: "", stderr: "", [stream]: `Accelerator: ${accelerator}` },
			]);
			await expect(fixture.stage()).rejects.toThrow(`cache-contract is already using ${accelerator}; cache staging refuses to reuse a GPU runtime.`);
			expect(fixture.calls).toEqual([["status", "--session", "cache-contract"]]);
			expect(fixture.messages).toEqual([]);
			expect(fixture.staged).toBe(false);
		});

		test(`cache staging refuses ${accelerator} reported on launch ${stream}`, async () => {
			const fixture = colabSessionFixture([
				missingCacheSession,
				{ ...launchedCacheSession, [stream]: `Accelerator: ${accelerator}` },
			]);
			await expect(fixture.stage()).rejects.toThrow(`cache-contract launched with ${accelerator}; cache staging refuses to use a GPU runtime.`);
			expect(fixture.calls.map(args => args[0])).toEqual(["status", "new"]);
			expect(fixture.messages).toEqual(["Colab cache: requesting CPU session cache-contract…"]);
			expect(fixture.staged).toBe(false);
		});

		test(`cache staging refuses ${accelerator} revealed only by post-launch status ${stream}`, async () => {
			const fixture = colabSessionFixture([
				missingCacheSession,
				launchedCacheSession,
				{ command: "status", exitCode: 0, stdout: "", stderr: "", [stream]: `Accelerator: ${accelerator}` },
			]);
			await expect(fixture.stage()).rejects.toThrow(`cache-contract launched with ${accelerator}; cache staging refuses to use a GPU runtime.`);
			expect(fixture.calls.map(args => args[0])).toEqual(["status", "new", "status"]);
			expect(fixture.messages).toEqual(["Colab cache: requesting CPU session cache-contract…"]);
			expect(fixture.staged).toBe(false);
		});
	}
}

test("cache staging stops when CPU session launch fails", async () => {
	const fixture = colabSessionFixture([
		missingCacheSession,
		{ ...launchedCacheSession, exitCode: 1, stdout: "", stderr: "Allocation failed" },
	]);
	await expect(fixture.stage()).rejects.toThrow("Could not acquire CPU Colab session cache-contract: Allocation failed");
	expect(fixture.calls.map(args => args[0])).toEqual(["status", "new"]);
	expect(fixture.staged).toBe(false);
});

test("cache staging fails closed when post-launch status cannot verify the runtime", async () => {
	const fixture = colabSessionFixture([
		missingCacheSession,
		launchedCacheSession,
		{ ...cpuCacheSession, exitCode: 1, stderr: "Status unavailable" },
	]);
	await expect(fixture.stage()).rejects.toThrow("Could not verify CPU Colab session cache-contract: Status unavailable");
	expect(fixture.calls.map(args => args[0])).toEqual(["status", "new", "status"]);
	expect(fixture.messages).toEqual(["Colab cache: requesting CPU session cache-contract…"]);
	expect(fixture.staged).toBe(false);
});

test("cache staging script verifies GGUF and runtime bytes before publishing a manifest", async () => {
	const source = buildColabModelCacheStageScript({
		artifact: {
			files: ["Qwen3.5-4B-Base-Q4_K_M.gguf"],
			primaryFile: "Qwen3.5-4B-Base-Q4_K_M.gguf",
			quantization: "Q4_K_M",
			totalSize: 3_000_000_000,
		},
		bucket: "gs://private-model-cache",
		reference: { repoId: "owner/Qwen3.5-4B-Base-GGUF", revision: "0123456789abcdef" },
		runtime: {
			archive: "llama-b11064-bin-ubuntu-cuda-12.8-x64.tar.gz",
			id: "upstream",
			sha256: "658c391b6c93483960433b160975b938a727315311320dbf2ab24bae41488fb7",
			url: "https://example.invalid/llama.tar.gz",
		},
	});
	const exercised = await runPythonScript(
		source,
		`import pathlib, tempfile
with tempfile.TemporaryDirectory() as folder:
    payload = pathlib.Path(folder) / "model.gguf"
    payload.write_bytes(b"verified baseline bytes")
    digest = ns["sha256_of"](payload)
    uploaded = []
    ns["run"] = lambda args, **kwargs: uploaded.append(args)
    ns["gcs_hash"] = lambda uri: digest
    ns["gcs_store"](payload, "gs://private-model-cache/model", digest)
    assert uploaded == [["gsutil", "cp", str(payload), "gs://private-model-cache/model"]]
    ns["gcs_hash"] = lambda uri: "wrong"
    try:
        ns["gcs_store"](payload, "gs://private-model-cache/model", digest)
        raise AssertionError("persistent checksum mismatch was accepted")
    except RuntimeError as error:
        assert "checksum mismatch" in str(error)
print("CACHE_STAGE_CONTRACT_OK")`,
	);
	expect(exercised.exitCode, exercised.stderr).toBe(0);
	expect(exercised.stdout).toContain("CACHE_STAGE_CONTRACT_OK");
});

test("GPU setup accepts only a matching persistent manifest and restores its verified GGUFs", async () => {
	const source = buildRemoteSetupScript({
		accelerator: "L4",
		artifact: {
			files: ["Qwen3.5-4B-Base-Q4_K_M.gguf"],
			primaryFile: "Qwen3.5-4B-Base-Q4_K_M.gguf",
			quantization: "Q4_K_M",
			totalSize: 3_000_000_000,
		},
		contextWindow: 32_768,
		remotePort: 8_081,
		reference: { repoId: "owner/Qwen3.5-4B-Base-GGUF", revision: "baseline" },
	});
	const exercised = await runPythonScript(
		source,
		`import json, pathlib, tempfile
with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    ns["MODEL_ROOT"] = root / "models"
    ns["PERSISTENT_CACHE"] = {"bucket": "gs://private-model-cache", "prefix": "ompk-colab-cache/v1"}
    name = ns["CONFIG"]["primaryFile"]
    uri = "gs://private-model-cache/ompk-colab-cache/v1/models/owner--Qwen3.5-4B-Base-GGUF/baseline/" + name + "/deadbeef"
    manifest = {"version": 1, "repoId": ns["CONFIG"]["repoId"], "revision": ns["CONFIG"]["revision"], "primaryFile": name, "files": [{"name": name, "sha256": "deadbeef", "uri": uri}]}
    class Result:
        stdout = json.dumps(manifest)
    ns["subprocess"].run = lambda args, **kwargs: Result()
    restored = []
    def restore(uri_value, destination, digest):
        restored.append((uri_value, digest))
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"baseline")
        return True
    ns["restore_persistent_file"] = restore
    ns["sha256_of"] = lambda path: "deadbeef"
    model = ns["restore_persistent_model"](name, [name])
    assert model is not None and model.read_bytes() == b"baseline"
    assert restored == [(uri, "deadbeef")]
print("PERSISTENT_MODEL_RESTORE_OK")`,
	);
	expect(exercised.exitCode, exercised.stderr).toBe(0);
	expect(exercised.stdout).toContain("PERSISTENT_MODEL_RESTORE_OK");
});
