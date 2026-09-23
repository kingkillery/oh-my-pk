import { stat } from "node:fs/promises";

export type TerminalLaunchBackend = "managed" | "system";

export interface TerminalLaunchRequest {
	command: string;
	cwd: string;
	title?: string;
	backend: TerminalLaunchBackend;
}

export interface TerminalLaunchResult {
	backend: "pk-herdr" | "psmux" | "system";
	id?: string;
	tabId?: string;
}

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface TerminalLaunchDependencies {
	run?: (args: string[], cwd: string) => Promise<CommandResult>;
	confirmFallback?: (reason: string) => Promise<boolean>;
	signal?: AbortSignal;
	environment?: Record<string, string | undefined>;
	platform?: NodeJS.Platform;
	newId?: () => string;
}

async function runCommand(args: string[], cwd: string): Promise<CommandResult> {
	try {
		const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
		const timeout = setTimeout(() => proc.kill(), 20_000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return { exitCode, stdout, stderr };
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

function createdTab(output: string): { tabId?: string; paneId?: string } {
	try {
		const parsed: unknown = JSON.parse(output);
		if (!parsed || typeof parsed !== "object" || !("result" in parsed)) return {};
		const result = parsed.result;
		if (!result || typeof result !== "object") return {};
		const tab = "tab" in result ? result.tab : undefined;
		const pane = "root_pane" in result ? result.root_pane : undefined;
		return {
			tabId:
				tab && typeof tab === "object" && "tab_id" in tab && typeof tab.tab_id === "string"
					? tab.tab_id
					: undefined,
			paneId:
				pane && typeof pane === "object" && "pane_id" in pane && typeof pane.pane_id === "string"
					? pane.pane_id
					: undefined,
		};
	} catch {
		return {};
	}
}

function powershellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function windowsArgument(value: string): string {
	return `"${value.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`).replace(/(\\+)$/g, (_match, slashes: string) => `${slashes}${slashes}`)}"`;
}

function encodedCommand(cwd: string, command: string): string {
	return Buffer.from(`Set-Location -LiteralPath ${powershellLiteral(cwd)}; ${command}`, "utf16le").toString("base64");
}

async function launchSystem(
	request: TerminalLaunchRequest,
	run: TerminalLaunchDependencies["run"],
	platform: NodeJS.Platform,
	signal?: AbortSignal,
): Promise<TerminalLaunchResult> {
	if (platform !== "win32") throw new Error("System terminal fallback is supported on Windows only.");
	const title = request.title?.trim() || "OMPK terminal";
	const args = [
		"-w",
		"new",
		"nt",
		"-d",
		request.cwd,
		"--title",
		title,
		"powershell.exe",
		"-NoExit",
		"-EncodedCommand",
		encodedCommand(request.cwd, request.command),
	];
	const argumentLine = args.map(windowsArgument).join(" ");
	const script = `Start-Process -FilePath 'wt.exe' -ArgumentList ${powershellLiteral(argumentLine)} -WorkingDirectory ${powershellLiteral(request.cwd)} -ErrorAction Stop`;
	if (signal?.aborted) throw new Error("Terminal launch was cancelled.");
	const result = await (run ?? runCommand)(
		["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
		request.cwd,
	);
	if (result.exitCode !== 0) throw new Error(`Windows Terminal launch failed: ${result.stderr || result.stdout}`);
	return { backend: "system" };
}

/** Launch only through a managed terminal unless the persisted setting or an explicit user decision permits system fallback. */
export async function launchInteractiveTerminal(
	request: TerminalLaunchRequest,
	dependencies: TerminalLaunchDependencies = {},
): Promise<TerminalLaunchResult> {
	const command = request.command.trim();
	if (!command) throw new Error("A terminal command is required.");
	if (dependencies.signal?.aborted) throw new Error("Terminal launch was cancelled.");
	if (!(await stat(request.cwd)).isDirectory()) throw new Error(`Terminal cwd is not a directory: ${request.cwd}`);
	const run = dependencies.run ?? runCommand;
	const platform = dependencies.platform ?? process.platform;
	if (request.backend === "system") return launchSystem(request, dependencies.run, platform, dependencies.signal);

	const failures: string[] = [];
	const environment = dependencies.environment ?? process.env;
	if (environment.HERDR_ENV === "1" && environment.HERDR_PANE_ID && environment.HERDR_WORKSPACE_ID) {
		const created = await run(
			[
				"pk-herdr",
				"tab",
				"create",
				"--workspace",
				environment.HERDR_WORKSPACE_ID,
				"--cwd",
				request.cwd,
				"--label",
				request.title?.trim() || "OMPK terminal",
				"--no-focus",
			],
			request.cwd,
		);
		if (created.exitCode !== 0) {
			failures.push(`PK-Herdr tab creation failed: ${created.stderr || created.stdout}`);
		} else {
			const { tabId, paneId } = createdTab(created.stdout);
			if (!tabId) {
				if (paneId) {
					const closed = await run(["pk-herdr", "pane", "close", paneId], request.cwd);
					if (closed.exitCode !== 0)
						throw new Error(
							`PK-Herdr tab ID missing; unable to close pane ${paneId}: ${closed.stderr || closed.stdout}`,
						);
				}
				throw new Error("PK-Herdr created a tab without a usable tab ID; refusing another launch.");
			}
			if (!paneId || dependencies.signal?.aborted) {
				const closed = await run(["pk-herdr", "tab", "close", tabId], request.cwd);
				if (closed.exitCode !== 0)
					throw new Error(`Unable to close PK-Herdr tab ${tabId}: ${closed.stderr || closed.stdout}`);
				if (dependencies.signal?.aborted) throw new Error("Terminal launch was cancelled.");
				failures.push("PK-Herdr tab creation returned no root pane ID");
			} else {
				const started = await run(["pk-herdr", "pane", "run", paneId, command], request.cwd);
				if (started.exitCode === 0) return { backend: "pk-herdr", id: paneId, tabId };
				const closed = await run(["pk-herdr", "tab", "close", tabId], request.cwd);
				if (closed.exitCode !== 0)
					throw new Error(
						`PK-Herdr tab ${tabId} failed to launch and could not be closed: ${closed.stderr || closed.stdout}`,
					);
				failures.push(`PK-Herdr tab launch failed: ${started.stderr || started.stdout}`);
			}
		}
	} else {
		failures.push("PK-Herdr caller context is unavailable");
	}

	if (platform === "win32") {
		if (dependencies.signal?.aborted) throw new Error("Terminal launch was cancelled.");
		const name = `ompk-${(request.title || "terminal")
			.toLowerCase()
			.replace(/[^a-z0-9_-]/g, "-")
			.slice(0, 15)}-${(dependencies.newId ?? (() => crypto.randomUUID()))().slice(0, 8)}`;
		const started = await run(
			[
				"psmux",
				"new-session",
				"-d",
				"-s",
				name,
				"--",
				"powershell.exe",
				"-NoLogo",
				"-NoExit",
				"-EncodedCommand",
				encodedCommand(request.cwd, command),
			],
			request.cwd,
		);
		if (started.exitCode === 0) {
			if (dependencies.signal?.aborted) {
				await run(["psmux", "kill-session", "-t", name], request.cwd);
				throw new Error("Terminal launch was cancelled.");
			}
			let verified = await run(["psmux", "has-session", "-t", name], request.cwd);
			if (verified.exitCode !== 0) {
				await Bun.sleep(100);
				verified = await run(["psmux", "has-session", "-t", name], request.cwd);
			}
			if (dependencies.signal?.aborted) {
				await run(["psmux", "kill-session", "-t", name], request.cwd);
				throw new Error("Terminal launch was cancelled.");
			}
			if (verified.exitCode === 0) return { backend: "psmux", id: name };
			await run(["psmux", "kill-session", "-t", name], request.cwd);
			failures.push(`psmux session was not available after launch: ${verified.stderr || verified.stdout}`);
		} else {
			failures.push(`psmux launch failed: ${started.stderr || started.stdout}`);
		}
	}

	const reason = `No managed terminal could launch the command (${failures.join("; ")}). Launch in Windows Terminal instead?`;
	if (platform !== "win32" || !dependencies.confirmFallback || !(await dependencies.confirmFallback(reason))) {
		throw new Error(`Terminal launch stopped without an approved fallback: ${failures.join("; ")}`);
	}
	if (dependencies.signal?.aborted) throw new Error("Terminal launch was cancelled.");
	return launchSystem(request, dependencies.run, platform, dependencies.signal);
}
