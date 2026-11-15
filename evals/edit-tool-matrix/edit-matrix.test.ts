import { describe, expect, it } from "bun:test";
import { toolWireSchema } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { gradeEditResponse } from "./assert-edit.ts";
import { EDIT_MATRIX_CASES } from "./cases.ts";
import { materializeCase } from "./fixtures.ts";
import { buildRealEditTool, type WorkerResponse } from "./worker.ts";

function makeWorkerOutput(
	caseId: string,
	toolCalls: WorkerResponse["toolCalls"],
	text = "",
): string {
	const payload: WorkerResponse = {
		provider: "google-antigravity",
		modelId: "gemini-4-hydrogen-high",
		caseId,
		toolCalls,
		text,
		stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
	};
	return JSON.stringify(payload);
}

describe("evals/edit-tool-matrix offline contract", () => {
	it("buildRealEditTool emits required `input` and `i` without leaking `_input`", () => {
		const tool = buildRealEditTool();
		const wire = toolWireSchema(tool) as {
			properties?: Record<string, unknown>;
			required?: string[];
		};
		expect(Object.keys(wire.properties ?? {}).sort()).toEqual(["i", "input"]);
		expect((wire.required ?? []).sort()).toEqual(["i", "input"]);
	});

	for (const testCase of EDIT_MATRIX_CASES) {
		it(`golden patch passes all 4 grader stages for ${testCase.id}`, async () => {
			const mat = materializeCase(testCase);
			const out = makeWorkerOutput(testCase.id, [
				{
					type: "toolCall",
					id: "call-1",
					name: "edit",
					arguments: { i: `Applying ${testCase.id}`, input: mat.goldenPatch },
				},
			]);
			const grade = await gradeEditResponse(out, testCase.id);
			expect(grade.pass).toBe(true);
			expect(grade.score).toBe(1);
		});
	}

	it("rejects text-only, all-null, unparseable, and mismatched-tag payloads at the exact stage", async () => {
		const caseId = "bare-plus-blank-line";

		const textOnly = await gradeEditResponse(makeWorkerOutput(caseId, [], "I cannot edit."), caseId);
		expect(textOnly.pass).toBe(false);
		expect(textOnly.stage).toBe("tool-call");

		const allNull = await gradeEditResponse(
			makeWorkerOutput(caseId, [
				{ type: "toolCall", id: "c2", name: "edit", arguments: { i: "Edit", input: null, _input: null } },
			]),
			caseId,
		);
		expect(allNull.pass).toBe(false);
		expect(allNull.stage).toBe("wire-validation");

		const badSyntax = await gradeEditResponse(
			makeWorkerOutput(caseId, [
				{ type: "toolCall", id: "c3", name: "edit", arguments: { i: "Edit", input: "not a hashline patch" } },
			]),
			caseId,
		);
		expect(badSyntax.pass).toBe(false);
		expect(badSyntax.stage).toBe("hashline-parse");

		const staleTag = await gradeEditResponse(
			makeWorkerOutput(caseId, [
				{
					type: "toolCall",
					id: "c4",
					name: "edit",
					arguments: { i: "Edit", input: "[src/math.ts#0000]\nINS.POST 2:\n+" },
				},
			]),
			caseId,
		);
		expect(staleTag.pass).toBe(false);
		expect(staleTag.stage).toBe("hashline-apply");
	});
});
