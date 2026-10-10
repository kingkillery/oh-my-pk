/**
 * Resolve the update channel version advertised by the fork.
 */
export interface ReleaseInfo {
	readonly tag: string;
	readonly version: string;
}

export interface ReleaseSourceOptions {
	readonly distBase: string;
	readonly packageName: string;
	readonly npmRegistry: string;
	readonly githubRepo?: string;
}

/**
 * Release-binary installs follow GitHub's latest release, like install.sh.
 * Custom distributions and package-manager installs retain their existing
 * distribution/registry channel. A GitHub outage may fall back to the binary
 * distribution, but never to an unrelated npm version for binary installs.
 */
export async function getLatestRelease(options: ReleaseSourceOptions): Promise<ReleaseInfo> {
	if (options.githubRepo) {
		try {
			return await getLatestGitHubRelease(options.githubRepo);
		} catch (error) {
			const distVersion = await getDistVersion(options.distBase);
			if (distVersion) return { tag: `v${distVersion}`, version: distVersion };
			throw error;
		}
	}
	const distVersion = await getDistVersion(options.distBase);
	if (distVersion) return { tag: `v${distVersion}`, version: distVersion };
	return getLatestNpmRelease(options);
}

async function getLatestGitHubRelease(repo: string): Promise<ReleaseInfo> {
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
	if (!response.ok) throw new Error(`Failed to fetch GitHub release: ${response.statusText}`);
	const data: unknown = await response.json();
	if (typeof data !== "object" || data === null || !("tag_name" in data) || typeof data.tag_name !== "string") {
		throw new Error("Failed to fetch GitHub release: invalid response");
	}
	const match = /^v?(\d+\.\d+\.\d+)$/.exec(data.tag_name);
	if (!match) throw new Error(`Invalid GitHub release tag: ${data.tag_name}`);
	return { tag: data.tag_name, version: match[1] };
}

/**
 * Resolve the version the fork's distribution endpoint currently serves
 * (`<distBase>/version` -> `vX.Y.Z`). Returns undefined when unreachable so
 * callers can fall back to package-manager metadata.
 */
export async function getDistVersion(distBase: string): Promise<string | undefined> {
	try {
		const response = await fetch(`${distBase}/version`);
		if (!response.ok) return undefined;
		const version = (await response.text()).trim().replace(/^v/, "");
		return version.length > 0 ? version : undefined;
	} catch {
		return undefined;
	}
}

async function getLatestNpmRelease(options: ReleaseSourceOptions): Promise<ReleaseInfo> {
	const response = await fetch(`${options.npmRegistry}${options.packageName}/latest`);
	if (!response.ok) {
		throw new Error(`Failed to fetch release info: ${response.statusText}`);
	}

	const data: unknown = await response.json();
	if (typeof data !== "object" || data === null || !("version" in data) || typeof data.version !== "string") {
		throw new Error("Failed to fetch release info: invalid registry response");
	}

	return { tag: `v${data.version}`, version: data.version };
}
