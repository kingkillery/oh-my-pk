import type { ImageContent, TextContent } from "@pk-nerdsaver-ai/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";
import type { KeyId } from "@pk-nerdsaver-ai/pi-tui";
import { logger } from "@pk-nerdsaver-ai/pi-utils";

import { CaptureService } from "./context";
import { type CapabilityRegistry, createDefaultRegistry, routeContext, updateAvailability } from "./router";
import type { CaptureMode, ContextPacket } from "./types";

const MODES: CaptureMode[] = ["screen", "window", "region", "browser"];

/** Default factory function loaded by the pi extension system. */
export default function desktopTagExtension(pi: ExtensionAPI): void {
	const captureService = new CaptureService();
	const registry = createDefaultRegistry();

	pi.setLabel("Desktop Tag");

	pi.registerCommand("tag", {
		description: "Capture desktop context and send it to the agent",
		async handler(args, ctx) {
			const { mode, request } = parseCommandArgs(args);
			await captureAndSend(pi, ctx, captureService, registry, mode, request);
		},
	});

	pi.registerShortcut("ctrl+shift+space" as KeyId, {
		description: "Capture the screen and tag the agent",
		async handler(ctx) {
			const request = ctx.hasUI ? await ctx.ui.input("What should pi do with this screen?") : "";
			await captureAndSend(pi, ctx, captureService, registry, "screen", request ?? "");
		},
	});
}

async function captureAndSend(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	captureService: CaptureService,
	registry: CapabilityRegistry,
	mode: CaptureMode,
	userRequest: string,
): Promise<void> {
	try {
		if (ctx.hasUI) ctx.ui.setStatus("desktop-tag", "Capturing desktop context...");

		const packet = await captureService.capture({ mode, userRequest, includeClipboard: true });
		await updateAvailability(registry);
		const routing = routeContext(registry, packet);

		const content: (TextContent | ImageContent)[] = [
			{ type: "text", text: buildPromptText(packet, routing.message) },
		];

		if (packet.visual.screenshotPath) {
			const image = await loadImage(packet.visual.screenshotPath);
			content.push(image);
		}

		pi.sendUserMessage(content);
		if (ctx.hasUI) ctx.ui.setStatus("desktop-tag", undefined);
	} catch (error) {
		logger.error("desktop-tag extension failed", { error: error instanceof Error ? error.message : String(error) });
		if (ctx.hasUI) ctx.ui.notify("Failed to capture desktop context", "error");
	}
}

function buildPromptText(packet: ContextPacket, routingMessage: string): string {
	const lines = [
		`[desktop-tag] ${routingMessage}`,
		`Capture mode: ${packet.captureMode}`,
		`User request: ${packet.userRequest}`,
	];
	if (packet.foregroundApp.processName) {
		lines.push(
			`Foreground app: ${packet.foregroundApp.processName} — ${packet.foregroundApp.windowTitle ?? "unknown window"}`,
		);
	}
	if (packet.browser.url) {
		lines.push(`Browser tab: ${packet.browser.title ?? ""} (${packet.browser.url})`);
	}
	if (packet.selection.clipboardText) {
		lines.push(`Selection/clipboard: ${packet.selection.clipboardText}`);
	}
	return lines.join("\n");
}

async function loadImage(path: string): Promise<ImageContent> {
	const bytes = await Bun.file(path).bytes();
	return { type: "image", data: bytes.toBase64(), mimeType: "image/png", detail: "high" };
}

function parseCommandArgs(args: string): { mode: CaptureMode; request: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const firstMode = tokens[0] as CaptureMode | undefined;
	if (firstMode && MODES.includes(firstMode)) {
		return { mode: firstMode, request: tokens.slice(1).join(" ") };
	}
	return { mode: "screen", request: args.trim() };
}
