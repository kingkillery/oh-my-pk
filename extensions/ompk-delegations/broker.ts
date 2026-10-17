/**
 * The sole HTTP ingress for completion-aware delegations.
 * Run as a protected service; never expose a plaintext bearer token publicly.
 * Admitted means durable work queued, not an agent launched.
 */
import { timingSafeEqual, createHash } from "node:crypto";
import { join } from "node:path";
import { WorkLedger, validateIntent } from "./ledger.ts";
export interface BrokerConfiguration {
  requesterToken: string;
  workerToken: string;
  reviewerToken: string;
  principal: string;
  workerId: string;
  workerMode: "personal" | "shared";
  repositories: string[];
  allowShared: boolean;
}
function authorized(actual: string | null, expected: string): boolean {
  if (!actual?.startsWith("Bearer ") || !expected || expected.length < 20) return false;
  const a = createHash("sha256").update(actual.slice(7)).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
function error(message: string, status: number): Response {
  return json({ error: message }, status);
}
export function makeBrokerHandler(ledger: WorkLedger, config: BrokerConfiguration) {
  if (!config.principal || !config.workerId ||
      [config.requesterToken,config.workerToken,config.reviewerToken].some(x=>x.length < 20) ||
      new Set([config.requesterToken,config.workerToken,config.reviewerToken]).size !== 3 ||
      config.repositories.length === 0) throw Error("Missing distinct broker principals and tokens or repository allowlist");
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const auth = request.headers.get("authorization");
    const requester = authorized(auth, config.requesterToken);
    const worker = authorized(auth, config.workerToken);
    const reviewer = authorized(auth, config.reviewerToken);
    if (!requester && !worker && !reviewer) return error("Unauthorized", 401);
    if (request.headers.get("content-length") && Number(request.headers.get("content-length")) > 64000)
      return error("Request too large", 413);
    if (request.method === "GET" && /^\/v1\/delegations\/[0-9a-f-]{36}$/.test(path)) {
      if (!requester && !reviewer) return error("Forbidden", 403);
      try { return json(ledger.get(config.principal, path.split("/").at(-1)!)); }
      catch { return error("Not found", 404); }
    }
    if (request.method !== "POST") return error("Route not found", 404);
    let body: Record<string, unknown>;
    try {
      const data: unknown = await request.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) return error("Invalid request body", 400);
      body = data as Record<string, unknown>;
    } catch { return error("Invalid JSON", 400); }
    try {
      if (path === "/v1/delegations/status" || path === "/v1/delegations/admit") {
        if (!requester) return error("Forbidden", 403);
        const input = validateIntent(body);
        if (!config.repositories.includes(input.target.repository.toLowerCase())) return error("Repository not authorized", 403);
        if (input.identityPreference !== config.workerMode || (input.identityPreference === "shared" && !config.allowShared)) return error("Requested identity is not bound to this broker worker",403);
        if (path.endsWith("/status")) {
          if (input.purpose !== "status") return error("Only status purpose is permitted here", 400);
          return json(ledger.inspect(config.principal,input));
        }
        if (input.purpose === "status") return error("Status requests cannot be admitted",400);
        return json(ledger.admit(config.principal,input.identityPreference,input));
      }
      if (path === "/v1/delegations/claim") {
        if (!worker) return error("Forbidden",403);
        const claimed = ledger.claim(config.workerId,60000,config.workerMode);
        return json(claimed ?? { noWork: true });
      }
      if (path === "/v1/delegations/reconcile") {
        if (!reviewer) return error("Forbidden",403);
        return json({ uncertain: ledger.reconcileExpired() });
      }
      const matched = /^\/v1\/delegations\/([0-9a-f-]{36})\/(heartbeat|progress|review|ready|uncertain|evidence|certify)$/.exec(path);
      if (!matched) return error("Route not found",404);
      const [,id,action] = matched;
      if (action === "evidence") {
        if (!reviewer) return error("Forbidden",403);
        if (!Array.isArray(body.receipts)) return error("Receipts required",400);
        ledger.attachReviewEvidence(id,config.principal+":reviewer",body.receipts as Array<{criterion:string;uri:string;sourceId:string}>);
        return json({ok:true});
      }
      if (action === "certify") {
        if (!reviewer) return error("Forbidden",403);
        const evidence=body.evidence;
        if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return error("Missing verifier evidence",400);
        const mapped: Record<string,string[]> = {};
        for(const [k,v] of Object.entries(evidence)){
          if(!Array.isArray(v) || v.some(x=>typeof x!=="string")) return error("Invalid verifier evidence",400);
          mapped[k]=v as string[];
        }
        return json(ledger.certify(id,config.principal+":reviewer",mapped));
      }
      if (!worker) return error("Forbidden",403);
      const epoch=body.epoch;
      if (typeof epoch !== "number" || !Number.isSafeInteger(epoch)) return error("Invalid epoch",400);
      if (action === "heartbeat") ledger.heartbeat(id,config.workerId,epoch);
      else if (action === "progress") ledger.progress(id,config.workerId,epoch,String(body.stage??""),String(body.message??""));
      else if (action === "uncertain") ledger.markUncertain(id,config.workerId,epoch,String(body.message??""));
      else if (action === "ready") ledger.readyWithoutProof(id,config.workerId,epoch,String(body.summary??""));
      else if (action === "review") {
        if (!Array.isArray(body.receipts)) return error("Receipts required",400);
        ledger.submitReview(id,config.workerId,epoch,body.receipts as Array<{criterion:string;uri:string;sourceId:string}>);
      }
      return json({ ok: true });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "Invalid operation";
      if (/Stale or unauthorized/.test(reason)) return error(reason,409);
      return error(reason,400);
    }
  };
}
function configuration(): BrokerConfiguration {
  const required = (name:string) => {
    const value=process.env[name];
    if (!value) throw Error("Missing configuration: " + name);
    return value;
  };
  return {
    requesterToken: required("OMPK_DELEGATION_REQUESTER_TOKEN"),
    workerToken: required("OMPK_DELEGATION_WORKER_TOKEN"),
    reviewerToken: required("OMPK_DELEGATION_REVIEWER_TOKEN"),
    principal: required("OMPK_DELEGATION_PRINCIPAL"),
    workerId: required("OMPK_DELEGATION_WORKER_ID"),
    workerMode: required("OMPK_DELEGATION_WORKER_MODE") === "shared" ? "shared" : "personal",
    repositories: required("OMPK_DELEGATION_REPOSITORIES").split(",").map(x=>x.trim().toLowerCase()).filter(Boolean),
    allowShared: process.env.OMPK_DELEGATION_ALLOW_SHARED === "1",
  };
}
if (import.meta.main) {
  const host = process.env.OMPK_DELEGATION_BIND || "127.0.0.1";
  if (!["127.0.0.1","localhost","::1"].includes(host) && process.env.OMPK_DELEGATION_TLS_TERMINATED !== "1") {
    throw Error("Non-loopback bind requires authenticated HTTPS reverse proxy");
  }
  const ledger = await WorkLedger.open(process.env.OMPK_DELEGATION_DB || join(process.cwd(), ".ompk", "work-ledger.db"));
  ledger.reconcileExpired();
  const sweep=setInterval(()=>ledger.reconcileExpired(),15000);
  sweep.unref();
  const server = Bun.serve({
    hostname: host, port: Number(process.env.OMPK_DELEGATION_PORT || "8899"),
    fetch: makeBrokerHandler(ledger,configuration()),
    idleTimeout: 15,
  });
  process.stdout.write("Delegation broker listening on " + server.hostname + ":" + server.port + "\n");
}
