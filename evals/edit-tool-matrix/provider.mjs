import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "worker.ts");

export default class PiAiEditMatrixProvider {
	constructor(options = {}) {
		this.provider = options.config?.provider ?? "google-antigravity";
		this.modelId = options.config?.modelId ?? "gemini-3.6-flash-high";
		this.temperature = options.config?.temperature ?? 0;
		this.maxTokens = options.config?.maxTokens ?? 2048;
	}

	id() {
		return `pi-ai:${this.provider}:${this.modelId}`;
	}

	async callApi(_prompt, context) {
		const caseId = context?.vars?.caseId;
		if (!caseId) {
			return { error: "Missing context.vars.caseId" };
		}

		const payload = JSON.stringify({
			provider: this.provider,
			modelId: this.modelId,
			caseId,
			temperature: this.temperature,
			maxTokens: this.maxTokens,
		});

		try {
			const bunBin = process.env.BUN_BIN || "bun";
			const { stdout } = await execFileAsync(bunBin, ["run", WORKER_PATH], {
				cwd: path.resolve(__dirname, "../.."),
				env: { ...process.env, EDIT_MATRIX_PAYLOAD: payload },
				maxBuffer: 10 * 1024 * 1024,
			});
			const parsed = JSON.parse(stdout);
			const usage = parsed.usage ?? {};
			return {
				output: stdout,
				tokenUsage: {
					total: usage.totalTokens ?? 0,
					prompt: usage.input ?? 0,
					completion: usage.output ?? 0,
				},
			};
		} catch (err) {
			return {
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
}
