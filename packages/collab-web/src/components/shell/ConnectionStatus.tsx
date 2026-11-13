import { Clock, LoaderCircle, Radio, RefreshCw, Unplug } from "lucide-react";
import type { ReactNode } from "react";
import { type ConnectionKind, type ConnectionView, formatHold } from "../../lib/connection-state";

function StatusIcon({ kind }: { kind: ConnectionKind }): ReactNode {
	const props = { size: 14, "aria-hidden": true as const };
	switch (kind) {
		case "live":
			return <Radio {...props} />;
		case "host-away":
			return <Clock {...props} />;
		case "reconnecting":
			return <RefreshCw {...props} />;
		case "room-closed":
		case "ended":
			return <Unplug {...props} />;
		default:
			return <LoaderCircle {...props} />;
	}
}

/** Status as an icon plus words. Color is a secondary cue. */
export function ConnectionPill({ view }: { view: ConnectionView }): ReactNode {
	return (
		<span className={`sh-status sh-status-${view.kind}`}>
			<span className="sh-status-icon">
				<StatusIcon kind={view.kind} />
			</span>
			<span className="sh-status-label">{view.label}</span>
			{view.holdSeconds !== null && <span className="sh-status-hold">{formatHold(view.holdSeconds)}</span>}
		</span>
	);
}

export function StatusIconMark({ kind }: { kind: ConnectionKind }): ReactNode {
	return (
		<span className="sh-status-icon">
			<StatusIcon kind={kind} />
		</span>
	);
}
