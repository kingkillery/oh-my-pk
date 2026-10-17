import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkLedger, type Intent } from "./ledger.ts";
import { makeBrokerHandler } from "./broker.ts";
import { runOnce, buildAgentPrompt } from "./worker.ts";
const requesterToken="requester-test-credential-123456789";
const workerToken="worker-test-credential-123456789012";
const reviewerToken="reviewer-test-credential-123456789";
const config={
  requesterToken,workerToken,reviewerToken,
  principal:"test:user",workerId:"worker-1",workerMode:"personal" as const,
  repositories:["kingkillery/oh-my-pk"],allowShared:false,
};
function input():Intent {
  return {
    schema:"ompk.delegation.ingress/v1",requestId:crypto.randomUUID(),purpose:"execute",
    source:{kind:"pi",sessionId:"unit-test"},
    target:{repository:"kingkillery/oh-my-pk"},
    intent:{task:"Update tests and show proof",acceptance:["tests pass"]},
    identityPreference:"personal",
  };
}
describe("worker process handoff to central records",()=>{
  let ledger:WorkLedger;
  let dir:string;
  let broker: ReturnType<typeof makeBrokerHandler>;
  let client:typeof fetch;
  let workerConfig:{
    brokerUrl:string;token:string;repoRoots:Record<string,string>;executable:string;logDir:string;maxSeconds:number;identityMode:"personal";
  };
  beforeEach(async()=>{
    ledger=await WorkLedger.open(":memory:");
    dir=await mkdtemp(join(tmpdir(),"ompk-ledger-worker-"));
    broker=makeBrokerHandler(ledger,config);
    client=(async (url,options)=>broker(new Request(url,options))) as typeof fetch;
    workerConfig={
      brokerUrl:"http://127.0.0.1:8899",token:workerToken,
      repoRoots:{"kingkillery/oh-my-pk":dir},
      executable:"ompk",logDir:join(dir,"logs"),maxSeconds:30,identityMode:"personal",
    };
  });
  afterEach(async()=>{ledger.close();await rm(dir,{recursive:true,force:true});});
  test("successful worker writes log and waits for independent certification",async()=>{
    ledger.admit("test:user","personal",input());
    let observed=false;
    const result=await runOnce(workerConfig,client,async({root,prompt,task})=>{
      observed=true;
      expect(root).toBe(dir);
      expect(prompt).toContain("tests pass");
      expect(task.identityMode).toBe("personal");
      return {exitCode:0,log:"Implementation prepared, no independent verification yet"};
    });
    expect(observed).toBe(true);
    expect(result).toBe("review_ready");
    const row=ledger.db.query("SELECT id FROM work_records LIMIT 1").get() as {id:string};
    expect(ledger.get("test:user",row.id).state).toBe("partial");
    expect(ledger.events(row.id).map(e=>e.kind)).toEqual([
      "admitted","claimed","progress","progress","review_pending_evidence",
    ]);
    ledger.attachReviewEvidence(row.id,"test:reviewer",[
      {criterion:"tests pass",uri:"https://example.test/ci/123",sourceId:"ci-job-123"},
    ]);
    expect(ledger.certify(row.id,"test:reviewer",{"tests pass":["https://example.test/ci/123"]}).state)
      .toBe("satisfied");
  });
  test("nonzero exit is recorded as uncertain and does not auto retry",async()=>{
    const admitted=ledger.admit("test:user","personal",input());
    const result=await runOnce(workerConfig,client,async()=>({exitCode:42,log:"failed"}));
    expect(result).toBe("uncertain");
    expect(ledger.get("test:user",admitted.operationId!).state).toBe("blocked");
    expect(ledger.claim("worker-1")).toBeNull();
  });
  test("unconfigured repo does not spawn a subprocess",async()=>{
    const admitted=ledger.admit("test:user","personal",input());
    workerConfig.repoRoots={};
    let executed=false;
    const result=await runOnce(workerConfig,client,async()=>{
      executed=true;return {exitCode:0,log:"never"};
    });
    expect(result).toBe("uncertain");
    expect(executed).toBe(false);
    expect(ledger.get("test:user",admitted.operationId!).state).toBe("blocked");
  });
  test("untrusted task remains a single argument; never a shell script",()=>{
    const prompt=buildAgentPrompt({
      operationId:crypto.randomUUID(),epoch:1,repository:"kingkillery/oh-my-pk",
      task:"Audit; rm -rf /",acceptance:["Produce evidence"],identityMode:"personal",
    });
    expect(prompt).toContain("Audit; rm -rf /");
    expect(prompt).toContain("existing repo AGENTS.md rules");
  });
});
