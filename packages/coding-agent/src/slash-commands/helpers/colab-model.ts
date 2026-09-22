import os from "node:os";
import path from "node:path";
import type { Server } from "bun";
import { kNoAuth } from "../../config/model-registry";
import type { SlashCommandRuntime } from "../types";
import { startPersistentColabBridge } from "./colab-persistent-bridge";

const DEFAULT_SESSION_NAME = "ompk-colab-model";
const DEFAULT_LOCAL_PORT = 18_082;
const DEFAULT_MAX_TOKENS = 8_192;
const DEFAULT_REMOTE_PORT = 8_081;
const RUNTIME_PROVIDER = "llama.cpp (colab)";
const RUNTIME_SOURCE_ID = "builtin://colab-model";
const PROGRESS_PREFIX = "__OMPK_COLAB_PROGRESS__";
const READY_PREFIX = "__OMPK_COLAB_READY__";
const HTTP_PREFIX = "__OMPK_COLAB_HTTP__";
const TOOL_READINESS_FUNCTION = "ompk_tool_readiness_probe";
const TOOL_READINESS_DECOY_FUNCTION = "ompk_decoy_probe";
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;

export type ColabAccelerator = "T4" | "L4" | "A100" | "H100" | "G4";

export interface ColabAcceleratorProfile {
	cmakeArchitecture: string;
	defaultContextWindow: number;
	modelSizeBudget: number;
	preferredQuantizations: readonly string[];
	/** Total accelerator memory used by model-aware context sizing. */
	vramBytes: number;
}

const ACCELERATOR_PROFILES: Record<ColabAccelerator, ColabAcceleratorProfile> = {
	T4: {
		cmakeArchitecture: "75-real",
		defaultContextWindow: 32_768,
		modelSizeBudget: 12_000_000_000,
		preferredQuantizations: ["Q3_K_M", "Q3_K_S", "IQ4_XS", "Q4_K_S", "Q4_K_M"],
		vramBytes: 16 * 1024 ** 3,
	},
	L4: {
		cmakeArchitecture: "89-real",
		defaultContextWindow: 65_536,
		modelSizeBudget: 18_000_000_000,
		preferredQuantizations: ["Q4_K_M", "Q4_K_S", "IQ4_XS", "Q3_K_M", "Q3_K_S", "Q5_K_M"],
		vramBytes: 24 * 1024 ** 3,
	},
	A100: {
		cmakeArchitecture: "80-real",
		defaultContextWindow: 65_536,
		modelSizeBudget: 28_000_000_000,
		preferredQuantizations: ["Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M", "Q4_K_S", "Q8_0"],
		vramBytes: 40 * 1024 ** 3,
	},
	H100: {
		cmakeArchitecture: "90-real",
		defaultContextWindow: 131_072,
		modelSizeBudget: 60_000_000_000,
		preferredQuantizations: ["Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M"],
		vramBytes: 80 * 1024 ** 3,
	},
	G4: {
		cmakeArchitecture: "120-real",
		defaultContextWindow: 131_072,
		modelSizeBudget: 72_000_000_000,
		preferredQuantizations: ["Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M"],
		vramBytes: 96 * 1024 ** 3,
	},
};

export interface ColabModelProfile {
	id: string;
	repoId: string;
	artifactFile: string;
	/**
	 * Maximum context supported by the model training configuration. Required
	 * together with `kvBytesPerToken` for VRAM-derived sizing; fixed-size
	 * diffusion profiles omit both.
	 */
	nCtxTrain?: number;
	defaultContextWindow: number;
	/** Q8 KV bytes per token for both K and V, from the model architecture. Undefined for fixed-size profiles. */
	kvBytesPerToken?: number;
	/** Runtime lane this profile was validated on; undefined means the upstream stock `llama-server` lane. */
	runtime?: ColabRuntimeProfileId;
	/**
	 * Validated per-request generation ceiling. Diffusion canvases allocate
	 * compute for the full generation, so this is an OOM bound, not a policy.
	 */
	maxGenerationTokens?: number;
	chatTemplate?: "qwen-chat-template";
	reasoningDisableMode?: "qwen-template-false";
	qwenPreserveThinking?: boolean;
	kvCacheType?: "q8_0";
	physicalMicrobatch?: 1024 | 2048;
	cachePrompt?: boolean;
}

/** Persisted launch manifest for models with validated serving parameters. */
export const COLAB_MODEL_PROFILES: readonly ColabModelProfile[] = [
	{
		id: "ornith-1.5-9b-abliterated",
		repoId: "mradermacher/Huihui-Ornith-1.5-9B-abliterated-GGUF",
		artifactFile: "Huihui-Ornith-1.5-9B-abliterated.Q4_K_M.gguf",
		nCtxTrain: 262_144,
		defaultContextWindow: 131_072,
		// Ornith-1.5-9B: 36 layers × 8 KV heads × 128 head dimension × 2 (K/V).
		kvBytesPerToken: 73_728,
		chatTemplate: "qwen-chat-template",
		reasoningDisableMode: "qwen-template-false",
		qwenPreserveThinking: true,
		kvCacheType: "q8_0",
		physicalMicrobatch: 1024,
		cachePrompt: true,
	},
	{
		// Validated on a Colab L4 (23 GB) against llama.cpp PR #24423
		// @ 12e0a962: one-shot -p generations completed at -n 256/1024/1536;
		// -n 2048 aborts during KV allocation. Diffusion canvases size compute
		// for the full generation (ubatch == n_ctx), so the context budget is
		// fixed, not KV-derived.
		id: "diffusiongemma-26b-a4b",
		repoId: "unsloth/diffusiongemma-26B-A4B-it-GGUF",
		artifactFile: "diffusiongemma-26B-A4B-it-Q4_K_M.gguf",
		defaultContextWindow: 2_048,
		runtime: "diffusion",
		maxGenerationTokens: 1_536,
	},
];

const AUTOMATIC_ACCELERATORS: readonly ColabAccelerator[] = ["T4", "L4", "A100"];

export function getColabAcceleratorProfile(accelerator: ColabAccelerator): ColabAcceleratorProfile {
	return ACCELERATOR_PROFILES[accelerator];
}

export function getColabModelProfile(
	reference: Pick<HuggingFaceModelReference, "repoId">,
	artifact: Pick<GgufArtifact, "primaryFile">,
): ColabModelProfile | undefined {
	const repoId = reference.repoId.toLowerCase();
	const artifactFile = artifact.primaryFile.split("/").pop()?.toLowerCase();
	return COLAB_MODEL_PROFILES.find(
		profile => profile.repoId.toLowerCase() === repoId && profile.artifactFile.toLowerCase() === artifactFile,
	);
}

export function calculateColabContextWindow(
	accelerator: ColabAccelerator,
	artifact: Pick<GgufArtifact, "totalSize">,
	profile: ColabModelProfile & { kvBytesPerToken: number; nCtxTrain: number },
): number {
	const availableBytes = getColabAcceleratorProfile(accelerator).vramBytes * 0.85 - artifact.totalSize;
	const calculated = Math.floor(availableBytes / profile.kvBytesPerToken);
	if (calculated < 1_024) {
		throw new Error(`The ${accelerator} does not have enough reserved VRAM for ${profile.id} context.`);
	}
	return Math.min(profile.nCtxTrain, calculated);
}

/**
 * Context budget for a launch. KV-sized profiles derive it from free VRAM;
 * fixed-size profiles (diffusion lanes, where compute scales with the whole
 * generation instead of KV) use their validated constant unchanged.
 */
export function resolveColabContextWindow(
	accelerator: ColabAccelerator,
	artifact: Pick<GgufArtifact, "totalSize">,
	profile: ColabModelProfile,
): number {
	if (profile.kvBytesPerToken === undefined || profile.nCtxTrain === undefined) {
		return profile.defaultContextWindow;
	}
	return calculateColabContextWindow(accelerator, artifact, profile as ColabModelProfile & { kvBytesPerToken: number; nCtxTrain: number });
}

export function getColabInferenceTimeoutSeconds(contextWindow: number): number {
	if (!Number.isInteger(contextWindow) || contextWindow < 1) throw new Error("Context window must be positive.");
	return Math.min(900, Math.max(300, 120 + Math.ceil(contextWindow / 512)));
}

export interface HuggingFaceModelReference {
	repoId: string;
	revision: string;
	file?: string;
}

export interface HuggingFaceTreeEntry {
	type: "file";
	path: string;
	size: number;
}

export interface GgufArtifact {
	files: string[];
	primaryFile: string;
	quantization: string;
	totalSize: number;
}

export type ColabRuntimeProfileId = "upstream" | "prism" | "diffusion";

/** How the serving `llama-server` was obtained on the VM. */
export type ColabRuntimeSource = "prebuilt" | "source";

const RUNTIME_CACHE_ROOT = "/content/ompk-runtime-cache";

/**
 * Publisher release archive validated end to end on one accelerator.
 * Restored (download → SHA-256 → data-filtered untar → `--version` commit →
 * `ldd`) instead of compiling the pinned checkout on that accelerator.
 */
export interface ColabPrebuiltRuntime {
	/** Release asset file name, also the cached archive name under `directory`. */
	archive: string;
	/** CUDA toolkit the archive links against; host libraries must satisfy it (checked via `ldd`). */
	cuda: string;
	/** VM cache directory holding the archive, `unpacked/`, and the `runtime.json` manifest. */
	directory: string;
	/** `llama-server` location relative to `directory/unpacked`. */
	serverPath: string;
	/** Hex SHA-256 of the archive; cached and downloaded copies are rejected on mismatch. */
	sha256: string;
	url: string;
}

/** Source checkout that produces the remote `llama-server` binary. */
export interface ColabRuntimeProfile {
	id: ColabRuntimeProfileId;
	/** Checkout directory on the Colab VM; each profile owns its own tree and build. */
	directory: string;
	repositoryUrl: string;
	/** Exact commit to build. Undefined builds the default branch head. */
	pinnedCommit?: string;
	/** Release tag matching `pinnedCommit`, for status output only. */
	pinnedTag?: string;
	/**
	 * Git refspec to fetch when the pinned commit lives only on a pull request
	 * (e.g. `pull/24423/head`). The checkout is still verified against
	 * `pinnedCommit`, so a moved pull request fails loudly instead of drifting.
	 */
	fetchRef?: string;
	/** Validated release archives keyed by the accelerator they were verified on.
	 * Accelerators without an entry compile `pinnedCommit` from source.
	 */
	prebuilt?: Partial<Record<ColabAccelerator, ColabPrebuiltRuntime>>;
	/** GGUF packings that only this runtime can load. */
	requiredQuantizations: readonly string[];
	/** Models served by this runtime think by default (per publisher model card). */
	reasoning: boolean;
}

const UPSTREAM_REPOSITORY = "https://github.com/ggml-org/llama.cpp";
const UPSTREAM_TAG = "b11064";

/**
 * Official ggml-org release archive. CI builds these without
 * `CMAKE_CUDA_ARCHITECTURES`, so they carry the broad default arch set from
 * `ggml/src/ggml-cuda/CMakeLists.txt` (`75-virtual` covers Turing via PTX JIT,
 * `86-real`/`89-real` cover Ampere/Ada) and unpack to `llama-<tag>/`.
 */
function upstreamReleaseArchive(cuda: string, sha256: string): ColabPrebuiltRuntime {
	const archive = `llama-${UPSTREAM_TAG}-bin-ubuntu-cuda-${cuda}-x64.tar.gz`;
	return {
		archive,
		cuda,
		directory: `${RUNTIME_CACHE_ROOT}/${UPSTREAM_TAG}/cuda-${cuda}-x64`,
		serverPath: `llama-${UPSTREAM_TAG}/llama-server`,
		sha256,
		url: `${UPSTREAM_REPOSITORY}/releases/download/${UPSTREAM_TAG}/${archive}`,
	};
}

