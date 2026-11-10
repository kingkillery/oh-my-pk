import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import { unified } from "@astrojs/markdown-remark";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import { rewriteDocLinks } from "./scripts/rewrite-links.mjs";

const generated = new URL("./.generated/", import.meta.url);
const sections = JSON.parse(readFileSync(new URL("navigation.json", generated), "utf8"));
const paths = JSON.parse(readFileSync(new URL("paths.json", generated), "utf8"));
const indexedPaths = new Set(["/docs/", ...sections.flatMap(section => section.entries.map(entry => `/docs/${entry.path.slice(0, -3)}/`))]);

export default defineConfig({
	site: "https://oh-my-pk.pkking.computer",
	base: "/docs",
	outDir: "./dist/site",
	publicDir: "./.generated/public",
	markdown: { processor: unified({ remarkPlugins: [[rewriteDocLinks, { paths }]] }) },
	integrations: [sitemap({ filter: page => indexedPaths.has(new URL(page).pathname) }), starlight({
		title: "oh-my-pk docs",
		sidebar: sections.map(section => ({
			label: section.label,
			collapsed: true,
			items: section.entries.map(entry => ({ label: entry.label, slug: entry.path.slice(0, -3) })),
		})),
		components: {
			Head: "./src/components/Head.astro",
			PageTitle: "./src/components/PageTitle.astro",
		},
	})],
});
