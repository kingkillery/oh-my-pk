/**
 * Best-effort git snapshot for a workspace.
 *
 * ChatGPT cannot see the filesystem, so every finished task reports what
 * changed. This stays deliberately shallow — status plus `diff --stat` — and
 * never throws: a non-git workspace simply returns an empty snapshot.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 8000;

async function runGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	return stdout;
}

/** Truncate text to a character cap with an explicit marker. */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
	const head = text.slice(0, Math.max(0, maxChars - 40));
	return { text: `${head}\n…[truncated ${text.length - head.length} chars]`, truncated: true };
}

/**
 * Capture a compact change summary for `cwd`.
 *
 * Returns an empty string when the directory is not a git repository or the
 * snapshot fails for any reason.
 */
export async function captureGitSnapshot(cwd: string, maxChars: number): Promise<string> {
	try {
		const [branch, status, unstagedStat, stagedStat] = await Promise.all([
			runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
			runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]).catch(() => ""),
			runGit(cwd, ["diff", "--stat"]).catch(() => ""),
			runGit(cwd, ["diff", "--stat", "--cached"]).catch(() => ""),
		]);
		const sections: string[] = [];
		const branchName = branch.trim();
		if (branchName) sections.push(`branch: ${branchName}`);
		const statusText = status.trim();
		sections.push(statusText ? `status:\n${statusText}` : "status: clean");
		const unstaged = unstagedStat.trim();
		if (unstaged) sections.push(`unstaged diff:\n${unstaged}`);
		const staged = stagedStat.trim();
		if (staged) sections.push(`staged diff:\n${staged}`);
		if (sections.length <= 1) return "";
		return truncateText(sections.join("\n\n"), maxChars).text;
	} catch {
		return "";
	}
}
