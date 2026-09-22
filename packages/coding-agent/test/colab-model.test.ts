import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@pk-nerdsaver-ai/pi-ai";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/builtin-registry";
import {
	applyColabSetup,
	buildColabCommand,
	buildRemoteSetupScript,
	COLAB_MODEL_PROFILES,
	type ColabModelLaunchResult,
	type ColabPrebuiltRuntime,
	calculateColabContextWindow,
	formatColabSetups,
	getColabAcceleratorProfile,
	getColabInferenceTimeoutSeconds,
	getColabModelProfile,
	isDiffusionGemmaModel,
	type HuggingFaceTreeEntry,
	handleColabModelSlashCommand,
	loadColabSetups,
	parseColabModelCommandArgs,
	parseHuggingFaceModelReference,
	resolveColabContextWindow,
	resolveColabSessionName,
	selectAutomaticColabAccelerators,
	selectColabPrebuiltRuntime,
	selectColabRuntimeProfile,
	selectGgufArtifact,
} from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/helpers/colab-model";
import type { SlashCommandRuntime } from "@pk-nerdsaver-ai/pi-coding-agent/slash-commands/types";
import { TaskTool } from "@pk-nerdsaver-ai/pi-coding-agent/task";
import {
	ASSIGNMENT_CONTRACT_V2_VERSION,
	ASSIGNMENT_RESULT_V2_VERSION,
	parseAssignmentContract,
	withAssignmentContractV2Digest,
} from "@pk-nerdsaver-ai/pi-coding-agent/task/assignment-contract";
import { discoverAgents } from "@pk-nerdsaver-ai/pi-coding-agent/task/discovery";
import type { ToolSession } from "@pk-nerdsaver-ai/pi-coding-agent/tools";

const QWEN_FILES: HuggingFaceTreeEntry[] = [
	{ type: "file", path: "Qwen3.8-27B-Q4_K_M.gguf", size: 17_100_000_000 },
	{ type: "file", path: "Qwen3.8-27B-Q6_K.gguf", size: 22_900_000_000 },
	{ type: "file", path: "Qwen3.8-27B-Q8_0.gguf", size: 29_500_000_000 },
	{ type: "file", path: "mmproj-Qwen3.8-27B-F16.gguf", size: 900_000_000 },
	{ type: "file", path: "Qwen3.8-27B-MTP-Q8_0.gguf", size: 800_000_000 },
];

const BONSAI_FILES: HuggingFaceTreeEntry[] = [
	{ type: "file", path: "Ternary-Bonsai-2-27B-F16.gguf", size: 53_808_408_928 },
	{ type: "file", path: "Ternary-Bonsai-2-27B-PQ2_0.gguf", size: 7_206_168_928 },
	{ type: "file", path: "Ternary-Bonsai-2-27B-PTQ1_0.gguf", size: 5_946_648_928 },
	{ type: "file", path: "Ternary-Bonsai-2-27B-mmproj-BF16.gguf", size: 931_145_856 },
	{ type: "file", path: "Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf", size: 629_246_976 },
];

const ORNITH_FILES: HuggingFaceTreeEntry[] = [
	{
		type: "file",
		path: "Huihui-Ornith-1.5-9B-abliterated.Q4_K_M.gguf",
		size: 5_700_000_000,
	},
];

function launchResult(overrides: Partial<ColabModelLaunchResult> = {}): ColabModelLaunchResult {
	return {
		accelerator: "A100",
		apiBaseUrl: "http://127.0.0.1:18081/v1",
		contextWindow: 32_768,
		maxTokens: 8_192,
		modelId: "/content/models/Qwen3.8-27B-Q6_K.gguf",
		modelName: "Qwen3.8-27B-Q6_K",
		quantization: "Q6_K",
		reasoning: false,
		repoId: "unsloth/Qwen3.8-27B-GGUF",
		runtime: { id: "upstream", repositoryUrl: "https://github.com/ggml-org/llama.cpp.git" },
		toolCallReady: true,
		sessionName: "ompk-colab-model",
		...overrides,
	};
}

