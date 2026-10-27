import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReleaseWorkspaceVersion, updateReleaseLockfile } from "./release-lockfile";

const workspace: ReleaseWorkspaceVersion = {
	path: "packages/agent",
	name: "@fixture/agent",
	version: "1.0.0",
	catalogVersion: "1.0.0",
};
const lock = `{
  "lockfileVersion": 1,
  "workspaces": {
    "packages/agent": {
      "name": "@fixture/agent",
      "version": "1.0.0",
      "dependencies": { "other": "1.0.0" },
    },
    "packages/private": {
      "name": "@fixture/private",
      "version": "1.0.0",
    },
  },
  "catalog": {
    "@fixture/agent": "1.0.0",
    "other": "1.0.0",
  },
  "packages": { "other": ["other@1.0.0", "sha512-fixture"] },
}\n`;

test("updates only the specified workspace and catalog fields", () => {
	const result = updateReleaseLockfile(lock, [workspace], "1.0.1");
	const expected = structuredClone(Bun.JSONC.parse(lock)) as {
		workspaces: Record<string, { version: string }>;
		catalog: Record<string, string>;
	};
	expected.workspaces[workspace.path].version = "1.0.1";
	expected.catalog[workspace.name] = "1.0.1";
	expect(Bun.JSONC.parse(result)).toEqual(expected);
	expect(updateReleaseLockfile(lock.replaceAll("\n", "\r\n"), [workspace], "1.0.1")).toContain("\r\n");
});

test("rejects stale, missing, duplicate or unexpectedly formatted release entries", () => {
	expect(() => updateReleaseLockfile(lock, [{ ...workspace, version: "0.9.0" }], "1.0.1")).toThrow("stale");
	expect(() => updateReleaseLockfile(lock, [{ ...workspace, catalogVersion: "0.9.0" }], "1.0.1")).toThrow("stale");
	expect(() => updateReleaseLockfile(lock, [workspace, workspace], "1.0.1")).toThrow("Duplicate");
	expect(() =>
		updateReleaseLockfile(lock.replace('"workspaces"', '"otherWorkspaces"'), [workspace], "1.0.1"),
	).toThrow();
	expect(() =>
		updateReleaseLockfile(lock.replace('    "packages/agent":', '  "packages/agent":'), [workspace], "1.0.1"),
	).toThrow("exactly one");
});

test("updates every current public workspace in the repository lockfile without changing its graph", async () => {
	const root = join(import.meta.dir, "..");
	const rootPackage = await Bun.file(join(root, "package.json")).json();
	const entries: ReleaseWorkspaceVersion[] = [];
	for await (const path of new Bun.Glob("packages/*/package.json").scan({ cwd: root })) {
		const pkg = await Bun.file(join(root, path)).json();
		if (pkg.private) continue;
		entries.push({
			path: path.replaceAll("\\", "/").replace(/\/package\.json$/, ""),
			name: pkg.name,
			version: pkg.version,
			catalogVersion: rootPackage.workspaces.catalog[pkg.name],
		});
	}
	expect(entries.length).toBeGreaterThan(0);
	const text = await Bun.file(join(root, "bun.lock")).text();
	const result = updateReleaseLockfile(text, entries, "999.999.999");
	const before = Bun.JSONC.parse(text) as { packages: unknown; workspaces: Record<string, { version?: string }> };
	const after = Bun.JSONC.parse(result) as { packages: unknown; workspaces: Record<string, { version?: string }> };
	expect(after.packages).toEqual(before.packages);
	for (const entry of entries) expect(after.workspaces[entry.path].version).toBe("999.999.999");
}, 30_000);

test("the updated lockfile is accepted by a real frozen Bun install", async () => {
	const root = await mkdtemp(join(tmpdir(), "ompk-release-lock-"));
	try {
		const packagePath = join(root, "packages/agent/package.json");
		const rootPackage = (version: string) => ({
			name: "release-fixture",
			private: true,
			workspaces: { packages: ["packages/*"], catalog: { "@fixture/agent": version } },
			dependencies: { "@fixture/agent": "catalog:" },
		});
		await Bun.write(join(root, "package.json"), JSON.stringify(rootPackage("1.0.0")));
		await Bun.write(packagePath, JSON.stringify({ name: workspace.name, version: "1.0.0" }));
		const run = async (args: string[]) => {
			const process = Bun.spawn([processExecPath, "install", ...args, "--ignore-scripts"], {
				cwd: root,
				stdout: "pipe",
				stderr: "pipe",
			});
			const timeout = setTimeout(() => process.kill(), 30_000);
			try {
				const [exit, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
				return { exit, stderr };
			} finally {
				clearTimeout(timeout);
			}
		};
		const initial = await run(["--lockfile-only"]);
		expect(initial.exit, initial.stderr).toBe(0);
		const lockPath = join(root, "bun.lock");
		const initialLock = await Bun.file(lockPath).text();
		await Bun.write(join(root, "package.json"), JSON.stringify(rootPackage("1.0.1")));
		await Bun.write(packagePath, JSON.stringify({ name: workspace.name, version: "1.0.1" }));
		await Bun.write(lockPath, updateReleaseLockfile(initialLock, [workspace], "1.0.1"));
		const frozen = await run(["--frozen-lockfile"]);
		expect(frozen.exit, frozen.stderr).toBe(0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 45_000);

const processExecPath = process.execPath;
