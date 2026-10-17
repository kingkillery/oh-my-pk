import * as path from "node:path";
import { getBlobsDir, getSessionsDir } from "@pk-nerdsaver-ai/pi-utils";
import * as git from "../utils/git";
import { canonicalPath, sha256 } from "./records";
import { SessionMemoryStore } from "./store";

export interface SessionMemoryProject {
	root: string;
	roots: string[];
	dbPath: string;
	sessionsDir: string;
	blobsDir: string;
}

export async function sessionMemoryProject(cwd: string, signal?: AbortSignal): Promise<SessionMemoryProject> {
	const worktrees = await git.worktree.list(cwd, signal);
	const root = worktrees[0]?.path ?? (await git.repo.root(cwd, signal));
	if (!root) throw new Error("Session memory requires a Git repository.");
	const sessionsDir = getSessionsDir();
	return {
		root,
		roots: [...new Set([root, ...worktrees.map(tree => tree.path)].filter(Boolean))],
		dbPath: path.join(
			path.dirname(sessionsDir),
			"session-memory",
			`${sha256(canonicalPath(root)).slice(0, 24)}.sqlite`,
		),
		sessionsDir,
		blobsDir: getBlobsDir(),
	};
}

export async function readSessionMemory(
	project: SessionMemoryProject,
	action: string,
	value = "",
	offset = 0,
	limit = 10,
): Promise<unknown> {
	if (!(await Bun.file(project.dbPath).exists()))
		return { status: "not-built", message: "Run /session-memory build in this repository first." };
	const store = await SessionMemoryStore.open(project.dbPath, project.root, true);
	try {
		switch (action) {
			case "status":
				return {
					project: project.root,
					index: project.dbPath,
					...store.status(),
					missingDependencies: store.missingDependencies(),
				};
			case "wake":
				return { summaryKind: "extractive", sessions: store.wake(limit, offset) };
			case "search":
				return { mode: "lexical", matches: store.search(value, limit, offset) };
			case "expand":
				return store.expand(value, offset, limit);
			case "source":
				return store.source(value, offset, limit);
			default:
				throw new Error("Use status, wake, search, expand or source.");
		}
	} finally {
		store.close();
	}
}
