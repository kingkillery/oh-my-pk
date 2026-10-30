"""When a trajectory counts as stuck, and what to do about it.

Three tiers, cheapest first:

  * `gate_for_judge` -- free, every call: is the recent trace worth a paid look at all?
  * a paid judge      -- optional (`judge.llm_stuck_judge`), only when the gate is open;
  * `is_stuck`        -- the strict heuristic decision used when no judge is wired: churn or
                         scatter, AND sustained errors, AND repeated identical failures.

`assess_abort` runs the cascade against a per-repository envelope (how long a turn that ended
well usually runs, `envelope.EnvelopeTracker`) with a hard backstop the judge cannot veto.
`nudge_text` is the redirect the guard sends first: it mirrors only the agent's own actions
back at it, carries no outside knowledge, and never tells it to stop.
"""
# ---- detector thresholds -----------------------------------------------------
# The "stuck" signature (calibrated on the measured separation: spirals showed first-
# 40-turn edit_churn ~6 vs ~1.5 normal, distinct_edit_files ~2.5 vs ~1, error_outputs
# ~9 vs ~3). We require a CONJUNCTION (churn AND errors/scatter AND some repetition)
# so productive-but-hard tasks (high activity, but CHANGING failures) are spared.
DEFAULT_THRESHOLDS = {
    "min_turns": 20,          # don't judge stuck before the solve loop has run a while
    "edit_churn": 4,          # >=4 edits to one file
    "distinct_edit_files": 3,  # OR edits scattered across >=3 files
    "error_outputs": 6,       # sustained error density
    "stagnation": 0.20,       # >=20% of failures are repeats of an earlier one
    "envelope_margin": 1.25,  # restart/abort only beyond margin x the resolved-turn pctl
    "envelope_pct": 90,       # use the p90 of resolved turns (NOT max): one very long
                              # resolve would set a max-based envelope far out (see
                              # EnvelopeTracker); p90 ignores the lone outlier.
    "envelope_min_samples": 5,  # need >=5 resolved tasks before trusting the percentile
    "judge_confidence": 0.7,  # LLM trace-judge must be >=this confident to drive an abort
    "backstop_mult": 2.5,     # HARD backstop: beyond this multiple of the envelope, a
                              # stuck trajectory aborts REGARDLESS of the judge's verdict.
                              # A judge can read multi-file thrashing far past the envelope
                              # as "exploration"; it must not be able to veto such an
                              # outlier.
    # ---- cheap GATE to the judge (Tier-0): permissive "worth a paid look?" trigger.
    # Sensitive on purpose (catch candidates); the judge supplies precision. Far cheaper
    # to evaluate than the judge, and far more permissive than is_stuck (which is the
    # strict heuristic DECISION used only in the no-judge fallback).
    "gate_min_turns": 18,        # don't wake the judge before the loop has had time to form
    "gate_error_outputs": 8,     # OR: a lot of errors even without an exact repeat
}


# A single LEVEL scales the thresholds the guard starts from (the per-repository
# EnvelopeTracker then learns on top, flooring learned signal gates against it). 'default' is
# DEFAULT_THRESHOLDS exactly. 'aggressive' mainly wakes the nudge -- lower judge confidence, an
# earlier gate, `nudge_on_ambiguous` -- and pulls the backstop in modestly (2.5x -> 1.8x);
# 'conservative' spares harder, for churny-but-productive repositories.
#   nudge_on_ambiguous: a judge-AMBIGUOUS trajectory past the envelope gets the redirect
#   (never a stop) instead of being spared outright. Only 'aggressive' sets it.
SPIRAL_LEVELS = {
    "conservative": {
        "judge_confidence": 0.85, "envelope_margin": 1.5, "backstop_mult": 3.5,
        "stagnation": 0.30, "gate_min_turns": 24, "min_turns": 28,
        "edit_churn": 5, "error_outputs": 8, "envelope_min_samples": 7,
    },
    "default": {},   # verbatim DEFAULT_THRESHOLDS — reproduces pre-knob behavior exactly
    "aggressive": {
        "judge_confidence": 0.55, "envelope_margin": 1.0, "backstop_mult": 1.8,
        "stagnation": 0.12, "gate_min_turns": 12, "min_turns": 14,
        "edit_churn": 3, "error_outputs": 4, "envelope_min_samples": 3,
        "nudge_on_ambiguous": True,
    },
}


def scaled_thresholds(level="default"):
    """Return DEFAULT_THRESHOLDS overlaid with the named LEVEL's overrides (see
    SPIRAL_LEVELS). Unknown level falls back to 'default' (verbatim defaults). This is the
    BASE the EnvelopeTracker starts from; per-repo learning floors on top of it."""
    thr = dict(DEFAULT_THRESHOLDS)
    thr.update(SPIRAL_LEVELS.get(level, SPIRAL_LEVELS["default"]))
    return thr


def gate_for_judge(state, thr=None):
    """TIER-0 (free, every turn): cheap rule-based trigger deciding whether the recent
    trace is worth ELEVATING to the paid LLM judge. Permissive — it only needs a sign of
    POSSIBLE trouble after the loop has had time to form: a repeated identical failure
    (the cheapest 'no progress' signal) OR a high error density. Productive trajectories
    (changing failures, few repeats) mostly keep this gate CLOSED, so the judge is rarely
    consulted; the judge then makes the precise stuck-vs-productive call. This separation
    is what keeps the judge from being a per-step tax."""
    thr = thr or DEFAULT_THRESHOLDS
    if state.turns < thr["gate_min_turns"]:
        return False
    return (state.repeated_fail_sigs >= 1
            or state.error_outputs >= thr["gate_error_outputs"])


