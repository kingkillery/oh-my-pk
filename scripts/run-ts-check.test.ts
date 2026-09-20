import { describe, expect, it } from "bun:test";
import { acquireResourceLock } from "./lib/resource-lock";
import { parsePorcelain, selectAffectedWorkspaceNames, type WorkspaceInfo } from "./run-ts-check";

const workspaces = [
	{ name: "utils", dir: "packages/utils", hasCheck: true, dependencies: [] },
	{ name: "agent", dir: "packages/agent", hasCheck: true, dependencies: ["utils"] },
	{ name: "extension", dir: "packages/extension", hasCheck: true, dependencies: ["agent"] },
	{ name: "unrelated", dir: "packages/unrelated", hasCheck: true, dependencies: [] },
] as const satisfies readonly WorkspaceInfo[];

describe("TypeScript check workspace selection", () => {
	it("includes the edited workspace and reverse-transitive dependents", () => {
		expect(selectAffectedWorkspaceNames(workspaces, ["packages/utils/src/index.ts"])).toEqual([
			"utils",
			"agent",
			"extension",
		]);
	});

	it("does not typecheck workspaces for unrelated repository documentation", () => {
		expect(selectAffectedWorkspaceNames(workspaces, ["README.md", "docs/tools/read.md"])).toEqual([]);
	});

	it("checks every workspace for global dependency inputs or unknown package paths", () => {
		expect(selectAffectedWorkspaceNames(workspaces, ["bun.lock"])).toEqual([
			"utils",
			"agent",
			"extension",
			"unrelated",
		]);
		expect(selectAffectedWorkspaceNames(workspaces, ["packages/new-package/src/index.ts"])).toEqual([
			"utils",
			"agent",
			"extension",
			"unrelated",
		]);
	});

	it("tracks both sides of porcelain rename entries", () => {
		const encoded = new TextEncoder().encode("R  packages/utils/src/new.ts\0packages/utils/src/old.ts\0");
		expect(parsePorcelain(encoded)).toEqual(["packages/utils/src/new.ts", "packages/utils/src/old.ts"]);
	});
});

describe("verification resource lock", () => {
	it("blocks a second holder until the first releases", async () => {
		const name = `oh-my-pk-lock-test-${process.pid}-${Date.now()}`;
		const releaseFirst = await acquireResourceLock(name);
		let secondAcquired = false;
		const second = acquireResourceLock(name).then(release => {
			secondAcquired = true;
			return release;
		});
		await Bun.sleep(100);
		expect(secondAcquired).toBe(false);
		await releaseFirst();
		const releaseSecond = await second;
		expect(secondAcquired).toBe(true);
		await releaseSecond();
	});
});
