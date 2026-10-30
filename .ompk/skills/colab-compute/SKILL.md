---
name: colab-compute
description: Launch or reuse Colab compute through OMPK's scoped operator approval and durable cutoff policy.
---

# Colab compute

Inspect existing sessions first. Full/yolo tool access is not permission to allocate compute.

For model inference use `/colab-model --gpu T4 --minutes 60 <model>` or `/decision-model launch --ttl 60m`. For general compute use `bun scripts/colab-compute.ts --account <verified-email> --task <task-id> --model <purpose> --session <owned-session> --gpu T4 --minutes 60` in a managed terminal.

Default total window is 60 minutes. Explicit maximum is 120 minutes including allocation, setup, retries, work and cleanup. Reserve five minutes for confirmed release. The operator chooses approval once or task-scoped experiment preapproval. Match the verified account, model/purpose, accelerator and duration; do not silently broaden scope, upgrade hardware or invoke paid-provider fallback. One runtime at a time; verify release before another allocation. Relaunches preserve the original deadline.

Use the shared controller and verify the OS cutoff before allocation. Do not bypass a refusal using raw `colab new`, a custom CLI wrapper, piped approval or model-authored permission records. Missing operator UI/TTY fails closed. Restarting the harness loses in-memory permission, never renews a runtime's cutoff, and requires approval again.

Keep runtime, model, bridge, provider registration and actual inference evidence separate. Preserve unrelated resources and settings. No computer use or visible console windows unless the user explicitly requests them. Tool-owned PK-Herdr sessions require a unique name and `--session-auto-close-after 4h`.

See [policy](../../../docs/colab-compute-policy.md) for API integration and offline contracts.