/**
 * Stock llama.cpp for ordinary GGUF packings.
 *
 * The pinned commit is the one tagged `b11064`, so the published release
 * archive and a source fallback build byte-identical provenance: the remote
 * setup script only adopts a prebuilt whose `--version` commit prefixes
 * `pinnedCommit`.
 *
 * The CUDA 12.8 archive is pinned for T4 and L4: Colab's T4 image ships
 * CUDA 12.8 (`libcudart.so.12.8.90`), and the release contains native 89-real
 * kernels for L4. The setup validates checksum, `--version`, `ldd`, health,
 * generation, and tool readiness before returning the provider endpoint. Any
 * host incompatibility falls back to the pinned source build.
 */
const UPSTREAM_RUNTIME: ColabRuntimeProfile = {
	id: "upstream",
	directory: "/content/llama.cpp",
	repositoryUrl: `${UPSTREAM_REPOSITORY}.git`,
	// Validated Colab T4 CUDA runtime.
	pinnedCommit: "a894dae939d426954ce54bb604824f1ae918a0c5",
	pinnedTag: UPSTREAM_TAG,
	prebuilt: {
		T4: upstreamReleaseArchive("12.8", "658c391b6c93483960433b160975b938a727315311320dbf2ab24bae41488fb7"),
		L4: upstreamReleaseArchive("12.8", "658c391b6c93483960433b160975b938a727315311320dbf2ab24bae41488fb7"),
	},
	requiredQuantizations: [],
	reasoning: false,
};

const PRISM_REPOSITORY = "https://github.com/PrismML-Eng/llama.cpp";
const PRISM_TAG = "prism-b10709-9a9394a";

function prismReleaseArchive(cuda: string, sha256: string): ColabPrebuiltRuntime {
	const archive = `llama-${PRISM_TAG}-bin-linux-cuda-${cuda}-x64.tar.gz`;
	return {
		archive,
		cuda,
		directory: `${RUNTIME_CACHE_ROOT}/${PRISM_TAG}/cuda-${cuda}-x64`,
		serverPath: `llama-${PRISM_TAG}/llama-server`,
		sha256,
		url: `${PRISM_REPOSITORY}/releases/download/${PRISM_TAG}/${archive}`,
	};
}

/**
 * PrismML ternary kernels (PQ2_0 / PTQ1_0 + Hadamard activation transform).
 * Stock llama.cpp rejects both packings; the publisher's Bonsai-demo pins this
 * release (lightweight tag → commit verified via `git ls-remote`).
 *
 * The CUDA 12.4 release archive is pinned per accelerator only where it was
 * verified with real generation and tool calls on that hardware: T4 and L4
 * (L4 verified 2026-09-20: visible text generation "KERNELS OK" plus a
 * constrained tool call with Ternary-Bonsai-2-27B-PQ2_0, sm_89). Other
 * accelerators keep building the pinned commit for their own CUDA architecture.
 */
const PRISM_RUNTIME: ColabRuntimeProfile = {
	id: "prism",
	directory: "/content/prism-llama.cpp",
	repositoryUrl: `${PRISM_REPOSITORY}.git`,
	pinnedCommit: "9a9394a895b96003ca842a6041cb28ac49a108f7",
	pinnedTag: PRISM_TAG,
	prebuilt: {
		T4: prismReleaseArchive("12.4", "f542fdcc818562359e947db65e0b11c4658dd5ca3bd240490448252e817d8e7a"),
		L4: prismReleaseArchive("12.4", "f542fdcc818562359e947db65e0b11c4658dd5ca3bd240490448252e817d8e7a"),
	},
	requiredQuantizations: ["PQ2_0", "PTQ1_0"],
	reasoning: true,
};

const DIFFUSION_PR = "pull/24423/head";

/**
 * DiffusionGemma support from llama.cpp PR #24423. The architecture ships only
 * `llama-diffusion-cli`: stock `llama-server` in this tree cannot run
 * diffusion models (upstream deliberately has no diffusion server), so the
 * remote lane serves the CLI behind a small OpenAI-compatible wrapper process.
 *
 * The pinned commit is the head validated end to end on a Colab L4 (three
 * one-shot generations, rc=0, 2026-09-22). The PR ref is fetched because the
 * commit exists only on the pull request; the checkout is verified against the
 * pin, so a moved PR fails loudly. No prebuilt: community binary bundles are
 * not publisher artifacts. Build target is `llama-diffusion-cli`.
 */
const DIFFUSION_RUNTIME: ColabRuntimeProfile = {
	id: "diffusion",
	directory: "/content/diffusion-llama.cpp",
	repositoryUrl: `${UPSTREAM_REPOSITORY}.git`,
	pinnedCommit: "12e0a9627d02c6395fd4bbf2aadff93d0d46a0e4",
	pinnedTag: "pr24423-diffusiongemma",
	fetchRef: DIFFUSION_PR,
	requiredQuantizations: [],
	reasoning: false,
};

const PRISM_PUBLISHER = "prism-ml";

export interface ColabRuntimeSummary {
	id: ColabRuntimeProfileId;
	/** Commit actually serving on the VM, as reported by the remote setup script. */
	commit?: string;
	pinnedTag?: string;
	repositoryUrl: string;
	/** Serving `llama-server` path on the VM, as reported by the remote setup script. */
	server?: string;
	/** Whether the VM restored a validated release archive or compiled the checkout. */
	source?: ColabRuntimeSource;
}

export interface ColabModelLaunchResult {
	accelerator: ColabAccelerator;
	apiBaseUrl: string;
	contextWindow: number;
	chatTemplate?: "qwen-chat-template";
	reasoningDisableMode?: "qwen-template-false";
	qwenPreserveThinking?: boolean;
	maxTokens: number;
	modelId: string;
	modelName: string;
	quantization: string;
	repoId: string;
	/** True when the runtime profile marks the model as thinking by default. */
	reasoning: boolean;
	runtime: ColabRuntimeSummary;
	sessionName: string;
	/** True only after the remote runtime emitted a valid synthetic tool call. */
	toolCallReady: boolean;
}
export interface ColabModelCommandRequest {
	accelerator?: ColabAccelerator;
	modelReference: string;
	sessionName?: string;
	localPort?: number;
	setupName?: string;
	listSetups?: boolean;
}

interface CommandResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

interface RemoteReadyPayload {
	contextWindow: number;
	modelId: string;
	modelName: string;
	port: number;
	/** Commit of the serving binary: verified `--version` output for a prebuilt, git HEAD for a source build. */
	runtimeCommit?: string;
	/** Serving `llama-server` path on the VM. */
	runtimeServer?: string;
	runtimeSource?: ColabRuntimeSource;
	toolCallReady: boolean;
}

interface HttpMetadata {
	headers?: Record<string, string>;
	status: number;
}
interface ColabModelLaunchOptions {
	accelerator?: ColabAccelerator;
	fetch?: typeof globalThis.fetch;
	sessionName?: string;
	localPort?: number;
}

type StatusEmitter = (message: string) => Promise<void> | void;

let activeBridge: Server<undefined> | undefined;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function encodeRepoPath(repoId: string): string {
	return repoId
		.split("/")
		.map(segment => encodeURIComponent(segment))
		.join("/");
}

function parseRepoId(value: string): { repoId: string; revision: string } {
	const revisionSeparator = value.lastIndexOf("@");
	const repoId = (revisionSeparator > 0 ? value.slice(0, revisionSeparator) : value).replace(/^\/+|\/+$/g, "");
	const revision = revisionSeparator > 0 ? value.slice(revisionSeparator + 1) : "main";
	const segments = repoId.split("/");
	if (segments.length !== 2 || segments.some(segment => segment.length === 0)) {
		throw new Error(`Expected a Hugging Face model id like owner/repository, received "${value}".`);
	}
	if (!revision) {
		throw new Error("The Hugging Face revision after @ cannot be empty.");
	}
	return { repoId, revision };
}

export function parseHuggingFaceModelReference(input: string): HuggingFaceModelReference {
	const value = input.trim();
	if (!value) {
		throw new Error("A Hugging Face model id or URL is required.");
	}

	if (!/^https?:\/\//i.test(value)) {
		return parseRepoId(value);
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`Invalid Hugging Face URL: ${value}`);
	}
	if (url.hostname !== "huggingface.co" && url.hostname !== "www.huggingface.co") {
		throw new Error(`Expected a huggingface.co URL, received ${url.hostname}.`);
	}
	const segments = url.pathname
		.split("/")
		.filter(Boolean)
		.map(segment => decodeURIComponent(segment));
	if (segments.length < 2) {
		throw new Error(`Hugging Face URL does not identify a model repository: ${value}`);
	}
	const repoId = `${segments[0]}/${segments[1]}`;
	if (segments.length === 2) {
		return { repoId, revision: "main" };
	}
	const view = segments[2];
	if (view === "blob" || view === "resolve") {
		if (segments.length < 5) {
			throw new Error(`Hugging Face file URL is missing a GGUF path: ${value}`);
		}
		const file = segments.slice(4).join("/");
		if (!file.toLowerCase().endsWith(".gguf")) {
			throw new Error(`Hugging Face file URL must point to a .gguf file: ${value}`);
		}
		return { repoId, revision: segments[3], file };
	}
	if (view === "tree") {
		return { repoId, revision: segments[3] || "main" };
	}
	throw new Error(`Unsupported Hugging Face model URL: ${value}`);
}

function normalizeAccelerator(value: string): ColabAccelerator {
	const normalized = value.toUpperCase();
	if (normalized in ACCELERATOR_PROFILES) return normalized as ColabAccelerator;
	throw new Error(`Unsupported Colab GPU "${value}". Choose T4, L4, A100, H100, or G4.`);
}

export function parseColabModelCommandArgs(input: string): ColabModelCommandRequest {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const modelTokens: string[] = [];
	let accelerator: ColabAccelerator | undefined;
	let sessionName: string | undefined;
	let localPort: number | undefined;
	let setupName: string | undefined;
	let listSetups = false;
	const parsePort = (raw: string): number => {
		if (!/^\d+$/.test(raw)) throw new Error(`Invalid /colab-model port "${raw}". Expected 1-65535.`);
		const port = Number(raw);
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			throw new Error(`Invalid /colab-model port "${raw}". Expected 1-65535.`);
		}
		return port;
	};
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
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
		if (token === "--session") {
			const value = tokens[index + 1];
			if (!value) throw new Error("--session requires a session name.");
			sessionName = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--session=")) {
			const value = token.slice("--session=".length);
			if (!value) throw new Error("--session requires a session name.");
			sessionName = value;
			continue;
		}
		if (token === "--port") {
			const value = tokens[index + 1];
			if (!value) throw new Error("--port requires a port number 1-65535.");
			localPort = parsePort(value);
			index += 1;
			continue;
		}
		if (token.startsWith("--port=")) {
			localPort = parsePort(token.slice("--port=".length));
			continue;
		}
		if (token === "--setup") {
			const value = tokens[index + 1];
			if (!value) throw new Error("--setup requires a setup name. See /colab-model --list-setups.");
			setupName = value;
			index += 1;
			continue;
		}
		if (token.startsWith("--setup=")) {
			const value = token.slice("--setup=".length);
			if (!value) throw new Error("--setup requires a setup name. See /colab-model --list-setups.");
			setupName = value;
			continue;
		}
		if (token === "--list-setups") {
			listSetups = true;
			continue;
		}
		if (token.startsWith("--")) throw new Error(`Unknown /colab-model option "${token}".`);
		modelTokens.push(token);
	}
	if (modelTokens.length > 1) {
		throw new Error("Expected one Hugging Face model id or URL.");
	}
	return { accelerator, modelReference: modelTokens[0] ?? "", sessionName, localPort, setupName, listSetups };
}

export const COLAB_SETUPS_FILENAME = "colab-setups.json";

export type ColabSetupStatus = "verified" | "degraded" | "spike" | "unverified";

export interface ColabSetup {
	name: string;
	accelerator: string;
	model: string;
	session?: string;
	status: ColabSetupStatus;
	launch: "colab-model" | "manual";
	verified?: string;
	notes?: string;
}

const COLAB_SETUP_STATUSES: readonly string[] = ["verified", "degraded", "spike", "unverified"];

