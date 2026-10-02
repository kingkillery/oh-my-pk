import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ColabAccelerator, launchColabModel } from "../src/slash-commands/helpers/colab-model";

interface CommandStep {
	args: string[];
	exitCode: number;
	stdout?: string;
	stderr?: string;
}

const sessionName = "model-session-contract";
const statusArgs = ["status", "--session", sessionName];
const cacheBoundary = new Error("Reached cache staging after allocation");

// Exercise real CLI subprocesses and stream parsing, with no Colab calls or global mocks.
async function exerciseSession(steps: CommandStep[], accelerator?: ColabAccelerator) {
	const directory = await mkdtemp(join(tmpdir(), "colab-model-session-"));
	const transcriptPath = join(directory, "transcript.json");
	const transcript = Bun.file(transcriptPath);
	await Bun.write(transcript, JSON.stringify({ steps, calls: [] }));
	let cacheReached = false;
	let failure: unknown;
	try {
		await launchColabModel("owner/model", () => {}, {
			sessionName,
			accelerator,
			localPort: 18082,
			fetch: Object.assign(async () => Response.json([{ type: "file", path: "model-Q4_K_M.gguf", size: 1000 }]), {
				preconnect: globalThis.fetch.preconnect,
			}),
			cliCommand: [
				process.execPath,
				"--eval",
				`const file = Bun.file(process.argv[1]);
const transcript = await file.json();
const args = process.argv.slice(2);
const step = transcript.steps[transcript.calls.length];
transcript.calls.push(args);
await Bun.write(file, JSON.stringify(transcript));
if (!step || JSON.stringify(args) !== JSON.stringify(step.args)) {
  process.stderr.write("Unexpected command: " + JSON.stringify(args));
  process.exit(99);
}
process.stdout.write(step.stdout ?? "");
process.stderr.write(step.stderr ?? "");
process.exitCode = step.exitCode;`,
				transcriptPath,
			],
			prepareModelCache: async () => {
				cacheReached = true;
				throw cacheBoundary;
			},
		}).catch(error => {
			failure = error;
		});
		const { calls } = await transcript.json();
		expect(calls).toEqual(steps.map(step => step.args));
		return { failure, cacheReached };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function failedAllocation(accelerator: ColabAccelerator = "T4"): CommandStep[] {
	return [
		{ args: statusArgs, exitCode: 1, stderr: "Status unavailable" },
		{
			args: ["new", "--session", sessionName, ...(accelerator === "CPU" ? [] : ["--gpu", accelerator])],
			exitCode: 1,
			stderr: "Allocation failed",
		},
	];
}

for (const recovered of [false, true]) {
	for (const stream of ["stdout", "stderr"] as const) {
		test(`automatic selection refuses CPU on ${stream} during ${recovered ? "recovery" : "initial status"}`, async () => {
			const result = await exerciseSession([
				...(recovered ? failedAllocation() : []),
				{ args: statusArgs, exitCode: 0, [stream]: "Hardware: CPU" },
			]);
			expect(result.failure).toEqual(
				new Error(
					`${sessionName} is a CPU runtime; pass --accelerator CPU to reuse it, or stop it to launch on a GPU.`,
				),
			);
			expect(result.cacheReached).toBe(false);
		});
	}

	test(`explicit CPU opt-in permits ${recovered ? "recovery" : "reuse"}`, async () => {
		const result = await exerciseSession(
			[...(recovered ? failedAllocation("CPU") : []), { args: statusArgs, exitCode: 0, stdout: "Hardware: CPU" }],
			"CPU",
		);
		expect(result.failure).toBe(cacheBoundary);
		expect(result.cacheReached).toBe(true);
	});
}

for (const accelerator of ["T4", "L4", "A100", "H100", "G4"] as const) {
	test(`automatic selection permits recovery on ${accelerator}`, async () => {
		const result = await exerciseSession([
			...failedAllocation(),
			{ args: statusArgs, exitCode: 0, stdout: `Hardware: ${accelerator}` },
		]);
		expect(result.failure).toBe(cacheBoundary);
		expect(result.cacheReached).toBe(true);
	});
}

test("explicit GPU selection permits matching recovery", async () => {
	const result = await exerciseSession(
		[...failedAllocation("L4"), { args: statusArgs, exitCode: 0, stdout: "Hardware: L4" }],
		"L4",
	);
	expect(result.failure).toBe(cacheBoundary);
	expect(result.cacheReached).toBe(true);
});

for (const accelerator of ["CPU", "T4"] as const) {
	test(`explicit GPU selection rejects recovery on ${accelerator}`, async () => {
		const result = await exerciseSession(
			[...failedAllocation("L4"), { args: statusArgs, exitCode: 0, stdout: `Hardware: ${accelerator}` }],
			"L4",
		);
		expect(result.failure).toEqual(
			new Error(`${sessionName} is already using ${accelerator}; stop it before requesting L4.`),
		);
		expect(result.cacheReached).toBe(false);
	});
}

test("a missing session whose name contains a GPU is allocated, not reused", async () => {
	// The real CLI exits 0 for a missing session; the name must not be read as its hardware.
	const result = await exerciseSession(
		[
			{ args: statusArgs, exitCode: 0, stdout: "[colab] Session 'ompk-colab-t4' not found." },
			{ args: ["new", "--session", sessionName, "--gpu", "L4"], exitCode: 0, stdout: "Hardware: L4" },
		],
		"L4",
	);
	expect(result.failure).toBe(cacheBoundary);
	expect(result.cacheReached).toBe(true);
});
