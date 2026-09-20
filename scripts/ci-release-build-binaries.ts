#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";

interface BaseTarget {
	id: string;
	platform: string;
	arch: string;
	target: string;
	outfile: string;
}

/** Rust build plan for the `ompk-collector` helper shipped per target. */
interface CollectorSpec {
	triple: string;
	zigbuild: boolean;
	outfile: string;
}

type BinaryTarget = BaseTarget & { collector: CollectorSpec };

const repoRoot = path.join(import.meta.dir, "..");
const codingAgentDir = path.join(repoRoot, "packages", "coding-agent");
const nativesDir = path.join(repoRoot, "packages", "natives");
const statsDir = path.join(repoRoot, "packages", "stats");

const binariesDir = path.join(repoRoot, "packages", "coding-agent", "binaries");
const entrypoint = "./packages/coding-agent/src/cli.ts";
// Worker threads spawn `new Worker(Bun.main, { argv })` — they re-enter the
// binary's own entry module — so no separate worker modules are compiled.
// Legacy pi-* extension compat surfaces are served through an in-process
// virtual namespace (`legacy-pi-compat.ts`), reached via the main module
// graph, so no extra `--compile` entrypoints are required (issue #3423).
const isDryRun = process.argv.includes("--dry-run");
const baseTargets: BaseTarget[] = [
	{
		id: "darwin-arm64",
		platform: "darwin",
		arch: "arm64",
		target: "bun-darwin-arm64",
		outfile: "packages/coding-agent/binaries/omp-darwin-arm64",
	},
	{
		id: "darwin-x64",
		platform: "darwin",
		arch: "x64",
		target: "bun-darwin-x64",
		outfile: "packages/coding-agent/binaries/omp-darwin-x64",
	},
	{
		id: "linux-x64",
		platform: "linux",
		arch: "x64",
		target: "bun-linux-x64-baseline",
		outfile: "packages/coding-agent/binaries/omp-linux-x64",
	},
	{
		id: "linux-arm64",
		platform: "linux",
		arch: "arm64",
		target: "bun-linux-arm64",
		outfile: "packages/coding-agent/binaries/omp-linux-arm64",
	},
	{
		id: "win32-x64",
		platform: "win32",
		arch: "x64",
		target: "bun-windows-x64-modern",
		outfile: "packages/coding-agent/binaries/omp-windows-x64.exe",
	},
];

/**
 * Runner↔triple assumptions (must stay in sync with the `release_binary`
 * matrix in .github/workflows/ci.yml):
 *   darwin-arm64 → macos-15 (native arm64)        plain cargo
 *   darwin-x64   → macos-15-intel (native x64)    plain cargo
 *   linux-x64    → ubuntu-22.04 (native x64)      zigbuild @ glibc floor
 *   linux-arm64  → ubuntu-24.04-arm (native)      zigbuild @ glibc floor
 *   win32-x64    → ubuntu-22.04 (cross, mingw)    plain cargo --target gnu
 *
 * win32 is a GNU-triple cross build because the MSVC toolchain can't run on
 * the Linux runner; linux uses cargo-zigbuild against GLIBC_FLOOR when
 * available so the helper keeps the native addons' glibc floor.
 */
function collectorSpec(target: BaseTarget): CollectorSpec {
	const triple =
		target.platform === "darwin"
			? target.arch === "arm64"
				? "aarch64-apple-darwin"
				: "x86_64-apple-darwin"
			: target.platform === "linux"
				? target.arch === "arm64"
					? "aarch64-unknown-linux-gnu"
					: "x86_64-unknown-linux-gnu"
				: "x86_64-pc-windows-gnu";
	return {
		triple,
		zigbuild: target.platform === "linux",
		outfile: `packages/coding-agent/binaries/ompk-collector-${target.platform}-${target.arch}${target.platform === "win32" ? ".exe" : ""}`,
	};
}

