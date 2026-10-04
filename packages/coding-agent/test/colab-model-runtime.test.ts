import { expect, test } from "bun:test";
import { buildRemoteSetupScript } from "../src/slash-commands/helpers/colab-model";

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

test("pinned runtime cache reuses verified bytes and rejects corrupt downloads", async () => {
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python 3 required");
	const exercise = `import hashlib, json, pathlib, sys, tempfile
ns = {"__name__": "colab_cache_test"}
exec(compile(sys.stdin.read(), "<colab-setup>", "exec"), ns)
with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    source = root / "release.bin"
    archive = root / "cached.bin"
    payload = b"pinned release archive content"
    source.write_bytes(payload)
    ns["PREBUILT"].update({"url": source.as_uri(), "sha256": hashlib.sha256(payload).hexdigest(), "archive": archive.name})
    ns["ensure_prebuilt_archive"](archive)
    assert archive.read_bytes() == payload
    source.unlink()
    ns["ensure_prebuilt_archive"](archive)
    assert archive.read_bytes() == payload
    archive.write_bytes(b"corrupt cache")
    source.write_bytes(b"corrupt download")
    try:
        ns["ensure_prebuilt_archive"](archive)
        raise AssertionError("corrupt artifact accepted")
    except RuntimeError as error:
        assert "sha256" in str(error)
    assert not archive.exists()
    assert not archive.with_name(archive.name + ".part").exists()
    server = root / "unpacked" / ns["PREBUILT"]["serverPath"]
    server.parent.mkdir(parents=True)
    server.write_bytes(b"not an executable")
    ns["PREBUILT"]["directory"] = str(root)
    (root / "runtime.json").write_text(json.dumps({"server": str(server), "sha256": ns["PREBUILT"]["sha256"], "commit": ns["RUNTIME"]["pinnedCommit"]}))
    assert "checksum" in ns["prebuilt_rejection"]()
print("CACHE_CONTRACT_OK")
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
		expect(stdout).toContain("CACHE_CONTRACT_OK");
	} finally {
		child.kill();
	}
}, 10_000);

test("resolve_model_path prioritizes Google Drive before remote download", async () => {
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python 3 required");
	const exercise = `import pathlib, sys, tempfile
ns = {"__name__": "colab_drive_test"}
exec(compile(sys.stdin.read(), "<colab-setup>", "exec"), ns)
with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    drive_dir = root / "drive" / "MyDrive" / "models"
    drive_dir.mkdir(parents=True)
    target_model = drive_dir / ns["CONFIG"]["primaryFile"]
    target_model.write_bytes(b"dummy gguf bytes")
    found = None
    for r in [drive_dir]:
        for cand in r.rglob(ns["CONFIG"]["primaryFile"]):
            if cand.is_file():
                found = cand
                break
    assert found == target_model
print("DRIVE_CACHE_OK")
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
		expect(stdout).toContain("DRIVE_CACHE_OK");
	} finally {
		child.kill();
	}
}, 10_000);

test("pinned model staging rejects same-named files from another revision and incomplete shards", async () => {
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python 3 required");
	const exercise = `import pathlib, sys, tempfile
ns = {"__name__": "colab_exact_cache_test"}
exec(compile(sys.stdin.read(), "<colab-setup>", "exec"), ns)
with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    pinned = root / "pinned"
    other = root / "other"
    pinned.mkdir(); other.mkdir()
    primary = "model-00001-of-00002.gguf"
    required = [primary, "model-00002-of-00002.gguf"]
    for name in required:
        (pinned / name).write_bytes(b"pinned model")
        (other / name).write_bytes(b"other revision")
    ns["CONFIG"]["modelCacheDirectory"] = str(pinned)
    assert ns["resolve_model_path"](primary, required) == pinned / primary
    assert ns["served_model_matches"](["llama-server", "--model", str(pinned / primary)], primary, required)
    assert not ns["served_model_matches"](["llama-server", "--model", str(other / primary)], primary, required)
    (pinned / required[1]).unlink()
    assert not ns["served_model_matches"](["llama-server", "--model", str(pinned / primary)], primary, required)
    try:
        ns["resolve_model_path"](primary, required)
        raise AssertionError("incomplete pinned cache was accepted")
    except RuntimeError as error:
        assert "incomplete" in str(error)
print("EXACT_CACHE_OK")
`;
	const child = Bun.spawn([python, "-c", exercise], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	child.stdin.write(setup);
	child.stdin.end();
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toContain("EXACT_CACHE_OK");
}, 10_000);

test("the prebuilt's CUDA runtime libraries are searched in the toolkit and pip locations that actually hold them", async () => {
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python 3 required");
	const l4Setup = buildRemoteSetupScript({
		accelerator: "L4",
		reference: { repoId: "ggml-org/gemma-4-E4B-it-GGUF", revision: "main" },
		artifact: {
			primaryFile: "gemma-4-E4B-it-Q4_K_M.gguf",
			files: ["gemma-4-E4B-it-Q4_K_M.gguf"],
			quantization: "Q4_K_M",
			totalSize: 5_000_000_000,
		},
		contextWindow: 32768,
		remotePort: 8081,
	});
	const exercise = `import importlib, os, pathlib, sys, tempfile
ns = {"__name__": "colab_cuda_path_test"}
exec(compile(sys.stdin.read(), "<colab-setup>", "exec"), ns)
assert ns["PREBUILT"]["cuda"] == "12.8"

def lib(folder, name):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(b"")

with tempfile.TemporaryDirectory() as scratch:
    parent = pathlib.Path(scratch) / "usr-local"
    site = pathlib.Path(scratch) / "site"
    sys.path.insert(0, str(site))
    assert ns["cuda_library_dirs"](parent) == []
    toolkit = parent / "cuda-12.8" / "lib64"
    lib(toolkit, "libcublas.so.12")
    lib(parent / "cuda-13.0" / "lib64", "libcublas.so.13")
    pip_blas = site / "nvidia" / "cublas" / "lib"
    pip_runtime = site / "nvidia" / "cuda_runtime" / "lib"
    lib(pip_blas, "libcublas.so.12")
    lib(pip_runtime, "libcudart.so.12")
    importlib.invalidate_caches()
    assert ns["cuda_library_dirs"](parent) == [str(toolkit), str(pip_blas), str(pip_runtime)], ns["cuda_library_dirs"](parent)
    (pip_blas / "libcublas.so.12").unlink()
    lib(pip_blas, "libcublas.so.13")
    assert ns["cuda_library_dirs"](parent) == [str(toolkit), str(pip_runtime)]
    ns["CUDA_TOOLKIT_PARENT"] = parent
    os.environ["LD_LIBRARY_PATH"] = "/usr/lib64-nvidia"
    parts = ns["library_env"](pathlib.Path("/opt/llama/bin/llama-server"))["LD_LIBRARY_PATH"].split(os.pathsep)
    assert parts == [str(pathlib.Path("/opt/llama/bin")), str(toolkit), str(pip_runtime), "/usr/lib64-nvidia"], parts
print("CUDA_PATH_OK")
`;
	const child = Bun.spawn([python, "-c", exercise], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	child.stdin.write(l4Setup);
	child.stdin.end();
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toContain("CUDA_PATH_OK");
}, 10_000);
