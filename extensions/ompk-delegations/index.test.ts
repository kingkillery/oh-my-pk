import assert from "node:assert/strict";
import { test } from "node:test";
import { delegationRoute, parseDelegationDecision } from "./index.ts";

test("status has a read-only broker route distinct from admission", () => {
  assert.equal(delegationRoute("status"), "/v1/delegations/status");
  assert.equal(delegationRoute("execute"), "/v1/delegations/admit");
  assert.equal(delegationRoute("verify"), "/v1/delegations/admit");
});
test("a status response cannot represent a new admission", () => {
  assert.throws(() => parseDelegationDecision({
    state: "admitted", message: "spawned", operationId: "job1", evidence: []
  }, "status"), /Status-only/);
});
test("a completion without evidence is refused", () => {
  assert.throws(() => parseDelegationDecision({
    state: "satisfied", message: "done", evidence: []
  }, "execute"), /criterion-level evidence/);
});
test("an evidence-backed satisfaction preserves original attribution", () => {
  const result = parseDelegationDecision({
    state: "satisfied", message: "already done", coverage: "index checked",
    evidence: [{ criterion: "merged", uri: "https://example.test/commit/1",
      sourceId: "prior-session-17", verifiedAt: "2026-10-17T00:00:00Z" }],
  }, "execute");
  assert.equal(result.state, "satisfied");
  assert.equal(result.evidence[0].sourceId, "prior-session-17");
});
test("running sessions require an operation identity", () => {
  assert.throws(() => parseDelegationDecision({
    state: "running", message: "working", evidence: []
  }, "status"), /operation identity/);
});
test("unknown history is returned as unknown, not silently satisfied", () => {
  const result = parseDelegationDecision({
    state: "unknown", message: "session index unavailable", evidence: [], coverage: "none"
  }, "status");
  assert.equal(result.state, "unknown");
});
test("invalid receipts fail instead of manufacturing provenance", () => {
  assert.throws(() => parseDelegationDecision({
    state: "satisfied", message: "done", evidence: [{ criterion: "build" }]
  }, "status"), /Unverifiable/);
});

import { resolveDelegation } from "./index.ts";

test("status calls only the observation endpoint and cannot grant work", async () => {
  const oldUrl = process.env.OMPK_DELEGATION_BROKER_URL;
  const oldToken = process.env.OMPK_DELEGATION_TOKEN;
  process.env.OMPK_DELEGATION_BROKER_URL = "https://broker.example.test";
  process.env.OMPK_DELEGATION_TOKEN = "test-only-token";
  try {
    let calls = 0;
    const transport = async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      assert.equal(String(url), "https://broker.example.test/v1/delegations/status");
      assert.equal(init?.method, "POST");
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.purpose, "status");
      assert.equal(sent.source.kind, "pi");
      assert.equal(sent.target.repository, "kingkillery/oh-my-pk");
      return new Response(JSON.stringify({ state: "unknown", message: "no indexed coverage", evidence: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const result = await resolveDelegation("status", {
      task: "Did we finish?", repository: "kingkillery/oh-my-pk",
      acceptance: [], identityMode: "personal",
    }, transport as typeof fetch);
    assert.equal(result.state, "unknown");
    assert.equal(calls, 1);
  } finally {
    if (oldUrl === undefined) delete process.env.OMPK_DELEGATION_BROKER_URL;
    else process.env.OMPK_DELEGATION_BROKER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.OMPK_DELEGATION_TOKEN;
    else process.env.OMPK_DELEGATION_TOKEN = oldToken;
  }
});
test("effectful request requires criteria before making HTTP request", async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    throw new Error("should not dispatch");
  };
  await assert.rejects(resolveDelegation("execute", {
    task: "Build something", repository: "kingkillery/oh-my-pk",
    acceptance: [], identityMode: "personal",
  }, transport as typeof fetch), /acceptance checks/);
  assert.equal(calls, 0);
});
test("independent verification requests an independently observed result", async () => {
  const oldUrl = process.env.OMPK_DELEGATION_BROKER_URL;
  const oldToken = process.env.OMPK_DELEGATION_TOKEN;
  process.env.OMPK_DELEGATION_BROKER_URL = "https://broker.example.test";
  process.env.OMPK_DELEGATION_TOKEN = "test-only-token";
  try {
    const transport = async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://broker.example.test/v1/delegations/admit");
      const sent = JSON.parse(String(init?.body));
      assert.equal(sent.purpose, "verify");
      assert.equal(sent.independentObservationRequired, true);
      return new Response(JSON.stringify({ state: "blocked", message: "requires another reviewer", evidence: [] }));
    };
    const result = await resolveDelegation("verify", {
      task: "Recheck the merged feature", repository: "kingkillery/oh-my-pk",
      acceptance: ["Independent test result"], identityMode: "shared",
    }, transport as typeof fetch);
    assert.equal(result.state, "blocked");
  } finally {
    if (oldUrl === undefined) delete process.env.OMPK_DELEGATION_BROKER_URL;
    else process.env.OMPK_DELEGATION_BROKER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.OMPK_DELEGATION_TOKEN;
    else process.env.OMPK_DELEGATION_TOKEN = oldToken;
  }
});
