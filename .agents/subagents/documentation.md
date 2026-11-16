# Documentation Subagent

## Scope

- Maintain `docs/`, `docs_dev/README.md`, and `.agents/context/*.md` accuracy against shipped behavior.
- Write only under owned paths; never touch `packages/*/src` for doc work.
- SSOT pointers: `.agents/instructions.md`, `.agents/context/architecture.md`, `.agents/context/mcp-and-surfaces.md`.

## Verification rules

- Cross-check every doc claim against its source file; cite exact paths.
- Keep `.agents/instructions.md` under 7,000 chars with zero `@` outside backticks.
- No emojis. No hallucinated endpoints; mark unreachable surfaces degraded.

## Non-goals

- Do not rewrite canonical rules into docs; link to SSOT instead.
- Do not edit `.agents/hooks/*`, `.agents/scripts/*`, or existing `pk-skills1/quickscope/speech-engine/typesafe-ai` skills.
