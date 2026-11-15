import { Patch, Patcher } from "@pk-nerdsaver-ai/hashline";
import type { Tool, ToolCall } from "@pk-nerdsaver-ai/pi-ai";
import { validateToolArguments } from "@pk-nerdsaver-ai/pi-ai/utils/validation";
import { nativeBlockResolver } from "../../packages/coding-agent/src/edit/hashline/block-resolver.ts";
import { hashlineEditParamsSchema } from "../../packages/coding-agent/src/edit/hashline/params.ts";
import { getCaseById } from "./cases.ts";
import { MATRIX_CWD, materializeCase, resolveVirtualPath } from "./fixtures.ts";
import type { WorkerResponse } from "./worker.ts";

export interface GradeStageResult {
	pass: boolean;
	score: number;
	reason: string;
	stage: "tool-call" | "wire-validation" | "hashline-parse" | "hashline-apply";
}

const RAW_EDIT_TOOL: Tool = {
	name: "edit",
	description: "hashline edit",
	parameters: hashlineEditParamsSchema,
};

export async function gradeEditResponse(rawOutput: string, caseId: string): Promise<GradeStageResult> {
	let parsed: WorkerResponse;
	try {
		parsed = JSON.parse(rawOutput) as WorkerResponse;
	} catch (err) {
		return {
			pass: false,
			score: 0,
			stage: "tool-call",
			reason: `Invalid worker JSON output: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	if (parsed.stopReason === "error" || parsed.errorMessage) {
		return {
			pass: false,
			score: 0,
			stage: "tool-call",
			reason: `Provider error (${parsed.stopReason}): ${parsed.errorMessage ?? "unknown error"}`,
		};
	}

	// Stage 1: Tool call emitted
	const firstCall: ToolCall | undefined = parsed.toolCalls?.[0];
	if (!firstCall) {
		return {
			pass: false,
			score: 0,
			stage: "tool-call",
			reason: `Expected \`edit\` tool call, got text-only response: ${parsed.text.slice(0, 160)}`,
		};
	}
	if (firstCall.name !== "edit") {
		return {
			pass: false,
			score: 0,
			stage: "tool-call",
			reason: `Expected \`edit\` tool call, got \`${firstCall.name}\``,
		};
	}

	// Stage 2: Wire & intent contract
	const rawArgs = (firstCall.arguments ?? {}) as Record<string, unknown>;
	if ("_input" in rawArgs) {
		return {
			pass: false,
			score: 0.25,
			stage: "wire-validation",
			reason: "Model emitted `_input` despite canonical wire schema",
		};
	}
	if (typeof rawArgs.i !== "string" || rawArgs.i.trim().length === 0) {
		return {
			pass: false,
			score: 0.25,
			stage: "wire-validation",
			reason: "Missing required non-empty intent field `i`",
		};
	}

	const { i: _intent, ...strippedArgs } = rawArgs;
	let validatedInput: string;
	try {
		const validated = validateToolArguments(RAW_EDIT_TOOL, {
			...firstCall,
			arguments: strippedArgs,
		}) as { input: string };
		validatedInput = validated.input;
	} catch (err) {
		return {
			pass: false,
			score: 0.25,
			stage: "wire-validation",
			reason: err instanceof Error ? err.message : String(err),
		};
	}

	// Stage 3: Real @pk-nerdsaver-ai/hashline parse
	let patch: Patch;
	try {
		patch = Patch.parse(validatedInput, { cwd: MATRIX_CWD });
		if (patch.sections.length === 0) {
			throw new Error("Patch parsed 0 sections");
		}
		for (const section of patch.sections) {
			section.parse();
		}
	} catch (err) {
		return {
			pass: false,
			score: 0.5,
			stage: "hashline-parse",
			reason: `Hashline parse failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}

	// Stage 4: Real in-memory Patcher apply + semantic output check
	const testCase = getCaseById(caseId);
	const mat = materializeCase(testCase);
	try {
		const patcher = new Patcher({
			fs: mat.fs,
			snapshots: mat.snapshots,
			blockResolver: nativeBlockResolver,
		});
		await patcher.apply(patch);
	} catch (err) {
		return {
			pass: false,
			score: 0.75,
			stage: "hashline-apply",
			reason: `Patcher.apply failed: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	for (const [relPath, expectedContent] of Object.entries(testCase.expectedFiles)) {
		const absPath = resolveVirtualPath(relPath);
		const actual = mat.fs.get(absPath) ?? mat.fs.get(relPath);
		if (actual === undefined) {
			return {
				pass: false,
				score: 0.75,
				stage: "hashline-apply",
				reason: `Expected file missing after edit: ${relPath}`,
			};
		}
		if (actual.replaceAll("\r\n", "\n") !== expectedContent.replaceAll("\r\n", "\n")) {
			return {
				pass: false,
				score: 0.75,
				stage: "hashline-apply",
				reason: `Content mismatch for ${relPath}.\nExpected:\n${expectedContent}\nActual:\n${actual}`,
			};
		}
	}
	// Ensure files that were moved/removed in expectedFiles are no longer present
	for (const oldRelPath of Object.keys(testCase.files)) {
		if (!(oldRelPath in testCase.expectedFiles)) {
			const stillThere = mat.fs.get(resolveVirtualPath(oldRelPath)) ?? mat.fs.get(oldRelPath);
			if (stillThere !== undefined) {
				return {
					pass: false,
					score: 0.75,
					stage: "hashline-apply",
					reason: `Source file ${oldRelPath} was expected to be moved/removed but still exists`,
				};
			}
		}
	}

	return {
		pass: true,
		score: 1,
		stage: "hashline-apply",
		reason: "All 4 stages passed (edit tool call, wire/intent validation, hashline parse, in-memory apply)",
	};
}

if (import.meta.main) {
	const raw = process.env.EDIT_MATRIX_PAYLOAD ?? (await Bun.stdin.text());
	const { output, caseId } = JSON.parse(raw) as { output: string; caseId: string };
	const result = await gradeEditResponse(output, caseId);
	process.stdout.write(JSON.stringify(result));
}
