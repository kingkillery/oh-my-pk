import { dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { visit } from "unist-util-visit";

const contentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src/content/docs");
const github = "https://github.com/kingkillery/oh-my-pk/blob/main/";

export function rewriteDocLinks({ paths }) {
	const available = new Set(paths);
	return (tree, file) => {
		if (!file.path) throw new Error("Markdown processor did not provide a source path");
		let source = relative(contentRoot, file.path).replaceAll("\\", "/");
		if (source === "index.md") source = "README.md";
		if (source.startsWith("../") || !available.has(source)) {
			throw new Error(`Unexpected documentation source: ${file.path}`);
		}
		visit(tree, node => {
			if ((node.type !== "link" && node.type !== "definition") || !node.url) return;
			const url = node.url;
			if (/^(?:[a-z][a-z\d+.-]*:|\/|#|\?)/i.test(url)) return;
			const marker = url.search(/[?#]/);
			const pathname = marker < 0 ? url : url.slice(0, marker);
			const suffix = marker < 0 ? "" : url.slice(marker);
			const repoPath = posix.normalize(posix.join("docs", posix.dirname(source), pathname));
			const docPath = repoPath.startsWith("docs/") ? repoPath.slice(5) : undefined;
			if (docPath && available.has(docPath)) {
				node.url = docPath === "README.md" ? `/docs/${suffix}` : `/docs/${docPath.slice(0, -3)}/${suffix}`;
			} else {
				node.url = `${github}${repoPath}${suffix}`;
			}
		});
	};
}
