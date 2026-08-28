import { USER_AGENT } from "@pk-nerdsaver-ai/pi-utils";

const OPENROUTER_APP_TITLE = APP_NAME.replace(/\b\w/g, character => character.toUpperCase()).replace(/Pk$/, "PK");

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": USER_AGENT,
		"HTTP-Referer": "https://omp.sh/",
		"X-OpenRouter-Title": "omp",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
