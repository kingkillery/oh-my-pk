/**
 * How the phone guest describes the relay connection.
 *
 * The phase machine stays compatible with the host. This view only decides
 * which words to show: a color dot is never the status.
 */

/** Guest socket lifecycle. Unchanged wire behavior; the UI maps it to words. */
export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

/** Close reason / control text for a room the relay has dropped. */
export const ROOM_CLOSED_REASON = "room closed";

/** Mirrors the relay's host hold (`HOST_GRACE_MS`) when a control frame omits it. */
export const DEFAULT_HOST_HOLD_MS = 45_000;

export type ConnectionKind = "connecting" | "joining" | "live" | "host-away" | "reconnecting" | "room-closed" | "ended";

export interface ConnectionInput {
	phase: ConnectionPhase;
	endedReason: string | null;
	/** Epoch ms when the relay's host hold ends. Null while the host is present. */
	hostAwayUntil: number | null;
	now: number;
	readOnly: boolean;
}

export interface ConnectionView {
	kind: ConnectionKind;
	/** Short status label. Always words, never color alone. */
	label: string;
	/** Whole seconds left in the host hold. Null unless the host is away. */
	holdSeconds: number | null;
	readOnly: boolean;
	roomClosed: boolean;
}

export function connectionView(input: ConnectionInput): ConnectionView {
	const readOnly = input.readOnly;
	if (input.phase === "ended") {
		const roomClosed = input.endedReason === ROOM_CLOSED_REASON;
		return {
			kind: roomClosed ? "room-closed" : "ended",
			label: roomClosed ? "Room closed" : "Ended",
			holdSeconds: null,
			readOnly,
			roomClosed,
		};
	}
	if (input.phase === "reconnecting") {
		return { kind: "reconnecting", label: "Reconnecting", holdSeconds: null, readOnly, roomClosed: false };
	}
	if (input.phase === "connecting") {
		return { kind: "connecting", label: "Connecting", holdSeconds: null, readOnly, roomClosed: false };
	}
	if ((input.phase === "live" || input.phase === "waiting") && input.hostAwayUntil !== null) {
		return hostAwayView(input.hostAwayUntil, input.now, readOnly);
	}
	if (input.phase === "waiting") {
		return { kind: "joining", label: "Joining", holdSeconds: null, readOnly, roomClosed: false };
	}
	return { kind: "live", label: "Live", holdSeconds: null, readOnly, roomClosed: false };
}

function hostAwayView(until: number, now: number, readOnly: boolean): ConnectionView {
	const remainingMs = Math.max(0, until - now);
	return {
		kind: "host-away",
		label: "Host away",
		holdSeconds: Math.ceil(remainingMs / 1000),
		readOnly,
		roomClosed: false,
	};
}

/** `m:ss` for the host-hold countdown. */
export function formatHold(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(total / 60);
	const rest = total % 60;
	return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/**
 * Whether a wake signal should poke the socket.
 * `online` always resumes. A visibility change resumes only when the page is shown.
 */
export function shouldResumeNow(event: "visibility" | "online", visibilityState: DocumentVisibilityState): boolean {
	if (event === "online") return true;
	return visibilityState === "visible";
}
