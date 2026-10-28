# Opt-in watchdog case collection

This feature is disabled unless `OMP_WATCHDOG_CASE_DIR` is set to an absolute, existing local directory in the OMPK process environment. Set it only for a deliberately selected run. Unset it or restart OMPK without it to stop collection; it is not a settings default. Running a previously installed executable does not pick up source changes until the user builds or installs a version containing them.

**The files contain raw watchdog state.** State can include assignment text, file paths, command fragments and error messages, and may contain secrets or private data. Use only authorized, non-sensitive work and a private directory outside version control, sync folders and shared locations. On Windows, restrict the directory's ACL before enabling collection; POSIX mode bits alone do not configure a Windows ACL. Do not transmit files or embeddings without separate data-scope approval. Do not commit them.

In the existing PK-Herdr session used to launch the source build, set the environment variable for that process only. For example, after creating and securing a directory, in that existing session:

```powershell
$env:OMP_WATCHDOG_CASE_DIR = 'C:\path\to\private\watchdog-cases'
# Start the OMPK source entry point in this same session:
& 'C:\Users\prest\.bun\bin\bun.exe' run 'C:\dev\Infra\oh-my-pk\packages\coding-agent\src\cli.ts'
# When finished, remove the variable before launching another run:
Remove-Item Env:OMP_WATCHDOG_CASE_DIR
```

Each participating in-process subagent monitor creates a uniquely named JSONL file only after its first watchdog observation. Decision rows record an opaque case ID and run group, subagent ID and session file path when available, decision-time state, timing, the incumbent evaluation, the action and whether it was applied, requested, or unavailable, and numeric policy thresholds. The session path is sensitive and may be absent. Configuration secrets and generated hint text are not stored as fields. A terminal row records only the run exit status and timing; this is not a judgment that the intervention worked. Runs that never reach evaluation produce no case. Crashes, late evaluations, write failures, and unfinished runs can leave incomplete records; absence of a terminal row means unknown. At most 100 decisions per monitor are written; the terminal row counts dropped decisions. State over 8192 characters is omitted rather than truncated. Disk writes are asynchronous and best effort; collection must not change the watchdog decision. Local write failure logs a generic warning and stops collection for that run.

The run UUID is a starting group, not proof that separate runs are unrelated. Before evaluation, inspect provenance and group related retries together. The raw event format is not a labeled evaluation dataset. A reviewer must redact each state without losing decision-critical facts, check action delivery and observed outcomes using source evidence, independently label it without the experimental output, and record when evidence became known. Preserve unknowns; run exit status is not an action-effectiveness label. Use the separate labeling template and audit. The current Titan adapter rejects inputs over 120 ASCII characters including question and state; do not silently truncate or automatically export raw state.

Collection does not run an embedding model, issue a second incumbent request, turn on shadow mode, or authorize production use. The comparison remains unrun until enough independently labeled, chronologically and group-separated cases exist, and the real-data evaluation runner is completed.
