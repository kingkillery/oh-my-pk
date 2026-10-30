/** Read-only CLI identity proof. Raw identity output is never logged. */
export function parseComputeAccount(output: string): string {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		value = undefined;
	}
	const jsonEmail = value && typeof value === "object" && "email" in value ? value.email : undefined;
	const email =
		typeof jsonEmail === "string" ? jsonEmail : /(?:^|\n)\s*(?:email|account)\s*[:=]\s*([^\s]+)/i.exec(output)?.[1];
	if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		throw new Error("Colab CLI account identity could not be verified; no compute was authorized.");
	return email.toLowerCase();
}
export async function resolveComputeAccount(): Promise<string> {
	const override = Bun.env.OMPK_COLAB_CLI?.trim();
	const cmd = override
		? [override, "whoami"]
		: process.platform === "win32"
			? ["wsl", "colab", "whoami"]
			: ["colab", "whoami"];
	const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
	const timer = setTimeout(() => child.kill(), 60000);
	try {
		const [stdout, , exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0)
			throw new Error("Colab CLI account identity could not be verified; no compute was authorized.");
		return parseComputeAccount(stdout);
	} finally {
		clearTimeout(timer);
	}
}
