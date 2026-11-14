import { SendHorizontal, Square } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { GuestClient, GuestSnapshot } from "../../lib/client";
import { ROOM_CLOSED_REASON } from "../../lib/connection-state";

export interface ComposerProps {
	client: GuestClient;
	snapshot: GuestSnapshot;
}

/** Textarea metrics: line-height 20px + 18px total vertical padding (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 18;
const MAX_ROWS = 8;

function composerPlaceholder(snapshot: GuestSnapshot, live: boolean, hostAway: boolean): string {
	if (snapshot.phase === "ended") return snapshot.endedReason === ROOM_CLOSED_REASON ? "Room closed" : "Ended";
	if (snapshot.readOnly) return "Read-only";
	if (hostAway) return "Host away";
	if (live) return "Message";
	if (snapshot.phase === "reconnecting") return "Reconnecting";
	if (snapshot.phase === "waiting") return "Joining";
	return "Connecting";
}

export function Composer({ client, snapshot }: ComposerProps): ReactNode {
	const [text, setText] = useState("");
	const taRef = useRef<HTMLTextAreaElement | null>(null);

	const hostAway = snapshot.hostAwayUntil !== null && snapshot.phase === "live";
	const live = snapshot.phase === "live" && !hostAway;
	const readOnly = snapshot.readOnly;
	const canPrompt = live && !readOnly;
	const busy = snapshot.working || (snapshot.state?.isStreaming ?? false);
	const queued = snapshot.state?.queuedMessageCount ?? 0;
	const canSend = canPrompt && text.trim().length > 0;

	useLayoutEffect(() => {
		const el = taRef.current;
		if (!el) return;
		el.style.height = "0px";
		const max = MAX_ROWS * LINE_PX + PAD_Y;
		el.style.height = `${Math.max(LINE_PX + PAD_Y, Math.min(el.scrollHeight, max))}px`;
		el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
	}, [text]);

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (!trimmed || !live || readOnly) return;
		client.sendPrompt(trimmed);
		setText("");
	}, [client, live, readOnly, text]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};

	return (
		<div className="sh-composer">
			<div className="sh-composer-inner">
				<textarea
					ref={taRef}
					className="sh-composer-input"
					aria-label="Message the host agent"
					value={text}
					onChange={e => setText(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder={composerPlaceholder(snapshot, live, hostAway)}
					disabled={!canPrompt}
					rows={1}
					spellCheck={false}
				/>
				<div className="sh-composer-footer">
					<span className="sh-composer-hint">
						Enter to send <span aria-hidden="true">·</span> Shift+Enter for newline
					</span>
					<div className="sh-composer-actions">
						{busy && queued > 0 && (
							<span className="sh-queued">
								<span className="sh-queued-label">queued </span>×{queued}
							</span>
						)}
						{busy && !readOnly && (
							<button
								type="button"
								className="sh-btn sh-btn-stop"
								onClick={() => client.sendAbort()}
								disabled={!live}
								aria-label="Stop"
							>
								<Square size={16} /> <span className="sh-btn-label">Stop</span>
							</button>
						)}
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							onClick={send}
							disabled={!canSend}
							aria-label="Send"
						>
							<SendHorizontal size={16} /> <span className="sh-btn-label">Send</span>
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
