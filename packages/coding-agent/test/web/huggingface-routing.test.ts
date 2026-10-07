import { describe, expect, it } from "bun:test";
import { handleHuggingFace, parseHuggingFaceUrl } from "../../src/web/scrapers/huggingface";

describe("Hugging Face file URL routing", () => {
	it("retains model, dataset, space and user landing-page handling", () => {
		for (const [path, type, id] of [
			["org/model", "model", "org/model"],
			["spaces/org/app/", "space", "org/app"],
			["datasets/org/data", "dataset", "org/data"],
			["datasets/data", "dataset", "data"],
			["user", "model_or_user", "user"],
		] as const)
			expect(parseHuggingFaceUrl(`https://huggingface.co/${path}`)).toEqual({ type, id });
	});
	it("declines file and revision paths so generic fetching preserves the original URL", async () => {
		for (const repo of ["org/model", "spaces/org/app", "datasets/org/data", "datasets/data"]) {
			for (const route of ["raw", "resolve", "blob", "tree"]) {
				const url = `https://huggingface.co/${repo}/${route}/revision-123/src/file.txt?download=true`;
				expect(await handleHuggingFace(url, 1)).toBeNull();
			}
		}
	});
});
