import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { logger } from "@pk-nerdsaver-ai/pi-utils";

import type {
	Annotation,
	BrowserContext,
	CaptureMode,
	ContextPacket,
	ForegroundAppContext,
	SelectionContext,
	VisualContext,
} from "./types";

/** Options for a single capture. */
export interface CaptureOptions {
	mode: CaptureMode;
	region?: { x: number; y: number; width: number; height: number };
	includeClipboard?: boolean;
	includeActiveAppState?: boolean;
	userRequest: string;
	annotations?: Annotation[];
}

/** Service that captures the desktop context for a tag request. */
export class CaptureService {
	readonly #tempDir: string;

	constructor(tempDir?: string) {
		this.#tempDir = tempDir ?? path.join(os.tmpdir(), "pi-desktop-tag");
	}

	async init(): Promise<void> {
		await fs.mkdir(this.#tempDir, { recursive: true });
	}

	async capture(options: CaptureOptions): Promise<ContextPacket> {
		await this.init();

		const captureId = crypto.randomUUID();
		const timestamp = new Date().toISOString();
		const screenshotPath = path.join(this.#tempDir, `${captureId}.png`);

		const [visual, foregroundApp, selection, browser, availableCapabilities] = await Promise.all([
			this.#captureVisual(options, captureId, screenshotPath),
			options.includeActiveAppState ? this.#captureForegroundApp() : Promise.resolve({}),
			options.includeClipboard ? this.#captureSelection() : Promise.resolve({}),
			this.#captureBrowserContext(),
			this.#resolveAvailableCapabilities(),
		]);

		return {
			captureId,
			timestamp,
			userRequest: options.userRequest,
			captureMode: options.mode,
			visual,
			foregroundApp,
			selection,
			browser,
			availableCapabilities,
		};
	}

	async #captureVisual(options: CaptureOptions, captureId: string, screenshotPath: string): Promise<VisualContext> {
		try {
			const { region } = options;
			if (options.mode === "screen" || options.mode === "browser" || options.mode === "window") {
				await captureScreenshot(screenshotPath, options.mode === "window" ? undefined : region);
			} else if (options.mode === "region" && region) {
				await captureScreenshot(screenshotPath, region);
			}

			return {
				screenshotPath,
				selectedRegion: region,
				displayScale: 1,
				annotations: options.annotations ?? [],
			};
		} catch (error) {
			logger.debug("Screenshot capture failed", { error: error instanceof Error ? error.message : String(error) });
			return { screenshotPath: undefined, selectedRegion: options.region, displayScale: 1, annotations: [] };
		}
	}

	async #captureForegroundApp(): Promise<ForegroundAppContext> {
		if (process.platform !== "win32") {
			return {};
		}
		try {
			const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$hwnd = [Win32]::GetForegroundWindow()
$processId = 0
[void][Win32]::GetWindowThreadProcessId($hwnd, [ref]$processId)
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
if ($process) {
    @{ Name = $process.Name; MainWindowTitle = $process.MainWindowTitle; Path = $process.Path } | ConvertTo-Json -Compress
} else {
    "{}"
}
`;
			const output = await runPowershell(script);
			const parsed = JSON.parse(output || "{}") as {
				Name?: string;
				MainWindowTitle?: string;
				Path?: string;
			};
			return {
				processName: parsed.Name,
				windowTitle: parsed.MainWindowTitle,
				executablePath: parsed.Path,
			};
		} catch (error) {
			logger.debug("Foreground app capture failed", { error: error instanceof Error ? error.message : String(error) });
			return {};
		}
	}

	async #captureSelection(): Promise<SelectionContext> {
		if (process.platform !== "win32") {
			return {};
		}
		try {
			const script = `
$text = Get-Clipboard -TextFormatType Text -ErrorAction SilentlyContinue
if ($text) { @{ text = $text } | ConvertTo-Json -Compress } else { "{}" }
`;
			const output = await runPowershell(script);
			const parsed = JSON.parse(output || "{}") as { text?: string };
			return { clipboardText: parsed.text };
		} catch (error) {
			logger.debug("Clipboard capture failed", { error: error instanceof Error ? error.message : String(error) });
			return {};
		}
	}

	async #captureBrowserContext(): Promise<BrowserContext> {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 1_500);
			const response = await fetch("http://127.0.0.1:18086/ix-bridge/status", { signal: controller.signal });
			clearTimeout(timer);
			if (!response.ok) return {};

			const body = (await response.json().catch(() => ({}))) as {
				running?: boolean;
				extension_connected?: boolean;
			};
			if (!body.extension_connected) return {};

			const urlRes = await fetch("http://127.0.0.1:18086/ix-bridge/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ lane: "agent-a", action: "get_url", args: {} }),
				signal: controller.signal,
			}).catch(() => undefined);
			const titleRes = await fetch("http://127.0.0.1:18086/ix-bridge/command", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ lane: "agent-a", action: "get_title", args: {} }),
				signal: controller.signal,
			}).catch(() => undefined);

			const url = await extractJsonText(urlRes, "url");
			const title = await extractJsonText(titleRes, "title");
			return { url, title };
		} catch {
			return {};
		}
	}

	async #resolveAvailableCapabilities(): Promise<string[]> {
		const capabilities = ["visual"];
		if (process.platform === "win32") {
			capabilities.push("clipboard", "foreground-app");
		}
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 1_000);
			const response = await fetch("http://127.0.0.1:18086/ix-bridge/status", { signal: controller.signal });
			clearTimeout(timer);
			if (response.ok) capabilities.push("browser");
		} catch {
			// ignore
		}
		return capabilities;
	}
}

async function extractJsonText(response: Response | undefined, key: string): Promise<string | undefined> {
	if (!response) return undefined;
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	const value = body[key];
	if (typeof value === "string") return value;
	const result = body.result;
	if (result && typeof result === "object" && key in result) {
		const nested = (result as Record<string, unknown>)[key];
		return typeof nested === "string" ? nested : undefined;
	}
	return undefined;
}

export async function captureScreenshot(screenshotPath: string, region?: { x: number; y: number; width: number; height: number }): Promise<void> {
	if (process.platform !== "win32") {
		throw new Error(`Screenshot capture not implemented for ${process.platform}`);
	}

	const x = region?.x ?? 0;
	const y = region?.y ?? 0;
	const width = region?.width ?? 0;
	const height = region?.height ?? 0;

	const script = region
		? `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)
$bmp.Save("${screenshotPath}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`
		: `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save("${screenshotPath}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`;

	await runPowershell(script);
}

async function runPowershell(script: string): Promise<string> {
	const scriptPath = path.join(os.tmpdir(), `pi-desktop-tag-${crypto.randomUUID()}.ps1`);
	await fs.writeFile(scriptPath, script, "utf8");
	try {
		const proc = Bun.spawn(["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		if (proc.exitCode !== 0) {
			throw new Error(`PowerShell failed: ${stderr || stdout}`);
		}
		return stdout.trim();
	} finally {
		await fs.unlink(scriptPath).catch(() => {});
	}
}
