import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkLedger, type Intent } from "./ledger.ts";
import { makeBrokerHandler } from "./broker.ts";
const requestToken = "requester-test-credential-123456789";
const workerToken = "worker-test-credential-123456789012";
const reviewerToken = "reviewer-test-credential-123456789";
const config = {
  requesterToken: requestToken, workerToken, reviewerToken,
  principal: "test-org:user-1", workerId: "worker-1", workerMode: "personal" as const,
  repositories: ["kingkillery/oh-my-pk"], allowShared: false,
};
function input(task = "Implement status ledger", purpose: Intent["purpose"] = "execute"): Intent {
  return {
    schema: "ompk.delegation.ingress/v1", requestId: crypto.randomUUID(), purpose,
    source: { kind: "pi", sessionId: "s1" },
    target: { repository: "kingkillery/oh-my-pk" },
    intent: { task, acceptance: ["verified tests", "reviewed commit"] },
    identityPreference: "personal",
  };
}
async function api(handler: (r: Request)=>Promise<Response>, route:string, token:string, body:unknown) {
  const response = await handler(new Request("http://localhost"+route,{
    method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify(body),
  }));
  return { status:response.status, data:await response.json() as Record<string,unknown> };
}
describe("central work ledger + broker", () => {
  let ledger: WorkLedger;
  let handler: ReturnType<typeof makeBrokerHandler>;
  beforeEach(async () => {
    ledger = await WorkLedger.open(":memory:");
    handler = makeBrokerHandler(ledger,config);
  });
  afterEach(() => ledger.close());
  test("status is read-only and does not create work",async ()=>{
    const i=input("Something unknown","status");
    const response=await api(handler,"/v1/delegations/status",requestToken,i);
    expect(response.status).toBe(200);
    expect(response.data.state).toBe("unknown");
    expect(ledger.db.query("SELECT COUNT(*) AS n FROM work_records").get()).toEqual({n:0});
    expect(ledger.db.query("SELECT COUNT(*) AS n FROM work_events").get()).toEqual({n:0});
  });
  test("duplicate exact request and same goal across two sessions join only once",async ()=>{
    const i=input();
    const a=await api(handler,"/v1/delegations/admit",requestToken,i);
    expect(a.data.state).toBe("admitted");
    const replay=await api(handler,"/v1/delegations/admit",requestToken,i);
    expect(replay.data.operationId).toBe(a.data.operationId);
    const other={...i,requestId:crypto.randomUUID(),source:{kind:"pi",sessionId:"s2"}};
    const joined=await api(handler,"/v1/delegations/admit",requestToken,other);
    expect(joined.data.operationId).toBe(a.data.operationId);
    expect(joined.data.state).toBe("running");
    expect(ledger.db.query("SELECT COUNT(*) AS n FROM work_records").get()).toEqual({n:1});
  });
  test("personal identity cannot request shared mode unless configured",async ()=>{
    const res=await api(handler,"/v1/delegations/admit",requestToken,{...input(),identityPreference:"shared"});
    expect(res.status).toBe(403);
  });
  test("identity and repository authorization are checked before write",async ()=>{
    const wrong=await api(handler,"/v1/delegations/admit",requestToken,{
      ...input(),target:{repository:"other-project/repo"},
    });
    expect(wrong.status).toBe(403);
    const unknown=await api(handler,"/v1/delegations/admit","bad-token",input());
    expect(unknown.status).toBe(401);
    expect(ledger.db.query("SELECT COUNT(*) AS n FROM work_records").get()).toEqual({n:0});
  });
  test("worker records stages and evidence; independent reviewer alone can certify",async ()=>{
    const admitted=await api(handler,"/v1/delegations/admit",requestToken,input());
    const claim=await api(handler,"/v1/delegations/claim",workerToken,{});
    expect(claim.data.operationId).toBe(admitted.data.operationId);
    expect(claim.data.epoch).toBe(1);
    const id=String(claim.data.operationId),epoch=claim.data.epoch;
    const update=await api(handler,`/v1/delegations/${id}/progress`,workerToken,{epoch,stage:"implemented",message:"Patch prepared"});
    expect(update.status).toBe(200);
    const evidence=[
      {criterion:"verified tests",uri:"https://example.test/actions/123",sourceId:"CI-123"},
      {criterion:"reviewed commit",uri:"https://example.test/commit/abc",sourceId:"reviewer-45"},
    ];
    const submit=await api(handler,`/v1/delegations/${id}/review`,workerToken,{epoch,receipts:evidence});
    expect(submit.status).toBe(200);
    const premature=await api(handler,"/v1/delegations/status",requestToken,input("Implement status ledger","status"));
    expect(premature.data.state).toBe("partial");
    const deny=await api(handler,`/v1/delegations/${id}/certify`,workerToken,{
      evidence:{"verified tests":[evidence[0].uri],"reviewed commit":[evidence[1].uri]},
    });
    expect(deny.status).toBe(403);
    const certified=await api(handler,`/v1/delegations/${id}/certify`,reviewerToken,{
      evidence:{"verified tests":[evidence[0].uri],"reviewed commit":[evidence[1].uri]},
    });
    expect(certified.data.state).toBe("satisfied");
    expect((certified.data.evidence as unknown[]).length).toBe(2);
    const events=ledger.events(id);
    expect(events.map(e=>e.kind)).toEqual(["admitted","claimed","progress","review_ready","verified"]);
  });
  test("uncertain expired lease never requeues external side effects",async ()=>{
    await api(handler,"/v1/delegations/admit",requestToken,input());
    const claim=ledger.claim("worker-1",1000)!;
    ledger.db.query("UPDATE work_records SET lease_expires=0 WHERE id=?").run(claim.operationId);
    expect(ledger.reconcileExpired()).toBe(1);
    expect(ledger.claim("worker-1")).toBeNull();
    expect(()=>ledger.progress(claim.operationId,"worker-1",claim.epoch,"tested","late")).toThrow(/Stale/);
    const state=ledger.get("test-org:user-1",claim.operationId);
    expect(state.state).toBe("blocked");
    expect(ledger.events(claim.operationId).at(-1)?.kind).toBe("lease_expired_uncertain");
  });
  test("new explicit alternatives preserve prior record and get separate attempts",async ()=>{
    const i=input();
    const a=await api(handler,"/v1/delegations/admit",requestToken,i);
    const b=await api(handler,"/v1/delegations/admit",requestToken,{
      ...i,requestId:crypto.randomUUID(),purpose:"alternative",
    });
    expect(b.data.state).toBe("admitted");
    expect(b.data.operationId).not.toBe(a.data.operationId);
    expect(ledger.db.query("SELECT COUNT(*) AS n FROM work_records").get()).toEqual({n:2});
  });
  test("status cannot accidentally use admission endpoint",async ()=>{
    const result=await api(handler,"/v1/delegations/admit",requestToken,input("unknown","status"));
    expect(result.status).toBe(400);
    expect(ledger.db.query("SELECT COUNT(*) AS n FROM work_records").get()).toEqual({n:0});
  });
  test("worker tokens cannot read arbitrary user status",async ()=>{
    const res=await api(handler,"/v1/delegations/status",workerToken,input("Unknown","status"));
    expect(res.status).toBe(403);
  });
  test("progress rejects unknown stage; keeps old stage and recorded state",async ()=>{
    const result=await api(handler,"/v1/delegations/admit",requestToken,input());
    const claim=ledger.claim("worker-1")!;
    const bad=await api(handler,`/v1/delegations/${claim.operationId}/progress`,workerToken,{
      epoch:claim.epoch,stage:"secret_credential_dump",message:"ignored",
    });
    expect(bad.status).toBe(400);
    expect(ledger.get("test-org:user-1",String(result.data.operationId)).state).toBe("running");
    expect(ledger.events(claim.operationId).map(e=>e.kind)).toEqual(["admitted","claimed"]);
  });
});