async function compilePythonScript(source: string): Promise<{ exitCode: number; stderr: string }> {
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python 3 is required to compile the Colab setup script");
	const processHandle = Bun.spawn(
		[python, "-c", "import sys; compile(sys.stdin.read(), '<colab-model-setup>', 'exec')"],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	processHandle.stdin.write(source);
	processHandle.stdin.end();
	const [exitCode, stderr] = await Promise.all([processHandle.exited, new Response(processHandle.stderr).text()]);
	return { exitCode, stderr };
}

interface RemoteSetupConfig {
	cmakeArchitecture: string;
	primaryFile: string;
	modelProfile: {
		artifactFile: string;
		cachePrompt: boolean;
		chatTemplate: string;
		id: string;
		kvCacheType: string;
		physicalMicrobatch: number;
		qwenPreserveThinking: boolean;
		reasoningDisableMode: string;
	} | null;
	runtime: {
		id: string;
		directory: string;
		repositoryUrl: string;
		pinnedCommit: string | null;
		pinnedTag: string | null;
		prebuilt: ColabPrebuiltRuntime | null;
	};
}

/** Recover the remote CONFIG payload structurally (AST), so assertions target behavior rather than script text. */
async function readSetupConfig(source: string): Promise<RemoteSetupConfig> {
	const python = Bun.which("python") ?? Bun.which("python3");
	if (!python) throw new Error("Python 3 is required to inspect the Colab setup script");
	const extractor = [
		"import ast, json, sys",
		"tree = ast.parse(sys.stdin.read())",
		"for node in tree.body:",
		"    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'CONFIG' for t in node.targets):",
		"        print(json.dumps(json.loads(ast.literal_eval(node.value.args[0]))))",
		"        break",
	].join("\n");
	const processHandle = Bun.spawn([python, "-c", extractor], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	processHandle.stdin.write(source);
	processHandle.stdin.end();
	const [exitCode, stdout, stderr] = await Promise.all([
		processHandle.exited,
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return JSON.parse(stdout);
}

describe("Hugging Face Colab model references", () => {
	test("parses repository ids and explicit revisions", () => {
		expect(parseHuggingFaceModelReference("unsloth/Qwen3.8-27B-GGUF")).toEqual({
			repoId: "unsloth/Qwen3.8-27B-GGUF",
			revision: "main",
		});
		expect(parseHuggingFaceModelReference("unsloth/Qwen3.8-27B-GGUF@release")).toEqual({
			repoId: "unsloth/Qwen3.8-27B-GGUF",
			revision: "release",
		});
	});

	test("parses repository and direct GGUF URLs", () => {
		expect(parseHuggingFaceModelReference("https://huggingface.co/unsloth/Qwen3.8-27B-GGUF")).toEqual({
			repoId: "unsloth/Qwen3.8-27B-GGUF",
			revision: "main",
		});
		expect(
			parseHuggingFaceModelReference(
				"https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/blob/main/Qwen3.8-27B-Q6_K.gguf?download=true",
			),
		).toEqual({
			repoId: "unsloth/Qwen3.8-27B-GGUF",
			revision: "main",
			file: "Qwen3.8-27B-Q6_K.gguf",
		});
	});

	test("rejects non-Hugging Face and non-GGUF file URLs", () => {
		expect(() => parseHuggingFaceModelReference("https://example.com/owner/model")).toThrow("huggingface.co");
		expect(() =>
			parseHuggingFaceModelReference("https://huggingface.co/owner/model/blob/main/model.safetensors"),
		).toThrow(".gguf");
	});
});

describe("/colab-model arguments", () => {
	test("accepts explicit cheap and premium GPU selections", () => {
		expect(parseColabModelCommandArgs("--gpu T4 owner/model")).toEqual({
			accelerator: "T4",
			modelReference: "owner/model",
			sessionName: undefined,
			localPort: undefined,
			setupName: undefined,
			listSetups: false,
		});
		expect(parseColabModelCommandArgs("owner/model --gpu=l4")).toEqual({
			accelerator: "L4",
			modelReference: "owner/model",
			sessionName: undefined,
			localPort: undefined,
			setupName: undefined,
			listSetups: false,
		});
		expect(parseColabModelCommandArgs("--gpu H100 owner/model")).toEqual({
			accelerator: "H100",
			modelReference: "owner/model",
			sessionName: undefined,
			localPort: undefined,
			setupName: undefined,
			listSetups: false,
		});
	});

	test("rejects unknown GPUs and options", () => {
		expect(() => parseColabModelCommandArgs("--gpu V100 owner/model")).toThrow("Unsupported Colab GPU");
		expect(() => parseColabModelCommandArgs("--cheap owner/model")).toThrow("Unknown /colab-model option");
	});

	test("accepts isolated session and port flags", () => {
		expect(parseColabModelCommandArgs("--session ompk-colab-t4 --port 18083 owner/model")).toEqual({
			accelerator: undefined,
			modelReference: "owner/model",
			sessionName: "ompk-colab-t4",
			localPort: 18083,
			setupName: undefined,
			listSetups: false,
		});
		expect(parseColabModelCommandArgs("owner/model --session=ompk-colab-t4 --port=18083 --gpu T4")).toEqual({
			accelerator: "T4",
			modelReference: "owner/model",
			sessionName: "ompk-colab-t4",
			localPort: 18083,
			setupName: undefined,
			listSetups: false,
		});
		expect(parseColabModelCommandArgs("owner/model").sessionName).toBeUndefined();
		expect(parseColabModelCommandArgs("owner/model").localPort).toBeUndefined();
		expect(() => parseColabModelCommandArgs("--port 99999 owner/model")).toThrow("Invalid /colab-model port");
		expect(() => parseColabModelCommandArgs("--session")).toThrow("--session requires a session name.");
		expect(() => parseColabModelCommandArgs("--port")).toThrow("--port requires a port number");
	});

	test("every launch resolves a local session name", () => {
		expect(resolveColabSessionName()).toBe("ompk-colab-model");
		expect(resolveColabSessionName("")).toBe("ompk-colab-model");
		expect(resolveColabSessionName("   ")).toBe("ompk-colab-model");
		expect(resolveColabSessionName("ompk-colab-t4")).toBe("ompk-colab-t4");
		const previous = Bun.env.OMPK_COLAB_SESSION;
		try {
			Bun.env.OMPK_COLAB_SESSION = "ompk-from-env";
			expect(resolveColabSessionName()).toBe("ompk-from-env");
			expect(resolveColabSessionName("explicit")).toBe("explicit");
		} finally {
			if (previous === undefined) delete Bun.env.OMPK_COLAB_SESSION;
			else Bun.env.OMPK_COLAB_SESSION = previous;
		}
	});
});

describe("colab setups registry", () => {
	test("parses --setup and --list-setups", () => {
		expect(parseColabModelCommandArgs("--list-setups").listSetups).toBe(true);
		expect(parseColabModelCommandArgs("--setup tpu-jax-flax-aqt").setupName).toBe("tpu-jax-flax-aqt");
		expect(parseColabModelCommandArgs("--setup=tpu-jax-flax-aqt").setupName).toBe("tpu-jax-flax-aqt");
		expect(() => parseColabModelCommandArgs("--setup")).toThrow("--setup requires a setup name");
		expect(parseColabModelCommandArgs("owner/repo").setupName).toBeUndefined();
		expect(parseColabModelCommandArgs("owner/repo").listSetups).toBe(false);
	});

	test("loader returns [] without a registry and validates what it finds", async () => {
		const dir = await mkdtemp(join(tmpdir(), "colab-setups-"));
		try {
			await expect(loadColabSetups(dir)).resolves.toEqual([]);
			await mkdir(join(dir, ".ompk"), { recursive: true });
			const file = join(dir, ".ompk", "colab-setups.json");
			await writeFile(
				file,
				JSON.stringify({
					setups: [
						{ name: "demo", accelerator: "T4", model: "owner/repo", status: "verified", launch: "colab-model" },
					],
				}),
			);
			const setups = await loadColabSetups(dir);
			expect(setups.map(entry => entry.name)).toEqual(["demo"]);
			expect(formatColabSetups(setups)).toContain("demo [verified]");
			expect(formatColabSetups([])).toContain("No Colab setups configured");
			await writeFile(file, "{nope");
			await expect(loadColabSetups(dir)).rejects.toThrow("Could not load Colab setups");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("applyColabSetup fills from the setup and explicit flags win", () => {
		const setups = [
			{
				name: "demo",
				accelerator: "T4",
				model: "owner/repo",
				status: "verified" as const,
				launch: "colab-model" as const,
			},
		];
		const applied = applyColabSetup(parseColabModelCommandArgs("--setup demo"), setups);
		expect(applied.setup?.name).toBe("demo");
		expect(applied.request.modelReference).toBe("owner/repo");
		expect(applied.request.accelerator).toBe("T4");
		const explicit = applyColabSetup(parseColabModelCommandArgs("--setup demo --gpu L4 other/repo"), setups);
		expect(explicit.request.accelerator).toBe("L4");
		expect(explicit.request.modelReference).toBe("other/repo");
		expect(() => applyColabSetup(parseColabModelCommandArgs("--setup missing"), setups)).toThrow(
			'Unknown Colab setup "missing". Available: demo.',
		);
	});

	test("--list-setups prints the registry without provisioning", async () => {
		const outputs: string[] = [];
		const runtime = { output: async (message: string) => void outputs.push(message) };
		const launch: Parameters<typeof handleColabModelSlashCommand>[2] = async () => {
			throw new Error("must not launch");
		};
		const result = await handleColabModelSlashCommand(
			"--list-setups",
			runtime as unknown as Parameters<typeof handleColabModelSlashCommand>[1],
			launch,
		);
		expect(result).toEqual({ consumed: true });
		expect(outputs.join("\n")).toContain("tpu-jax-flax-aqt");
	});

	test("--setup on a manual setup prints the runbook without provisioning", async () => {
		const outputs: string[] = [];
		const runtime = { output: async (message: string) => void outputs.push(message) };
		const launch: Parameters<typeof handleColabModelSlashCommand>[2] = async () => {
			throw new Error("must not launch");
		};
		const result = await handleColabModelSlashCommand(
			"--setup tpu-jax-flax-aqt",
			runtime as unknown as Parameters<typeof handleColabModelSlashCommand>[1],
			launch,
		);
		expect(result).toEqual({ consumed: true });
		expect(outputs.join("\n")).toContain("manual");
	});
});

describe("GGUF accelerator selection", () => {
	const reference = { repoId: "unsloth/Qwen3.8-27B-GGUF", revision: "main" };

	test("selects Q6_K for A100 and Q4_K_M for L4", () => {
		expect(selectGgufArtifact(QWEN_FILES, reference, "A100").primaryFile).toBe("Qwen3.8-27B-Q6_K.gguf");
		expect(selectGgufArtifact(QWEN_FILES, reference, "L4").primaryFile).toBe("Qwen3.8-27B-Q4_K_M.gguf");
	});

	test("uses cheaper viable GPUs before A100", () => {
		expect(selectAutomaticColabAccelerators(QWEN_FILES, reference)).toEqual(["L4", "A100"]);
		const smallFiles: HuggingFaceTreeEntry[] = [{ type: "file", path: "small-Q4_K_M.gguf", size: 8_000_000_000 }];
		expect(selectAutomaticColabAccelerators(smallFiles, reference)).toEqual(["T4", "L4", "A100"]);
	});

	test("uses native-only CUDA architectures for every supported GPU", () => {
		expect(getColabAcceleratorProfile("T4").cmakeArchitecture).toBe("75-real");
		expect(getColabAcceleratorProfile("L4").cmakeArchitecture).toBe("89-real");
		expect(getColabAcceleratorProfile("A100").cmakeArchitecture).toBe("80-real");
		expect(getColabAcceleratorProfile("H100").cmakeArchitecture).toBe("90-real");
		expect(getColabAcceleratorProfile("G4").cmakeArchitecture).toBe("120-real");
	});

	test("configures default context window scaled to accelerator VRAM", () => {
		expect(getColabAcceleratorProfile("T4").defaultContextWindow).toBe(32_768);
		expect(getColabAcceleratorProfile("L4").defaultContextWindow).toBe(65_536);
		expect(getColabAcceleratorProfile("A100").defaultContextWindow).toBe(65_536);
		expect(getColabAcceleratorProfile("H100").defaultContextWindow).toBe(131_072);
		expect(getColabAcceleratorProfile("G4").defaultContextWindow).toBe(131_072);
	});

	test("uses the Ornith manifest for dynamic context and cache timing", () => {
		const reference = {
			repoId: "mradermacher/Huihui-Ornith-1.5-9B-abliterated-GGUF",
			revision: "main",
		};
		const artifact = selectGgufArtifact(ORNITH_FILES, reference, "L4");
		const profile = getColabModelProfile(reference, artifact);
		expect(profile).toEqual(COLAB_MODEL_PROFILES[0]);
		expect(profile?.artifactFile).toBe("Huihui-Ornith-1.5-9B-abliterated.Q4_K_M.gguf");
		expect(profile?.nCtxTrain).toBe(262_144);
		expect(profile?.defaultContextWindow).toBe(131_072);
		const l4Context = resolveColabContextWindow("L4", artifact, profile!);
		expect(l4Context).toBeGreaterThanOrEqual(profile!.defaultContextWindow);
		expect(l4Context).toBeLessThanOrEqual(profile!.nCtxTrain!);
		expect(selectAutomaticColabAccelerators(ORNITH_FILES, reference)).toEqual(["L4", "A100"]);
		expect(getColabInferenceTimeoutSeconds(131_072)).toBe(376);
		expect(getColabInferenceTimeoutSeconds(262_144)).toBe(632);
	});

	test("keeps every shard and uses the first shard as the llama.cpp model path", () => {
		const splitFiles: HuggingFaceTreeEntry[] = [
			{ type: "file", path: "model-Q6_K-00002-of-00003.gguf", size: 9_000_000_000 },
			{ type: "file", path: "model-Q6_K-00001-of-00003.gguf", size: 9_000_000_000 },
			{ type: "file", path: "model-Q6_K-00003-of-00003.gguf", size: 4_000_000_000 },
		];
		const artifact = selectGgufArtifact(splitFiles, reference, "A100");
		expect(artifact.primaryFile).toBe("model-Q6_K-00001-of-00003.gguf");
		expect(artifact.files).toEqual([
			"model-Q6_K-00001-of-00003.gguf",
			"model-Q6_K-00002-of-00003.gguf",
			"model-Q6_K-00003-of-00003.gguf",
		]);
		expect(artifact.totalSize).toBe(22_000_000_000);
	});

	test("honors an explicit GGUF URL even when it exceeds the automatic budget", () => {
		const artifact = selectGgufArtifact(QWEN_FILES, { ...reference, file: "Qwen3.8-27B-Q8_0.gguf" }, "L4");
		expect(artifact.primaryFile).toBe("Qwen3.8-27B-Q8_0.gguf");
		expect(artifact.quantization).toBe("Q8_0");
	});

	test("recognizes PrismML packings and prefers the larger PQ2_0 on T4", () => {
		const bonsai = { repoId: "prism-ml/Ternary-Bonsai-2-27B-gguf", revision: "main" };
		const artifact = selectGgufArtifact(BONSAI_FILES, bonsai, "T4");
		expect(artifact.primaryFile).toBe("Ternary-Bonsai-2-27B-PQ2_0.gguf");
		expect(artifact.quantization).toBe("PQ2_0");
		const explicit = selectGgufArtifact(BONSAI_FILES, { ...bonsai, file: "Ternary-Bonsai-2-27B-PTQ1_0.gguf" }, "T4");
		expect(explicit.quantization).toBe("PTQ1_0");
		expect(selectAutomaticColabAccelerators(BONSAI_FILES, bonsai)).toEqual(["T4", "L4", "A100"]);
	});
});

describe("llama.cpp runtime selection", () => {
	const bonsai = { repoId: "prism-ml/Ternary-Bonsai-2-27B-gguf", revision: "main" };
	const qwen = { repoId: "unsloth/Qwen3.8-27B-GGUF", revision: "main" };

	test("pins the PrismML fork for PQ2_0 and PTQ1_0 regardless of publisher", () => {
		for (const quantization of ["PQ2_0", "PTQ1_0"]) {
			const profile = selectColabRuntimeProfile(qwen, { quantization, primaryFile: `x-${quantization}.gguf` });
			expect(profile.id).toBe("prism");
			expect(profile.repositoryUrl).toBe("https://github.com/PrismML-Eng/llama.cpp.git");
			expect(profile.pinnedCommit).toBe("9a9394a895b96003ca842a6041cb28ac49a108f7");
			expect(profile.pinnedTag).toBe("prism-b10709-9a9394a");
			expect(profile.reasoning).toBe(true);
		}
	});
	test("pins stock llama.cpp to the validated T4 CUDA runtime for conventional quantizations", () => {
		const profile = selectColabRuntimeProfile(qwen, selectGgufArtifact(QWEN_FILES, qwen, "A100"));
		expect(profile.id).toBe("upstream");
		expect(profile.repositoryUrl).toBe("https://github.com/ggml-org/llama.cpp.git");
		expect(profile.pinnedCommit).toBe("a894dae939d426954ce54bb604824f1ae918a0c5");
		expect(profile.reasoning).toBe(false);
		const other = selectColabRuntimeProfile(
			{ repoId: "other/model" },
			{ quantization: "Q2_0", primaryFile: "m-Q2_0.gguf" },
		);
		expect(other.id).toBe("upstream");
	});

	test("rejects the deprecated prism-ml Q2_0 packing instead of falling back to stock llama.cpp", () => {
		expect(() =>
			selectColabRuntimeProfile(bonsai, { quantization: "Q2_0", primaryFile: "Ternary-Bonsai-2-27B-Q2_0.gguf" }),
		).toThrow(/Q2_0/);
	});

	test("uses the verified CUDA release only on its validated accelerator", () => {
		const profile = selectColabRuntimeProfile(bonsai, {
			quantization: "PQ2_0",
			primaryFile: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
		});
		expect(selectColabPrebuiltRuntime(profile, "T4")).toMatchObject({
			cuda: "12.4",
			sha256: "f542fdcc818562359e947db65e0b11c4658dd5ca3bd240490448252e817d8e7a",
		});
		expect(selectColabPrebuiltRuntime(profile, "A100")).toBeUndefined();
		const upstream = selectColabRuntimeProfile(qwen, { quantization: "Q4_K_M", primaryFile: "model-Q4_K_M.gguf" });
		expect(selectColabPrebuiltRuntime(upstream, "T4")).toMatchObject({
			archive: "llama-b11064-bin-ubuntu-cuda-12.8-x64.tar.gz",
			cuda: "12.8",
			directory: "/content/ompk-runtime-cache/b11064/cuda-12.8-x64",
			serverPath: "llama-b11064/llama-server",
			sha256: "658c391b6c93483960433b160975b938a727315311320dbf2ab24bae41488fb7",
			url: "https://github.com/ggml-org/llama.cpp/releases/download/b11064/llama-b11064-bin-ubuntu-cuda-12.8-x64.tar.gz",
		});
		expect(selectColabPrebuiltRuntime(upstream, "L4")).toMatchObject({
			archive: "llama-b11064-bin-ubuntu-cuda-12.8-x64.tar.gz",
			cuda: "12.8",
		});
		expect(selectColabPrebuiltRuntime(upstream, "A100")).toBeUndefined();
	});

	test("builds each runtime in its own tree with pinned checkouts", async () => {
		const bonsaiScript = buildRemoteSetupScript({
			accelerator: "T4",
			artifact: selectGgufArtifact(BONSAI_FILES, bonsai, "T4"),
			contextWindow: 32_768,
			reference: bonsai,
			remotePort: 8_081,
		});
		const qwenScript = buildRemoteSetupScript({
			accelerator: "A100",
			artifact: selectGgufArtifact(QWEN_FILES, qwen, "A100"),
			contextWindow: 32_768,
			reference: qwen,
			remotePort: 8_081,
		});
		const [bonsaiConfig, qwenConfig, compilation] = await Promise.all([
			readSetupConfig(bonsaiScript),
			readSetupConfig(qwenScript),
			compilePythonScript(bonsaiScript),
		]);
		expect(compilation.exitCode, compilation.stderr).toBe(0);
		expect(bonsaiConfig.runtime).toEqual({
			id: "prism",
			directory: "/content/prism-llama.cpp",
			repositoryUrl: "https://github.com/PrismML-Eng/llama.cpp.git",
			pinnedCommit: "9a9394a895b96003ca842a6041cb28ac49a108f7",
			pinnedTag: "prism-b10709-9a9394a",
			fetchRef: null,
			prebuilt:
				selectColabPrebuiltRuntime(
					selectColabRuntimeProfile(bonsai, {
						quantization: "PQ2_0",
						primaryFile: "Ternary-Bonsai-2-27B-PQ2_0.gguf",
					}),
					"T4",
				) ?? null,
		});
		expect(bonsaiConfig.cmakeArchitecture).toBe("75-real");
		expect(qwenConfig.runtime.id).toBe("upstream");
		expect(qwenConfig.runtime.pinnedCommit).toBe("a894dae939d426954ce54bb604824f1ae918a0c5");
		expect(qwenConfig.runtime.directory).not.toBe(bonsaiConfig.runtime.directory);
	});
	test("serializes Ornith cache and microbatch tuning into remote setup", async () => {
		const reference = {
			repoId: "mradermacher/Huihui-Ornith-1.5-9B-abliterated-GGUF",
			revision: "main",
		};
		const artifact = selectGgufArtifact(ORNITH_FILES, reference, "L4");
		const profile = getColabModelProfile(reference, artifact);
		const source = buildRemoteSetupScript({
			accelerator: "L4",
			artifact,
			contextWindow: resolveColabContextWindow("L4", artifact, profile!),
			modelProfile: profile,
			reference,
			remotePort: 8_081,
		});
		const [config, compilation] = await Promise.all([readSetupConfig(source), compilePythonScript(source)]);
		expect(compilation.exitCode, compilation.stderr).toBe(0);
		expect(config.modelProfile).toEqual({
			artifactFile: "Huihui-Ornith-1.5-9B-abliterated.Q4_K_M.gguf",
			cachePrompt: true,
			chatTemplate: "qwen-chat-template",
			id: "ornith-1.5-9b-abliterated",
			kvCacheType: "q8_0",
			maxGenerationTokens: null,
			physicalMicrobatch: 1024,
			qwenPreserveThinking: true,
			reasoningDisableMode: "qwen-template-false",
			runtime: null,
		});
	});

	test("pins diffusion runtime and validates python syntax for DiffusionGemma", async () => {
		const diffRef = {
			repoId: "unsloth/diffusiongemma-26B-A4B-it-GGUF",
			revision: "main",
		};
		const diffArtifact = {
			primaryFile: "diffusiongemma-26B-A4B-it-Q4_K_M.gguf",
			quantization: "Q4_K_M",
			files: ["diffusiongemma-26B-A4B-it-Q4_K_M.gguf"],
			totalSize: 16_800_000_000,
		};
		expect(isDiffusionGemmaModel(diffRef.repoId, diffArtifact.primaryFile)).toBe(true);
		const runtime = selectColabRuntimeProfile(diffRef, diffArtifact);
		expect(runtime.id).toBe("diffusion");
		expect(runtime.pinnedCommit).toBe("12e0a9627d02c6395fd4bbf2aadff93d0d46a0e4");
		expect(runtime.fetchRef).toBe("pull/24423/head");

		const profile = getColabModelProfile(diffRef, diffArtifact);
		expect(profile).toBeDefined();
		expect(profile?.runtime).toBe("diffusion");
		expect(profile?.defaultContextWindow).toBe(2_048);
		expect(profile?.maxGenerationTokens).toBe(1_536);

		const source = buildRemoteSetupScript({
			accelerator: "L4",
			artifact: diffArtifact,
			contextWindow: resolveColabContextWindow("L4", diffArtifact, profile!),
			modelProfile: profile,
			reference: diffRef,
			remotePort: 8_081,
		});
		const [config, compilation] = await Promise.all([readSetupConfig(source), compilePythonScript(source)]);
		expect(compilation.exitCode, compilation.stderr).toBe(0);
		expect(config.runtime.id).toBe("diffusion");
		expect(config.runtime.fetchRef).toBe("pull/24423/head");
		expect(config.modelProfile?.maxGenerationTokens).toBe(1_536);
	});
});

describe("/colab-model command", () => {
	let restoreFetch = () => {};
	beforeEach(() => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(Response.json({ data: [{ id: launchResult().modelId }] }));
		restoreFetch = () => fetchSpy.mockRestore();
	});
	afterEach(() => restoreFetch());

	test("is registered as a built-in slash command", () => {
		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("colab-model")).toBe(true);
	});

	test("uses WSL for the Colab CLI on Windows", () => {
		expect(buildColabCommand(["status", "--session", "test"], "win32")).toEqual([
			"wsl",
			"colab",
			"status",
			"--session",
			"test",
		]);
		expect(buildColabCommand(["sessions"], "linux")).toEqual(["colab", "sessions"]);
	});

	test("compiles the setup probe and verifies target selection among tools", async () => {
		const reference = parseHuggingFaceModelReference("unsloth/Qwen3.8-27B-GGUF");
		const artifact = selectGgufArtifact(QWEN_FILES, reference, "A100");
		const script = buildRemoteSetupScript({
			accelerator: "A100",
			artifact,
			contextWindow: 32_768,
			reference,
			remotePort: 8_081,
		});

		expect(script).toContain('"name": "ompk_tool_readiness_probe"');
		expect(script).toContain('"name": "ompk_decoy_probe"');
		expect(script).toContain('"tool_choice": "required"');
		expect(script).toContain('function.get("name") != "ompk_tool_readiness_probe"');
		expect(script).toContain('"toolCallReady": True');

		const compilation = await compilePythonScript(script);
		expect(compilation.exitCode, compilation.stderr).toBe(0);
	});

	test("registers the warmed endpoint and selects the runtime model", async () => {
		const output = vi.fn();
		const registerProvider = vi.fn();
		const selectedModel = {
			provider: "llama.cpp (colab)",
			id: "/content/models/Qwen3.8-27B-Q6_K.gguf",
		} as Model<Api>;
		const find = vi.fn(() => selectedModel);
		const setModel = vi.fn(async () => {});
		const runtime = {
			output,
			notifyConfigChanged: vi.fn(async () => {}),
			notifyTitleChanged: vi.fn(async () => {}),
			session: {
				modelRegistry: { registerProvider, find },
				setModel,
			},
		} as unknown as SlashCommandRuntime;
		const launch = vi.fn(async () => launchResult());
		await handleColabModelSlashCommand("--gpu A100 unsloth/Qwen3.8-27B-GGUF", runtime, launch);
		expect(launch).toHaveBeenCalledWith("unsloth/Qwen3.8-27B-GGUF", expect.any(Function), {
			accelerator: "A100",
			sessionName: undefined,
			localPort: undefined,
		});

		expect(registerProvider).toHaveBeenCalledTimes(1);
		expect(registerProvider.mock.calls[0]?.[0]).toBe("llama.cpp (colab)");
		expect(registerProvider.mock.calls[0]?.[1]).toMatchObject({
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:18081/v1",
			models: [
				{
					id: "/content/models/Qwen3.8-27B-Q6_K.gguf",
					name: "Qwen3.8-27B-Q6_K · Colab A100",
					supportsTools: true,
				},
			],
		});
		expect(find).toHaveBeenCalledWith("llama.cpp (colab)", selectedModel.id);
		expect(setModel).toHaveBeenCalledWith(selectedModel);
		expect(output).toHaveBeenLastCalledWith(expect.stringContaining("Colab model ready: llama.cpp (colab)/"));
	});

	test("replaces a stale launch id with the bridge live alias before registration and selection", async () => {
		const directory = await mkdtemp(join(tmpdir(), "colab-live-alias-"));
		const auth = await AuthStorage.create(":memory:");
		const result = launchResult({ modelId: "stale-model.gguf", modelName: "stale-model" });
		const liveId = "Qwen3.8-live-Q6_K.gguf";
		const fetchMock = globalThis.fetch as unknown as {
			mockResolvedValueOnce: (response: Response) => void;
		};
		fetchMock.mockResolvedValueOnce(Response.json({ data: [{ id: liveId }, { id: "unused-second-alias" }] }));
		try {
			const registry = new ModelRegistry(auth, join(directory, "models.yml"));
			const registerProvider = vi.spyOn(registry, "registerProvider");
			const find = vi.spyOn(registry, "find");
			const setModel = vi.fn(async (_model: Model<Api>) => {});
			const output = vi.fn();
			const runtime = { output, session: { modelRegistry: registry, setModel } } as unknown as SlashCommandRuntime;
			await handleColabModelSlashCommand(result.repoId, runtime, async () => result);
			expect(globalThis.fetch).toHaveBeenCalledWith(`${result.apiBaseUrl}/models`, {
				signal: expect.any(AbortSignal),
			});
			expect(registerProvider).toHaveBeenCalledWith(
				"llama.cpp (colab)",
				expect.objectContaining({
					baseUrl: result.apiBaseUrl,
					api: "openai-completions",
					apiKey: "N/A",
					models: [
						expect.objectContaining({ id: liveId, name: "Qwen3.8-live-Q6_K · Colab A100", supportsTools: true }),
					],
				}),
				"builtin://colab-model",
			);
			expect(find).toHaveBeenCalledWith("llama.cpp (colab)", liveId);
			expect(setModel).toHaveBeenCalledTimes(1);
			expect(setModel).toHaveBeenCalledWith(registry.find("llama.cpp (colab)", liveId));
			expect(registry.find("llama.cpp (colab)", result.modelId)).toBeUndefined();
			expect(output).toHaveBeenLastCalledWith(
				expect.stringContaining(`Colab model ready: llama.cpp (colab)/${liveId}`),
			);
			registerProvider.mockRestore();
			find.mockRestore();
		} finally {
			auth.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test.each([
		["HTTP failure", () => Response.json({ error: "unavailable" }, { status: 503 })],
		["empty model list", () => Response.json({ data: [] })],
		["invalid model id", () => Response.json({ data: [{ id: 42 }] })],
	])("does not register a stale id after a live model probe %s", async (_label, response) => {
		const fetchMock = globalThis.fetch as unknown as {
			mockResolvedValueOnce: (response: Response) => void;
		};
		fetchMock.mockResolvedValueOnce(response());
		const registerProvider = vi.fn();
		const setModel = vi.fn();
		const output = vi.fn();
		const runtime = {
			output,
			session: { modelRegistry: { registerProvider }, setModel },
		} as unknown as SlashCommandRuntime;
		await handleColabModelSlashCommand("owner/model", runtime, async () => launchResult());
		expect(registerProvider).not.toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Colab model launch failed:"));
	});

	test("registers Colab separately without changing a local llama.cpp model with the same id", async () => {
		const directory = await mkdtemp(join(tmpdir(), "colab-provider-"));
		const auth = await AuthStorage.create(":memory:");
		try {
			const registry = new ModelRegistry(auth, join(directory, "models.yml"));
			const result = launchResult();
			registry.registerProvider(
				"llama.cpp",
				{
					api: "openai-completions",
					baseUrl: "http://127.0.0.1:8080/v1",
					apiKey: "N/A",
					models: [
						{
							id: result.modelId,
							name: "Local model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: result.contextWindow,
							maxTokens: result.maxTokens,
						},
					],
				},
				"test://local-llama",
			);
			const localModel = registry.find("llama.cpp", result.modelId);
			expect(localModel).toBeDefined();
			let selected: Model<Api> | undefined;
			const runtime = {
				output: vi.fn(),
				session: {
					modelRegistry: registry,
					setModel: async (model: Model<Api>) => {
						selected = model;
					},
				},
			} as unknown as SlashCommandRuntime;

			const liveSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(Response.json({ data: [{ id: result.modelId }] }));
			try {
				await handleColabModelSlashCommand(result.repoId, runtime, async () => result);
			} finally {
				liveSpy.mockRestore();
			}

			const colabModel = registry.find("llama.cpp (colab)", result.modelId);
			expect(colabModel).toMatchObject({ provider: "llama.cpp (colab)", baseUrl: result.apiBaseUrl });
			expect(selected).toBe(colabModel);
			expect(registry.find("llama.cpp", result.modelId)).toEqual(localModel);
			expect(registry.find("llama.cpp", result.modelId)?.baseUrl).toBe("http://127.0.0.1:8080/v1");
		} finally {
			auth.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("repeated registration reconciles the configured Colab model without duplicate picker entries", async () => {
		const directory = await mkdtemp(join(tmpdir(), "colab-configured-"));
		const auth = await AuthStorage.create(":memory:");
		try {
			const result = launchResult({
				apiBaseUrl: "http://127.0.0.1:18082/v1",
				contextWindow: 65_536,
				maxTokens: 8_192,
			});
			const modelsPath = join(directory, "models.yml");
			const configText = JSON.stringify({
				providers: {
					"llama.cpp (colab)": {
						api: "openai-completions",
						baseUrl: result.apiBaseUrl,
						auth: "none",
						models: [{ id: result.modelId, name: "Configured Colab", contextWindow: 65_536, maxTokens: 8_192 }],
					},
				},
			});
			await Bun.write(modelsPath, configText);
			const registry = new ModelRegistry(auth, modelsPath);
			expect(registry.getError()).toBeUndefined();
			expect(registry.find("llama.cpp (colab)", result.modelId)?.baseUrl).toBe(result.apiBaseUrl);
			let selected: Model<Api> | undefined;
			const runtime = {
				output: async () => {},
				session: {
					modelRegistry: registry,
					setModel: async (model: Model<Api>) => {
						selected = model;
					},
				},
			} as unknown as SlashCommandRuntime;
			const liveSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(Response.json({ data: [{ id: result.modelId }] }));
			try {
				await handleColabModelSlashCommand(result.repoId, runtime, async () => result);
				await handleColabModelSlashCommand(result.repoId, runtime, async () => result);
			} finally {
				liveSpy.mockRestore();
			}
			const matches = registry
				.getAll()
				.filter(model => model.provider === "llama.cpp (colab)" && model.id === result.modelId);
			expect(matches).toHaveLength(1);
			expect(matches[0]).toMatchObject({ baseUrl: result.apiBaseUrl, contextWindow: 65_536, maxTokens: 8_192 });
			expect(selected).toBe(matches[0]);
			expect(await Bun.file(modelsPath).text()).toBe(configText);
		} finally {
			auth.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("does not register a model when tool-call readiness is missing", async () => {
		const output = vi.fn();
		const registerProvider = vi.fn();
		const setModel = vi.fn(async () => {});
		const runtime = {
			output,
			session: {
				modelRegistry: { registerProvider },
				setModel,
			},
		} as unknown as SlashCommandRuntime;
		const { toolCallReady: _missing, ...missingReadiness } = launchResult();
		const launch = vi.fn(async () => missingReadiness as ColabModelLaunchResult);

		await handleColabModelSlashCommand("unsloth/Qwen3.8-27B-GGUF", runtime, launch);

		expect(registerProvider).not.toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();
		expect(output).toHaveBeenLastCalledWith(expect.stringContaining("tool-call readiness"));
	});

	test("does not register a model when readiness is malformed", async () => {
		const output = vi.fn();
		const registerProvider = vi.fn();
		const setModel = vi.fn(async () => {});
		const runtime = {
			output,
			session: {
				modelRegistry: { registerProvider },
				setModel,
			},
		} as unknown as SlashCommandRuntime;
		const launch = vi.fn(async () => launchResult({ toolCallReady: false }));

		await handleColabModelSlashCommand("unsloth/Qwen3.8-27B-GGUF", runtime, launch);

		expect(registerProvider).not.toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();
		expect(output).toHaveBeenLastCalledWith(expect.stringContaining("tool-call readiness"));
	});

	test("reports usage without launching when the model reference is missing", async () => {
		const output = vi.fn();
		const launch = vi.fn(async () => launchResult());
		const runtime = { output } as unknown as SlashCommandRuntime;

		await handleColabModelSlashCommand(" ", runtime, launch);

		expect(launch).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(expect.stringContaining("Usage: /colab-model"));
	});

	test("non-Gemini model registers, becomes active root Agent, exposes enabled discovered lanes under root spawns, and enforces AssignmentContract", async () => {
		let registeredProvider: { name: string; getModels: () => Model<Api>[] } | undefined;
		let activeModel: Model<Api> | undefined;

		const models: Model<Api>[] = [];
		const registerProvider = vi.fn((name: string, providerConfig: any) => {
			registeredProvider = { name, ...providerConfig };
			if (Array.isArray(providerConfig.models)) {
				for (const m of providerConfig.models) {
					models.push({
						provider: name,
						id: m.id,
						name: m.name,
						api: providerConfig.api,
						supportsTools: m.supportsTools,
						contextWindow: m.contextWindow,
						maxTokens: m.maxTokens,
						input: m.input,
						cost: m.cost,
					} as unknown as Model<Api>);
				}
			}
		});
		const find = vi.fn((provider: string, modelId: string) =>
			models.find(m => m.provider === provider && m.id === modelId),
		);
		const setModel = vi.fn(async (model: Model<Api>) => {
			activeModel = model;
		});
		const output = vi.fn();
		const settings = Settings.isolated();
		const sharedSession = {
			cwd: process.cwd(),
			settings,
			modelRegistry: { registerProvider, find },
			setModel,
			get model() {
				return activeModel;
			},
			getSessionSpawns: () => "*",
			getSessionFile: () => "/tmp/test-session.json",
			taskDepth: 0,
		} as unknown as ToolSession & SlashCommandRuntime["session"];

		const runtime = {
			output,
			session: sharedSession,
		} as unknown as SlashCommandRuntime;

		const launch = vi.fn(async () => launchResult());
		await handleColabModelSlashCommand("unsloth/Qwen3.8-27B-GGUF", runtime, launch);

		expect(registeredProvider).toBeDefined();
		expect(registeredProvider?.name).toBe("llama.cpp (colab)");
		expect(activeModel).toBeDefined();
		expect(activeModel?.provider).toBe("llama.cpp (colab)");
		expect(activeModel?.id).toBe("/content/models/Qwen3.8-27B-Q6_K.gguf");
		expect(activeModel?.supportsTools).toBe(true);

		const taskTool = await TaskTool.create(sharedSession as ToolSession);
		const description = taskTool.description;

		const { agents } = await discoverAgents(sharedSession.cwd);
		const disabledAgents = sharedSession.settings.get("task.disabledAgents") as string[];
		const enabledAgents = agents.filter(a => !disabledAgents.includes(a.name));

		expect(enabledAgents.length).toBeGreaterThan(0);
		for (const agent of enabledAgents) {
			expect(description).toContain(`# ${agent.name}`);
		}

		const invalidContract = {
			version: ASSIGNMENT_CONTRACT_V2_VERSION,
			id: "test-lane",
			revision: 1,
			role: "Lane explorer",
			workClass: "judgment",
			autonomy: "supervised",
			objective: "Explore lane requirements",
			deliverables: ["findings.md"],
			scope: { allowedPaths: ["**"] },
			acceptance: [{ id: "c1", description: "check", check: "artifact_exists", params: { path: "findings.md" } }],
			reporting: ASSIGNMENT_RESULT_V2_VERSION,
			digest: "invalid-digest",
		};
		const parseResult = parseAssignmentContract(invalidContract);
		expect(parseResult.ok).toBe(false);
		if (!parseResult.ok) {
			expect(parseResult.diagnostics.some(d => d.code === "digest_mismatch")).toBe(true);
		}

		const validContract = withAssignmentContractV2Digest({
			version: ASSIGNMENT_CONTRACT_V2_VERSION,
			id: "test-lane",
			revision: 1,
			role: "Lane explorer",
			workClass: "judgment",
			autonomy: "supervised",
			objective: "Explore lane requirements",
			deliverables: ["findings.md"],
			scope: { allowedPaths: ["**"] },
			acceptance: [{ id: "c1", description: "check", check: "artifact_exists", params: { path: "findings.md" } }],
			reporting: ASSIGNMENT_RESULT_V2_VERSION,
		});
		const validParse = parseAssignmentContract(validContract);
		expect(validParse.ok).toBe(true);
	});
});
