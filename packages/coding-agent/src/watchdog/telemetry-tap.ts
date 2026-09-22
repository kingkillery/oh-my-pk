/**
 * Telemetry Tap (State Compactor)
 *
 * Captures external tool execution telemetry in a bounded sliding window
 * and compacts it into a dense ~120-150 token snapshot for System 1 evaluation.
 */

import type { ToolActionRecord } from "./types";

export function extractToolTarget(toolName: string, args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;

	const record = args as Record<string, unknown>;

	switch (toolName) {
		case "edit":
		case "read":
		case "write": {
			if (typeof record.path === "string") return record.path;
			if (typeof record.target === "string") return record.target;
			break;
		}
		case "bash": {
			if (typeof record.command === "string") {
				const cmd = record.command.trim();
				const firstLine = cmd.split("\n")[0] ?? "";
				return firstLine.length > 50 ? `${firstLine.slice(0, 47)}...` : firstLine;
			}
			break;
		}
		case "grep": {
			if (typeof record.pattern === "string") return record.pattern;
			break;
		}
		case "ast_grep": {
			if (typeof record.pat === "string") return record.pat;
			break;
		}
		case "glob": {
			if (Array.isArray(record.paths) && typeof record.paths[0] === "string") {
				return record.paths.join(", ");
			}
			break;
		}
		default: {
			if (typeof record.path === "string") return record.path;
			if (typeof record.query === "string") return record.query;
			if (typeof record.pattern === "string") return record.pattern;
			break;
		}
	}

	return undefined;
}

export class TelemetryTap {
	readonly #windowSize: number;
	readonly #window: ToolActionRecord[] = [];

	constructor(windowSize = 5) {
		this.#windowSize = Math.max(1, windowSize);
	}

	record(action: ToolActionRecord): void {
		this.#window.push(action);
		if (this.#window.length > this.#windowSize) {
			this.#window.shift();
		}
	}

	get recentActions(): readonly ToolActionRecord[] {
		return this.#window;
	}

	get consecutiveErrors(): number {
		let count = 0;
		for (let i = this.#window.length - 1; i >= 0; i--) {
			if (this.#window[i].status === "error") {
				count++;
			} else {
				break;
			}
		}
		return count;
	}

	get consecutiveSameTarget(): number {
		if (this.#window.length === 0) return 0;
		const lastTarget = this.#window[this.#window.length - 1].target;
		if (!lastTarget) return 1;

		let count = 0;
		for (let i = this.#window.length - 1; i >= 0; i--) {
			if (this.#window[i].target === lastTarget) {
				count++;
			} else {
				break;
			}
		}
		return count;
	}

	/**
	 * Compact state snapshot (~100-150 tokens) for System 1 forward-pass evaluation.
	 */
	toCompactState(role: string, taskSummary: string): string {
		const lines: string[] = [
			`Agent Role: ${role || "subagent"}`,
			`Goal: ${taskSummary ? taskSummary.slice(0, 120) : "unspecified"}`,
			`Recent Tool Actions (last ${this.#window.length}):`,
		];

		if (this.#window.length === 0) {
			lines.push("  (no actions recorded yet)");
			return lines.join("\n");
		}

		for (let i = 0; i < this.#window.length; i++) {
			const item = this.#window[i];
			const targetPart = item.target ? ` "${item.target}"` : "";
			const statusPart =
				item.status === "error"
					? ` [ERROR: ${item.errorMessage ? item.errorMessage.slice(0, 60).replace(/\s+/g, " ") : "failed"}]`
					: " [OK]";
			lines.push(`  ${i + 1}. ${item.tool}${targetPart}${statusPart} (${item.durationMs}ms)`);
		}

		const sameTarget = this.consecutiveSameTarget;
		if (sameTarget >= 2 && this.#window[this.#window.length - 1].target) {
			lines.push(
				`Note: Target "${this.#window[this.#window.length - 1].target}" touched ${sameTarget}x consecutively.`,
			);
		}

		return lines.join("\n");
	}

	clear(): void {
		this.#window.length = 0;
	}
}
