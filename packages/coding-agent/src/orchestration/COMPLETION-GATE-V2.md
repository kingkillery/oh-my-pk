# Completion gate v2: pilot contract

The default remains v1. SDK clients may opt a session into v2 by calling
`session.setCompletionPilot(input)` after its active task contract is set.
The supplied contract must match the active snapshot, and the session must
have persistent storage. Closeout executes the configured checks and flushes a
`completion-pilot-receipt/v2` custom entry to the session journal before
accepting a pass. Pilot commands execute with the session's privileges; review
them before opting in and do not put secrets in the receipt. Clearing the
active task clears the pilot. The separate pilot can also be run with `bun
packages/coding-agent/src/orchestration/completion-pilot-cli.ts pilot.json`.
The JSON input has the shape of `CompletionPilotInput` in `completion-pilot.ts`.
It includes an exact full commit ID, contract, working directory, and explicit
criterion checks. The output is a versioned JSON result; exit 0 means pass,
1 means recoverable or blocked, and 2 means invalid input or execution error.
Save output outside the candidate checkout when retaining a receipt.

V2 does not infer verification or named deliverables from successful tool
results. Partial ledger records do not establish satisfaction; a separate
complete supporting record is required. Every unresolved required blocker
prevents a pass. Callers must exclude nonblocking follow-ups from that list.

The pilot runs each specified test command directly and checks tracked artifact
content against its supplied SHA-256. It requires a clean working tree and the
exact commit both before and after checks. Every criterion needs a passing
check, and every named deliverable needs a matching artifact check. A required
blocker yields blocked. Missing checks remain unproven.

The operator must review the contract, test commands, artifact digests, and
their relationship to the requested outcome before running: the pilot executes
the supplied commands and cannot judge whether they are meaningful. Git-ignored
dependencies and transient changes are not captured by the clean-tree check.
The pilot does not prove deployment, runtime health, data freshness, or human
approval. The standalone CLI prints a receipt but does not save it. Session
reminders remain bounded: a failed gate produces a non-passing receipt and a
reminder, not a guarantee that a model's final prose is truthful. The session
journal must be protected like other session data. Do not enable v2 globally
until the relevant gaps are addressed and observed on a real workflow.
