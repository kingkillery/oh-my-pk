import { errorMessage } from "./parse";
import {
	buildColabCommand,
	fetchHuggingFaceGgufs,
	parseHuggingFaceModelReference,
	selectColabPrebuiltRuntime,
	selectColabRuntimeProfile,
	type ColabAccelerator,
	type GgufArtifact,
	type HuggingFaceModelReference,
	type HuggingFaceTreeEntry,
} from "./colab-model";
import type { SlashCommandRuntime } from "../types";

const DEFAULT_CACHE_SESSION_NAME = "colab-pkherdr";
const CACHE_PREFIX = "ompk-colab-cache/v1";
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;
const PROGRESS_PREFIX = "__OMPK_COLAB_CACHE_PROGRESS__";
const READY_PREFIX = "__OMPK_COLAB_CACHE_READY__";

export interface ColabModelCacheRequest {
	accelerator: ColabAccelerator;
	file: string;
	modelReference: string;
	sessionName?: string;
}

export interface ColabModelCacheResult {
	artifact: GgufArtifact;
	bucket: string;
	repoId: string;
	revision: string;
	runtimeArchive: string;
	runtimeSha256: string;
	sessionName: string;
}

interface CommandResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

type StatusEmitter = (message: string) => Promise<void> | void;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function normalizeAccelerator(value: string): ColabAccelerator {
	const normalized = value.toUpperCase();
	if (normalized === "T4" || normalized === "L4" || normalized === "A100" || normalized === "H100" || normalized === "G4") {
		return normalized;
	}
	throw new Error(`Unsupported Colab GPU "${value}". Choose T4, L4, A100, H100, or G4.`);
}

export function parseColabModelCacheCommandArgs(input: string): ColabModelCacheRequest {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const modelTokens: string[] = [];
	let accelerator: ColabAccelerator = "L4";
	let file = "";
	let sessionName: string | undefined;
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "stage") continue;
		if (token === "--gpu") {
			const value = tokens[index + 1];
			if (!value) throw new Error("--gpu requires T4, L4, A100, H100, or G4.");
			accelerator = normalizeAccelerator(value);
			index += 1;
			continue;
		}
		if (token.startsWith("--gpu=")) {
			accelerator = normalizeAccelerator(token.slice("--gpu=".length));
			continue;
		}
		if (token === "--file") {
			file = tokens[index + 1] ?? "";
			if (!file) throw new Error("--file requires the exact GGUF filename.");
			index += 1;
			continue;
		}
		if (token.startsWith("--file=")) {
			file = token.slice("--file=".length);
			if (!file) throw new Error("--file requires the exact GGUF filename.");
			continue;
		}
		if (token === "--session") {
			sessionName = tokens[index + 1] ?? "";
			if (!sessionName) throw new Error("--session requires a CPU session name.");
			index += 1;
			continue;
		}
		if (token.startsWith("--session=")) {
			sessionName = token.slice("--session=".length);
			if (!sessionName) throw new Error("--session requires a CPU session name.");
			continue;
		}
		if (token.startsWith("--")) throw new Error(`Unknown /colab-model-cache option "${token}".`);
		modelTokens.push(token);
	}
	if (modelTokens.length !== 1) throw new Error("Expected one Hugging Face GGUF repository or URL.");
	if (!file) throw new Error("--file is required so a baseline artifact is pinned explicitly.");
	return { accelerator, file, modelReference: modelTokens[0], sessionName };
}

function artifactForFile(entries: readonly HuggingFaceTreeEntry[], reference: HuggingFaceModelReference, file: string): GgufArtifact {
	const exact = entries.find(entry => entry.path === file);
	if (!exact) throw new Error(`${file} was not found in ${reference.repoId}@${reference.revision}.`);
	const groupKey = file.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, "-SPLIT");
	const grouped = entries
		.filter(entry => entry.path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, "-SPLIT") === groupKey)
		.sort((left, right) => left.path.localeCompare(right.path));
	const primaryFile = grouped[0]?.path;
	if (!primaryFile) throw new Error(`No GGUF artifact group was found for ${file}.`);
	const leafNames = new Set(grouped.map(entry => entry.path.split("/").at(-1)!));
	if (leafNames.size !== grouped.length) throw new Error(`GGUF split group ${file} has ambiguous file names.`);
	const quantization = primaryFile.toUpperCase().match(/(?:^|[-_.])((?:IQ|PTQ|PQ|Q)\d(?:_[A-Z0-9]+)+|BF16|F16)(?:[-_.]|$)/)?.[1] ?? "UNKNOWN";
	return {
		files: grouped.map(entry => entry.path),
		primaryFile,
		quantization,
		totalSize: grouped.reduce((total, entry) => total + entry.size, 0),
	};
}

