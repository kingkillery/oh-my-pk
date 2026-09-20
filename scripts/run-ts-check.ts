#!/usr/bin/env bun

import * as path from "node:path";
import { acquireResourceLock } from "./lib/resource-lock";

interface WorkspaceManifest {
	name?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

export interface WorkspaceInfo {
	name: string;
	dir: string;
	hasCheck: boolean;
	dependencies: readonly string[];
}

const repoRoot = path.join(import.meta.dir, "..");
const RESOURCE_LOCK_NAME = "oh-my-pk-heavy-verification";

export function selectAffectedWorkspaceNames(
	workspaces: readonly WorkspaceInfo[],
	changedPaths: readonly string[],
): string[] {
	const byDir = new Map(workspaces.map(workspace => [workspace.dir, workspace]));
	const byName = new Map(workspaces.map(workspace => [workspace.name, workspace]));
	const seeds = new Set<string>();
	let runAll = false;

	for (const changedPath of changedPaths) {
		const normalized = changedPath.replace(/\\/g, "/");
		if (isGlobalTypeScriptInput(normalized)) {
			runAll = true;
			break;
		}
		const workspaceDir = workspaceDirForPath(normalized);
		if (!workspaceDir) continue;
		const workspace = byDir.get(workspaceDir);
		if (!workspace) {
			runAll = true;
			break;
		}
		seeds.add(workspace.name);
	}

	if (runAll) return orderWorkspaces(workspaces, new Set(workspaces.map(workspace => workspace.name)));

	const affected = new Set(seeds);
	let changed = true;
	while (changed) {
		changed = false;
		for (const workspace of workspaces) {
			if (affected.has(workspace.name)) continue;
			if (!workspace.dependencies.some(dependency => affected.has(dependency))) continue;
			affected.add(workspace.name);
			changed = true;
		}
	}
	return orderWorkspaces([...byName.values()], affected);
}

function isGlobalTypeScriptInput(changedPath: string): boolean {
	return (
		changedPath === "package.json" ||
		changedPath === "bun.lock" ||
		changedPath === "bunfig.toml" ||
		changedPath === "biome.json" ||
		changedPath === "biome.jsonc" ||
		changedPath === "tsconfig.json" ||
		changedPath === "tsconfig.base.json" ||
		changedPath === "tsconfig.tools.json" ||
		changedPath.startsWith("patches/") ||
		changedPath.startsWith("types/")
	);
}

function workspaceDirForPath(changedPath: string): string | undefined {
	const packageMatch = /^(packages\/[^/]+)(?:\/|$)/u.exec(changedPath);
	if (packageMatch?.[1]) return packageMatch[1];
	if (changedPath === "python/robomp/web" || changedPath.startsWith("python/robomp/web/")) {
		return "python/robomp/web";
	}
	return undefined;
}

function orderWorkspaces(workspaces: readonly WorkspaceInfo[], selected: ReadonlySet<string>): string[] {
	const byName = new Map(workspaces.map(workspace => [workspace.name, workspace]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const ordered: string[] = [];
	const visit = (name: string): void => {
		if (visited.has(name)) return;
		if (visiting.has(name)) return;
		const workspace = byName.get(name);
		if (!workspace) return;
		visiting.add(name);
		for (const dependency of workspace.dependencies) {
			if (selected.has(dependency)) visit(dependency);
		}
		visiting.delete(name);
		visited.add(name);
		if (selected.has(name)) ordered.push(name);
	};
	for (const name of [...selected].sort()) visit(name);
	return ordered;
}

async function main(): Promise<void> {
	const forceAll = process.argv.includes("--all") || isCI();
	console.log(`Waiting for machine-wide ${RESOURCE_LOCK_NAME} lock...`);
	const release = await acquireResourceLock(RESOURCE_LOCK_NAME);
	try {
		console.log(`Acquired ${RESOURCE_LOCK_NAME} lock.`);
		const workspaces = await loadWorkspaces();
		let selectedNames: string[];
		if (forceAll) {
			selectedNames = orderWorkspaces(workspaces, new Set(workspaces.map(workspace => workspace.name)));
		} else {
			const changedPaths = await collectChangedPaths();
			selectedNames = selectAffectedWorkspaceNames(workspaces, changedPaths);
		}

		await runCommand([process.execPath, "run", "check:tools"], repoRoot);
		const selected = selectedNames
			.map(name => workspaces.find(workspace => workspace.name === name))
			.filter((workspace): workspace is WorkspaceInfo => workspace?.hasCheck === true);
		if (selected.length === 0) {
			console.log("No changed TypeScript workspace or dependent requires checking.");
			return;
		}
		console.log(`Checking workspaces sequentially: ${selected.map(workspace => workspace.name).join(", ")}`);
		for (const workspace of selected) {
			await runCommand([process.execPath, "run", "check"], path.join(repoRoot, workspace.dir));
		}
	} finally {
		await release();
	}
}

function isCI(): boolean {
	const value = Bun.env.CI?.trim().toLowerCase();
	return value !== undefined && value !== "" && value !== "0" && value !== "false";
}

async function loadWorkspaces(): Promise<WorkspaceInfo[]> {
	const manifests = ["python/robomp/web/package.json"];
	for await (const manifestPath of new Bun.Glob("packages/*/package.json").scan({ cwd: repoRoot, onlyFiles: true })) {
		manifests.push(manifestPath.replace(/\\/g, "/"));
	}
	const workspaces: WorkspaceInfo[] = [];
	for (const manifestPath of manifests) {
		const file = Bun.file(path.join(repoRoot, manifestPath));
		if (!(await file.exists())) continue;
		const manifest = (await file.json()) as WorkspaceManifest;
		if (!manifest.name) continue;
		const dependencies = new Set<string>();
		for (const group of [
			manifest.dependencies,
			manifest.devDependencies,
			manifest.optionalDependencies,
			manifest.peerDependencies,
		]) {
			for (const name of Object.keys(group ?? {})) dependencies.add(name);
		}
		workspaces.push({
			name: manifest.name,
			dir: path.posix.dirname(manifestPath),
			hasCheck: manifest.scripts?.check !== undefined,
			dependencies: [...dependencies],
		});
	}
	return workspaces;
}

async function collectChangedPaths(): Promise<string[]> {
	const changed = new Set<string>();
	const status = await runCaptured(["git", "status", "--porcelain", "-z"]);
	if (status.exitCode !== 0) throw new Error("Unable to inspect the working tree; refusing to run a partial check");
	for (const changedPath of parsePorcelain(status.stdout)) changed.add(changedPath);

	const mergeBase = await runCaptured(["git", "merge-base", "HEAD", "origin/main"]);
	if (mergeBase.exitCode !== 0)
		throw new Error("Unable to resolve origin/main; use `bun run ci:check:full` for a full check");
	const base = new TextDecoder().decode(mergeBase.stdout).trim();
	const branch = await runCaptured(["git", "diff", "--name-only", "-z", base, "HEAD"]);
	if (branch.exitCode !== 0) throw new Error("Unable to inspect branch changes; refusing to run a partial check");
	for (const changedPath of decodeNulPaths(branch.stdout)) changed.add(changedPath);
	return [...changed];
}

export function parsePorcelain(buffer: Uint8Array): string[] {
	const entries = decodeNulPaths(buffer);
	const changedPaths: string[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		changedPaths.push(entry.slice(3));
		if (status.includes("R") || status.includes("C")) {
			const renamedPath = entries[index + 1];
			if (renamedPath) {
				changedPaths.push(renamedPath);
				index += 1;
			}
		}
	}
	return changedPaths;
}

function decodeNulPaths(buffer: Uint8Array): string[] {
	return new TextDecoder().decode(buffer).split("\0").filter(Boolean);
}

async function runCaptured(argv: string[]) {
	const proc = Bun.spawn(argv, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).bytes(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0 && stderr.trim() !== "") console.error(stderr.trim());
	return { stdout, exitCode };
}

class CommandFailedError extends Error {
	readonly exitCode: number;
	constructor(argv: readonly string[], exitCode: number) {
		super(`command failed with exit code ${exitCode}: ${argv.join(" ")}`);
		this.exitCode = exitCode;
	}
}

async function runCommand(argv: string[], cwd: string): Promise<void> {
	const proc = Bun.spawn(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new CommandFailedError(argv, exitCode);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		if (error instanceof CommandFailedError) {
			process.exitCode = error.exitCode;
		} else {
			console.error(error);
			process.exitCode = 1;
		}
	}
}
