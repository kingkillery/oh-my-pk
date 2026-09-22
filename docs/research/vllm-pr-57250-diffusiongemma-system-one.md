# vLLM PR 57250: DiffusionGemma structured generation / System One exploration

**Upstream:** [vllm-project/vllm#57250](https://github.com/vllm-project/vllm/pull/57250)  
**Status observed:** Open, 2026-09-22  
**Scope:** Research only; no production integration decision.

## What the PR proposes

PR 57250 adds experimental DiffusionGemma request controls to vLLM and ships a sample interposer that exposes a prototype `/v1/systemone` endpoint. It explicitly says that endpoint is **not** a standard vLLM endpoint. The purpose is bounded structured decisions—not free-form chat generation—by fixing a token canvas and reading model logprobs for the unpinned answer positions. [PR purpose and endpoint status](https://github.com/vllm-project/vllm/pull/57250)

A request seeds a full diffusion canvas, pins the schema tokens, leaves answer positions unpinned, performs a bounded number of denoising steps, and can return the converging-step canvas without committing it. The client requests exact logprobs for the permitted label token IDs and normalizes those logprobs into choice probabilities. [PR request-field contract](https://github.com/vllm-project/vllm/pull/57250)

The PR identifies three directly usable judgment forms: yes/no (called `noul` in Jev terminology), ordered scale, and multiple choice. The PR also proposes entropy-gated repeated samples when the first read is uncertain. [PR purpose](https://github.com/vllm-project/vllm/pull/57250)

## Essential protocol constraints

- Every permitted answer label must be a **single tokenizer token**. Multi-token semantic answers must be translated to verified single-token aliases such as `A`, `B`, and `C`; otherwise the canvas positions shift. [PR single-token constraint](https://github.com/vllm-project/vllm/pull/57250)
- The client must provide canvas seed token IDs and answer-slot positions. The PR explains this is necessary because the current implementation exposes raw unfixed positions; a future template syntax is anticipated. [PR rationale](https://github.com/vllm-project/vllm/pull/57250)
- `diffusion_read_only` is designed for a probability read: it caps output at the canvas, ignores EOS, emits on the converging step, skips commit-forward, and yields temperature-1 logprobs. [PR field table](https://github.com/vllm-project/vllm/pull/57250)
- `logprob_token_ids` avoids relying on top-k rank: the PR reports that a 26-option question had only 1–8 desired labels in top-k absent exact requested logprobs. [PR field table](https://github.com/vllm-project/vllm/pull/57250)
- A request canvas shorter than the server canvas does not reduce scheduler/sampler cost; a short schema on a wide server costs the same as a server sized to that width. [PR field table](https://github.com/vllm-project/vllm/pull/57250)

## Upstream maturity and runtime evidence

The upstream PR is open and lists five prerequisite PRs: logprob-stash handling, prefill logit rows, converging-step `logprob_token_ids`, Dynamo fallback casting, and DiffusionGemma multimodal support. It should therefore be treated as a pinned experimental stack until upstream lands the series. [Prerequisites](https://github.com/vllm-project/vllm/pull/57250)

The demonstrated command serves `nvidia/diffusiongemma-26B-A4B-it-NVFP4` with vLLM diffusion configuration, prefix caching, async scheduling, and a 32-token canvas. Its reported test environment is one DGX Spark with no competing GPU process. That demonstrates the author’s environment only; it does **not** establish support for OMPK's current llama.cpp/Colab L4 setup. [PR test plan](https://github.com/vllm-project/vllm/pull/57250)

The author reports 54 requests/s at 32-way concurrency (about 162 decisions/s for three decisions/request) in a cache-aware benchmark. This is upstream self-reported performance, not an OMPK benchmark. [PR results](https://github.com/vllm-project/vllm/pull/57250)

## Relevance to Oh My PK

OMPK already has two relevant, separate capabilities:

1. A Colab profile/runtime system that currently serves DiffusionGemma through a llama.cpp GGUF wrapper.
2. A typed System One client in `packages/coding-agent/src/lib/typesafe-http.ts`, with a local evaluation corpus under `evals/typesafe-jev/`.

Those should remain separate. PR 57250 describes a vLLM/NVFP4 System One runtime, while the existing Colab DiffusionGemma setup is an OpenAI-compatible llama.cpp text-generation endpoint. Registering the proposed runtime as another normal chat model would leak protocol controls and unsupported semantics into the chat ModelRegistry.

The recommended integration seam is a `SystemOneBackend` module with two adapters:

```text
SystemOneBackend
├─ RemoteTypeSafeBackend
└─ ColabDiffusionGemmaBackend
```

The Colab adapter alone should own canvas construction, tokenizer validation, position pinning, vLLM request fields, logprob normalization, uncertainty retries, and conversion back into the existing typed System One result. Callers should retain a single `systemOne(state, questions, options)` interface.

## Recommended experimental lane

1. Add a distinct, opt-in `diffusiongemma-jev` Colab setup type; do not modify the existing llama.cpp DiffusionGemma setup.
2. Pin a tested upstream vLLM revision plus every required prerequisite, and require a runtime capability probe before registration.
3. Expose only a private `/v1/systemone` interposer plus health/capabilities—not a general chat model.
4. Implement one `noul` request first. Reject labels that cannot be represented by one verified token.
5. Add contract tests for token aliases, malformed/missing logprobs, probability normalization, low-confidence retry/escalation, and failed capability probes.
6. Evaluate the adapter with the existing `evals/typesafe-jev/` corpus before adding Choice, Score, batching, or any user-facing default.

## Open questions to resolve by measurement

- Which available Colab accelerator and vLLM build can actually serve the NVFP4 model and this diffusion stack?
- What end-to-end latency, throughput, and probability calibration hold on that target after tunnel overhead?
- What canvas width and prefix-cache policy are acceptable for OMPK's expected batch shapes?
- Does the upstream prototype's response schema remain stable through merge, or must OMPK own and version its interposer contract?
