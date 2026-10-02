import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Legacy API values are normalized to PK-Herdr; they never select another backend. */
export type TerminalLaunchBackend = "pk-herdr" | "managed" | "system";
export interface TerminalLaunchRequest {
	command: string;
	cwd: string;
	title?: string;
	backend: TerminalLaunchBackend;
}
export interface TerminalLaunchResult {
	backend: "pk-herdr";
	id: string;
	paneId: string;
	tabId: string;
	workspaceId: string;
	sessionName?: string;
}
export interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}
export interface OwnedTerminalServer {
	/** Retained direct process handle, not a PID lookup or a command timeout. */
	kill(): void;
	release(): void;
	exited: Promise<number>;
}
export interface TerminalLaunchSkill {
	name: "pk-herdr";
	filePath: string;
	/** Exact installed instructions exposed to the caller before launch. */
	content: string;
}
export interface TerminalLaunchDependencies {
	/** Session-scoped canonical skill; missing, unreadable, or changed instructions fail closed. */
	skill: TerminalLaunchSkill;
	run?: (args: string[], cwd: string, options?: { timeoutMs: number }) => Promise<CommandResult>;
	startServer?: (args: string[], cwd: string) => Promise<OwnedTerminalServer>;
	waitForReady?: (
		sessionName: string,
		cwd: string,
		run: NonNullable<TerminalLaunchDependencies["run"]>,
		signal?: AbortSignal,
	) => Promise<void>;
	signal?: AbortSignal;
	environment?: Record<string, string | undefined>;
	newId?: () => string;
}

// Node's windowsHide uses CREATE_NO_WINDOW, as in gopk-clips/ensure-daemon.ts.
// Unlike a shell/terminal launch, this executes the headless native server directly.
async function startServer(args: string[], cwd: string): Promise<OwnedTerminalServer> {
	const child = spawn(args[0]!, args.slice(1), { cwd, windowsHide: true, stdio: "ignore" });
	const started = Promise.withResolvers<void>();
	const exited = Promise.withResolvers<number>();
	child.once("spawn", () => started.resolve());
	child.once("error", error => {
		started.reject(error);
		exited.resolve(127);
	});
	child.once("exit", code => exited.resolve(code ?? 1));
	await started.promise;
	return {
		kill: () => {
			child.kill();
		},
		release: () => child.unref(),
		exited: exited.promise,
	};
}

async function runCommand(args: string[], cwd: string, options = { timeoutMs: 20_000 }): Promise<CommandResult> {
	const result = Promise.withResolvers<CommandResult>();
	const child = spawn(args[0]!, args.slice(1), { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", chunk => {
		stdout += chunk;
	});
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const timeout = setTimeout(() => child.kill(), options.timeoutMs);
	child.once("error", error => {
		clearTimeout(timeout);
		result.resolve({ exitCode: 127, stdout, stderr: error.message });
	});
	child.once("close", code => {
		clearTimeout(timeout);
		result.resolve({ exitCode: code ?? 1, stdout, stderr });
	});
	return result.promise;
}

function cancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Terminal launch was cancelled.");
}

async function waitForReady(
	sessionName: string,
	cwd: string,
	run: NonNullable<TerminalLaunchDependencies["run"]>,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + 10_000;
	do {
		cancelled(signal);
		const status = await run(["pk-herdr", "--session", sessionName, "status", "server", "--json"], cwd, {
			timeoutMs: 2_000,
		});
		cancelled(signal);
		try {
			const parsed = JSON.parse(status.stdout);
			if (status.exitCode === 0 && parsed.running === true && parsed.session === sessionName) return;
		} catch {
			/* A server still starting may not return JSON yet. */
		}
		await Bun.sleep(50);
	} while (Date.now() < deadline);
	throw new Error(`PK-Herdr session ${sessionName} did not become ready within 10 seconds.`);
}

