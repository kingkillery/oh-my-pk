# OMPK tooling review — 2026-10-08

Production baseline: `24ea04c60737ae8d5450fa785e0556dde5c5710d`. Its [CI run](https://github.com/kingkillery/oh-my-pk/actions/runs/37591282425) passed. This report records the verified tooling fix bundle prepared from that baseline. Production acceptance remains open until the changes are merged into `main`.

## Reconciliation

- Closed stale reports [#49](https://github.com/kingkillery/oh-my-pk/issues/49), [#66](https://github.com/kingkillery/oh-my-pk/issues/66), and [#42](https://github.com/kingkillery/oh-my-pk/issues/42) after checking the current implementation and available behavioral evidence.
- [PR #93](https://github.com/kingkillery/oh-my-pk/pull/93) already fixed evaluator bindings, shared Python reset ownership, todo persistence, artifact allocation, and Hugging Face file routing. [PR #94](https://github.com/kingkillery/oh-my-pk/pull/94) already fixed URL freshness and SQLite handle retention. Refreshed the stale checkout before editing; did not replay these changes.
- Nineteen reports remain open. Grouped symptoms stay open until their full contract is verified; local fixes do not close production issues.

## Focused fixes

| Report | Confirmed defect and shared fix | Acceptance |
| --- | --- | --- |
| [#52](https://github.com/kingkillery/oh-my-pk/issues/52) | A missing authored path could be rebound to another file. Read headers now carry an unambiguous path; the coding-agent adapter refuses target substitution. Both batch callers share the existing partial-write receipt. | 49 edit/core/ACP tests passed, including missing-target preflight, explicit plan paths, and a failed second write. Existing safe same-file recovery remains covered. Other stale/unseen/block subclaims remain open. |
| [#50](https://github.com/kingkillery/oh-my-pk/issues/50) | Explicit reads added padding and structural rows; grep filtered selectors after result caps. Reuse existing line builders and the range-aware matcher. | 43 selector checks passed, including late matches, disjoint ranges, multiline blank lines, overlapping scopes, and the local file-size guard. Summary/header checks passed 30/30. |
| [#56](https://github.com/kingkillery/oh-my-pk/issues/56) | IRC-reactivated runs had status updates without fresh jobs/results. Reuse the existing monitor, finalizer, and job manager; preserve the initial output and publish a new run handle. | Five real-session checks passed for IRC wake, structured yield, failure, cancellation, and disposal, including peer-suite execution. History/artifact anchors passed 23/23. Image placeholders remain a separate history-format limitation. |
| [#62](https://github.com/kingkillery/oh-my-pk/issues/62) | Injected module bindings collided with declarations; Python writes converted LF on Windows. Reuse one AST inspection and disable write-time newline translation. | Module fixtures 1/1, existing transforms 20/20, Python helper contracts 3/3 passed. Python retains its `Path` return; the prompt now describes it correctly. |
| [#41](https://github.com/kingkillery/oh-my-pk/issues/41) | Root CI omitted the relay package. Add it to the existing native/integration bucket. | Native Linux relay suite 158/158; actual CI dry-run includes the package. A live disposable Podman canary remains required. |

The real skill resolver passed four targeted cases for discovery, namespaced resources, encoded file paths, missing files, and traversal rejection. [#68](https://github.com/kingkillery/oh-my-pk/issues/68) stays open for the separate vault/application contracts. IRC documentation now states its wake-policy and process-local completion boundaries; [#58](https://github.com/kingkillery/oh-my-pk/issues/58) stays open for wider delivery acceptance.

## Verification and remaining priorities

The final combined regression run passed **581 tests / 0 failures / 9 skips** across 63 files, with 2,165 assertions. It covers every changed unit/contract test plus nearby task, yield, grep, edit/ACP, patcher, and import-transform cases. The separately selected delegated integration cases are recorded below. [Combined raw output](C:/Users/prest/AppData/Local/Temp/ompk-review-union-final-8e9cba21.log).

Hashline and coding-agent package checks passed, including type checking; final whitespace checks passed. The coding-agent check reports one existing warning and two informational diagnostics in unchanged decision-model files. [Final coding-agent check](C:/Users/prest/AppData/Local/Temp/ompk-review-agent-check-final2-8e9cba21.log).

The combined run exposed fixture isolation issues: the resumed-task fixture now resets its process globals before each test, and temporary Git repositories set their own newline policy rather than inheriting Windows system conversion. Existing behavioral assertions and system settings remain unchanged.

The vault's historical two-writer count failure does not reproduce in isolation on this baseline: exactly two generation children and two native sessions completed. A preceding digest test used Bun's default five-second deadline; its unfinished work leaked into the next fixture after timeout. Giving that integration case an explicit 30-second deadline, matching the writer case, produced **2 pass / 0 fail / 27 filtered**, 89 assertions, in 21.835 seconds under a 120-second external cap. Both exact output and durable-payload assertions completed. This accepts the two-case repair slice; the wider native campaign remains unaccepted.

Next priorities after this bundle:

1. Verify the remaining edit provenance and block-resolution contracts in #52/#54/#53 with real colliding-path and shifted-code fixtures.
2. Run #41's disposable container canary: denied egress, token absence, and non-`ompk/*` push rejection. Proxy tests alone do not prove container isolation.
3. Finish #56's image/artifact recovery contract and the native campaign's wider containment and acceptance gates.
4. Reproduce #60's stale browser-lane identity and #69's capability-aware startup validation with isolated sessions.

No release, production deployment, or container canary was performed. Required instructions, transport boundaries, and unrelated local work are preserved.
