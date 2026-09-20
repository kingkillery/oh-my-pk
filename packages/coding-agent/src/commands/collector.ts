/**
 * Configure and inspect the tool-issue collector.
 *
 * The collector is the optional service that ingests recorded reports,
 * deduplicates them, ranks by impact, and files GitHub issues. It runs either
 * as a local OMPK extension (`local`) or as a helper on a machine you control
 * (`remote`). `serve`/`pair-info`/`token` are the host-side half; `pair` and
 * `status` are the client-side half.
 */
import { APP_NAME, getProjectDir } from "@pk-nerdsaver-ai/pi-utils";
import { Args, Command, Flags } from "@pk-nerdsaver-ai/pi-utils/cli";
import {
	ensureLocalCollector,
	findCollectorBinary,
	localCollectorUrl,
	probeRemoteCollector,
	resolveCollectorMode,
	stopLocalCollector,
} from "../autoqa/collector-control";
import { Settings } from "../config/settings";

export default class Collector extends Command {
	static description = "Configure the tool-issue collector (local extension or a helper you host)";

	static args = {
		action: Args.string({
			description: "status (default), pair, or serve",
			required: false,
			options: ["status", "pair", "serve"],
			default: "status",
		}),
		url: Args.string({ description: "Collector ingest URL (pair)", required: false }),
		token: Args.string({ description: "Collector bearer token (pair)", required: false }),
	};

	static flags = {
		"remote-url": Flags.string({ description: "Set the remote collector URL without probing (pair)" }),
		"remote-token": Flags.string({ description: "Set the remote collector token (pair)" }),
		"set-mode": Flags.string({
			description: "Set collector mode directly: off, local, or remote",
			options: ["off", "local", "remote"],
		}),
		port: Flags.integer({ description: "Local collector port (serve/status)", default: 8791 }),
		json: Flags.boolean({ char: "j", description: "Output as JSON", default: false }),
	};

	static examples = [
		`${APP_NAME} collector status`,
		`${APP_NAME} collector pair http://100.64.0.1:8791/v1/grievances <token>`,
		`${APP_NAME} collector --set-mode local`,
		`${APP_NAME} collector serve --port 8791   # on the host machine`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Collector);
		// Commands run before any session exists, so the settings singleton has
		// to be initialized here (same pattern as the other CLI-backed commands).
		const settings = await Settings.init({ cwd: getProjectDir() });

		if (args.action === "pair") {
			await this.#pair(settings, args.url, args.token, flags["remote-url"], flags["remote-token"], flags.json);
			return;
		}
		if (args.action === "serve") {
			await this.#serve(flags.port);
			return;
		}
		await this.#status(settings, flags.port, flags["set-mode"], flags.json);
	}

	/** `pair` — probe a collector, then persist URL + token + mode. */
	async #pair(
		settings: Settings,
		urlArg: string | undefined,
		tokenArg: string | undefined,
		urlFlag: string | undefined,
		tokenFlag: string | undefined,
		json: boolean,
	): Promise<void> {
		const url = (urlArg ?? urlFlag ?? settings.get("dev.autoqa.collector.remoteUrl") ?? "").trim();
		const token = (tokenArg ?? tokenFlag ?? settings.get("dev.autoqa.collector.remoteToken") ?? "").trim();
		if (!url || !token) {
			console.error(
				"Both a collector URL and token are required. Get them from `ompk-collector pair-info` on the host.",
			);
			process.exitCode = 1;
			return;
		}
		const probe = await probeRemoteCollector(url, token);
		if (!probe.ok) {
			const message = `Collector unreachable at ${url}: ${probe.error}`;
			if (json) console.log(JSON.stringify({ ok: false, url, error: probe.error }));
			else console.error(message);
			process.exitCode = 1;
			return;
		}
		settings.set("dev.autoqa.collector.remoteUrl", url);
		settings.set("dev.autoqa.collector.remoteToken", token);
		settings.set("dev.autoqa.collector.mode", "remote");
		await settings.flush?.();
		if (json)
			console.log(JSON.stringify({ ok: true, mode: "remote", url, reports: probe.reports, groups: probe.groups }));
		else
			console.log(
				`Paired. Mode=remote\n  URL:   ${url}\n  Host reports: ${probe.reports}  groups: ${probe.groups}\nReports now ship to this collector.`,
			);
	}

	/** `serve` — run the collector binary in the foreground (host machine). */
	async #serve(port: number): Promise<void> {
		const binary = findCollectorBinary(Settings.instance.get("dev.autoqa.collector.binaryPath"));
		if (!binary) {
			console.error("ompk-collector binary not found. Install it, or set dev.autoqa.collector.binaryPath.");
			process.exitCode = 1;
			return;
		}
		const proc = Bun.spawn([binary, "serve", "--port", String(port)], {
			stdout: "inherit",
			stderr: "inherit",
			stdin: "inherit",
		});
		// Forward Ctrl+C to the child so the collector shuts its listener down.
		process.on("SIGINT", () => proc.kill());
		const code = await proc.exited;
		stopLocalCollector();
		process.exitCode = code ?? 0;
	}

	/** `status` — show mode, target, and reachability. */
	async #status(settings: Settings, port: number, setMode: string | undefined, json: boolean): Promise<void> {
		if (setMode === "off" || setMode === "local" || setMode === "remote") {
			settings.set("dev.autoqa.collector.mode", setMode);
			await settings.flush?.();
		}
		const mode = resolveCollectorMode(settings);
		const url = settings.get("dev.autoqa.collector.remoteUrl")?.trim() ?? "";
		const token = settings.get("dev.autoqa.collector.remoteToken")?.trim() ?? "";
		const localUrl = localCollectorUrl(port);
		let reachable: boolean | null = null;
		let detail = "";
		if (mode === "remote") {
			const probe = await probeRemoteCollector(url, token);
			reachable = probe.ok;
			detail = probe.ok ? `${probe.reports} reports, ${probe.groups} groups` : probe.error;
		} else if (mode === "local") {
			// Actually start the extension (idempotent) so status reflects the
			// real discovery path: sibling-of-binary / PATH lookup + spawn.
			const started = await ensureLocalCollector(settings);
			reachable = started;
			detail = started ? "local extension answering" : "helper not found or failed to start";
		}
		if (json) {
			console.log(JSON.stringify({ mode, remoteUrl: url || null, localUrl, reachable, detail }));
			return;
		}
		console.log(`Collector mode: ${mode}`);
		if (mode === "remote")
			console.log(`  Target: ${url || "(not configured — run `omp collector pair <url> <token>`)"}`);
		if (mode === "local") console.log(`  Target: ${localUrl}`);
		if (reachable !== null) console.log(`  ${reachable ? "Reachable" : "Unreachable"}: ${detail}`);
		if (mode === "off")
			console.log("  Reports are recorded locally only. Enable with `omp collector --set-mode local`.");
	}
}
