# LocalMesh (personal ompk extension)

LocalMesh is a signed task/assignment control plane (contracts, scheduler,
durable node runtime, executor gateway, artifact/checkpoint stores). It is
**opt-in and personal**: it lives entirely in this directory and is not part of
oh-my-pk's core.

- **Not a core dependency.** Nothing under `packages/**` imports it. The root
  Bun workspace, root `bun.lock`, root Cargo workspace and root CI never build
  or test it.
- **Own toolchain.** This directory has its own Bun workspace
  (`packages/*`), `bun.lock`, Cargo workspace (`crates/*`) and CI workflow
  (`.github/workflows/localmesh.yml`, which runs only when files here change).
- **Reaches OMPK only as an extension.** The planned bridge (Lane E,
  `docs/prd/localmesh-lane-e-acceptance.md`) is an `omp.extensions` package that
  registers commands/tools through `ExtensionAPI`, loaded like any personal
  extension: `~/.ompk/agent/extensions`, the `extensions:` setting in
  `~/.ompk/agent/config.yml`, or `--extension`. It must not edit
  `packages/coding-agent`. See `docs/extensions.md` and `packages/clips-extension`.

## Status

Lanes A–D are implemented and tested. The bridge extension (Lane E) does not
exist yet. `mesh-control-api` still returns "unsupported" for cancel, artifacts
and follow, and `ompk-mesh` is wired to an unavailable API. No relay, Iroh or
Blossom infrastructure is used; `crates/mesh-iroh` is interface-only.

## Develop

```sh
cd extensions/localmesh
bun install                 # this directory's own workspace and lockfile
bun run check               # biome + tsgo for every package
bun run test                # every package's tests
bun run check:rs && bun run test:rs   # mesh-iroh (clippy -D warnings, fmt, tests)
```

## Layout

- `packages/mesh-*`: TypeScript packages (`@pk-nerdsaver-ai/mesh-*`, all private)
- `crates/mesh-iroh`: capability-gated Iroh transport boundary (no Iroh dependency yet)
- `docs/`: deployment handoff and the lane PRDs (`docs/prd/`)
- `infra/`: example configuration (no live infrastructure)
