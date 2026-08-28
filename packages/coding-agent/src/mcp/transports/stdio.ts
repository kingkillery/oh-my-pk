/**
 * MCP stdio transport.
 *
 * Implements JSON-RPC 2.0 over subprocess stdin/stdout.
 * Messages are newline-delimited JSON.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir, readJsonl } from "@pk-nerdsaver-ai/pi-utils";
import type { Subprocess } from "bun";
import { hostHasInheritableConsole } from "../../eval/py/spawn-options";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPStdioServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import { RequestIdAllocator } from "../request-id";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";

/** Subprocess argv and platform-derived spawn flags for an MCP stdio server. */
export interface StdioSpawnCommand {
	cmd: string[];
	/**
	 * Hide the Windows console window for the direct child.
	 *
	 * Windows uses this only when the OMP host has no console to share. When
	 * the host is running inside a terminal, `windowsHide: true` maps to
	 * `CREATE_NO_WINDOW`, which strips that inheritable console from hidden
	 * `cmd.exe` / PowerShell wrapper chains. Their console grandchildren then
	 * allocate fresh visible conhost windows during startup or reconnects
	 * (#3567).
	 */
	windowsHide?: boolean;
	/**
	 * Run the subprocess in its own session when the platform can safely do so.
	 *
	 * Linux/other POSIX: `true`. Detach → `setsid`, so the MCP process tree has
	 * no controlling terminal and terminal job-control signals (Ctrl+Z SIGTSTP,
	 * background-read SIGTTIN) cannot stop stdio servers such as
	 * `chrome-devtools-mcp` and leave our read loop blocked on silent pipes.
	 *
	 * macOS: `false`. LaunchServices/TCC attributes Apple Events automation to
	 * the responsible terminal process only while the child stays in the
	 * inherited session; detaching via `setsid` prevents the permission prompt
	 * for servers such as `xcrun mcpbridge` (#4987).
	 *
	 * Windows: `false`. There is no SIGTSTP/SIGTTIN to escape, and Windows
	 * wrapper chains must stay in the OMP console session so nested console
	 * grandchildren keep stdout routed through our pipe (#3544).
	 */
	detached: boolean;
	/**
	 * Pass argv to `Bun.spawn` verbatim (Windows only), suppressing the
	 * default libuv backslash-quoting.
	 *
	 * Set when `cmd` already holds a `cmd.exe /d /e:ON /v:OFF /c "<line>"`
	 * command line escaped for `cmd.exe`'s parser (see `buildCmdExeArgv`).
	 * libuv's quoting targets `CommandLineToArgvW`, not `cmd.exe`, so letting
	 * it re-quote a batch launch would corrupt arguments and re-open the
	 * `%VAR%` / quote-injection holes the escaping closes (BatBadBut,
	 * CVE-2024-24576).
	 */
	windowsVerbatimArguments?: boolean;
}

/** Inputs used to resolve platform-specific stdio spawn behavior. */
export interface ResolveStdioSpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	hostHasInheritableConsole?: boolean;
	platform?: NodeJS.Platform;
}

const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];
const WINDOWS_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);

function getCaseInsensitiveEnv(env: Record<string, string | undefined>, name: string): string | undefined {
	const direct = env[name];
	if (direct !== undefined) return direct;
	const normalized = name.toLowerCase();
	for (const [key, value] of Object.entries(env)) {
		if (key.toLowerCase() === normalized) return value;
	}
	return undefined;
}

