/**
 * Completion-aware delegation boundary for Pi/OMPK.
 * Client adapter only: authoritative matching and atomic dispatch live on the broker.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@pk-nerdsaver-ai/pi-coding-agent";

export type DelegationPurpose = "status" | "execute" | "verify" | "retry" | "extend" | "alternative";
type DecisionState = "satisfied" | "running" | "partial" | "blocked" | "unknown" | "admitted";
interface EvidenceReceipt {
  criterion: string;
  uri: string;
  sourceId: string;
  verifiedAt: string;
}
interface DelegationDecision {
  state: DecisionState;
  message: string;
  operationId?: string;
  evidence: EvidenceReceipt[];
  coverage?: string;
  sessionUrl?: string;
}
const STATES: readonly DecisionState[] = ["satisfied", "running", "partial", "blocked", "unknown", "admitted"];
const PURPOSES: readonly DelegationPurpose[] = ["status", "execute", "verify", "retry", "extend", "alternative"];
const MAX_TASK_LENGTH = 12000;
const TIMEOUT_MS = 15000;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 2000 ? value : undefined;
}
export function parseDelegationDecision(raw: unknown, purpose: DelegationPurpose): DelegationDecision {
  const data = object(raw);
  if (!data || !STATES.includes(data.state as DecisionState) || !string(data.message)) {
    throw new Error("Invalid delegation decision envelope");
  }
  const state = data.state as DecisionState;
  if (purpose === "status" && state === "admitted") {
    throw new Error("Status-only request unexpectedly admitted an execution");
  }
  const receipts: EvidenceReceipt[] = [];
  if (data.evidence !== undefined && !Array.isArray(data.evidence)) {
    throw new Error("Invalid delegation evidence");
  }
  for (const receipt of (data.evidence ?? []) as unknown[]) {
    const entry = object(receipt);
    if (!entry || !string(entry.criterion) || !string(entry.uri) ||
        !string(entry.sourceId) || !string(entry.verifiedAt)) {
      throw new Error("Unverifiable delegation evidence receipt");
    }
    receipts.push({
      criterion: entry.criterion as string, uri: entry.uri as string,
      sourceId: entry.sourceId as string, verifiedAt: entry.verifiedAt as string,
    });
  }
  if (state === "satisfied" && receipts.length === 0) {
    throw new Error("Completion without criterion-level evidence is not accepted");
  }
  const operationId = string(data.operationId);
  if ((state === "admitted" || state === "running") && !operationId) {
    throw new Error("Missing operation identity");
  }
  return {
    state, message: data.message as string, evidence: receipts, operationId,
    coverage: string(data.coverage), sessionUrl: string(data.sessionUrl),
  };
}
export function delegationRoute(purpose: DelegationPurpose): string {
  if (!PURPOSES.includes(purpose)) throw new Error("Unknown delegation purpose");
  return purpose === "status" ? "/v1/delegations/status" : "/v1/delegations/admit";
}
function configuredBroker(): { base: string; token: string } {
  const configured = process.env.OMPK_DELEGATION_BROKER_URL;
  const token = process.env.OMPK_DELEGATION_TOKEN;
  if (!configured || !token) throw new Error("Delegation broker not configured");
  const url = new URL(configured);
  if (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Delegation broker must use HTTPS except for localhost");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Broker URL must not carry credentials, query or fragment");
  }
  return { base: url.toString().replace(/\/$/, ""), token };
}
export async function resolveDelegation(
  purpose: DelegationPurpose,
  request: { task: string; repository: string; acceptance: string[]; identityMode: "personal" | "shared"; sourceSession?: string; requestId?: string; operationId?: string },
  fetcher: typeof fetch = fetch,
): Promise<DelegationDecision> {
  if (!request.task.trim() || request.task.length > MAX_TASK_LENGTH) throw new Error("Invalid task length");
  if (!/^[\w.-]+\/[\w.-]+$/.test(request.repository)) throw new Error("Use owner/repository");
  if (purpose !== "status" && (request.acceptance.length === 0 || request.acceptance.some(v => !v.trim()))) {
    throw new Error("Execution and verification require explicit acceptance checks");
  }
  const { base, token } = configuredBroker();
  const response = await fetcher(base + delegationRoute(purpose), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({
      schema: "ompk.delegation.ingress/v1",
      requestId: request.requestId ?? randomUUID(),
      purpose,
      source: { kind: "pi", sessionId: request.sourceSession ?? null },
      target: { repository: request.repository, ...(request.operationId ? {operationId:request.operationId} : {}) },
      intent: { task: request.task, acceptance: request.acceptance },
      identityPreference: request.identityMode,
      independentObservationRequired: purpose === "verify" || purpose === "alternative",
    }),
  });
  if (!response.ok) throw new Error("Delegation broker HTTP " + response.status);
  return parseDelegationDecision(await response.json() as unknown, purpose);
}
export default function delegationExtension(pi: ExtensionAPI) {
  const { z } = pi.zod;
  pi.registerTool({
    name: "ompk_delegation",
    label: "OMPK Delegations",
    description: "Completion-aware remote delegation. Status requests MUST use purpose=status (no launches). Execute/retry/verify/extend/alternative are explicit actions, mediated by the broker. Always report evidence limits; never claim completion from a similarity match.",
    parameters: z.object({
      purpose: z.enum(PURPOSES as [DelegationPurpose, ...DelegationPurpose[]]),
      task: z.string().min(1).max(MAX_TASK_LENGTH),
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      acceptance: z.array(z.string().min(1).max(1000)).max(20).default([]),
      identityMode: z.enum(["personal", "shared"]).default("personal"),
      operationId: z.string().uuid().optional(),
    }),
    async execute(_id, params, _onUpdate, ctx) {
      try {
        const decision = await resolveDelegation(params.purpose, {
          task: params.task, repository: params.repository,
          acceptance: params.acceptance, identityMode: params.identityMode,
          sourceSession: ctx.sessionManager.getSessionId(),operationId: params.operationId,
        });
        const execution = decision.state === "admitted"
          ? "A broker-owned operation was admitted."
          : "No new execution admitted by this response.";
        return {
          content: [{ type: "text", text: [decision.message, execution,
            "State: " + decision.state,
            decision.operationId ? "Operation: " + decision.operationId : "",
            decision.coverage ? "Coverage: " + decision.coverage : "Coverage not provided",
            ...decision.evidence.map(e => "Evidence [" + e.criterion + "]: " + e.uri + " (" + e.sourceId + ", verified " + e.verifiedAt + ")"),
          ].filter(Boolean).join("\n") }],
          details: decision,
        };
      } catch (error) {
        return { content: [{ type: "text", text: "Delegation unavailable; no new action confirmed: " +
          (error instanceof Error ? error.message : String(error)) }], isError: true };
      }
    },
  });
  pi.registerCommand("delegations", {
    description: "Show remote delegation setup and usage; does not start work",
    handler: async (_args, ctx) => {
      ctx.ui.notify("OMPK delegations: configure OMPK_DELEGATION_BROKER_URL and OMPK_DELEGATION_TOKEN. Use ompk_delegation with purpose=status for read-only lookup, or purpose=execute for authorized work.", "info");
    },
  });
}
