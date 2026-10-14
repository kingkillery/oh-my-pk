import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { recoverLocalAgentOwner } from "../../src/gateway/local-agent-owner-recovery";
import type { LocalAgentRuntimeDescriptor } from "../../src/gateway/local-agent-owner-types";
import {
	SessionAlreadyOwnedError,
	SessionWriterGuard,
	type SessionWriterGuardHandle,
} from "../../src/session/session-writer-guard";

const children = new Set<ReturnType<typeof Bun.spawn>>();
const guards = new Set<SessionWriterGuardHandle>();

afterEach(async () => {
	for (const child of children) child.kill();
	children.clear();
	await Promise.all([...guards].map(guard => guard.release()));
	guards.clear();
});

function descriptor(transcriptPath: string): LocalAgentRuntimeDescriptor {
	return {
		protocol: 1,
		sessionId: "session-shared",
		agentId: "agent-shared",
		ownerId: "owner-old",
		ownerPid: 123,
		ownerEpoch: 7,
		endpoint: "ws://127.0.0.1:1/owner",
		tokenFilePath: `${transcriptPath}.token`,
		transcriptPath,
		leaseExpiresAt: 1,
		eventSeq: 0,
		lifecycle: "running",
		ref: {
			id: "agent-shared",
			sessionId: "session-shared",
			displayName: "Shared",
			kind: "desktop-tag",
			cwd: path.dirname(transcriptPath),
			status: "running",
			needsAttention: false,
		},
	};
}

async function waitForLine(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (!text.includes("\n")) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value, { stream: true });
	}
	reader.releaseLock();
	return text.trim();
}

