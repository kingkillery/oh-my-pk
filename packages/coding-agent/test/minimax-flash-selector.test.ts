import { expect, test } from "bun:test";
import { Effort } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModels } from "@pk-nerdsaver-ai/pi-catalog/models";
import { resolveModelRoleValue } from "../src/config/model-resolver";

test("the MiniMax Flash default role resolves before asynchronous discovery", () => {
	const resolved = resolveModelRoleValue(
		"openrouter/minimax/minimax-m3.1-flash:medium",
		getBundledModels("openrouter"),
	);
	expect(resolved.model?.provider).toBe("openrouter");
	expect(resolved.model?.id).toBe("minimax/minimax-m3.1-flash");
	expect(resolved.thinkingLevel).toBe(Effort.Medium);
	expect(resolved.explicitThinkingLevel).toBe(true);
	expect(resolved.warning).toBeUndefined();
});