function createdIds(output: string): { workspaceId?: string; tabId?: string; paneId?: string } {
	try {
		const result = JSON.parse(output).result;
		const workspaceId = result.workspace?.workspace_id ?? result.tab?.workspace_id;
		const tabId = result.tab?.tab_id;
		const paneId = result.root_pane?.pane_id;
		return {
			workspaceId: typeof workspaceId === "string" && /^w[0-9a-z]+$/i.test(workspaceId) ? workspaceId : undefined,
			tabId: typeof tabId === "string" && /^w[0-9a-z]+:t[0-9a-z]+$/i.test(tabId) ? tabId : undefined,
			paneId: typeof paneId === "string" && /^w[0-9a-z]+:p[0-9a-z]+$/i.test(paneId) ? paneId : undefined,
		};
	} catch {
		return {};
	}
}

/** TabList's result.tabs contains TabInfo { workspace_id, tab_id, label }. */
async function reconcileCallerTab(
	workspaceId: string,
	label: string,
	cwd: string,
	run: NonNullable<TerminalLaunchDependencies["run"]>,
): Promise<string> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const listed = await run(["pk-herdr", "tab", "list", "--workspace", workspaceId], cwd, { timeoutMs: 2_000 });
			const result = JSON.parse(listed.stdout).result;
			if (listed.exitCode === 0 && result.type === "tab_list" && Array.isArray(result.tabs)) {
				const matches = result.tabs.filter(
					(tab: { workspace_id?: string; tab_id?: string; label?: string }) =>
						tab.workspace_id === workspaceId &&
						tab.label === label &&
						typeof tab.tab_id === "string" &&
						new RegExp(`^${workspaceId}:t[0-9a-z]+$`, "i").test(tab.tab_id),
				);
				if (matches.length === 1) return matches[0].tab_id;
				if (matches.length > 1) break; // Ownership is ambiguous; never guess.
			}
		} catch {
			// A lost receipt or request still settling warrants bounded inspection, not another creation.
		}
		if (attempt < 4) await Bun.sleep(250);
	}
	throw new Error(
		`PK-Herdr caller tab cleanup remains unconfirmed in workspace ${workspaceId}; inspect tab list --workspace ${workspaceId} for exact label ${JSON.stringify(label)} and close only its matching tab. Refusing another launch.`,
	);
}

