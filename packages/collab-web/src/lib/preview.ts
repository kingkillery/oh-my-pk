/**
 * Snapshots for phone screenshots.
 * Allowed on localhost and on the Android wrapper's asset origin
 * (`appassets.androidplatform.net`), which is not a public host.
 * The preview link is a fixed zero key. It is never rendered and never dialed.
 */

import type { AssistantMessage, SessionEntry, SessionHeader, SessionState } from "@pk-nerdsaver-ai/pi-wire";
import { GuestClient } from "./client";
import { encodeBase64Url } from "./link";

export const PREVIEW_SCENARIOS = [
	"live",
	"connecting",
	"host-away",
	"reconnecting",
	"room-closed",
	"read-only",
] as const;

export type PreviewScenario = (typeof PREVIEW_SCENARIOS)[number];

/** Room id used only to satisfy the link parser. Must not appear in the UI. */
export const PREVIEW_LINK_MARKER = "previewroom1";

const PREVIEW_HOSTS: Record<string, true> = {
	localhost: true,
	"127.0.0.1": true,
	"::1": true,
	"[::1]": true,
	"appassets.androidplatform.net": true,
};

export function readPreviewScenario(loc: { hostname: string; search: string }): PreviewScenario | null {
	if (!PREVIEW_HOSTS[loc.hostname]) return null;
	const value = new URLSearchParams(loc.search).get("preview");
	if (
		value === "live" ||
		value === "connecting" ||
		value === "host-away" ||
		value === "reconnecting" ||
		value === "room-closed" ||
		value === "read-only"
	) {
		return value;
	}
	return null;
}

export function readPreviewTheme(loc: { search: string }): "light" | "dark" | null {
	const value = new URLSearchParams(loc.search).get("theme");
	return value === "light" || value === "dark" ? value : null;
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		model: "preview",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 1,
	};
}

const HEADER: SessionHeader = {
	type: "session",
	id: "preview-session",
	title: "Login form",
	timestamp: "2026-06-12T00:00:00.000Z",
	cwd: "/work/app",
};

function state(streaming: boolean): SessionState {
	return {
		isStreaming: streaming,
		queuedMessageCount: 0,
		cwd: "/work/app",
		sessionName: "Login form",
		thinkingLevel: "low",
		model: { id: "preview", name: "Preview", provider: "local", contextWindow: 128000 },
		participants: [
			{ name: "host", role: "host" },
			{ name: "phone", role: "guest" },
		],
		contextUsage: { tokens: 1200, contextWindow: 128000, percent: 4 },
	};
}

const ENTRIES: SessionEntry[] = [
	{
		id: "p1",
		parentId: null,
		timestamp: "2026-06-12T00:00:01.000Z",
		type: "message",
		message: {
			role: "user",
			content: "Update the login form so it works on a phone.",
			timestamp: 1,
		},
	},
	{
		id: "p2",
		parentId: "p1",
		timestamp: "2026-06-12T00:00:02.000Z",
		type: "message",
		message: assistant(
			"The login form needs three changes:\n\n- Label each field\n- Keep the submit button above the keyboard\n- Show errors as text, not color alone",
		),
	},
];

export function createPreviewClient(scenario: PreviewScenario, now = Date.now()): GuestClient {
	const client = new GuestClient(`${PREVIEW_LINK_MARKER}.${encodeBase64Url(new Uint8Array(48))}`, "phone");
	const readOnly = scenario === "read-only";
	const live = scenario === "live" || scenario === "host-away" || scenario === "read-only";
	client.presentPreview({
		phase:
			scenario === "connecting"
				? "connecting"
				: scenario === "reconnecting"
					? "reconnecting"
					: scenario === "room-closed"
						? "ended"
						: "live",
		endedReason: scenario === "room-closed" ? "room closed" : null,
		hostAwayUntil: scenario === "host-away" ? now + 45_000 : null,
		readOnly,
		working: scenario === "live",
		header: scenario === "connecting" ? null : HEADER,
		entries: scenario === "connecting" ? [] : ENTRIES,
		state: scenario === "connecting" ? null : state(live && scenario === "live"),
	});
	return client;
}
