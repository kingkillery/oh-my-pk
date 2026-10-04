import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertColabModelReadiness,
	buildRemoteSetupScript,
	type ColabLoraAdapter,
	launchColabModel,
	validateColabAdapters,
} from "../src/slash-commands/helpers/colab-model";

const BASE = "m-Q4_0.gguf";
const artifact = { primaryFile: BASE, files: [BASE], quantization: "Q4_0", totalSize: 1 };
const upstream = { id: "upstream" } as const;
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

// Adapter bytes are tiny fixed strings so the generated VM script can verify real size and sha256 values.
const CONTENT: Record<string, string> = { "one.gguf": "adapter one bytes", "two.gguf": "second adapter bytes!" };
const adapterOf = (file: string, scale: number): ColabLoraAdapter => ({
	file,
	size: Buffer.byteLength(CONTENT[file]),
	sha256: sha(CONTENT[file]),
	scale,
});
const ONE = adapterOf("one.gguf", 1);
const TWO = adapterOf("two.gguf", 0.5);
// The first adapter under test, as published.
const REAL: ColabLoraAdapter = {
	file: "quant_dsl_v0_1_gemma4_e4b_finetuned_lora.gguf",
	size: 558_140_736,
	sha256: "f80f71149950e7b2ab606f775454f0bd9508829754c4ff8e6c06f7ea97b687ec",
	scale: 1.0,
};

function setupFor(adapters: readonly ColabLoraAdapter[], extra: { alias?: string } = {}) {
	return buildRemoteSetupScript({
		accelerator: "L4",
		artifact,
		contextWindow: 8_192,
		remotePort: 8_081,
		reference: { repoId: "owner/model-GGUF", revision: "main" },
		modelCacheDirectory: "/content/ompk-models/cache/x",
		adapters,
		...extra,
	});
}