function getWindowsPathExt(env: Record<string, string | undefined>): string[] {
	const raw = getCaseInsensitiveEnv(env, "PATHEXT");
	if (!raw) return DEFAULT_WINDOWS_PATHEXT;
	const extensions: string[] = [];
	for (const part of raw.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		extensions.push(trimmed.startsWith(".") ? trimmed : `.${trimmed}`);
	}
	return extensions.length > 0 ? extensions : DEFAULT_WINDOWS_PATHEXT;
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function hasPathSegment(command: string): boolean {
	return command.includes("/") || command.includes("\\") || path.isAbsolute(command);
}

function hasExecutableExtension(command: string, extensions: string[]): boolean {
	const ext = path.extname(command).toLowerCase();
	if (!ext) return false;
	return extensions.some(candidate => candidate.toLowerCase() === ext);
}

async function resolveWindowsCommandPath(
	command: string,
	cwd: string,
	env: Record<string, string | undefined>,
): Promise<string | null> {
	const extensions = getWindowsPathExt(env);
	const hasExt = hasExecutableExtension(command, extensions);
	const candidates = hasExt ? [command] : extensions.map(ext => `${command}${ext}`);

	if (hasPathSegment(command)) {
		for (const candidate of candidates) {
			const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
			if (await fileExists(resolved)) return resolved;
		}
		return hasExt ? command : null;
	}

	// Match cmd.exe's lookup order for an unqualified name: current directory
	// first, then PATH. Skipping cwd would launch a global shim instead of a
	// project-local one with the same name.
	const searchDirs = [cwd];
	const pathValue = getCaseInsensitiveEnv(env, "PATH");
	if (pathValue) {
		for (const dir of pathValue.split(";")) {
			if (dir) searchDirs.push(dir);
		}
	}
	for (const dir of searchDirs) {
		for (const candidate of candidates) {
			const resolved = path.join(dir, candidate);
			if (await fileExists(resolved)) return resolved;
		}
	}
	return hasExt ? command : null;
}

function resolveWindowsShimPath(value: string, shimDir: string): string | null {
	const match = /^%dp0%[\\/]*(.*)$/i.exec(value);
	if (!match) return null;
	const suffix = match[1];
	if (!suffix) return shimDir;
	return path.join(shimDir, ...suffix.split(/[\\/]+/).filter(Boolean));
}

async function resolveWindowsNpmShimCommand(
	command: string,
	args: readonly string[],
	cwd: string,
	windowsHide: boolean,
): Promise<StdioSpawnCommand | null> {
	if (!isWindowsBatchCommand(command)) return null;
	if (!hasPathSegment(command)) return null;
	const commandPath = path.resolve(cwd, command);
	const commandName = path
		.basename(commandPath)
		.replace(/\.cmd$/i, "")
		.toLowerCase();
	if (commandName === "npx") return null;

	let content: string;
	try {
		content = await Bun.file(commandPath).text();
	} catch {
		return null;
	}

	// cmd-shim emits the same invocation line for every interpreter; only
	// bypass cmd.exe when the shim's fallback interpreter is actually node.
	// The IF EXIST branch assigns a %dp0%-prefixed value, so requiring a
	// non-%-leading SET value picks the bare PATH-fallback program name.
	const prog = /SET\s+"_prog=([^%"][^"]*)"/i.exec(content)?.[1];
	if (
		!prog ||
		path
			.basename(prog)
			.replace(/\.exe$/i, "")
			.toLowerCase() !== "node"
	)
		return null;

	const rawTarget = /"%_prog%"\s+"([^"]+)"\s+%\*/i.exec(content)?.[1];
	if (!rawTarget) return null;

	const target = resolveWindowsShimPath(rawTarget, path.dirname(commandPath));
	if (!target) return null;

	const siblingNode = path.join(path.dirname(commandPath), "node.exe");
	const nodeCommand = (await fileExists(siblingNode)) ? siblingNode : "node";
	return {
		cmd: [nodeCommand, target, ...args],
		windowsHide,
		detached: false,
	};
}

function isWindowsBatchCommand(command: string): boolean {
	return WINDOWS_BATCH_EXTENSIONS.has(path.extname(command).toLowerCase());
}

function resolveComSpec(env: Record<string, string | undefined>): string {
	const comspec = getCaseInsensitiveEnv(env, "COMSPEC");
	return comspec && comspec.length > 0 ? comspec : "cmd.exe";
}

