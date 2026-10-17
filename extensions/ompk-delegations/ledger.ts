/**
 * Central, durable delegation work records.
 *
 * One writer authority per broker SQLite database. This is a work/evidence
 * projection + queue admission boundary, NOT a second OMPK launch authority.
 * A worker must still use OMPK's normal authenticated launch/runtime controls.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type WorkState = "queued" | "running" | "review_ready" | "satisfied" | "blocked" | "failed" | "uncertain" | "cancelled";
export type Purpose = "status" | "execute" | "retry" | "verify" | "extend" | "alternative";
export interface Intent {
  schema: string;
  requestId: string;
  purpose: Purpose;
  source: { kind: string; sessionId?: string | null };
  target: { repository: string; operationId?: string };
  intent: { task: string; acceptance: string[] };
  identityPreference: "personal" | "shared";
  independentObservationRequired?: boolean;
}
export interface Receipt { criterion: string; uri: string; sourceId: string; verifiedAt: string }
export interface Decision {
  state: "satisfied" | "running" | "partial" | "blocked" | "unknown" | "admitted";
  message: string;
  operationId?: string;
  evidence: Receipt[];
  coverage: string;
  sessionUrl?: string;
}
interface WorkRow {
  id: string; principal: string; goal_key: string; repository: string; task: string;
  acceptance_json: string; purpose: string; identity_mode: string; state: WorkState;
  stage: string; source_json: string; created_at: string; updated_at: string;
  lease_epoch: number; lease_expires: number | null; worker_id: string | null;
}
const now = () => new Date().toISOString();
const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const TERMINAL = new Set<WorkState>(["satisfied", "blocked", "failed", "uncertain", "cancelled"]);

export function validateIntent(payload: unknown): Intent {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Error("Invalid request");
  const p = payload as Record<string, unknown>;
  if (p.schema !== "ompk.delegation.ingress/v1" ||
      !["status", "execute", "retry", "verify", "extend", "alternative"].includes(String(p.purpose)) ||
      typeof p.requestId !== "string" || p.requestId.length < 10 || p.requestId.length > 128 ||
      !["personal", "shared"].includes(String(p.identityPreference))) throw Error("Invalid request envelope");
  const source = p.source as Intent["source"] | null;
  const target = p.target as Intent["target"] | null;
  const intent = p.intent as Intent["intent"] | null;
  if (!source || typeof source.kind !== "string" || source.kind.length > 80 ||
      !target || typeof target.repository !== "string" ||
      (target.operationId !== undefined && (typeof target.operationId !== "string" || !/^[0-9a-f-]{36}$/.test(target.operationId))) ||
      !/^[\w.-]+\/[\w.-]+$/.test(target.repository) ||
      !intent || typeof intent.task !== "string" || intent.task.length < 1 ||
      intent.task.length > 12000 || !Array.isArray(intent.acceptance) ||
      intent.acceptance.length > 20 ||
      intent.acceptance.some(v => typeof v !== "string" || !v.trim() || v.length > 1000))
    throw Error("Invalid task or target");
  if (p.purpose !== "status" && intent.acceptance.length === 0) throw Error("Acceptance criteria required");
  return p as unknown as Intent;
}
export class WorkLedger {
  readonly db: Database;
  private constructor(db: Database) {
    this.db = db;
    this.db.run("PRAGMA busy_timeout=5000");
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA synchronous=FULL");
    this.db.run("CREATE TABLE IF NOT EXISTS work_schema_version(version INTEGER NOT NULL)");
    const version=this.db.query("SELECT version FROM work_schema_version").get() as {version:number}|null;
    if(version && version.version!==1) throw Error("Unsupported central work-ledger schema: "+version.version);
    if(!version) this.db.query("INSERT INTO work_schema_version(version) VALUES(1)").run();
    this.db.run(`CREATE TABLE IF NOT EXISTS work_records (
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, goal_key TEXT NOT NULL,
      repository TEXT NOT NULL, task TEXT NOT NULL, acceptance_json TEXT NOT NULL,
      purpose TEXT NOT NULL, identity_mode TEXT NOT NULL,
      state TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'planned',
      source_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      lease_epoch INTEGER NOT NULL DEFAULT 0, lease_expires INTEGER, worker_id TEXT
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_work_goal ON work_records(principal, goal_key, created_at DESC)");
    this.db.run(`CREATE TABLE IF NOT EXISTS ingress_requests (
      principal TEXT NOT NULL, source_key TEXT NOT NULL, request_id TEXT NOT NULL, input_digest TEXT NOT NULL,
      operation_id TEXT NOT NULL REFERENCES work_records(id),
      PRIMARY KEY (principal, source_key, request_id)
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS work_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL REFERENCES work_records(id),
      actor TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_work_events ON work_events(operation_id, seq)");
    this.db.run(`CREATE TABLE IF NOT EXISTS work_receipts (
      operation_id TEXT NOT NULL REFERENCES work_records(id), criterion TEXT NOT NULL,
      uri TEXT NOT NULL, source_id TEXT NOT NULL, verified_at TEXT,
      verifier TEXT, PRIMARY KEY(operation_id, criterion, uri)
    )`);
  }
  static async open(path: string): Promise<WorkLedger> {
    if (!path || !path.trim()) throw Error("A central database path is mandatory");
    if (path !== ":memory:") await mkdir(dirname(path), { recursive: true });
    return new WorkLedger(new Database(path, { create: true }));
  }
  close(): void { this.db.close(); }
  private row(id: string): WorkRow | null {
    return this.db.query("SELECT * FROM work_records WHERE id=?").get(id) as WorkRow | null;
  }
  private event(id: string, actor: string, kind: string, payload: unknown): void {
    this.db.query("INSERT INTO work_events(operation_id,actor,kind,payload_json,occurred_at) VALUES (?,?,?,?,?)")
      .run(id, actor, kind, JSON.stringify(payload), now());
  }
  events(id: string): Array<{ seq: number; actor: string; kind: string; payload_json: string; occurred_at: string }> {
    return this.db.query("SELECT seq,actor,kind,payload_json,occurred_at FROM work_events WHERE operation_id=? ORDER BY seq")
      .all(id) as Array<{ seq: number; actor: string; kind: string; payload_json: string; occurred_at: string }>;
  }
  private receipts(id: string): Receipt[] {
    const rows = this.db.query("SELECT criterion,uri,source_id,verified_at FROM work_receipts WHERE operation_id=? AND verified_at IS NOT NULL").all(id) as Array<{ criterion: string; uri: string; source_id: string; verified_at: string }>;
    return rows.map(r => ({ criterion: r.criterion, uri: r.uri, sourceId: r.source_id, verifiedAt: r.verified_at }));
  }
  private decision(row: WorkRow, admitted = false): Decision {
    const evidence = this.receipts(row.id);
    const complete = row.state === "satisfied" &&
      (JSON.parse(row.acceptance_json) as string[]).every(c => evidence.some(e => e.criterion === c));
    const state: Decision["state"] = admitted ? "admitted" :
      complete ? "satisfied" :
      row.state === "queued" || row.state === "running" ? "running" :
      row.state === "blocked" || row.state === "failed" || row.state === "uncertain" || row.state === "cancelled" ? "blocked" :
      "partial";
    return {
      state, operationId: row.id, evidence, coverage: "central-ledger; historical evidence only; no live-health assertion",
      message: state === "satisfied" ? "Work has verified completion receipts. Current runtime health was not probed." :
        state === "running" ? "Existing operation is " + row.state + " (stage: " + row.stage + ")." :
        state === "admitted" ? "New work admitted to the central queue; execution has not yet started." :
        "Work is " + row.state + " (stage: " + row.stage + "); do not infer completion.",
    };
  }
  inspect(principal: string, input: Intent): Decision {
    if (input.target.operationId) return this.get(principal,input.target.operationId);
    const goalKey = this.goalKey(principal, input);
    const row = this.db.query("SELECT * FROM work_records WHERE principal=? AND goal_key=? ORDER BY created_at DESC LIMIT 1")
      .get(principal, goalKey) as WorkRow | null;
    if (row) return this.decision(row);
    const candidates=this.db.query("SELECT id,task,state,stage FROM work_records WHERE principal=? AND repository=? ORDER BY created_at DESC LIMIT 5")
      .all(principal,input.target.repository) as Array<{id:string;task:string;state:string;stage:string}>;
    const details=candidates.map(x=>x.id+" ["+x.state+"/"+x.stage+"]: "+x.task.slice(0,110)).join("; ");
    return {
      state:"unknown", evidence: [],
      coverage: "central-ledger exact-scope lookup; bounded recent candidate list; semantic equivalence not verified",
      message: "No exact matching work record. Candidate records (not proof of equivalence): "+(details||"none")+
        ". Reference a specific operationId for authoritative status. No new work started.",
    };
  }
  private goalKey(principal: string, input: Intent): string {
    return hash(JSON.stringify({
      principal, repository: input.target.repository.toLowerCase(),
      task: normalize(input.intent.task), acceptance: input.intent.acceptance.map(normalize).sort(),
    }));
  }
  admit(principal: string, effectiveMode: "personal" | "shared", input: Intent): Decision {
    const sourceKey = JSON.stringify(input.source);
    const digest = hash(JSON.stringify({ purpose:input.purpose, identityMode:effectiveMode, target:input.target, intent:input.intent }));
    return this.db.transaction(() => {
      const prior = this.db.query("SELECT operation_id,input_digest FROM ingress_requests WHERE principal=? AND source_key=? AND request_id=?")
        .get(principal, sourceKey, input.requestId) as { operation_id: string; input_digest: string } | null;
      if (prior) {
        if (prior.input_digest !== digest) throw Error("Conflicting idempotency key payload");
        const row = this.row(prior.operation_id);
        if (!row) throw Error("Ingress reference missing authoritative record");
        return this.decision(row);
      }
      const same = this.db.query("SELECT * FROM work_records WHERE principal=? AND goal_key=? ORDER BY created_at DESC LIMIT 1")
        .get(principal, this.goalKey(principal, input)) as WorkRow | null;
      const deliberate = ["retry", "verify", "alternative", "extend"].includes(input.purpose);
      if (same && !deliberate) {
        this.db.query("INSERT INTO ingress_requests(principal,source_key,request_id,input_digest,operation_id) VALUES(?,?,?,?,?)")
          .run(principal, sourceKey, input.requestId, digest, same.id);
        this.event(same.id, principal, "joined_existing", { source: input.source, requestId: input.requestId });
        return this.decision(same);
      }
      const id = randomUUID();
      const stamp = now();
      this.db.query(`INSERT INTO work_records(id,principal,goal_key,repository,task,acceptance_json,purpose,identity_mode,state,stage,source_json,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,principal,this.goalKey(principal,input),input.target.repository,input.intent.task,
        JSON.stringify(input.intent.acceptance),input.purpose,effectiveMode,"queued","planned",JSON.stringify(input.source),stamp,stamp);
      this.db.query("INSERT INTO ingress_requests(principal,source_key,request_id,input_digest,operation_id) VALUES(?,?,?,?,?)")
        .run(principal, sourceKey, input.requestId, digest, id);
      this.event(id, principal, "admitted", { source: input.source, purpose: input.purpose, predecessor: same?.id ?? null });
      return this.decision(this.row(id)!, true);
    }).immediate();
  }
  get(principal: string, id: string): Decision {
    const row = this.row(id);
    if (!row || row.principal !== principal) throw Error("Not found");
    return this.decision(row);
  }
  claim(workerId: string, leaseMs = 60000, identityMode: "personal" | "shared" = "personal"): { operationId: string; epoch: number; task: string; repository: string; acceptance: string[]; identityMode: "personal" | "shared" } | null {
    if (leaseMs < 1000 || leaseMs > 300000) throw Error("Invalid lease");
    return this.db.transaction(() => {
      const row = this.db.query("SELECT * FROM work_records WHERE state='queued' AND identity_mode=? ORDER BY created_at,id LIMIT 1").get(identityMode) as WorkRow | null;
      if (!row) return null;
      const epoch = row.lease_epoch + 1;
      this.db.query("UPDATE work_records SET state='running',worker_id=?,lease_epoch=?,lease_expires=?,updated_at=? WHERE id=?")
        .run(workerId,epoch,Date.now()+leaseMs,now(),row.id);
      this.event(row.id,workerId,"claimed",{epoch,leaseMs});
      return { operationId: row.id,epoch,task:row.task,repository:row.repository,acceptance:JSON.parse(row.acceptance_json) as string[],identityMode };
    }).immediate();
  }
  private assertOwner(id: string, workerId: string, epoch: number): WorkRow {
    const row = this.row(id);
    if (!row || row.worker_id !== workerId || row.lease_epoch !== epoch ||
      row.lease_expires === null || row.lease_expires <= Date.now() || row.state !== "running")
      throw Error("Stale or unauthorized worker lease");
    return row;
  }
  heartbeat(id: string, workerId: string, epoch: number, leaseMs = 60000): void {
    this.db.transaction(() => {
      this.assertOwner(id,workerId,epoch);
      this.db.query("UPDATE work_records SET lease_expires=?,updated_at=? WHERE id=?")
        .run(Date.now()+leaseMs,now(),id);
      this.event(id,workerId,"heartbeat",{epoch,leaseMs});
    }).immediate();
  }
  progress(id: string,workerId: string,epoch: number,stage: string,message: string): void {
    if (!["planned","implementing","implemented","testing","tested","committed","pushed","merged","deployed","review"].includes(stage) ||
      !message.trim() || message.length > 2000) throw Error("Invalid progress");
    this.db.transaction(() => {
      this.assertOwner(id,workerId,epoch);
      this.db.query("UPDATE work_records SET stage=?,updated_at=? WHERE id=?").run(stage,now(),id);
      this.event(id,workerId,"progress",{stage,message});
    }).immediate();
  }
  submitReview(id: string,workerId: string,epoch: number,receipts: Array<{ criterion:string;uri:string;sourceId:string }>): void {
    this.db.transaction(() => {
      const row = this.assertOwner(id,workerId,epoch);
      const accepted = JSON.parse(row.acceptance_json) as string[];
      if (receipts.length === 0 || receipts.some(r => !accepted.includes(r.criterion) ||
        !r.uri.startsWith("https://") && !r.uri.startsWith("file://") ||
        !r.sourceId.trim())) throw Error("Missing or invalid evidence receipts");
      for (const r of receipts) {
        this.db.query("INSERT OR IGNORE INTO work_receipts(operation_id,criterion,uri,source_id) VALUES(?,?,?,?)")
          .run(id,r.criterion,r.uri,r.sourceId);
      }
      this.db.query("UPDATE work_records SET state='review_ready',stage='review',lease_expires=NULL,updated_at=? WHERE id=?")
        .run(now(),id);
      this.event(id,workerId,"review_ready",{receiptCount:receipts.length});
    }).immediate();
  }
  markUncertain(id: string,workerId: string,epoch: number,message: string): void {
    if (!message.trim() || message.length>2000) throw Error("Invalid uncertainty reason");
    this.db.transaction(() => {
      this.assertOwner(id,workerId,epoch);
      this.db.query("UPDATE work_records SET state='uncertain',lease_expires=NULL,updated_at=? WHERE id=?").run(now(),id);
      this.event(id,workerId,"outcome_uncertain",{message});
    }).immediate();
  }
  readyWithoutProof(id: string,workerId: string,epoch: number,summary: string): void {
    if (!summary.trim() || summary.length > 2000) throw Error("Invalid review summary");
    this.db.transaction(() => {
      this.assertOwner(id,workerId,epoch);
      this.db.query("UPDATE work_records SET state='review_ready',stage='review',lease_expires=NULL,updated_at=? WHERE id=?").run(now(),id);
      this.event(id,workerId,"review_pending_evidence",{summary});
    }).immediate();
  }
  attachReviewEvidence(id: string,verifier: string, receipts: Array<{criterion:string;uri:string;sourceId:string}>): void {
    this.db.transaction(() => {
      const row=this.row(id);
      if (!row || row.state!=="review_ready") throw Error("Work is not awaiting review");
      const accepted=JSON.parse(row.acceptance_json) as string[];
      if (receipts.length===0 || receipts.length>50 || receipts.some(r =>
        !accepted.includes(r.criterion) || !r.sourceId?.trim() ||
        !/^https:\/\/|^file:\/\//.test(r.uri))) throw Error("Invalid review receipts");
      for(const r of receipts){
        this.db.query("INSERT OR IGNORE INTO work_receipts(operation_id,criterion,uri,source_id) VALUES(?,?,?,?)")
          .run(id,r.criterion,r.uri,r.sourceId);
      }
      this.event(id,verifier,"evidence_attached",{count:receipts.length});
    }).immediate();
  }
  certify(id: string,verifier:string,criterionEvidence: Record<string,string[]>): Decision {
    return this.db.transaction(() => {
      const row=this.row(id);
      if (!row || row.state !== "review_ready") throw Error("Work is not ready for review");
      const criteria=JSON.parse(row.acceptance_json) as string[];
      for(const criterion of criteria){
        const selected=criterionEvidence[criterion];
        if(!Array.isArray(selected) || selected.length===0) throw Error("Missing independently verified criterion: "+criterion);
        for(const uri of selected){
          const existing=this.db.query("SELECT uri FROM work_receipts WHERE operation_id=? AND criterion=? AND uri=?")
            .get(id,criterion,uri);
          if(!existing) throw Error("Verifier cannot certify an unsubmitted receipt");
          this.db.query("UPDATE work_receipts SET verified_at=?,verifier=? WHERE operation_id=? AND criterion=? AND uri=?")
            .run(now(),verifier,id,criterion,uri);
        }
      }
      this.db.query("UPDATE work_records SET state='satisfied',updated_at=? WHERE id=?").run(now(),id);
      this.event(id,verifier,"verified",{criteria});
      return this.decision(this.row(id)!);
    }).immediate();
  }
  reconcileExpired(): number {
    return this.db.transaction(() => {
      const rows=this.db.query("SELECT id,worker_id,lease_epoch FROM work_records WHERE state='running' AND lease_expires<=?")
        .all(Date.now()) as Array<{id:string;worker_id:string;lease_epoch:number}>;
      for(const row of rows){
        this.db.query("UPDATE work_records SET state='uncertain',worker_id=NULL,lease_expires=NULL,updated_at=? WHERE id=?").run(now(),row.id);
        this.event(row.id,"broker","lease_expired_uncertain",{priorOwner:row.worker_id,epoch:row.lease_epoch});
      }
      return rows.length;
    }).immediate();
  }
}
