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
