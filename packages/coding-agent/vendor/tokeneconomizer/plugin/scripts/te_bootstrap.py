"""Locate the `tokeneconomizer` package and run the hook dispatcher (`hook`) or the command line
(`cli`), both in `tokeneconomizer.plugin`.

The package is found, in order:

  1. `$TE_CORE_PATH`                  -- a checkout you point at explicitly;
  2. `<plugin root>/lib`              -- in the repository, a symlink to the package; Claude
                                         Code's install copies the plugin directory into its
                                         cache (even from a local marketplace) and follows it,
                                         so the installed copy is self-contained. In the bundle
                                         `scripts/build_plugin.py` writes, a real copy;
  3. `<plugin root>/..`               -- the repository this plugin directory lives in, for a
                                         checkout whose symlinks were not created (`--plugin-dir`);
  4. the marketplace it came from    -- Codex's install copies the plugin directory but drops
                                         the `lib` symlink; for a copy under
                                         `<CODEX_HOME>/plugins/cache/<marketplace>/...`, the
                                         checkout `config.toml` names as that marketplace's
                                         `source` (the clone a local marketplace was added
                                         from), or Codex's own checkout of a git marketplace,
                                         `<CODEX_HOME>/.tmp/marketplaces/<marketplace>`;
  5. an installed package            -- `pip install` of the repository.

When none has it, a hook answers `{}` as always, and says why once in the plugin's errors.log.

This file must stay importable by any Python 3 so that an old interpreter can still answer a
hook with `{}` instead of a syntax error: no f-strings, no annotations, nothing newer than 3.0.
"""
import os
import re
import sys

MIN_VERSION = (3, 10)

# `source = ...` in Codex's config.toml: a TOML basic string ("...", with escapes) or a literal
# one ('...', as written), which Codex writes for a path with backslashes (0.163.0, Windows).
_SOURCE = re.compile(r'''source\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')''')


def _toml_string(basic, literal):
    r"""A `source` value: a literal string as written; a basic string with its `\\` and `\"`
    undone, any other backslash kept, as a path pasted between double quotes has them."""
    if literal is not None:
        return literal
    return re.sub(r'\\([\\"])', r'\1', basic)


def _without_long_prefix(path):
    r"""`path` without the extended-length prefix Codex puts on a local source on Windows:
    `\\?\C:\src` is `C:\src`, and `\\?\UNC\server\share` is `\\server\share`."""
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith("\\\\?\\"):
        return path[4:]
    return path


def _marketplace_sources(plugin_root):
    """For a Codex install copy (`<home>/plugins/cache/<marketplace>/<plugin>/<version>`), the
    `source` its `config.toml` records for that marketplace (a local one), and the checkout Codex
    keeps of a git one."""
    parts = plugin_root.rstrip(os.sep).split(os.sep)
    if len(parts) < 6 or parts[-4] != "cache" or parts[-5] != "plugins":
        return []
    home, market = os.sep.join(parts[:-5]), parts[-3]
    out = [os.path.join(home, ".tmp", "marketplaces", market)]
    # Claude Code keeps the same cache layout under `~/.claude/plugins/cache/`; on a checkout
    # without symlinks (Windows) the copy has no `lib`, so the package is found in the clone
    # its `known_marketplaces.json` records for this marketplace.
    try:
        import json
        known = json.load(open(os.path.join(home, "plugins", "known_marketplaces.json"),
                               encoding="utf-8"))
        entry = known.get(market) or {}
        source = entry.get("source") or {}
        for cand in (source.get("path"), entry.get("installLocation")):
            if cand:
                out.append(cand)
    except (IOError, OSError, ValueError, AttributeError):
        pass
    try:
        text = open(os.path.join(home, "config.toml"), encoding="utf-8", errors="replace").read()
    except (IOError, OSError):
        return out
    section = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("["):
            section = line.strip("[]").strip().replace('"', "").replace("'", "")
            continue
        m = _SOURCE.match(line)
        if m and section == "marketplaces." + market:
            source = _without_long_prefix(_toml_string(m.group(1), m.group(2)))
            if source:
                out.append(source)
    return out


def _symlink_stub(plugin_root):
    """Where `lib/tokeneconomizer` points when git checked the symlink out as a plain file
    holding its target (Windows without symlink support): the directory holding the package."""
    stub = os.path.join(plugin_root, "lib", "tokeneconomizer")
    try:
        if not os.path.isfile(stub) or os.path.getsize(stub) > 1024:
            return None
        target = open(stub, encoding="utf-8").read().strip()
    except (IOError, OSError):
        return None
    return os.path.dirname(os.path.normpath(os.path.join(plugin_root, "lib", target)))


def core_path():
    plugin_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for cand in ([os.environ.get("TE_CORE_PATH"), os.path.join(plugin_root, "lib"),
                  _symlink_stub(plugin_root), os.path.dirname(plugin_root)]
                 + _marketplace_sources(plugin_root)):
        if cand and os.path.isfile(os.path.join(cand, "tokeneconomizer", "plugin", "hook.py")):
            return cand
    return None


def _say_missing(plugin_root):
    """One line in the plugin's errors.log (not repeated) when the core cannot be found."""
    home = os.environ.get("TOKENECONOMIZER_HOME") or os.path.join(os.path.expanduser("~"),
                                                                  ".tokeneconomizer")
    line = ("bootstrap: the tokeneconomizer package was not found for the plugin at %s; "
            "install from the bundle (scripts/build_plugin.py) or set TE_CORE_PATH\n" % plugin_root)
    path = os.path.join(home, "errors.log")
    try:
        if os.path.exists(path) and line in open(path, encoding="utf-8", errors="replace").read():
            return
        if not os.path.isdir(home):
            os.makedirs(home)
        open(path, "a", encoding="utf-8").write(line)
    except (IOError, OSError):
        pass


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "hook"
    rest = sys.argv[2:]
    if sys.version_info < MIN_VERSION:
        if mode == "hook":
            getattr(sys.stdin, "buffer", sys.stdin).read()     # bytes: no locale to decode with
            sys.stdout.write("{}\n")
            return 0
        sys.stderr.write("TokenEconomizer needs Python >= %d.%d (this is %s); set TE_PYTHON\n"
                         % (MIN_VERSION[0], MIN_VERSION[1], sys.version.split()[0]))
        return 1
    # Everything the plugin writes under its state root is derived from the agents' session
    # logs, which the agents keep private; so are these files.
    os.umask(0o077)
    # Where this plugin is, for the stable launcher the hooks keep (`paths.ensure_launcher`).
    os.environ["TE_PLUGIN_ROOT"] = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    core = core_path()
    if core:
        sys.path.insert(0, core)
    try:
        if mode == "hook":
            from tokeneconomizer.plugin import hook
            return hook.main(rest)
        from tokeneconomizer.plugin import cli
        return cli.main(rest)
    except ImportError:
        if core is None:
            _say_missing(os.environ["TE_PLUGIN_ROOT"])
            if mode != "hook":
                sys.stderr.write("TokenEconomizer: its core package was not found next to the "
                                 "plugin at %s (see ~/.tokeneconomizer/errors.log)\n"
                                 % os.environ["TE_PLUGIN_ROOT"])
                return 1
        if mode == "hook":
            sys.stdout.write("{}\n")
            return 0
        raise


if __name__ == "__main__":
    sys.exit(main())