function parseColabSetup(value: unknown): ColabSetup {
	if (typeof value !== "object" || value === null) {
		throw new Error("Colab setup entries must be objects with a name.");
	}
	const entry = value as Record<string, unknown>;
	if (typeof entry.name !== "string" || !entry.name) {
		throw new Error("Colab setup entries must have a name.");
	}
	if (typeof entry.model !== "string" || !entry.model) {
		throw new Error(`Colab setup "${entry.name}" must have a model.`);
	}
	if (typeof entry.accelerator !== "string" || !entry.accelerator) {
		throw new Error(`Colab setup "${entry.name}" must have an accelerator.`);
	}
	const status = entry.status ?? "unverified";
	if (typeof status !== "string" || !COLAB_SETUP_STATUSES.includes(status)) {
		throw new Error(`Colab setup "${entry.name}" has unknown status "${String(status)}".`);
	}
	const launch = entry.launch ?? "manual";
	if (launch !== "colab-model" && launch !== "manual") {
		throw new Error(`Colab setup "${entry.name}" has unknown launch "${String(launch)}".`);
	}
	return {
		name: entry.name,
		accelerator: entry.accelerator,
		model: entry.model,
		...(typeof entry.session === "string" && entry.session ? { session: entry.session } : {}),
		status: status as ColabSetupStatus,
		launch,
		...(typeof entry.verified === "string" ? { verified: entry.verified } : {}),
		...(typeof entry.notes === "string" ? { notes: entry.notes } : {}),
	};
}

/**
 * Walk up from cwd looking for `.ompk/colab-setups.json` (project registry).
 * Returns undefined when no registry exists — setups are optional.
 */
export async function findColabSetupsFile(cwd: string = process.cwd()): Promise<string | undefined> {
	let dir = path.resolve(cwd);
	const home = os.homedir();
	for (;;) {
		const candidate = path.join(dir, ".ompk", COLAB_SETUPS_FILENAME);
		if (await Bun.file(candidate).exists()) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir || dir === home) return undefined;
		dir = parent;
	}
}

/**
 * Load the setups registry. Empty when no registry file exists; throws when
 * the file exists but is unreadable or malformed (fail loud, never silently
 * launch the wrong setup).
 */
export async function loadColabSetups(cwd: string = process.cwd()): Promise<ColabSetup[]> {
	const file = await findColabSetupsFile(cwd);
	if (!file) return [];
	let payload: unknown;
	try {
		payload = await Bun.file(file).json();
	} catch (error) {
		throw new Error(`Could not load Colab setups from ${file}: ${errorMessage(error)}`);
	}
	const setups = (payload as { setups?: unknown } | null)?.setups;
	if (setups === undefined) return [];
	if (!Array.isArray(setups)) {
		throw new Error(`Colab setups file ${file} must hold { "setups": [...] }.`);
	}
	try {
		return setups.map(entry => parseColabSetup(entry));
	} catch (error) {
		throw new Error(`Invalid Colab setup in ${file}: ${errorMessage(error)}`);
	}
}

/** One-line-per-setup listing for /colab-model --list-setups. */
export function formatColabSetups(setups: ColabSetup[]): string {
	if (setups.length === 0) {
		return "No Colab setups configured. Add .ompk/colab-setups.json to register one.";
	}
	const lines = [`Colab setups (${setups.length}):`];
	for (const setup of setups) {
		lines.push(
			`- ${setup.name} [${setup.status}] — ${setup.accelerator} — ${setup.model}${setup.session ? ` (session ${setup.session})` : ""}${setup.launch === "manual" ? " (manual)" : ""}`,
		);
		if (setup.notes) lines.push(`    ${setup.notes}`);
	}
	return lines.join("\n");
}

/**
 * Fill launch defaults from a named setup. Explicit CLI flags always win;
 * unknown names throw listing what exists.
 */
export function applyColabSetup(
	request: ColabModelCommandRequest,
	setups: ColabSetup[],
): { request: ColabModelCommandRequest; setup?: ColabSetup } {
	if (!request.setupName) return { request };
	const setup = setups.find(entry => entry.name === request.setupName);
	if (!setup) {
		const available = setups.map(entry => entry.name).join(", ") || "(none configured)";
		throw new Error(
			`Unknown Colab setup "${request.setupName}". Available: ${available}. See /colab-model --list-setups.`,
		);
	}
	let accelerator = request.accelerator;
	if (!accelerator && setup.launch === "colab-model") {
		try {
			accelerator = normalizeAccelerator(setup.accelerator);
		} catch {
			throw new Error(
				`Colab setup "${setup.name}" accelerator "${setup.accelerator}" is not launchable via /colab-model.`,
			);
		}
	}
	return {
		request: {
			...request,
			accelerator,
			modelReference: request.modelReference || setup.model,
			sessionName: request.sessionName ?? setup.session,
		},
		setup,
	};
}

function isTreeEntry(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export async function fetchHuggingFaceGgufs(
	reference: HuggingFaceModelReference,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<HuggingFaceTreeEntry[]> {
	const treeUrl = new URL(
		`https://huggingface.co/api/models/${encodeRepoPath(reference.repoId)}/tree/${encodeURIComponent(reference.revision)}`,
	);
	treeUrl.searchParams.set("recursive", "true");
	treeUrl.searchParams.set("expand", "false");
	treeUrl.searchParams.set("limit", "1000");
	const response = await fetchImpl(treeUrl, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(
			`Hugging Face returned ${response.status} while listing ${reference.repoId}@${reference.revision}. Public GGUF repositories are supported; gated repositories are not forwarded credentials.`,
		);
	}
	const payload: unknown = await response.json();
	if (!Array.isArray(payload)) {
		throw new Error(`Hugging Face returned an invalid file listing for ${reference.repoId}.`);
	}
	const entries: HuggingFaceTreeEntry[] = [];
	for (const value of payload) {
		if (!isTreeEntry(value) || value.type !== "file" || typeof value.path !== "string") continue;
		if (!value.path.toLowerCase().endsWith(".gguf")) continue;
		entries.push({
			type: "file",
			path: value.path,
			size: typeof value.size === "number" && Number.isFinite(value.size) ? value.size : 0,
		});
	}
	if (entries.length === 0) {
		throw new Error(`${reference.repoId}@${reference.revision} does not contain any GGUF files.`);
	}
	return entries;
}

function splitGroupKey(file: string): string {
	return file.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, "-SPLIT");
}

function extractQuantization(file: string): string {
	const match = file.toUpperCase().match(/(?:^|[-_.])((?:IQ|PTQ|PQ|Q)\d(?:_[A-Z0-9]+)+|BF16|F16)(?:[-_.]|$)/);
	return match?.[1] ?? "UNKNOWN";
}

function isPrimaryModelFile(file: string): boolean {
	const lower = file.toLowerCase();
	return (
		!lower.includes("mmproj") && !lower.includes("-mtp") && !lower.includes("draft") && !lower.includes("speculative")
	);
}

export function selectGgufArtifact(
	entries: readonly HuggingFaceTreeEntry[],
	reference: HuggingFaceModelReference,
	accelerator: ColabAccelerator,
): GgufArtifact {
	const byGroup = new Map<string, HuggingFaceTreeEntry[]>();
	for (const entry of entries) {
		const groupKey = splitGroupKey(entry.path);
		const group = byGroup.get(groupKey) ?? [];
		group.push(entry);
		byGroup.set(groupKey, group);
	}

	const toArtifact = (group: HuggingFaceTreeEntry[]): GgufArtifact => {
		const sorted = [...group].sort((left, right) => left.path.localeCompare(right.path));
		return {
			files: sorted.map(entry => entry.path),
			primaryFile: sorted[0].path,
			quantization: extractQuantization(sorted[0].path),
			totalSize: sorted.reduce((total, entry) => total + entry.size, 0),
		};
	};

	if (reference.file) {
		const exact = entries.find(entry => entry.path === reference.file);
		if (!exact) {
			throw new Error(`${reference.file} was not found in ${reference.repoId}@${reference.revision}.`);
		}
		return toArtifact(byGroup.get(splitGroupKey(exact.path)) ?? [exact]);
	}

	const artifacts = [...byGroup.values()].filter(group => isPrimaryModelFile(group[0].path)).map(toArtifact);
	const profile = getColabAcceleratorProfile(accelerator);
	const fitting = artifacts.filter(
		artifact => artifact.totalSize === 0 || artifact.totalSize <= profile.modelSizeBudget,
	);
	if (fitting.length === 0) {
		const smallest = artifacts.reduce<GgufArtifact | undefined>(
			(current, artifact) => (!current || artifact.totalSize < current.totalSize ? artifact : current),
			undefined,
		);
		throw new Error(
			`No GGUF in ${reference.repoId} fits the ${accelerator} launch budget (${Math.round(profile.modelSizeBudget / 1_000_000_000)} GB). Smallest candidate is ${smallest ? `${(smallest.totalSize / 1_000_000_000).toFixed(1)} GB` : "unknown"}. Pass a direct GGUF file URL to override automatic selection.`,
		);
	}
	const preferred = profile.preferredQuantizations;
	fitting.sort((left, right) => {
		const leftRank = preferred.indexOf(left.quantization);
		const rightRank = preferred.indexOf(right.quantization);
		const normalizedLeftRank = leftRank === -1 ? preferred.length : leftRank;
		const normalizedRightRank = rightRank === -1 ? preferred.length : rightRank;
		if (normalizedLeftRank !== normalizedRightRank) return normalizedLeftRank - normalizedRightRank;
		return right.totalSize - left.totalSize;
	});
	return fitting[0];
}

export function selectAutomaticColabAccelerators(
	entries: readonly HuggingFaceTreeEntry[],
	reference: HuggingFaceModelReference,
): ColabAccelerator[] {
	return AUTOMATIC_ACCELERATORS.filter(accelerator => {
		try {
			const artifact = selectGgufArtifact(entries, reference, accelerator);
			const profile = getColabModelProfile(reference, artifact);
			if (profile && resolveColabContextWindow(accelerator, artifact, profile) < profile.defaultContextWindow)
				return false;
			return true;
		} catch {
			return false;
		}
	});
}

/**
 * DiffusionGemma family marker in either the repository id or the GGUF file
 * name; matched on a normalized lowercase form so `Diffusion-Gemma`,
 * `diffusiongemma`, and `DiffusionGemma` all route identically.
 */
export function isDiffusionGemmaModel(repoId: string, primaryFile: string): boolean {
	return /diffusion[-_]?gemma/i.test(`${repoId} ${primaryFile}`);
}

/**
 * Pick the llama.cpp source tree that can load the selected GGUF.
 *
 * DiffusionGemma models require the PR #24423 diffusion tree regardless of
 * publisher: stock llama.cpp in any other tree rejects the `diffusion-gemma`
 * architecture. PQ2_0 / PTQ1_0 require the PrismML fork regardless of
 * publisher. A bare `Q2_0` file from a prism-ml repository is the deprecated
 * pre-migration packing: stock llama.cpp loads it silently and emits garbage,
 * and current fork binaries refuse it, so it is rejected instead of falling
 * back.
 */
export function selectColabRuntimeProfile(
	reference: Pick<HuggingFaceModelReference, "repoId">,
	artifact: Pick<GgufArtifact, "quantization" | "primaryFile">,
): ColabRuntimeProfile {
	if (isDiffusionGemmaModel(reference.repoId, artifact.primaryFile)) return DIFFUSION_RUNTIME;
	if (PRISM_RUNTIME.requiredQuantizations.includes(artifact.quantization)) return PRISM_RUNTIME;
	const publisher = reference.repoId.split("/")[0]?.toLowerCase();
	if (publisher === PRISM_PUBLISHER && artifact.quantization === "Q2_0") {
		throw new Error(
			`${artifact.primaryFile} uses the deprecated ${PRISM_PUBLISHER} Q2_0 packing that stock llama.cpp loads without validation. Pick a PQ2_0 or PTQ1_0 GGUF from ${reference.repoId} instead.`,
		);
	}
	return UPSTREAM_RUNTIME;
}

/**
 * Release archive to restore for this profile on this accelerator, if one was
 * validated there. Requires a pinned commit so the archive's reported build can
 * be checked against known provenance; everything else compiles from source.
 */
export function selectColabPrebuiltRuntime(
	profile: ColabRuntimeProfile,
	accelerator: ColabAccelerator,
): ColabPrebuiltRuntime | undefined {
	if (!profile.pinnedCommit) return undefined;
	return profile.prebuilt?.[accelerator];
}

function summarizeRuntime(
	profile: ColabRuntimeProfile,
	ready?: Pick<RemoteReadyPayload, "runtimeCommit" | "runtimeServer" | "runtimeSource">,
): ColabRuntimeSummary {
	return {
		id: profile.id,
		commit: ready?.runtimeCommit ?? profile.pinnedCommit,
		pinnedTag: profile.pinnedTag,
		repositoryUrl: profile.repositoryUrl,
		server: ready?.runtimeServer,
		source: ready?.runtimeSource,
	};
}

export function buildColabCommand(args: readonly string[], platform = process.platform): string[] {
	const override = Bun.env.OMPK_COLAB_CLI?.trim();
	if (override) return [override, ...args];
	return platform === "win32" ? ["wsl", "colab", ...args] : ["colab", ...args];
}

async function readCommandStream(
	stream: ReadableStream<Uint8Array>,
	onChunk?: (chunk: string) => Promise<void> | void,
): Promise<string> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let output = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		if (output.length < MAX_COMMAND_OUTPUT) {
			output += chunk.slice(0, MAX_COMMAND_OUTPUT - output.length);
		}
		await onChunk?.(chunk);
	}
	const final = decoder.decode();
	if (output.length < MAX_COMMAND_OUTPUT) output += final.slice(0, MAX_COMMAND_OUTPUT - output.length);
	if (final) await onChunk?.(final);
	return output;
}