def is_stuck(state, thr=None):
    """Strict heuristic 'this looks like an unproductive loop' classifier — the DECISION
    used only in the no-judge fallback. Must have run a while AND show churn/scatter AND
    repeated identical failures (stagnation): the last term is what separates a doomed
    spiral from a productive hard grind. (When the judge is wired, gate_for_judge is the
    cheap trigger and the judge is the decision; is_stuck is not used.)"""
    thr = thr or DEFAULT_THRESHOLDS
    if state.turns < thr["min_turns"]:
        return False
    churny = (state.edit_churn >= thr["edit_churn"]
              or state.distinct_edit_files >= thr["distinct_edit_files"])
    noisy = state.error_outputs >= thr["error_outputs"]
    repeating = state.stagnation >= thr["stagnation"]
    return churny and noisy and repeating


def assess_abort(state, envelope=None, judge=None, thr=None):
    """Decide whether to abort, TRACE-FIRST, as an explicit TWO-TIER cascade. Returns
    (abort: bool, reason: str).

    TIER 0 — cheap rule-based GATE (free, every turn): gate_for_judge(). Decides only
        whether the recent trace is WORTH a paid look. Permissive; productive trajectories
        mostly keep it closed, so the judge is rarely consulted (this is what makes the
        judge not a per-step tax).
    TIER 1 — paid LLM JUDGE (only when the gate is open, and the caller additionally
        rate-limits it): reads a leakage-safe digest of the RECENT actions and decides
        stuck-vs-productive. The judge — not the step count — drives the outcome:
          - STUCK, confidence>=judge_confidence -> ABORT, even within the envelope (a
            clearly-doomed loop shouldn't burn tokens up to the envelope first);
          - PRODUCTIVE -> SPARE, even past the envelope (progress shows in the trace);
          - ambiguous -> defer to the envelope fallback.
    FALLBACK — when NO judge is wired (judge=None): the strict is_stuck() heuristic plus
        the per-repo resolved-turn envelope (the Phase-1.5 behavior), so the guard still
        works cheaply without an LLM.
    """
    thr = thr or DEFAULT_THRESHOLDS

    # HARD BACKSTOP (checked BEFORE the judge): an extreme outlier — far past the
    # envelope AND stuck by the strict heuristic — aborts regardless of any judge
    # verdict. The judge cannot veto this; it exists because an LLM judge can read thrashing
    # far past the envelope as "exploration".
    # `backstop_turns` (learned, cap-aware) is preferred when the tracker supplied it, so
    # the backstop stays REACHABLE under a tight turn cap; else fall back to the
    # multiplier-on-envelope form (the Copilot-scale behavior).
    backstop_turns = thr.get("backstop_turns")
    if backstop_turns is None and envelope is not None:
        backstop_turns = envelope * thr["backstop_mult"]
    if (backstop_turns is not None
            and state.turns >= backstop_turns
            and is_stuck(state, thr)):
        return True, (f"backstop:{state.turns}>={backstop_turns:.0f}"
                      f"turns stagnation={state.stagnation:.2f}")

    if judge is not None:
        # TWO-TIER: gate -> judge. The gate opens on the cheap rule-based trigger OR when
        # the trajectory is already PAST this repo's typical resolved length (envelope) —
        # an over-envelope run is worth a paid judge look even without an exact repeated
        # failure yet, which is what lets the guard engage on a short-turn agent whose
        # spirals hit the cap before accumulating a repeat signature.
        # `gate_over_envelope=False` (the plugin's) leaves the gate to the trouble signs alone.
        over_envelope = (envelope is not None and state.turns >= envelope
                         and thr.get("gate_over_envelope", True))
        if not (gate_for_judge(state, thr) or over_envelope):
            return False, "gate-closed"
        try:
            v = judge(state.recent_digest(envelope=envelope))   # caller rate-limits
        except Exception:
            v = None
        if not v:
            return False, "judge-throttled"
        conf = float(v.get("confidence", 0) or 0)
        if v.get("stuck") and conf >= thr["judge_confidence"]:
            return True, f"judge-stuck@{conf:.2f}:{str(v.get('reason',''))[:60]}"
        if v.get("stuck") is False:
            return False, "judge-productive"
        # judge AMBIGUOUS (stuck=None): do NOT abort on the (possibly under-calibrated,
        # early-stream) envelope alone: a resolvable task can run just past an envelope
        # learned from few turns. Ambiguity => SPARE; the hard backstop
        # (2.5x envelope AND is_stuck, checked above) remains the only envelope-driven kill,
        # and it sits well beyond any resolvable task's length.
        return False, "judge-ambiguous-spared"

    # FALLBACK (no judge): strict heuristic + envelope safety gate.
    if not is_stuck(state, thr):
        return False, "not-stuck"
    if envelope is not None and state.turns >= envelope:
        return True, f"envelope:{state.turns}>={envelope:.0f}"
    return False, "stuck-but-within-envelope"


def nudge_text(state):
    """The redirect: mirror the agent's OWN repeated actions back at it. Contains
    nothing but a summary of what it already did — leakage-safe by construction, and
    framed to REDIRECT effort, never to stop it."""
    busiest = max(state.edit_counts.items(), key=lambda kv: kv[1])[0] \
        if state.edit_counts else "one file"
    return (
        "Process check (automated): so far you've made "
        f"{sum(state.edit_counts.values())} edits across "
        f"{state.distinct_edit_files} file(s) (most to `{busiest}`) and run "
        f"{state.test_runs} verification(s), and the same failure has recurred "
        f"{state.repeated_fail_sigs} time(s) without the tests going green. This "
        "looks like a repetitive loop. Do NOT stop — instead step back and try a "
        "MATERIALLY DIFFERENT hypothesis: re-read the failing test's expectation, "
        "consider a different file or root cause than the ones you've been editing, "
        "and verify the new hypothesis directly before editing again.")