const targets: BinaryTarget[] = baseTargets.map(target => ({ ...target, collector: collectorSpec(target) }));

function parseRequestedTargets(): Set<string> | null {
	const flagIndex = process.argv.indexOf("--targets");
	const flagValue =
		flagIndex >= 0
			? process.argv[flagIndex + 1]
			: (process.argv.find(arg => arg.startsWith("--targets="))?.split("=", 2)[1] ?? Bun.env.RELEASE_TARGETS);

	if (!flagValue) {
		return null;
	}

	return new Set(
		flagValue
			.split(",")
			.map(value => value.trim())
			.filter(Boolean),
	);
}

function shouldAdhocSignDarwinBinary(target: BinaryTarget): boolean {
	return target.platform === "darwin" && process.platform === "darwin";
}

async function runCommand(command: string[], cwd: string, env: NodeJS.ProcessEnv = Bun.env): Promise<void> {
	const proc = Bun.spawn(command, {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`Command failed with exit code ${exitCode}: ${command.join(" ")}`);
	}
}

async function embedNative(target: BinaryTarget): Promise<void> {
	if (isDryRun) {
		console.log(`DRY RUN bun run gen:native [${target.platform}/${target.arch}]`);
		return;
	}

	await runCommand(["bun", "run", "gen:native"], nativesDir, {
		...Bun.env,
		TARGET_PLATFORM: target.platform,
		TARGET_ARCH: target.arch,
	});
}

async function buildBinary(target: BinaryTarget): Promise<void> {
	console.log(`Building ${target.outfile}...`);
	await embedNative(target);
	if (isDryRun) {
		console.log(
			`DRY RUN bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv --no-compile-autoload-tsconfig --no-compile-autoload-package-json --minify-identifiers --keep-names --define process.env.PI_COMPILED="true" --root . --target=${target.target} ${entrypoint} --outfile ${target.outfile}`,
		);
		return;
	}

	const buildEnv = shouldAdhocSignDarwinBinary(target) ? { ...Bun.env, BUN_NO_CODESIGN_MACHO_BINARY: "1" } : Bun.env;
	await runCommand(
		[
			"bun",
			"build",
			"--compile",
			"--no-compile-autoload-bunfig",
			"--no-compile-autoload-dotenv",
			"--no-compile-autoload-tsconfig",
			"--no-compile-autoload-package-json",
			"--minify-identifiers",
			"--keep-names",
			"--define",
			'process.env.PI_COMPILED="true"',
			"--root",
			".",
			"--target",
			target.target,
			entrypoint,
			"--outfile",
			target.outfile,
		],
		repoRoot,
		buildEnv,
	);

	// Bun 1.3.12 emits a truncated Mach-O signature on darwin builds.
	if (shouldAdhocSignDarwinBinary(target)) {
		await runCommand(["codesign", "--force", "--sign", "-", path.join(repoRoot, target.outfile)], repoRoot);
	}
}

async function commandExists(command: string): Promise<boolean> {
	const proc = Bun.spawn(["which", command], { stdout: "ignore", stderr: "ignore" });
	return (await proc.exited) === 0;
}

/**
 * Build the `ompk-collector` Rust helper for this target and copy it next to
 * the main binary.
 *
 * Toolchain matrix:
 *   - CI darwin/linux runners: native cargo for the matching triple.
 *   - CI win32 (Linux runner): mingw-w64 gnu cross via plain cargo.
 *   - Linux glibc floor: cargo zigbuild against GLIBC_FLOOR when installed;
 *     plain cargo otherwise (floor rises to the runner's glibc).
 *   - Local Windows host: host MSVC build (no --target), since the gnu
 *     cross toolchain is a CI provision.
 */
