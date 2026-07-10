# pi-desktop-tag

Oh My Pi extension that turns your desktop into an agent trigger surface.

Press a shortcut (or run `ompk tag`) to capture the current screen, selected region, active browser tab, or selected text, type an instruction, and let `omp` route the task to the right executor: local tools, the IX Bridge browser, a remote hub, or a vision-only answer.

## Quick start

```bash
# Run as a standalone wrapper (starts the gateway and opens the overlay)
bun --cwd=packages/desktop-tag src/cli.ts

# Or load it as an omp extension and use the slash command
omp --extension packages/desktop-tag/src/extension.ts
/tag
```

## Architecture

- `context.ts` — `ContextPacket` capture (screenshot, foreground app, browser URL/DOM, clipboard, selection).
- `router.ts` — intent + capability router that maps a request to an executor and constrained tool set.
- `events.ts` — unified `AgentEvent` protocol consumed by the overlay.
- `worker.ts` — `AgentSession` worker adapter (`omp` as the runtime).
- `gateway.ts` — local HTTP + WebSocket gateway for the overlay.
- `extension.ts` — `omp` extension entrypoint (`/tag` command).
- `cli.ts` — `ompk-tag` wrapper that boots the gateway and overlay.

## Status

This is the Phase 1 desktop delegation surface: screenshot/region/selection capture, a compact web overlay, and `pi` AgentSession execution. Later phases will add the IX Bridge DOM snapshot, Desktop Commander native actions, and hub-based remote routing.
