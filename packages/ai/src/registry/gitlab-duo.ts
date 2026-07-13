import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const gitlabDuoProvider = {
	id: "gitlab-duo",
	name: "GitLab Duo Non-Agentic",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginGitLabDuo } = await import("./oauth/gitlab-duo");
		return loginGitLabDuo(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshGitLabDuoToken } = await import("./oauth/gitlab-duo");
		return refreshGitLabDuoToken(credentials);
	},
	callbackPort: 8080,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;

/**
 * GitLab Duo Agent (Workflow) API — authenticated by `GITLAB_TOKEN` via the
 * catalog's `envVars`, not an interactive login. A minimal registry entry so it
 * satisfies the catalog-provider exhaustiveness check without an OAuth flow.
 */
export const gitlabDuoAgentProvider = {
	id: "gitlab-duo-agent",
	name: "GitLab Duo Agent",
} as const satisfies ProviderDefinition;
