"""The per-repository envelope: how long a turn that ended well usually runs.

`EnvelopeTracker` learns, from turns that ended well only, a percentile of their lengths (the
envelope past which a stuck trajectory may be acted on) and the detector thresholds on top of
the preset level. A turn's own outcome only ever gates LATER turns. The functions below keep a
tracker in a repository's state store between sessions, under the store's lock, since two
sessions in one repository share it.
"""
import math

from .rules import scaled_thresholds


def _percentile(xs, p):
    """Linear-interpolated p-th percentile of xs (0<=p<=100). xs need not be sorted."""
    if not xs:
        return None
    xs = sorted(xs)
    n = len(xs)
    if n == 1:
        return float(xs[0])
    i = (p / 100.0) * (n - 1)
    lo = int(i)
    frac = i - lo
    if lo + 1 >= n:
        return float(xs[-1])
    return xs[lo] + frac * (xs[lo + 1] - xs[lo])


class EnvelopeTracker:
    """Per-repo resolved-turn envelope AND runtime-learned detection thresholds.

    Envelope: margin * the p<pct> of turn-counts among RESOLVED tasks seen so far. Using a
    PERCENTILE (default p90), not the max, makes the gate robust to a single very-long
    resolve — empirically one 115-turn xarray resolve set a max-based envelope to ~144 and
    disabled the guard for every 40-60-turn spiral below it; p90 ignores that lone outlier
    (envelope ~32) while staying HIGH on repos like matplotlib where long resolves are
    COMMON (so productive-long tasks stay protected). Stays None until >=min_samples
    resolved tasks exist (don't trust a percentile of a handful of points), so we never
    abort on a repo we know little about yet.

    Thresholds: `thresholds()` derives the FULL detector threshold dict from the SAME
    resolved-task history, so the guard adapts to the agent/repo's actual turn scale
    instead of the hardcoded Copilot-scale DEFAULT_THRESHOLDS, whose backstop lies above
    Claude Code's 80-turn cap. Turn-scale gates
    scale DOWN to the learned distribution; signal gates keep DEFAULT as a FLOOR so the
    learned dict is never MORE trigger-happy than the hand-tuned one (resolve-safety). Fed
    only by RESOLVED tasks (same causal rule as the envelope), so a task's own outcome can
    only gate FUTURE tasks, never itself."""
    def __init__(self, margin=None, pct=None, min_samples=None, level="default",
                 frozen_envelope=None):
        # `level` selects the aggressiveness preset (SPIRAL_LEVELS). It sets the BASE
        # thresholds this tracker starts from AND the envelope margin/percentile/min-samples;
        # explicit margin/pct/min_samples args still win over the preset when given.
        self.level = level
        self.base_thr = scaled_thresholds(level)
        self.margin = margin or self.base_thr["envelope_margin"]
        self.pct = pct if pct is not None else self.base_thr["envelope_pct"]
        self.min_samples = (min_samples if min_samples is not None
                            else self.base_thr["envelope_min_samples"])
        # FROZEN envelope (pre-registered hyperparameter): when set, `envelope` returns this
        # value from task 1, bypassing the >=min_samples warm-up. For SHORT streams (Web-Bench
        # = 20 tasks, ~5 resolved at ~25% Pass@1) the percentile never reaches min_samples, so
        # a within-stream-learned envelope would stay None the whole run and the guard would
        # never engage. A frozen scalar (calibrated once from SWE-bench/held-out, IDENTICAL
        # across all streams -- a fixed hyperparameter, NOT a prior pooled across the streams)
        # lets the guard engage while preserving stream independence. None => today's behavior.
        self.frozen_envelope = frozen_envelope
        self.resolved_turns = []   # all RESOLVED tasks' turn counts (for the percentile)
        self.resolved_snaps = []   # per-resolved-task SpiralState.snapshot() dicts (signals)

    def update(self, turns, resolved, snapshot=None):
        """Record a completed task. Only RESOLVED tasks feed the baseline. `snapshot` is an
        optional SpiralState.snapshot() dict (edit_churn/distinct_edit_files/error_outputs/
        stagnation/...) captured from that task's trajectory; when omitted only the
        turn-envelope learns (back-compat with callers that don't reconstruct the state)."""
        if resolved and turns:
            self.resolved_turns.append(turns)
            if snapshot:
                self.resolved_snaps.append(snapshot)

    @property
    def envelope(self):
        if len(self.resolved_turns) < self.min_samples:
            # cold start: fall back to the frozen pre-registered envelope if one was set
            # (short-stream case); else None == "don't trust a handful of points yet".
            return self.frozen_envelope
        return _percentile(self.resolved_turns, self.pct) * self.margin

    def thresholds(self, max_turns=None):
        """Return the detector threshold dict to hand to is_stuck/gate_for_judge/
        assess_abort. Starts from the LEVEL-scaled base (scaled_thresholds(self.level); ==
        DEFAULT_THRESHOLDS for level 'default') and, once >=min_samples RESOLVED tasks
        exist, overrides the learned keys from this stream's resolved-task distribution.
        Before warm-up (or with no data) it returns the base verbatim, so behavior is
        unchanged until the stream has learned enough — exactly like the envelope gating
        None today. Learned signal-gates floor against the SCALED base, so an 'aggressive'
        level genuinely lowers those floors (and 'conservative' raises them). Pass
        `max_turns` (the run's turn cap) to make the hard backstop REACHABLE under the cap."""
        base = self.base_thr
        thr = dict(base)
        env = self.envelope
        # cap-aware backstop: reachable even under a tight turn cap. The Copilot-scale
        # `backstop_mult * envelope` (~110 turns) lies above Claude's 80-turn cap, so it is
        # clamped under 0.9*cap and an extreme outlier still aborts in-cap.
        if env is not None:
            bt = env * thr["backstop_mult"]
            if max_turns:
                bt = min(bt, 0.9 * max_turns)
            thr["backstop_turns"] = bt
        if len(self.resolved_turns) < self.min_samples:
            return thr   # cold start: level-scaled base (+ backstop_turns if env exists)

        # --- turn-scale gates: relative to the learned resolved-turn distribution. On a
        # short-turn agent (Claude p90~35) this drops the judge gate from 18 -> ~10 so the
        # guard can engage before the cap; on a long-turn agent (Copilot p90~150+) the
        # clamp keeps it at the base ceiling (no change). ---
        p90t = _percentile(self.resolved_turns, 90) or 0

        def _clamp(v, lo, hi):
            return int(max(lo, min(hi, round(v))))
        thr["gate_min_turns"] = _clamp(0.6 * p90t, 6, base["gate_min_turns"])
        thr["min_turns"] = _clamp(0.6 * p90t, 8, base["min_turns"])

        # --- signal gates: treat RESOLVED runs as the "normal" band and sit just ABOVE its
        # p90, but never BELOW the (level-scaled) base floor (so the learned dict is never
        # more trigger-happy than the level asks — protects resolve-safety on churny-but-
        # productive repos, where this RAISES the bar). Needs the per-task snapshots. ---
        if self.resolved_snaps:
            def _sig(key):
                return [s.get(key, 0) or 0 for s in self.resolved_snaps]
            thr["edit_churn"] = max(base["edit_churn"],
                                    math.ceil((_percentile(_sig("edit_churn"), 90) or 0) + 1))
            thr["distinct_edit_files"] = max(
                base["distinct_edit_files"],
                math.ceil((_percentile(_sig("distinct_edit_files"), 90) or 0) + 1))
            thr["error_outputs"] = max(
                base["error_outputs"],
                math.ceil((_percentile(_sig("error_outputs"), 90) or 0) + 1))
            thr["gate_error_outputs"] = max(base["gate_error_outputs"],
                                            thr["error_outputs"])
            thr["stagnation"] = max(base["stagnation"],
                                    round(_percentile(_sig("stagnation"), 90) or 0, 3))
        return thr


