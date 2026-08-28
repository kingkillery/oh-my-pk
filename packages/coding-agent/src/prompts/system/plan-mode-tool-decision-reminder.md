<system-reminder>
Plan mode ended without a required tool call. Choose one now:
1. Call `{{askToolName}}` for required clarification, or
2. Call `resolve` with `action: "apply"`, `reason`, and `extra: { title: "<slug>" }`.

You MUST choose exactly one next action now:
1. Call `{{askToolName}}` to gather required clarification, OR
2. Write the plan slug/title (`<slug>`, matching `local://<slug>-plan.md`) as plain text to `xd://propose` with `{{writeToolName}}` to finish planning and request approval

You NEVER output plain text in this turn.
</system-reminder>
