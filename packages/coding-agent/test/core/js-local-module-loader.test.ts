import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { LocalModuleLoader } from "@pk-nerdsaver-ai/pi-coding-agent/eval/js/shared/local-module-loader";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils/temp";

describe("eval local module compatibility bindings", () => {
	it("preserves module-owned bindings and resolves CommonJS from the workspace", async () => {
		using tmp = TempDir.createSync("@eval-local-module-");
		await Bun.write(path.join(tmp.path(), "fixture.cjs"), 'module.exports = { marker: "workspace" };');
		await Bun.write(
			path.join(tmp.path(), "owned.js"),
			[
				'import { dirname } from "node:path";',
				'import { fileURLToPath } from "node:url";',
				'import { createRequire } from "node:module";',
				"const __filename = fileURLToPath(import.meta.url);",
				"const __dirname = dirname(__filename);",
				"const require = createRequire(import.meta.url);",
				'export const value = [__filename === import.meta.path, __dirname === import.meta.dir, require("./fixture.cjs").marker];',
			].join("\n"),
		);
		await Bun.write(
			path.join(tmp.path(), "injected.js"),
			'function local() { const __dirname = "private"; return __dirname; } export const value = [__filename === import.meta.path, __dirname === import.meta.dir, require("./fixture.cjs").marker];',
		);
		await Bun.write(
			path.join(tmp.path(), "exported.js"),
			'export const __dirname = import.meta.dir; export const value = [__filename === import.meta.path, __dirname === import.meta.dir, require("./fixture.cjs").marker];',
		);
		await Bun.write(
			path.join(tmp.path(), "imported.js"),
			'import { dirname as __dirname } from "node:path"; export const value = [__filename === import.meta.path, __dirname(__filename) === import.meta.dir, require("./fixture.cjs").marker];',
		);
		await Bun.write(
			path.join(tmp.path(), "block.js"),
			'if (true) { var __dirname = import.meta.dir; } export const value = [__filename === import.meta.path, __dirname === import.meta.dir, require("./fixture.cjs").marker];',
		);
		const loader = new LocalModuleLoader(tmp.path());
		const globals = globalThis as Record<string, unknown>;
		const hadRequireHelper = Object.hasOwn(globals, "__omp_get_require__");
		const previous = globals.__omp_get_require__;
		globals.__omp_get_require__ = (url: string) => loader.requireForFile(url, tmp.path());
		try {
			for (const filename of ["owned.js", "injected.js", "exported.js", "imported.js", "block.js"]) {
				const result = await loader.resolveForRun(tmp.path(), `./${filename}`);
				expect(result.mode).toBe("local");
				if (result.mode !== "local") throw new Error("Expected a managed local module");
				expect((result.value as { value: unknown }).value).toEqual([true, true, "workspace"]);
			}
			const commonJs = await loader.resolveForRun(tmp.path(), "./fixture.cjs");
			expect(commonJs.mode).toBe("external");
			if (commonJs.mode !== "external") throw new Error("Expected CommonJS passthrough");
			expect((await import(commonJs.target)).default.marker).toBe("workspace");
		} finally {
			if (hadRequireHelper) globals.__omp_get_require__ = previous;
			else delete globals.__omp_get_require__;
		}
	});
});
