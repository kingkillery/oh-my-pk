# Offline JEV embedding experiment

This is an offline-only fixture prototype. Nothing imports it from the live JEV path, so the default is off: normal requests load no artifacts and make no embedding calls. There is no shadow mode or automatic action execution. The watchdog arbiter remains authoritative and admits exactly one intervention for a given state; therefore this fixture does not demonstrate a useful choice among competing actions.

Run the fixture replay with Bun:

```
bun run packages/coding-agent/src/watchdog/embedding-pilot/replay.ts --out <fixture-output.json>
bun test packages/coding-agent/src/watchdog/embedding-pilot/scorer.test.ts
```

The replay is synthetic. It fits a logistic head using only observed action outcomes, selects a similarity threshold on validation fixtures, freezes it, and measures held-out fixtures. The embeddings are marked `fixture:384`; neither labels nor vectors represent live Titan or real cases. It explicitly reports incumbent JEV as unavailable and quality as unproven. Similarity and retrieval baselines are trivial because the trusted arbiter allows only one action. Cost and latency against JEV are unavailable. A trained fixture head must never be used with real vectors.

For a real developer-controlled replay, construct authorized, redacted cases and embeddings using `titan.ts` and `embedDecision`; record timestamps, independent labels, scope, groups and policy identity. Titan sends text to OpenRouter/Amazon Bedrock. `OPENROUTER_API_KEY` must be passed in by the operator; this prototype does not load credentials, export private cases, or persist embeddings automatically. Over-budget or non-ASCII input fails rather than being truncated.

The v2 formatter preserves the entire ASCII question and state in up to 16 ordered 120-character chunks. Each chunk is embedded separately in one bounded batch, normalized, averaged and normalized again. This retains all text but pooling can lose cross-chunk context; its quality is not established. Inputs over 1,920 characters or with unsupported characters fail rather than being truncated. The corpus hash, model revision, 384 dimensions, format version, head version, feature order, scaling, training hash and policy identity bind artifacts. Re-embed, rebuild the corpus and retrain if the model, dimensions, formatting or normalization changes. Restrict corpus files to authorized scope and protect them as sensitive. Rolling back is simply not invoking the offline module; the incumbent and its policy are untouched.

The offline real-data runner accepts a prepared JSON array of `EvaluationRow` objects defined in `evaluate.ts` and writes an aggregate report: `bun evaluate.ts <prepared-dataset.json> <report.json>`. The operator supplies actual versioned embeddings, incumbent results, policy context, time-ordered group-disjoint train/validation/test assignments, independently reviewed labels, and observed action outcomes. Missing outcomes remain null and cannot train the head. It rejects duplicate cases, incompatible vectors, crossed groups, invalid timestamps and untrusted policy fingerprints. Training outcomes must be known before evaluation begins, and independent validation labels must be known before testing begins. The threshold is chosen only on independently labeled validation cases; if fitting or validation is insufficient, the hybrid remains unavailable. Similarity and retrieval baselines are identical under the current single-action arbiter. Reported scoring latency excludes embedding calls. The gate is always unproven until a representative, independently reviewed evaluation is interpreted by a person.

No independent real-case labels, meaningful multi-candidate JEV comparison, production readiness, deployment, shadow lifecycle, live accuracy, or operational acceptance has been demonstrated.