/** Always PK-Herdr, with cleanup limited to resources this invocation owns. */
export async function launchInteractiveTerminal(
	request: TerminalLaunchRequest,
	dependencies: TerminalLaunchDependencies,
): Promise<TerminalLaunchResult> {
	const command = request.command.trim();
	if (!command) throw new Error("A terminal command is required.");
	cancelled(dependencies.signal);
	const cwd = resolve(request.cwd);
	if (!(await stat(cwd)).isDirectory()) throw new Error(`Terminal cwd is not a directory: ${cwd}`);
	cancelled(dependencies.signal);
	const skill = dependencies.skill;
	if (skill?.name !== "pk-herdr" || !skill.filePath || !skill.content.trim()) {
		throw new Error(
			"Interactive terminals require the installed pk-herdr skill; resolve skill://pk-herdr before launching.",
		);
	}
	try {
		if (!(await stat(skill.filePath)).isFile()) throw new Error("The skill path is not a regular file.");
		if ((await Bun.file(skill.filePath).text()) !== skill.content) {
			throw new Error("The installed instructions changed; reload the terminal tool before launching.");
		}
	} catch (error) {
		throw new Error(`PK-Herdr skill unavailable or changed at ${skill.filePath}: ${String(error)}`);
	}
	cancelled(dependencies.signal);
	const execute = dependencies.run ?? runCommand;
	const run: NonNullable<TerminalLaunchDependencies["run"]> = (args, directory, options) =>
		execute(args, directory, options ?? { timeoutMs: 20_000 });
	const env = dependencies.environment ?? process.env;
	const caller =
		env.HERDR_ENV === "1" &&
		/^w[0-9a-z]+$/i.test(env.HERDR_WORKSPACE_ID ?? "") &&
		new RegExp(`^${env.HERDR_WORKSPACE_ID}:p[0-9a-z]+$`, "i").test(env.HERDR_PANE_ID ?? "");
	const sessionName = caller
		? undefined
		: `ompk-terminal-${(dependencies.newId ?? (() => crypto.randomUUID()))()
				.replace(/[^a-z0-9-]/gi, "")
				.toLowerCase()}`;
	const prefix = sessionName ? ["pk-herdr", "--session", sessionName] : ["pk-herdr"];
	// Retain the readable title plus a per-launch token until receipt ownership is certain.
	const title = request.title?.trim() || "OMPK terminal";
	const callerLabel = `${title} [ompk-owned:${(dependencies.newId ?? (() => crypto.randomUUID()))()}]`;
	let server: OwnedTerminalServer | undefined;
	let ready = false;
	let tabId: string | undefined;
	let creationAttempted = false;
	try {
		if (sessionName) {
			server = await (dependencies.startServer ?? startServer)(
				[...prefix, "--session-auto-close-after", "4h", "server"],
				cwd,
			);
			cancelled(dependencies.signal);
			const readiness = new AbortController();
			const signal = dependencies.signal
				? AbortSignal.any([dependencies.signal, readiness.signal])
				: readiness.signal;
			try {
				await Promise.race([
					(dependencies.waitForReady ?? waitForReady)(sessionName, cwd, run, signal),
					server.exited.then(code => {
						throw new Error(`PK-Herdr owned server exited during startup (${code}).`);
					}),
				]);
			} finally {
				readiness.abort();
			}
			ready = true;
		}
		cancelled(dependencies.signal);
		creationAttempted = true;
		const created = await run(
			[
				...prefix,
				...(caller
					? ["tab", "create", "--workspace", env.HERDR_WORKSPACE_ID!]
					: ["workspace", "create", "--origin", "tool"]),
				"--cwd",
				cwd,
				"--label",
				caller ? callerLabel : title,
				"--no-focus",
			],
			cwd,
		);
		const ids = createdIds(created.stdout);
		const workspaceId = caller ? env.HERDR_WORKSPACE_ID! : ids.workspaceId;
		// Close only a tab proven to belong to the caller workspace.
		tabId = ids.tabId && (!caller || ids.tabId.startsWith(`${workspaceId}:`)) ? ids.tabId : undefined;
		if (created.exitCode !== 0) throw new Error(`PK-Herdr creation failed: ${created.stderr || created.stdout}`);
		if (
			!workspaceId ||
			!tabId ||
			!ids.paneId ||
			!tabId.startsWith(`${workspaceId}:`) ||
			!ids.paneId.startsWith(`${workspaceId}:`)
		)
			throw new Error("PK-Herdr creation returned malformed resource IDs; refusing another launch.");
		cancelled(dependencies.signal);
		const started = await run([...prefix, "pane", "run", ids.paneId, command], cwd);
		cancelled(dependencies.signal);
		if (started.exitCode !== 0) throw new Error(`PK-Herdr pane launch failed: ${started.stderr || started.stdout}`);
		server?.release(); // Keep the direct handle in event closures; do not prevent ordinary app shutdown.
		return {
			backend: "pk-herdr",
			id: ids.paneId,
			paneId: ids.paneId,
			tabId,
			workspaceId,
			...(sessionName ? { sessionName } : {}),
		};
	} catch (error) {
		let cleanup: CommandResult | undefined;
		try {
			if (caller && creationAttempted && !tabId)
				tabId = await reconcileCallerTab(env.HERDR_WORKSPACE_ID!, callerLabel, cwd, run);
			if (sessionName && server)
				cleanup = await run(["pk-herdr", "session", "stop", sessionName, "--json"], cwd, { timeoutMs: 20_000 });
			else if (tabId) cleanup = await run([...prefix, "tab", "close", tabId], cwd);
		} catch (cleanupError) {
			if (!ready) server?.kill();
			server?.release();
			throw new Error(
				`PK-Herdr cleanup failed; refusing another launch: ${String(cleanupError)}; original failure: ${String(error)}`,
			);
		}
		if (!ready) server?.kill();
		server?.release();
		if (cleanup && cleanup.exitCode !== 0)
			throw new Error(
				`PK-Herdr cleanup failed; refusing another launch: ${cleanup.stderr || cleanup.stdout}; original failure: ${String(error)}`,
			);
		throw error;
	}
}