async function runPython(source: string, exercise: string) {
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python 3 is required to exercise the generated Colab setup script");
	const child = Bun.spawn(
		[
			python,
			"-c",
			`import sys\nns = {"__name__": "colab_adapter_test"}\nexec(compile(sys.stdin.read(), "<colab-setup>", "exec"), ns)\n${exercise}`,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	child.stdin.write(source);
	child.stdin.end();
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		child.kill();
	}
}

// Shared helpers for the Python exercises: a staged cache directory and a stubbed server launch.
const PY_PRELUDE = `import contextlib, io, json, os, pathlib, tempfile
FILES = json.loads(${JSON.stringify(JSON.stringify(CONTENT))})
BASE = ${JSON.stringify(BASE)}
class Process:
    pid = 1
    def poll(self): return None
def stage(root):
    directory = root / "cache"
    directory.mkdir(exist_ok=True)
    (directory / BASE).write_bytes(b"base")
    for name, text in FILES.items():
        (directory / name).write_text(text)
    return directory
def launch(root, directory):
    ns["LOG_FILE"] = root / "server.log"
    ns["PID_FILE"] = root / "server.pid"
    ns["ADAPTER_STATE_FILE"] = root / "adapters.json"
    launched = []
    ns["subprocess"].Popen = lambda args, **kwargs: launched.append(list(args)) or Process()
    ns["request_json"] = lambda url, payload=None, timeout=30: {"status": "ok"}
    target = ns["RuntimeTarget"]("source", root / "llama-server", None)
    ns["start_server"](target, directory / BASE, BASE, "http://127.0.0.1:8081")
    # Reuse later trusts this record: the new server's pid and the adapters verified for it.
    assert json.loads(ns["ADAPTER_STATE_FILE"].read_text()) == {"pid": 1, "adapters": ns["adapter_echo"]()["adapters"]}
    return launched[-1]
`;

// ---------------------------------------------------------------------------
// validateColabAdapters
// ---------------------------------------------------------------------------

const manyAdapters = Array.from({ length: 5 }, (_, index) => ({ ...ONE, file: `adapter-${index}.gguf` }));
const badFiles: [string, string][] = [
	["a path separator", "dir/one.gguf"],
	["a backslash", "dir\\one.gguf"],
	["a comma", "a,b.gguf"],
	["a colon", "a:b.gguf"],
	["a double quote", 'a"b.gguf'],
	["a single quote", "a'b.gguf"],
	["a space", "a b.gguf"],
	["a non-gguf extension", "one.bin"],
	["an uppercase extension", "one.GGUF"],
	["a trailing newline", "one.gguf\n"],
	["a leading dash", "-one.gguf"],
	["a leading dot", ".one.gguf"],
	["an empty name", ""],
	["too many characters", `${"a".repeat(129)}.gguf`],
];
const rejected: [string, readonly ColabLoraAdapter[], RegExp][] = [
	["an empty list", [], /1-4/],
	["more than four adapters", manyAdapters, /1-4/],
	["a duplicate file", [ONE, { ...TWO, file: ONE.file }], /more than once/],
	...badFiles.map(([label, file]): [string, readonly ColabLoraAdapter[], RegExp] => [
		`a file name with ${label}`,
		[{ ...ONE, file }],
		/plain \.gguf file name/,
	]),
	["a file equal to the base GGUF", [{ ...ONE, file: BASE }], /same name as a base GGUF/],
	...["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), ""].map(
		(digest): [string, readonly ColabLoraAdapter[], RegExp] => [
			`sha256 ${JSON.stringify(digest.slice(0, 8))} (${digest.length} chars)`,
			[{ ...ONE, sha256: digest }],
			/sha256/,
		],
	),
	...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map(
		(size): [string, readonly ColabLoraAdapter[], RegExp] => [`size ${size}`, [{ ...ONE, size }], /size/],
	),
	...[0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 4.0001, 5].map(
		(scale): [string, readonly ColabLoraAdapter[], RegExp] => [`scale ${scale}`, [{ ...ONE, scale }], /scale/],
	),
	["a string scale", [{ ...ONE, scale: "1" as unknown as number }], /scale/],
	["a null entry", [null as unknown as ColabLoraAdapter], /must be an object/],
];

for (const [label, adapters, message] of rejected) {
	test(`validateColabAdapters rejects ${label}`, () => {
		expect(() => validateColabAdapters(adapters, artifact, upstream)).toThrow(message);
	});
}

for (const id of ["prism", "diffusion"] as const) {
	test(`validateColabAdapters rejects the ${id} runtime lane`, () => {
		expect(() => validateColabAdapters([ONE], artifact, { id })).toThrow(/upstream/);
	});
}

test("validateColabAdapters rejects a collision with any base GGUF shard, including nested paths", () => {
	const sharded = {
		primaryFile: "sub/model-00001-of-00002.gguf",
		files: ["sub/model-00001-of-00002.gguf", "sub/model-00002-of-00002.gguf"],
	};
	expect(() => validateColabAdapters([{ ...ONE, file: "model-00002-of-00002.gguf" }], sharded, upstream)).toThrow(
		/same name as a base GGUF/,
	);
	expect(validateColabAdapters([ONE], sharded, upstream)).toEqual([ONE]);
});

test("validateColabAdapters accepts the contract's boundaries and returns canonical copies", () => {
	expect(validateColabAdapters([REAL], artifact, upstream)).toEqual([REAL]);
	expect(
		validateColabAdapters(
			[
				{ ...ONE, scale: 4 },
				{ ...TWO, scale: 0.0001 },
			],
			artifact,
			upstream,
		),
	).toHaveLength(2);
	expect(validateColabAdapters([{ ...ONE, file: `${"a".repeat(128)}.gguf` }], artifact, upstream)).toHaveLength(1);
	const four = Array.from({ length: 4 }, (_, index) => ({ ...ONE, file: `adapter-${index}.gguf` }));
	expect(validateColabAdapters(four, artifact, upstream)).toHaveLength(4);
	// Extra properties never reach the VM script: only file, size, sha256 and scale survive.
	expect(
		validateColabAdapters([{ ...ONE, path: "/secret/one.gguf" } as ColabLoraAdapter], artifact, upstream),
	).toStrictEqual([ONE]);
});

// ---------------------------------------------------------------------------
// buildRemoteSetupScript payload
// ---------------------------------------------------------------------------

test("buildRemoteSetupScript refuses a bad alias, invalid adapters, or adapters without a staged cache", () => {
	const base = {
		accelerator: "L4" as const,
		artifact,
		contextWindow: 8_192,
		remotePort: 8_081,
		reference: { repoId: "owner/model-GGUF", revision: "main" },
	};
	for (const alias of ["", "bad alias", "-x", "a/b", 'a"b', "a".repeat(129)]) {
		expect(() => buildRemoteSetupScript({ ...base, alias })).toThrow(/alias/);
	}
	expect(() => buildRemoteSetupScript({ ...base, adapters: [ONE] })).toThrow(/modelCacheDirectory/);
	expect(() =>
		buildRemoteSetupScript({ ...base, modelCacheDirectory: "/c", adapters: [{ ...ONE, scale: 0 }] }),
	).toThrow(/scale/);
	const prism = (extra: { adapters?: ColabLoraAdapter[] }) =>
		buildRemoteSetupScript({
			...base,
			reference: { repoId: "prism-ml/Ternary-Bonsai-2-27B-gguf", revision: "main" },
			artifact: { ...artifact, primaryFile: "b-PQ2_0.gguf", files: ["b-PQ2_0.gguf"], quantization: "PQ2_0" },
			modelCacheDirectory: "/c",
			...extra,
		});
	expect(() => prism({ adapters: [ONE] })).toThrow(/upstream/);
	expect(() => prism({})).not.toThrow();
});

test("adapters and alias are top-level CONFIG keys, default to none, and add no remote stage names", async () => {
	const withAdapters = setupFor([ONE, TWO], { alias: "quant-dsl:v0.1" });
	const without = buildRemoteSetupScript({
		accelerator: "L4",
		artifact,
		contextWindow: 8_192,
		remotePort: 8_081,
		reference: { repoId: "owner/model-GGUF", revision: "main" },
	});
	const stages = (script: string) => [...script.matchAll(/@measured\("([^"]+)"\)/g)].map(match => match[1]);
	// launch-trace rejects unknown stage names mid-launch, so the set must stay exactly this.
	expect(stages(withAdapters)).toEqual([
		"runtime-source",
		"dependencies-build",
		"runtime-transfer-verify",
		"runtime-prepare",
		"remote-readiness-probe",
		"model-transfer-verify",
		"load-compile",
	]);
	expect(stages(without)).toEqual(stages(withAdapters));

	const withResult = await runPython(
		withAdapters,
		`assert ns["CONFIG"]["adapters"] == ${JSON.stringify([ONE, TWO])}
assert ns["CONFIG"]["alias"] == "quant-dsl:v0.1"
assert ns["ADAPTERS"] == ns["CONFIG"]["adapters"]
assert "adapters" not in ns["CONFIG"]["runtime"] and "alias" not in ns["CONFIG"]["runtime"]
assert "adapters" not in (ns["CONFIG"]["modelProfile"] or {}) and "alias" not in (ns["CONFIG"]["modelProfile"] or {})
print("PAYLOAD_OK")`,
	);
	expect(withResult.exitCode, withResult.stderr).toBe(0);
	expect(withResult.stdout).toContain("PAYLOAD_OK");

	const withoutResult = await runPython(
		without,
		`assert ns["CONFIG"]["adapters"] == [] and ns["CONFIG"]["alias"] is None and ns["ADAPTERS"] == []
print("DEFAULTS_OK")`,
	);
	expect(withoutResult.exitCode, withoutResult.stderr).toBe(0);
	expect(withoutResult.stdout).toContain("DEFAULTS_OK");
}, 20_000);

// ---------------------------------------------------------------------------
// Remote argv
// ---------------------------------------------------------------------------

for (const [label, adapters] of [
	["one adapter", [ONE]],
	["two adapters", [ONE, TWO]],
] as const) {
	test(`server argv for ${label} appends one single-token --lora-scaled per adapter after the untouched base argv`, async () => {
		const result = await runPython(
			setupFor(adapters),
			`${PY_PRELUDE}
with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    directory = stage(root)
    wanted = ns["ADAPTERS"]
    argv = launch(root, directory)
    ns["ADAPTERS"] = []
    base = launch(root, directory)
    assert argv[:len(base)] == base, (argv, base)
    tail = argv[len(base):]
    assert len(tail) == 2 * len(wanted), tail
    assert argv.count("--lora-scaled") == len(wanted) and "--lora" not in argv
    for index, adapter in enumerate(wanted):
        flag, token = tail[2 * index], tail[2 * index + 1]
        assert flag == "--lora-scaled", flag
        path, separator, scale = token.rpartition(":")
        assert separator and "," not in token and '"' not in token and "'" not in token, token
        assert pathlib.Path(path).is_absolute(), path
        assert pathlib.Path(path).name == adapter["file"]
        assert pathlib.Path(path).resolve().parent == (directory / BASE).resolve().parent
        assert scale == repr(float(adapter["scale"])), scale
    print("ARGV_OK " + json.dumps([token.rpartition(":")[2] for token in tail[1::2]], separators=(",", ":")))`,
		);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stdout).toContain(`ARGV_OK ${JSON.stringify(adapters.map(adapter => adapter.scale.toFixed(1)))}`);
	}, 20_000);
}

test("a custom alias replaces the file stem in --alias; without one the stem is kept", async () => {
	const exercise = `${PY_PRELUDE}
with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    directory = stage(root)
    argv = launch(root, directory)
    print("ALIAS " + argv[argv.index("--alias") + 1])`;
	const aliased = await runPython(setupFor([ONE], { alias: "quant-dsl:v0.1" }), exercise);
	expect(aliased.exitCode, aliased.stderr).toBe(0);
	expect(aliased.stdout).toMatch(/^ALIAS quant-dsl:v0\.1\s*$/m);
	const plain = await runPython(setupFor([ONE]), exercise);
	expect(plain.exitCode, plain.stderr).toBe(0);
	expect(plain.stdout).toMatch(/^ALIAS m-Q4_0\s*$/m);
}, 20_000);

test("adapters are re-verified on the VM beside the base GGUF, and errors name files but never paths", async () => {
	const result = await runPython(
		setupFor([ONE, TWO]),
		`${PY_PRELUDE}
def failure(mutate):
    with tempfile.TemporaryDirectory() as folder:
        root = pathlib.Path(folder)
        directory = stage(root)
        mutate(root, directory)
        try:
            ns["adapter_argv"](directory / BASE)
        except RuntimeError as error:
            message = str(error)
            assert str(directory) not in message and str(root) not in message, message
            return message
        raise AssertionError("adapter was accepted")

def corrupt(name, same_size):
    def mutate(root, directory):
        text = FILES[name]
        (directory / name).write_text(text[:-1] + "#" if same_size else text + "x")
    return mutate

def elsewhere(root, directory):
    # The adapter only exists outside the base GGUF's directory.
    other = root / "elsewhere"
    other.mkdir()
    (directory / "one.gguf").replace(other / "one.gguf")

missing = failure(lambda root, directory: (directory / "two.gguf").unlink())
assert "two.gguf" in missing and "missing" in missing, missing
wrong_size = failure(corrupt("one.gguf", False))
assert "one.gguf" in wrong_size and "size" in wrong_size, wrong_size
wrong_hash = failure(corrupt("two.gguf", True))
assert "two.gguf" in wrong_hash and "sha256" in wrong_hash, wrong_hash
moved = failure(elsewhere)
assert "one.gguf" in moved and "missing" in moved, moved

original = ns["ADAPTERS"][0]["scale"]
for bad in (float("nan"), float("inf"), float("-inf"), 0, -1, 4.5):
    ns["ADAPTERS"][0]["scale"] = bad
    assert "invalid scale" in failure(lambda root, directory: None)
ns["ADAPTERS"][0]["scale"] = original

ns["RUNTIME"]["id"] = "diffusion"
assert "upstream" in failure(lambda root, directory: None)
ns["RUNTIME"]["id"] = "upstream"

with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    directory = stage(root)
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        argv = ns["adapter_argv"](directory / BASE)
    messages = [json.loads(line.removeprefix(ns["PROGRESS_PREFIX"]))["message"] for line in output.getvalue().splitlines() if line.startswith(ns["PROGRESS_PREFIX"])]
    assert messages == ["verified LoRA adapter one.gguf at scale 1.0", "verified LoRA adapter two.gguf at scale 0.5"], messages
    assert len(argv) == 4
print("VERIFY_OK")`,
	);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain("VERIFY_OK");
}, 20_000);

// ---------------------------------------------------------------------------
// Server reuse
// ---------------------------------------------------------------------------

test("served_model_matches reuses a server only for the identical ordered (path, scale) adapter list", async () => {
	const result = await runPython(
		setupFor([ONE, TWO]),
		`${PY_PRELUDE}
with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    directory = stage(root)
    other = root / "other"
    other.mkdir()
    (other / "one.gguf").write_text(FILES["one.gguf"])
    ns["CONFIG"]["modelCacheDirectory"] = str(directory)
    everything = {adapter["file"]: adapter for adapter in ns["ADAPTERS"]}
    model = str(directory / BASE)
    one, two = str(directory / "one.gguf"), str(directory / "two.gguf")

    def served(*loras, extra=()):
        argv = ["llama-server", "--model", model, "--alias", "x", *extra]
        for path, scale in loras:
            argv += ["--lora-scaled", path + ":" + scale]
        return argv

    def matches(requested, argv):
        ns["ADAPTERS"] = [everything[name] for name in requested]
        return ns["served_model_matches"](argv, BASE, [BASE])

    rows = [
        ("same single adapter", ["one.gguf"], served((one, "1.0")), True),
        ("same scale written as an integer", ["one.gguf"], served((one, "1")), True),
        ("same two adapters in order", ["one.gguf", "two.gguf"], served((one, "1.0"), (two, "0.5")), True),
        ("base-only launch on a base-only server", [], served(), True),
        ("adapter launch on a base-only server", ["one.gguf"], served(), False),
        ("base-only launch on an adapter server", [], served((one, "1.0")), False),
        ("different scale", ["one.gguf"], served((one, "0.5")), False),
        ("different order", ["one.gguf", "two.gguf"], served((two, "0.5"), (one, "1.0")), False),
        ("server has an extra adapter", ["one.gguf"], served((one, "1.0"), (two, "0.5")), False),
        ("server lacks an adapter", ["one.gguf", "two.gguf"], served((one, "1.0")), False),
        ("different adapter file", ["one.gguf"], served((two, "1.0")), False),
        ("adapter from another directory", ["one.gguf"], served((str(other / "one.gguf"), "1.0")), False),
        ("plain --lora on a base-only launch", [], served(extra=["--lora", one]), False),
        ("plain --lora on an adapter launch", ["one.gguf"], served(extra=["--lora", one]), False),
        ("comma list is not the launched form", ["one.gguf", "two.gguf"], ["llama-server", "--model", model, "--lora-scaled", one + ":1.0," + two + ":0.5"], False),
        ("lora-init-without-apply", ["one.gguf"], served((one, "1.0"), extra=["--lora-init-without-apply"]), False),
        ("--lora-scaled without a value", ["one.gguf"], ["llama-server", "--model", model, "--lora-scaled"], False),
        ("non-numeric scale", ["one.gguf"], served((one, "high")), False),
    ]
    for label, requested, argv, expected in rows:
        assert matches(requested, argv) is expected, label

    # A requested adapter that vanished from the cache is not reusable even if argv matches.
    (directory / "two.gguf").unlink()
    assert matches(["one.gguf", "two.gguf"], served((one, "1.0"), (two, "0.5"))) is False
print("REUSE_OK")`,
	);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain("REUSE_OK");
}, 20_000);

test("main replaces a running server unless its model, alias and adapters all match the launch", async () => {
	const result = await runPython(
		setupFor([ONE, TWO]),
		`${PY_PRELUDE}
class Replaced(Exception):
    pass

with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    directory = stage(root)
    everything = {adapter["file"]: adapter for adapter in ns["ADAPTERS"]}
    model = str(directory / BASE)
    stem = BASE[:-len(".gguf")]
    target = ns["RuntimeTarget"]("source", pathlib.Path("/opt/llama-server"), "commit")

    def run_main(alias, requested, server_id, loras, state="started"):
        ns["CONFIG"]["alias"] = alias
        ns["CONFIG"]["modelCacheDirectory"] = str(directory)
        ns["ADAPTERS"] = [everything[name] for name in requested]
        argv = ["/opt/llama-server", "--model", model, "--alias", server_id, "--port", "8081"]
        for name, scale in loras:
            argv += ["--lora-scaled", str(directory / name) + ":" + scale]
        announced = []
        stopped = []
        ns["PID_FILE"] = root / "server.pid"
        # What start_server recorded when it launched the running server: its pid and the adapters it verified then.
        sidecar = root / "adapters.json"
        sidecar.unlink(missing_ok=True)
        ns["ADAPTER_STATE_FILE"] = sidecar
        recorded = [{"file": name, "sha256": everything[name]["sha256"], "scale": float(scale)} for name, scale in loras]
        if state == "started":
            sidecar.write_text(json.dumps({"pid": 4242, "adapters": recorded}))
        elif state == "other pid":
            sidecar.write_text(json.dumps({"pid": 1, "adapters": recorded}))
        elif state == "older bytes":
            sidecar.write_text(json.dumps({"pid": 4242, "adapters": [{**item, "sha256": "0" * 64} for item in recorded]}))
        elif state == "garbage":
            sidecar.write_text("not json")
        ns["run"] = lambda args, cwd=None: None
        ns["request_json"] = lambda url, payload=None, timeout=30: {"data": [{"id": server_id}]}
        ns["validated_targets"] = lambda: [target]
        ns["serving_process"] = lambda port, processes=None: (4242, target.server, argv)
        ns["target_for_process"] = lambda targets, running: target
        ns["record_runtime_manifest"] = lambda value, primary_name: None
        ns["announce_ready"] = lambda *args: announced.append(args)
        def stop_prior_server():
            stopped.append(True)
            raise Replaced()
        ns["stop_prior_server"] = stop_prior_server
        try:
            ns["main"]()
        except Replaced:
            assert not announced
            return "replaced"
        assert not stopped and len(announced) == 1 and announced[0][0] == server_id
        return "reused"

    rows = [
        ("alias, same adapter", "quant-dsl", ["one.gguf"], "quant-dsl", [("one.gguf", "1.0")], "reused"),
        ("alias launch on a base-only server", "quant-dsl", ["one.gguf"], stem, [], "replaced"),
        ("alias, different scale", "quant-dsl", ["one.gguf"], "quant-dsl", [("one.gguf", "0.5")], "replaced"),
        ("alias, different adapter order", "quant-dsl", ["one.gguf", "two.gguf"], "quant-dsl", [("two.gguf", "0.5"), ("one.gguf", "1.0")], "replaced"),
        ("alias differs from the running one", "other", ["one.gguf"], "quant-dsl", [("one.gguf", "1.0")], "replaced"),
        ("no alias, same adapter", None, ["one.gguf"], stem, [("one.gguf", "1.0")], "reused"),
        ("no alias, adapter launch on a base-only server", None, ["one.gguf"], stem, [], "replaced"),
        ("no alias, base-only launch on an adapter server", None, [], stem, [("one.gguf", "1.0")], "replaced"),
        ("no alias, base-only launch on a base-only server", None, [], stem, [], "reused"),
    ]
    for label, alias, requested, server_id, loras, expected in rows:
        assert run_main(alias, requested, server_id, loras) == expected, label
    # The argv matches, but the adapter bytes the running server holds are not provably the ones now on disk and in the manifest.
    for state in ("missing", "other pid", "older bytes", "garbage"):
        assert run_main("quant-dsl", ["one.gguf"], "quant-dsl", [("one.gguf", "1.0")], state) == "replaced", state
    # A base-only launch never consults the sidecar.
    assert run_main(None, [], stem, [], "missing") == "reused"
print("MAIN_REUSE_OK")`,
	);
	expect(result.exitCode, result.stderr).toBe(0);
	expect(result.stdout).toContain("MAIN_REUSE_OK");
}, 20_000);

// ---------------------------------------------------------------------------
// READY echo
// ---------------------------------------------------------------------------

test("the READY payload echoes adapters as file, sha256 and scale only, plus the alias", async () => {
	const exercise = (alias: string | null, expected: string) => `${PY_PRELUDE}
from types import SimpleNamespace
target = SimpleNamespace(commit="pinned", server=pathlib.Path("/tmp/llama-server"), source="source")
def announce(mode):
    ns["CONFIG"]["readinessMode"] = mode
    def request(url, payload=None, timeout=30):
        if url.endswith("/props"):
            return {"default_generation_settings": {"n_ctx": 8192}}
        if url.endswith("/health"):
            return {"status": "ok"}
        if payload and "tools" in payload:
            call = {"type": "function", "function": {"name": "ompk_tool_readiness_probe", "arguments": json.dumps({"lane": "task"})}}
            return {"choices": [{"message": {"tool_calls": [call]}}]}
        return {"choices": [{"message": {"content": "OK"}}]}
    ns["request_json"] = request
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        ns["announce_ready"]("served-id", BASE, "http://fixture", target)
    lines = [line for line in output.getvalue().splitlines() if line.startswith(ns["READY_PREFIX"])]
    assert len(lines) == 1
    return json.loads(lines[0].removeprefix(ns["READY_PREFIX"]))
alias = ${alias === null ? "None" : JSON.stringify(alias)}
ns["CONFIG"]["alias"] = alias
expected = ${expected}
for mode in ("chat", "tools"):
    ready = announce(mode)
    assert ready["adapters"] == expected, ready
    assert ready["alias"] == alias, ready
    assert all(sorted(item) == ["file", "scale", "sha256"] for item in ready["adapters"])
print("ECHO_OK")`;
	const adapterLiteral = `[{"file": "one.gguf", "sha256": ${JSON.stringify(ONE.sha256)}, "scale": 1.0}, {"file": "two.gguf", "sha256": ${JSON.stringify(TWO.sha256)}, "scale": 0.5}]`;
	const adapterRun = await runPython(setupFor([ONE, TWO]), exercise("quant-dsl", adapterLiteral));
	expect(adapterRun.exitCode, adapterRun.stderr).toBe(0);
	expect(adapterRun.stdout).toContain("ECHO_OK");
	const baseRun = await runPython(setupFor([]), exercise(null, "[]"));
	expect(baseRun.exitCode, baseRun.stderr).toBe(0);
	expect(baseRun.stdout).toContain("ECHO_OK");
}, 20_000);

const readyBase = { modelId: "served", modelName: "served", port: 8_081, contextWindow: 8_192, toolCallReady: true };
const echo = (adapter: ColabLoraAdapter) => ({ file: adapter.file, sha256: adapter.sha256, scale: adapter.scale });

test("host accepts a READY echo equal to the validated request and keeps older payloads working", () => {
	expect(() =>
		assertColabModelReadiness({ ...readyBase, adapters: [echo(ONE), echo(TWO)], alias: "a" }, "upstream", "tools", {
			adapters: [ONE, TWO],
			alias: "a",
		}),
	).not.toThrow();
	// A base-only launch tolerates a payload without the new fields, and null means no alias.
	expect(() => assertColabModelReadiness(readyBase, "upstream", "tools", { adapters: [] })).not.toThrow();
	expect(() =>
		assertColabModelReadiness({ ...readyBase, adapters: [], alias: null }, "upstream", "tools", {}),
	).not.toThrow();
	// Without an expectation the check is skipped entirely, exactly as before.
	expect(() => assertColabModelReadiness({ ...readyBase, adapters: [echo(TWO)] }, "upstream")).not.toThrow();
});

const mismatches: [string, Record<string, unknown>, { adapters?: ColabLoraAdapter[]; alias?: string }][] = [
	["adapters missing from the payload", {}, { adapters: [ONE] }],
	["an empty echo for a requested adapter", { adapters: [] }, { adapters: [ONE] }],
	["an unrequested adapter", { adapters: [echo(ONE)] }, {}],
	["an extra adapter", { adapters: [echo(ONE), echo(TWO)] }, { adapters: [ONE] }],
	["a missing adapter", { adapters: [echo(ONE)] }, { adapters: [ONE, TWO] }],
	["a different order", { adapters: [echo(TWO), echo(ONE)] }, { adapters: [ONE, TWO] }],
	["a different file", { adapters: [echo(TWO)] }, { adapters: [ONE] }],
	["a different sha256", { adapters: [{ ...echo(ONE), sha256: "0".repeat(64) }] }, { adapters: [ONE] }],
	["a different scale", { adapters: [{ ...echo(ONE), scale: 0.5 }] }, { adapters: [ONE] }],
	["a non-array echo", { adapters: "one.gguf" }, { adapters: [ONE] }],
	["a null entry", { adapters: [null] }, { adapters: [ONE] }],
	["a different alias", { adapters: [echo(ONE)], alias: "other" }, { adapters: [ONE], alias: "a" }],
	["a missing alias", { adapters: [echo(ONE)] }, { adapters: [ONE], alias: "a" }],
	["an unrequested alias", { adapters: [], alias: "a" }, {}],
];
for (const [label, patch, expected] of mismatches) {
	test(`host rejects a READY payload with ${label}`, () => {
		expect(() =>
			assertColabModelReadiness({ ...readyBase, ...patch } as never, "upstream", "tools", expected),
		).toThrow(/differ from the validated request/);
	});
}

// ---------------------------------------------------------------------------
// launchColabModel: validation before any CLI call, and the READY cross-check
// ---------------------------------------------------------------------------

const REMOTE_BASE = "model-Q4_K_M.gguf";

// A fake Colab CLI that records every invocation and the exec script, and answers exec with a canned READY line.
const FAKE_CLI = `const fs = await import("node:fs");
const [record, ready] = [process.argv[1], process.argv[2]];
const args = process.argv.slice(3);
fs.appendFileSync(record, JSON.stringify(args) + "\\n");
if (args[0] === "status") process.stdout.write("[colab] endpoint | Hardware: L4\\n");
else if (args[0] === "exec") {
  fs.writeFileSync(record + ".script", await Bun.stdin.text());
  if (ready !== "none") process.stdout.write("__OMPK_COLAB_READY__" + ready + "\\n");
} else process.exitCode = 1;`;

async function launchWithFakeCli(
	options: Parameters<typeof launchColabModel>[2],
	{ model = "owner/model", path = REMOTE_BASE, ready = "none" } = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "colab-adapters-"));
	const record = join(directory, "cli-calls.txt");
	try {
		const failure = await launchColabModel(model, () => {}, {
			sessionName: "adapter-contract",
			localPort: 18_083,
			fetch: Object.assign(async () => Response.json([{ type: "file", path, size: 1_000 }]), {
				preconnect: globalThis.fetch.preconnect,
			}),
			cliCommand: [process.execPath, "--eval", FAKE_CLI, record, ready],
			...options,
		}).then(
			() => undefined,
			error => error as Error,
		);
		const calls = existsSync(record)
			? (await Bun.file(record).text())
					.trim()
					.split("\n")
					.map(line => JSON.parse(line) as string[])
			: [];
		const script = existsSync(`${record}.script`) ? await Bun.file(`${record}.script`).text() : undefined;
		return { failure, calls, script };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const stagedCache = async () => "/content/ompk-models/cache/x";
const launchRejections: [
	string,
	Parameters<typeof launchColabModel>[2],
	RegExp,
	Parameters<typeof launchWithFakeCli>[1]?,
][] = [
	["a bad alias", { alias: "not valid!", prepareModelCache: stagedCache }, /alias/],
	["an alias with a path separator", { alias: "a/b" }, /alias/],
	["adapters without prepareModelCache", { adapters: [ONE] }, /prepareModelCache/],
	["a duplicate adapter", { adapters: [ONE, ONE], prepareModelCache: stagedCache }, /more than once/],
	["a colon in the file name", { adapters: [{ ...ONE, file: "a:b.gguf" }], prepareModelCache: stagedCache }, /plain/],
	["a NaN scale", { adapters: [{ ...ONE, scale: Number.NaN }], prepareModelCache: stagedCache }, /scale/],
	["a zero size", { adapters: [{ ...ONE, size: 0 }], prepareModelCache: stagedCache }, /size/],
	[
		"a collision with the base GGUF",
		{ adapters: [{ ...ONE, file: REMOTE_BASE }], prepareModelCache: stagedCache },
		/same name as a base GGUF/,
	],
	["more than four adapters", { adapters: manyAdapters, prepareModelCache: stagedCache }, /1-4/],
	[
		"the prism runtime lane",
		{ adapters: [ONE], prepareModelCache: stagedCache },
		/upstream/,
		{ model: "prism-ml/Ternary-Bonsai-2-27B-gguf", path: "Ternary-Bonsai-2-27B-PQ2_0.gguf" },
	],
	[
		"the diffusion runtime lane",
		{ adapters: [ONE], prepareModelCache: stagedCache },
		/upstream/,
		{ model: "owner/diffusion-gemma-GGUF", path: "dg-Q4_K_M.gguf" },
	],
];

for (const [label, options, message, fixture] of launchRejections) {
	test(`launch rejects ${label} before any Colab CLI call`, async () => {
		const result = await launchWithFakeCli(options, fixture);
		expect(result.failure?.message).toMatch(message);
		expect(result.calls).toEqual([]);
	}, 20_000);
}

test("launch reaches the Colab CLI for a valid adapter set, so the rejections above are not vacuous", async () => {
	const result = await launchWithFakeCli({ adapters: [ONE], alias: "quant-dsl", prepareModelCache: stagedCache });
	expect(result.calls.map(call => call[0])).toEqual(["status", "exec"]);
	expect(result.failure?.message).toContain("validated readiness probe");
}, 20_000);

const readyJson = (patch: Record<string, unknown>) =>
	JSON.stringify({ ...readyBase, runtimeCommit: "unpinned", toolCallReady: true, ...patch });

test("launch sends validated adapters and the alias to the VM and rejects a READY echo that differs", async () => {
	for (const [label, patch] of [
		["a missing echo", {}],
		["a different adapter", { adapters: [echo(TWO)], alias: "quant-dsl" }],
		["a different scale", { adapters: [{ ...echo(ONE), scale: 0.5 }], alias: "quant-dsl" }],
		["a different alias", { adapters: [echo(ONE)], alias: "other" }],
	] as const) {
		const result = await launchWithFakeCli(
			{ adapters: [ONE], alias: "quant-dsl", prepareModelCache: stagedCache },
			{ ready: readyJson(patch) },
		);
		expect(result.failure?.message, label).toMatch(/differ from the validated request/);
		expect(
			result.calls.map(call => call[0]),
			label,
		).toEqual(["status", "exec"]);
		expect(result.script).toContain("one.gguf");
		expect(result.script).toContain("quant-dsl");
	}
}, 30_000);

test("launch cross-checks adapters named only by the staging callback, and rejects a conflicting option", async () => {
	const fromCallback = await launchWithFakeCli(
		{ prepareModelCache: async () => ({ directory: "/content/ompk-models/cache/x", adapters: [ONE] }) },
		{ ready: readyJson({ adapters: [echo(TWO)] }) },
	);
	expect(fromCallback.failure?.message).toMatch(/differ from the validated request/);
	expect(fromCallback.script).toContain("one.gguf");

	const conflicting = await launchWithFakeCli({
		adapters: [ONE],
		prepareModelCache: async () => ({ directory: "/content/ompk-models/cache/x", adapters: [TWO] }),
	});
	expect(conflicting.failure?.message).toMatch(/differ from the adapters reported by cache staging/);
	// Callback adapters are only knowable after staging, so the VM never receives a script for the conflict.
	expect(conflicting.calls.map(call => call[0])).toEqual(["status"]);

	const invalidFromCallback = await launchWithFakeCli({
		prepareModelCache: async () => ({ directory: "/content/ompk-models/cache/x", adapters: [{ ...ONE, scale: 9 }] }),
	});
	expect(invalidFromCallback.failure?.message).toMatch(/scale/);
	expect(invalidFromCallback.calls.map(call => call[0])).toEqual(["status"]);
}, 30_000);

test("an equal option and callback adapter list is accepted and a plain string cache still works", async () => {
	const equal = await launchWithFakeCli(
		{
			adapters: [ONE],
			prepareModelCache: async () => ({ directory: "/content/ompk-models/cache/x", adapters: [{ ...ONE }] }),
		},
		{ ready: readyJson({ adapters: [echo(TWO)] }) },
	);
	// Passing the equality check means the failure is the READY cross-check, not the option/callback conflict.
	expect(equal.failure?.message).toMatch(/differ from the validated request/);
	const baseOnly = await launchWithFakeCli(
		{ prepareModelCache: stagedCache },
		{ ready: readyJson({ adapters: [echo(ONE)] }) },
	);
	expect(baseOnly.failure?.message).toMatch(/differ from the validated request/);
}, 30_000);
