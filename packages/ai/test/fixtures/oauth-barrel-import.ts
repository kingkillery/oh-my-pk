import {
	AnthropicOAuthFlow as RootAnthropicOAuthFlow,
	loginAnthropic as rootLoginAnthropic,
	refreshAnthropicToken as rootRefreshAnthropicToken,
} from "@pk-nerdsaver-ai/pi-ai";
import {
	AnthropicOAuthFlow as OAuthAnthropicOAuthFlow,
	loginAnthropic as oauthLoginAnthropic,
	refreshAnthropicToken as oauthRefreshAnthropicToken,
} from "@pk-nerdsaver-ai/pi-ai/registry/oauth";
import "@pk-nerdsaver-ai/pi-ai/providers/anthropic";
import "@pk-nerdsaver-ai/pi-ai/auth-storage";

const publicExports = [
	RootAnthropicOAuthFlow,
	rootLoginAnthropic,
	rootRefreshAnthropicToken,
	OAuthAnthropicOAuthFlow,
	oauthLoginAnthropic,
	oauthRefreshAnthropicToken,
];

if (publicExports.some(value => !value)) {
	throw new Error("Anthropic OAuth exports are unavailable");
}
