# LocalMesh infrastructure boundary

This directory holds deployment-facing configuration only. It never becomes the
control-plane authority.

- The orchestrator's transactional database owns jobs, leases, fencing, and its outbox.
- Nostr, Iroh, and Blossom are capability-gated delivery or artifact adapters.
- Adapters may transport canonical envelopes and blobs, but may not invoke Docker,
  shell tools, or worker commands directly.
- Configure keys and relay authorization in the host secret manager. Do not put them
  in this directory or in a checkpoint manifest.

`localmesh.example.json` is intentionally non-runnable until a host supplies its
own durable database, secret references, and allowed transport clients.