async function buildCollector(target: BinaryTarget): Promise<void> {
	const collector = target.collector;
	console.log(`Building ${collector.outfile} (${collector.triple})...`);
	if (isDryRun) {
		console.log(`DRY RUN cargo build --release --target ${collector.triple} (crates/ompk-collector) + copy`);
		return;
	}
	const crateDir = path.join(repoRoot, "crates", "ompk-collector");
	// Host-native win32 build: on a Windows host the MSVC host target is the
	// right binary; the gnu triple is only for Linux-runner cross builds.
	const hostNativeWin32 = target.platform === "win32" && process.platform === "win32";
	const zigbuild = !hostNativeWin32 && collector.zigbuild && (await commandExists("cargo-zigbuild"));
	const glibcFloor = Bun.env.GLIBC_FLOOR ? `.${Bun.env.GLIBC_FLOOR}` : "";
	const rustTarget = hostNativeWin32 ? null : zigbuild ? `${collector.triple}${glibcFloor}` : collector.triple;
	const command = zigbuild ? "zigbuild" : "build";
	const buildArgs = rustTarget
		? ["cargo", command, "--release", "--target", rustTarget]
		: ["cargo", "build", "--release"];
	await runCommand(buildArgs, crateDir);
	// ompk-collector is a workspace member, so cargo places artifacts in the
	// workspace-root target dir even when the build runs from the crate dir.
	const builtPath = path.join(
		repoRoot,
		"target",
		...(rustTarget ? [collector.triple] : []),
		"release",
		target.platform === "win32" ? "ompk-collector.exe" : "ompk-collector",
	);
	const outPath = path.join(repoRoot, collector.outfile);
	await fs.copyFile(builtPath, outPath);
	// Ad-hoc sign darwin builds so they execute out of the box, matching the
	// main binary's treatment (Developer-ID signing stays a workflow-level
	// step for the omp binary).
	if (target.platform === "darwin" && process.platform === "darwin") {
		await runCommand(["codesign", "--force", "--sign", "-", outPath], repoRoot);
	}
}

async function generateBundle(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun run gen:stats");
		console.log("DRY RUN bun run gen:docs");
		console.log("DRY RUN bun run gen:mupdf");
		return;
	}
	await runCommand(["bun", "run", "gen:stats"], statsDir);
	await runCommand(["bun", "run", "gen:docs"], codingAgentDir);
	await runCommand(["bun", "run", "gen:mupdf"], codingAgentDir);
}

async function resetArtifacts(): Promise<void> {
	if (isDryRun) {
		console.log("DRY RUN bun run gen:native:reset");
		console.log("DRY RUN bun run gen:stats:reset");
		console.log("DRY RUN bun run gen:docs:reset");
		console.log("DRY RUN bun run gen:mupdf:reset");
		return;
	}
	await runCommand(["bun", "run", "gen:native:reset"], nativesDir);
	await runCommand(["bun", "run", "gen:stats:reset"], statsDir);
	await runCommand(["bun", "run", "gen:docs:reset"], codingAgentDir);
	await runCommand(["bun", "run", "gen:mupdf:reset"], codingAgentDir);
}

async function main(): Promise<void> {
	const requestedTargets = parseRequestedTargets();
	const selectedTargets = requestedTargets ? targets.filter(target => requestedTargets.has(target.id)) : targets;

	if (requestedTargets) {
		const unknownTargets = [...requestedTargets].filter(
			requestedTarget => !targets.some(target => target.id === requestedTarget),
		);
		if (unknownTargets.length > 0) {
			throw new Error(`Unknown release target(s): ${unknownTargets.join(", ")}`);
		}
	}

	if (selectedTargets.length === 0) {
		throw new Error("No release targets selected.");
	}

	await fs.mkdir(binariesDir, { recursive: true });
	// Generate inside the try so resetArtifacts() always restores the empty
	// checked-in placeholders, even if a generate or build step throws.
	try {
		await generateBundle();
		for (const target of selectedTargets) {
			await buildBinary(target);
			await buildCollector(target);
		}
	} finally {
		await resetArtifacts();
	}
}

await main();
