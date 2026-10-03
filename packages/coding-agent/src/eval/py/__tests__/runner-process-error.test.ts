import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../runner.py", import.meta.url));
const stdoutMarker = "SYNTHETIC_PRIVATE_STDOUT_66";
const stderrMarker = "SYNTHETIC_PRIVATE_STDERR_66";

async function execute(code: string): Promise<string> {
	const proc = Bun.spawn(["python3", runner], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const deadline = setTimeout(() => proc.kill(), 4_000);
	try {
		proc.stdin.write(`${JSON.stringify({ id: "regression", code })}\n`);
		const reader = proc.stdout.getReader();
		const decoder = new TextDecoder();
		let output = "";
		while (true) {
			const { value, done } = await reader.read();
			if (done) throw new Error("Python runner exited before completing the request");
			output += decoder.decode(value, { stream: true });
			if (
				output
					.split("\n")
					.slice(0, -1)
					.some(line => line && JSON.parse(line).type === "done")
			)
				return output;
		}
	} finally {
		clearTimeout(deadline);
		proc.kill();
		await proc.exited;
	}
}

describe("Python runner captured process errors", () => {
	for (const timeout of [false, true]) {
		for (const text of [false, true]) {
			it(`withholds captured streams for ${timeout ? "TimeoutExpired" : "CalledProcessError"} (text=${text})`, async () => {
				// Keep markers out of argv/traceback: only captured file contents are private here.
				const child = `import sys, time; print('${stdoutMarker}', flush=True); print('${stderrMarker}', file=sys.stderr, flush=True); ${timeout ? "time.sleep(30)" : "sys.exit(17)"}`;
				const safeCode = [
					"import subprocess, sys, tempfile, pathlib",
					`child = ${JSON.stringify(child)}`,
					"with tempfile.TemporaryDirectory() as directory:",
					"    script = pathlib.Path(directory) / 'child.py'",
					"    script.write_text(child)",
					`    subprocess.run([sys.executable, str(script)], capture_output=True, text=${text ? "True" : "False"}, check=True${timeout ? ", timeout=0.2" : ""})`,
				].join("\n");
				const output = await execute(safeCode);
				expect(output).not.toContain(stdoutMarker);
				expect(output).not.toContain(stderrMarker);
				const error = output
					.trim()
					.split("\n")
					.map(line => JSON.parse(line))
					.find(frame => frame.type === "error");
				expect(error.ename).toBe(timeout ? "TimeoutExpired" : "CalledProcessError");
				expect(error.command[1]).toEndWith("child.py");
				expect(error.traceback.length).toBeGreaterThan(0);
				expect(error.stdout).toContain("withheld");
				expect(error.stderr).toContain("withheld");
				if (timeout) {
					expect(error.returncode).toBeUndefined();
					expect(error.evalue).toContain("0.2 seconds");
				} else {
					expect(error.returncode).toBe(17);
				}
			});
		}
	}

	it("preserves empty stream diagnostics without claiming output was withheld", async () => {
		const output = await execute(
			"import subprocess\nraise subprocess.CalledProcessError(3, ['safe-command'], output=b'', stderr=None)",
		);
		expect(output).not.toContain("withheld");
		expect(output).toContain('"stdout": ""');
		expect(output).toContain('"stderr": ""');
	});

	it("continues streaming explicitly printed output", async () => {
		const output = await execute("print('ordinary diagnostic', flush=True)\nraise ValueError('ordinary failure')");
		expect(output).toContain("ordinary diagnostic");
		expect(output).toContain("ordinary failure");
	});

	it("allows explicit recovery after caller-controlled redaction", async () => {
		const output = await execute(
			[
				"import subprocess",
				`marker = ${JSON.stringify(stdoutMarker)}`,
				"try:",
				"    raise subprocess.TimeoutExpired(['safe-command'], 1, output=('progress ' + marker).encode())",
				"except subprocess.TimeoutExpired as error:",
				"    print(error.stdout.decode().replace(marker, '[redacted]'))",
			].join("\n"),
		);
		expect(output).toContain("progress [redacted]");
		expect(output).not.toContain(stdoutMarker);
	});
});
