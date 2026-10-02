# Clef decision model

OMPK treats Clef/SystemOne as a typed **decision service**, not a chat model provider. It accepts
caller-defined `noul`, `choice`, and `score` questions through `POST /v1/systemone`.

## Launch from OMPK

```text
/decision-model launch
```

Defaults:

- model: `clef-flash`
- accelerator: T4
- Colab session: `ompk-clef-decision`
- Tailscale hostname: `clef-inference`
- automatic shutdown: **60 minutes**

Useful overrides:

```text
/decision-model launch --ttl 90m --gpu L4
/decision-model launch --ttl 2h --gpu H100 --model clef
/decision-model status
/decision-model stop
```

The TTL is mandatory. Accepted launch windows are 10–240 minutes; there is intentionally no
`--no-ttl` mode.

## Compute shutoff contract

Before OMPK is allowed to run `colab new`, it:

1. validates that the named Colab session is either absent or already owned by this launcher;
2. creates a Windows Scheduled Task for the cutoff;
3. verifies that task is registered;
4. persists the ownership/cutoff record under `~/.ompk/decision-model/`;
5. only then requests Colab compute.

The cutoff is OS-owned, not an in-process timer. It uses `WakeToRun`, `StartWhenAvailable`,
allows battery operation, and retries the stop every five minutes for 30 minutes. Exiting OMPK
does not cancel the cutoff.

If bootstrap fails, OMPK immediately tries to stop the session. The scheduled cutoff is removed
only when shutdown is confirmed; otherwise it stays armed as the backstop.

## Tailscale credential

The launcher reads one of:

- `TS_AUTHKEY`
- `TAILSCALE_AUTHKEY`

Both `tskey-auth-*` and `tskey-api-*` are accepted. An API access token is used only to mint a
short-lived, one-use, preauthorized ephemeral node auth key before the runtime joins the tailnet.

The credential is passed to the remote bootstrap over command stdin with shell tracing disabled.
It is not written to OMPK's decision-model state file.

## Endpoint discovery

The runtime starts a localhost-only FastAPI service, then publishes it privately with Tailscale
Serve. OMPK discovers the node from local `tailscale status --json`, health-checks `/healthz`,
and routes unpinned SystemOne requests to:

```text
https://clef-inference.<tailnet>.ts.net/v1/systemone
```

Tailscale duplicate-name suffixes such as `clef-inference-1` are also recognized.

If the Colab runtime disappears, the cached endpoint is invalidated. Existing TypeSafe/OpenRouter
SystemOne configuration remains the fallback. Explicitly pinned JEV calls are not silently
substituted with Clef.

## Model loading

The launcher uses Cloudflare's native `joint_schema_model.systemone` implementation.

- `clef-flash` uses 4-bit loading below 24 GB VRAM.
- full `clef` uses 4-bit loading below 60 GB VRAM.
- Hugging Face Xet high-performance downloading is enabled.
- Pillow is force-reinstalled to the validated version before model imports to prevent mixed
  `PIL._typing` installations.

Use `/decision-model status` to see the live endpoint and remaining cutoff window.
