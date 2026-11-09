/**
 * Minimax Code (minimax m plan) login flow.
 *
 * MiniMax M Plan is a subscription service that provides access to
 * MiniMax text models through an OpenAI-compatible API.
 *
 * This is not OAuth - it's a simple API key flow:
 * 1. Open browser to the matching regional MiniMax subscription page
 * 2. User subscribes and copies their API key
 * 3. User pastes the API key back into the CLI
 *
 * International: https://api.minimax.io/v1
 * China: https://api.minimaxi.com/v1
 */

import { createApiKeyLogin } from "../api-key-login";

const AUTH_URL_INTL = "https://platform.minimax.io/console/plan";
const AUTH_URL_CN = "https://platform.minimaxi.com/console/plan";
const API_BASE_URL_INTL = "https://api.minimax.io/v1";
const API_BASE_URL_CN = "https://api.minimaxi.com/v1";
const VALIDATION_MODEL = "MiniMax-M3.1-Flash";

function createMiniMaxLogin(authUrl: string, baseUrl: string, provider: string) {
	return createApiKeyLogin({
		providerLabel: provider,
		authUrl,
		instructions: "Subscribe to MiniMax M Plan and copy your M Plan API key",
		promptMessage: "Paste your MiniMax M Plan API key",
		placeholder: "sk-cp-...",
		validation: {
			kind: "chat-completions",
			provider,
			baseUrl,
			model: VALIDATION_MODEL,
		},
	});
}

/**
 * Login to Minimax Code (minimax m plan).
 *
 * Opens browser to subscription page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export const loginMiniMaxCode = createMiniMaxLogin(AUTH_URL_INTL, API_BASE_URL_INTL, "Minimax Code (minimax m plan)");

/**
 * Login to Minimax Code (minimax m plan) (China).
 *
 * Same flow as international but uses China endpoint.
 */
export const loginMiniMaxCodeCn = createMiniMaxLogin(
	AUTH_URL_CN,
	API_BASE_URL_CN,
	"Minimax Code (minimax m plan) (China)",
);