describe("SessionWriterGuard", () => {
	test("rejects a second in-process writer until the holder releases", async () => {
		using temp = TempDir.createSync("@omp-writer-guard-");
		const options = {
			sessionId: "session-1",
			transcriptPath: temp.join("session.jsonl"),
			lockRoot: temp.join("locks"),
		};
		const first = SessionWriterGuard.acquire(options);
		guards.add(first);
		expect(() => SessionWriterGuard.acquire(options)).toThrow(SessionAlreadyOwnedError);
		await first.release();
		guards.delete(first);
		const next = SessionWriterGuard.acquire(options);
		guards.add(next);
		expect(next.guardId).not.toBe(first.guardId);
	});

	test("removes its lock file when the last holder releases", async () => {
		using temp = TempDir.createSync("@omp-writer-guard-cleanup-");
		const lockRoot = temp.join("locks");
		const options = { sessionId: "session-cleanup", transcriptPath: temp.join("session.jsonl"), lockRoot };
		const guard = SessionWriterGuard.acquire(options);
		expect((await fs.readdir(lockRoot)).filter(name => name.endsWith(".db"))).toHaveLength(1);
		await guard.release();
		expect(await fs.readdir(lockRoot)).toEqual([]);
	});

	test("reuses a lock file left marked retired when its deletion failed", async () => {
		using temp = TempDir.createSync("@omp-writer-guard-retired-");
		const lockRoot = temp.join("locks");
		const options = { sessionId: "session-retired", transcriptPath: temp.join("session.jsonl"), lockRoot };
		await SessionWriterGuard.acquire(options).release();
		// Windows refuses to delete a lock file another process still has open, leaving it
		// marked retired at its path. Recreate that state.
		const lockFile = path.join(
			lockRoot,
			`${new Bun.CryptoHasher("sha256").update("session-retired").digest("hex")}.db`,
		);
		const stale = new Database(lockFile, { create: true });
		stale.exec(
			"CREATE TABLE writer_guard (singleton INTEGER PRIMARY KEY, session_id TEXT NOT NULL, transcript_path TEXT NOT NULL, guard_id TEXT NOT NULL, acquired_at INTEGER NOT NULL); CREATE TABLE retired (singleton INTEGER PRIMARY KEY, nonce TEXT NOT NULL); INSERT INTO retired VALUES (1, 'left-behind');",
		);
		stale.close();

		const guard = SessionWriterGuard.acquire(options);
		guards.add(guard);
		expect(() => SessionWriterGuard.acquire(options)).toThrow(SessionAlreadyOwnedError);
		await guard.release();
		guards.delete(guard);
		expect(await fs.readdir(lockRoot)).toEqual([]);
	});

	test("hands the lock to a waiting process when the holder releases and deletes the file", async () => {
		using temp = TempDir.createSync("@omp-writer-guard-waiter-");
		const lockRoot = temp.join("locks");
		const transcriptPath = temp.join("session.jsonl");
		const options = { sessionId: "session-waited", transcriptPath, lockRoot };
		const holder = SessionWriterGuard.acquire(options);
		const moduleUrl = new URL("../../src/session/session-writer-guard.ts", import.meta.url).href;
		const childFile = temp.join("waiter.ts");
		await fs.writeFile(
			childFile,
			`import { SessionWriterGuard } from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write("waiting\\n");\nconst guard = SessionWriterGuard.acquire({ sessionId: "session-waited", transcriptPath: ${JSON.stringify(transcriptPath)}, lockRoot: ${JSON.stringify(lockRoot)}, busyTimeoutMs: 20_000 });\nprocess.stdout.write("acquired\\n");\nawait Promise.withResolvers<void>().promise;\nawait guard.release();\n`,
		);
		const child = Bun.spawn([process.execPath, childFile], { stdout: "pipe", stderr: "pipe" });
		children.add(child);
		expect(await waitForLine(child.stdout)).toBe("waiting");

		await holder.release();
		expect(await waitForLine(child.stdout)).toBe("acquired");
		// The waiter now owns the live lock, wherever it ended up.
		expect(() => SessionWriterGuard.acquire(options)).toThrow(SessionAlreadyOwnedError);
	}, 30_000);

	test("requires lease expiry and OS lock release before crashed-owner recovery", async () => {
		using temp = TempDir.createSync("@omp-writer-owner-death-");
		const lockRoot = temp.join("locks");
		const transcriptPath = temp.join("session.jsonl");
		const moduleUrl = new URL("../../src/session/session-writer-guard.ts", import.meta.url).href;
		const childFile = temp.join("holder.ts");
		await fs.writeFile(
			childFile,
			`import { SessionWriterGuard } from ${JSON.stringify(moduleUrl)};\nconst guard = SessionWriterGuard.acquire({ sessionId: "session-shared", transcriptPath: ${JSON.stringify(transcriptPath)}, lockRoot: ${JSON.stringify(lockRoot)} });\nprocess.stdout.write("acquired\\n");\nawait Promise.withResolvers<void>().promise;\nawait guard.release();\n`,
		);
		const child = Bun.spawn([process.execPath, childFile], { stdout: "pipe", stderr: "pipe" });
		children.add(child);
		expect(await waitForLine(child.stdout)).toBe("acquired");

		const staleButAlive = await recoverLocalAgentOwner({
			descriptor: descriptor(transcriptPath),
			now: 2,
			lockRoot,
			recover: async () => "should-not-run",
		});
		expect(staleButAlive).toEqual({ recovered: false, reason: "writer_active" });

		child.kill();
		await child.exited;
		children.delete(child);
		let recoveredEpoch = 0;
		const recovered = await recoverLocalAgentOwner({
			descriptor: descriptor(transcriptPath),
			now: 2,
			lockRoot,
			recover: async (_guard, epoch) => {
				recoveredEpoch = epoch;
				return "resumed";
			},
		});
		expect(recovered.recovered).toBe(true);
		if (!recovered.recovered) return;
		guards.add(recovered.guard);
		expect(recoveredEpoch).toBe(8);
		expect(() => SessionWriterGuard.acquire({ sessionId: "session-shared", transcriptPath, lockRoot })).toThrow(
			SessionAlreadyOwnedError,
		);
	});

	test("does not attempt recovery while the owner lease is fresh", async () => {
		using temp = TempDir.createSync("@omp-writer-fresh-lease-");
		let called = false;
		const result = await recoverLocalAgentOwner({
			descriptor: { ...descriptor(temp.join("session.jsonl")), leaseExpiresAt: 100 },
			now: 99,
			lockRoot: temp.join("locks"),
			recover: async () => {
				called = true;
			},
		});
		expect(result).toEqual({ recovered: false, reason: "lease_fresh" });
		expect(called).toBe(false);
	});
});
