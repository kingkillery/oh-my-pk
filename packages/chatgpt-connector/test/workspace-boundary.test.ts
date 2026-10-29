import { expect, test } from "bun:test";
import { requireSandboxedRunner } from "../src/workspace-boundary";

test("fails closed unless the host supplies a sandbox-enforcing runner", () => {
	expect(() => requireSandboxedRunner(undefined)).toThrow("sandbox-enforcing runner");
	const runner = () => {};
	expect(requireSandboxedRunner(runner)).toBe(runner);
});
