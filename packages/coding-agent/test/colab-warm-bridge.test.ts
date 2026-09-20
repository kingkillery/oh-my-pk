import { expect, test } from "bun:test";

test("persistent Colab bridge HTTP streaming, cancellation isolation, and recovery", async () => {
	const pathname = decodeURIComponent(new URL("./colab-warm-bridge-contract.py", import.meta.url).pathname);
	const command =
		process.platform === "win32"
			? [
					"wsl.exe",
					"-d",
					"Ubuntu",
					"-e",
					"/opt/colab-cli/bin/python",
					pathname.replace(/^\/([A-Za-z]):\//, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`),
				]
			: ["python3", pathname];
	const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exitCode, diagnostics: exitCode === 0 ? "" : stdout + stderr }).toEqual({ exitCode: 0, diagnostics: "" });
}, 30_000);
