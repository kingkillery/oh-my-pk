import { describe, expect, it } from "bun:test";
import { ScreenpipeClient } from "../src/client";

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
	return (async (input: string | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

describe("ScreenpipeClient", () => {
	it("posts a bounded, redaction-gated SELECT to /raw_sql", async () => {
		let capturedUrl = "";
		let capturedQuery = "";
		const fetchImpl = fakeFetch((url, init) => {
			capturedUrl = url;
			capturedQuery = JSON.parse(String(init.body)).query;
			return new Response(JSON.stringify([]), { status: 200 });
		});
		const client = new ScreenpipeClient({ baseUrl: "http://127.0.0.1:3030/", fetchImpl });

		await client.fetchRedactedFrames({ sinceFrameId: 42, limit: 100 });

		expect(capturedUrl).toBe("http://127.0.0.1:3030/raw_sql");
		expect(capturedQuery).toContain("id > 42");
		expect(capturedQuery).toContain("LIMIT 100");
		expect(capturedQuery).toContain("image_redacted_at IS NOT NULL");
	});

	it("parses a fully-redacted row", async () => {
		const row = {
			id: 5,
			timestamp: "2026-07-13T14:00:00.000Z",
			device_name: "device-1",
			app_name: "code",
			window_name: "main.rs",
			browser_url: null,
			focused: 1,
			snapshot_path: null,
			content_hash: 123,
			full_text_redacted_at: 1_752_415_200,
			accessibility_redacted_at: null,
			accessibility_tree_redacted_at: null,
			window_name_redacted_at: 1_752_415_200,
			browser_url_redacted_at: null,
			text_json_redacted_at: null,
			image_redacted_at: null,
			image_redaction_version: null,
			has_full_text: 1,
			has_accessibility_text: 0,
			has_accessibility_tree: 0,
			has_text_json: 0,
		};
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify([row]), { status: 200 }));
		const client = new ScreenpipeClient({ fetchImpl });

		const frames = await client.fetchRedactedFrames({ sinceFrameId: 0, limit: 10 });

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ id: 5, app_name: "code" });
	});

	it("drops a row whose full_text is marked present but has no redaction watermark", async () => {
		const row = {
			id: 5,
			timestamp: "2026-07-13T14:00:00.000Z",
			device_name: "device-1",
			app_name: "code",
			window_name: null,
			browser_url: null,
			focused: 1,
			snapshot_path: null,
			content_hash: null,
			full_text_redacted_at: null,
			accessibility_redacted_at: null,
			accessibility_tree_redacted_at: null,
			window_name_redacted_at: null,
			browser_url_redacted_at: null,
			text_json_redacted_at: null,
			image_redacted_at: null,
			image_redaction_version: null,
			has_full_text: 1,
			has_accessibility_text: 0,
			has_accessibility_tree: 0,
			has_text_json: 0,
		};
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify([row]), { status: 200 }));
		const client = new ScreenpipeClient({ fetchImpl });

		const frames = await client.fetchRedactedFrames({ sinceFrameId: 0, limit: 10 });

		expect(frames).toEqual([]);
	});

	it("drops a row with a snapshot but no image redaction watermark", async () => {
		const row = {
			id: 5,
			timestamp: "2026-07-13T14:00:00.000Z",
			device_name: "device-1",
			app_name: "code",
			window_name: null,
			browser_url: null,
			focused: 1,
			snapshot_path: "/home/user/.screenpipe/data/2026-07-13/1_m0.jpg",
			content_hash: null,
			full_text_redacted_at: null,
			accessibility_redacted_at: null,
			accessibility_tree_redacted_at: null,
			window_name_redacted_at: null,
			browser_url_redacted_at: null,
			text_json_redacted_at: null,
			image_redacted_at: null,
			image_redaction_version: null,
			has_full_text: 0,
			has_accessibility_text: 0,
			has_accessibility_tree: 0,
			has_text_json: 0,
		};
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify([row]), { status: 200 }));
		const client = new ScreenpipeClient({ fetchImpl });

		const frames = await client.fetchRedactedFrames({ sinceFrameId: 0, limit: 10 });

		expect(frames).toEqual([]);
	});

	it("rejects a non-2xx response", async () => {
		const fetchImpl = fakeFetch(() => new Response("boom", { status: 500 }));
		const client = new ScreenpipeClient({ fetchImpl });

		await expect(client.fetchRedactedFrames({ sinceFrameId: 0, limit: 10 })).rejects.toThrow(
			"screenpipe /raw_sql returned 500",
		);
	});

	it("rejects an out-of-range limit", async () => {
		const client = new ScreenpipeClient({ fetchImpl: fakeFetch(() => new Response("[]")) });
		await expect(client.fetchRedactedFrames({ sinceFrameId: 0, limit: 0 })).rejects.toThrow(
			"limit must be a positive integer",
		);
		await expect(client.fetchRedactedFrames({ sinceFrameId: -1, limit: 10 })).rejects.toThrow(
			"sinceFrameId must be a non-negative integer",
		);
	});
});
