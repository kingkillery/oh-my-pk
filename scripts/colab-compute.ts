/** General Colab allocation entrypoint. No model inference or fallback is implied. */
import { createInterface } from "node:readline/promises";
import {
	assertComputeLease,
	ColabComputePolicy,
	type ComputeConfirmation,
	type ComputeRequest,
} from "../packages/coding-agent/src/slash-commands/helpers/colab-compute-policy";
import {
	buildColabCommand,
	isColabSessionMissing,
} from "../packages/coding-agent/src/slash-commands/helpers/colab-model";
import { armWindowsCutoff } from "../packages/coding-agent/src/slash-commands/helpers/decision-model";

interface Result {
	exitCode: number;
	stdout: string;
	stderr: string;
}
export interface ComputeCliDeps {
	run: (args: readonly string[], timeoutMs: number) => Promise<Result>;
	confirm?: ComputeConfirmation;
	arm: (sessionName: string, cutoffAt: string) => Promise<{ cutoffAt: string }>;
	policy: ColabComputePolicy;
}
export async function launchApprovedColab(request: ComputeRequest, deps: ComputeCliDeps) {
	const status = await deps.run(["status", "--session", request.sessionName], 60000);
	if (status.exitCode === 0 && !isColabSessionMissing(status.stdout + status.stderr)) return { reused: true };
	if (status.exitCode !== 0) throw new Error("Colab status could not be verified; refusing an ambiguous allocation.");
	const lease = await deps.policy.authorize(request, deps.confirm, deps.arm);
	assertComputeLease(lease, request, deps.policy.now());
	const args = [
		"new",
		"--session",
		request.sessionName,
		...(request.accelerator === "CPU" ? [] : ["--gpu", request.accelerator]),
	];
	const allocated = await deps.run(args, Math.min(300000, Date.parse(lease.cutoffAt) - deps.policy.now()));
	if (allocated.exitCode !== 0)
		throw new Error(
			"Colab allocation failed; original cutoff remains armed. Inspect the exact session before retrying.",
		);
	return { reused: false, cutoffAt: lease.cutoffAt, hardDeadlineAt: lease.hardDeadlineAt };
}
if (import.meta.main) {
	const args = Bun.argv.slice(2);
	const option = (name: string) => {
		const i = args.indexOf(name);
		return i < 0 ? undefined : args[i + 1];
	};
	if (args.includes("--help")) {
		process.stdout.write(
			"Usage: bun scripts/colab-compute.ts --account EMAIL --task ID --model PURPOSE --session NAME --gpu T4 [--minutes 60]\nAsks separately for compute permission. Maximum 120 minutes including cleanup. No --yes or yolo bypass.\n",
		);
	} else {
		const request = {
			account: option("--account") ?? "",
			taskId: option("--task") ?? "",
			model: option("--model") ?? "general-compute",
			sessionName: option("--session") ?? "",
			accelerator: option("--gpu") ?? "T4",
			minutes: Number(option("--minutes") ?? 60),
		};
		if (
			args.some(
				(v, i) => i % 2 === 0 && !["--account", "--task", "--model", "--session", "--gpu", "--minutes"].includes(v),
			)
		)
			throw new Error("Unknown compute CLI option");
		if (!["CPU", "T4", "L4", "A100", "H100", "G4"].includes(request.accelerator))
			throw new Error("Invalid accelerator; fallback is disabled");
		const run = async (argv: readonly string[], timeoutMs: number) => {
			const base = buildColabCommand(["status"]).slice(0, -1);
			const child = Bun.spawn([...base, ...argv], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			const timer = setTimeout(() => child.kill(), timeoutMs);
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				return { stdout, stderr, exitCode };
			} finally {
				clearTimeout(timer);
			}
		};
		// Bind the declared account to the CLI's current identity before permission or mutation.
		const identity = await run(["whoami"], 60000);
		if (
			identity.exitCode !== 0 ||
			!(identity.stdout.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).some(
				email => email.toLowerCase() === request.account.toLowerCase(),
			) ||
			!request.account.includes("@")
		)
			throw new Error("Colab account identity could not be verified");
		const result = await launchApprovedColab(request, {
			policy: new ColabComputePolicy(),
			run,
			arm: (session, cutoff) => armWindowsCutoff(session, (Date.parse(cutoff) - Date.now()) / 60000, cutoff),
			confirm: async (_request, summary) => {
				if (!process.stdin.isTTY || !process.stdout.isTTY)
					throw new Error(
						"Compute approval requires the operator TTY or trusted harness confirmation; piped approval is refused",
					);
				const io = createInterface({ input: process.stdin, output: process.stdout });
				try {
					return (await io.question(summary + "\nType approve to allocate: ")).trim() === "approve"
						? "once"
						: "deny";
				} finally {
					io.close();
				}
			},
		});
		process.stdout.write(JSON.stringify(result) + "\n");
	}
}
