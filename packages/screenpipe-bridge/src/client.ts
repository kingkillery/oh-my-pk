import type { ScreenpipeFrameRow } from "./types";

export interface ScreenpipeClientOptions {
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
}

export interface FetchRedactedFramesOptions {
	readonly sinceFrameId: number;
	readonly limit: number;
}

/**
 * Reads already-redacted frame metadata from a local screenpipe instance via
 * its read-only `/raw_sql` endpoint. Every text surface a frame carries must
 * already have its redaction watermark set (screenpipe's async PII worker),
 * and a frame with a screenshot must have its image redaction watermark set
 * too — frames missing either are filtered out in SQL, then re-checked
 * client-side in `parseFrameRow` since screenpipe is a separate, untrusted
 * process from this bridge's point of view.
 */
export class ScreenpipeClient {
	#baseUrl: string;
	#fetchImpl: typeof fetch;

	constructor(options: ScreenpipeClientOptions = {}) {
		this.#baseUrl = (options.baseUrl ?? "http://127.0.0.1:3030").replace(/\/+$/, "");
		this.#fetchImpl = options.fetchImpl ?? fetch;
	}

	async fetchRedactedFrames(options: FetchRedactedFramesOptions): Promise<readonly ScreenpipeFrameRow[]> {
		const { sinceFrameId, limit } = options;
		if (!Number.isSafeInteger(sinceFrameId) || sinceFrameId < 0)
			throw new Error("sinceFrameId must be a non-negative integer");
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000)
			throw new Error("limit must be a positive integer no greater than 10000");

		const query = buildRedactedFramesQuery(sinceFrameId, limit);
		const response = await this.#fetchImpl(`${this.#baseUrl}/raw_sql`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query }),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`screenpipe /raw_sql returned ${response.status}: ${body.slice(0, 500)}`);
		}
		const payload: unknown = await response.json();
		if (!Array.isArray(payload)) throw new Error("screenpipe /raw_sql returned a non-array payload");
		return payload.map(parseFrameRow).filter((row): row is ScreenpipeFrameRow => row !== undefined);
	}
}

function buildRedactedFramesQuery(sinceFrameId: number, limit: number): string {
	return `
		SELECT
			id, timestamp, device_name, app_name, window_name, browser_url, focused,
			snapshot_path, content_hash,
			full_text_redacted_at, accessibility_redacted_at, accessibility_tree_redacted_at,
			window_name_redacted_at, browser_url_redacted_at, text_json_redacted_at,
			image_redacted_at, image_redaction_version,
			CASE WHEN full_text IS NOT NULL AND full_text != '' THEN 1 ELSE 0 END AS has_full_text,
			CASE WHEN accessibility_text IS NOT NULL AND accessibility_text != '' THEN 1 ELSE 0 END AS has_accessibility_text,
			CASE WHEN accessibility_tree_json IS NOT NULL AND accessibility_tree_json != '' THEN 1 ELSE 0 END AS has_accessibility_tree,
			CASE WHEN text_json IS NOT NULL AND text_json != '' THEN 1 ELSE 0 END AS has_text_json
		FROM frames
		WHERE id > ${sinceFrameId}
			AND (full_text IS NULL OR full_text = '' OR full_text_redacted_at IS NOT NULL)
			AND (accessibility_text IS NULL OR accessibility_text = '' OR accessibility_redacted_at IS NOT NULL)
			AND (accessibility_tree_json IS NULL OR accessibility_tree_json = '' OR accessibility_tree_redacted_at IS NOT NULL)
			AND (window_name IS NULL OR window_name = '' OR window_name_redacted_at IS NOT NULL)
			AND (browser_url IS NULL OR browser_url = '' OR browser_url_redacted_at IS NOT NULL)
			AND (text_json IS NULL OR text_json = '' OR text_json_redacted_at IS NOT NULL)
			AND (snapshot_path IS NULL OR image_redacted_at IS NOT NULL)
		ORDER BY id ASC
		LIMIT ${limit}
	`.trim();
}

/** Re-validates the redaction gates the SQL WHERE clause already applied; drops any row that fails. */
function parseFrameRow(value: unknown): ScreenpipeFrameRow | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const row = value as Record<string, unknown>;
	if (typeof row.id !== "number" || typeof row.timestamp !== "string" || typeof row.device_name !== "string")
		return undefined;
	if (!Number.isFinite(Date.parse(row.timestamp))) return undefined;

	const hasFullText = row.has_full_text === 1;
	const hasAccessibilityText = row.has_accessibility_text === 1;
	const hasAccessibilityTree = row.has_accessibility_tree === 1;
	const hasTextJson = row.has_text_json === 1;
	const snapshotPath = typeof row.snapshot_path === "string" ? row.snapshot_path : null;

	if (hasFullText && typeof row.full_text_redacted_at !== "number") return undefined;
	if (hasAccessibilityText && typeof row.accessibility_redacted_at !== "number") return undefined;
	if (hasAccessibilityTree && typeof row.accessibility_tree_redacted_at !== "number") return undefined;
	if (hasTextJson && typeof row.text_json_redacted_at !== "number") return undefined;
	if (typeof row.window_name === "string" && row.window_name !== "" && typeof row.window_name_redacted_at !== "number")
		return undefined;
	if (typeof row.browser_url === "string" && row.browser_url !== "" && typeof row.browser_url_redacted_at !== "number")
		return undefined;
	if (snapshotPath !== null && typeof row.image_redacted_at !== "number") return undefined;

	return {
		id: row.id,
		timestamp: row.timestamp,
		device_name: row.device_name,
		app_name: typeof row.app_name === "string" ? row.app_name : null,
		window_name: typeof row.window_name === "string" ? row.window_name : null,
		browser_url: typeof row.browser_url === "string" ? row.browser_url : null,
		focused: typeof row.focused === "number" ? row.focused : null,
		snapshot_path: snapshotPath,
		content_hash: typeof row.content_hash === "number" ? row.content_hash : null,
		full_text_redacted_at: typeof row.full_text_redacted_at === "number" ? row.full_text_redacted_at : null,
		accessibility_redacted_at:
			typeof row.accessibility_redacted_at === "number" ? row.accessibility_redacted_at : null,
		accessibility_tree_redacted_at:
			typeof row.accessibility_tree_redacted_at === "number" ? row.accessibility_tree_redacted_at : null,
		window_name_redacted_at: typeof row.window_name_redacted_at === "number" ? row.window_name_redacted_at : null,
		browser_url_redacted_at: typeof row.browser_url_redacted_at === "number" ? row.browser_url_redacted_at : null,
		text_json_redacted_at: typeof row.text_json_redacted_at === "number" ? row.text_json_redacted_at : null,
		image_redacted_at: typeof row.image_redacted_at === "number" ? row.image_redacted_at : null,
		image_redaction_version: typeof row.image_redaction_version === "number" ? row.image_redaction_version : null,
		has_full_text: hasFullText ? 1 : 0,
		has_accessibility_text: hasAccessibilityText ? 1 : 0,
		has_accessibility_tree: hasAccessibilityTree ? 1 : 0,
		has_text_json: hasTextJson ? 1 : 0,
	};
}
