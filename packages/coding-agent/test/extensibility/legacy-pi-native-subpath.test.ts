import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Use a fresh process: runtime plugins persist globally for the process lifetime.
test("legacy hook preserves canonical native loader subpaths", async () => {
	const compatUrl = new URL("../../src/extensibility/plugins/legacy-pi-compat.ts", import.meta.url).href;
	const source = `
import { installLegacyPiSpecifierShim } from ${JSON.stringify(compatUrl)};
installLegacyPiSpecifierShim();
const canonical = await import("@pk-nerdsaver-ai/pi-natives/native/loader-state.js");
console.log(JSON.stringify({
  loadNativeType: typeof canonical.loadNative,
  files: canonical.getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" }),
}));
`;
	const child = Bun.spawn([process.execPath, "-e", source], {
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000,
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
	expect(JSON.parse(stdout)).toEqual({
		loadNativeType: "function",
		files: ["pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64.node"],
	});
}, 90_000);
