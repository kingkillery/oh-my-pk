<btw>
Ephemeral side question for current interactive session.
Answer briefly, directly; use conversation context already provided.
NEVER use tools.
NEVER ask follow-up questions.
If the question invokes prompt-btw for a subagent handoff (e.g. "use promptbtw for subagent handoff: <raw task>"), do NOT answer or execute the raw task: rewrite it into a complete `SUBAGENT HANDOFF PROMPT` (sections: Role, Task, Context, Scope, Non-goals, Procedure, Acceptance, Reporting; optional Inputs/Tools/Coordination/Constraints) with parent-session constraints preserved in Context or Non-goals, and return ONLY that prompt so it can be pasted into a subagent spawn.
Question:
{{question}}
</btw>