test("an idempotency key cannot be reused for a different operation",async ()=>{
  const ledger=await WorkLedger.open(":memory:");
  const first=input("Fix A");
  ledger.admit("principal","personal",first);
  expect(()=>ledger.admit("principal","personal",{...first,intent:{...first.intent,task:"Fix B"}}))
    .toThrow(/Conflicting idempotency/);
  ledger.close();
});
test("worker can finish execution without falsely certifying missing evidence",async ()=>{
  const ledger=await WorkLedger.open(":memory:");
  const admitted=ledger.admit("principal","personal",input());
  const claim=ledger.claim("worker")!;
  ledger.readyWithoutProof(claim.operationId,"worker",claim.epoch,"Output needs review and receipts");
  const state=ledger.get("principal",claim.operationId);
  expect(state.state).toBe("partial");
  expect(state.evidence).toEqual([]);
  expect(ledger.events(claim.operationId).at(-1)?.kind).toBe("review_pending_evidence");
  ledger.close();
});

test("ambiguous status returns candidates without claiming historical completion",async()=>{
  const ledger=await WorkLedger.open(":memory:");
  const accepted=ledger.admit("principal","personal",input("Implement known feature"));
  const question=input("Did we finish the feature?","status");
  const state=ledger.inspect("principal",question);
  expect(state.state).toBe("unknown");
  expect(state.message).toContain(accepted.operationId!);
  expect(state.coverage).toContain("not verified");
  const pinned=ledger.inspect("principal",{...question,target:{...question.target,operationId:accepted.operationId}});
  expect(pinned.operationId).toBe(accepted.operationId);
  expect(pinned.state).toBe("running");
  ledger.close();
});