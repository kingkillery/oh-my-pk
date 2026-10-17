/**
 * Explicit, single-operation OMPK worker for the central delegation queue.
 * Runs only when an operator launches `bun worker.ts once|watch`.
 * No automatic process provisioning, model selection, or credential escalation.
 */
import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface WorkerConfiguration {
  brokerUrl: string;
  token: string;
  repoRoots: Record<string,string>;
  executable: string;
  logDir: string;
  maxSeconds: number;
  sessionDir?: string;
  identityMode: "personal" | "shared";
}
export interface ClaimedTask {
  operationId: string;
  epoch: number;
  repository: string;
  task: string;
  acceptance: string[];
  identityMode: "personal" | "shared";
}
type Transport = typeof fetch;
function validateBrokerUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname))) {
    throw Error("Broker requires HTTPS unless it is local loopback");
  }
  if (url.username || url.password || url.search || url.hash) throw Error("Unsafe broker URL");
  return url.toString().replace(/\/$/,"");
}
async function post(config: WorkerConfiguration,path:string,body: unknown, transport:Transport): Promise<Record<string,unknown>> {
  const response=await transport(validateBrokerUrl(config.brokerUrl)+path,{
    method:"POST", redirect:"error", signal:AbortSignal.timeout(20000),
    headers:{ authorization:"Bearer "+config.token,"content-type":"application/json" },
    body:JSON.stringify(body),
  });
  if (!response.ok) throw Error("Broker request failed HTTP "+response.status);
  return await response.json() as Record<string,unknown>;
}
export function buildAgentPrompt(task: ClaimedTask): string {
  return [
    "You are executing one OMPK-delegated mission under existing repo AGENTS.md rules and runtime permissions.",
    "Do not claim success unless each acceptance criterion has a concrete evidence reference.",
    "Preserve existing work and sessions. Check the current checkout and prior implementation before making changes.",
    "Do not commit, push, merge, deploy or use paid resources without the existing authorized mission allowing it.",
    "Never copy credentials into transcripts or results. Report blockers honestly.",
    "",
    "Objective: "+task.task,
    "Repository: "+task.repository,
    "Acceptance criteria:",
    ...task.acceptance.map((s,i)=>(i+1)+". "+s),
    "",
    "Return a concise summary with changed files, commands run, observed outcomes, evidence references and remaining blockers.",
    "Finishing this chat turn is not final completion: the separate reviewer must certify evidence.",
  ].join("\n");
}
export async function runOnce(
  config: WorkerConfiguration,
  transport: Transport = fetch,
  execute: (args: {task:ClaimedTask;root:string;prompt:string;config:WorkerConfiguration;signal:AbortSignal})=>Promise<{exitCode:number;log:string}> = executeWithOmPk,
): Promise<"idle" | "review_ready" | "uncertain"> {
  const claim=await post(config,"/v1/delegations/claim",{},transport);
  if (claim.noWork===true) return "idle";
  if(typeof claim.operationId!=="string" || !/^[0-9a-f-]{36}$/.test(claim.operationId) ||
      !Number.isSafeInteger(claim.epoch) || typeof claim.repository!=="string" ||
      typeof claim.task!=="string" || !Array.isArray(claim.acceptance) ||
      !["personal","shared"].includes(String(claim.identityMode))) {
    throw Error("Invalid authenticated broker claim");
  }
  const task=claim as unknown as ClaimedTask;
  const actionBase="/v1/delegations/"+encodeURIComponent(task.operationId);
  if (task.identityMode !== config.identityMode) throw Error("Worker identity mode is not authorized for this claim");
  const report = (action:string,body:unknown) => post(config,actionBase+"/"+action,body,transport);
  const root=config.repoRoots[task.repository.toLowerCase()];
  if(!root) {
    await report("uncertain",{epoch:task.epoch,message:"Repository has no configured trusted workspace"});
    return "uncertain";
  }
  let workspace:string;
  try { workspace=await realpath(root); }
  catch {
    await report("uncertain",{epoch:task.epoch,message:"Configured workspace not available"});
    return "uncertain";
  }
  if (!config.executable || !config.executable.trim()) throw Error("Missing configured OMPK executable");
  await report("progress",{epoch:task.epoch,stage:"implementing",message:"OMPK agent run started in configured workspace"});
  let result: {exitCode:number;log:string};
  const controller=new AbortController();
  let heartbeatFailed=false;
  const heartbeat=setInterval(()=>{
    void report("heartbeat",{epoch:task.epoch}).catch(()=>{
      heartbeatFailed=true;
      controller.abort();
    });
  },15000);
  try {
    result=await execute({task,root:workspace,prompt:buildAgentPrompt(task),config,signal:controller.signal});
  } catch(cause) {
    try {
      await report("uncertain",{epoch:task.epoch,message:"Execution outcome requires reconciliation: "+String(cause).slice(0,400)});
    } catch { /* Expired/invalid lease is reconciled by the broker, never retried here. */ }
    return "uncertain";
  } finally { clearInterval(heartbeat); }
  if(heartbeatFailed) return "uncertain";
  await mkdir(config.logDir,{recursive:true,mode:0o700});
  const logPath=join(config.logDir,task.operationId+".txt");
  await writeFile(logPath,result.log.slice(-2_000_000),{encoding:"utf8",mode:0o600});
  const logDigest=createHash("sha256").update(result.log).digest("hex");
  await report("progress",{epoch:task.epoch,stage:"implemented",
    message:"Agent exited with code "+result.exitCode+"; private run log SHA-256: "+logDigest+"; log: "+logPath});
  if(result.exitCode!==0) {
    await report("uncertain",{epoch:task.epoch,message:"Agent exited unsuccessfully; external effects may still need reconciliation"});
    return "uncertain";
  }
  await report("ready",{epoch:task.epoch,summary:"Agent finished. Review private log "+logPath+" and independently verify acceptance before certification."});
  return "review_ready";
}
async function executeWithOmPk({task,root,prompt,config,signal}: {
  task:ClaimedTask;root:string;prompt:string;config:WorkerConfiguration;signal:AbortSignal;
}): Promise<{exitCode:number;log:string}> {
  const env:Record<string,string>={};
  for(const [key,value] of Object.entries(process.env)) {
    if (value && !key.startsWith("OMPK_DELEGATION_")) env[key]=value;
  }
  const args=[config.executable,"--print","--no-extensions","--cwd="+root,
    "--max-time="+config.maxSeconds,...(config.sessionDir?["--session-dir="+config.sessionDir]:[]),prompt];
  if (!Number.isSafeInteger(config.maxSeconds) || config.maxSeconds<5 || config.maxSeconds>3600) {
    throw Error("Invalid maximum execution duration");
  }
  const processHandle=Bun.spawn({cmd:args,cwd:root,env,stdout:"pipe",stderr:"pipe"});
  const abort=()=>processHandle.kill();
  signal.addEventListener("abort",abort,{once:true});
  const timer=setTimeout(()=>processHandle.kill(),config.maxSeconds*1000+10000);
  try {
    const [output,errors,code]=await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    return {exitCode:code,log:output+"\n--- stderr ---\n"+errors};
  } finally { clearTimeout(timer); signal.removeEventListener("abort",abort); }
}
function fromEnvironment(): WorkerConfiguration {
  const get=(key:string) => {
    const value=process.env[key];
    if(!value) throw Error("Missing "+key);
    return value;
  };
  const parsed:unknown=JSON.parse(get("OMPK_DELEGATION_REPO_PATHS"));
  if (!parsed || typeof parsed!=="object" || Array.isArray(parsed)) throw Error("Invalid repository path mapping");
  const repoRoots:Record<string,string>={};
  for(const [key,value] of Object.entries(parsed)) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(key) || typeof value!=="string") throw Error("Invalid trusted repo mapping");
    repoRoots[key.toLowerCase()]=value;
  }
  return {
    brokerUrl:get("OMPK_DELEGATION_BROKER_URL"),token:get("OMPK_DELEGATION_WORKER_TOKEN"),
    executable:get("OMPK_DELEGATION_OMPK_BIN"),logDir:get("OMPK_DELEGATION_LOG_DIR"),
    repoRoots,maxSeconds:Number(process.env.OMPK_DELEGATION_MAX_SECONDS||"600"),
    sessionDir:process.env.OMPK_DELEGATION_SESSION_DIR,
    identityMode:get("OMPK_DELEGATION_WORKER_MODE")==="shared"?"shared":"personal",
  };
}
if(import.meta.main) {
  const mode=process.argv[2];
  if(mode!=="once" && mode!=="watch") throw Error("Usage: bun worker.ts once|watch");
  const config=fromEnvironment();
  do {
    const result=await runOnce(config);
    process.stdout.write("Delegation worker: "+result+"\n");
    if(mode==="watch") await Bun.sleep(result==="idle"?5000:250);
  } while(mode==="watch");
}
