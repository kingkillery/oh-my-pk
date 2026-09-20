import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { VERSION } from "../src/dirs";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

for (const label of [undefined, "", "testing.20260920.1481ee8a04"]) {
	test(`build display identity: ${label ?? "source fallback"}`, async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "ompk-build-version-"));
		directories.push(directory);
		const entry = path.join(directory, "entry.ts");
		const output = path.join(directory, "output.mjs");
		await Bun.write(
			entry,
			`import { VERSION, DISPLAY_VERSION } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/dirs.ts"))}; console.log(JSON.stringify({ base: VERSION, display: DISPLAY_VERSION }));`,
		);
		const build = await Bun.build({
			entrypoints: [entry],
			target: "bun",
			define: label === undefined ? {} : { OMPK_BUILD_LABEL: JSON.stringify(label) },
		});
		expect(build.success).toBe(true);
		await Bun.write(output, await build.outputs[0].text());
		const child = Bun.spawn([process.execPath, output], {
			env: { ...process.env, OMPK_BUILD_LABEL: "must-not-override-compiled-identity" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ base: VERSION, display: label ? `${VERSION}+${label}` : VERSION });
	});
}
