/**
 * Clips — agent-native screen recording, as an oh-my-pk extension.
 *
 * Two surfaces:
 *  - `/record` opens the recorder web UI (gopk.xyz) so you can capture a clip.
 *  - `/clip <url>` and the `clip_context` tool fetch a clip's agent-readable
 *    briefing (transcript + timestamped screenshot URLs) and feed it into the
 *    session so the agent can "see and hear" the recording.
 *
 * Host base URL resolves from (in order): the `--clips-host` flag, the
 * `GOPK_CLIPS_URL` env var, then the `https://gopk.xyz` default.
 */
import type { TSchema } from "@pk-nerdsaver-ai/pi-ai";
import type { ExtensionAPI } from "@pk-nerdsaver-ai/pi-coding-agent";

const DEFAULT_HOST = "https://gopk.xyz";
const CLIP_PATH = /\/clip\/([^/?#]+)/;

function resolveHost(pi: ExtensionAPI): string {
	const flag = pi.getFlag("clips-host");
	if (typeof flag === "string" && flag.trim()) return flag.replace(/\/+$/, "");
	const env = process.env.GOPK_CLIPS_URL;
	if (env?.trim()) return env.replace(/\/+$/, "");
	return DEFAULT_HOST;
}

/** Pull the clip id out of a full share URL or accept a bare id. */
function extractClipId(input: string): string | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	const match = trimmed.match(CLIP_PATH);
	if (match) return match[1];
	// Bare id (no slashes / scheme / spaces) — accept as-is.
	if (!trimmed.includes("/") && !trimmed.includes(" ")) return trimmed;
	return undefined;
}

function resolveToken(pi: ExtensionAPI): string | undefined {
	const flag = pi.getFlag("clips-token");
	if (typeof flag === "string" && flag.trim()) return flag.trim();
	const env = process.env.GOPK_CLIPS_TOKEN;
	return env?.trim() ? env.trim() : undefined;
}

async function fetchAgentContext(host: string, id: string, token: string | undefined): Promise<string> {
	const headers = token ? { authorization: `Bearer ${token}` } : undefined;
	const res = await fetch(`${host}/clip/${id}/agent`, { headers });
	if (res.status === 401) throw new Error("Unauthorized — set --clips-token or GOPK_CLIPS_TOKEN");
	if (!res.ok) throw new Error(`Clip ${id} returned HTTP ${res.status}`);
	return res.text();
}

/** Best-effort open of a URL in the OS default browser; failure is non-fatal. */
function openInBrowser(url: string): void {
	const command =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
	try {
		Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref();
	} catch {
		// Headless / no opener available — the notify message still shows the URL.
	}
}

export default function clipsExtension(pi: ExtensionAPI): void {
	pi.setLabel("Clips");

	pi.registerFlag("clips-host", {
		description: "Base URL of the Clips host (default https://gopk.xyz)",
		type: "string",
	});
	pi.registerFlag("clips-token", {
		description: "Access token for the private Clips host (or set GOPK_CLIPS_TOKEN)",
		type: "string",
	});

	// `/record` — open the recorder UI.
	pi.registerCommand("record", {
		description: "Open the Clips recorder to capture a screen + voice clip",
		handler: async (_args, ctx): Promise<void> => {
			const host = resolveHost(pi);
			openInBrowser(host);
			ctx.ui.notify(`Opening Clips recorder at ${host}`, "info");
		},
	});

	// `/clip <url|id>` — ingest a clip's transcript + frames into the session.
	pi.registerCommand("clip", {
		description: "Load a Clips recording (URL or id) into context so the agent can see and hear it",
		handler: async (args, ctx): Promise<void> => {
			const host = resolveHost(pi);
			const token = resolveToken(pi);
			const id = extractClipId(args);
			if (!id) {
				ctx.ui.notify("Usage: /clip <gopk.xyz clip url or id>", "warning");
				return;
			}
			try {
				const context = await fetchAgentContext(host, id, token);
				pi.sendUserMessage(
					`I am sharing a screen recording (Clip ${id}). Use this transcript and the screenshot URLs to understand what I showed — fetch any frame URL to see the screen at that moment.\n\n${context}`,
					{ deliverAs: "followUp" },
				);
				ctx.ui.notify(`Loaded clip ${id} into context`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to load clip: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// Agent-callable tool: lets the model pull a clip into context on its own.
	pi.registerTool({
		name: "clip_context",
		label: "Load Clip Context",
		description:
			"Fetch the agent-readable transcript and timestamped screenshot URLs for a Clips screen recording. Pass the share URL or clip id. Returns markdown the agent can read; fetch any frame URL to see the screen at that moment.",
		approval: "read",
		parameters: pi.typebox.Type.Object({
			clip: pi.typebox.Type.String({ description: "Clip share URL (https://gopk.xyz/clip/<id>) or bare clip id" }),
		}) as TSchema,
		async execute(_toolCallId, params) {
			const clip = params && typeof params === "object" && "clip" in params ? params.clip : undefined;
			if (typeof clip !== "string") {
				return { content: [{ type: "text", text: "Missing required 'clip' string parameter." }] };
			}
			const id = extractClipId(clip);
			if (!id) return { content: [{ type: "text", text: `Could not parse a clip id from "${clip}".` }] };
			const context = await fetchAgentContext(resolveHost(pi), id, resolveToken(pi));
			return { content: [{ type: "text", text: context }] };
		},
	});
}