async function runCommand(
	args: readonly string[],
	options: {
		input?: string;
		onStdout?: (chunk: string) => Promise<void> | void;
		timeoutMs: number;
	},
): Promise<CommandResult> {
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
	for (const accelerator of Object.keys(ACCELERATOR_PROFILES) as ColabAccelerator[]) {
		if (new RegExp(`\\b${accelerator}\\b`, "i").test(output)) return accelerator;
	}
	return undefined;
}

async function ensureColabSession(
	sessionName: string,
	accelerators: readonly ColabAccelerator[],
	requestedAccelerator: ColabAccelerator | undefined,
	emit: StatusEmitter,
): Promise<ColabAccelerator> {
	const status = await runCommand(["status", "--session", sessionName], { timeoutMs: 60_000 });
	const existingAccelerator =
		status.exitCode === 0 ? parseAccelerator(`${status.stdout}\n${status.stderr}`) : undefined;
	if (existingAccelerator) {
		if (requestedAccelerator && existingAccelerator !== requestedAccelerator) {
			throw new Error(
				`${sessionName} is already using ${existingAccelerator}; stop it before requesting ${requestedAccelerator}.`,
			);
		}
		await emit(`Colab: reusing ${sessionName} on ${existingAccelerator}.`);
		return existingAccelerator;
	}

	let lastFailure = "";
	for (const accelerator of accelerators) {
		await emit(`Colab: requesting ${accelerator} runtime…`);
		const launch = await runCommand(["new", "--session", sessionName, "--gpu", accelerator], {
			timeoutMs: 5 * 60_000,
		});
		if (launch.exitCode === 0) return parseAccelerator(`${launch.stdout}\n${launch.stderr}`) ?? accelerator;
		lastFailure = launch.stderr || launch.stdout;
		const recoveredStatus = await runCommand(["status", "--session", sessionName], { timeoutMs: 60_000 });
		const recoveredAccelerator =
			recoveredStatus.exitCode === 0
				? parseAccelerator(`${recoveredStatus.stdout}\n${recoveredStatus.stderr}`)
				: undefined;
		if (recoveredAccelerator) {
			if (requestedAccelerator && recoveredAccelerator !== requestedAccelerator) {
				throw new Error(
					`${sessionName} is already using ${recoveredAccelerator}; stop it before requesting ${requestedAccelerator}.`,
				);
			}
			return recoveredAccelerator;
		}
	}
	throw new Error(
		`Could not acquire a ${accelerators.join(", ")} Colab runtime${lastFailure ? `: ${lastFailure}` : "."}`,
	);
}

function pythonJson(value: unknown): string {
	return JSON.stringify(JSON.stringify(value));
}

/**
 * OpenAI-compatible wrapper for diffusion lanes. PR #24423 ships only
 * `llama-diffusion-cli` (no `llama-server`), so the remote setup writes this
 * stdlib-only server and fronts the CLI with it. One generation runs at a
 * time (the model owns the whole GPU); streaming requests get a single final
 * SSE chunk because the CLI yields its completion in one piece.
 */
const DIFFUSION_SERVER_SOURCE = `import argparse
import json
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PARSER = argparse.ArgumentParser()
PARSER.add_argument("--host", default="127.0.0.1")
PARSER.add_argument("--port", type=int, required=True)
PARSER.add_argument("--cli", required=True)
PARSER.add_argument("--model", required=True)
PARSER.add_argument("--alias", required=True)
PARSER.add_argument("--n-gpu-layers", default="99")
PARSER.add_argument("--max-gen", type=int, default=1024)
PARSER.add_argument("--ctx", type=int, default=None)
PARSER.add_argument("--timeout", type=int, default=600)
ARGS = PARSER.parse_args()
MODEL_PATH = str(Path(ARGS.model).resolve())
ALIAS = ARGS.alias
REPORTED_CTX = ARGS.ctx if ARGS.ctx is not None else ARGS.max_gen
GENERATION_LOCK = threading.Lock()
BASE_COMMAND = [ARGS.cli, "-m", MODEL_PATH, "-ngl", ARGS.n_gpu_layers]


class GenerationError(RuntimeError):
    pass


def message_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(message_text(part.get("text")) for part in content if isinstance(part, dict))
    return ""


def build_prompt(messages):
    parts = []
    for message in messages or []:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        text = message_text(message.get("content")).strip()
        if not text:
            continue
        if role == "system":
            parts.append(text)
        elif role == "user":
            parts.append(text)
    return "\\n\\n".join(parts)


def generate(payload):
    prompt = build_prompt(payload.get("messages"))
    if not prompt:
        raise GenerationError("no usable user message in the request")
    try:
        max_tokens = int(payload.get("max_tokens") or ARGS.max_gen)
    except (TypeError, ValueError):
        max_tokens = ARGS.max_gen
    max_tokens = max(1, min(max_tokens, ARGS.max_gen))
    command = BASE_COMMAND + ["-p", prompt, "-n", str(max_tokens)]
    with GENERATION_LOCK:
        completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=ARGS.timeout)
    if completed.returncode != 0:
        raise GenerationError(f"llama-diffusion-cli exited with {completed.returncode}")
    text = completed.stdout.decode("utf-8", errors="replace").strip()
    if not text:
        raise GenerationError("generation produced no output")
    now = int(time.time())
    return {
        "id": f"chatcmpl-ompk-diffusion-{now}",
        "object": "chat.completion",
        "created": now,
        "model": ALIAS,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json({"status": "ok"})
        elif self.path == "/props":
            self.send_json({"default_generation_settings": {"n_ctx": REPORTED_CTX}})
        elif self.path == "/v1/models":
            self.send_json({"object": "list", "data": [{"id": ALIAS, "object": "model", "owned_by": "ompk"}]})
        else:
            self.send_json({"error": {"message": f"unknown path {self.path}"}}, status=404)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": {"message": "invalid JSON body"}}, status=400)
            return
        if self.path != "/v1/chat/completions":
            self.send_json({"error": {"message": f"unknown path {self.path}"}}, status=404)
            return
        try:
            result = generate(payload)
        except GenerationError as error:
            self.send_json({"error": {"message": str(error)}}, status=502)
            return
        except subprocess.TimeoutExpired:
            self.send_json({"error": {"message": "generation timed out"}}, status=504)
            return
        if payload.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            chunk = {
                "id": result["id"],
                "object": "chat.completion.chunk",
                "created": result["created"],
                "model": ALIAS,
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": result["choices"][0]["message"]["content"]}, "finish_reason": "stop"}],
            }
            self.wfile.write(b"data: " + json.dumps(chunk).encode() + b"\\n\\n")
            self.wfile.write(b"data: [DONE]\\n\\n")
        else:
            self.send_json(result)


def main():
    ThreadingHTTPServer((ARGS.host, ARGS.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
`;

