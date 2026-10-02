import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, logger } from "@pk-nerdsaver-ai/pi-utils";
import {
	clearDecisionEndpointCache,
	type DecisionEndpoint,
	discoverDecisionEndpoint,
} from "../../lib/decision-endpoint-discovery";
import type { SlashCommandRuntime } from "../types";
import clefServerSource from "./clef-server.py" with { type: "text" };

const DEFAULT_SESSION = "ompk-clef-decision";
const DEFAULT_HOSTNAME = "clef-inference";
const DEFAULT_MODEL = "clef-flash";
const DEFAULT_ACCELERATOR = "T4";
const DEFAULT_TTL_MINUTES = 60;
const MIN_TTL_MINUTES = 10;
const MAX_TTL_MINUTES = 240;
const REMOTE_PORT = 8000;
const STARTUP_TIMEOUT_MS = 45 * 60_000;
const DISCOVERY_TIMEOUT_MS = 5 * 60_000;

export type ClefAccelerator = "T4" | "L4" | "A100" | "H100" | "G4";

export interface DecisionModelLaunchRequest {
	action: "launch";
	accelerator: ClefAccelerator;
	hostname: string;
	model: "clef" | "clef-flash";
	sessionName: string;
	ttlMinutes: number;
}

export interface DecisionModelStatusRequest {
	action: "status";
	sessionName: string;
}

export interface DecisionModelStopRequest {
	action: "stop";
	sessionName: string;
}

export type DecisionModelRequest = DecisionModelLaunchRequest | DecisionModelStatusRequest | DecisionModelStopRequest;

interface CommandResult {
	exitCode: number;
	stderr: string;
	stdout: string;
}

interface CutoffReceipt {
	cutoffAt: string;
	scriptPath: string;
	taskName: string;
}

interface DecisionModelState {
	accelerator: ClefAccelerator;
	cutoffAt: string;
	hostname: string;
	model: "clef" | "clef-flash";
	sessionName: string;
	startedAt: string;
	taskName: string;
	endpoint?: string;
}
export interface DecisionModelLifecycleDeps {
	armCutoff?: (sessionName: string, ttlMinutes: number) => Promise<CutoffReceipt>;
	discover?: () => Promise<DecisionEndpoint | undefined>;
	runColab?: (args: readonly string[], options?: { input?: string; timeoutMs?: number }) => Promise<CommandResult>;
	cancelCutoff?: (taskName: string) => Promise<void>;
	readState?: (sessionName: string) => Promise<DecisionModelState | undefined>;
	writeState?: (state: DecisionModelState) => Promise<void>;
	removeState?: (sessionName: string) => Promise<void>;
	now?: () => number;
}

function parseTtlMinutes(raw: string): number {
	const value = raw.trim().toLowerCase();
	const match = /^(\d+)(m|h)?$/.exec(value);
	if (!match) throw new Error(`Invalid TTL "${raw}". Use minutes (60 or 60m) or hours (1h).`);
	const amount = Number(match[1]);
	const minutes = match[2] === "h" ? amount * 60 : amount;
	if (!Number.isInteger(minutes) || minutes < MIN_TTL_MINUTES || minutes > MAX_TTL_MINUTES) {
		throw new Error(`TTL must be ${MIN_TTL_MINUTES}-${MAX_TTL_MINUTES} minutes.`);
	}
	return minutes;
}

function parseAccelerator(raw: string): ClefAccelerator {
	const value = raw.toUpperCase();
	if (value === "T4" || value === "L4" || value === "A100" || value === "H100" || value === "G4") return value;
	throw new Error(`Unsupported Clef accelerator "${raw}". Choose T4, L4, A100, H100, or G4.`);
}

function parseModel(raw: string): "clef" | "clef-flash" {
	const value = raw.toLowerCase();
	if (value === "clef" || value === "clef-flash") return value;
	throw new Error(`Unsupported decision model "${raw}". Choose clef or clef-flash.`);
}

