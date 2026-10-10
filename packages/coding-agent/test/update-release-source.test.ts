import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { getLatestRelease } from "@pk-nerdsaver-ai/pi-coding-agent/cli/update-release-source";

const RELEASE_SOURCE = {
	distBase: "https://oh-my-pk.pkking.computer",
	packageName: "@pk-nerdsaver-ai/pi-coding-agent",
	npmRegistry: "https://registry.npmjs.org/",
} as const;

const restoreCallbacks: Array<() => void> = [];

afterEach(() => {
	for (const restore of restoreCallbacks.splice(0)) restore();
});

function stubFetch(handler: (url: string) => Response): readonly string[] {
	const calls: string[] = [];
	const fetchStub: typeof globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
			void init;
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push(url);
			return handler(url);
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchStub);
	restoreCallbacks.push(() => fetchSpy.mockRestore());
	return calls;
}

describe("update release source", () => {
	it("uses the official GitHub release before a potentially stale distribution", async () => {
		const calls = stubFetch(url =>
			url.includes("api.github.com") ? Response.json({ tag_name: "v16.4.28" }) : new Response("v16.4.25"),
		);
		expect(await getLatestRelease({ ...RELEASE_SOURCE, githubRepo: "kingkillery/oh-my-pk" })).toEqual({
			tag: "v16.4.28",
			version: "16.4.28",
		});
		expect(calls).toEqual(["https://api.github.com/repos/kingkillery/oh-my-pk/releases/latest"]);
	});

	it("falls back to the binary distribution when GitHub is unavailable", async () => {
		const calls = stubFetch(url =>
			url.includes("api.github.com") ? new Response("rate limited", { status: 403 }) : new Response("v16.4.28"),
		);
		expect(await getLatestRelease({ ...RELEASE_SOURCE, githubRepo: "kingkillery/oh-my-pk" })).toEqual({
			tag: "v16.4.28",
			version: "16.4.28",
		});
		expect(calls).toHaveLength(2);
	});

	it("does not silently switch binary installs to npm if both release hosts fail", async () => {
		const calls = stubFetch(() => new Response("unavailable", { status: 503 }));
		await expect(getLatestRelease({ ...RELEASE_SOURCE, githubRepo: "kingkillery/oh-my-pk" })).rejects.toThrow(
			"GitHub release",
		);
		expect(calls.some(url => url.includes("registry.npmjs.org"))).toBe(false);
	});

	it("rejects malformed GitHub release metadata", async () => {
		stubFetch(url =>
			url.includes("api.github.com")
				? Response.json({ tag_name: "not-a-release" })
				: new Response("unavailable", { status: 503 }),
		);
		await expect(getLatestRelease({ ...RELEASE_SOURCE, githubRepo: "kingkillery/oh-my-pk" })).rejects.toThrow(
			"Invalid GitHub release tag",
		);
	});

	it("checks the fork distribution endpoint before npm so pushed binary updates are visible immediately", async () => {
		const calls = stubFetch(url => {
			if (url === "https://oh-my-pk.pkking.computer/version") return new Response("v999.0.0\n");
			return new Response("unexpected", { status: 500, statusText: "unexpected" });
		});

		const release = await getLatestRelease(RELEASE_SOURCE);

		expect(release).toEqual({ tag: "v999.0.0", version: "999.0.0" });
		expect(calls).toEqual(["https://oh-my-pk.pkking.computer/version"]);
	});

	it("falls back to the fork npm package when the distribution endpoint is unavailable", async () => {
		const calls = stubFetch(url => {
			if (url === "https://oh-my-pk.pkking.computer/version") {
				return new Response("missing", { status: 404, statusText: "Not Found" });
			}
			if (url === "https://registry.npmjs.org/@pk-nerdsaver-ai/pi-coding-agent/latest") {
				return Response.json({ version: "999.0.1" });
			}
			return new Response("unexpected", { status: 500, statusText: "unexpected" });
		});

		const release = await getLatestRelease(RELEASE_SOURCE);

		expect(release).toEqual({ tag: "v999.0.1", version: "999.0.1" });
		expect(calls).toEqual([
			"https://oh-my-pk.pkking.computer/version",
			"https://registry.npmjs.org/@pk-nerdsaver-ai/pi-coding-agent/latest",
		]);
	});
});
