import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import worker from "../../install-redirect/worker.js";

const siteRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(siteRoot, "../..");
const assetRoot = join(siteRoot, "dist/assets");
const origin = "https://oh-my-pk.pkking.computer";

// Exercise the real Worker against the generated files, without a network service.
const env = { ASSETS: { async fetch(request: Request) {
	const pathname = decodeURIComponent(new URL(request.url).pathname);
	const relativePath = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
	const filePath = resolve(assetRoot, `.${relativePath}`);
	if (!filePath.startsWith(`${assetRoot}${sep}`)) return new Response("Not found", { status: 404 });
	const file = Bun.file(filePath);
	if (!(await file.exists())) return new Response("Not found", { status: 404 });
	return new Response(request.method === "HEAD" ? null : file);
} } };
const request = (path: string, method = "GET") => worker.fetch(new Request(`${origin}${path}`, { method }), env, {});

async function inspectHtml(response: Response) {
	assert.equal(response.status, 200);
	const links: string[] = [];
	const alternate: string[] = [];
	const controls: string[] = [];
	const ids: string[] = [];
	const robots: string[] = [];
	await new HTMLRewriter()
		.on("a[href]", { element(element) { links.push(element.getAttribute("href") ?? ""); } })
		.on('link[rel="alternate"][type="text/markdown"]', { element(element) { alternate.push(element.getAttribute("href") ?? ""); } })
		.on("button[data-copy-markdown]", { element(element) { controls.push(element.getAttribute("data-copy-markdown") ?? ""); } })
		.on("[id]", { element(element) { ids.push(element.getAttribute("id") ?? ""); } })
		.on('meta[name="robots"]', { element(element) { robots.push(element.getAttribute("content") ?? ""); } })
		.transform(response).text();
	return { links, alternate, controls, ids, robots };
}

const settings = await inspectHtml(await request("/docs/settings/"));
assert(settings.links.includes("/docs/providers/"), "settings page should link to rendered provider docs");
assert(settings.links.includes("/docs/subagents/"), "settings page should link to rendered subagent docs");
assert(settings.links.includes("/docs/raw/settings.md"));
assert.deepEqual(settings.alternate, ["/docs/raw/settings.md"]);
assert.deepEqual(settings.controls, ["/docs/raw/settings.md"]);
assert(settings.ids.includes("agent-model-profiles-and-difficulty-routing"), "settings section anchors should be available");

const source = await Bun.file(join(repoRoot, "docs/subagents.md")).arrayBuffer();
for (const path of ["/docs/raw/subagents.md", "/docs/subagents.md"]) {
	const response = await request(path);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.deepEqual(await response.arrayBuffer(), source, `${path} should preserve the canonical Markdown bytes`);
}
const head = await request("/docs/raw/subagents.md", "HEAD");
assert.equal(head.status, 200);
assert.equal(await head.text(), "");

const rootIndex = await request("/llms.txt");
assert.equal(rootIndex.headers.get("content-type"), "text/plain; charset=utf-8");
const llms = await rootIndex.text();
assert.equal(await (await request("/docs/llms.txt")).text(), llms);
const allPaths: string[] = await Bun.file(join(siteRoot, ".generated/paths.json")).json();
await Promise.all(allPaths.map(async path => {
	const [original, generated] = await Promise.all([
		Bun.file(join(repoRoot, "docs", path)).arrayBuffer(),
		Bun.file(join(assetRoot, "docs/raw", path)).arrayBuffer(),
	]);
	assert.deepEqual(generated, original, `raw Markdown differs from docs/${path}`);
}));
const sections: { label: string; entries: { label: string; path: string }[] }[] = await Bun.file(join(siteRoot, ".generated/navigation.json")).json();
const home = await inspectHtml(await request("/docs/"));
const hrefs = new Set(home.links);
const sitemap = await (await request("/docs/sitemap-0.xml")).text();
assert(sitemap.includes(`${origin}/docs/subagents/`));
assert(!sitemap.includes(`${origin}/docs/ai-schema-normalize/`));
const legacy = await inspectHtml(await request("/docs/ai-schema-normalize/"));
assert(legacy.robots.includes("noindex"), "legacy-only pages should not be indexed by search engines");
const pageLinks = new Set<string>();
for (const section of sections) {
	assert(llms.includes(`## ${section.label}`));
	for (const entry of section.entries) {
		const slug = entry.path.slice(0, -3);
		assert(hrefs.has(`/docs/${slug}/`), `navigation is missing ${entry.path}`);
		assert(llms.includes(`${origin}/docs/raw/${entry.path}`), `llms.txt is missing ${entry.path}`);
		const page = await inspectHtml(await request(`/docs/${slug}/`));
		assert.deepEqual(page.alternate, [`/docs/raw/${entry.path}`]);
		assert.deepEqual(page.controls, [`/docs/raw/${entry.path}`]);
		for (const href of page.links) {
			const url = new URL(href, `${origin}/docs/${slug}/`);
			if (url.origin === origin && url.pathname.startsWith("/docs/")) pageLinks.add(url.pathname);
		}
	}
}
const failures = (await Promise.all([...pageLinks].map(async path => {
	const response = await request(path.endsWith("/") || /\.[a-z\d]+$/i.test(path) ? path : `${path}/`);
	return response.status === 200 ? undefined : `${path}: ${response.status}`;
}))).filter(Boolean);
assert.deepEqual(failures, [], "rendered documentation links must point to generated assets");
assert.equal((await request("/docs/pagefind/pagefind.js")).status, 200);
assert.equal((await request("/docs/no-such-document/")).status, 404);
const versionRes = await request("/version");
assert.equal(versionRes.status, 200);
assert((await versionRes.text()).startsWith("v"), "version should return a release tag starting with v");
assert.equal((await request("/collab/")).status, 503);
assert.equal((await request("/", "POST")).status, 405);
console.log(`Verified ${sections.length} documentation sections, ${sections.reduce((sum, section) => sum + section.entries.length, 0)} curated pages, ${pageLinks.size} internal paths, raw Markdown, indexes, and Worker routing.`);
