/**
 * ssh-exec — direct argv spawn + Windows-path helpers for the mesh CLI.
 *
 * Why this exists: on Windows, piping scripts into bash strips backslashes,
 * and Windows OpenSSH ssh/scp reject backslash paths delivered through any
 * shell pipeline. `direct()` runs an argv array via Bun.spawn (no shell),
 * `toWinPath()` normalizes any path to the forward-slash form OpenSSH accepts,
 * and `sshArgv()` returns the full argv to launch ssh with a mesh node
 * (BatchMode=yes so an unkeyed host fails fast instead of hanging on a prompt).
 */

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export async function direct(argv: string[], opts: { cwd?: string } = {}): Promise<ExecResult> {
	const proc = Bun.spawn({
		cmd: argv,
		cwd: opts.cwd ?? process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
		env: process.env,
	});
	const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
	const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";
	const code = await proc.exited;
	return { code, stdout, stderr };
}

export function toWinPath(p: string): string {
	const r = Bun.spawnSync(["cygpath", "-m", p], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) return p.replace(/\\/g, "/");
	const out = r.stdout ? new TextDecoder().decode(r.stdout).trim() : "";
	return (out || p).replace(/\\/g, "/");
}

export interface SshArgvOptions {
	key?: string;
	port?: string;
	connectTimeout?: number;
}

export function sshArgv(opts: SshArgvOptions = {}): string[] {
	const parts = ["ssh"];
	if (opts.key) parts.push("-i", toWinPath(opts.key));
	if (opts.port) parts.push("-p", opts.port);
	parts.push("-o", `ConnectTimeout=${opts.connectTimeout ?? 10}`);
	parts.push("-o", "StrictHostKeyChecking=accept-new");
	parts.push("-o", "BatchMode=yes");
	return parts;
}
