import { mkdir, rm } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

const siteRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(siteRoot, "../..");
const docsRoot = join(repoRoot, "docs");
const contentDir = join(siteRoot, "src/content/docs");
const generatedDir = join(siteRoot, ".generated");
const publicDir = join(generatedDir, "public");
const index = await Bun.file(join(docsRoot, "README.md")).text();

type Entry = { label: string; path: string };
type Section = { label: string; entries: Entry[] };
const sections: Section[] = [];
for (const line of index.split(/\r?\n/)) {
	const heading = /^##\s+(.+)$/.exec(line);
	if (heading) {
		sections.push({ label: heading[1], entries: [] });
		continue;
	}
	const link = /^-\s+\[([^\]]+)\]\(([^)#]+\.md)\)/.exec(line);
	if (!link || sections.length === 0) continue;
	const path = posix.normalize(link[2]);
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/.test(link[2]) || path.startsWith("../") || path.startsWith("/")) {
		throw new Error(`Documentation index contains an unsafe path: ${link[2]}`);
	}
	sections[sections.length - 1].entries.push({ label: link[1].replaceAll("`", ""), path });
}
if (!sections.length || sections.some(section => section.entries.length === 0)) {
	throw new Error("The documentation index must contain sections with Markdown links.");
}

// The old Worker could serve any tracked docs path. Keep those routes available,
// but index only the intentionally curated pages from docs/README.md.
const git = Bun.spawn(["git", "ls-files", "-z", "--", "docs/"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
const [tracked, gitError, status] = await Promise.all([
	new Response(git.stdout).text(),
	new Response(git.stderr).text(),
	git.exited,
]);
if (status !== 0) throw new Error(`Cannot enumerate tracked documentation: ${gitError}`);
const curated = new Set(sections.flatMap(section => section.entries.map(entry => entry.path)));
const paths = new Set([
	...tracked.split("\0").filter(path => path.startsWith("docs/") && path.endsWith(".md")).map(path => path.slice(5)),
	...curated,
	"README.md",
]);

await rm(contentDir, { recursive: true, force: true });
await rm(generatedDir, { recursive: true, force: true });
await mkdir(contentDir, { recursive: true });
await mkdir(publicDir, { recursive: true });
const descriptions = new Map<string, string>();
for (const path of [...paths].sort()) {
	const source = Bun.file(join(docsRoot, path));
	if (!(await source.exists())) throw new Error(`Documentation source is missing: docs/${path}`);
	const markdown = await source.text();
	const body = markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "");
	const heading = /^#\s+(.+)$/m.exec(body);
	if (!heading) throw new Error(`Documentation page has no top-level heading: docs/${path}`);
	const title = heading[1].replace(/[`*_]/g, "").trim();
	const description = body.slice(heading.index + heading[0].length).split(/\r?\n\s*\r?\n/)
		.map(paragraph => paragraph.trim().replace(/\s+/g, " "))
		.find(paragraph => paragraph && !/^(?:#|[-*>|`]|\d+\.)/.test(paragraph));
	const summary = (description ?? title).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_]/g, "");
	descriptions.set(path, summary.length > 200 ? `${summary.slice(0, 197).replace(/\s+\S*$/, "")}…` : summary);
	const slug = path === "README.md" ? undefined : path.slice(0, -3);
	const metadata = [
		"---",
		`title: ${JSON.stringify(title)}`,
		`rawPath: ${JSON.stringify(path)}`,
		...(slug ? [`slug: ${JSON.stringify(slug)}`] : []),
		...(!curated.has(path) && path !== "README.md" ? ["pagefind: false", "head:", "  - tag: meta", "    attrs:", "      name: robots", "      content: noindex"] : []),
		"---",
		"",
	].join("\n");
	const contentPath = join(contentDir, path === "README.md" ? "index.md" : path);
	const rawPath = join(publicDir, "raw", path);
	await Promise.all([mkdir(dirname(contentPath), { recursive: true }), mkdir(dirname(rawPath), { recursive: true })]);
	await Promise.all([Bun.write(contentPath, metadata + body), Bun.write(rawPath, source)]);
}

const llms = ["# oh-my-pk documentation", "", "> User guides and reference material for the oh-my-pk coding agent.", ""];
for (const section of sections) {
	llms.push(`## ${section.label}`, "");
	for (const entry of section.entries) {
		llms.push(`- [${entry.label}](https://oh-my-pk.pkking.computer/docs/raw/${entry.path}): ${descriptions.get(entry.path)}`);
	}
	llms.push("");
}
await Promise.all([
	Bun.write(join(generatedDir, "navigation.json"), JSON.stringify(sections, null, 2)),
	Bun.write(join(generatedDir, "paths.json"), JSON.stringify([...paths].sort(), null, 2)),
	Bun.write(join(publicDir, "llms.txt"), llms.join("\n")),
]);
console.log(`Prepared ${paths.size} documentation pages; ${curated.size} are in the curated navigation.`);