function cacheBucket(): string {
	const bucket = Bun.env.OMPK_GCS_MODEL_BUCKET?.trim() || Bun.env.GCS_BUCKET?.trim();
	if (!bucket?.startsWith("gs://")) {
		throw new Error("Set OMPK_GCS_MODEL_BUCKET to a gs:// bucket before staging persistent Colab artifacts.");
	}
	return bucket.replace(/\/+$/, "");
}

export async function resolveImmutableHuggingFaceRevision(
	reference: HuggingFaceModelReference,
	fetchImpl: FetchLike = globalThis.fetch,
): Promise<HuggingFaceModelReference> {
	const repoPath = reference.repoId.split("/").map(segment => encodeURIComponent(segment)).join("/");
	const response = await fetchImpl(
		`https://huggingface.co/api/models/${repoPath}/revision/${encodeURIComponent(reference.revision)}`,
		{ headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) },
	);
	if (!response.ok) throw new Error(`Hugging Face returned ${response.status} while resolving ${reference.repoId}@${reference.revision}.`);
	const payload: unknown = await response.json();
	if (!payload || typeof payload !== "object" || !("sha" in payload) || typeof payload.sha !== "string" || !/^[a-f0-9]{40}$/i.test(payload.sha)) {
		throw new Error(`Hugging Face did not return an immutable revision for ${reference.repoId}@${reference.revision}.`);
	}
	return { ...reference, revision: payload.sha };
}

async function readCommandStream(stream: ReadableStream<Uint8Array>, onChunk?: (chunk: string) => Promise<void> | void): Promise<string> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let output = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		if (output.length < MAX_COMMAND_OUTPUT) output += chunk.slice(0, MAX_COMMAND_OUTPUT - output.length);
		await onChunk?.(chunk);
	}
	return output + decoder.decode();
}

async function runColab(args: readonly string[], options: { input?: string; onStdout?: (chunk: string) => Promise<void> | void; timeoutMs: number }): Promise<CommandResult> {
	const processHandle = Bun.spawn({
		cmd: buildColabCommand(args),
		stdin: options.input === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (options.input !== undefined) {
		const stdin = processHandle.stdin;
		if (!stdin) throw new Error("Colab command stdin pipe was not created.");
		stdin.write(options.input);
		stdin.end();
	}
	const timeout = setTimeout(() => processHandle.kill(), options.timeoutMs);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			readCommandStream(processHandle.stdout, options.onStdout),
			readCommandStream(processHandle.stderr),
			processHandle.exited,
		]);
		return { exitCode, stderr, stdout };
	} finally {
		clearTimeout(timeout);
	}
}

function parseAccelerator(output: string): ColabAccelerator | undefined {
	for (const accelerator of ["T4", "L4", "A100", "H100", "G4"] as const) {
		if (new RegExp(`\\b${accelerator}\\b`, "i").test(output)) return accelerator;
	}
	return undefined;
}

export async function ensureCpuColabSession(
	sessionName: string,
	emit: StatusEmitter,
	runCommand: typeof runColab = runColab,
): Promise<void> {
	const status = await runCommand(["status", "--session", sessionName], { timeoutMs: 60_000 });
	if (status.exitCode === 0) {
		const accelerator = parseAccelerator(`${status.stdout}\n${status.stderr}`);
		if (accelerator) throw new Error(`${sessionName} is already using ${accelerator}; cache staging refuses to reuse a GPU runtime.`);
		await emit(`Colab cache: reusing CPU session ${sessionName}.`);
		return;
	}
	await emit(`Colab cache: requesting CPU session ${sessionName}…`);
	const launch = await runCommand(["new", "--session", sessionName], { timeoutMs: 5 * 60_000 });
	if (launch.exitCode !== 0) throw new Error(`Could not acquire CPU Colab session ${sessionName}: ${launch.stderr || launch.stdout}`);
	const launchedAccelerator = parseAccelerator(`${launch.stdout}\n${launch.stderr}`);
	if (launchedAccelerator) {
		throw new Error(`${sessionName} launched with ${launchedAccelerator}; cache staging refuses to use a GPU runtime.`);
	}
	// A successful launch without --gpu does not prove that Colab allocated a CPU runtime.
	const acquiredStatus = await runCommand(["status", "--session", sessionName], { timeoutMs: 60_000 });
	if (acquiredStatus.exitCode !== 0) {
		throw new Error(`Could not verify CPU Colab session ${sessionName}: ${acquiredStatus.stderr || acquiredStatus.stdout}`);
	}
	const acquiredAccelerator = parseAccelerator(`${acquiredStatus.stdout}\n${acquiredStatus.stderr}`);
	if (acquiredAccelerator) {
		throw new Error(`${sessionName} launched with ${acquiredAccelerator}; cache staging refuses to use a GPU runtime.`);
	}
	await emit(`Colab cache: acquired CPU session ${sessionName}.`);
}

