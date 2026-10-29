/** Refuse the in-process runner: cwd and tool selection are not a filesystem sandbox. */
export function requireSandboxedRunner<T>(runner: T | undefined): T {
	if (!runner) throw new Error("Connector requires a sandbox-enforcing runner; the in-process runner is disabled");
	return runner;
}