export function buildRemoteSetupScript(config: {
	accelerator: ColabAccelerator;
	artifact: GgufArtifact;
	contextWindow: number;
	reference: HuggingFaceModelReference;
	remotePort: number;
	runtime?: ColabRuntimeProfile;
	modelProfile?: ColabModelProfile;
}): string {
	const runtime = config.runtime ?? selectColabRuntimeProfile(config.reference, config.artifact);
	const prebuilt = selectColabPrebuiltRuntime(runtime, config.accelerator);
	const modelProfile = config.modelProfile ?? getColabModelProfile(config.reference, config.artifact);
	const persistentCacheBucket = Bun.env.OMPK_GCS_MODEL_BUCKET?.trim() || Bun.env.GCS_BUCKET?.trim();
	const payload = {
		accelerator: config.accelerator,
		cmakeArchitecture: getColabAcceleratorProfile(config.accelerator).cmakeArchitecture,
		contextWindow: config.contextWindow,
		files: config.artifact.files,
		primaryFile: config.artifact.primaryFile,
		quantization: config.artifact.quantization,
		remotePort: config.remotePort,
		repoId: config.reference.repoId,
		revision: config.reference.revision,
		persistentCache: persistentCacheBucket?.startsWith("gs://")
			? { bucket: persistentCacheBucket.replace(/\/+$/, ""), prefix: "ompk-colab-cache/v1" }
			: null,
		modelProfile: modelProfile
			? {
					artifactFile: modelProfile.artifactFile,
					cachePrompt: modelProfile.cachePrompt ?? null,
					chatTemplate: modelProfile.chatTemplate ?? null,
					id: modelProfile.id,
					kvCacheType: modelProfile.kvCacheType ?? null,
					maxGenerationTokens: modelProfile.maxGenerationTokens ?? null,
					physicalMicrobatch: modelProfile.physicalMicrobatch ?? null,
					qwenPreserveThinking: modelProfile.qwenPreserveThinking ?? null,
					reasoningDisableMode: modelProfile.reasoningDisableMode ?? null,
					runtime: modelProfile.runtime ?? null,
				}
			: null,
		runtime: {
			id: runtime.id,
			directory: runtime.directory,
			repositoryUrl: runtime.repositoryUrl,
			pinnedCommit: runtime.pinnedCommit ?? null,
			pinnedTag: runtime.pinnedTag ?? null,
			fetchRef: runtime.fetchRef ?? null,
			prebuilt: prebuilt
				? {
						archive: prebuilt.archive,
						cuda: prebuilt.cuda,
						directory: prebuilt.directory,
						serverPath: prebuilt.serverPath,
						sha256: prebuilt.sha256,
						url: prebuilt.url,
					}
				: null,
		},
	};
	return `import hashlib
import json
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor
import os
import signal
import socket
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

CONFIG = json.loads(${pythonJson(payload)})
PROGRESS_PREFIX = ${JSON.stringify(PROGRESS_PREFIX)}
READY_PREFIX = ${JSON.stringify(READY_PREFIX)}
RUNTIME = CONFIG["runtime"]
MODEL_PROFILE = CONFIG.get("modelProfile") or {}
PREBUILT = RUNTIME["prebuilt"]
PERSISTENT_CACHE = CONFIG.get("persistentCache") or {}
LLAMA_DIR = Path(RUNTIME["directory"])
MODEL_ROOT = Path("/content/ompk-models")
PID_FILE = Path("/content/ompk-colab-model.pid")
LOG_FILE = Path("/content/ompk-colab-model.log")
HEX_DIGITS = frozenset("0123456789abcdef")
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

def inference_timeout_seconds():
    # Scale cold-prefill probes with context while retaining bounded requests.
    return min(900, max(300, 120 + int(CONFIG["contextWindow"] / 512)))

# A llama-server whose provenance is verified for this launch: restored release archive or pinned source build.
RuntimeTarget = namedtuple("RuntimeTarget", ["source", "server", "commit"])


class PrebuiltCompatibilityError(RuntimeError):
    pass


def progress(message):
    print(PROGRESS_PREFIX + json.dumps({"message": message}), flush=True)


def run(args, cwd=None):
    completed = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if completed.returncode != 0:
        tail = "\\n".join(completed.stdout.splitlines()[-80:])
        raise RuntimeError(f"Command failed ({completed.returncode}): {' '.join(args)}\\n{tail}")


def git_output(args):
    if not LLAMA_DIR.is_dir():
        return ""
    completed = subprocess.run(["git", *args], cwd=LLAMA_DIR, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return completed.stdout.strip() if completed.returncode == 0 else ""


def runtime_label():
    return f"{RUNTIME['id']} llama.cpp {RUNTIME['pinnedTag'] or (RUNTIME['pinnedCommit'] or 'head')[:12]}"


def cmake_cache_value(key):
    cache = LLAMA_DIR / "build" / "CMakeCache.txt"
    if not cache.is_file():
        return ""
    for line in cache.read_text(errors="replace").splitlines():
        if line.startswith("//") or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if separator and name.split(":")[0] == key:
            return value.strip()
    return ""


def runtime_binary_name():
    # The diffusion tree builds llama-diffusion-cli; every other lane serves llama-server.
    return "llama-diffusion-cli" if RUNTIME["id"] == "diffusion" else "llama-server"


def source_server_path():
    return LLAMA_DIR / "build" / "bin" / runtime_binary_name()


def source_binary_is_valid():
    """Reuse a compiled llama-server only when its build is keyed to this runtime: pinned commit, CUDA arch, Release."""
    if not source_server_path().is_file():
        return False
    expected = {
        "CMAKE_CUDA_ARCHITECTURES": CONFIG["cmakeArchitecture"],
        "CMAKE_BUILD_TYPE": "Release",
        "GGML_CUDA": "ON",
    }
    if any(cmake_cache_value(key) != value for key, value in expected.items()):
        return False
    pinned = RUNTIME["pinnedCommit"]
    if pinned and git_output(["rev-parse", "HEAD"]) != pinned:
        return False
    try:
        version = subprocess.run([str(source_server_path()), "--version"], env=library_env(source_server_path()), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return False
    if version.returncode != 0:
        return False
    commit = reported_commit(version.stdout)
    return not pinned or (commit is not None and pinned.startswith(commit))


def source_target():
    return RuntimeTarget("source", source_server_path(), git_output(["rev-parse", "HEAD"]) or None)


def prepare_runtime_source():
    pinned = RUNTIME["pinnedCommit"]
    if not (LLAMA_DIR / ".git").is_dir():
        if LLAMA_DIR.exists():
            shutil.rmtree(LLAMA_DIR)
        if not pinned:
            progress("cloning llama.cpp")
            run(["git", "clone", "--depth", "1", RUNTIME["repositoryUrl"], str(LLAMA_DIR)])
            return
        LLAMA_DIR.mkdir(parents=True)
        run(["git", "init", "-q"], cwd=LLAMA_DIR)
    if not pinned:
        progress("updating llama.cpp")
        run(["git", "pull", "--ff-only"], cwd=LLAMA_DIR)
        return
    if git_output(["rev-parse", "HEAD"]) != pinned:
        progress(f"checking out {runtime_label()}")
        subprocess.run(["git", "remote", "remove", "origin"], cwd=LLAMA_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        run(["git", "remote", "add", "origin", RUNTIME["repositoryUrl"]], cwd=LLAMA_DIR)
        fetch_ref = RUNTIME.get("fetchRef")
        if fetch_ref:
            # The pin lives on a pull request; fetch the ref, land on it, and
            # verify the commit so a moved PR fails instead of drifting.
            run(["git", "fetch", "--depth", "1", "origin", fetch_ref], cwd=LLAMA_DIR)
            run(["git", "checkout", "--detach", "--force", "FETCH_HEAD"], cwd=LLAMA_DIR)
            head = git_output(["rev-parse", "HEAD"])
            if head != pinned:
                raise RuntimeError(f"{LLAMA_DIR} {fetch_ref} is at {head or 'an unknown commit'}, expected pinned {pinned}; the pull request moved past the validated commit")
        else:
            run(["git", "fetch", "--depth", "1", "origin", pinned], cwd=LLAMA_DIR)
            run(["git", "checkout", "--detach", "--force", pinned], cwd=LLAMA_DIR)
    head = git_output(["rev-parse", "HEAD"])
    if head != pinned:
        raise RuntimeError(f"{LLAMA_DIR} is at {head or 'an unknown commit'}, expected pinned {pinned}")


def build_source_runtime():
    """Compile the runtime binary from the checkout; the result must pass the same validation as a reused build."""
    build_dir = LLAMA_DIR / "build"
    if build_dir.exists() and tree_in_use(build_dir):
        raise RuntimeError(f"Refusing to replace in-use runtime build {build_dir}")
    prepare_runtime_source()
    if build_dir.exists():
        progress(f"discarding unvalidated {RUNTIME['id']} llama.cpp build")
        shutil.rmtree(build_dir)
    binary = runtime_binary_name()
    progress(f"building CUDA {binary} from {runtime_label()}")
    configure = [
        "cmake", "-S", str(LLAMA_DIR), "-B", str(build_dir),
        "-DGGML_CUDA=ON", f"-DCMAKE_CUDA_ARCHITECTURES={CONFIG['cmakeArchitecture']}",
        "-DCMAKE_BUILD_TYPE=Release", "-DLLAMA_CURL=OFF",
    ]
    if shutil.which("ninja"):
        configure.extend(["-G", "Ninja"])
    run(configure)
    run([
        "cmake", "--build", str(build_dir), "--config", "Release",
        "--parallel", str(max(2, os.cpu_count() or 2)), "--target", binary,
    ])
    if not source_binary_is_valid():
        raise RuntimeError(f"Built {binary} did not pass the {runtime_label()} validation")
    return source_target()


def prebuilt_paths():
    """(cache root, archive, unpacked tree, manifest) for the pinned release archive."""
    root = Path(PREBUILT["directory"])
    return root, root / PREBUILT["archive"], root / "unpacked", root / "runtime.json"


def prebuilt_server_path():
    return prebuilt_paths()[2] / PREBUILT["serverPath"]


def prebuilt_label():
    return f"prebuilt {PREBUILT['archive']}"


def library_env(server):
    """Resolve the shared libraries bundled beside the executable ahead of anything else on the host."""
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = os.pathsep.join(part for part in (str(server.parent), env.get("LD_LIBRARY_PATH", "")) if part)
    return env


def sha256_of(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def reported_commit(version_output):
    """Commit hash printed by 'llama-server --version' (a 7+ hex token on its version line), or None."""
    for line in version_output.splitlines():
        if not line.strip().lower().startswith("version:"):
            continue
        for token in line.replace("(", " ").replace(")", " ").replace(",", " ").split():
            candidate = token.lower()
            if len(candidate) >= 7 and set(candidate) <= HEX_DIGITS and not candidate.isdigit():
                return candidate
    return None


def verify_prebuilt_server(server):
    """Raise unless the executable runs on this host, reports the pinned commit, and every bundled library resolves."""
    pinned = RUNTIME["pinnedCommit"] or ""
    env = library_env(server)
    try:
        version = subprocess.run([str(server), "--version"], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PrebuiltCompatibilityError(f"{server} could not report its version: {error}") from error
    if version.returncode != 0:
        tail = "\\n".join(version.stdout.splitlines()[-20:])
        raise PrebuiltCompatibilityError(f"{server} --version exited with {version.returncode}: {tail}")
    commit = reported_commit(version.stdout)
    if commit is None:
        raise RuntimeError(f"{server} did not report a llama.cpp build commit")
    if not pinned or not pinned.startswith(commit):
        raise RuntimeError(f"{server} was built from {commit}, expected pinned {pinned or 'commit'}")
    libraries = [server, *sorted(path for path in server.parent.glob("*.so*") if path.is_file() and not path.is_symlink())]
    for library in libraries:
        try:
            ldd = subprocess.run(["ldd", str(library)], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise PrebuiltCompatibilityError(f"ldd could not inspect {library.name}: {error}") from error
        missing = sorted({line.strip() for line in ldd.stdout.splitlines() if "not found" in line})
        if ldd.returncode != 0 or missing:
            detail = "; ".join(missing) or "\\n".join(ldd.stdout.splitlines()[-5:])
            raise PrebuiltCompatibilityError(f"{library.name} cannot load on this host: {detail}")
    return commit


def prebuilt_rejection():
    """None when the unpacked release matches the pinned archive and still runs here; otherwise the reason."""
    root, archive, unpacked, manifest = prebuilt_paths()
    server = prebuilt_server_path()
    if not server.is_file():
        return "not installed"
    if not manifest.is_file():
        return f"{manifest} is missing"
    try:
        recorded = json.loads(manifest.read_text())
    except (OSError, ValueError) as error:
        return f"{manifest} is unreadable: {error}"
    expected = {"sha256": PREBUILT["sha256"], "commit": RUNTIME["pinnedCommit"], "server": str(server)}
    if not isinstance(recorded, dict) or any(recorded.get(key) != value for key, value in expected.items()):
        return f"{manifest} does not describe {PREBUILT['archive']} at {runtime_label()}"
    if not archive.is_file() or sha256_of(archive) != PREBUILT["sha256"]:
        return f"{archive} is missing or fails its pinned checksum"
    try:
        verify_prebuilt_server(server)
    except RuntimeError as error:
        return str(error)
    return None


def prebuilt_target():
    return RuntimeTarget("prebuilt", prebuilt_server_path(), RUNTIME["pinnedCommit"])


def persistent_uri(*parts):
    bucket = PERSISTENT_CACHE.get("bucket")
    prefix = PERSISTENT_CACHE.get("prefix")
    if not isinstance(bucket, str) or not bucket.startswith("gs://") or not isinstance(prefix, str) or not prefix:
        return None
    return "/".join([bucket.rstrip("/"), prefix.strip("/"), *parts])


def restore_persistent_file(uri, destination, expected_sha256):
    part = destination.with_name(destination.name + ".part")
    try:
        subprocess.run(["gsutil", "cp", uri, str(part)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=7200, check=True)
        actual = sha256_of(part)
        if actual != expected_sha256:
            raise RuntimeError(f"{uri} sha256 {actual} does not match expected {expected_sha256}")
        part.replace(destination)
        return True
    finally:
        if part.exists():
            part.unlink()


def ensure_prebuilt_archive(archive):
    """Keep the cached archive only when it hashes to the pinned digest; otherwise download and verify a fresh copy."""
    if archive.is_file():
        if sha256_of(archive) == PREBUILT["sha256"]:
            progress(f"reusing cached {PREBUILT['archive']}")
            return
        progress(f"discarding cached {PREBUILT['archive']} with an unexpected checksum")
        archive.unlink()
    persistent = persistent_uri("runtimes", RUNTIME["id"], PREBUILT["archive"], PREBUILT["sha256"])
    if persistent:
        try:
            progress(f"restoring {PREBUILT['archive']} from persistent GCS")
            if restore_persistent_file(persistent, archive, PREBUILT["sha256"]):
                return
        except (OSError, subprocess.SubprocessError, RuntimeError) as error:
            progress(f"persistent runtime cache unavailable ({error}); downloading release")
    progress(f"downloading {PREBUILT['archive']}")
    part = archive.with_name(archive.name + ".part")
    try:
        with urllib.request.urlopen(PREBUILT["url"], timeout=120) as response, part.open("wb") as handle:
            shutil.copyfileobj(response, handle, 1 << 20)
        actual = sha256_of(part)
        if actual != PREBUILT["sha256"]:
            raise RuntimeError(f"{PREBUILT['archive']} sha256 {actual} does not match pinned {PREBUILT['sha256']}")
        part.replace(archive)
    finally:
        if part.exists():
            part.unlink()


def process_argv(proc_dir):
    try:
        return [part.decode("utf-8", errors="replace") for part in (proc_dir / "cmdline").read_bytes().split(b"\\0") if part]
    except OSError:
        return []


def iter_processes():
    """(pid, exe, argv) for every readable process; exe is None when its link cannot be read."""
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return
    for proc_dir in proc_root.iterdir():
        if not proc_dir.name.isdigit():
            continue
        argv = process_argv(proc_dir)
        if not argv:
            continue
        try:
            exe = Path(os.readlink(proc_dir / "exe"))
        except OSError:
            exe = None
        yield int(proc_dir.name), exe, argv


def tree_in_use(directory, processes=None):
    """True when a running process executes from inside the directory."""
    resolved = directory.resolve()
    for _pid, exe, _argv in (iter_processes() if processes is None else processes):
        if exe is None:
            continue
        try:
            exe.resolve().relative_to(resolved)
            return True
        except ValueError:
            continue
    return False


def retire_tree(directory):
    """Remove a superseded tree, or rename it aside when a process still runs from it (never delete an active tree)."""
    if tree_in_use(directory):
        retired = directory.with_name(f"{directory.name}.retired-{int(time.time())}")
        progress(f"keeping in-use {directory} as {retired.name}")
        directory.rename(retired)
    else:
        shutil.rmtree(directory)


def restore_prebuilt():
    """Download, verify, unpack, and validate the pinned release archive; returns its target or raises."""
    if not hasattr(tarfile, "data_filter"):
        raise RuntimeError("this Python lacks tarfile's data filter; refusing to unpack the release unsafely")
    root, archive, unpacked, manifest = prebuilt_paths()
    root.mkdir(parents=True, exist_ok=True)
    ensure_prebuilt_archive(archive)
    staging = root / "unpacked.staging"
    if staging.exists():
        shutil.rmtree(staging)
    progress(f"unpacking {PREBUILT['archive']}")
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            bundle.extractall(staging, filter="data")
        staged_server = staging / PREBUILT["serverPath"]
        if not staged_server.is_file():
            raise RuntimeError(f"{PREBUILT['archive']} does not contain {PREBUILT['serverPath']}")
        staged_server.chmod(staged_server.stat().st_mode | 0o100)
        commit = verify_prebuilt_server(staged_server)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    if unpacked.exists():
        retire_tree(unpacked)
    staging.rename(unpacked)
    server = prebuilt_server_path()
    manifest.write_text(json.dumps({
        "server": str(server),
        "archive": str(archive),
        "sha256": PREBUILT["sha256"],
        "tag": RUNTIME["pinnedTag"],
        "commit": RUNTIME["pinnedCommit"],
        "reportedCommit": commit,
        "cuda": PREBUILT["cuda"],
        "accelerator": CONFIG["accelerator"],
        "verifiedAt": time.time(),
    }))
    rejection = prebuilt_rejection()
    if rejection is not None:
        raise RuntimeError(f"restored {PREBUILT['archive']} failed validation: {rejection}")
    return prebuilt_target()


def validated_targets():
    """Servers whose provenance is verified for this launch, most preferred first; never adopts an unknown binary."""
    targets = []
    if PREBUILT:
        rejection = prebuilt_rejection()
        if rejection is None:
            targets.append(prebuilt_target())
        elif rejection != "not installed":
            progress(f"{prebuilt_label()} is not reusable: {rejection}")
    if source_binary_is_valid():
        targets.append(source_target())
    return targets


def prepare_runtime_target(targets):
    """Pick a validated server, restoring the pinned release when possible and compiling only as a last resort."""
    if targets:
        progress(f"reusing validated {targets[0].source} {runtime_binary_name()} ({runtime_label()})")
        return targets[0]
    if PREBUILT:
        try:
            return restore_prebuilt()
        except PrebuiltCompatibilityError as error:
            progress(f"{prebuilt_label()} unavailable ({error}); building from source instead")
    return build_source_runtime()


def argv_option(argv, flag):
    if flag not in argv:
        return None
    index = argv.index(flag) + 1
    return argv[index] if index < len(argv) else None


def serving_process(port, processes=None):
    """(pid, exe, argv) of the serving process bound to the port, or None when nothing matches."""
    # The diffusion lane serves through the OpenAI wrapper, not llama-server itself.
    expected = "ompk-diffusion-server" if RUNTIME["id"] == "diffusion" else "llama-server"
    for pid, exe, argv in (iter_processes() if processes is None else processes):
        if expected not in Path(argv[0]).name:
            continue
        if argv_option(argv, "--port") != str(port):
            continue
        return pid, exe, argv
    return None


def target_for_process(targets, running):
    """The validated target behind the serving process, or None.

    llama-server runs the binary directly (exe identity); the diffusion
    wrapper is a python process whose --cli argument names the validated
    CLI, so identity is taken from that argument instead.
    """
    if running is None:
        return None
    _pid, exe, argv = running
    candidate = argv_option(argv, "--cli") if RUNTIME["id"] == "diffusion" else exe
    if candidate is None:
        return None
    for target in targets:
        try:
            if os.path.samefile(candidate, target.server):
                return target
        except OSError:
            continue
    return None


def served_model_matches(argv, primary_name, required_names):
    """True when the process serves this exact GGUF: same file name, every split still present beside it."""
    model = argv_option(argv, "--model")
    if not model:
        return False
    model_path = Path(model)
    return model_path.name == primary_name and model_path.is_file() and all((model_path.parent / name).is_file() for name in required_names)


def request_json(url, payload=None, timeout=30):
    data = None if payload is None else json.dumps(payload).encode()
    headers = {} if payload is None else {"Content-Type": "application/json"}
    request = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def announce_ready(model_id, primary_name, base_url, target):
    context_window = CONFIG["contextWindow"]
    try:
        props = request_json(base_url + "/props")
        context_window = int(props.get("default_generation_settings", {}).get("n_ctx", context_window))
    except (OSError, urllib.error.URLError, ValueError, TypeError, json.JSONDecodeError):
        pass
    progress("warming model with a generation request")
    warmup = request_json(base_url + "/v1/chat/completions", {
        "model": model_id,
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "temperature": 0,
        "max_tokens": 16,
        "seed": 0,
        "chat_template_kwargs": {"enable_thinking": False},
    }, timeout=inference_timeout_seconds())
    if not isinstance(warmup.get("choices"), list) or not warmup["choices"]:
        raise RuntimeError("Warmup request returned no completion choices")
    if RUNTIME["id"] == "diffusion":
        # PR #24423's CLI cannot emit tool calls; the generation warmup above
        # is the whole readiness contract for this lane.
        progress("diffusion lane: skipping tool-call probe (architecture cannot emit tool calls)")
        print(READY_PREFIX + json.dumps({
            "contextWindow": context_window,
            "modelId": model_id,
            "modelName": Path(primary_name).stem,
            "port": CONFIG["remotePort"],
            "runtimeCommit": target.commit,
            "runtimeServer": str(target.server),
            "runtimeSource": target.source,
            "toolCallReady": False,
        }), flush=True)
        return


    progress("checking deterministic tool-call support")
    tool_probe = request_json(base_url + "/v1/chat/completions", {
        "model": model_id,
        "messages": [
            {"role": "system", "content": "The assignment requires " + ${JSON.stringify(TOOL_READINESS_FUNCTION)} + ". Call it exactly once, not " + ${JSON.stringify(TOOL_READINESS_DECOY_FUNCTION)} + ". Do not answer in prose."},
            {"role": "user", "content": "Invoke the required target function now."},
        ],
        "tools": [{
            "type": "function",
            "function": {
                "name": ${JSON.stringify(TOOL_READINESS_FUNCTION)},
                "description": "Synthetic target used to verify lane selection.",
                "parameters": {
                    "type": "object",
                    "properties": {"lane": {"type": "string", "enum": ["task"]}},
                    "required": ["lane"],
                    "additionalProperties": False,
                },
            },
        }, {
            "type": "function",
            "function": {
                "name": ${JSON.stringify(TOOL_READINESS_DECOY_FUNCTION)},
                "description": "Synthetic decoy that must not be selected.",
                "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
            },
        }],
        "tool_choice": "required",
        "temperature": 0,
        "max_tokens": 32,
        "seed": 0,
        "chat_template_kwargs": {"enable_thinking": False},
    }, timeout=inference_timeout_seconds())
    choices = tool_probe.get("choices")
    if not isinstance(choices, list) or len(choices) != 1:
        raise RuntimeError("Tool-call readiness probe returned an invalid choices payload")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    tool_calls = message.get("tool_calls") if isinstance(message, dict) else None
    if not isinstance(tool_calls, list) or len(tool_calls) != 1:
        raise RuntimeError("Tool-call readiness probe returned no single tool call")
    tool_call = tool_calls[0]
    if not isinstance(tool_call, dict) or tool_call.get("type") != "function":
        raise RuntimeError("Tool-call readiness probe returned a non-function tool call")
    function = tool_call.get("function")
    if not isinstance(function, dict) or function.get("name") != ${JSON.stringify(TOOL_READINESS_FUNCTION)}:
        raise RuntimeError("Tool-call readiness probe selected the wrong function")
    raw_arguments = function.get("arguments")
    if not isinstance(raw_arguments, str):
        raise RuntimeError("Tool-call readiness probe returned malformed arguments")
    try:
        arguments = json.loads(raw_arguments)
    except (TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("Tool-call readiness probe returned unparseable arguments") from error
    if arguments != {"lane": "task"}:
        raise RuntimeError("Tool-call readiness probe returned invalid target arguments")

    print(READY_PREFIX + json.dumps({
        "contextWindow": context_window,
        "modelId": model_id,
        "modelName": Path(primary_name).stem,
        "port": CONFIG["remotePort"],
        "runtimeCommit": target.commit,
        "runtimeServer": str(target.server),
        "runtimeSource": target.source,
        "toolCallReady": True,
    }), flush=True)


def persistent_cache_key(value):
    return value.replace("/", "--").replace("@", "--at--")


def restore_persistent_model(primary_name, required_names):
    manifest_uri = persistent_uri(
        "manifests",
        persistent_cache_key(CONFIG["repoId"]),
        persistent_cache_key(CONFIG["revision"]),
        Path(primary_name).name + ".json",
    )
    if not manifest_uri:
        return None
    try:
        response = subprocess.run(["gsutil", "cat", manifest_uri], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60, check=True)
        manifest = json.loads(response.stdout)
        if not isinstance(manifest, dict):
            raise RuntimeError("manifest is not an object")
        expected_names = set(CONFIG["files"])
        entries = manifest.get("files")
        if manifest.get("version") != 1 or manifest.get("repoId") != CONFIG["repoId"] or manifest.get("revision") != CONFIG["revision"] or manifest.get("primaryFile") != CONFIG["primaryFile"]:
            raise RuntimeError("manifest does not match the requested model")
        if not isinstance(entries, list) or {entry.get("name") for entry in entries if isinstance(entry, dict)} != expected_names:
            raise RuntimeError("manifest does not describe exactly the required GGUF files")
        model_dir = MODEL_ROOT / CONFIG["repoId"].replace("/", "--")
        model_dir.mkdir(parents=True, exist_ok=True)
        allowed_prefix = persistent_uri("models", persistent_cache_key(CONFIG["repoId"]), persistent_cache_key(CONFIG["revision"])) + "/"
        for entry in entries:
            if not isinstance(entry, dict):
                raise RuntimeError("manifest contains an invalid file entry")
            name, uri, digest = entry.get("name"), entry.get("uri"), entry.get("sha256")
            if not isinstance(name, str) or not isinstance(uri, str) or not isinstance(digest, str) or not uri.startswith(allowed_prefix):
                raise RuntimeError("manifest contains an untrusted GCS artifact reference")
            destination = model_dir / Path(name).name
            if destination.is_file() and sha256_of(destination) == digest:
                continue
            destination.unlink(missing_ok=True)
            progress(f"restoring {Path(name).name} from persistent GCS")
            restore_persistent_file(uri, destination, digest)
        model_path = model_dir / Path(primary_name).name
        if not model_path.is_file() or not all((model_dir / Path(name).name).is_file() for name in required_names):
            raise RuntimeError("persistent model restore did not produce every required GGUF file")
        return model_path
    except (OSError, subprocess.SubprocessError, ValueError, RuntimeError) as error:
        progress(f"persistent model cache unavailable ({error}); falling back to Hugging Face")
        return None


def resolve_model_path(primary_name, required_names):
    # 1. Local VM storage cache (/content/ompk-models, /content/models)
    # 2. Google Drive FUSE mount (/content/drive/MyDrive/models, etc.)
    # 3. In-region Google Cloud Storage (gsutil copy)
    search_roots = [
        MODEL_ROOT,
        Path("/content/models"),
        Path("/content/drive/MyDrive/models"),
        Path("/content/drive/MyDrive/ompk-models"),
        Path("/content/drive/MyDrive"),
    ]
    for root in search_roots:
        if not root.exists():
            continue
        for candidate in root.rglob(primary_name):
            if candidate.is_file() and all((candidate.parent / name).is_file() for name in required_names):
                progress(f"reusing cached {primary_name} from {root}")
                return candidate

    persistent_model = restore_persistent_model(primary_name, required_names)
    if persistent_model is not None:
        return persistent_model
    progress(f"downloading {CONFIG['repoId']} {CONFIG['quantization']}")
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        run([sys.executable, "-m", "pip", "install", "--quiet", "huggingface_hub"])
        from huggingface_hub import snapshot_download
    model_dir = MODEL_ROOT / CONFIG["repoId"].replace("/", "--")
    snapshot_download(
        repo_id=CONFIG["repoId"],
        revision=CONFIG["revision"],
        allow_patterns=CONFIG["files"],
        local_dir=str(model_dir),
    )
    model_path = model_dir / CONFIG["primaryFile"]
    if not model_path.is_file():
        raise FileNotFoundError(model_path)
    return model_path


def stop_prior_server():
    """Retire the prior llama-server on this port, never trusting a stale PID file alone."""
    try:
        recorded_pid = int(PID_FILE.read_text().strip())
    except (OSError, ValueError):
        recorded_pid = None
    running = serving_process(CONFIG["remotePort"])
    if running is None:
        return
    pid = running[0]
    if recorded_pid is not None and recorded_pid != pid:
        progress("ignoring stale llama-server PID file; using the server on the requested port")
    progress(f"stopping prior llama-server {pid} on port {CONFIG['remotePort']}")
    for termination_signal in (signal.SIGTERM, signal.SIGKILL):
        # Recheck identity before each signal so a recycled PID is not terminated.
        if serving_process(CONFIG["remotePort"]) != running:
            break
        try:
            os.kill(pid, termination_signal)
        except ProcessLookupError:
            break
        for attempt in range(100):
            if serving_process(CONFIG["remotePort"]) != running:
                break
            time.sleep(0.1)
        else:
            continue
        break
    if serving_process(CONFIG["remotePort"]) == running:
        raise RuntimeError(f"Prior llama-server {pid} did not stop")
    PID_FILE.unlink(missing_ok=True)


def assert_port_unused():
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(("127.0.0.1", CONFIG["remotePort"])) == 0:
            raise RuntimeError("Existing server is not a validated reusable match. It was left running; stop it explicitly only after checking ownership and activity.")


def start_server(target, model_path, primary_name, base_url):
    alias = Path(primary_name).stem
    progress(f"loading {alias} on the GPU with {target.source} {runtime_label()}")
    log_handle = LOG_FILE.open("w", buffering=1)
    if RUNTIME["id"] == "diffusion":
        # No diffusion llama-server exists (PR #24423 ships only the CLI), so
        # serve an OpenAI-compatible wrapper that runs one CLI generation per
        # request. Flash attention is unsupported in this tree and is omitted.
        wrapper = Path("/content/ompk-diffusion-server.py")
        wrapper.write_text(${JSON.stringify(DIFFUSION_SERVER_SOURCE)})
        max_gen = MODEL_PROFILE.get("maxGenerationTokens") or CONFIG["contextWindow"]
        server_args = [
            sys.executable, str(wrapper),
            "--host", "127.0.0.1", "--port", str(CONFIG["remotePort"]),
            "--cli", str(target.server), "--model", str(model_path), "--alias", alias,
            "--n-gpu-layers", "99",
            "--max-gen", str(max_gen), "--timeout", str(inference_timeout_seconds()),
        ]
    else:
        server_args = [
            str(target.server), "--model", str(model_path), "--alias", alias,
            "--host", "127.0.0.1", "--port", str(CONFIG["remotePort"]),
            "--ctx-size", str(CONFIG["contextWindow"]), "--n-gpu-layers", "99",
            "--flash-attn", "on", "--jinja", "--parallel", "1", "--metrics",
        ]
        if MODEL_PROFILE.get("kvCacheType"):
            server_args.extend(["--cache-type-k", MODEL_PROFILE["kvCacheType"], "--cache-type-v", MODEL_PROFILE["kvCacheType"]])
        if MODEL_PROFILE.get("physicalMicrobatch"):
            server_args.extend(["--ubatch-size", str(MODEL_PROFILE["physicalMicrobatch"])])
        if MODEL_PROFILE.get("cachePrompt"):
            server_args.append("--cache-prompt")
    server_process = subprocess.Popen(server_args, env=library_env(target.server), stdout=log_handle, stderr=subprocess.STDOUT, start_new_session=True)
    PID_FILE.write_text(str(server_process.pid))
    for attempt in range(180):
        if server_process.poll() is not None:
            log_handle.close()
            tail = "\\n".join(LOG_FILE.read_text(errors="replace").splitlines()[-80:])
            raise RuntimeError(f"{runtime_binary_name()} exited with {server_process.returncode}:\\n{tail}")
        try:
            health = request_json(base_url + "/health", timeout=3)
            if health.get("status") == "ok":
                return
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            pass
        time.sleep(5)
    server_process.terminate()
    raise TimeoutError("the serving process did not become healthy within 15 minutes")


def main():
    progress("checking CUDA runtime")
    run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"])
    primary_name = Path(CONFIG["primaryFile"]).name
    required_names = [Path(name).name for name in CONFIG["files"]]
    base_url = f"http://127.0.0.1:{CONFIG['remotePort']}"
    models_payload = None
    try:
        models_payload = request_json(base_url + "/v1/models", timeout=5)
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        pass
    running_ids = [item.get("id", "") for item in (models_payload or {}).get("data", []) if isinstance(item, dict)]
    matching_names = {primary_name, Path(primary_name).stem}
    matching_id = next((model_id for model_id in running_ids if Path(model_id).name in matching_names), None)
    targets = validated_targets()
    if matching_id is not None:
        running = serving_process(CONFIG["remotePort"])
        target = target_for_process(targets, running) if running else None
        if target is not None and served_model_matches(running[2], primary_name, required_names):
            progress(f"reusing running {Path(primary_name).stem} on validated {target.source} {runtime_label()}")
            PID_FILE.write_text(str(running[0]))
            announce_ready(matching_id, primary_name, base_url, target)
            return
        raise RuntimeError("Running model is not served by the validated runtime; it was left running and was not replaced.")

    stop_prior_server()
    assert_port_unused()
    with ThreadPoolExecutor(max_workers=1) as executor:
        model_future = executor.submit(resolve_model_path, primary_name, required_names)
        target = prepare_runtime_target(targets)
        model_path = model_future.result()

    assert_port_unused()
    start_server(target, model_path, primary_name, base_url)
    models_payload = request_json(base_url + "/v1/models")
    model_items = models_payload.get("data", [])
    if not model_items or not isinstance(model_items[0], dict) or not model_items[0].get("id"):
        raise RuntimeError("llama-server did not advertise a model id")
    announce_ready(model_items[0]["id"], primary_name, base_url, target)


if __name__ == "__main__":
    main()
`;
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
			if (payload?.message) await emit(`Colab: ${payload.message}…`);
		}
	};
}