export function parseDecisionModelArgs(args: string): DecisionModelRequest {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const action = (tokens.shift() ?? "status").toLowerCase();
	if (action !== "launch" && action !== "status" && action !== "stop") {
		throw new Error("Usage: /decision-model [launch|status|stop] [--ttl 60m] [--gpu T4] [--model clef-flash]");
	}
	let sessionName = DEFAULT_SESSION;
	if (action !== "launch") {
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (token === "--session") sessionName = tokens[++i] ?? "";
			else if (token.startsWith("--session=")) sessionName = token.slice("--session=".length);
			else throw new Error(`Unknown /decision-model ${action} option "${token}".`);
		}
		if (!sessionName) throw new Error("--session requires a name.");
		return { action, sessionName };
	}
	let accelerator: ClefAccelerator = DEFAULT_ACCELERATOR;
	let hostname = DEFAULT_HOSTNAME;
	let model: "clef" | "clef-flash" = DEFAULT_MODEL;
	let ttlMinutes = DEFAULT_TTL_MINUTES;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--ttl") ttlMinutes = parseTtlMinutes(tokens[++i] ?? "");
		else if (token.startsWith("--ttl=")) ttlMinutes = parseTtlMinutes(token.slice("--ttl=".length));
		else if (token === "--gpu" || token === "--accelerator") accelerator = parseAccelerator(tokens[++i] ?? "");
		else if (token.startsWith("--gpu=")) accelerator = parseAccelerator(token.slice("--gpu=".length));
		else if (token.startsWith("--accelerator=")) accelerator = parseAccelerator(token.slice("--accelerator=".length));
		else if (token === "--model") model = parseModel(tokens[++i] ?? "");
		else if (token.startsWith("--model=")) model = parseModel(token.slice("--model=".length));
		else if (token === "--session") sessionName = tokens[++i] ?? "";
		else if (token.startsWith("--session=")) sessionName = token.slice("--session=".length);
		else if (token === "--hostname") hostname = tokens[++i] ?? "";
		else if (token.startsWith("--hostname=")) hostname = token.slice("--hostname=".length);
		else if (token === "--no-ttl" || token === "--ttl=off") {
			throw new Error("Clef launches always require a natural shutoff timer; disabling the TTL is not supported.");
		} else throw new Error(`Unknown /decision-model launch option "${token}".`);
	}
	if (!sessionName || !hostname) throw new Error("Session and hostname must be non-empty.");
	return { action: "launch", accelerator, hostname, model, sessionName, ttlMinutes };
}

function safeSessionName(sessionName: string): string {
	return sessionName.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "clef";
}

function configRoot(): string {
	const configured = $env.PI_CONFIG_DIR?.trim();
	if (!configured) return path.join(os.homedir(), ".ompk");
	return path.isAbsolute(configured) ? configured : path.join(os.homedir(), configured);
}

function stateDirectory(): string {
	return path.join(configRoot(), "decision-model");
}

function stateFile(sessionName: string): string {
	return path.join(stateDirectory(), `${safeSessionName(sessionName)}.json`);
}

