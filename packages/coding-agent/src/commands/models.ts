/**
 * List, search, refresh, and add custom model endpoints.
 */
import { APP_NAME } from "@pk-nerdsaver-ai/pi-utils";
import { Args, Command, Flags } from "@pk-nerdsaver-ai/pi-utils/cli";
import { parseAuthFlag, parseCustomProviderApi, resolveModelsArgs, runModelsCommand } from "../cli/models-cli";
import { CUSTOM_PROVIDER_APIS } from "../slash-commands/helpers/inference-provider";

export default class Models extends Command {
	static description = "List, search, refresh, and add custom model endpoints";

	static args = {
		action: Args.string({
			description: "ls (default) | find | refresh | canonical | add | <provider>",
			required: false,
		}),
		pattern: Args.string({
			description: "Filter/search substring, or provider name (required for find)",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		extension: Flags.string({
			char: "e",
			description: "Load an extension file before listing (repeatable)",
			multiple: true,
		}),
		"no-extensions": Flags.boolean({
			description: "Disable extension discovery (explicit -e paths still work)",
		}),
		config: Flags.string({
			description: "Load an extra config.yml-style overlay for this run (repeatable)",
			multiple: true,
		}),
		provider: Flags.string({ description: "Custom provider id (required for add)" }),
		"base-url": Flags.string({
			description: "OpenAI-compatible base URL (required for add; bare hosts get http:// and /v1)",
		}),
		model: Flags.string({ description: "Model id served by the endpoint (required for add)" }),
		"api-key": Flags.string({ description: "Env var name holding the API key (omit with --auth none)" }),
		auth: Flags.string({
			description: "apiKey (default when --api-key is set) or none",
			options: ["apiKey", "none"],
		}),
		api: Flags.string({
			description: "API adapter (default openai-completions)",
			options: [...CUSTOM_PROVIDER_APIS],
		}),
		"context-window": Flags.integer({ description: "Context window for the added model" }),
		"max-tokens": Flags.integer({ description: "Max output tokens for the added model" }),
		replace: Flags.boolean({ description: "Replace an existing custom provider id" }),
	};

	static examples = [
		`# List every available model, grouped by provider\n  ${APP_NAME} models`,
		`# List one provider's models (any provider name works)\n  ${APP_NAME} models openai-codex`,
		`# Find models by substring\n  ${APP_NAME} models find minimax`,
		`# Force a fresh catalog fetch (replaces rm -rf ~/.ompk/models.db)\n  ${APP_NAME} models refresh`,
		`# Show the coalesced canonical model view\n  ${APP_NAME} models canonical`,
		`# Machine-readable output\n  ${APP_NAME} models --json`,
		`# Register a keyless OpenAI-compatible endpoint\n  ${APP_NAME} models add --provider tailscale --base-url http://100.69.212.61:8000/v1 --model gemma --auth none`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Models);
		const { action, pattern } = resolveModelsArgs(args.action, args.pattern);
		await runModelsCommand({
			action,
			pattern,
			flags: {
				json: flags.json,
				extensions: flags.extension,
				noExtensions: flags["no-extensions"],
				config: flags.config,
				provider: flags.provider,
				baseUrl: flags["base-url"],
				model: flags.model,
				apiKey: flags["api-key"],
				auth: parseAuthFlag(flags.auth),
				api: parseCustomProviderApi(flags.api),
				contextWindow: flags["context-window"],
				maxTokens: flags["max-tokens"],
				replace: flags.replace,
			},
		});
	}
}
