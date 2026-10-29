# OMPK / T3 handoff readiness investigation

Date: 2026-10-28. Scope: OMPK ACP source fixes and live OMPK/Codex interoperability checks. Installed-provider results are distinguished from validation of the uninstalled source patch.

## Verified baseline

- Checkout branch: `feat/search-tool-active-tools`.
- Installed OMPK: `oh-my-pk/16.4.34`, at `C:\Users\prest\bin\ompk.exe`.
- Checkout coding-agent version: `16.4.34`.
- Installed T3 desktop: `0.1.3`, commit `d2c440312e5f`, inspected from its installed ASAR archives, not assumed from the earlier upstream snapshot.
- The installed T3 bundle constructs a `t3-code` stdio MCP bridge for ACP sessions. It also retains the refusal-before-prompt restoration of unsent handoffs. Refusal alone was not established as a cause of native-session replacement.
- Existing unrelated untracked files were present before this task and were preserved.

## Reproduced OMPK boundary failure

The shared MCP manager normally gives tool discovery 250 ms before returning and leaves slower servers connecting in the background. ACP previously used the same policy. A client could receive `session/new` and send its handoff prompt while the supplied history-recovery tool was still absent.

The regression uses actual ACP SDK streams, `AcpAgent`, a real `AgentSession`, isolated credentials/settings, and a local MCP protocol fixture. With a 700 ms tool-list response and the original window, the initial active tool list omits the history tool. The same tool subsequently appears. This distinguishes delayed discovery from a server that cannot connect.

The red receipt is `.local/handoff-readiness-red.log`: the eventual-availability assertion passes and the initial-availability assertion fails. This is a reproducible prerequisite failure for trimmed handoffs, not proof of which failure affected a particular live conversation.

## Implemented change

ACP requests an initial discovery window of up to five seconds before returning session creation, load, or resume. Fast servers return as soon as discovery completes. Failed servers still degrade without aborting the session. Servers still pending when the window expires produce an explicit log warning and continue registering in the background. The default interactive discovery window remains 250 ms.

The bounded window is a tradeoff: a slow optional client server can now delay ACP readiness by up to five seconds. It does not guarantee tools whose discovery takes longer are present on the first prompt.

## Reproduced disconnect failure

The combined regression run exposed an unhandled `ACP connection closed` rejection after transport shutdown. A separate deterministic test holds a real outgoing bootstrap notification in the stream, closes the transport, and checks that the managed session is disposed. Before the fix it fails with an unhandled rejection; after the fix it passes. Receipts: `.local/handoff-bootstrap-red.log` and `.local/handoff-bootstrap-green.log`.

Deferred bootstrap notifications now contain their rejected writes. Expected shutdowns do not produce a warning, and unexpected failures on a live connection are logged. This fixes an OMPK lifecycle defect relevant to disconnects; it does not establish that it caused the reported live handoff failures.

## Behavioral coverage

- Delayed HTTP history tool is active and callable after creation, load, and resume.
- Delayed legacy stdio history tool exercises the transport used by T3's bridge.
- A tool-list response held beyond the window does not prevent session creation and later registers successfully.
- Calling the advertised normalized alias dispatches the original `t3_thread_read` RPC and recovers distinct fact, decision, and file sentinels.
- Transport closure during a bootstrap write disposes the real session without an unhandled rejection.
- Existing failed-server, unsupported-transport, cancellation, replay, and nonblocking interactive-startup tests remain relevant regression coverage.

OMPK currently normalizes the example tool alias to `mcp__history_t_thread_read`. The outbound RPC preserves `t3_thread_read`; tool-name normalization was not changed.

## Verification and remaining work

The final focused ACP/MCP run passed **142 tests across eight files**, with 549 assertions and no failures. After the T3 round-trip, a fresh run against the current checkout passed the same 142 tests, and package `bun check` passed again, including Biome and type checking, with two pre-existing warnings and four informational diagnostics outside the changed files. `git diff --check` passed. Latest receipts are `.local/handoff-final-tests.log` / `.exit` and `.local/handoff-final-package-check.log` / `.exit`; earlier red/green receipts remain available separately.

One combined run stalled on this Windows/Bun runtime and was stopped by its verified PID. The final combined run uses the existing test-only `.local/acp-test-keepalive.ts` preload. No keepalive was added to production code. The stalled receipt and the subsequent run that exposed the bootstrap defect are preserved separately.

## Live evidence collected during continuation

