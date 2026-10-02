Launch an interactive command through PK-Herdr only. Before terminal creation or control, read and follow `skill://pk-herdr`; if the URI is unavailable, locate and read the installed `pk-herdr/SKILL.md` in the configured skill roots. If the skill is unavailable, stop and report the missing skill. Use the installed CLI's relevant `--help` to verify unfamiliar command syntax. Inside genuine Herdr context, create a background tab in the caller's workspace without changing focus. Outside Herdr, start a unique tool-owned headless session with four-hour idle cleanup and create its workspace without changing focus. Never fall back to psmux, Windows Terminal, or another external console. If the headless server cannot be started without opening a window, stop and ask the user to start it inside a managed pane. Use this tool instead of bash, eval, Start-Process, or wt.exe for interactive terminal launches; ordinary non-interactive commands and CLI help do not need a new terminal.

When a tool creates its own named PK-Herdr session, launch it with `pk-herdr --session <unique-tool-session-name> --session-auto-close-after 4h`. Replace the placeholder with a real unique session name. This applies to OMPK, Codex, and tools or wrappers implemented using PK-Herdr: include the cleanup flag in the actual Herdr launch arguments. Scope subsequent Herdr commands to that same named session. Close resources when the tool finishes; four-hour idle cleanup handles abandoned sessions and saves supported agent resume metadata.

Cleanup stops the entire named session. Do not enable it on the default session or an existing session started by the user. A tab created in the caller's existing workspace does not create a separate session; close that tool's tab or pane when finished.
{{#if skillContent}}
<required-terminal-skill source="{{skillPath}}">
{{skillContent}}
</required-terminal-skill>
{{else}}
The required installed pk-herdr skill is unavailable: {{skillError}}. Terminal launches fail closed until the session loads that skill.
{{/if}}