export function buildRemoteHttpScript(config: {
	bodyBase64: string;
	headers: Record<string, string>;
	method: string;
	path: string;
	remotePort: number;
}): string {
	return `import base64
import json
import sys
import urllib.error
import urllib.request

CONFIG = json.loads(${pythonJson(config)})
HTTP_PREFIX = ${JSON.stringify(HTTP_PREFIX)}
url = f"http://127.0.0.1:{CONFIG['remotePort']}" + CONFIG["path"]
data = base64.b64decode(CONFIG["bodyBase64"]) if CONFIG["bodyBase64"] else None
request = urllib.request.Request(url, data=data, headers=CONFIG["headers"], method=CONFIG["method"])
try:
    response = urllib.request.urlopen(request, timeout=900)
except urllib.error.HTTPError as error:
    response = error
metadata = {
    "status": response.status,
    "headers": {
        "content-type": response.headers.get("content-type", "application/json"),
        "cache-control": response.headers.get("cache-control", "no-cache"),
    },
}
print(HTTP_PREFIX + json.dumps(metadata), flush=True)
content_type = response.headers.get("content-type", "")
if "text/event-stream" in content_type:
    while True:
        line = response.readline()
        if not line:
            break
        print(line.decode("utf-8", errors="replace"), end="", flush=True)
        if line.strip() == b"data: [DONE]":
            print("", flush=True)
            break
else:
    print(response.read().decode("utf-8", errors="replace"), end="", flush=True)
response.close()
`;
}

