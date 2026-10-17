import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	blobReferences,
	canonicalPath,
	excerpt,
	inProject,
	object,
	parseRecord,
	readRecords,
	recordText,
	sha256,
} from "./records";

const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, sha TEXT NOT NULL, bytes INTEGER NOT NULL, compressed BLOB NOT NULL, preview TEXT NOT NULL, role TEXT NOT NULL, entry_id TEXT NOT NULL, parent_id TEXT NOT NULL, timestamp TEXT NOT NULL, parsed INTEGER NOT NULL)",
	"CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(body, content='')",
	"CREATE TABLE IF NOT EXISTS archives (id TEXT PRIMARY KEY, path TEXT NOT NULL, sha TEXT NOT NULL, bytes INTEGER NOT NULL, mtime REAL NOT NULL, cwd TEXT NOT NULL, session_id TEXT NOT NULL, summary TEXT NOT NULL, captured_at TEXT NOT NULL, stable INTEGER NOT NULL, started_at TEXT NOT NULL)",
	"CREATE INDEX IF NOT EXISTS archives_path ON archives(path, captured_at)",
	"CREATE TABLE IF NOT EXISTS members (archive_id TEXT NOT NULL, seq INTEGER NOT NULL, record_id TEXT NOT NULL, offset INTEGER NOT NULL, PRIMARY KEY(archive_id,seq))",
	"CREATE INDEX IF NOT EXISTS members_record ON members(record_id)",
	"CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL, summary TEXT NOT NULL)",
	"CREATE INDEX IF NOT EXISTS segments_archive ON segments(archive_id,first_seq)",
	"CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, bytes INTEGER NOT NULL, compressed BLOB NOT NULL)",
	"CREATE TABLE IF NOT EXISTS blob_refs (record_id TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY(record_id,sha))",
].join(";\n");

export interface EvidenceExcerpt {
	recordId: string;
	text: string;
}
interface RecordRow {
	rowid: number;
	id: string;
	sha: string;
	bytes: number;
	compressed: Uint8Array<ArrayBuffer>;
	preview: string;
	role: string;
	entry_id: string;
	parent_id: string;
	timestamp: string;
	parsed: number;
}
export interface ArchiveRow {
	id: string;
	path: string;
	sha: string;
	bytes: number;
	mtime: number;
	cwd: string;
	session_id: string;
	summary: string;
	captured_at: string;
	stable: number;
	started_at: string;
}
export interface BuildReceipt {
	indexed: number;
	skipped: number;
	excluded: number;
	unstable: number;
	records: number;
	bytes: number;
	warnings: string[];
}
export interface BuildOptions {
	sessionsDir: string;
	blobsDir: string;
	roots: readonly string[];
	signal?: AbortSignal;
	force?: boolean;
	onProgress?: (receipt: BuildReceipt) => void;
}

/** An append-only, repository-scoped archive and derived lexical index. */
export class SessionMemoryStore {
	#db: Database;
	#statements = new Map<string, Statement<unknown, SQLQueryBindings[]>>();
	readonly path: string;
	private constructor(db: Database, dbPath: string) {
		this.#db = db;
		this.path = dbPath;
	}

	static async open(dbPath: string, projectRoot: string, readonly = false): Promise<SessionMemoryStore> {
		if (!readonly) await fs.mkdir(path.dirname(dbPath), { recursive: true });
		const db = new Database(dbPath, { readonly, create: !readonly });
		const store = new SessionMemoryStore(db, dbPath);
		try {
			db.exec("PRAGMA busy_timeout=5000");
			if (!readonly) {
				db.exec("PRAGMA journal_mode=WAL");
				db.exec(SCHEMA);
				db.run("INSERT OR IGNORE INTO metadata VALUES ('project_root',?)", [canonicalPath(projectRoot)]);
				db.run("INSERT OR IGNORE INTO metadata VALUES ('schema_version','1')");
			}
			const root = store.#query<{ value: string }>("SELECT value FROM metadata WHERE key='project_root'").get();
			if (root?.value !== canonicalPath(projectRoot))
				throw new Error("Session memory belongs to another repository.");
			const version = store.#query<{ value: string }>("SELECT value FROM metadata WHERE key='schema_version'").get();
			if (version?.value !== "1") throw new Error("Unsupported session-memory schema.");
			return store;
		} catch (error) {
			store.close();
			throw error;
		}
	}

