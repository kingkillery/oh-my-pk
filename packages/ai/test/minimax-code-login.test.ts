import { describe, expect, it } from "bun:test";
import { minimaxCodeProvider } from "@pk-nerdsaver-ai/pi-ai/registry/minimax-code";
import { minimaxCodeCnProvider } from "@pk-nerdsaver-ai/pi-ai/registry/minimax-code-cn";
import { loginMiniMaxCode, loginMiniMaxCodeCn } from "@pk-nerdsaver-ai/pi-ai/registry/oauth/minimax-code";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";

describe("Minimax Code (minimax m plan) login", () => {
	it("opens the international platform and validates against the international API", async () => {
		const authUrls: string[] = [];
		const validationUrls: string[] = [];
		const validationModels: string[] = [];
		const prompts: string[] = [];

		const fetchMock: FetchImpl = async (input, init) => {
			validationUrls.push(String(input));
			validationModels.push(JSON.parse(String(init?.body)).model);
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		const apiKey = await loginMiniMaxCode({
			onAuth: info => authUrls.push(info.url),
			onPrompt: async prompt => {
				prompts.push(prompt.message);
				return "  sk-intl  ";
			},
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-intl");
		expect(authUrls).toEqual(["https://platform.minimax.io/console/plan"]);
		expect(validationUrls).toEqual(["https://api.minimax.io/v1/chat/completions"]);
		expect(validationModels).toEqual(["MiniMax-M3.1-Flash"]);
		expect(prompts).toEqual(["Paste your MiniMax M Plan API key"]);
	});

	it("opens the China platform and validates against the China API", async () => {
		const authUrls: string[] = [];
		const validationUrls: string[] = [];

		const fetchMock: FetchImpl = async input => {
			validationUrls.push(String(input));
			return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
		};

		const apiKey = await loginMiniMaxCodeCn({
			onAuth: info => authUrls.push(info.url),
			onPrompt: async () => "  sk-cn  ",
			fetch: fetchMock,
		});

		expect(apiKey).toBe("sk-cn");
		expect(authUrls).toEqual(["https://platform.minimaxi.com/console/plan"]);
		expect(validationUrls).toEqual(["https://api.minimaxi.com/v1/chat/completions"]);
	});

	it("renames both regions without changing credential identities", () => {
		expect(minimaxCodeProvider.name).toBe("Minimax Code (minimax m plan)");
		expect(minimaxCodeProvider.id).toBe("minimax-code");
		expect(minimaxCodeCnProvider.name).toBe("Minimax Code (minimax m plan) (China)");
		expect(minimaxCodeCnProvider.id).toBe("minimax-code-cn");
	});
});
