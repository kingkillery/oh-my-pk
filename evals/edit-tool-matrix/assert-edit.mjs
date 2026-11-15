import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSERT_TS = path.join(__dirname, "assert-edit.ts");

export default async function assertEdit(output, context) {
	const caseId = context?.vars?.caseId;
	if (!caseId) {
		return { pass: false, score: 0, reason: "Missing context.vars.caseId" };
	}
	const bunBin = process.env.BUN_BIN || "bun";
	const { stdout } = await execFileAsync(bunBin, ["run", ASSERT_TS], {
		cwd: path.resolve(__dirname, "../.."),
		env: { ...process.env, EDIT_MATRIX_PAYLOAD: JSON.stringify({ output, caseId }) },
		maxBuffer: 10 * 1024 * 1024,
	});
	return JSON.parse(stdout);
}
