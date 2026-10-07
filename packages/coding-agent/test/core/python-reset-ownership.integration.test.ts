import { afterEach, describe, expect, it } from "bun:test";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { disposeAllKernelSessions, disposeKernelSessionsByOwner, executePython } from "../../src/eval/py/executor";

describe.skipIf(Bun.env.PI_PYTHON_INTEGRATION !== "1")("Python reset ownership", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	it("preserves shared state on refused resets and permits the remaining owner to reset", async () => {
		using directory = TempDir.createSync("python-reset-owner-");
		const options = {
			cwd: directory.path(),
			sessionId: "reset-owners",
			kernelMode: "session" as const,
			interpreter: Bun.env.PI_TEST_PYTHON,
		};
		expect(await executePython("retained = 73", { ...options, kernelOwnerId: "parent" })).toMatchObject({
			exitCode: 0,
			cancelled: false,
		});
		expect((await executePython("print(retained)", { ...options, kernelOwnerId: "child" })).output.trim()).toBe("73");
		const attempts = await Promise.allSettled(
			["parent", "child"].map(kernelOwnerId =>
				executePython("retained = 0", { ...options, kernelOwnerId, reset: true }),
			),
		);
		for (const attempt of attempts) {
			expect(attempt.status).toBe("rejected");
			if (attempt.status === "rejected") expect(String(attempt.reason)).toContain("other owners are attached");
		}
		expect((await executePython("print(retained)", { ...options, kernelOwnerId: "parent" })).output.trim()).toBe(
			"73",
		);
		await disposeKernelSessionsByOwner("child");
		expect((await executePython("print(retained)", { ...options, kernelOwnerId: "parent" })).output.trim()).toBe(
			"73",
		);
		await expect(executePython("pass", { ...options, kernelOwnerId: "stranger", reset: true })).rejects.toThrow(
			"other owners",
		);
		const reset = await executePython('print("retained" in globals())', {
			...options,
			kernelOwnerId: "parent",
			reset: true,
		});
		expect(reset.exitCode).toBe(0);
		expect(reset.output.trim()).toBe("False");
	}, 30_000);
});
