import { describe, expect, it } from "bun:test";
import { type ConnectionInput, connectionView, formatHold, shouldResumeNow } from "../src/lib/connection-state";

function view(overrides: Partial<ConnectionInput> = {}) {
	return connectionView({
		phase: "live",
		endedReason: null,
		hostAwayUntil: null,
		now: 0,
		readOnly: false,
		...overrides,
	});
}

describe("connectionView", () => {
	it("names each phase in words", () => {
		expect(view({ phase: "connecting" })).toMatchObject({ kind: "connecting", label: "Connecting" });
		expect(view({ phase: "waiting" })).toMatchObject({ kind: "joining", label: "Joining" });
		expect(view({ phase: "live" })).toMatchObject({ kind: "live", label: "Live", holdSeconds: null });
		expect(view({ phase: "reconnecting" })).toMatchObject({ kind: "reconnecting", label: "Reconnecting" });
	});

	it("shows the host hold countdown and clamps it at zero", () => {
		const away = view({ hostAwayUntil: 45_000, now: 3_200 });
		expect(away.kind).toBe("host-away");
		expect(away.label).toBe("Host away");
		expect(away.holdSeconds).toBe(42);
		expect(formatHold(away.holdSeconds ?? 0)).toBe("0:42");

		const expired = view({ hostAwayUntil: 1_000, now: 5_000 });
		expect(expired.holdSeconds).toBe(0);
		expect(formatHold(0)).toBe("0:00");
		expect(formatHold(61)).toBe("1:01");
	});

	it("prefers reconnecting over a stale host-away hold", () => {
		const reconnecting = view({ phase: "reconnecting", hostAwayUntil: 45_000, now: 0 });
		expect(reconnecting.kind).toBe("reconnecting");
		expect(reconnecting.holdSeconds).toBeNull();
	});

	it("treats room closed as a rescan, and other endings as ended", () => {
		const closed = view({ phase: "ended", endedReason: "room closed" });
		expect(closed).toMatchObject({ kind: "room-closed", label: "Room closed", roomClosed: true });

		const ended = view({ phase: "ended", endedReason: "host left" });
		expect(ended).toMatchObject({ kind: "ended", label: "Ended", roomClosed: false });
	});

	it("keeps read-only as a flag on top of the connection kind", () => {
		expect(view({ readOnly: true }).readOnly).toBe(true);
		expect(view({ readOnly: true }).label).toBe("Live");
		expect(view({ phase: "waiting", hostAwayUntil: 10_000, now: 0, readOnly: true }).kind).toBe("host-away");
	});
});

describe("shouldResumeNow", () => {
	it("resumes when the page becomes visible or the network returns", () => {
		expect(shouldResumeNow("visibility", "visible")).toBe(true);
		expect(shouldResumeNow("visibility", "hidden")).toBe(false);
		expect(shouldResumeNow("online", "hidden")).toBe(true);
		expect(shouldResumeNow("online", "visible")).toBe(true);
	});
});