interface ByteStreamReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

async function readHttpMetadata(reader: ByteStreamReader): Promise<{ metadata: HttpMetadata; remainder: Uint8Array }> {
	const decoder = new TextDecoder();
	let buffered = "";
	while (!buffered.includes("\n")) {
		const { done, value } = await reader.read();
		if (done || !value) throw new Error("Colab bridge closed before returning HTTP metadata.");
		buffered += decoder.decode(value, { stream: true });
		if (buffered.length > 32_768) throw new Error("Colab bridge returned an oversized HTTP prelude.");
	}
	const newline = buffered.indexOf("\n");
	const metadataLine = buffered.slice(0, newline).replace(/\r$/, "");
	const metadata = parseMarkedJson<HttpMetadata>(metadataLine, HTTP_PREFIX);
	if (!metadata || !Number.isInteger(metadata.status)) {
		throw new Error(`Colab bridge returned invalid HTTP metadata: ${metadataLine}`);
	}
	return { metadata, remainder: new TextEncoder().encode(buffered.slice(newline + 1)) };
}

async function proxyToColab(request: Request, sessionName: string, remotePort: number): Promise<Response> {
	if (request.method === "OPTIONS") return new Response(null, { status: 204 });
	const url = new URL(request.url);
	const body =
		request.method === "GET" || request.method === "HEAD"
			? new Uint8Array()
			: new Uint8Array(await request.arrayBuffer());
	const headers: Record<string, string> = {};
	const contentType = request.headers.get("content-type");
	const accept = request.headers.get("accept");
	if (contentType) headers["Content-Type"] = contentType;
	if (accept) headers.Accept = accept;
	const script = buildRemoteHttpScript({
		bodyBase64: body.toBase64(),
		headers,
		method: request.method,
		path: `${url.pathname}${url.search}`,
		remotePort,
	});
	const processHandle = Bun.spawn({
		cmd: buildColabCommand(["exec", "--session", sessionName, "--timeout", "1200"]),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	processHandle.stdin.write(script);
	processHandle.stdin.end();
	const stderrPromise = new Response(processHandle.stderr).text();
	const reader = processHandle.stdout.getReader();
	try {
		const { metadata, remainder } = await readHttpMetadata(reader);
		const bodyStream = new ReadableStream<Uint8Array>({
			start(controller) {
				if (remainder.length > 0) controller.enqueue(remainder);
				void (async () => {
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							controller.enqueue(value);
						}
						const exitCode = await processHandle.exited;
						if (exitCode !== 0) {
							const stderr = await stderrPromise;
							controller.error(new Error(stderr || `Colab bridge exited with code ${exitCode}.`));
							return;
						}
						controller.close();
					} catch (error) {
						controller.error(error);
					}
				})();
			},
			cancel() {
				processHandle.kill();
			},
		});
		return new Response(bodyStream, { status: metadata.status, headers: metadata.headers });
	} catch (error) {
		processHandle.kill();
		const stderr = await stderrPromise;
		return Response.json(
			{ error: { message: `${errorMessage(error)}${stderr ? `\n${stderr}` : ""}`, type: "colab_bridge_error" } },
			{ status: 502 },
		);
	}
}

