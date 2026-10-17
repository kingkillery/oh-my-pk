import * as fs from "node:fs/promises";
import * as path from "node:path";

export function sha256(bytes: string | Uint8Array): string {
	return new Bun.SHA256().update(bytes).digest("hex");
}

export function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function inProject(cwd: string, roots: readonly string[]): boolean {
	return roots.some(root => {
		const relative = path.relative(canonicalPath(root), canonicalPath(cwd));
		return (
			relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
		);
	});
}

/** Read a bounded snapshot, preserving newline bytes, blank lines and invalid JSON. */
export async function* readRecords(
	filePath: string,
	size: number,
): AsyncGenerator<{ bytes: Uint8Array<ArrayBuffer>; offset: number }> {
	const file = await fs.open(filePath, "r");
	let offset = 0;
	let position = 0;
	let pending: Uint8Array<ArrayBuffer>[] = [];
	let length = 0;
	try {
		while (position < size) {
			// Scope checks only need the first record; avoid reading 256 KiB per unrelated session.
			const buffer = new Uint8Array(Math.min(offset === 0 ? 4096 : 256 * 1024, size - position));
			const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
			if (!bytesRead) throw new Error(`Session changed while reading: ${filePath}`);
			position += bytesRead;
			let start = 0;
			for (let i = 0; i < bytesRead; i++) {
				if (buffer[i] !== 10) continue;
				const part = buffer.subarray(start, i + 1);
				pending.push(part);
				length += part.length;
				const bytes = new Uint8Array(length);
				let cursor = 0;
				for (const chunk of pending) {
					bytes.set(chunk, cursor);
					cursor += chunk.length;
				}
				yield { bytes, offset };
				offset += length;
				start = i + 1;
				pending = [];
				length = 0;
			}
			if (start < bytesRead) {
				const part = buffer.subarray(start, bytesRead);
				pending.push(part);
				length += part.length;
			}
		}
		if (length) {
			const bytes = new Uint8Array(length);
			let cursor = 0;
			for (const chunk of pending) {
				bytes.set(chunk, cursor);
				cursor += chunk.length;
			}
			yield { bytes, offset };
		}
	} finally {
		await file.close();
	}
}

export function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function parseRecord(bytes: Uint8Array): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ""));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? object(value) : null;
	} catch {
		return null;
	}
}

function isImagePayload(value: Record<string, unknown>): boolean {
	return (
		value.type === "image" ||
		(typeof value.mimeType === "string" && value.mimeType.toLowerCase().startsWith("image/"))
	);
}

/** Index textual evidence and tool arguments, excluding encoded image payloads/signatures. */
export function recordText(value: unknown, key = ""): string {
	const pending = [{ value, key }];
	const text: string[] = [];
	const excluded = new Set(["image_url", "thinkingSignature", "thoughtSignature", "textSignature"]);
	while (pending.length) {
		const current = pending.pop();
		if (!current) continue;
		if (typeof current.value === "string") {
			if (!excluded.has(current.key) && current.value) text.push(current.value);
		} else if (Array.isArray(current.value)) {
			for (let i = current.value.length - 1; i >= 0; i--)
				pending.push({ value: current.value[i], key: current.key });
		} else if (current.value !== null && typeof current.value === "object") {
			const entries = Object.entries(current.value);
			const image = isImagePayload(object(current.value));
			for (let i = entries.length - 1; i >= 0; i--) {
				if (image && entries[i][0] === "data") continue;
				pending.push({ value: entries[i][1], key: entries[i][0] });
			}
		}
	}
	return text.join("\n");
}

export function excerpt(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 320);
}

/** Only persisted image fields are dependencies; quoted example refs are ordinary text. */
export function blobReferences(parsed: Record<string, unknown> | null, rawText = ""): string[] {
	if (!parsed) return [...new Set([...rawText.matchAll(/blob:sha256:([a-f0-9]{64})/g)].map(match => match[1]))];
	const hashes = new Set<string>();
	const pending: unknown[] = [parsed];
	const add = (value: unknown) => {
		if (typeof value !== "string") return;
		const match = /^blob:sha256:([a-f0-9]{64})$/.exec(value);
		if (match) hashes.add(match[1]);
	};
	while (pending.length) {
		const value = pending.pop();
		if (Array.isArray(value)) {
			for (const child of value) pending.push(child);
		} else if (value !== null && typeof value === "object") {
			const entry = object(value);
			if (isImagePayload(entry)) add(entry.data);
			add(entry.image_url);
			for (const child of Object.values(entry)) if (child !== null && typeof child === "object") pending.push(child);
		}
	}
	return [...hashes];
}
