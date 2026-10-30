# Loop guard

How the failure-loop guard (see the [main README](../../README.md)) decides, one tool call at a
time.

Per tool call, `turn.TurnGuard`:

1. folds the call into a `state.SpiralState` -- edits per file, files edited, error outputs,
   verification runs, and how often a failure repeats one seen before (edits made through the
   shell count too, `shell_edits.py`);
2. checks a hard backstop: stuck *and* far past this repository's envelope (an unspent
   redirect is still given first);
3. asks `rules.assess_abort`: a free gate decides whether the turn is worth a look; then the
   judge (`judge.py`) decides -- in the plugin always, once the repository has an envelope;
   without a judge (some experiment arms), the strict heuristic `is_stuck` with the envelope
   does;
4. answers the first stuck verdict with a redirect (`rules.nudge_text`, or a judge-written one)
   and starts a fresh segment, so the agent gets a fair window to recover; a later one with an
   `abort` verdict, which the plugin delivers as a notice to the person (it never stops a
   turn).

The **envelope** (`envelope.py`) is a percentile of how long this repository's turns run when
they end well -- the agent stopped on its own and no check after its last edit failed. Only such
turns feed it, and a turn's own outcome only gates later turns. The guard's thresholds start
from a preset (`SPIRAL_LEVELS`), learn on top of it, and can be pinned by hand
(`loopguard.<name>` settings).

| Module | |
|---|---|
| `turn.py` | `TurnGuard`: the guard for one prompt-turn, persisted between hook calls |
| `rules.py` | thresholds and presets, the gate, `is_stuck`, `assess_abort`, the redirect text |
| `envelope.py` | `EnvelopeTracker` and its per-repository storage |
| `state.py` | `SpiralState`, `completed_calls` (one streamed line to finished calls) |
| `shell_edits.py` | files a shell command writes (`sed -i`, redirects, inline Python, ...) |
| `judge.py` | the stuck judge and redirect writer (model calls) |
