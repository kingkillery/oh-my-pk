import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type { WatchdogAction, WatchdogConfig, WatchdogEvaluation } from "./types";

// Local, opt-in raw telemetry. Each monitor owns a bounded, append-only file.
export function createWatchdogCaseCollector(
	directory: string | undefined,
	source?: { subagentId: string; sessionFile?: string },
) {
	if (!directory || !path.isAbsolute(directory)) return undefined;
	const groupId = randomUUID();
	const filename = path.join(directory, `watchdog-${groupId}.jsonl`);
	let pending = Promise.resolve();
	let initialized = false;
	let failed = false;
	let count = 0;
	let dropped = 0;
	const enqueue = (entry: object) => {
		pending = pending.then(async () => {
			if (failed) return;
			try {
				const handle = await open(filename, initialized ? "a" : "wx", 0o600);
				initialized = true;
				try {
					await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
				} finally {
					await handle.close();
				}
			} catch {
				failed = true;
				logger.warn("Watchdog case collection stopped: local write failed");
			}
		});
	};
	return {
		decision(
			state: string,
			startedAt: string,
			evaluation: WatchdogEvaluation | undefined,
			action: WatchdogAction | undefined,
			config: WatchdogConfig | undefined,
			actionStatus: string,
		) {
			if (count >= 100) {
				dropped++;
				return;
			}
			count++;
			enqueue({
				version: 1,
				kind: "decision",
				caseId: randomUUID(),
				groupId,
				source: source ?? null,
				startedAt,
				decisionAt: new Date().toISOString(),
				question: "Assess thrashing, stall severity, and blocker type to determine the watchdog intervention.",
				state: state.length <= 8192 ? state : null,
				stateOmitted: state.length > 8192 ? "too_long" : null,
				policy: {
					identity: "watchdog-arbitrator-v1",
					abortSeverityThreshold: config?.abortSeverityThreshold ?? 2.5,
					abortThrashThreshold: config?.abortThrashThreshold ?? 0.85,
					hintSeverityThreshold: config?.hintSeverityThreshold ?? 1.6,
					hintThrashThreshold: config?.hintThrashThreshold ?? 0.6,
				},
				evaluation: evaluation ?? null,
				action: action?.action ?? null,
				actionStatus,
			});
		},
		outcome(outcome: { exitCode: number; aborted: boolean | null; isError: boolean | null }) {
			if (count === 0) return;
			enqueue({
				version: 1,
				kind: "run_outcome",
				groupId,
				observedAt: new Date().toISOString(),
				...outcome,
				droppedDecisions: dropped,
				note: "Run status only; action effectiveness and expert label are unknown.",
			});
		},
		flush: () => pending,
	};
}
