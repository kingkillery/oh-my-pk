/** A public workspace and the versions present before the release bump. */
export interface ReleaseWorkspaceVersion {
	path: string;
	name: string;
	version: string;
	catalogVersion?: string;
}

interface Lockfile {
	workspaces: Record<string, { name?: string; version?: string }>;
	catalog: Record<string, string>;
	[key: string]: unknown;
}

function parseLockfile(text: string): Lockfile {
	const value: unknown = Bun.JSONC.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bun.lock object");
	const lock = value as Lockfile;
	if (!lock.workspaces || typeof lock.workspaces !== "object" || !lock.catalog || typeof lock.catalog !== "object") {
		throw new Error("bun.lock is missing workspaces or catalog");
	}
	return lock;
}

function escaped(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceOnce(text: string, pattern: RegExp, label: string, version: string): string {
	const matches = [...text.matchAll(pattern)];
	if (matches.length !== 1) throw new Error(`Expected exactly one ${label} in bun.lock; found ${matches.length}`);
	return text.replace(pattern, (_match, prefix: string) => `${prefix}${JSON.stringify(version)}`);
}

/**
 * Update only public workspace and catalog version fields, without asking Bun's
 * resolver to change the existing dependency graph. Refuse unexpected formats
 * or stale inputs before writing anything.
 */
export function updateReleaseLockfile(text: string, workspaces: ReleaseWorkspaceVersion[], version: string): string {
	const original = parseLockfile(text);
	const expected = structuredClone(original);
	let updated = text;
	const seen = new Set<string>();
	for (const workspace of workspaces) {
		if (seen.has(workspace.path)) throw new Error(`Duplicate release workspace: ${workspace.path}`);
		seen.add(workspace.path);
		const existing = original.workspaces[workspace.path];
		if (!existing || existing.name !== workspace.name || existing.version !== workspace.version) {
			throw new Error(`bun.lock workspace is missing or stale: ${workspace.path}`);
		}
		const block = `(^    ${escaped(JSON.stringify(workspace.path))}: \\{\\r?\\n[ \\t]+"name": ${escaped(JSON.stringify(workspace.name))},\\r?\\n[ \\t]+"version": )${escaped(JSON.stringify(workspace.version))}`;
		updated = replaceOnce(updated, new RegExp(block, "gm"), `workspace ${workspace.path}`, version);
		expected.workspaces[workspace.path].version = version;
		if (workspace.catalogVersion !== undefined) {
			if (original.catalog[workspace.name] !== workspace.catalogVersion) {
				throw new Error(`bun.lock catalog is missing or stale: ${workspace.name}`);
			}
			const entry = `(^    ${escaped(JSON.stringify(workspace.name))}: )${escaped(JSON.stringify(workspace.catalogVersion))}(?=,)`;
			updated = replaceOnce(updated, new RegExp(entry, "gm"), `catalog ${workspace.name}`, version);
			expected.catalog[workspace.name] = version;
		}
	}
	if (!Bun.deepEquals(parseLockfile(updated), expected)) {
		throw new Error("Release lockfile update would change fields outside workspace/catalog versions");
	}
	return updated;
}
