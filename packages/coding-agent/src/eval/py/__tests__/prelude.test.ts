import { describe, expect, it } from "bun:test";
import { PYTHON_PRELUDE } from "../prelude";

describe("python prelude", () => {
	it.skipIf(!Bun.which("python3") && !Bun.which("python"))(
		"preserves write contents and caller-controlled subprocess capture types",
		async () => {
			const python = Bun.which("python3") ?? Bun.which("python");
			if (!python) throw new Error("Python 3 is required");
			const content =
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Fixture preserves nested JavaScript interpolation literally.
				'const render = value => `outer ${value ? `inner ${value}` : "none"}`;\nexport default render;\n';
			const source = [
				"import pathlib, subprocess, sys, tempfile",
				'namespace = {"__omp_display": lambda *args, **kwargs: None}',
				`exec(${JSON.stringify(PYTHON_PRELUDE)}, namespace)`,
				`content = ${JSON.stringify(content)}`,
				"with tempfile.TemporaryDirectory() as directory:",
				"    target = pathlib.Path(directory) / 'nested' / 'fixture.js'",
				"    written = namespace['write'](target, content)",
				"    assert isinstance(written, pathlib.Path) and written == target",
				"    assert target.read_bytes() == content.encode('utf-8')",
				"    assert namespace['read'](written) == content",
				"    captured = subprocess.run([sys.executable, '-c', 'print(42)'], capture_output=True, text=True)",
				"    uncaptured = subprocess.run([sys.executable, '-c', 'print(42)'], stdout=subprocess.DEVNULL)",
				"    assert captured.stdout.strip() == '42' and isinstance(captured.stdout, str)",
				"    assert uncaptured.stdout is None",
				"print('write and capture contracts passed')",
			].join("\n");
			const proc = Bun.spawn([python, "-c", source], { stdout: "pipe", stderr: "pipe" });
			const timeout = setTimeout(() => proc.kill(), 4_000);
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
				expect(stdout.trim()).toBe("write and capture contracts passed");
			} finally {
				clearTimeout(timeout);
				if (proc.exitCode === null) proc.kill();
				await proc.exited;
			}
		},
	);

	it("exposes read(path, offset?, limit?) with positional optional args", () => {
		// The eval docs advertise `read(path, offset?=1, limit?=None)`. A
		// keyword-only signature (`def read(path, *, offset=1, limit=None)`)
		// makes `read("file", 10)` raise `TypeError: read() takes 1 positional
		// argument but 2 were given`, which agents in the wild repeatedly hit.
		// Lock the contract so the helper accepts both positional and keyword
		// forms.
		const match = PYTHON_PRELUDE.match(/def\s+read\(([^)]+)\)/);
		expect(match).not.toBeNull();
		const signature = match?.[1] ?? "";
		expect(signature).not.toContain("*,");
		expect(signature).toContain("offset");
		expect(signature).toContain("limit");
	});

	it("exposes isolation artifacts on the agent() handle node", () => {
		// agent(..., handle=True) is the only escape hatch for
		// recovering apply=False patch/branch/nested artifacts (the bare
		// schema return is just the parsed object), so the helper MUST
		// translate the bridge's camelCase details onto the node — otherwise
		// an isolated apply=False workflow loses captured nested patches.
		expect(PYTHON_PRELUDE).toContain('("patchPath", "patch_path")');
		expect(PYTHON_PRELUDE).toContain('("branchName", "branch_name")');
		expect(PYTHON_PRELUDE).toContain('("nestedPatches", "nested_patches")');
		expect(PYTHON_PRELUDE).toContain('("changesApplied", "changes_applied")');
		expect(PYTHON_PRELUDE).toContain('("isolationSummary", "isolation_summary")');
	});
});