// Argument bytes cmd.exe delivers unchanged without quoting. Anything outside
// this set (spaces, quotes, `%`, shell metacharacters, non-ASCII) forces the
// quoted+escaped path below. Mirrors the fuzz-tested allow-list from Zig's
// BatBadBut mitigation.
const CMD_SAFE_ARG = /^[A-Za-z0-9#$*+\-./:?@\\_]+$/;

/**
 * Escape the interior of a `cmd.exe`-quoted token: neutralize `%VAR%` expansion
 * and double any backslash run that precedes a quote (including the caller's
 * closing quote) so `CommandLineToArgvW` delivers the backslashes literally.
 *
 * `cmd.exe` re-parses the whole `/c` string and expands `%…%` *before* the
 * batch shim's own argv split runs, so both the command path and every argument
 * must pass through this. Percent → `%%cd:~,%` (which expands to nothing,
 * leaving a literal `%`) and `"` → `""` are the documented BatBadBut mitigation
 * (CVE-2024-24576). The caller supplies the surrounding double quotes.
 *
 * @see https://flatt.tech/research/posts/batbadbut-you-cant-securely-execute-commands-on-windows/
 */
function escapeCmdQuotedInterior(value: string): string {
	let out = "";
	let backslashes = 0;
	for (const ch of value) {
		if (ch === "\\") {
			backslashes += 1;
			out += ch;
		} else if (ch === '"') {
			out += "\\".repeat(backslashes);
			out += '""';
			backslashes = 0;
		} else if (ch === "%") {
			out += "%%cd:~,%";
			backslashes = 0;
		} else {
			backslashes = 0;
			out += ch;
		}
	}
	// Double the trailing backslash run so it stays literal before the closing
	// quote the caller appends.
	out += "\\".repeat(backslashes);
	return out;
}

/** Reject bytes that cannot round-trip through `cmd.exe`'s `/c` command line. */
function assertCmdBatchToken(value: string, kind: "command" | "argument"): void {
	// NUL/LF act as an end-of-command marker and CR is stripped, so any of them
	// would silently truncate or corrupt the launch.
	if (/[\0\r\n]/.test(value)) {
		throw new Error(`Windows batch MCP ${kind} cannot contain NUL, CR, or LF characters`);
	}
}

/**
 * Escape one argument for `cmd.exe`'s command-line pre-parse so a `.cmd`/`.bat`
 * shim receives it verbatim. Quotes only when the argument is empty, ends in a
 * backslash, or holds a byte outside {@link CMD_SAFE_ARG}; the quoted body is
 * escaped by {@link escapeCmdQuotedInterior}.
 *
 * @throws when the argument contains NUL, CR, or LF (see {@link assertCmdBatchToken}).
 */
function escapeCmdBatchArg(arg: string): string {
	assertCmdBatchToken(arg, "argument");
	const needsQuotes = arg.length === 0 || arg.endsWith("\\") || !CMD_SAFE_ARG.test(arg);
	// An unquoted arg is pure allow-list bytes (no `%`, `"`, or trailing `\`), so
	// it needs no interior escaping.
	return needsQuotes ? `"${escapeCmdQuotedInterior(arg)}"` : arg;
}

/**
 * Build the `cmd.exe` argv for a Windows `.cmd`/`.bat` (or unresolved bare)
 * MCP command.
 *
 * The trailing element is a single `/c` string wrapped in an outer quote pair
 * that `cmd.exe` strips (its opening-quote rule). The command token is always
 * quoted and, like every argument, escaped so a `%` in the resolved path (e.g.
 * `C:\work\%TOKEN%\server.cmd`) is not expanded before the shim launches.
 * `/e:ON` keeps command extensions on (required for the `%%cd:~,%` trick) and
 * `/v:OFF` disables delayed expansion. The result MUST be spawned with
 * `windowsVerbatimArguments` so libuv passes it through unmodified.
 */
function buildCmdExeArgv(comspec: string, command: string, args: readonly string[]): string[] {
	assertCmdBatchToken(command, "command");
	let line = `""${escapeCmdQuotedInterior(command)}"`;
	for (const arg of args) line += ` ${escapeCmdBatchArg(arg)}`;
	line += '"';
	return [comspec, "/d", "/e:ON", "/v:OFF", "/c", line];
}

/**
 * Resolve the subprocess argv used to launch an MCP stdio server.
 *
 * On Windows, our PATH/PATHEXT walk may return `null` for a bare command
 * (e.g. `npx`) — `Bun.env.PATH` empty under a restricted parent process,
 * UNC/network mounts that reject `fs.access`, locked-down shells. The
 * legacy fallback handed `Bun.spawn` the bare name, but `CreateProcess`
 * only appends `.exe` for extensionless names — `.cmd`/`.bat` are never
 * tried, so `npx` (which exists only as `npx.cmd` on Windows) crashes the
 * subprocess immediately. When the resolver can't pin the command down,
 * route through `cmd.exe` so Windows's own PATHEXT lookup runs.
 */
export async function resolveStdioSpawnCommand(
	config: MCPStdioServerConfig,
	options: ResolveStdioSpawnOptions,
): Promise<StdioSpawnCommand> {
	const args = config.args ?? [];
	if (options.platform !== "win32") return { cmd: [config.command, ...args], detached: options.platform !== "darwin" };

	const windowsHide = options.hostHasInheritableConsole === undefined ? true : !options.hostHasInheritableConsole;
	const resolved = await resolveWindowsCommandPath(config.command, options.cwd, options.env);
	const resolvedCommand = resolved ?? config.command;
	const npmShimCommand = await resolveWindowsNpmShimCommand(resolvedCommand, args, options.cwd, windowsHide);
	if (npmShimCommand) return npmShimCommand;

	// Direct-spawn only when we resolved to a concrete file AND its extension
	// is not a batch script. Everything else (resolved .cmd/.bat, or an
	// unresolved extensionless command) goes through cmd.exe so PATHEXT runs.
	// Windows stdio servers stay attached so wrapper grandchildren inherit the
	// same console session. Only hide the child when OMP itself has no console
	// to share; CREATE_NO_WINDOW breaks console inheritance for nested wrappers.
	const detached = false;
	const needsCmdExe = resolved === null || isWindowsBatchCommand(resolvedCommand);
	if (!needsCmdExe) return { cmd: [resolvedCommand, ...args], windowsHide, detached };

	return {
		cmd: buildCmdExeArgv(resolveComSpec(options.env), resolvedCommand, args),
		windowsHide,
		detached,
		windowsVerbatimArguments: true,
	};
}

/** Minimal write surface of `Subprocess.stdin` we need for framed sends. */
interface FrameSink {
	write(chunk: string): unknown;
	flush(): unknown;
}

/** Narrow a value to a thenable so a rejection handler can be attached. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		value != null &&
		(typeof value === "object" || typeof value === "function") &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

/**
 * Write a newline-delimited JSON-RPC frame to the subprocess's stdin sink,
 * swallowing both synchronous throws and asynchronous rejections so the caller
 * can decide how to react.
 *
 * Bun's `FileSink.write()`/`flush()` can fail two ways once the read end of the
 * pipe has been closed by a subprocess that exited between read-loop ticks:
 *   - a synchronous throw (most reliably observed on Windows), and
 *   - a *rejected Promise* returned from `write()`/`flush()`, i.e. the EPIPE is
 *     surfaced asynchronously (note the `processTicksAndRejections` frame in the
 *     stack traces on #1710 and the follow-up report).
 *
 * A sibling `async` method's `try/catch` only catches the synchronous case; an
 * un-awaited rejected Promise escapes as a fatal unhandled rejection. So we both
 * catch the throw and neutralize any returned promise's rejection.
 *
 * Returns `true` when the frame was accepted synchronously, `false` when the
 * sink threw — callers signal transport closure on `false`. An asynchronous
 * failure cannot be reflected in the return value; it is neutralized here and
 * the dead transport is detected by the read loop / request timeout instead.
 */
export function writeFrame(stdin: FrameSink, frame: string): boolean {
	try {
		const wrote = stdin.write(frame);
		const flushed = stdin.flush();
		if (isThenable(wrote)) wrote.then(undefined, () => {});
		if (isThenable(flushed)) flushed.then(undefined, () => {});
		return true;
	} catch {
		return false;
	}
}
interface MCPStdioListenerState {
	handle: MCPListenHandle;
	requestedNotifications: MCPSubscriptionNotificationFilter;
	acknowledgment: ReturnType<typeof Promise.withResolvers<MCPSubscriptionNotificationFilter>>;
	completion: ReturnType<typeof Promise.withResolvers<void>>;
	stdin: FrameSink;
	onNotification?: (method: string, params: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	writePromise: Promise<void>;
	requestSent: boolean;
	cancellationSent: boolean;
	cancelled: boolean;
	acknowledged: boolean;
	settled: boolean;
}

/** Grace window to observe a cooperative exit after SIGTERM before escalating to SIGKILL. */
const TERM_GRACE_MS = 1000;
/** Grace window to observe SIGKILL taking effect before `close()` gives up and returns. */
const KILL_GRACE_MS = 500;

/**
 * The subset of `Subprocess` that termination needs. Decoupled from the
 * `Subprocess<In, Out, Err>` stdio generics — `#process`'s pipes are
 * irrelevant to signaling — so tests can exercise it against a plain
 * `Bun.spawn(cmd, { stdio: "ignore" })` child without fighting the generics.
 */
interface KillableSubprocess {
	readonly pid: number;
	readonly exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
}

/**
 * Race `exited` against a timer. Resolves `true` once the process has exited
 * within `timeoutMs`, `false` if the timer wins first. `exited` resolving OR
 * rejecting both count as "exited" — mirrors `waitForExit()` in
 * `lsp/client.ts`, which treats the same ambiguity (Bun documents
 * `Subprocess.exited` as resolve-only, but a settle either way means there is
 * nothing left to wait on).
 *
 * The timer is always cleared before returning — win or lose — so a process
 * that exits promptly never leaves a dangling `timeoutMs` timer holding the
 * event loop open behind it.
 */
async function waitForProcessExit(exited: Promise<number>, timeoutMs: number): Promise<boolean> {
	const { promise: timedOut, resolve: resolveTimedOut } = Promise.withResolvers<false>();
	const timer = setTimeout(() => resolveTimedOut(false), timeoutMs);
	try {
		return await Promise.race([
			exited.then(
				() => true,
				() => true,
			),
			timedOut,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** `true` when `error` is a Node errno exception carrying the given `code`. */
function isErrnoCode(error: unknown, code: string): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	return error.code === code;
}

/**
 * Signal `signal` to `proc`. When `detached` is true on a POSIX platform,
 * targets the whole process group via the negative-pid convention
 * (`process.kill(-pid, signal)`) so a detached session leader's descendants —
 * not just the direct child — receive it too; a bare direct-child signal
 * never reaches grandchildren the child itself spawned.
 *
 * `ESRCH` from the group signal means the group is already gone — that is a
 * success (nothing left to signal), not a failure — so it does not fall
 * through. Any other group-signal failure (e.g. `EPERM`) falls back to
 * signaling the direct child as a last resort. Non-detached transports
 * (macOS, Windows, or POSIX where detach did not apply) always signal the
 * direct child only: a negative-pid signal outside a detached session could
 * hit an unrelated process group.
 */
function signalStdioProcess(
	proc: KillableSubprocess,
	detached: boolean,
	signal: NodeJS.Signals,
	platform: NodeJS.Platform,
): void {
	if (detached && platform !== "win32") {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch (error) {
			if (isErrnoCode(error, "ESRCH")) return;
			// Fall through to the direct-child signal below.
		}
	}
	try {
		proc.kill(signal);
	} catch {
		// Already gone.
	}
}

/**
 * Terminate an MCP stdio subprocess: SIGTERM (process-group when `detached`
 * on POSIX, direct child otherwise), wait up to `termGraceMs` for a
 * cooperative exit, then escalate to SIGKILL — waiting up to `KILL_GRACE_MS`
 * more only when the leader itself hadn't already exited. A detached
 * leader's cooperative exit does not prove the whole process group is gone
 * (a grandchild can outlive it and ignore SIGTERM), so detached transports
 * always fire the group SIGKILL sweep, even after a clean SIGTERM exit.
 * Every step is a no-op-safe signal against an already-exited target, so
 * repeat calls (idempotent `close()`) never throw.
 *
 * Exported so tests can exercise group-signal escalation with an explicit
 * `detached`/`platform` pair: `StdioTransport.connect()` derives `detached`
 * from `resolveStdioSpawnCommand()`, which is tied to the host's real
 * `process.platform`, so a POSIX detached session cannot be reproduced
 * end-to-end through `connect()` on a non-Linux dev/CI host. `termGraceMs`
 * preserves the production grace by default while allowing those real
 * subprocess tests to cover the same transition without sleeping for a
 * production-length shutdown window.
 */
export async function terminateStdioProcess(
	proc: KillableSubprocess,
	detached: boolean,
	platform: NodeJS.Platform = process.platform,
	termGraceMs = TERM_GRACE_MS,
): Promise<void> {
	signalStdioProcess(proc, detached, "SIGTERM", platform);
	const exitedOnTerm = await waitForProcessExit(proc.exited, termGraceMs);
	// A non-detached transport has no process group beyond the leader itself:
	// once it exits, there is nothing left to signal. A detached transport's
	// leader exiting is NOT proof the group is empty — a grandchild it spawned
	// can still be alive and ignoring SIGTERM — so detached transports always
	// fall through to the group SIGKILL, even on a cooperative leader exit.
	if (exitedOnTerm && !detached) return;
	signalStdioProcess(proc, detached, "SIGKILL", platform);
	// Once the leader has already exited there is no further `exited` signal
	// to wait on for this call — the SIGKILL above is a fire-and-forget sweep
	// for any surviving group members — so only block on the grace window
	// when the leader itself is still the thing being escalated against.
	if (!exitedOnTerm) await waitForProcessExit(proc.exited, KILL_GRACE_MS);
}

/**
 * Stdio transport for MCP servers.
 * Spawns a subprocess and communicates via stdin/stdout.
 */
export class StdioTransport implements MCPTransport {
	#process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	#connected = false;
	#readLoop: Promise<void> | null = null;
	/**
	 * Set from `resolveStdioSpawnCommand()`'s `detached` flag in `connect()`.
	 * Gates process-group signaling in `close()` — only a transport that
	 * actually spawned into its own session may target it.
	 */
	#detached = false;
	readonly #requestIds = new RequestIdAllocator();

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	configureProtocol(configuration: MCPTransportProtocolConfiguration): void {
		this.#protocolConfiguration = configuration;
	}

	getProtocolConfiguration(): MCPTransportProtocolConfiguration | undefined {
		return this.#protocolConfiguration;
	}

	/**
	 * Start the subprocess and begin reading.
	 */
	async connect(): Promise<void> {
		if (this.#connected) return;

		const env = {
			...Bun.env,
			...this.config.env,
		};
		const cwd = this.config.cwd ?? getProjectDir();
		const spawnCommand = await resolveStdioSpawnCommand(this.config, {
			cwd,
			env,
			platform: process.platform,
			hostHasInheritableConsole: hostHasInheritableConsole(),
		});

		// Platform-derived session and console-window handling come from
		// `resolveStdioSpawnCommand`: Linux/other POSIX detach into their own
		// session to escape terminal job-control signals (SIGTSTP, SIGTTIN);
		// macOS stays attached so TCC can prompt for Apple Events automation;
		// Windows stays attached, and only hides the child when the host has no
		// console to share. See `StdioSpawnCommand`.
		// Keep this on Bun's argv-first overload. The eval JS kernel path that
		// triggers macOS Apple Events TCC prompts uses the same shape; the
		// one-object `{ cmd }` overload timed out before prompting for `mcpbridge`
		// even with `detached: false` (#5085).
		this.#process = Bun.spawn(spawnCommand.cmd, {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: spawnCommand.windowsHide,
			detached: spawnCommand.detached,
			windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
		});
		this.#detached = spawnCommand.detached;

		this.#connected = true;

		// Start reading stdout
		this.#readLoop = this.#startReadLoop();

		// Log stderr for debugging
		this.#startStderrLoop();
	}

	async #startReadLoop(): Promise<void> {
		if (!this.#process?.stdout) return;
		try {
			for await (const line of readJsonl(this.#process.stdout)) {
				if (!this.#connected) break;
				try {
					this.#handleMessage(line as JsonRpcMessage);
				} catch {
					// Skip malformed lines
				}
			}
		} catch (error) {
			if (this.#connected) {
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			this.#handleClose();
		}
	}

	async #startStderrLoop(): Promise<void> {
		if (!this.#process?.stderr) return;

		const reader = this.#process.stderr.getReader();
		const decoder = new TextDecoder();

		try {
			while (this.#connected) {
				const { done, value } = await reader.read();
				if (done) break;
				// Log stderr but don't treat as error - servers use it for logging
				const text = decoder.decode(value, { stream: true });
				if (text.trim()) {
					// Could expose via onStderr callback if needed
					// For now, silent - MCP spec says clients MAY capture/ignore
				}
			}
		} catch {
			// Ignore stderr read errors
		} finally {
			reader.releaseLock();
		}
	}

	#handleMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#handleMessage(m);
			return;
		}
		// Initialization-based revisions permit server-to-client requests. The
		// modern protocol represents interaction through request results instead,
		// so answering a server-originated request would itself violate the wire
		// protocol. An unconfigured transport remains legacy-compatible for
		// callers that construct StdioTransport directly.
		if ("method" in message && "id" in message && message.id != null) {
			const request = message as JsonRpcRequest;
			if (this.#protocolConfiguration?.era === "modern") {
				const error = new Error(`MCP protocol violation: modern server sent client request "${request.method}"`);
				try {
					this.onError?.(error);
				} catch {
					// A diagnostic callback must not break the stdout read loop.
				}
				return;
			}
			void this.#handleServerRequest(request);
			return;
		}

		// Responses complete ordinary requests or gracefully close listeners.
		if ("id" in message && message.id != null) {
			const response = message as JsonRpcResponse;
			const listener = this.#listeners.get(response.id);
			if (listener) {
				this.#handleListenerResponse(listener, response);
				return;
			}
			const pending = this.#pendingRequests.get(response.id);
			if (pending) {
				this.#pendingRequests.delete(response.id);
				if (response.error) {
					pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		// Subscription notifications are demultiplexed by their listen request ID.
		if ("method" in message) {
			const notification = message as { method: string; params?: unknown };
			if (notification.method === MCPNotificationMethods.CANCELLED) {
				const requestId =
					typeof notification.params === "object" &&
					notification.params !== null &&
					!Array.isArray(notification.params)
						? (notification.params as Record<string, unknown>).requestId
						: undefined;
				const listener =
					typeof requestId === "string" || typeof requestId === "number"
						? this.#listeners.get(requestId)
						: undefined;
				if (listener) {
					this.#settleListenerSuccess(listener);
					return;
				}
				return;
			}

			const subscriptionId = getMCPNotificationSubscriptionId(notification.params);
			if (subscriptionId !== undefined) {
				const listener = this.#listeners.get(subscriptionId);
				if (listener) this.#handleListenerNotification(listener, notification.method, notification.params);
				return;
			}
			if (notification.method === MCPNotificationMethods.SUBSCRIPTIONS_ACKNOWLEDGED) {
				this.onError?.(
					new MCPSubscriptionProtocolError(
						"subscriptions/listen acknowledgment omitted io.modelcontextprotocol/subscriptionId",
					),
				);
				return;
			}
			this.onNotification?.(notification.method, notification.params);
		}
	}

	#cleanupListener(listener: MCPStdioListenerState): void {
		this.#listeners.delete(listener.handle.requestId);
		if (listener.signal && listener.onAbort) {
			listener.signal.removeEventListener("abort", listener.onAbort);
		}
	}

	async #sendListenerCancellation(listener: MCPStdioListenerState): Promise<void> {
		if (listener.cancellationSent || !listener.requestSent) return;
		if (!this.#connected || this.#process?.stdin !== listener.stdin) return;
		listener.cancellationSent = true;
		const notification = {
			jsonrpc: "2.0" as const,
			method: MCPNotificationMethods.CANCELLED,
			params: { requestId: listener.handle.requestId },
		};
		try {
			await listener.stdin.write(`${JSON.stringify(notification)}\n`);
			await listener.stdin.flush();
		} catch {
			// Advisory cancellation must not replace local listener failure.
		}
	}

	#settleListenerFailure(listener: MCPStdioListenerState, error: unknown): void {
		if (listener.settled) return;
		listener.settled = true;
		if ((listener.acknowledged || listener.requestSent) && !listener.cancellationSent) {
			listener.cancelled = true;
			void this.#sendListenerCancellation(listener);
		}
		this.#cleanupListener(listener);
		const failure = error instanceof Error ? error : new Error(String(error));
		if (!listener.acknowledged) listener.acknowledgment.reject(failure);
		listener.completion.reject(failure);
		try {
			this.onError?.(failure);
		} catch {
			// Diagnostic callbacks do not own the transport read loop.
		}
	}

	#settleListenerSuccess(listener: MCPStdioListenerState): void {
		if (listener.settled) return;
		listener.settled = true;
		this.#cleanupListener(listener);
		if (!listener.acknowledged) {
			listener.acknowledgment.reject(
				new MCPSubscriptionProtocolError(
					`subscriptions/listen ${listener.handle.requestId} ended before acknowledgment`,
				),
			);
		}
		listener.completion.resolve();
	}

	#handleListenerResponse(listener: MCPStdioListenerState, response: JsonRpcResponse): void {
		try {
			if (response.error) {
				throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
			}
			if (!listener.acknowledged) {
				throw new MCPSubscriptionProtocolError(
					`subscriptions/listen ${listener.handle.requestId} closed before acknowledgment`,
				);
			}
			const result = response.result;
			if (typeof result !== "object" || result === null || Array.isArray(result)) {
				throw new MCPSubscriptionProtocolError("Invalid subscriptions/listen closure result");
			}
			const closure = result as Record<string, unknown>;
			const metadata =
				typeof closure._meta === "object" && closure._meta !== null && !Array.isArray(closure._meta)
					? (closure._meta as Record<string, unknown>)
					: undefined;
			if (
				closure.resultType !== "complete" ||
				metadata?.["io.modelcontextprotocol/subscriptionId"] !== listener.handle.requestId
			) {
				throw new MCPSubscriptionProtocolError("Invalid subscriptions/listen graceful closure");
			}
			this.#settleListenerSuccess(listener);
		} catch (error) {
			this.#settleListenerFailure(listener, error);
		}
	}

	#handleListenerNotification(listener: MCPStdioListenerState, method: string, params: unknown): void {
		try {
			if (!listener.acknowledged) {
				if (method !== MCPNotificationMethods.SUBSCRIPTIONS_ACKNOWLEDGED) {
					throw new MCPSubscriptionProtocolError(
						`subscriptions/listen ${listener.handle.requestId} received ${method} before acknowledgment`,
					);
				}
				const accepted = validateMCPSubscriptionAcknowledgement(listener.requestedNotifications, params);
				listener.acknowledged = true;
				listener.handle.acknowledgedNotifications = accepted;
				listener.acknowledgment.resolve(accepted);
				return;
			}
			if (method === MCPNotificationMethods.SUBSCRIPTIONS_ACKNOWLEDGED) {
				throw new MCPSubscriptionProtocolError(
					`subscriptions/listen ${listener.handle.requestId} was acknowledged more than once`,
				);
			}
			if (
				!isMCPSubscriptionNotificationAcknowledged(listener.handle.acknowledgedNotifications ?? {}, method, params)
			) {
				throw new MCPSubscriptionProtocolError(
					`subscriptions/listen ${listener.handle.requestId} received unacknowledged notification ${method}`,
				);
			}
			try {
				listener.onNotification?.(method, params);
			} catch (error) {
				// Delivery has failed after the server accepted this listener, so
				// tell it to release only this request-scoped subscription. Mark
				// cancellation requested before settling: the server can respond
				// between stdin.write() and stdin.flush(), before requestSent is
				// recorded, and the write continuation will send it once framed.
				listener.cancelled = true;
				void this.#sendListenerCancellation(listener);
				this.#settleListenerFailure(listener, error);
			}
		} catch (error) {
			this.#settleListenerFailure(listener, error);
		}
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		try {
			if (!this.onRequest) {
				this.#sendResponse(request.id, undefined, { code: -32601, message: "Method not found" });
				return;
			}
			const result = await this.onRequest(request.method, request.params);
			this.#sendResponse(request.id, result);
		} catch (error) {
			this.#sendResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	#sendResponse(id: string | number, result?: unknown, error?: JsonRpcError): void {
		if (this.#protocolConfiguration?.era === "modern") return;
		if (!this.#connected || !this.#process?.stdin) return;
		const response = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		// Silent on failure — a dead subprocess has no use for the response,
		// and the read loop will close the transport on EOF.
		writeFrame(this.#process.stdin, `${JSON.stringify(response)}\n`);
	}

	#handleClose(): void {
		if (!this.#connected) return;
		this.#connected = false;

		// Reject all pending requests
		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error("Transport closed"));
		}
		this.#pendingRequests.clear();
		for (const listener of this.#listeners.values()) {
			this.#settleListenerFailure(listener, new Error("Transport closed"));
		}
		this.#listeners.clear();

		this.onClose?.();
	}

	async listen(
		params: { notifications: MCPSubscriptionNotificationFilter },
		options?: MCPListenOptions,
	): Promise<MCPListenHandle> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}
		const protocol = this.#protocolConfiguration;
		if (protocol?.era !== "modern" || protocol.phase !== "connected") {
			throw new Error("subscriptions/listen requires a connected modern MCP transport");
		}
		if (!hasMCPSubscriptionNotifications(params.notifications)) {
			throw new Error("subscriptions/listen requires at least one notification filter");
		}
		if (params.notifications.resourceSubscriptions?.some(uri => typeof uri !== "string" || uri.length === 0)) {
			throw new Error("subscriptions/listen resourceSubscriptions must contain non-empty strings");
		}
		if (options?.signal?.aborted) {
			throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
		}

		const requestedNotifications: MCPSubscriptionNotificationFilter = {
			...(params.notifications.toolsListChanged === true ? { toolsListChanged: true } : {}),
			...(params.notifications.promptsListChanged === true ? { promptsListChanged: true } : {}),
			...(params.notifications.resourcesListChanged === true ? { resourcesListChanged: true } : {}),
			...(params.notifications.resourceSubscriptions
				? { resourceSubscriptions: [...new Set(params.notifications.resourceSubscriptions)] }
				: {}),
		};
		const requestId = Snowflake.next();
		const acknowledgment = Promise.withResolvers<MCPSubscriptionNotificationFilter>();
		const completion = Promise.withResolvers<void>();
		// A subprocess can answer during the same turn as the request write.
		// Mark lifecycle promises handled until the returned handle can be observed.
		void acknowledgment.promise.catch(() => {});
		void completion.promise.catch(() => {});
		const stdin = this.#process.stdin;
		let listener!: MCPStdioListenerState;

		const sendCancellation = (): Promise<void> => this.#sendListenerCancellation(listener);
		const cancel = async (): Promise<void> => {
			if (listener.settled) return;
			listener.cancelled = true;
			await listener.writePromise.catch(() => {});
			await sendCancellation();
			this.#settleListenerSuccess(listener);
		};
		const handle: MCPListenHandle = {
			requestId,
			requestedNotifications,
			acknowledged: acknowledgment.promise,
			completion: completion.promise,
			cancel,
		};
		listener = {
			handle,
			requestedNotifications,
			acknowledgment,
			completion,
			stdin,
			onNotification: options?.onNotification,
			signal: options?.signal,
			requestSent: false,
			cancellationSent: false,
			cancelled: false,
			acknowledged: false,
			settled: false,
			writePromise: Promise.resolve(),
		};
		if (options?.signal) {
			listener.onAbort = () => {
				void cancel();
			};
			options.signal.addEventListener("abort", listener.onAbort, { once: true });
			if (options.signal.aborted) {
				listener.onAbort();
			}
		}
		this.#listeners.set(requestId, listener);

		const request = {
			jsonrpc: "2.0" as const,
			id: requestId,
			method: "subscriptions/listen",
			params: buildModernRequestParams(
				{ notifications: requestedNotifications },
				{ version: protocol.version, clientCapabilities: protocol.clientCapabilities },
				options?.metadata,
				protocol.clientInfo,
			),
		};
		listener.writePromise = (async () => {
			try {
				await stdin.write(`${JSON.stringify(request)}\n`);
				await stdin.flush();
				listener.requestSent = true;
				if (listener.cancelled) await sendCancellation();
			} catch (error) {
				this.#settleListenerFailure(listener, error);
			}
		})();
		return handle;
	}
	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const id = this.#requestIds.next(this.config.requestIdFormat);
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};
		const stdin = this.#process.stdin;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		let requestSent = false;
		let cancellationRequested = false;
		let cancellationSent = false;

		const sendCancellationIfNeeded = () => {
			if (!cancellationRequested || cancellationSent || !requestSent) return;
			if (!this.#connected || this.#process?.stdin !== stdin) return;

			cancellationSent = true;
			const notification = {
				jsonrpc: "2.0" as const,
				method: "notifications/cancelled",
				params: { requestId: id },
			};
			// Cancellation is advisory and best-effort. A pipe that closes between
			// the liveness check and this write must not replace the local abort or
			// timeout result, nor may an asynchronous EPIPE escape unhandled.
			writeFrame(stdin, `${JSON.stringify(notification)}\n`);
		};

		const settle = (complete: () => void): boolean => {
			if (settled) return false;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			this.#pendingRequests.delete(id);
			complete();
			return true;
		};

		const onAbort = () => {
			if (settled) return;
			cancellationRequested = true;
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
			settle(() => reject(reason));
			sendCancellationIfNeeded();
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
			}
		}

		this.#pendingRequests.set(id, {
			resolve: (value: unknown) => {
				settle(() => resolve(value as T));
			},
			reject: (error: Error) => {
				settle(() => reject(error));
			},
		});

		if (isMCPTimeoutEnabled(timeout)) {
			timer = setTimeout(() => {
				if (settled) return;
				cancellationRequested = true;
				settle(() => reject(new Error(`Request timeout after ${timeout}ms`)));
				sendCancellationIfNeeded();
			}, timeout);
		}

		const message = `${JSON.stringify(request)}\n`;
		const failFromSend = (error: unknown) => {
			if (settled) return;
			cleanup();
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		try {
			// Never `await` write/flush. Bun's FileSink returns a pending Promise
			// once the OS pipe buffer fills (default ~64 KB on POSIX), and a
			// subprocess that stops draining stdin will park those awaits forever.
			// Awaiting here would keep the async fn stuck above `return promise`,
			// past the timeout timer and the abort handler, orphaning the deferred
			// rejection and hanging the caller (#3945). Route sync throws (Windows
			// EPIPE) and async rejections (POSIX EPIPE on processTicksAndRejections)
			// into `reject()` while leaving the returned promise free to settle
			// from the response, timer, abort signal, or read-loop transport-close.
			const wrote = stdin.write(message);
			if (isThenable(wrote)) wrote.then(undefined, failFromSend);
			const flushed = stdin.flush();
			if (isThenable(flushed)) flushed.then(undefined, failFromSend);
		} catch (error) {
			failFromSend(error);
		}

		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error("Transport not connected");
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		// Bun's FileSink can throw EPIPE synchronously on Windows when the
		// subprocess has exited between the last read-loop tick and this
		// write (e.g. an MCP server that dies after returning `initialize`
		// but before `notifications/initialized` is delivered). Tear the
		// transport down so any wired `onClose` (and reconnect machinery)
		// engages, then surface the failure to the caller so a write that
		// dropped on the floor is never silently treated as delivered —
		// `initializeConnection()` runs before the manager installs its
		// `onClose` handler, so a swallowed failure there would yield a
		// "connected" handle wrapping a dead transport. See #1710.
		if (!writeFrame(this.#process.stdin, `${JSON.stringify(notification)}\n`)) {
			this.#handleClose();
			throw new Error(`Transport closed while sending notification "${method}"`);
		}
	}

	#beginClose(): Subprocess<"pipe", "pipe", "pipe"> | null {
		const listeners = [...this.#listeners.values()];
		for (const listener of listeners) {
			listener.cancelled = true;
			void this.#sendListenerCancellation(listener);
		}
		if (this.#connected) {
			this.#handleClose();
		}

		if (this.#process) {
			// Grab the handle and null the field immediately (before any
			// `await`) so a concurrent/repeat `close()` sees `#process` already
			// cleared and skips straight past this block — no double-signal.
			const proc = this.#process;
			this.#process = null;

			// 1. Cooperative EOF first: a well-behaved server sees stdin close
			// and can exit on its own before any signal is sent. Guarded — the
			// sink can throw if the pipe is already closed/dead (e.g. the child
			// already exited and the read loop got there first).
			try {
				proc.stdin.end();
			} catch {
				// Already closed/dead.
			}

			// 2-3. Group-aware SIGTERM (when this transport actually spawned
			// detached), bounded wait, then escalate to SIGKILL. See
			// `terminateStdioProcess` for the exact signaling/escalation rules.
			await terminateStdioProcess(proc, this.#detached);
		}

		if (this.#readLoop) {
			// Do not block/await the read loop as it can hang indefinitely in some environments
			this.#readLoop.catch(() => {});
			this.#readLoop = null;
		}
		return proc;
	}

	/**
	 * Permanently revoke this transport's subprocess ownership without waiting
	 * through the graceful-close window. The exit promise remains observed so
	 * forced probe retirement cannot leak an unhandled process failure.
	 */
	retire(): void {
		const proc = this.#beginClose();
		if (!proc) return;
		try {
			proc.kill();
		} catch {
			// Ignore kill errors
		}
		void proc.exited.catch(() => {});
	}

	async close(): Promise<void> {
		const proc = this.#beginClose();
		if (!proc) return;

		const exited = proc.exited;
		let timeoutId: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<void>(resolve => {
			timeoutId = setTimeout(resolve, 2000);
		});
		try {
			await Promise.race([exited, timeoutPromise]);
		} catch {
			// Ignore exited rejection
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
		}
		try {
			proc.kill();
		} catch {
			// Ignore kill errors
		}
	}
}

/**
 * Create and connect a stdio transport.
 */
export async function createStdioTransport(config: MCPStdioServerConfig): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	await transport.connect();
	return transport;
}