export function startOpenAiBridge(sessionName: string, remotePort: number, localPort = 0): string {
	activeBridge?.stop(true);
	activeBridge = Bun.serve({
		hostname: "127.0.0.1",
		port: localPort,
		fetch: request => proxyToColab(request, sessionName, remotePort),
	});
	return `http://127.0.0.1:${activeBridge.port}/v1`;
}

async function fetchLiveColabModelId(apiBaseUrl: string, fetchImpl = globalThis.fetch): Promise<string> {
	const response = await fetchImpl(`${apiBaseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
	if (!response.ok) throw new Error(`Colab model list returned HTTP ${response.status}.`);
	const payload: unknown = await response.json();
	if (payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)) {
		const first: unknown = payload.data[0];
		if (first && typeof first === "object" && "id" in first && typeof first.id === "string" && first.id.trim()) {
			return first.id;
		}
	}
	throw new Error("Colab model list did not contain a live model id.");
}

function liveColabModelName(modelId: string): string {
	return modelId
		.split("/")
		.pop()!
		.replace(/\.gguf$/i, "");
}

/**
 * Resolve the local Colab session name for a launch.
 *
 * The CLI tracks sessions by opaque server IDs and only knows the local
 * nickname stored in `~/.config/colab-cli/sessions.json`. Every launch must
 * therefore pin an explicit `--session` name or the local mapping is lost
 * (server shows the VM as `[?]` and `stop`/`status` by name cannot reach it).
 * Explicit names win, then `OMPK_COLAB_SESSION`, then the default.
 */
export function resolveColabSessionName(sessionName?: string): string {
	return sessionName?.trim() || Bun.env.OMPK_COLAB_SESSION?.trim() || DEFAULT_SESSION_NAME;
}

export async function launchColabModel(
	modelReference: string,
	emit: StatusEmitter,
	options: ColabModelLaunchOptions = {},
): Promise<ColabModelLaunchResult> {
	const reference = parseHuggingFaceModelReference(modelReference);
	await emit(`Colab: resolving ${reference.repoId}@${reference.revision}…`);
	const entries = await fetchHuggingFaceGgufs(reference, options.fetch);
	const sessionName = resolveColabSessionName(options.sessionName);
	const localPort = (() => {
		const raw =
			options.localPort ??
			(Bun.env.OMPK_COLAB_PORT?.trim() ? Number(Bun.env.OMPK_COLAB_PORT.trim()) : DEFAULT_LOCAL_PORT);
		if (!Number.isInteger(raw) || raw < 1 || raw > 65_535) {
			throw new Error(
				`Invalid Colab bridge port "${options.localPort ?? Bun.env.OMPK_COLAB_PORT}". Expected 1-65535.`,
			);
		}
		return raw;
	})();
	const acquisitionCandidates = options.accelerator
		? [options.accelerator]
		: selectAutomaticColabAccelerators(entries, reference);
	if (acquisitionCandidates.length === 0) {
		throw new Error(
			`No GGUF in ${reference.repoId} fits an automatic T4, L4, or A100 launch. Pass --gpu H100 or --gpu G4, or use a smaller GGUF.`,
		);
	}
	const accelerator = await ensureColabSession(sessionName, acquisitionCandidates, options.accelerator, emit);
	const artifact = selectGgufArtifact(entries, reference, accelerator);
	const modelProfile = getColabModelProfile(reference, artifact);
	const contextWindow = modelProfile
		? resolveColabContextWindow(accelerator, artifact, modelProfile)
		: getColabAcceleratorProfile(accelerator).defaultContextWindow;
	const runtime = selectColabRuntimeProfile(reference, artifact);
	const prebuilt = selectColabPrebuiltRuntime(runtime, accelerator);
	await emit(
		`Colab: selected ${artifact.quantization} (${artifact.totalSize > 0 ? `${(artifact.totalSize / 1_000_000_000).toFixed(1)} GB` : "size unknown"}) for ${accelerator} on ${runtime.id} llama.cpp${runtime.pinnedTag ? ` ${runtime.pinnedTag}` : ""}${prebuilt ? ` (prebuilt CUDA ${prebuilt.cuda} release, source fallback)` : ""}.`,
	);
	if (modelProfile) {
		const tuning = modelProfile.runtime === "diffusion" ? `generation cap ${modelProfile.maxGenerationTokens}` : `Q8 KV cache, ubatch ${modelProfile.physicalMicrobatch}`;
		await emit(`Colab: ${modelProfile.id} context budget ${contextWindow.toLocaleString()} tokens; ${tuning}.`);
	}
	const setup = await runCommand(["exec", "--session", sessionName, "--timeout", "3600"], {
		input: buildRemoteSetupScript({
			accelerator,
			artifact,
			contextWindow,
			modelProfile,
			reference,
			remotePort: DEFAULT_REMOTE_PORT,
			runtime,
		}),
		onStdout: createProgressParser(emit),
		timeoutMs: 60 * 60_000,
	});
	if (setup.exitCode !== 0) {
		throw new Error(
			`Colab setup failed; no replacement was provisioned. Reconnect explicitly if the runtime expired: ${setup.stderr || setup.stdout}`,
		);
	}
	const ready = parseMarkedJson<RemoteReadyPayload>(setup.stdout, READY_PREFIX);
	// The diffusion lane has no tool-calling probe: PR #24423's CLI cannot
	// emit tool calls, so the wrapper validates with a generation warmup and
	// reports toolCallReady: false. Everything else still requires the probe.
	const requiresToolProbe = runtime.id !== "diffusion";
	if (!ready?.modelId || !ready.port || (requiresToolProbe && ready.toolCallReady !== true)) {
		throw new Error(
			`Colab setup completed without a validated readiness probe: ${setup.stdout || setup.stderr}`,
		);
	}
	if (runtime.pinnedCommit && ready.runtimeCommit !== runtime.pinnedCommit) {
		throw new Error(
			`Colab runtime reported commit ${ready.runtimeCommit ?? "unknown"}; expected pinned ${runtime.pinnedTag ?? runtime.pinnedCommit}.`,
		);
	}
	await emit("Colab: opening private localhost API bridge…");
	const bridge = await startPersistentColabBridge({
		sessionName,
		remotePort: ready.port,
		modelId: ready.modelId,
		localPort,
		remoteTimeoutSeconds: getColabInferenceTimeoutSeconds(contextWindow),
	});
	const apiBaseUrl = bridge.apiBaseUrl;
	let modelId = ready.modelId;
	try {
		modelId = await fetchLiveColabModelId(apiBaseUrl, options.fetch);
	} catch (error) {
		await emit(
			`Colab warning: could not confirm the live model alias; keeping ${ready.modelId}: ${errorMessage(error)}`,
		);
	}
	const effectiveContextWindow = ready.contextWindow || contextWindow;
	return {
		accelerator,
		toolCallReady: ready.toolCallReady,
		apiBaseUrl,
		contextWindow: effectiveContextWindow,
		chatTemplate: modelProfile?.chatTemplate,
		reasoningDisableMode: modelProfile?.reasoningDisableMode,
		qwenPreserveThinking: modelProfile?.qwenPreserveThinking,
		maxTokens: Math.min(DEFAULT_MAX_TOKENS, effectiveContextWindow, modelProfile?.maxGenerationTokens ?? DEFAULT_MAX_TOKENS),
		modelId,
		modelName: modelId === ready.modelId ? ready.modelName : liveColabModelName(modelId),
		quantization: artifact.quantization,
		reasoning: runtime.reasoning,
		repoId: reference.repoId,
		runtime: summarizeRuntime(runtime, ready),
		sessionName,
	};
}

export async function handleColabModelSlashCommand(
	args: string,
	runtime: SlashCommandRuntime,
	launch: typeof launchColabModel = launchColabModel,
): Promise<{ consumed: true }> {
	try {
		const request = parseColabModelCommandArgs(args);
		const setups = await loadColabSetups();
		if (request.listSetups) {
			await runtime.output(formatColabSetups(setups));
			return { consumed: true };
		}
		const applied = applyColabSetup(request, setups);
		if (applied.setup && applied.setup.launch !== "colab-model") {
			const setup = applied.setup;
			await runtime.output(
				[
					`Colab setup "${setup.name}" [${setup.status}] is manual — /colab-model cannot provision it.`,
					`Accelerator: ${setup.accelerator}${setup.session ? ` (last session: ${setup.session})` : ""}`,
					setup.notes ?? "",
				]
					.filter(Boolean)
					.join("\n"),
			);
			return { consumed: true };
		}
		const resolved = applied.request;
		if (!resolved.modelReference) {
			await runtime.output(
				"Usage: /colab-model [--gpu T4|L4|A100|H100|G4] [--session <name>] [--port <number>] [--setup <name> | --list-setups] <owner/repository | huggingface.co model or GGUF URL>\nExample: /colab-model --gpu L4 unsloth/Qwen3.8-27B-GGUF\nExample: /colab-model --session ompk-colab-t4 --port 18083 unsloth/Qwen3-32B-GGUF\nExample: /colab-model --list-setups",
			);
			return { consumed: true };
		}
		const result = await launch(resolved.modelReference, message => runtime.output(message), {
			accelerator: resolved.accelerator,
			sessionName: resolved.sessionName,
			localPort: resolved.localPort,
		});
		const isDiffusion = result.runtime.id === "diffusion";
		if (!isDiffusion && result.toolCallReady !== true) {
			throw new Error("Colab model failed the tool-call readiness probe; refusing to register it as tool-capable.");
		}
		const liveId = await fetchLiveColabModelId(result.apiBaseUrl);
		const modelName = liveId === result.modelId ? result.modelName : liveColabModelName(liveId);
		runtime.session.modelRegistry.registerProvider(
			RUNTIME_PROVIDER,
			{
				baseUrl: result.apiBaseUrl,
				apiKey: kNoAuth,
				api: "openai-completions",
				// Diffusion GGUFs have no qwen thinking lane; omit the compat
				// override so the plain completions format applies.
				...(isDiffusion
					? {}
					: {
							compat: {
								thinkingFormat: result.chatTemplate ?? "qwen-chat-template",
								reasoningDisableMode: result.reasoningDisableMode ?? "qwen-template-false",
								qwenPreserveThinking: result.qwenPreserveThinking ?? true,
							},
						}),
				models: [
					{
						id: liveId,
						name: `${modelName} · Colab ${result.accelerator}`,
						reasoning:
							result.reasoning ||
							(!isDiffusion &&
								/qwen3(?:[._-]|$)|deepseek-r1|gpt-oss|reasoning|thinking/i.test(`${result.repoId}/${modelName}`)),
						input: ["text"],
						supportsTools: !isDiffusion,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: result.contextWindow,
						maxTokens: result.maxTokens,
					},
				],
			},
			RUNTIME_SOURCE_ID,
		);
		const model = runtime.session.modelRegistry.find(RUNTIME_PROVIDER, liveId);
		if (!model) {
			throw new Error(`Registered model ${RUNTIME_PROVIDER}/${liveId} was not found.`);
		}
		await runtime.session.setModel(model);
		await runtime.notifyTitleChanged?.();
		await runtime.notifyConfigChanged?.();
		await runtime.output(
			[
				`Colab model ready: ${RUNTIME_PROVIDER}/${liveId}`,
				`${result.repoId} ${result.quantization} on ${result.accelerator}`,
				`llama.cpp: ${result.runtime.id} ${result.runtime.pinnedTag ?? ""} ${result.runtime.commit ?? ""}`
					.replace(/\s+/g, " ")
					.trim(),
				`OpenAI-compatible API: ${result.apiBaseUrl}`,
				`Runtime: ${result.sessionName} (stop with: colab stop --session ${result.sessionName})`,
				...(isDiffusion
					? ["Tools: unavailable — the diffusion CLI cannot emit tool calls; this model answers chat only."]
					: []),
			].join("\n"),
		);
	} catch (error) {
		await runtime.output(`Colab model launch failed: ${errorMessage(error)}`);
	}
	return { consumed: true };
}
