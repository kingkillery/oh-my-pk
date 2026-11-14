import type { ReactNode } from "react";
import { type ConnectionView, formatHold } from "../../lib/connection-state";
import { StatusIconMark } from "./ConnectionStatus";

export interface BannersProps {
	view: ConnectionView;
	endedReason: string | null;
	onRejoin(): void;
	onNewLink(): void;
}

export function Banners({ view, endedReason, onRejoin, onNewLink }: BannersProps): ReactNode {
	if (
		view.kind === "connecting" ||
		view.kind === "joining" ||
		view.kind === "reconnecting" ||
		view.kind === "host-away"
	) {
		return (
			<div className={`sh-banner sh-banner-${view.kind}`} role="status">
				<StatusIconMark kind={view.kind} />
				<span>{view.label}</span>
				{view.holdSeconds !== null && <span className="sh-status-hold">{formatHold(view.holdSeconds)}</span>}
			</div>
		);
	}
	if (view.kind === "room-closed") {
		return (
			<div className="sh-ended" role="alertdialog" aria-label="Room closed">
				<div className="sh-ended-card">
					<div className="sh-ended-title">Room closed</div>
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={onNewLink}>
							Rescan the QR on your computer
						</button>
					</div>
				</div>
			</div>
		);
	}
	if (view.kind === "ended") {
		return (
			<div className="sh-ended" role="alertdialog" aria-label="Session ended">
				<div className="sh-ended-card">
					<div className="sh-ended-title">Ended</div>
					{endedReason && <div className="sh-ended-reason">{endedReason}</div>}
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={onRejoin}>
							Rejoin
						</button>
						<button type="button" className="sh-btn" onClick={onNewLink}>
							New link
						</button>
					</div>
				</div>
			</div>
		);
	}
	return null;
}