# ---- the per-repository envelope ---------------------------------------------------------
ENVELOPE_HISTORY = 500      # recent ended-green turns kept for the percentile


# Overrides that shape the envelope itself, passed to the tracker; the rest are pinned over the
# thresholds it returns.
_ENVELOPE_KEYS = {"envelope_margin": "margin", "envelope_pct": "pct",
                  "envelope_min_samples": "min_samples"}


def load_envelope(store, level="default", overrides=None):
    d = store.read("envelope.json") or {}
    ov = overrides or {}
    tracker = EnvelopeTracker(level=level, **{
        arg: ov[key] for key, arg in _ENVELOPE_KEYS.items() if key in ov})
    tracker.resolved_turns = [int(x) for x in d.get("resolved_turns", []) if x]
    tracker.resolved_snaps = [s for s in d.get("resolved_snaps", []) if isinstance(s, dict)]
    return tracker


def thresholds(tracker, overrides=None):
    """The thresholds a turn is checked against: the preset, what this repository's history
    learned on top of it, then a person's pinned values (`<name>`), which win."""
    thr = tracker.thresholds(max_turns=None)
    for key, value in (overrides or {}).items():
        if key not in _ENVELOPE_KEYS:
            thr[key] = value
    if "backstop_mult" in (overrides or {}) and tracker.envelope is not None:
        thr["backstop_turns"] = tracker.envelope * thr["backstop_mult"]
    return thr


def base_thresholds(level="default", overrides=None):
    """The thresholds before any learning: the preset with a person's pinned values on top.
    What `te config show` reports, so the numbers a setting replaces are visible."""
    thr = scaled_thresholds(level)
    thr.update(overrides or {})
    return thr


def save_envelope(store, tracker):
    store.write("envelope.json", {
        "level": tracker.level,
        "resolved_turns": tracker.resolved_turns[-ENVELOPE_HISTORY:],
        "resolved_snaps": tracker.resolved_snaps[-ENVELOPE_HISTORY:]})


def record_turn(store, guard, level="default", stopped_normally=True, overrides=None):
    """Fold a finished turn into the envelope -- under the store lock, since two sessions in
    one repository share it. Only turns that ended green feed it, as only resolved tasks fed
    the experiments' envelope; a turn's own outcome gates only later turns."""
    # The snapshot is of the WHOLE turn (`guard.whole`), not the post-nudge segment: the
    # experiments snapshot a resolved task's full trajectory (`spiral_snapshot(transcript)`).
    with store.locked("envelope"):
        tracker = load_envelope(store, level, overrides)
        tracker.update(guard.cum_turns, guard.resolved_proxy(stopped_normally),
                       snapshot=guard.whole.snapshot())
        save_envelope(store, tracker)
    return tracker