function parseMarkedJson<T>(output: string, prefix: string): T | undefined {
	for (const line of output.split(/\r?\n/)) {
		if (!line.startsWith(prefix)) continue;
		try {
			return JSON.parse(line.slice(prefix.length)) as T;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function createProgressParser(emit: StatusEmitter): (chunk: string) => Promise<void> {
	let buffered = "";
	return async chunk => {
		buffered += chunk;
		const lines = buffered.split(/\r?\n/);
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			const payload = parseMarkedJson<{ message?: string }>(line, PROGRESS_PREFIX);
			if (payload?.message) await emit(`Colab cache: ${payload.message}…`);
		}
	};
}

export function buildColabModelCacheStageScript(config: {
	artifact: GgufArtifact;
	bucket: string;
	reference: HuggingFaceModelReference;
	runtime: { archive: string; sha256: string; url: string; id: string };
}): string {
	return `import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

CONFIG = json.loads(${JSON.stringify(JSON.stringify(config))})
PROGRESS_PREFIX = ${JSON.stringify(PROGRESS_PREFIX)}
READY_PREFIX = ${JSON.stringify(READY_PREFIX)}
CACHE_PREFIX = ${JSON.stringify(CACHE_PREFIX)}


def progress(message):
    print(PROGRESS_PREFIX + json.dumps({"message": message}), flush=True)


def sha256_of(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(args, timeout=7200, capture=False):
    completed = subprocess.run(args, text=True, stdout=subprocess.PIPE if capture else subprocess.DEVNULL, stderr=subprocess.PIPE if capture else subprocess.DEVNULL, timeout=timeout)
    if completed.returncode:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"command failed ({completed.returncode}): {' '.join(args)}{': ' + detail[-2000:] if detail else ''}")
    return completed


def gcs_hash(uri):
    process = subprocess.Popen(["gsutil", "cat", uri], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    digest = hashlib.sha256()
    assert process.stdout is not None
    for chunk in iter(lambda: process.stdout.read(1 << 20), b""):
        digest.update(chunk)
    stderr = process.stderr.read().decode(errors="replace") if process.stderr else ""
    if process.wait() != 0:
        raise RuntimeError(f"could not verify {uri}: {stderr[-2000:]}")
    return digest.hexdigest()


def gcs_store(source, uri, expected):
    if sha256_of(source) != expected:
        raise RuntimeError(f"local checksum changed before upload: {source.name}")
    progress(f"uploading {source.name} to persistent GCS")
    run(["gsutil", "cp", str(source), uri])
    actual = gcs_hash(uri)
    if actual != expected:
        raise RuntimeError(f"persistent checksum mismatch for {uri}: {actual}")


def cache_key(value):
    return value.replace("/", "--").replace("@", "--at--")


def main():
    bucket = CONFIG["bucket"].rstrip("/")
    reference = CONFIG["reference"]
    artifact = CONFIG["artifact"]
    repo_key = cache_key(reference["repoId"])
    revision_key = cache_key(reference["revision"])
    with tempfile.TemporaryDirectory(prefix="ompk-colab-cache-") as folder:
        root = Path(folder)
        try:
            from huggingface_hub import snapshot_download
        except ImportError:
            run([sys.executable, "-m", "pip", "install", "--quiet", "huggingface_hub"])
            from huggingface_hub import snapshot_download
        progress(f"downloading {reference['repoId']}@{reference['revision']}")
        snapshot_download(repo_id=reference["repoId"], revision=reference["revision"], allow_patterns=artifact["files"], local_dir=str(root / "model"))
        files = []
        for name in artifact["files"]:
            source = root / "model" / name
            if not source.is_file():
                raise FileNotFoundError(source)
            digest = sha256_of(source)
            uri = f"{bucket}/{CACHE_PREFIX}/models/{repo_key}/{revision_key}/{Path(name).name}/{digest}"
            gcs_store(source, uri, digest)
            files.append({"name": name, "sha256": digest, "uri": uri, "size": source.stat().st_size})
        runtime = CONFIG["runtime"]
        archive = root / runtime["archive"]
        progress(f"downloading {runtime['archive']}")
        with urllib.request.urlopen(runtime["url"], timeout=120) as response, archive.open("wb") as handle:
            shutil.copyfileobj(response, handle, 1 << 20)
        if sha256_of(archive) != runtime["sha256"]:
            raise RuntimeError(f"runtime archive checksum mismatch: {runtime['archive']}")
        runtime_uri = f"{bucket}/{CACHE_PREFIX}/runtimes/{runtime['id']}/{runtime['archive']}/{runtime['sha256']}"
        gcs_store(archive, runtime_uri, runtime["sha256"])
        manifest = {
            "version": 1,
            "repoId": reference["repoId"],
            "revision": reference["revision"],
            "primaryFile": artifact["primaryFile"],
            "files": files,
            "runtime": {"id": runtime["id"], "archive": runtime["archive"], "sha256": runtime["sha256"], "uri": runtime_uri},
        }
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, sort_keys=True))
        manifest_uri = f"{bucket}/{CACHE_PREFIX}/manifests/{repo_key}/{revision_key}/{Path(artifact['primaryFile']).name}.json"
        progress("publishing verified artifact manifest")
        run(["gsutil", "cp", str(manifest_path), manifest_uri])
        print(READY_PREFIX + json.dumps({"manifestUri": manifest_uri, "runtimeUri": runtime_uri}), flush=True)


if __name__ == "__main__":
    main()
`;
}

export async function stageColabModelCache(modelReference: string, emit: StatusEmitter, options: Omit<ColabModelCacheRequest, "modelReference">): Promise<ColabModelCacheResult> {
	const requestedReference = parseHuggingFaceModelReference(modelReference);
	if (requestedReference.file && requestedReference.file !== options.file) {
		throw new Error("The GGUF URL and --file must identify the same artifact.");
	}
	const reference = await resolveImmutableHuggingFaceRevision(requestedReference);
	const entries = await fetchHuggingFaceGgufs(reference);
	const artifact = artifactForFile(entries, reference, options.file);
	const runtime = selectColabRuntimeProfile(reference, artifact);
	const prebuilt = selectColabPrebuiltRuntime(runtime, options.accelerator);
	if (!prebuilt) throw new Error(`${options.accelerator} has no verified prebuilt ${runtime.id} llama.cpp archive to stage; choose T4 or L4.`);
	const bucket = cacheBucket();
	const sessionName = options.sessionName ?? (Bun.env.OMPK_COLAB_CACHE_SESSION?.trim() || DEFAULT_CACHE_SESSION_NAME);
	await ensureCpuColabSession(sessionName, emit);
	await emit(`Colab cache: staging ${artifact.primaryFile} and ${prebuilt.archive} for ${options.accelerator}.`);
	const result = await runColab(["exec", "--session", sessionName, "--timeout", "7200"], {
		input: buildColabModelCacheStageScript({
			artifact,
			bucket,
			reference,
			runtime: { archive: prebuilt.archive, id: runtime.id, sha256: prebuilt.sha256, url: prebuilt.url },
		}),
		onStdout: createProgressParser(emit),
		timeoutMs: 2 * 60 * 60_000,
	});
	if (result.exitCode !== 0) throw new Error(`Colab cache staging failed: ${result.stderr || result.stdout}`);
	if (!parseMarkedJson(result.stdout, READY_PREFIX)) throw new Error(`Colab cache staging completed without a verified manifest: ${result.stdout || result.stderr}`);
	return {
		artifact,
		bucket,
		repoId: reference.repoId,
		revision: reference.revision,
		runtimeArchive: prebuilt.archive,
		runtimeSha256: prebuilt.sha256,
		sessionName,
	};
}

export async function handleColabModelCacheSlashCommand(args: string, runtime: SlashCommandRuntime): Promise<{ consumed: true }> {
	try {
		const request = parseColabModelCacheCommandArgs(args);
		const result = await stageColabModelCache(request.modelReference, message => runtime.output(message), request);
		await runtime.output([
			"Colab cache staging complete.",
			`${result.repoId} ${result.artifact.primaryFile} (${result.artifact.quantization})`,
			`Pinned model revision: ${result.revision}`,
			`Warm with: /colab-model --gpu ${request.accelerator} ${result.repoId}@${result.revision}`,
			`Verified runtime archive: ${result.runtimeArchive}`,
			`Persistent bucket: ${result.bucket}`,
			`CPU session: ${result.sessionName}`,
		].join("\n"));
	} catch (error) {
		await runtime.output(`Colab cache staging failed: ${errorMessage(error)}`);
	}
	return { consumed: true };
}
