import * as path from "node:path";
import { isFsMissing } from "@pk-nerdsaver-ai/pi-utils";
import type { PluginManifest } from "./types";

export interface PluginPackageJson {
	name?: string;
	version: string;
	description?: string;
	omp?: PluginManifest;
	pi?: PluginManifest;
}

interface CodexPluginJson {
	name?: unknown;
	version?: unknown;
	description?: unknown;
}

interface PartialPluginManifest extends Omit<PluginManifest, "version"> {
	version?: string;
}

function normalizeCodexPluginManifest(raw: CodexPluginJson): PartialPluginManifest | null {
	const name = typeof raw.name === "string" && raw.name.trim() ? raw.name : undefined;
	const version = typeof raw.version === "string" && raw.version.trim() ? raw.version : undefined;
	const description = typeof raw.description === "string" && raw.description.trim() ? raw.description : undefined;
	if (!name && !version && !description) return null;
	return {
		...(name !== undefined && { name }),
		...(version !== undefined && { version }),
		...(description !== undefined && { description }),
	};
}

export async function readCodexPluginManifest(pluginPath: string): Promise<PartialPluginManifest | null> {
	const manifestPath = path.join(pluginPath, ".codex-plugin", "plugin.json");
	try {
		const raw = (await Bun.file(manifestPath).json()) as CodexPluginJson;
		return normalizeCodexPluginManifest(raw);
	} catch (err) {
		if (isFsMissing(err, manifestPath)) return null;
		throw err;
	}
}

export async function readSupportedPluginManifest(
	pluginPath: string,
	pkg: PluginPackageJson,
): Promise<PluginManifest | null> {
	const manifest = pkg.omp ?? pkg.pi ?? (await readCodexPluginManifest(pluginPath));
	if (!manifest) return null;
	return { ...manifest, version: pkg.version };
}

export async function readPluginManifestOrFallback(
	pluginPath: string,
	pkg: PluginPackageJson,
): Promise<PluginManifest> {
	return (await readSupportedPluginManifest(pluginPath, pkg)) ?? { version: pkg.version };
}
