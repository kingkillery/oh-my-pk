# Colab compute approval and lifetime

Compute permission is independent of ordinary tool approval, including yolo/full access. Ask before every new allocation unless a trusted operator already approved this exact bounded experiment.

- Default total window: 60 minutes. Explicit maximum: 120 minutes. The final five minutes are reserved for shutdown and release verification.
- A task-scoped approval binds model/purpose, current CLI account, accelerator and duration. One runtime at a time. A larger accelerator, different account/model or duration requires fresh approval. No provider fallback.
- The operator can choose Deny, Approve once, or Preapprove this bounded experiment in the harness UI. Missing UI denies allocation. Headless callers must supply a trusted confirmation callback; tool approval mode never grants compute permission.
- Preapproval is held by the task's controller in memory. Harness restart loses approval and asks again; it does not renew a saved runtime cutoff. A verified existing owned runtime retains its original cutoff.
- Retries and relaunches use the original deadline, including time spent allocating, preparing and running. Concurrency stays blocked until release is confirmed. A failed or ambiguous allocation never enables another accelerator automatically.
- The scheduler must echo the exact approved cutoff before allocation. A failed guard prevents launch. Windows is currently the supported native scheduled-cutoff host; other hosts fail closed pending a supported durable guard.

`/colab-model --gpu T4 --minutes 60 <model>` prompts when provisioning is needed. Existing compatible runtimes are inspected first. `/decision-model launch --ttl 60m` uses the same approval policy, and rejects TTL above two hours. Status and stop remain available without allocating compute.

For general compute, use `bun scripts/colab-compute.ts --account <verified-email> --task <task-id> --model <purpose> --session <owned-name> --gpu T4 --minutes 60`. It verifies current CLI identity, checks the named runtime, and requires a direct operator TTY to approve a fresh allocation. Piped approval, --yes and yolo bypass flags are refused. For repeated work, embed `launchApprovedColab` with one ColabComputePolicy instance and trusted harness confirmation; reuse that controller for the whole experiment. The CLI deliberately does not persist permission between separate invocations.

A custom cliCommand is transport configuration, not compute approval. API users of launchColabModel must provide authorizeCompute returning a policy-issued lease after a verified cutoff. A plain object or expired lease is rejected. CPU cache staging continues to refuse unguarded allocation; use the approved general-compute controller first, then reuse its CPU session. Never call raw colab new from a skill to bypass this policy.

Offline contracts are in packages/coding-agent/test/colab-compute-policy.test.ts, colab-model-session.test.ts and decision-model.test.ts. They use fixture command transcripts and injected guards, with no cloud allocation, scheduled task registration, GUI or provider calls.