A read-only query of T3's live `statev2.sqlite` projection found two relevant OMPK-to-Codex records. The handoff into this conversation is marked `injected`, with 7 retained items and 186 omitted items, and its target run completed. The source conversation's other attempt is still `pending`, with 6 retained and 67 omitted items, but its target run was interrupted. Pending state on that interrupted attempt alone does not establish a delivery defect. Sanitized receipt: `.local/handoff-live-trace.json`. The audit opens SQLite read-only and exports metadata/counts, not conversation bodies or credentials.

A separate bounded live receiving-agent pilot exercised this checkout's real ACP agent/session with the existing `openai-codex/gpt-6.1-sol` subscription route. All five cases passed:

- Short inline historical context returned the exact fact, decision, and file sentinels.
- Trimmed historical context called the advertised history tool and returned all three recovered values.
- A resumed session recovered a new delta containing different values, rather than repeating the previous answer.
- Cancellation during a deliberately held history call returned ACP `cancelled`.
- The same session then recovered a third set of values successfully after cancellation.

The pilot checked the persisted final reply and ACP output grouped by message ID. All recorded model routes were `openai-codex` / `openai-codex-responses`; no paid fallback was used. Inputs and history-server responses were synthetic test sentinels. Receipt: `.local/handoff-live-receiver/receipt.json`; driver: `.local/handoff-live-receiver.ts`. An earlier collector incorrectly concatenated separate assistant messages into one JSON document; that collector error was corrected without changing production code. SDK background services kept the first completed pilot host alive; its exact PID and ownership were verified before stopping it, and the final driver exits after its cleanup receipt. No pilot process remains running.

These five pilot cases are live model/OMPK receiving-boundary checks. They do not exercise T3's handoff budgeting or delivery bookkeeping; the separate T3 round-trip below does.

No T3 source, provider registration, installed executable, or pre-existing user thread configuration was changed. Existing subscription authentication was used in place; credentials were not copied into test files or output. The running T3 provider still uses the existing installed OMPK binary.

## Authorized T3 round-trip

After explicit user authorization, one [disposable T3 test thread](t3-thread://v1/mcp:5809eff8-97c4-45d4-bd20-b8da9e531f58) exercised the existing Codex and OMPK subscription routes. No additional provider registration was created. The source facts were introduced only on the sending provider and were not repeated in the receiving prompt.

- Run 2, short Codex to OMPK: all four original fields matched. T3 delivered 3 items inline with no omissions.
- Run 5, short OMPK to Codex: all four new OMPK-origin fields matched. T3 injected 9 items with no omissions.
- Run 7, trimmed Codex to OMPK: a 105,386-character source message was omitted; T3 delivered 3 other items inline. OMPK called the real history reader for that exact omitted item and recovered all four fields.
- Run 9, trimmed OMPK to Codex: a different 105,408-character source message was omitted; T3 injected 4 other items. Codex called the real history reader for that exact item and recovered all four new fields.
- Run 11 was intentionally interrupted during startup, before provider generation started. Run 12 completed afterward and returned the latest four fields correctly. This is startup-interruption recovery, not a claim of mid-generation T3 interruption coverage.

The same OMPK native session was retained across short, trimmed, and post-interruption checks. Codex also retained its native session across its short and trimmed checks. The verifier checks completed run state, exact reply fields, acknowledged delivery, the omitted source item ID, and the matching completed history-tool call. All five checks passed; the controlled startup run is recorded as `interrupted`.

The test used `approval-required` mode. Codex's trimmed history read paused for an MCP approval; after approval completed, the tool read and final answer succeeded. That observed policy pause was not classified as failed delivery or attributed to the original reported problem. Some installed OMPK turns emitted two identical assistant replies; their fields matched, and duplicate-message behavior was not changed in this task.

Receipts: `.local/handoff-roundtrip-verification.json` and `.local/handoff-roundtrip-trace.json`. The read-only verifier is `.local/handoff-roundtrip-verify.ts`. The test thread is archived with no active run or pending requests; its history remains available for inspection. The original source conversation was not repurposed.

## Remaining limitations

- The source patch is uncommitted and has not replaced the installed OMPK binary. Its delayed-startup and disconnect fixes have red/green behavioral tests and live source receiving-agent coverage. The full T3 matrix validates the installed provider, not a deployed patched provider.
- Servers still connecting after five seconds can remain unavailable to the first prompt; this state is now logged and background registration continues.
- Handoffs remain textual context with explicit history recovery. Attachments and native tool/reasoning state are not replayed; complete continuity for those is not claimed.
- Forced live provider refusal and other provider/model combinations were not certified. The tested pair is OMPK `openai-codex/gpt-6.1-sol` and native Codex `gpt-6.1-sol`, using existing subscription authentication without paid fallback.
- No commit, push, merge, deployment, or publication was performed by the coordinating task.
