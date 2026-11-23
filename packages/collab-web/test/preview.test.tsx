import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Banners } from "../src/components/shell/Banners";
import { connectionView } from "../src/lib/connection-state";
import { encodeBase64Url } from "../src/lib/link";
import { PREVIEW_LINK_MARKER, readPreviewScenario } from "../src/lib/preview";
import type { PreviewScenario } from "../src/lib/preview";

// app.tsx pulls in the tool-view custom element, which extends HTMLElement.
if (typeof globalThis.HTMLElement === "undefined") {
	globalThis.HTMLElement = class {} as typeof HTMLElement;
}

const { PreviewApp } = await import("../src/app");

const ZERO_KEY = encodeBase64Url(new Uint8Array(48));

function render(scenario: PreviewScenario): string {
	return renderToStaticMarkup(<PreviewApp scenario={scenario} />);
}

describe("localhost preview", () => {
	it("only enables preview on a local or bundled-app host", () => {
		expect(readPreviewScenario({ hostname: "localhost", search: "?preview=live" })).toBe("live");
		expect(readPreviewScenario({ hostname: "127.0.0.1", search: "?preview=read-only" })).toBe("read-only");
		expect(readPreviewScenario({ hostname: "appassets.androidplatform.net", search: "?preview=live" })).toBe("live");
		expect(readPreviewScenario({ hostname: "oh-my-pk.pkking.computer", search: "?preview=live" })).toBeNull();
		expect(readPreviewScenario({ hostname: "localhost", search: "?preview=other" })).toBeNull();
	});

	it("renders phone states without the preview link", () => {
		const live = render("live");
		expect(live).toContain("Login form");
		expect(live).toContain("Stop");
		expect(live).toContain('data-connection="live"');
		expect(live).toContain('data-working="true"');
		expect(live).toContain('data-needs-input="false"');
		expect(live).not.toContain(PREVIEW_LINK_MARKER);
		expect(live).not.toContain(ZERO_KEY);

		const away = render("host-away");
		expect(away).toContain("Host away");
		expect(away).toContain("0:45");

		expect(render("connecting")).toContain("Connecting");
		expect(render("reconnecting")).toContain("Reconnecting");

		const closed = render("room-closed");
		expect(closed).toContain("Room closed");
		expect(closed).toContain("Rescan the QR on your computer");

		const readOnly = render("read-only");
		expect(readOnly).toContain("Read-only");
		expect(readOnly).toContain('data-readonly="true"');
		expect(readOnly).toContain("disabled");
		expect(readOnly).not.toContain(">Stop<");
	});

	it("room closed offers a rescan and other endings still offer rejoin", () => {
		const closed = renderToStaticMarkup(
			<Banners
				view={connectionView({
					phase: "ended",
					endedReason: "room closed",
					hostAwayUntil: null,
					now: 0,
					readOnly: false,
				})}
				endedReason="room closed"
				onRejoin={() => {}}
				onNewLink={() => {}}
			/>,
		);
		expect(closed).toContain("Rescan the QR on your computer");
		expect(closed).not.toContain("Rejoin");

		const ended = renderToStaticMarkup(
			<Banners
				view={connectionView({
					phase: "ended",
					endedReason: "host left",
					hostAwayUntil: null,
					now: 0,
					readOnly: false,
				})}
				endedReason="host left"
				onRejoin={() => {}}
				onNewLink={() => {}}
			/>,
		);
		expect(ended).toContain("Rejoin");
		expect(ended).toContain("host left");
	});
});
