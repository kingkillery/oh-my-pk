"""Detached processes on Windows, where a hook's children die with it.

An agent runs each hook inside a Windows job object that kills every process in it when the hook
returns, so `start_new_session` (a no-op on Windows) does not keep a spawned `te` alive. Two
ways out, tried in order:

  1. `CREATE_BREAKAWAY_FROM_JOB`, which works when the job allows breakaway;
  2. otherwise WMI's `Win32_Process.Create`, whose process is a child of the WMI service and so
     outside the job by construction. WMI passes neither the environment nor redirections, so
     the command, its environment and its log are written to a spec file that this module, run
     as a script, reads back (`pythonw winspawn.py <spec>`; `python` where there is no pythonw).

Run as a script, this file imports nothing from the package: the package may not be on
`sys.path` until the spec's `PYTHONPATH` is applied.
"""
import json
import os
import subprocess
import sys
import tempfile

# No DETACHED_PROCESS: it overrides CREATE_NO_WINDOW and leaves `te` with no console, so every
# console child it runs (git, the agent's CLI) opens a visible window of its own. A hidden
# console is inherited by those children instead.
_FLAGS = (0x00000200      # CREATE_NEW_PROCESS_GROUP
          | 0x08000000)   # CREATE_NO_WINDOW
_BREAKAWAY = 0x01000000   # CREATE_BREAKAWAY_FROM_JOB


def _windowless_python():
    """pythonw beside this interpreter, which WMI can start without a console window: the one
    named like it (`python3.13t.exe` -> `pythonw3.13t.exe`), else `pythonw.exe`."""
    folder, name = os.path.split(sys.executable)
    names = ["pythonw.exe"]
    if name.lower().startswith("python"):
        names.insert(0, "pythonw" + name[len("python"):])
    for candidate in names:
        exe = os.path.join(folder, candidate)
        if os.path.isfile(exe):
            return exe
    return sys.executable


def spawn(cmd, cwd, env, log_path):
    """Start `cmd` so that it outlives the hook that started it. Returns whether it started."""
    try:
        with open(log_path, "a", encoding="utf-8") as log:
            subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd=cwd,
                             env=env, creationflags=_FLAGS | _BREAKAWAY, close_fds=True)
        return True
    except OSError:
        pass  # the job forbids breakaway: go through WMI
    return _spawn_wmi(cmd, cwd, env, log_path)


def _spawn_wmi(cmd, cwd, env, log_path):
    fd, spec = tempfile.mkstemp(prefix="te-spawn-", suffix=".json",
                                dir=os.path.dirname(log_path))
    with os.fdopen(fd, "w") as fh:
        json.dump({"cmd": cmd, "cwd": cwd, "env": env, "log": log_path}, fh)
    line = subprocess.list2cmdline([_windowless_python(), os.path.abspath(__file__), spec])
    ps = ("$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments "
          "@{ CommandLine = '%s'; CurrentDirectory = '%s' }; exit $r.ReturnValue"
          % (line.replace("'", "''"), cwd.replace("'", "''")))
    try:
        done = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                              stdin=subprocess.DEVNULL, capture_output=True, timeout=15,
                              creationflags=0x08000000)
    except (OSError, subprocess.SubprocessError):
        done = None
    if done is None or done.returncode != 0:
        try:
            os.remove(spec)
        except OSError:
            pass
        return False
    return True


def _run(spec_path):
    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)
    try:
        os.remove(spec_path)
    except OSError:
        pass
    with open(spec["log"], "a", encoding="utf-8") as log:
        return subprocess.call(spec["cmd"], stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                               cwd=spec["cwd"], env=spec["env"], creationflags=0x08000000)


if __name__ == "__main__":
    sys.exit(_run(sys.argv[1]))
