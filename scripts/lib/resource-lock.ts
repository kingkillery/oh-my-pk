import * as os from "node:os";
import * as path from "node:path";

export type ReleaseResourceLock = () => Promise<void>;

export async function acquireResourceLock(name: string): Promise<ReleaseResourceLock> {
	const safeName = name.replace(/[^A-Za-z0-9._-]/g, "-");
	const proc = process.platform === "win32" ? spawnWindowsMutex(safeName) : spawnUnixLock(safeName);
	try {
		await waitUntilAcquired(proc.stdout);
	} catch (error) {
		proc.kill();
		await proc.exited;
		throw error;
	}
	let released = false;
	return async () => {
		if (released) return;
		released = true;
		proc.stdin.write("release\n");
		proc.stdin.end();
		const exitCode = await proc.exited;
		if (exitCode !== 0) throw new Error(`Resource lock holder exited with code ${exitCode}`);
	};
}

function spawnWindowsMutex(name: string) {
	const powershell = Bun.which("powershell.exe") ?? Bun.which("pwsh.exe");
	if (!powershell) throw new Error("PowerShell is required to acquire the verification resource mutex on Windows");
	const script = [
		`$mutex = [Threading.Mutex]::new($false, 'Global\\${name}')`,
		"try {",
		"[void]$mutex.WaitOne()",
		"[Console]::Out.WriteLine('acquired')",
		"[Console]::Out.Flush()",
		"[void][Console]::In.ReadLine()",
		"} finally {",
		"try { $mutex.ReleaseMutex() } catch {}",
		"$mutex.Dispose()",
		"}",
	].join("; ");
	return Bun.spawn([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
}

function spawnUnixLock(name: string) {
	const lockPath = path.join(os.tmpdir(), `${name}.lock`);
	const flock = Bun.which("flock");
	if (flock) {
		return Bun.spawn([flock, "-x", lockPath, "sh", "-c", "printf 'acquired\\n'; read _"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
	}
	const python = Bun.which("python3");
	if (!python) throw new Error("flock or python3 is required to acquire the verification resource lock");
	const script = [
		"import fcntl, sys",
		"lock = open(sys.argv[1], 'a+')",
		"fcntl.flock(lock, fcntl.LOCK_EX)",
		"print('acquired', flush=True)",
		"sys.stdin.readline()",
	].join("; ");
	return Bun.spawn([python, "-u", "-c", script, lockPath], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
}

async function waitUntilAcquired(stdout: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) throw new Error("Resource lock holder exited before acquiring the lock");
			buffered += decoder.decode(value, { stream: true });
			const newline = buffered.indexOf("\n");
			if (newline < 0) continue;
			if (buffered.slice(0, newline).trim() !== "acquired") {
				throw new Error(`Unexpected resource lock response: ${buffered.slice(0, newline)}`);
			}
			return;
		}
	} finally {
		reader.releaseLock();
	}
}
