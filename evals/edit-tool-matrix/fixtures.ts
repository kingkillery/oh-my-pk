import * as path from "node:path";
import {
	computeFileHash,
	formatHashlineHeader,
	formatNumberedLines,
	InMemoryFilesystem,
	InMemorySnapshotStore,
} from "@pk-nerdsaver-ai/hashline";
import type { Context, ToolCall, ToolResultMessage, UserMessage } from "@pk-nerdsaver-ai/pi-ai";

export const MATRIX_CWD = "/repo";

export interface MatrixCase {
	id: string;
	title: string;
	instruction: string;
	files: Record<string, string>;
	/**
	 * Golden hashline patch template using `{{TAG:relPath}}` placeholders so
	 * offline tests can verify solvability against exact runtime `computeFileHash` tags.
	 */
	goldenPatchTemplate: string;
	/**
	 * Expected final in-memory filesystem map (`relPath -> content`) after applying the edit.
	 */
	expectedFiles: Record<string, string>;
}

export interface MaterializedCase {
	id: string;
	fs: InMemoryFilesystem;
	snapshots: InMemorySnapshotStore;
	tags: Record<string, string>;
	readOutputs: Record<string, string>;
	goldenPatch: string;
}
export function resolveVirtualPath(relPath: string): string {
	return path.resolve(MATRIX_CWD, relPath);
}

export function materializeCase(testCase: MatrixCase): MaterializedCase {
	const fs = new InMemoryFilesystem();
	const snapshots = new InMemorySnapshotStore();
	const tags: Record<string, string> = {};
	const readOutputs: Record<string, string> = {};

	for (const [relPath, content] of Object.entries(testCase.files)) {
		const absPath = resolveVirtualPath(relPath);
		fs.set(absPath, content);
		const lineCount = content.split("\n").length;
		const seenLines = Array.from({ length: lineCount }, (_, idx) => idx + 1);
		const tag = snapshots.record(absPath, content, seenLines);
		tags[relPath] = tag;
		readOutputs[relPath] = `${formatHashlineHeader(relPath, tag)}\n${formatNumberedLines(content)}`;
	}

	let goldenPatch = testCase.goldenPatchTemplate;
	for (const [relPath, tag] of Object.entries(tags)) {
		goldenPatch = goldenPatch.replaceAll(`{{TAG:${relPath}}}`, tag);
	}

	return {
		id: testCase.id,
		fs,
		snapshots,
		tags,
		readOutputs,
		goldenPatch,
	};
}

export function buildSeededContext(testCase: MatrixCase, systemPrompt: string): Context {
	const mat = materializeCase(testCase);
	const filePaths = Object.keys(testCase.files);
	const now = Date.now();

	const readCalls: ToolCall[] = filePaths.map((relPath, idx) => ({
		type: "toolCall",
		id: `read_${testCase.id}_${idx + 1}`,
		name: "read",
		arguments: { path: relPath, i: `Reading ${relPath}` },
	}));

	const readResults: ToolResultMessage[] = filePaths.map((relPath, idx) => ({
		role: "toolResult",
		toolCallId: `read_${testCase.id}_${idx + 1}`,
		toolName: "read",
		content: [{ type: "text", text: mat.readOutputs[relPath] ?? "" }],
		isError: false,
		timestamp: now + idx + 1,
	}));

	const userMsg: UserMessage = {
		role: "user",
		content: testCase.instruction,
		timestamp: now,
	};

	return {
		systemPrompt,
		messages: [
			userMsg,
			{
				role: "assistant",
				content: readCalls,
				api: "anthropic-messages",
				provider: "anthropic",
				model: "seed",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: now + 1,
			},
			...readResults,
		],
	};
}
