# Fusion Mode and Decision Routing

Fusion is `oh-my-pk`'s mid-session model-routing engine (Devin-Fusion architecture). It pairs a primary frontier agent with a persistent, cost-effective sidekick and dynamically switches model tiers at compaction boundaries. Because compaction invalidates the message-segment cache during history rewrites, switching the main model at that exact boundary incurs zero marginal cache-eviction penalty.

---

## Operating Modes

Fusion operates in two distinct configurations:

1. **Binary Mode (Default without pool)**:
   Switches between two model tiers:
   - **Frontier / Strong**: The session's primary model (used for ambiguity, architecture, planning, and high-risk changes).
   - **Compact / Cheap**: Configured via `fusion.compactModel` (used for settled, mechanical coding and lint passes).

2. **Pool Mode (`fusion.modelPool` with 2+ tiers)**:
   Maintains a tiered ranking of available models (Tier 1 = most powerful … Tier 5 = fastest / least expensive). The router evaluates the compaction summary and conversation window, choosing the exact tier for the subsequent stretch of work.

---

## Decision Routing vs. Dynamic Classifier

Fusion provides two routing engines for deciding when to switch tiers:

### 1. Fast Decision Model Routing (`fusion.decisionRouting`)
Routes the fusion pool using a specialized decision model. It reads the compaction summary, trailing messages, and available pool criteria to judge whether the current task warrants a tier upgrade or downgrade:
- **High-complexity, security audits, or architectural shifts**: Keeps or escalates to Tier 1.
- **Normal code implementation & refactoring**: Selects balanced mid tiers (Tier 2–3).
- **Settled work, test verification, formatting, or documentation**: Downgrades to high-throughput, low-cost tiers (Tier 4–5).

### 2. Standard Heuristic Classifier (`fusion.dynamicRouting`)
Uses prompt feature extraction (keyword density, token estimates, tool error streaks) to select a tier when a decision model endpoint is not configured.

---

## Global Decision Router vs. Fusion Pool Decision Router

| Feature | Global Router (`/v1/route`) | Fusion Pool Decision Router (`/fusion pool decision on`) |
|:---|:---|:---|
| **Available Models** | **Global Preferred Pool** (Kimi K3.1 Pro, Minimax M3.1 Flash, DeepSeek Flash, Flint, Nemotron Ultra, Gemini 3.8 Flash, GPT-6 Terra) | **User-Selected Pool** (Specifically the 2–5 models you assign to `fusion.modelPool`) |
| **Activation** | HTTP API or `scripts/fast-decision-dispatch.ts` | `/fusion decision on` or `/fusion pool decision on` |
| **Routing Boundary** | Per-request / per-turn | At session compaction boundaries |
| **Target Use Case** | External dispatch, API integrations, script routing | Mid-session interactive paired execution within `omp` |

---

## Slash Commands Reference

Use `/fusion` inside any interactive session to inspect, configure, and toggle Fusion:

```text
/fusion [on|off|status|mode <...>|routing <on|off>|decision <on|off>|sidekick <model>|strong <model|clear>|compact <model|clear>|pool <list|set|remove|clear|decision <on|off>>|jobs|pause|resume|stop]
```

### Core Toggles

- **`/fusion on` / `/fusion off`**: Master toggle for Fusion.
- **`/fusion status`**: Prints active Fusion mode, sidekick status, routing engine, and model pool.
- **`/fusion mode <off|delegate|escalate|token-savings|autonomous>`**:
  - `delegate`: Prompt-driven offloading to sidekick.
  - `escalate`: Cheap-first execution, escalating to frontier when tools fail or complex reasoning is needed.
  - `token-savings`: Aggressive cost minimization.
  - `autonomous`: Full self-directing sidekick and main agent pairing.

### Decision Routing Commands

- **`/fusion decision on`** (or `/fusion --decision-mode on`):
  Enables decision-model routing for Fusion. Automatically activates `fusion.dynamicRouting` and `fusion.enabled`.
- **`/fusion decision off`**:
  Disables decision-model routing.
- **`/fusion pool decision on`**:
  Explicitly enables decision-model routing specifically across your configured `fusion.modelPool` tiers.
- **`/fusion pool decision off`**:
  Reverts pool routing to the heuristic classifier.

### Managing the Model Pool

```text
# View current pool tiers and routing status
/fusion pool

# Set specific model tiers (Tier 1 = strongest, higher numbers = cheaper)
/fusion pool set 1 openai-codex/gpt-6.1-terra
/fusion pool set 2 kimi-code/k3.1-pro
/fusion pool set 3 minimax-code/MiniMax-M3.1-Flash
/fusion pool set 4 openrouter/deepseek/deepseek-v4.1-flash-1017
/fusion pool set 5 openrouter/recursive/flint-v1.0:free

# Enable decision routing on the pool
/fusion pool decision on

# Remove a tier
/fusion pool remove 5

# Clear all tiers
/fusion pool clear
```

---

## Configuration Settings (`config.yml`)

All Fusion settings can be configured globally in `~/.ompk/agent/config.yml` or checked with `oh-my-pk config get <key>`:

| Key | Type | Default | Description |
|:---|:---|:---|:---|
| `fusion.enabled` | `boolean` | `false` | Master toggle for Fusion execution. |
| `fusion.mode` | `enum` | `"escalate"` | Strategy mode (`off`, `delegate`, `escalate`, `token-savings`, `autonomous`). |
| `fusion.decisionRouting` | `boolean` | `false` | Routes the fusion pool through the decision model based on compaction summaries. |
| `fusion.dynamicRouting` | `boolean` | `false` | Dynamic tier switching at compaction boundaries. |
| `fusion.modelPool` | `array` | `[]` | List of `"<tier>=<selector>"` mappings (e.g. `["1=openai-codex/gpt-6.1-terra", "2=kimi-code/k3.1-pro"]`). |
| `fusion.compactModel` | `string` | `""` | Cheaper main-model tier switched in at compaction when not using pool mode. |
| `fusion.sidekickModel` | `string` | `"pi/smol"` | Model selector used for persistent sidekick tasks. |
| `fusion.sidekickStrongModel`| `string` | `""` | Stronger model tier for sidekick tasks during difficult stretches. |
| `fusion.escalateFailureStreak`| `number`| `3` | Number of consecutive tool failures that trigger auto-escalation back to Tier 1. |
| `fusion.decisionWindowPercent`| `number`| `25` | Percentage of trailing conversation history evaluated by the decision router (default 25%). |