	#query<T, P extends SQLQueryBindings[] = SQLQueryBindings[]>(sql: string): Statement<T, P> {
		let statement = this.#statements.get(sql);
		if (!statement) {
			statement = this.#db.query(sql);
			this.#statements.set(sql, statement);
		}
		return statement as Statement<T, P>;
	}
	close(): void {
		for (const statement of this.#statements.values()) statement.finalize();
		this.#statements.clear();
		this.#db.close();
	}
	status(): {
		archives: number;
		files: number;
		records: number;
		rawBytes: number;
		blobs: number;
		missingBlobs: number;
	} {
		const count = (sql: string) => this.#query<{ n: number }>(sql).get()?.n ?? 0;
		return {
			archives: count("SELECT count(*) n FROM archives"),
			files: count("SELECT count(DISTINCT path) n FROM archives"),
			records: count("SELECT count(*) n FROM records"),
			rawBytes: count("SELECT coalesce(sum(bytes),0) n FROM records"),
			blobs: count("SELECT count(*) n FROM blobs"),
			missingBlobs: new Set(this.missingDependencies().map(ref => ref.sha)).size,
		};
	}
	missingDependencies(): { sha: string; recordId: string }[] {
		const missing: { sha: string; recordId: string }[] = [];
		for (const row of this.#query<RecordRow & { ref_sha: string }>(
			"SELECT r.*,ref.sha ref_sha FROM blob_refs ref JOIN records r ON r.id=ref.record_id LEFT JOIN blobs b ON b.sha=ref.sha WHERE b.sha IS NULL",
		).all()) {
			const bytes = Bun.gunzipSync(row.compressed);
			if (sha256(bytes) !== row.sha) throw new Error(`Archive corruption: ${row.id}`);
			if (blobReferences(parseRecord(bytes), new TextDecoder().decode(bytes)).includes(row.ref_sha))
				missing.push({ sha: row.ref_sha, recordId: row.id });
		}
		return missing;
	}
	#summarize(ids: readonly string[]): EvidenceExcerpt[] {
		const read = (id: string) =>
			this.#query<Pick<RecordRow, "id" | "preview" | "role">>("SELECT id,preview,role FROM records WHERE id=?").get(
				id,
			);
		let first: Pick<RecordRow, "id" | "preview" | "role"> | null = null;
		let last: Pick<RecordRow, "id" | "preview" | "role"> | null = null;
		let fallback: Pick<RecordRow, "id" | "preview" | "role"> | null = null;
		for (const id of ids) {
			const row = read(id);
			if (!fallback && row?.preview) fallback = row;
			if (row?.role === "user") {
				first = row;
				break;
			}
		}
		for (let i = ids.length - 1; i >= 0; i--) {
			const row = read(ids[i]);
			if (row?.role === "assistant") {
				last = row;
				break;
			}
		}
		const selected = first || last ? [first, last] : [fallback];
		return [
			...new Map(
				selected.filter(row => row !== null).map(row => [row.id, { recordId: row.id, text: row.preview }]),
			).values(),
		];
	}
	async build(options: BuildOptions): Promise<BuildReceipt> {
		options.signal?.throwIfAborted();
		const receipt: BuildReceipt = {
			indexed: 0,
			skipped: 0,
			excluded: 0,
			unstable: 0,
			records: 0,
			bytes: 0,
			warnings: [],
		};
		// Forked sessions can retain another project's folder. The header owns scope.
		for await (const relative of new Bun.Glob("**/*.jsonl").scan({
			cwd: options.sessionsDir,
			onlyFiles: true,
			followSymlinks: false,
		})) {
			options.signal?.throwIfAborted();
			const filePath = path.resolve(options.sessionsDir, relative);
			try {
				await this.#indexFile(filePath, options, receipt);
			} catch (error) {
				options.signal?.throwIfAborted();
				receipt.warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
			}
			options.onProgress?.(receipt);
		}
		for (const hash of new Set(this.missingDependencies().map(ref => ref.sha))) {
			const file = Bun.file(path.join(options.blobsDir, hash));
			if (!(await file.exists())) continue;
			const bytes = await file.bytes();
			if (sha256(bytes) !== hash) {
				receipt.warnings.push(`Blob hash mismatch: ${hash}`);
				continue;
			}
			this.#query("INSERT OR IGNORE INTO blobs VALUES (?,?,?)").run(hash, bytes.length, Bun.gzipSync(bytes));
		}
		return receipt;
	}
	async #indexFile(filePath: string, options: BuildOptions, receipt: BuildReceipt): Promise<void> {
		const before = await fs.stat(filePath);
		const previous = this.#query<ArchiveRow>(
			"SELECT * FROM archives WHERE path=? ORDER BY captured_at DESC LIMIT 1",
		).get(filePath);
		if (!options.force && previous?.stable && previous.bytes === before.size && previous.mtime === before.mtimeMs) {
			receipt.skipped++;
			return;
		}
		const iterator = readRecords(filePath, before.size);
		const first = await iterator.next();
		const header = first.done ? null : parseRecord(first.value.bytes);
		if (header?.type !== "session" || typeof header.cwd !== "string" || !inProject(header.cwd, options.roots)) {
			await iterator.return(undefined);
			receipt.excluded++;
			return;
		}
		// Exclude nested independent repositories, even when their paths are inside a pilot root.
		let directory = path.resolve(header.cwd);
		while (!options.roots.some(root => canonicalPath(root) === canonicalPath(directory))) {
			if (
				await fs.stat(path.join(directory, ".git")).then(
					() => true,
					() => false,
				)
			) {
				await iterator.return(undefined);
				receipt.excluded++;
				return;
			}
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
		const members: { id: string; offset: number }[] = [];
		const digest = new Bun.SHA256();
		const pending: {
			id: string;
			sha: string;
			bytes: Uint8Array<ArrayBuffer>;
			text: string;
			parsed: Record<string, unknown> | null;
			message: Record<string, unknown>;
			blobHashes: string[];
		}[] = [];
		let pendingBytes = 0;
		const flush = () => {
			this.#db
				.transaction(() => {
					for (const item of pending) {
						const { id, sha, bytes, text, parsed, message, blobHashes } = item;
						const inserted = this.#query(
							"INSERT OR IGNORE INTO records (id,sha,bytes,compressed,preview,role,entry_id,parent_id,timestamp,parsed) VALUES (?,?,?,?,?,?,?,?,?,?)",
						).run(
							id,
							sha,
							bytes.length,
							Bun.gzipSync(bytes),
							excerpt(text),
							typeof message.role === "string" ? message.role : String(parsed?.type ?? "unparsed"),
							typeof parsed?.id === "string" ? parsed.id : "",
							typeof parsed?.parentId === "string" ? parsed.parentId : "",
							typeof parsed?.timestamp === "string" ? parsed.timestamp : "",
							parsed ? 1 : 0,
						);
						if (inserted.changes) {
							const row = this.#query<{ rowid: number }>("SELECT rowid FROM records WHERE id=?").get(id);
							if (row) this.#query("INSERT INTO evidence_fts(rowid,body) VALUES (?,?)").run(row.rowid, text);
							receipt.records++;
							receipt.bytes += bytes.length;
						}
						for (const hash of blobHashes)
							this.#query("INSERT OR IGNORE INTO blob_refs VALUES (?,?)").run(id, hash);
					}
				})
				.immediate();
			pending.length = 0;
			pendingBytes = 0;
		};
		let current = first;
		try {
			while (!current.done) {
				options.signal?.throwIfAborted();
				const { bytes, offset } = current.value;
				digest.update(bytes);
				const sha = sha256(bytes);
				const id = `r:${sha256(`${canonicalPath(filePath)}:${offset}:${sha}`)}`;
				if (this.#query<{ id: string }>("SELECT id FROM records WHERE id=?").get(id)) {
					members.push({ id, offset });
					current = await iterator.next();
					continue;
				}
				const parsed = parseRecord(bytes);
				const message = object(parsed?.message);
				const rawText = new TextDecoder().decode(bytes);
				const text = parsed ? recordText(message.content ?? parsed.summary ?? parsed) : rawText;
				const blobHashes = blobReferences(parsed, rawText);
				for (const blobHash of blobHashes) {
					if (this.#query<{ sha: string }>("SELECT sha FROM blobs WHERE sha=?").get(blobHash)) continue;
					const blobFile = Bun.file(path.join(options.blobsDir, blobHash));
					if (!(await blobFile.exists())) continue;
					const blob = new Uint8Array(await blobFile.arrayBuffer());
					if (sha256(blob) !== blobHash) {
						receipt.warnings.push(`Blob hash mismatch: ${blobHash}`);
						continue;
					}
					this.#query("INSERT OR IGNORE INTO blobs VALUES (?,?,?)").run(blobHash, blob.length, Bun.gzipSync(blob));
				}
				pending.push({ id, sha, bytes, text, parsed, message, blobHashes });
				pendingBytes += bytes.length;
				if (pending.length >= 128 || pendingBytes >= 4 * 1024 * 1024) flush();
				members.push({ id, offset });
				current = await iterator.next();
			}
		} finally {
			await iterator.return(undefined);
		}
		flush();
		const sha = digest.digest("hex");
		const archiveId = `a:${sha256(`${canonicalPath(filePath)}:${sha}`)}`;
		const after = await fs.stat(filePath);
		const stable = before.size === after.size && before.mtimeMs === after.mtimeMs;
		this.#db
			.transaction(() => {
				this.#query(
					"INSERT INTO archives VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mtime=excluded.mtime,stable=excluded.stable,captured_at=excluded.captured_at",
				).run(
					archiveId,
					filePath,
					sha,
					before.size,
					before.mtimeMs,
					header.cwd as string,
					String(header.id ?? ""),
					JSON.stringify(this.#summarize(members.map(member => member.id))),
					new Date().toISOString(),
					stable ? 1 : 0,
					typeof header.timestamp === "string" ? header.timestamp : "",
				);
				for (let seq = 0; seq < members.length; seq++) {
					const member = members[seq];
					this.#query("INSERT OR IGNORE INTO members VALUES (?,?,?,?)").run(
						archiveId,
						seq,
						member.id,
						member.offset,
					);
				}
				for (let start = 0; start < members.length; start += 32) {
					const group = members.slice(start, start + 32);
					this.#query("INSERT OR IGNORE INTO segments VALUES (?,?,?,?,?)").run(
						`${archiveId}:${start}`,
						archiveId,
						start,
						start + group.length - 1,
						JSON.stringify(this.#summarize(group.map(member => member.id))),
					);
				}
			})
			.immediate();
		receipt.indexed++;
		if (!stable) receipt.unstable++;
	}
	search(query: string, limit = 10, offset = 0): unknown[] {
		const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24) ?? [];
		if (!terms.length) return [];
		const match = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
		return this.#query(
			"SELECT r.id,r.preview,r.role,r.timestamp,r.sha,r.bytes, (SELECT m.archive_id FROM members m WHERE m.record_id=r.id LIMIT 1) archiveId, evidence_fts.rank score FROM evidence_fts JOIN records r ON r.rowid=evidence_fts.rowid WHERE evidence_fts MATCH ? AND EXISTS(SELECT 1 FROM members m WHERE m.record_id=r.id) ORDER BY evidence_fts.rank LIMIT ? OFFSET ?",
		).all(match, Math.min(50, Math.max(1, limit)), Math.max(0, offset));
	}
	wake(limit = 10, offset = 0): ArchiveRow[] {
		return this.#query<ArchiveRow>(
			"SELECT * FROM archives a WHERE a.rowid= (SELECT b.rowid FROM archives b WHERE b.path=a.path ORDER BY b.captured_at DESC,b.rowid DESC LIMIT 1) ORDER BY started_at DESC,id LIMIT ? OFFSET ?",
		).all(Math.min(50, Math.max(1, limit)), Math.max(0, offset));
	}
	expand(id: string, offset = 0, limit = 20): unknown {
		const archive = this.#query<ArchiveRow>("SELECT * FROM archives WHERE id=?").get(id);
		if (archive)
			return {
				...archive,
				summary: JSON.parse(archive.summary),
				children: this.#query("SELECT * FROM segments WHERE archive_id=? ORDER BY first_seq LIMIT ? OFFSET ?").all(
					id,
					Math.min(50, Math.max(1, limit)),
					Math.max(0, offset),
				),
			};
		const segment = this.#query<{ archive_id: string; first_seq: number; last_seq: number; summary: string }>(
			"SELECT * FROM segments WHERE id=?",
		).get(id);
		if (segment)
			return {
				...segment,
				summary: JSON.parse(segment.summary),
				children: this.#query(
					"SELECT r.id,r.preview,r.role,r.entry_id,r.parent_id,r.timestamp,m.offset,m.seq FROM members m JOIN records r ON r.id=m.record_id WHERE m.archive_id=? AND m.seq BETWEEN ? AND ? ORDER BY m.seq LIMIT ? OFFSET ?",
				).all(
					segment.archive_id,
					segment.first_seq,
					segment.last_seq,
					Math.min(50, Math.max(1, limit)),
					Math.max(0, offset),
				),
			};
		const record = this.#query<RecordRow>("SELECT rowid,* FROM records WHERE id=?").get(id);
		if (!record) throw new Error(`Evidence node not found: ${id}`);
		const blobBytes = Bun.gunzipSync(record.compressed);
		const referenced = new Set(blobReferences(parseRecord(blobBytes), new TextDecoder().decode(blobBytes)));
		return {
			id,
			sha: record.sha,
			bytes: record.bytes,
			preview: record.preview,
			sources: this.#query(
				"SELECT a.id archiveId,a.path,a.sha fileSha,m.offset,m.seq FROM members m JOIN archives a ON a.id=m.archive_id WHERE m.record_id=? ORDER BY a.captured_at DESC LIMIT ? OFFSET ?",
			).all(id, Math.min(50, Math.max(1, limit)), Math.max(0, offset)),
			parents: this.#query(
				"SELECT DISTINCT p.record_id id FROM members m JOIN members p ON p.archive_id=m.archive_id JOIN records r ON r.id=p.record_id WHERE m.record_id=? AND r.entry_id=? AND r.entry_id<>'' LIMIT 50",
			).all(id, record.parent_id),
			children: this.#query(
				"SELECT DISTINCT c.id,c.preview,c.role,c.timestamp FROM members m JOIN members child ON child.archive_id=m.archive_id JOIN records c ON c.id=child.record_id WHERE m.record_id=? AND c.parent_id=? AND c.parent_id<>'' ORDER BY c.timestamp,c.id LIMIT ? OFFSET ?",
			).all(id, record.entry_id, Math.min(50, Math.max(1, limit)), Math.max(0, offset)),
			blobs: this.#query<{ sha: string; bytes: number | null; recoverable: number }>(
				"SELECT r.sha,b.bytes,b.sha IS NOT NULL recoverable FROM blob_refs r LEFT JOIN blobs b ON b.sha=r.sha WHERE r.record_id=?",
			)
				.all(id)
				.filter(ref => referenced.has(ref.sha))
				.map(ref => ({ ...ref, id: `b:${ref.sha}` })),
		};
	}
	source(
		id: string,
		offset = 0,
		limit = 8192,
	): {
		id: string;
		sha: string;
		bytes: number;
		offset: number;
		nextOffset: number | null;
		base64: string;
		text: string;
	} {
		const row = id.startsWith("b:")
			? this.#query<Pick<RecordRow, "sha" | "bytes" | "compressed">>("SELECT * FROM blobs WHERE sha=?").get(
					id.slice(2),
				)
			: this.#query<RecordRow>("SELECT rowid,* FROM records WHERE id=?").get(id);
		if (!row) throw new Error(`Evidence record not found: ${id}`);
		const bytes = Bun.gunzipSync(row.compressed);
		if (sha256(bytes) !== row.sha) throw new Error(`Archive corruption: ${id}`);
		const start = Math.min(bytes.length, Math.max(0, offset));
		const end = Math.min(bytes.length, start + Math.min(65536, Math.max(1, limit)));
		const slice = bytes.subarray(start, end);
		return {
			id,
			sha: row.sha,
			bytes: bytes.length,
			offset: start,
			nextOffset: end < bytes.length ? end : null,
			base64: Buffer.from(slice).toString("base64"),
			text: new TextDecoder().decode(slice),
		};
	}
	/** Verify all archived bytes without trusting previews or the original files. */
	async verify(
		signal?: AbortSignal,
	): Promise<{ archives: number; records: number; blobs: number; faults: string[]; missingBlobs: number }> {
		const result = {
			archives: 0,
			records: 0,
			blobs: 0,
			faults: [] as string[],
			missingBlobs: this.status().missingBlobs,
		};
		for (const archive of this.#query<ArchiveRow>("SELECT * FROM archives").iterate()) {
			signal?.throwIfAborted();
			const digest = new Bun.SHA256();
			let size = 0;
			for (const row of this.#query<RecordRow>(
				"SELECT r.* FROM members m JOIN records r ON r.id=m.record_id WHERE m.archive_id=? ORDER BY m.seq",
			).iterate(archive.id)) {
				try {
					const bytes = Bun.gunzipSync(row.compressed);
					if (sha256(bytes) !== row.sha || bytes.length !== row.bytes) result.faults.push(row.id);
					digest.update(bytes);
					size += bytes.length;
					result.records++;
				} catch {
					result.faults.push(row.id);
				}
			}
			if (digest.digest("hex") !== archive.sha || size !== archive.bytes) result.faults.push(archive.id);
			result.archives++;
			await Bun.sleep(0);
		}
		for (const blob of this.#query<{ sha: string; bytes: number; compressed: Uint8Array<ArrayBuffer> }>(
			"SELECT * FROM blobs",
		).iterate()) {
			try {
				const bytes = Bun.gunzipSync(blob.compressed);
				if (sha256(bytes) !== blob.sha || bytes.length !== blob.bytes) result.faults.push(blob.sha);
				result.blobs++;
			} catch {
				result.faults.push(blob.sha);
			}
		}
		return result;
	}
	/** Reconstruct a session and its referenced blobs into a new directory; never overwrite. */
	async restore(
		archiveId: string,
		destination: string,
	): Promise<{ sha: string; bytes: number; missingBlobs: string[] }> {
		const archive = this.#query<ArchiveRow>("SELECT * FROM archives WHERE id=?").get(archiveId);
		if (!archive) throw new Error(`Archive not found: ${archiveId}`);
		await fs.mkdir(destination);
		const output = Bun.file(path.join(destination, "session.jsonl")).writer({ highWaterMark: 64 * 1024 });
		const digest = new Bun.SHA256();
		let length = 0;
		const missingBlobs: string[] = [];
		const dependencies = new Set<string>();
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let buffered = 0;
		const flush = async () => {
			if (!buffered) return;
			await output.write(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered));
			chunks.length = 0;
			buffered = 0;
		};
		const statement = this.#db.query<RecordRow, [string]>(
			"SELECT r.* FROM members m JOIN records r ON r.id=m.record_id WHERE m.archive_id=? ORDER BY m.seq",
		);
		try {
			for (const record of statement.iterate(archiveId)) {
				const bytes = Bun.gunzipSync(record.compressed);
				if (sha256(bytes) !== record.sha) throw new Error(`Archive corruption: ${record.id}`);
				digest.update(bytes);
				for (const hash of blobReferences(parseRecord(bytes), new TextDecoder().decode(bytes)))
					dependencies.add(hash);
				chunks.push(bytes);
				buffered += bytes.length;
				if (buffered >= 64 * 1024) await flush();
				length += bytes.length;
			}
			await flush();
		} finally {
			statement.finalize();
			await output.end();
		}
		const sha = digest.digest("hex");
		if (sha !== archive.sha || length !== archive.bytes)
			throw new Error(`Session restore verification failed: ${archiveId}`);
		await fs.mkdir(path.join(destination, "blobs"));
		for (const ref of this.#query<{ sha: string; compressed: Uint8Array<ArrayBuffer> | null }>(
			"SELECT DISTINCT refs.sha,b.compressed FROM members m JOIN blob_refs refs ON refs.record_id=m.record_id LEFT JOIN blobs b ON b.sha=refs.sha WHERE m.archive_id=?",
		).all(archiveId)) {
			if (!dependencies.has(ref.sha)) continue;
			if (!ref.compressed) {
				missingBlobs.push(ref.sha);
				continue;
			}
			const bytes = Bun.gunzipSync(ref.compressed);
			if (sha256(bytes) !== ref.sha) throw new Error(`Blob archive corruption: ${ref.sha}`);
			await Bun.write(path.join(destination, "blobs", ref.sha), bytes);
		}
		return { sha, bytes: length, missingBlobs };
	}
}
