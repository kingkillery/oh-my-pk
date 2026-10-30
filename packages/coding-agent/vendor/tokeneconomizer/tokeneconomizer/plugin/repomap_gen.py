#!/usr/bin/env python3
"""Host-side aider repo-map generator. Prints the map to stdout.

A separate process, not an import, for two reasons: aider pulls a large dependency tree that
must never enter a hook's (or a harness's) own process, and a generator that crashes or hangs
on a pathological repository then costs one non-zero exit instead of the session.

Usage: repomap_gen.py <src_dir> <map_tokens> [mentioned_idents_csv] [--git] [--cache DIR]

  --git        map the files `git ls-files` lists, in every language aider reads (the plugin's
               live repository), instead of walking the `.py` files of an extracted tree
  --cache DIR  keep aider's tags cache in DIR instead of inside the repository
"""
import os
import sys

from aider.io import InputOutput
from aider.models import Model
from aider.repomap import RepoMap

# Directories that are not the library under test. Their contents rank well (many files,
# many symbols) while never containing the fix, so leaving them in spends the token budget
# on documentation and benchmarks instead of on the code the agent has to change.
SKIP = ("/.git", "/__pycache__", "/.tox", "/build", "/dist", "/.eggs", ".egg-info",
        "/doc/", "/docs/", "/examples/", "/benchmarks/", "/tutorial/", "/asv_benchmarks/")


# Across every language a repository also carries code it did not write: vendored libraries
# and minified assets rank high (big, symbol-dense) and are never what a session works on.
VENDORED = ("/vendor/", "/vendors/", "/third_party/", "/third-party/", "/node_modules/",
            "/bower_components/", "/static/", "/assets/")
MINIFIED = (".min.js", ".min.css", ".bundle.js", "-min.js")
MAX_BYTES = 256 * 1024


def _git_files(repo):
    import subprocess
    out = subprocess.run(["git", "ls-files", "-z"], cwd=repo, capture_output=True,
                         encoding="utf-8", errors="replace")
    files = []
    for f in out.stdout.split("\0"):
        path = "/" + f
        if (not f or any(s in path for s in SKIP + VENDORED) or f.endswith(MINIFIED)):
            continue
        full = os.path.join(repo, f)
        try:
            if os.path.getsize(full) > MAX_BYTES:
                continue
        except OSError:
            continue
        files.append(full)
    return files


def main():
    args = sys.argv[1:]
    use_git = "--git" in args
    cache = args[args.index("--cache") + 1] if "--cache" in args else None
    pos = [a for i, a in enumerate(args)
           if not a.startswith("--") and (i == 0 or args[i - 1] != "--cache")]
    repo = os.path.abspath(pos[0])
    budget = int(pos[1]) if len(pos) > 1 else 2048
    mentioned = set(pos[2].split(",")) if len(pos) > 2 and pos[2] else set()

    if use_git:
        files = _git_files(repo)
    else:
        files = []
        for dirpath, _dirnames, filenames in os.walk(repo):
            if any(s in dirpath for s in SKIP):
                continue
            files.extend(os.path.join(dirpath, f) for f in filenames if f.endswith(".py"))
    if cache:
        # An absolute path: aider joins it onto the repository root, which leaves it as is.
        RepoMap.TAGS_CACHE_DIR = os.path.abspath(cache)

    # stdout is the MAP and nothing else. aider's console writes its progress and warnings
    # to stdout ("Initial repo scan can be slow in larger repos, but only happens once.",
    # model-metadata warnings), and the scaffold takes this process's stdout verbatim as the
    # map body -- so every line aider prints would land in the agent's instructions. Point
    # sys.stdout at stderr while aider is constructed and runs, and write the map afterwards.
    real_stdout, sys.stdout = sys.stdout, sys.stderr
    try:
        io = InputOutput()
        # Used ONLY for its token counter -- no model is called and no key is needed. The
        # map is produced by static analysis; the counter just enforces the budget.
        model = Model("gpt-4o")
        rm = RepoMap(map_tokens=budget, root=repo, main_model=model, io=io, verbose=False)
        text = rm.get_repo_map([], files, mentioned_idents=mentioned) or ""
    finally:
        sys.stdout = real_stdout
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