async function readState(sessionName: string): Promise<DecisionModelState | undefined> {
	try {
		return JSON.parse(await fs.readFile(stateFile(sessionName), "utf8")) as DecisionModelState;
	} catch {
		return undefined;
	}
}
async function writeState(state: DecisionModelState): Promise<void> {
	await fs.mkdir(stateDirectory(), { recursive: true });
	await fs.writeFile(stateFile(state.sessionName), JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function removeState(sessionName: string): Promise<void> {
	await fs.rm(stateFile(sessionName), { force: true });
}

function windowsExecutable(...segments: string[]): string {
	return path.win32.join($env.WINDIR || "C:\\Windows", ...segments);
}

function colabCommand(args: readonly string[]): string[] {
	const override = $env.OMPK_COLAB_CLI?.trim();
	if (override) return [override, ...args];
	return process.platform === "win32"
		? [windowsExecutable("System32", "wsl.exe"), "colab", ...args]
		: ["colab", ...args];
}

async function runCommand(
	cmd: readonly string[],
	options: { input?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
	const child = Bun.spawn({
		cmd: [...cmd],
		stdin: options.input === undefined ? "ignore" : "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (options.input !== undefined) {
		if (!child.stdin) throw new Error("Command stdin pipe was not created.");
		child.stdin.write(options.input);
		child.stdin.end();
	}
	const timeout = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000);
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { exitCode, stderr, stdout };
	} finally {
		clearTimeout(timeout);
	}
}

async function runColab(
	args: readonly string[],
	options: { input?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
	return runCommand(colabCommand(args), options);
}
function psLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

async function cancelCutoff(taskName: string): Promise<void> {
	if (process.platform !== "win32") return;
	const powershell = windowsExecutable("System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const script = `Unregister-ScheduledTask -TaskName ${psLiteral(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`;
	await runCommand([powershell, "-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 20_000 });
}

async function armWindowsCutoff(sessionName: string, ttlMinutes: number): Promise<CutoffReceipt> {
	if (process.platform !== "win32") {
		throw new Error(
			"Safe Clef launch currently requires the Windows host so OMPK can verify an OS-level scheduled cutoff.",
		);
	}
	await fs.mkdir(stateDirectory(), { recursive: true });
	const safe = safeSessionName(sessionName);
	const taskName = `OMPK-Clef-${safe}`;
	const scriptPath = path.join(stateDirectory(), `stop-${safe}.ps1`);
	const logPath = path.join(stateDirectory(), `stop-${safe}.log`);
	const cutoffAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
	const customCli = $env.OMPK_COLAB_CLI?.trim();
	const stopInvocation = customCli
		? `& ${psLiteral(customCli)} stop --session ${psLiteral(sessionName)} *> ${psLiteral(logPath)}`
		: [
				"$wsl = Join-Path $env:WINDIR 'System32\\wsl.exe'",
				`& $wsl colab stop --session ${psLiteral(sessionName)} *> ${psLiteral(logPath)}`,
			].join("\r\n");
	const stopScript = [
		"$ErrorActionPreference = 'Continue'",
		stopInvocation,
		"$code = $LASTEXITCODE",
		`if ($code -eq 0) { Unregister-ScheduledTask -TaskName ${psLiteral(taskName)} -Confirm:$false -ErrorAction SilentlyContinue }`,
		"exit $code",
	].join("\r\n");
	await fs.writeFile(scriptPath, stopScript + "\r\n", "utf8");
	await cancelCutoff(taskName);
	const powershell = windowsExecutable("System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const registration = [
		"$ErrorActionPreference='Stop'",
		`$action=New-ScheduledTaskAction -Execute ${psLiteral(powershell)} -Argument ${psLiteral(`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`)}`,
		`$trigger=New-ScheduledTaskTrigger -Once -At ([DateTimeOffset]::Parse(${psLiteral(cutoffAt)}).LocalDateTime) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Minutes 30)`,
		"$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)",
		"$principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
		`Register-ScheduledTask -TaskName ${psLiteral(taskName)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
		`$task=Get-ScheduledTask -TaskName ${psLiteral(taskName)} -ErrorAction Stop`,
		`if ($task.TaskName -ne ${psLiteral(taskName)}) { throw 'Cutoff task verification failed.' }`,
	].join(";");
	const result = await runCommand([powershell, "-NoProfile", "-NonInteractive", "-Command", registration], {
		timeoutMs: 30_000,
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`Could not arm Clef cutoff: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`,
		);
	}
	return { cutoffAt, scriptPath, taskName };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function modelId(model: "clef" | "clef-flash"): string {
	return model === "clef" ? "Cloudflare/clef" : "Cloudflare/clef-flash";
}

function resolveTailscaleCredential(): string {
	const value = $env.TS_AUTHKEY?.trim() || $env.TAILSCALE_AUTHKEY?.trim();
	if (!value) {
		throw new Error(
			"Clef launch needs TS_AUTHKEY (or TAILSCALE_AUTHKEY) in OMPK's environment. tskey-auth-* and tskey-api-* are supported.",
		);
	}
	return value;
}
export function buildClefRemoteBootstrap(request: DecisionModelLaunchRequest, credential: string): string {
	const serverSource = Buffer.from(clefServerSource, "utf8").toString("base64");
	const remoteModelId = modelId(request.model);
	return [
		"set -euo pipefail",
		"set +x",
		"export HF_XET_HIGH_PERFORMANCE=1",
		`export TS_AUTHKEY=${shellQuote(credential)}`,
		`export OMPK_CLEF_MODEL_ID=${shellQuote(remoteModelId)}`,
		`export OMPK_CLEF_PORT=${REMOTE_PORT}`,
		"python -m pip install -q -U 'transformers==5.10.2' 'huggingface_hub>=0.36' safetensors accelerate bitsandbytes fastapi 'uvicorn[standard]' requests",
		"python -m pip install -q --force-reinstall --no-cache-dir 'pillow==12.3.0'",
		"python - <<'PY'\nfrom PIL import ImageText, _typing\nassert hasattr(_typing, '_Ink')\nprint('Pillow import verified')\nPY",
		"if ! command -v tailscale >/dev/null 2>&1; then curl -fsSL https://tailscale.com/install.sh | sh; fi",
		"mkdir -p /var/run/tailscale",
		"if ! tailscale status --json >/dev/null 2>&1; then nohup tailscaled --state=mem: --tun=userspace-networking >/tmp/ompk-tailscaled.log 2>&1 & fi",
		"for i in $(seq 1 80); do [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 0.25; done",
		'NODE_AUTH="$TS_AUTHKEY"',
		"if [[ \"$TS_AUTHKEY\" == tskey-api-* ]]; then NODE_AUTH=$(TS_API=\"$TS_AUTHKEY\" python - <<'PY'\nimport os, requests\npayload={'capabilities':{'devices':{'create':{'reusable':False,'ephemeral':True,'preauthorized':True,'tags':[]}}},'expirySeconds':3600,'description':'ompk-clef-ephemeral'}\nr=requests.post('https://api.tailscale.com/api/v2/tailnet/-/keys',auth=(os.environ['TS_API'],''),json=payload,timeout=30)\nr.raise_for_status()\nprint(r.json()['key'])\nPY\n); fi",
		`tailscale up --auth-key="$NODE_AUTH" --hostname=${shellQuote(request.hostname)} --accept-routes=false`,
		"unset TS_AUTHKEY NODE_AUTH",
		'if [ -f /tmp/ompk-clef-server.pid ]; then old=$(cat /tmp/ompk-clef-server.pid); kill "$old" 2>/dev/null || true; fi',
		`printf '%s' ${shellQuote(serverSource)} | base64 -d > /tmp/ompk-clef-server.py`,
		'nohup env HF_XET_HIGH_PERFORMANCE=1 OMPK_CLEF_MODEL_ID="$OMPK_CLEF_MODEL_ID" OMPK_CLEF_PORT="$OMPK_CLEF_PORT" python /tmp/ompk-clef-server.py >/tmp/ompk-clef-server.log 2>&1 & echo $! >/tmp/ompk-clef-server.pid',
		'healthy=0; for i in $(seq 1 1800); do if curl -fsS http://127.0.0.1:$OMPK_CLEF_PORT/healthz >/tmp/ompk-clef-health.json 2>/dev/null; then healthy=1; break; fi; sleep 1; done; [ "$healthy" = 1 ] || { tail -100 /tmp/ompk-clef-server.log >&2; exit 1; }',
		"tailscale serve reset >/dev/null 2>&1 || true",
		'if tailscale serve --bg --yes "$OMPK_CLEF_PORT" >/tmp/ompk-clef-serve.log 2>&1; then SERVE_MODE=https; else tailscale serve --bg --yes --tcp "$OMPK_CLEF_PORT" "$OMPK_CLEF_PORT" >/tmp/ompk-clef-serve.log 2>&1; SERVE_MODE=tcp; fi',
		`echo '__OMPK_CLEF_READY__{"model":"${request.model}","port":${REMOTE_PORT},"serve":"'$SERVE_MODE'"}'`,
	].join("\n");
}

function colabSessionMissing(output: string): boolean {
	return /\bSession '[^']*' not found\b/i.test(output);
}

function parseSessionAccelerator(output: string): string | undefined {
	if (colabSessionMissing(output)) return undefined;
	const match = /\b(?:Hardware|Accelerator):\s*([A-Za-z0-9]+)/i.exec(output);
	return match?.[1]?.toUpperCase();
}

async function sessionIsActive(
	sessionName: string,
	run: NonNullable<DecisionModelLifecycleDeps["runColab"]>,
): Promise<{ active: boolean; accelerator?: string; raw: string }> {
	const result = await run(["status", "--session", sessionName], { timeoutMs: 60_000 });
	const raw = `${result.stdout}\n${result.stderr}`;
	return {
		active: result.exitCode === 0 && !colabSessionMissing(raw),
		accelerator: parseSessionAccelerator(raw),
		raw,
	};
}

async function stopSession(
	sessionName: string,
	run: NonNullable<DecisionModelLifecycleDeps["runColab"]>,
): Promise<boolean> {
	const stopped = await run(["stop", "--session", sessionName], { timeoutMs: 120_000 });
	if (stopped.exitCode === 0) return true;
	return !(await sessionIsActive(sessionName, run)).active;
}
export interface DecisionModelLaunchResult {
	cutoffAt: string;
	endpoint: DecisionEndpoint;
	reusedSession: boolean;
	sessionName: string;
}

async function waitForDecisionEndpoint(
	discover: NonNullable<DecisionModelLifecycleDeps["discover"]>,
	model: "clef" | "clef-flash",
	now: () => number,
): Promise<DecisionEndpoint> {
	const deadline = now() + DISCOVERY_TIMEOUT_MS;
	let last: DecisionEndpoint | undefined;
	while (now() < deadline) {
		clearDecisionEndpointCache();
		last = await discover();
		if (last?.model === model) return last;
		await Bun.sleep(2_000);
	}
	throw new Error(
		last
			? `Decision endpoint was visible as ${last.model}, but ${model} was expected.`
			: "Clef finished bootstrapping but no live tailnet decision endpoint was discovered.",
	);
}

export async function launchClefDecisionModel(
	request: DecisionModelLaunchRequest,
	deps: DecisionModelLifecycleDeps = {},
): Promise<DecisionModelLaunchResult> {
	const run = deps.runColab ?? runColab;
	const arm = deps.armCutoff ?? armWindowsCutoff;
	const discover = deps.discover ?? discoverDecisionEndpoint;
	const loadState = deps.readState ?? readState;
	const saveState = deps.writeState ?? writeState;
	const deleteState = deps.removeState ?? removeState;
	const cancel = deps.cancelCutoff ?? cancelCutoff;
	const now = deps.now ?? Date.now;

	const existingState = await loadState(request.sessionName);
	const liveBefore = await discover().catch(() => undefined);
	if (liveBefore && !existingState) {
		throw new Error(
			`A live decision endpoint already exists at ${liveBefore.baseUrl}, but OMPK does not own its Colab session. Refusing to allocate another runtime.`,
		);
	}
	const before = await sessionIsActive(request.sessionName, run);
	if (before.active && !existingState) {
		throw new Error(
			`${request.sessionName} is already active but has no OMPK decision-model ownership record. Refusing to adopt or stop it.`,
		);
	}
	if (before.active && before.accelerator && before.accelerator !== request.accelerator) {
		throw new Error(
			`${request.sessionName} is already using ${before.accelerator}; stop it before requesting ${request.accelerator}.`,
		);
	}
	const credential = resolveTailscaleCredential();
	const cutoff = await arm(request.sessionName, request.ttlMinutes);
	const state: DecisionModelState = {
		accelerator: request.accelerator,
		cutoffAt: cutoff.cutoffAt,
		hostname: request.hostname,
		model: request.model,
		sessionName: request.sessionName,
		startedAt: new Date(now()).toISOString(),
		taskName: cutoff.taskName,
	};
	await saveState(state);

	let allocated = false;
	try {
		if (!before.active) {
			const created = await run(["new", "--session", request.sessionName, "--gpu", request.accelerator], {
				timeoutMs: 5 * 60_000,
			});
			if (created.exitCode !== 0) {
				throw new Error(`Colab allocation failed: ${(created.stderr || created.stdout).trim()}`);
			}
			allocated = true;
		}
		const bootstrap = await run(["exec", "--session", request.sessionName, "--timeout", "3600"], {
			input: buildClefRemoteBootstrap(request, credential),
			timeoutMs: STARTUP_TIMEOUT_MS,
		});
		if (bootstrap.exitCode !== 0 || !bootstrap.stdout.includes("__OMPK_CLEF_READY__")) {
			throw new Error(
				`Clef bootstrap failed: ${(bootstrap.stderr || bootstrap.stdout).trim().slice(-4000) || `exit ${bootstrap.exitCode}`}`,
			);
		}
		if (request.hostname !== DEFAULT_HOSTNAME) $env.OMP_DECISION_HOSTNAME = request.hostname;
		clearDecisionEndpointCache();
		const endpoint = await waitForDecisionEndpoint(discover, request.model, now);
		state.endpoint = endpoint.baseUrl;
		await saveState(state);
		return {
			cutoffAt: cutoff.cutoffAt,
			endpoint,
			reusedSession: !allocated,
			sessionName: request.sessionName,
		};
	} catch (error) {
		let released = false;
		try {
			released = await stopSession(request.sessionName, run);
		} catch {
			released = false;
		}
		if (released) {
			await cancel(cutoff.taskName);
			await deleteState(request.sessionName);
			clearDecisionEndpointCache();
		} else {
			logger.error(
				"[DecisionModel] launch failed and immediate Colab release was not confirmed; cutoff remains armed",
				{
					cutoffAt: cutoff.cutoffAt,
					sessionName: request.sessionName,
				},
			);
		}
		throw error;
	}
}
export interface DecisionModelStatus {
	active: boolean;
	cutoffAt?: string;
	endpoint?: DecisionEndpoint;
	model?: string;
	sessionName: string;
	state?: DecisionModelState;
}

export async function getDecisionModelStatus(
	sessionName = DEFAULT_SESSION,
	deps: DecisionModelLifecycleDeps = {},
): Promise<DecisionModelStatus> {
	const run = deps.runColab ?? runColab;
	const loadState = deps.readState ?? readState;
	const discover = deps.discover ?? discoverDecisionEndpoint;
	const [session, state, endpoint] = await Promise.all([
		sessionIsActive(sessionName, run),
		loadState(sessionName),
		discover().catch(() => undefined),
	]);
	return {
		active: session.active,
		cutoffAt: state?.cutoffAt,
		endpoint,
		model: endpoint?.model ?? state?.model,
		sessionName,
		state,
	};
}

export async function stopClefDecisionModel(
	sessionName = DEFAULT_SESSION,
	deps: DecisionModelLifecycleDeps = {},
): Promise<{ stopped: boolean; cutoffRetained: boolean }> {
	const run = deps.runColab ?? runColab;
	const loadState = deps.readState ?? readState;
	const deleteState = deps.removeState ?? removeState;
	const cancel = deps.cancelCutoff ?? cancelCutoff;
	const state = await loadState(sessionName);
	const before = await sessionIsActive(sessionName, run);
	if (!state && before.active) {
		throw new Error(
			`${sessionName} is active but is not owned by the OMPK decision-model launcher; refusing to stop it.`,
		);
	}
	if (!before.active) {
		if (state) await cancel(state.taskName);
		await deleteState(sessionName);
		clearDecisionEndpointCache();
		return { stopped: true, cutoffRetained: false };
	}
	const stopped = await stopSession(sessionName, run);
	if (!stopped) return { stopped: false, cutoffRetained: state !== undefined };
	if (state) await cancel(state.taskName);
	await deleteState(sessionName);
	clearDecisionEndpointCache();
	return { stopped: true, cutoffRetained: false };
}
function minutesRemaining(cutoffAt: string | undefined, now = Date.now()): string {
	if (!cutoffAt) return "unknown";
	const milliseconds = Date.parse(cutoffAt) - now;
	if (!Number.isFinite(milliseconds)) return "unknown";
	return `${Math.max(0, Math.ceil(milliseconds / 60_000))}m`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function handleDecisionModelSlashCommand(
	args: string,
	runtime: SlashCommandRuntime,
): Promise<{ consumed: true }> {
	try {
		const request = parseDecisionModelArgs(args);
		if (request.action === "launch") {
			await runtime.output(
				`Clef: arming a verified ${request.ttlMinutes}m cutoff before requesting ${request.accelerator} compute…`,
			);
			const result = await launchClefDecisionModel(request);
			await runtime.output(
				[
					`Decision model ready: ${result.endpoint.model}`,
					`Endpoint: ${result.endpoint.baseUrl}/systemone`,
					`Colab session: ${result.sessionName}${result.reusedSession ? " (reused)" : ""}`,
					`Automatic shutdown: ${result.cutoffAt} (${minutesRemaining(result.cutoffAt)} remaining)`,
				].join("\n"),
			);
			return { consumed: true };
		}

		if (request.action === "stop") {
			const result = await stopClefDecisionModel(request.sessionName);
			await runtime.output(
				result.stopped
					? `Clef decision runtime stopped: ${request.sessionName}. Automatic cutoff task cleared.`
					: `Could not confirm shutdown of ${request.sessionName}; the automatic cutoff remains armed.`,
			);
			return { consumed: true };
		}

		const status = await getDecisionModelStatus(request.sessionName);
		await runtime.output(
			[
				`Clef decision runtime: ${status.active ? "ACTIVE" : "OFFLINE"}`,
				`Session: ${status.sessionName}`,
				`Model: ${status.model ?? "unknown"}`,
				`Endpoint: ${status.endpoint?.baseUrl ?? status.state?.endpoint ?? "not discovered"}`,
				`Automatic shutdown: ${status.cutoffAt ? `${status.cutoffAt} (${minutesRemaining(status.cutoffAt)} remaining)` : "NOT ARMED"}`,
				...(status.active && !status.cutoffAt
					? ["Warning: this active session is not owned by the Clef launcher and has no recorded OMPK cutoff."]
					: []),
			].join("\n"),
		);
	} catch (error) {
		await runtime.output(`Decision model command failed: ${errorMessage(error)}`);
	}
	return { consumed: true };
}
