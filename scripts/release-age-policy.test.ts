import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureName = "ompk-release-age-fixture";
const roots: string[] = [];
const requests: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const pathname = decodeURIComponent(new URL(request.url).pathname);
		requests.push(pathname);
		const packageName = pathname.slice(1);
		if (![fixtureName, "@types/bun", "bun-types"].includes(packageName))
			return new Response("not found", { status: 404 });
		const metadata = (version: string) => ({
			name: packageName,
			version,
			dist: {
				tarball: `http://127.0.0.1:${server.port}/${version}.tgz`,
				integrity:
					"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
			},
		});
		return Response.json({
			name: packageName,
			"dist-tags": { latest: "1.1.0" },
			versions: { "1.0.0": metadata("1.0.0"), "1.1.0": metadata("1.1.0") },
			time: { "1.0.0": "2020-01-01T00:00:00.000Z", "1.1.0": new Date().toISOString() },
		});
	},
});

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
	requests.length = 0;
});
afterAll(() => server.stop(true));

async function fixture(packageJson: object): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ompk-release-age-"));
	roots.push(root);
	const config = await Bun.file(new URL("../bunfig.toml", import.meta.url)).text();
	await Bun.write(
		join(root, "bunfig.toml"),
		config.replace("[install]", `[install]\nregistry = "http://127.0.0.1:${server.port}"`),
	);
	await Bun.write(join(root, "package.json"), JSON.stringify(packageJson));
	return root;
}

async function install(root: string, flags: string[]): Promise<{ exit: number; stderr: string }> {
	const process = Bun.spawn([processExecPath, "install", ...flags, "--ignore-scripts"], {
		cwd: root,
		env: { ...Bun.env, BUN_INSTALL_CACHE_DIR: join(root, "cache") },
		stdout: "ignore",
		stderr: "pipe",
	});
	const timeout = setTimeout(() => process.kill(), 30_000);
	try {
		const [exit, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
		return { exit, stderr };
	} finally {
		clearTimeout(timeout);
	}
}
const processExecPath = process.execPath;

describe("release dependency age policy", () => {
	test("retains the age gate for newly resolved third-party packages", async () => {
		const root = await fixture({ name: "age-gate-test", dependencies: { [fixtureName]: ">=1.0.0" } });
		const result = await install(root, ["--lockfile-only"]);
		expect(result.exit, result.stderr).toBe(0);
		const lock = await Bun.file(join(root, "bun.lock")).text();
		expect(lock).toContain(`${fixtureName}@1.0.0`);
		expect(lock).not.toContain(`${fixtureName}@1.1.0`);
	});

	for (const name of ["@types/bun", "bun-types"]) {
		test(`keeps the existing ${name} age exemption`, async () => {
			const root = await fixture({ name: "existing-exemption-test", dependencies: { [name]: ">=1.0.0" } });
			const result = await install(root, ["--lockfile-only"]);
			expect(result.exit, result.stderr).toBe(0);
			const lock = await Bun.file(join(root, "bun.lock")).text();
			expect(lock).toContain(`${name}@1.1.0`);
		});
	}

	test("resolves newly versioned first-party catalog packages from the workspace", async () => {
		const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json();
		const names = Object.keys(packageJson.workspaces.catalog).filter(name => name.startsWith("@pk-nerdsaver-ai/"));
		const catalog = Object.fromEntries(names.map(name => [name, "16.4.32"]));
		const dependencies = Object.fromEntries(names.map(name => [name, "catalog:"]));
		const root = await fixture({
			name: "workspace-test",
			workspaces: { packages: ["packages/*"], catalog },
			dependencies,
		});
		for (const [index, name] of names.entries()) {
			await Bun.write(
				join(root, `packages/workspace-${index}/package.json`),
				JSON.stringify({ name, version: "16.4.32" }),
			);
		}
		const result = await install(root, ["--lockfile-only"]);
		expect(result.exit, result.stderr).toBe(0);
		const lock = await Bun.file(join(root, "bun.lock")).text();
		for (const [index, name] of names.entries()) {
			expect(lock).toContain(`${name}@workspace:packages/workspace-${index}`);
			expect(requests.some(pathname => pathname.includes(name))).toBe(false);
		}
		await Bun.write(
			join(root, "package.json"),
			JSON.stringify({
				name: "workspace-test",
				workspaces: { packages: ["packages/*"], catalog },
				dependencies: { ...dependencies, [fixtureName]: "1.0.0" },
			}),
		);
		requests.length = 0;
		const mismatch = await install(root, ["--frozen-lockfile"]);
		expect(mismatch.exit).not.toBe(0);
		expect(mismatch.stderr).toMatch(/lockfile|frozen/i);
	});
});
