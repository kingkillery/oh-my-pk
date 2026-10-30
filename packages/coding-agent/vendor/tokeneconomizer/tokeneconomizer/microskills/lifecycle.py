"""The lifecycle every learned fact goes through, whoever proposed it.

A fact is a CANDIDATE until it is confirmed on K_PROMOTE tasks -- tasks that edited different
files, for a fact about the code (stable across the repository's history, not one task's
coincidence); any K_PROMOTE tasks, for a fact about the environment, which does not change with
the files a task edits (`drift=False`). It is then ACTIVE until a
recency-weighted score, with contradictions weighted LAMBDA times a confirmation, falls below the
floor -- or at once, for a high-stakes fact, on one clean contradiction. An ACTIVE fact is
injected only while it clears the FIRING GATE: the waste it prevents occurred (or, once injected,
kept being prevented) on at least FIRE_GATE of the tasks that exercised it.
"""
import os

# ---- lifecycle knobs (the validated replay constants) ----------------------
K_PROMOTE   = 3      # confirmations (drifted, where drift applies) to promote -> ACTIVE
GAMMA       = 0.8    # recency decay per task-ago
LAMBDA      = 5.0    # contradiction weight (asymmetry: fail toward retirement)
SCORE_FLOOR = 0.0    # retire ACTIVE when recency score < floor
HARD_KILL   = True   # high-stakes fact: single clean contradiction retires now
FIRE_GATE   = 0.40   # inject only if firing rate on this repo >= 40%
FIRE_MIN_N  = 4      # ...measured over at least this many exercised tasks


def edited_pyfiles(calls):
    fs = set()
    for tool, args, _ in calls:
        if tool in ("edit", "multiedit", "write", "create", "str_replace_editor"):
            p = args.get("file_path") or args.get("path") or ""
            if p.endswith(".py"):
                fs.add(os.path.basename(p))
        elif tool == "apply_patch":
            for p in args.get("paths") or ():
                if p.endswith(".py"):
                    fs.add(os.path.basename(p))
    return fs


def edited_files(calls):
    """Every file an edit tool wrote, by basename, whatever its language: the plugin's reading
    (`Vocabulary.generic`). The experiments count Python files only (`edited_pyfiles`)."""
    fs = set()
    for tool, args, _ in calls:
        if tool in ("edit", "multiedit", "write", "create", "str_replace_editor"):
            p = args.get("file_path") or args.get("path") or ""
            if p:
                fs.add(os.path.basename(p))
        elif tool == "apply_patch":
            for p in args.get("paths") or ():
                fs.add(os.path.basename(p))
    return fs


class Lifecycle:
    def __init__(self, key, high, drift=True):
        self.key = key
        self.high = high
        self.drift = drift                 # promotion needs confirmations on different files
        self.state = "CANDIDATE"           # CANDIDATE | ACTIVE | RETIRED
        self.confirms = []                 # [(task_idx, [edited_files])]
        self.contradicts = []              # [task_idx]
        self.fire_num = 0                  # tasks where the waste occurred (fired)
        self.fire_den = 0                  # tasks where the fact was exercised
        self.promoted_at = None
        self.retired_at = None

    def to_dict(self):
        return {"key": self.key, "high": self.high, "drift": self.drift, "state": self.state,
                "confirms": self.confirms, "contradicts": self.contradicts,
                "fire_num": self.fire_num, "fire_den": self.fire_den,
                "promoted_at": self.promoted_at, "retired_at": self.retired_at}

    @classmethod
    def from_dict(cls, d):
        f = cls(d["key"], d["high"])
        f.__dict__.update(d)
        return f

    def _drifted_confirms(self):
        if not self.drift:
            return len(self.confirms)
        kept = []
        for idx, fs in self.confirms:
            fs = set(fs)
            if not fs or all(len(fs & set(k)) == 0 for _, k in kept):
                kept.append((idx, fs))
        return len(kept)

    def score(self, now):
        s = sum(GAMMA ** (now - i) for i, _ in self.confirms)
        s -= LAMBDA * sum(GAMMA ** (now - i) for i in self.contradicts)
        return s

    def firing_rate(self):
        return (self.fire_num / self.fire_den) if self.fire_den else 0.0

    def injectable(self):
        """ACTIVE and clears the firing gate -> goes into the rendered manual."""
        return (self.state == "ACTIVE"
                and self.fire_den >= FIRE_MIN_N
                and self.firing_rate() >= FIRE_GATE)

    def update(self, now, verdict, fired, exercised, files):
        if exercised:
            self.fire_den += 1
            if fired:
                self.fire_num += 1
        if verdict == "confirm":
            self.confirms.append((now, sorted(files)))
        elif verdict == "contradict":
            self.contradicts.append(now)
        if self.state == "CANDIDATE":
            if self._drifted_confirms() >= K_PROMOTE:
                self.state, self.promoted_at = "ACTIVE", now
        elif self.state == "ACTIVE":
            hard = self.high and verdict == "contradict" and HARD_KILL
            if hard or self.score(now) < SCORE_FLOOR:
                self.state, self.retired_at = "RETIRED", now
