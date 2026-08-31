# LocalMesh deployment handoff

This is the non-secret integration contract for the first LocalMesh vertical slice. It describes what a deployment/controller may compose without reimplementing mesh authority.

## Ownership boundary

The LocalMesh packages own the following invariants:

- `mesh-contracts`: canonical task, assignment, receipt, evidence, and artifact shapes and digests.
- `mesh-auth`: signed task and scheduler-assignment envelopes.
- `mesh-orchestrator`: durable task state, scheduler epochs, fencing, receipt finalization, and transactional outbox.
- `mesh-control-api`: signed-task admission, local authorization, and safe task/status/trace projections.
- `mesh-node`: node-local assignment admission, active-computer protection, lifecycle bounds, and execution-port isolation.
- `mesh-receipts` and `mesh-evidence`: worker receipt signatures and assignment-bound evidence-chain verification.

The deployment/controller owns composition only: durable storage location, trusted-key material through injected adapters, local policy wiring, node process lifecycle, and transport clients. It must not duplicate task state, weaken package checks, or treat a transport acknowledgement as execution authority.

## Required composition

Create one durable runtime authority for a deployment scope:

```text
SqliteMeshRuntimeRepository
  -> MeshOrchestrator(receiptVerifierResolver, clock)
  -> MeshControlApi(taskEnvelopeVerifier, authorizer, clock)
```

- The task envelope verifier is a configured, fixed trusted verifier; task-envelope metadata does not select it.
- The receipt verifier resolver is backed by the authoritative assignment record. It returns the expected worker verifier for that lease, never one selected from a receipt signature.
- The clock is controller-owned and used at every durable boundary. Do not use worker-provided timestamps for current lease or scheduler authority.
- Persist and reopen the same repository; do not create an in-memory fallback in a production controller.

Each node is composed separately:

```text
SqliteMeshNodeStateRepository
  -> await MeshNodeAgent.create(options)
```

The node’s trusted scheduler verifier allow-list is fixed local configuration. A received envelope may choose only among a matching entry in that list.

The node-state repository is a distinct, node-local SQLite/WAL inbox and lifecycle-fact store. It is not the controller’s task database and must not be replaced with the package’s in-memory test default in a production node. `MeshNodeAgent.create` binds the store to its own `nodeId` and public key, then re-verifies every persisted signed assignment through the fixed local scheduler verifier allow-list before it will use persisted work.

## Required data flow

1. Accept task ingress only as a signed task envelope with a matching outer idempotency key through `MeshControlApi`.
2. Let the controller’s policy adapter decide only after signature verification succeeds.
3. Acquire the scheduler lease and call `MeshOrchestrator.assign` with a validated assignment. The assignment must be signed by the current scheduler before delivery.
4. Call `await MeshNodeAgent.accept({ task, signedAssignment })`. Never deliver a bare assignment to a node or call lifecycle operations before this admission succeeds.
5. The assigned worker creates a receipt, signs it with its configured worker identity, and submits the signed envelope to `MeshOrchestrator.recordReceipt`.
6. To inspect a completed chain, call `await verifyEvidenceChain` with signed receipt envelopes and a resolver backed by the authoritative assignment store. This is read-only validation, not a completion decision; a self-hashed bare receipt is not evidence.
7. Drain the orchestrator outbox through a transport adapter only after the durable transaction commits. Transport publication is delivery, not a command path.

Node-local lifecycle persistence follows a stricter execution boundary:

- Admission is committed before a capacity slot is reserved for a later explicit `start` call.
- `starting`, `running`, `cancelling`, and `cleaning` intents are committed before the respective execution-port call.
- On a process restart, any of those uncertain states becomes `reconciliation_required`; it retains capacity and rejects lifecycle commands without invoking the execution port. It is never automatically re-run.
- If an execution-port call rejects after an intent was committed, or its post-call lifecycle write cannot be committed, its external effect is treated as uncertain. The node enters `reconciliation_required`, emits no terminal outbox fact, and invokes no more execution-port commands for that assignment in the live process.
- The only built-in resolution is `resolveReconciliationAsLost(assignmentId)`. A deployment may expose it only behind locally authenticated operator control after the workload is stopped/contained, or after the operator consciously accepts detaching from it. It makes one durable `lost` lifecycle fact and local terminal outbox message; it does not retry work, accept a controller instruction, create a signed receipt, or complete a controller task.
- A persisted `admitted` assignment may remain admitted: committing `starting` before the port call proves the execution boundary was not crossed. It still requires an explicit later `start` command.
- A known terminal outcome creates exactly one local `node.lifecycle.terminal` outbox fact in the same transaction. This is not a `SignedExecutionReceiptV1` and cannot complete a controller task; receipt signing and submission remain separate injected integrations.

## Current capability gates

Nostr, Blossom, and other external clients remain injected adapters:

- The Nostr bridge requires relay write, NIP-44, and gift-wrap capabilities before it publishes. Its current inbound method is an integration-side provenance gate, so cryptographic Nostr verification must happen before the caller invokes it.
- The Blossom bridge requires Blossom upload and Nostr authorization capabilities and checks content hashes before and after upload.
- No adapter creates keys, opens network sessions, runs commands, or promotes cloud state on its own.
- Iroh/direct-transfer activation is out of scope for this slice; keep it disabled until its explicit capability and artifact-authorization contract is added.

## Explicitly unsupported controller behavior

Do not advertise cancellation, artifact retrieval, event following, or a durable event-history cursor as working until their durable implementations exist. `mesh-control-api` reports those operations as unsupported today.

Do not add a bypass for local active-computer protection. Node-local policy remains final even if a task or remote controller requests an interactive machine. A signed receipt is a bound worker attestation, not by itself proof of semantic success.

## Acceptance checks for deployment integration

The deployment-side integration is ready for independent review when it demonstrates all of these without live cloud promotion:

- An unsigned or altered task fails before local authorization.
- An unsigned, altered, untrusted, expired, or conflicting scheduler assignment never reaches the execution port.
- A duplicate delivery of the exact same signed assignment is idempotent; a reused assignment ID with a different signed payload is rejected.
- A bare, bad-key, or lease-mismatched receipt cannot complete a task or appear as verified evidence.
- A receipt from an old scheduler epoch or an expired lease cannot finalize work.
- An active interactive computer is not selected or admitted for protected work.
- Outbox publication occurs after durable commit and can be retried without duplicating the underlying task transition.

## Review scope and status

Review the controller as a composition root against the contract above. In particular, verify that its assignment store supplies both the lease and receipt verifier to the evidence resolver, and that it never trusts a key ID or algorithm supplied by the receipt.

This handoff contains no credentials, hostnames, relay URLs, or cloud-promotion instructions. Cloud activation remains a separate, explicitly approved operation.
