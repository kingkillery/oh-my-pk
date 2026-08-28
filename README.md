<p align="center">
  <img src="https://raw.githubusercontent.com/kingkillery/oh-my-pk/refs/heads/main/assets/hero.png" alt="omp">
</p>

<p align="center">
  <strong>A coding agent with the IDE wired in.</strong>
  <strong><a href="https://oh-my-pk.pkking.computer">oh-my-pk.pkking.computer</a></strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@pk-nerdsaver-ai/pi-coding-agent"><img src="https://img.shields.io/npm/v/@pk-nerdsaver-ai/pi-coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://github.com/kingkillery/oh-my-pk/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://github.com/kingkillery/oh-my-pk/actions"><img src="https://img.shields.io/github/actions/workflow/status/kingkillery/oh-my-pk/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/kingkillery/oh-my-pk/blob/main/LICENSE"><img src="https://img.shields.io/github/license/kingkillery/oh-my-pk?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  Fork of <a href="https://github.com/badlogic/pi-mono">Pi</a> by <a href="https://github.com/mariozechner">@mariozechner</a> 
</p>

The most capable agent surface that ships. Continuously tuned by real-world use — complete out of the box, open all the way down.

**60+** providers · **31** built-in tools · **14** lsp ops · **28** dap ops · **~80k** lines of Rust core.

> [!NOTE]
> Pull requests require a **vouch** before they can be accepted. This fork
> maintains a vouch system to ensure quality contributions. See
> [CONTRIBUTING.md](CONTRIBUTING.md) for how to get vouched and open a PR.

## Install

The installer scripts install or validate Bun and then install the
`@pk-nerdsaver-ai/pi-coding-agent` npm package by default.

**macOS · Linux**

```sh
curl -fsSL https://oh-my-pk.pkking.computer/install | sh
```

> **Alpine / musl:** the prebuilt musl binary links `libstdc++`/`libgcc` dynamically, which stock Alpine does not ship. Install them first: `apk add libstdc++ libgcc`.

**Homebrew**

```sh
# Homebrew tap not available for this fork
```

**Bun (recommended)**

```sh
bun install -g @pk-nerdsaver-ai/pi-coding-agent
```

**Nix**

```sh
# Run without installing
nix run github:kingkillery/oh-my-pk

# Or install into the active profile
nix profile install github:kingkillery/oh-my-pk
```

Flake consumers can use `packages.<system>.omp`, `overlays.default`, `nixosModules.default`, or `homeManagerModules.default`. A Home Manager configuration can install OMP and own its settings declaratively:

```nix
{
  inputs.omp.url = "github:kingkillery/oh-my-pk";

  # In your Home Manager module:
  imports = [ inputs.omp.homeManagerModules.default ];
  programs.omp = {
    enable = true;
    settings.startup.quiet = true;
  };
}
```

**Windows (PowerShell)**

```powershell
irm https://oh-my-pk.pkking.computer/install.ps1 | iex
```

`oh-my-pk` requires Bash on Windows. Install Git for Windows (recommended), or
use WSL, Cygwin, or MSYS2; the installer detects Git Bash or `bash.exe` on
`PATH` and records the shell path.

**Direct npm package install with Bun**

```sh
bun install -g @pk-nerdsaver-ai/pi-coding-agent
```

The default path supports macOS, Linux, and Windows and requires Bun >= 1.3.14.
Publishing a GitHub Release or the separate binary channel does not update this
path: the same release must also be published to npm.

### Explicit binary install

Prebuilt binaries are an explicit alternative; they are never selected by the
default installer commands above.

```sh
# macOS or Linux
curl -fsSL https://oh-my-pk.pkking.computer/install.sh | sh -s -- --binary
```

```powershell
# Windows
& ([scriptblock]::Create((irm https://oh-my-pk.pkking.computer/install.ps1))) -Binary
```

Binary mode supports macOS x64/arm64, Linux x64/arm64, and Windows x64. It
downloads the selected platform asset from the private Hugging Face model
repository through the install endpoint; clients never receive the repository
token. See [the fork release guide](docs/RELEASING-FORK.md) for the separate
GitHub, Hugging Face, and npm release gates.

There is no Homebrew tap or mise registry entry for this fork — don't use
`brew install kingkillery/tap/omp` or
`mise use -g github:kingkillery/oh-my-pk`; neither is published.

### Shell completions

`oh-my-pk` (aliases: `omp`, `ompk`) generates its own completion scripts for **bash**, **zsh**, and **fish** from the live command/flag metadata, so they never drift from the actual CLI. Subcommands, flags, and enum values complete statically; model names (`--model`, `--smol`, `--slow`, `--plan`) resolve against the bundled model catalog and `--resume` against your on-disk sessions.

```sh
# zsh — add to ~/.zshrc (or write the output into a file on your $fpath)
eval "$(oh-my-pk completions zsh)"

# bash — add to ~/.bashrc
eval "$(oh-my-pk completions bash)"

# fish
oh-my-pk completions fish > ~/.config/fish/completions/oh-my-pk.fish
```

## Every tool, _benchmaxxed_.

Edits that land on the first attempt. Reads that summarize files instead of dumping their content. Searches that return instantly. Pick any model — oh-my-pk will get it right.

| model            | metric       | what                                                                  |
| ---------------- | ------------ | --------------------------------------------------------------------- |
| Grok Code Fast 1 | 6.7% → 68.3% | Tenfold lift the moment the edit format stops eating the model alive. |
| Gemini 3 Flash   | +5 pp        | Over str_replace — beats Google's own best attempt at the format.     |
| Grok 4 Fast      | −61% tokens  | Output collapses once the retry loop on bad diffs disappears.         |
| MiniMax          | 2.1×         | Pass rate more than doubles. Same weights, same prompt.               |

- `read` : summarized snippets · ideal defaults · selector hit rate
- `grep` : fastest in the west
- `lsp` : everything your IDE knows, the agent knows
- `prompts` : adjusted relentlessly for each model

[Read the full post ↗](https://blog.can.ac/2026/02/12/the-harness-problem/)

## The Pi _you love_, with **batteries included**.

Originally built on [Mario Zechner](https://github.com/mariozechner)'s wonderful [Pi](https://github.com/badlogic/pi-mono), oh-my-pk adds everything you're missing.

### 01 · Code execution w/ tool-calling

Most harnesses give the agent a Python sandbox and call it done. Ours runs persistent Python and a Bun worker, and either kernel can call back into the agent's own tools — read, search, task — over a loopback bridge. The agent loads a CSV with tool.read from inside Python, charts it from JavaScript, and never leaves the cell.

![omp TUI running Python code and rendering a chart.](assets/python.webp)

### 02 · LSP wired into every write

Ask for a rename and you get a rename. The call goes through workspace/willRenameFiles, so re-exports, barrel files, and aliased imports update before the file moves. Everything your IDE knows, the agent knows.

![omp TUI with TypeScript and Biome language servers active.](assets/lspv.webp)

_[Read the LSP config docs](docs/lsp-config.md)_

### 03 · Drives a real debugger

A C binary segfaults: the agent attaches lldb, steps to the bad pointer, reads the frame. A Go service hangs: it attaches dlv and walks the goroutines. A Python process is wedged: debugpy, pause, inspect, evaluate. Most agents are still sprinkling print statements.

### 04 · Time-traveling stream rules

Your rules sit dormant until the model goes off-script. A regex match aborts the stream mid-token, injects the rule as a system reminder, and retries from the same point. You get course-correction without paying context tax on every turn. Injections survive compaction, so the fix sticks.

### 05 · First-class subagents

Split a job across workers and get typed results back. `task` fans workers out in parallel; opt editing workers into isolated copy-on-write/worktree environments when you need overlap-safe patches. Each worker runs its own tool surface, and `yield` returns a schema-validated object the parent reads directly.

Launch one directly with `/subagent using <alias-or-model> "<prompt>"`, cap new workers with `/tier light|mid|frontier|auto`, or pass `fork: true` to `task` for an ephemeral child that inherits the parent's system prompt, tools, model, and read-only history snapshot. Fresh contexts remain the default.

For whole-repository coverage, the bundled `agentic-mapreduce` skill turns deterministic selectors into bounded map shards and a typed reducer pass with `mr-worker` and `mr-reducer`; `tree-of-thoughts` and `tot-reasoner` cover shards that need adversarial branching.

Agent Hub can sync background agents into pk-kanban, keeping long-running worker state visible on the same local board you use for project coordination.

Watch the fan-out while it runs: `Alt+A` opens [Agent Hub](docs/agent-hub.md), where the roster shows current activity and usage for every subagent. Open one to read its live transcript, type a steering message, revive a parked worker, or kill a stuck one without aborting the parent session.

### 06 · A second model, watching every turn.

Pair a reviewer model to the 'advisor' role and it reads every turn the main agent takes, injecting notes inline — a quiet aside, a concern, or a hard blocker. It runs on its own context and its own model, so it catches what the doer rushed past. The main agent sees the note and course-corrects, or tells you why it won't.

Need the second model to do work instead of review it? `/fusion on` keeps a warm cheap sidekick for settled mechanical tasks while the frontier model keeps the reasoning. Choose `delegate` or `escalate`, optionally route through a model pool, and inspect live sidekick state and token split with `/fusion status`. Fusion is opt-in and requires an available, credentialed sidekick model.

### 07 · Hand someone the link, they're in.

/collab puts your live session on a relay and hands back a link — and a QR. A teammate joins from another terminal with oh-my-pk join, or just opens it in a browser. Share read-write to pair on the same agent, or /collab view for a read-only link anyone can watch but no one can steer. Frames are sealed client-side; the relay never sees your keys.

`/hub` is the durable counterpart: publish a client-side encrypted replication snapshot on one device, then run `/hub resume <link>` to restore the full history as a local session fork on another. Hub handoff requires provisioned account access, relay connectivity, and the complete link including its fragment key.

### 08 · Read a pdf on arxiv, why not?

web_search chains twenty-three ranked providers and hands whatever URLs it finds straight to read. Arxiv PDFs, GitHub pages, Stack Overflow threads come back as structured markdown with anchors intact — the same tool surface you use on local files. Cite, follow, quote, never lose where you came from.

![omp TUI: web_search returns 10 ranked Perplexity sources for inference-time compute scaling, the agent picks an arxiv paper, calls read https://arxiv.org/pdf/2604.10739v1, and summarizes the paper's headline result with real numbers.](https://oh-my-pk.pkking.computer/clips/web-poster.webp)

_[Watch the capture ↗](https://oh-my-pk.pkking.computer/clips/web.mp4)_

### 09 · Unapologetically native. Even on Windows.

Other agents shell out to rg, grep, find, and bash. On many machines those binaries don't exist, and on the ones where they do, every call costs a fork-exec round-trip. omp links the real implementations into the process. ripgrep, glob, find: in-process. brush is the bash — with sessions that survive across calls, and 58 command-line utilities (ls, sed, sort, xargs, even jq) ported into the builtins crate and run in-process, zero fork/exec. The same omp binary runs on macOS, Linux, and Windows — no WSL bridge.

### 10 · Code review with priorities and a verdict

Get a clear verdict on whether the change ships, with every issue ranked P0 through P3 and scored for confidence. /review spawns dedicated reviewer subagents that sweep branches, single commits, or uncommitted work in parallel. You tackle what blocks release first; nothing important hides in a wall of prose.

### 11 · Hashline: edit by content hash

Perfect edits, fewer tokens. The model points at anchors instead of retyping the lines it wants to change, so whitespace battles and string-not-found loops just stop happening. Edit a stale file and the anchors diverge — we reject the patch before it corrupts anything. Grok 4 Fast spends 61% fewer output tokens on the same work.

### 12 · GitHub is just another filesystem

Other harnesses bolt on gh_issue_view, gh_pr_view, gh_search — each with its own parameters the agent has to learn and you have to debug. We skipped that. read already handles paths; PRs are paths. One interface to teach the model, one surface to keep correct.

### 13 · Memory the agent curates

The agent remembers your codebase between sessions. It writes facts mid-run with retain, captures reusable lessons with learn, pulls them back with recall, and compresses each session into a mental model that loads on the first turn of the next one. Pick the engine with `memory.backend` — local, Hindsight, or Mnemopi. Project-scoped by default, so what it learns about this repo stays with this repo.

### 14 · ACP: editor-drivable agent

Run omp inside Zed and you get the same agent you drive from the terminal — reading the buffer you're actually looking at, writing through the editor's save path, spawning shells in the editor's terminal. Destructive tools pause for a permission prompt you can answer once and forget. No bridge, no plugin, no second brain to keep in sync.

### 15 · Reads the configuration your other tools already wrote

Every other agent ships an importer and expects you to convert. `oh-my-pk` discovers the supported parts of eight auto-registered ecosystems already on disk — Claude Code, Cursor, Windsurf, Codex, Cline, GitHub Copilot, VS Code, and OpenCode. Nothing is copied or migrated; the Discovery table below names the exact surfaces that load.

### 16 · oh-my-pk commit: atomic splits, validated messages

oh-my-pk commit reads the working tree through git_overview, git_file_diff, and git_hunk, then splits unrelated changes into atomic commits ordered by their dependencies. Cycles are rejected before anything is written. Source files score above tests, docs, and configs, so the headline commit is the one that matters. Lock files are excluded from analysis entirely.

### 17 · Read PRs. _Walk skills._ Pull JSON out of subagents.

Sixteen internal schemes — `pr://`, `issue://`, `agent://`, `skill://`, `ssh://`, and the rest — resolve transparently inside every FS-shaped tool the agent already calls. `read pr://1428` returns the same shape as `read src/foo.ts`. `grep` walks a diff like a directory. `agent://<id>/findings.0.path` pulls a field out of a subagent's output by path.

### 18 · Conflict resolution, made easy.

Each merge conflict becomes one URL. The agent writes `@theirs`, `@ours`, or `@base` to `conflict://N` and the file resolves cleanly. Bulk form: `conflict://*`.

### 19 · Preview, then accept.

`ast_edit` returns a _(proposed)_ card with the replacement count. The change is staged. The agent writes a one-line reason to `xd://resolve`; the TUI turns it into an **Accept** card and the disk move happens — atomic, all or nothing.

### 20 · Drives a _real browser_. _Or your Slack?_

Stealth's on by default, so pages see a normal user instead of a headless bot. The same API drives any Electron app in place — point it at Slack and the agent reads your DMs the way it reads the web. Or skip the sandbox entirely: the browser relay extension lets the agent adopt the Chrome tabs you already have open, without stealing focus.

### 21 · Hands on the desktop itself

`computer` runs persistent JavaScript against the real host: enumerate windows and displays, capture screenshots, send native input, walk the OS accessibility tree, touch the clipboard. Not the browser tool, no DOM — the same desktop you're looking at.

## Whatever the task needs, _it's already in the box_.

31 tools live in the same namespace as `read` and `bash`. Pin the active set with `--tools read,edit,bash,…`; rarely used discoverable tools stay behind `xd://` devices. `read xd://` lists them, and `write xd://<tool>` runs one when `tools.xdev` is enabled.

**Files & search**

- `read` — files, dirs, archives, SQLite, PDFs, notebooks, URLs, remote `ssh://` paths, and internal `://` schemes through one path.
- `write` — create or overwrite a file, archive entry, or SQLite row.
- `edit` — hashline patches with content-hash anchors and stale-anchor recovery.
- `ast_edit` — structural rewrites previewed before apply, via ast-grep.
- `ast_grep` — structural code queries over 50+ tree-sitter grammars.
- `grep` — regex over files, globs, and internal URLs.
- `glob` — glob-based path lookup; reach for `grep` when you need content matches.

**Runtime**

- `bash` — workspace shell with 46 in-process coreutils, optional PTY, and background-job dispatch.
- `eval` — persistent Python and JavaScript cells with shared prelude and tool re-entry.

**Code intelligence**

- `lsp` — diagnostics, navigation, symbols, renames, code actions, raw requests.
- `debug` — drive a DAP session — breakpoints, stepping, threads, stack, variables.
- `security_scan` — plan and run native security reviews; drives Codex Security cloud scans.

**Coordination**

- `task` — fan out subagents in parallel, optionally workspace-isolated.
- `hub` — message live agents, wait on or cancel background jobs, and supervise long-running processes.
- `todo` — ordered mutations over the session todo list with phase tracking.
- `ask` — structured follow-up questions for interactive runs.

**Desktop & web**

- `browser` — Puppeteer tabs over headless Chromium, CDP-attached apps, or your own Chrome via the relay.
- `computer` — persistent JS against the host desktop: windows, screenshots, native input, AX tree, clipboard.
- `web_search` — one query across configured providers, returning answer plus citations.
- `github` — GitHub CLI ops — repo, PR, issues, code search, Actions run-watch.
- `generate_image` — generate or edit raster images via Gemini, GPT, or xAI Grok image models.
- `inspect_image` — vision-model analysis of a local image file.

**Memory & skills**

- `checkpoint` — mark conversation state for a later collapse-and-report.
- `rewind` — prune exploratory context, keep a concise report.
- `retain` — queue durable facts into the active memory bank.
- `recall` — search the memory bank for raw memories.
- `reflect` — synthesize an answer over the bank.
- `memory_edit` — update, forget, or invalidate stored memories by id.
- `learn` — capture a reusable lesson; optionally promote it into a managed skill.
- `manage_skill` — create, update, or delete an isolated managed skill.

Setting-gated, off by default: `github`, `security_scan`, `generate_image`, `tts`, `checkpoint`, `rewind`, and the memory tools (`retain`/`recall`/`reflect`/`memory_edit`, per `memory.backend`). `inspect_image` activates automatically when the active model can't see.

[Full tool reference →](https://oh-my-pk.pkking.computer/docs)

### Prompt controls

Three standalone, lowercase words opt a turn into specialized agent behavior:

- `ultrathink` — request careful multi-step reasoning and the highest supported automatic thinking effort.
- `orchestrate` — run substantial independent work through parallel subagents and verify each phase.
- `workflowz` — build a deterministic multi-subagent workflow with the active `task` tool.

They trigger only in prose, not inside code spans, fenced code blocks, XML/HTML sections, identifiers, or paths. See [Magic keywords](docs/magic-keywords.md) for exact matching rules and configuration.

### Session controls

Slash commands shift how a whole session runs:

- `/vibe` — enter [Vibe mode](docs/vibe-mode.md): act as a director driving persistent `fast`/`good` worker sessions with a `read`-only toolset.
- `/fresh` — reset the provider stream state (stale prompt cache, wedged stream) without changing the local transcript. See [Session operations](docs/session-operations-export-share-fork-resume.md#fresh).

## Sixty-plus providers, a thousand models, _one /model away_.

Ten roles route work by intent. `default` for normal turns. `smol` for cheap subagent fan-out. `slow` for deep reasoning. `plan` for plan mode. `commit` for changelogs. Plus `vision`, `designer`, `task`, `advisor`, and `tiny` for their namesakes. Override at launch with `--smol`, `--slow`, or `--plan`; cycle through the configured models for the active role with `Ctrl+P`. Swap the active model mid-session with the `/model` slash command.

The lists below are selected bundled providers, not the exhaustive 59-namespace catalog. `/login` handles supported OAuth/account-backed providers; API-key-backed APIs and coding gateways use their provider credentials.

### Selected direct APIs and gateways

Anthropic · OpenAI · Google Gemini · Google Vertex · Azure OpenAI · Amazon Bedrock · xAI · Z.AI (direct) · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Hugging Face · NVIDIA · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Vertex · Google Antigravity `oauth` · xAI · SuperGrok `oauth` · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · DeepInfra · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

OpenAI Codex `oauth` · Google Antigravity `oauth` · Google Gemini CLI `oauth` · Cursor `oauth` · GitHub Copilot `oauth` · Cline `oauth` · Qwen Portal `oauth` · Ollama Cloud `oauth` · Wafer Serverless `oauth` · GitLab Duo · Kimi Code · MiniMax Coding Plan · Alibaba Coding Plan · Zhipu Coding Plan · Xiaomi token plans · Wafer Pass · OpenCode Go · OpenCode Zen · Moonshot · Qianfan · NanoGPT · Venice · Kilo · ZenMux

Perplexity is a `web_search` backend, not a bundled `/model` provider.

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Devin `oauth` · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal `oauth` · Z.AI / GLM Coding Plan `plan` · Zhipu Coding Plan `plan` · Xiaomi MiMo · Qianfan · Umans `plan` · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

The three implicit keyless engines are Ollama, llama.cpp, and LM Studio. Ollama discovers through native `/api/tags` and `/api/show`; llama.cpp uses its model endpoints; LM Studio uses `/v1/models`. vLLM and LiteLLM also support runtime discovery and can be configured keyless when the server permits it. Ollama Cloud is hosted and requires API-key or OAuth authentication.

### Custom OpenAI-compatible providers

Define custom providers in `~/.omp/agent/models.yml`:

```yaml
providers:
  spark:
    baseUrl: http://192.168.10.223:8000/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: minimax-m3
        name: MiniMax M3
        contextWindow: 100000
        maxTokens: 32000
```

Run `omp models spark` to verify discovery. Then run `omp setup` and choose the model in the default-model step, or open `/model` in a session and assign it to the `default` role.

To preconfigure the default without the picker, add the selector to `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: spark/minimax-m3
```

### Four knobs that make routing useful

- **Custom providers** — Declare anything that speaks `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, or `google-vertex` in `~/.omp/agent/models.yml`.
- **Fallback chains** — Per-role or per-model chains under `retry.fallbackChains`. When the primary throws 429s or hits a quota wall, the next entry takes the rest of the turn — restored on cooldown.
- **Path-scoped models** — Scope `enabledModels` and `disabledProviders` entries to a `path:` prefix to pin a different model set on one repo without touching the global config. Scoped entries cover the path and everything under it.
- **Round-robin credentials** — Stack API keys per provider and the runtime rotates with session affinity and per-credential backoff. Useful when one key would burn its quota by lunch.

Full provider & routing reference at [oh-my-pk.pkking.computer/docs](https://oh-my-pk.pkking.computer/docs).

## Twenty-three backends. _One tool the agent already knows_.

`web_search` is built in, not bolted on. `auto` walks a twenty-three-provider chain; pin one by name if you already pay for it. Behind every hit, site-aware extraction turns GitHub, registries, arXiv, Stack Overflow, and docs into structured markdown — anchors and link targets survive.

### Search providers

Twenty-three backends. Pin one, or let `auto` walk the chain in order.

| provider     | auth                                      |
| ------------ | ----------------------------------------- |
| `auto`       | chain                                     |
| `perplexity` | `PERPLEXITY_API_KEY` (anonymous fallback) |
| `gemini`     | oauth                                     |
| `anthropic`  | oauth                                     |
| `codex`      | oauth                                     |
| `xai`        | oauth or `XAI_API_KEY`                    |
| `zai`        | `ZAI_API_KEY`                             |
| `exa`        | `EXA_API_KEY` (or mcp)                    |
| `tinyfish`   | `TINYFISH_API_KEY`                        |
| `jina`       | `JINA_API_KEY`                            |
| `kagi`       | `KAGI_API_KEY`                            |
| `tavily`     | `TAVILY_API_KEY`                          |
| `firecrawl`  | `FIRECRAWL_API_KEY` (keyless fallback)    |
| `brave`      | `BRAVE_API_KEY`                           |
| `kimi`       | `/login kimi-code` or search key          |
| `parallel`   | `PARALLEL_API_KEY`                        |
| `synthetic`  | `SYNTHETIC_API_KEY`                       |
| `searxng`    | self-hosted                               |
| `duckduckgo` | no key                                    |
| `startpage`  | no key                                    |
| `google`     | no key (browser)                          |
| `ecosia`     | no key (browser)                          |
| `mojeek`     | no key (browser)                          |
| `public`     | no key (all of the above, consolidated)   |

Exa also accepts a stored API key through `/login exa`; explicit keyless selection uses the public MCP fallback.

### Specialised handlers

The agent gets structured content, not stripped HTML.

- **Code hosts** — github, gitlab
- **Package registries** — npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages
- **Research sources** — arxiv, semantic scholar
- **Forums** — stack overflow, reddit, hn
- **Docs** — mdn, readthedocs, docs.rs

Pages convert to markdown with link structure intact. The agent can cite, follow, and quote without losing anchors.

### Security databases

Vuln lookups answer with vendor data, not blog summaries.

- **NVD** — national vulnerability database
- **OSV** — open source vuln feed
- **CISA KEV** — known exploited vulns

[`web_search` reference ↗](docs/tools/web_search.md)

## Roughly **~80,000** lines of Rust, doing the work other harnesses shell out for.

Six crates, one platform-tagged N-API addon. Search, shell, AST, highlight, PTY, desktop control, image decode, BPE counting — all in-process on the libuv pool. No fork/exec on the hot path. Another ~80k lines ride along vendored: the brush bash fork, plus 58 command-line utilities — coreutils, findutils, sed, jq, ripgrep-backed grep, fd, diff, moreutils — ported into the builtins crate and compiled straight into the shell.

- Crates: `pi-natives`, `pi-shell`, `pi-ast`, `pi-iso`, `pi-voice`, `pi-walker`
- Platforms: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64` — x64 ships dual AVX2 and baseline binaries

Per crate, code lines only:

| Crate         | What it does                                                                           |   ~LoC |
| ------------- | -------------------------------------------------------------------------------------- | -----: |
| pi-shell      | Embedded bash engine · persistent sessions · in-process coreutils dispatch · minimizer | 38,000 |
| pi-natives    | The N-API surface — every module in the table below                                    | 25,000 |
| pi-walker     | Parallel ignore-aware walker + scan cache shared by grep · glob · workspace · shell    |  5,200 |
| pi-iso        | Workspace isolation · apfs · btrfs · zfs · reflink · overlayfs · projfs · rcopy        |  3,300 |
| pi-ast        | tree-sitter + ast-grep matching, block resolution, structural summaries                |  2,900 |
| pi-voice      | Audio capture/playback · Opus · live WebRTC                                            |  1,000 |

Inside `pi-natives`, the per-module breakdown (glue and tests omitted):

| Module        | What it does                                                                      | Powered by                                |   ~LoC |
| ------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | -----: |
| desktop       | Window/display enumeration · screenshot · native input · AX tree for `computer`   | xcap · enigo · OS AX FFI                  | 10,600 |
| grep          | Regex search · parallel/sequential · glob & type filters · fuzzy find             | grep-regex · grep-searcher                |  3,280 |
| text          | ANSI-aware width · truncation · column slicing · SGR-preserving wrap              | unicode-width · segmentation              |  2,070 |
| snapcompact   | Bitmap-frame rasterization + PNG encode for context compression                   | image · png                               |  1,760 |
| keys          | Kitty keyboard protocol with xterm fallback · PHF perfect-hash lookup             | phf                                       |  1,740 |
| ast           | ast-grep pattern matching and structural rewrites                                 | ast-grep-core                             |  1,510 |
| diff          | Structured file diffing for tools and previews                                    | in-tree                                   |  1,030 |
| pty           | Native PTY allocation for sudo · ssh interactive prompts                          | portable-pty                              |    630 |
| crash_handler | Native crash capture and reporting                                                | in-tree                                   |    610 |
| highlight     | Syntax highlighting · 11 semantic categories · 30+ aliases                        | syntect                                   |    550 |
| appearance    | Mode 2031 + native macOS dark/light via CoreFoundation FFI                        | core-foundation                           |    450 |
| task          | Blocking work on libuv thread pool · cancellation · timeout · profiling           | tokio · napi                              |    440 |
| glob          | Discovery with glob · type filters · mtime sort · gitignore respect               | ignore · globset                          |    430 |
| fd            | Filesystem walker for find-tool replacement                                       | ignore                                    |    385 |
| clipboard     | Text copy and image read from system clipboard · no xclip/pbcopy                  | arboard                                   |    370 |
| workspace     | Workspace walker with gitignore + AGENTS.md discovery in one pass                 | ignore                                    |    275 |
| power         | macOS power-assertion API for idle/system/display-sleep prevention                | IOKit FFI                                 |    270 |
| prof          | Circular buffer profiler with folded-stack and SVG flamegraph output              | inferno                                   |    240 |
| file_lock     | Cross-process advisory file locking                                               | in-tree                                   |    210 |
| ps            | Cross-platform process-tree kill and descendant listing                           | libc · libproc · CreateToolhelp32Snapshot |    195 |
| tokens        | O200k / Cl100k BPE token counting · both tables embedded                          | tiktoken-rs                               |     70 |
| html          | HTML to Markdown with optional content cleaning                                   | html-to-markdown-rs                       |     60 |
| sixel         | Terminal image rendering · decode PNG · JPEG · WebP · GIF · resize · SIXEL encode | icy_sixel · image                         |     55 |

| Module | What it does |
| --- | --- |
| `shell` | Persistent embedded Brush shell sessions · custom builtins · timeout/abort · fixups/cancellation · process management |
| `minimizer` | Opt-in shell-output compression · command detection · fail-safe built-in/user pipelines · original-output artifact preservation |
| `grep` | Regex search · parallel/sequential execution · glob and type filters |
| `fd` | Fuzzy path discovery for autocomplete and `@` mentions |
| `keys` | Kitty keyboard protocol with xterm fallback · PHF perfect-hash lookup |
| `text` | ANSI-aware width · truncation · column slicing · SGR-preserving wrap |
| `summary` | Tree-sitter structural source summaries with elision controls |
| `block` | Tree-sitter block ranges and enclosing-boundary resolution |
| `ast` | ast-grep pattern matching and structural rewrites |
| `fs_cache` | TTL-based directory-scan cache with explicit invalidation |
| `highlight` | Syntax highlighting · semantic categories · language aliases |
| `pty` | Native PTY allocation for sudo, SSH, and interactive prompts; owned by `pi-natives` |
| `glob` | Discovery with glob/type filters, mtime sort, and gitignore respect |
| `workspace` | Workspace walking with gitignore and `AGENTS.md` discovery in one pass |
| `appearance` | Native macOS dark/light detection and observation via CoreFoundation FFI |
| `power` | macOS power assertions for idle/system/display-sleep prevention |
| `task` | Libuv blocking jobs and Tokio async futures with cancellation, timeout, and profiling |
| `iso` | APFS clonefile · btrfs subvolume snapshots · ZFS snapshot+clone · Linux FICLONE · OverlayFS/fuse-overlayfs · Windows block clones · ProjFS · git-worktree/recursive-copy fallback |
| `prof` | Circular-buffer profiler with folded stacks and SVG flamegraphs |
| `ps` | Stable process references, child traversal, status/wait, and process-tree termination |
| `clipboard` | Text copy and image read from the system clipboard without `xclip`/`pbcopy` |
| `tokens` | Embedded O200k/Cl100k BPE token counting; Rayon-backed batches |
| `snapcompact` | Bitmap conversation-frame rendering to PNG with bundled pixel fonts |
| `sixel` | PNG/JPEG/WebP/GIF decode, resize, and SIXEL rendering |
| `html` | HTML-to-Markdown conversion with optional content cleaning |

## Five entry points: _interactive_, _one-shot_, the Node SDK, RPC, and ACP.

Same engine, five surfaces. `oh-my-pk` runs the TUI. `oh-my-pk -p` prints a final response and exits; `oh-my-pk --mode json` emits the one-shot session as newline-delimited JSON events. The Node SDK embeds the session in your process. `oh-my-pk --mode rpc` and `oh-my-pk acp` hand the wheel to another program over stdio.

### Interactive — when in doubt, the agent asks

The TUI is the default surface. Tool calls render as cards, edits preview before they land, and ambiguity routes through the `ask` tool — a structured option picker the agent can call mid-turn. The keyboard handles the rest.

The same prompt cards surface over ACP, so editors get the picker without writing one.

![omp TUI showing a multi-select question from the ask tool.](assets/ask.webp)

### SDK — embed in Node

`@pk-nerdsaver-ai/pi-coding-agent`

Node and TypeScript hosts pull the engine in directly. The package exposes `ModelRegistry`, `SessionManager`, `createAgentSession`, and `discoverAuthStorage`; the session emits typed events you subscribe to.

```ts
import {
  createAgentSession,
  SessionManager,
} from "@pk-nerdsaver-ai/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

if (modelFallbackMessage) {
  process.stderr.write(`${modelFallbackMessage}\n`);
}

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("list .ts files");
unsubscribe();
await session.dispose();
```

### RPC — drive over stdio

`oh-my-pk --mode rpc`

For non-Node embedders, or when you want process isolation. NDJSON commands in, response and event frames out. `--mode rpc-ui` adds tool cards, selectors, and dialogs as `extension_ui_request` frames the host must answer.

```text
$ oh-my-pk --mode rpc --no-session
< {"type":"ready"}
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response","command":"prompt","success":true}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

### ACP — speak to editors

`oh-my-pk acp`

The [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol) over JSON-RPC. When the editor advertises capabilities, tool I/O routes through it and writes are gated by `session/request_permission`.

| omp tool     | ACP route                           |
| ------------ | ----------------------------------- |
| `bash`       | `terminal/create + terminal/output` |
| `read`       | `fs/read_text_file`                 |
| `write`      | `fs/write_text_file`                |
| `edit, bash` | `session/request_permission`        |

Full references: [SDK docs](docs/sdk.md) · [RPC protocol](docs/rpc.md) · [ACP specification](https://github.com/zed-industries/agent-client-protocol).

## A harness worth keeping is one you _don't_ outgrow.

Pick it up at **[oh-my-pk.pkking.computer](https://oh-my-pk.pkking.computer)** and read the full docs at **[oh-my-pk.pkking.computer/docs](https://oh-my-pk.pkking.computer/docs)**.

omp is a fork of [Pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner), rewritten as a coding-first surface: sessions, subagents, slash commands, extensions — all TypeScript, all MIT, all on [GitHub](https://github.com/kingkillery/oh-my-pk). Shape it from config, hook it from outside, or read the source when you need to.

### Primitives

An extension is a TypeScript module. Same tool API, same slash-command registry, same hotkey table, same TUI primitives the built-ins use. Nothing is reserved.

### Discovery

At session startup, `oh-my-pk` discovers supported configuration already on disk; nothing is copied or migrated.

| Ecosystem | Discovered surface |
| --- | --- |
| Claude Code | `.claude/CLAUDE.md` context, `.claude/skills`, commands, supported MCP files, tools/settings, and system-prompt files; `.claude/rules/*.md` is not currently discovered |
| Cursor | `.cursor/rules/*.{mdc,md}`, `mcp.json`, and project settings; Cursor skills and legacy root `.cursorrules` are not currently discovered |
| Windsurf | user `global_rules.md`, project `.windsurf/rules/*.md`, and `mcp_config.json`; Windsurf skills and legacy `.windsurfrules` are not currently discovered |
| Codex | user/project `AGENTS.md`, `config.toml` MCP, skills, and supported commands/prompts/hooks/tools/settings |
| Cline | project `.clinerules` as either a file or a directory of Markdown rules |
| GitHub Copilot | project `.github/copilot-instructions.md`, recursive `*.instructions.md` `applyTo` rules, `.github/skills`, and `.github/prompts`; user files come from `~/.copilot` or `COPILOT_HOME`; Copilot MCP is not currently ingested |
| VS Code | project `.vscode/mcp.json` MCP configuration |
| OpenCode | project `opencode.json` and `.opencode/{skills,commands,plugins}`, plus user configuration under `~/.config/opencode`; supported MCP, context, settings, commands, skills, and plugins load by capability |

### Extensibility

Ask `oh-my-pk` to write the piece you're missing. Restart the session to load a newly written extension, skill, hook, custom tool, agent, or MCP configuration; `/reload-plugins` currently refreshes discovery caches, file slash commands, and SSH state. Keep extensions local, ship them in a `marketplace`, or publish them to npm.

## Philosophy

omp is a fork of [pi-mono](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/mariozechner), extended with a batteries-included coding workflow.

Key ideas:

- Keep interactive terminal-first UX for real coding work
- Include practical built-ins (tools, sessions, branching, subagents, extensibility)
- Make advanced behavior configurable rather than hidden

## GraphTree: parallel multi-agent worktrees and Fractal parity

`/graphtree` manages isolated git worktree nodes and recursive agent lifecycle trees for running several agents on the same repository side by side.

- `/graphtree status` (or bare `/graphtree`): prints active worktree node hierarchy as ASCII tree.
- `/graphtree list`: lists worktree node details (branch, path).
- `/graphtree agents`: renders a bounded live recursive `AgentRegistry` parent/child tree with sanitized status, attention, activity, and working directory context.
- `/graphtree init <name> [branch]`: creates a new worktree node (defaults to branch `graphtree/<name>`).
- `/graphtree run <objective>`: hands the model a prompt with configured hard bounds (`task.maxRecursionDepth`, `task.maxConcurrency`, `task.maxRuntimeMs`, `task.isolation.mode`) to plan, shard, and reduce work across nodes. Note: `/graphtree run` is prompt-driven and relies on local task/agent primitives rather than a standalone daemon.
- `/graphtree stop <agent-id>`: aborts and releases a non-main, non-advisor agent via `AgentLifecycleManager`.
- `/graphtree steer <agent-id> <guidance>`: revives a subagent if parked and sends steering guidance.
- `/graphtree revive <agent-id>`: revives a parked subagent; live agents report their current state without claiming a revival.
- `/graphtree merge <name>`: squash-merges a node's branch into `HEAD` as staged changes for review.
- `/graphtree prune <name>`: removes a clean, named worktree node (refuses dirty worktrees).

### External Fractal Parity Matrix

| Capability | External Systems (`plasma-ai/fractal`, `TinyAGI/fractals`) | Local Primitive in oh-my-pk |
| --- | --- | --- |
| Recursive Agent Tree | Autonomous sub-tree spawning | `AgentRegistry` parent/child hierarchy + nested task recursion |
| Worktree & Path Isolation | Separate directories / worktree clones | `task.isolation.mode` + `git worktree` nodes |
| Bounded Execution | Recursion & concurrency limits | `task.maxRecursionDepth`, `task.maxConcurrency`, `task.maxRuntimeMs` |
| Lifecycle Controls | Pause, stop, steer sub-tasks | `/graphtree stop`, `/graphtree steer`, `/graphtree revive` via `AgentLifecycleManager` |
| Persistence & Revival | Disk-backed agent state | Parked session files (`sessionFile`) with on-demand cold revival |
| Tree Visualization | Graph/tree terminal UI | ASCII tree rendering (`/graphtree` & `/graphtree agents`) |

See [`docs/graphtree.md`](docs/graphtree.md) for the complete reference and architectural details.

---

## Development

### Getting started from source

Fresh clones need both workspace dependencies and the local Rust/N-API addon before the source CLI can start.

```sh
bun setup
bun dev
```

`bun setup` installs Bun workspaces and builds `@pk-nerdsaver-ai/pi-natives`. Re-run `bun run build:native` after changing Rust crates or `packages/natives`.

Nix users get the pinned Bun and Rust toolchains plus all native build dependencies:

```sh
nix develop
bun setup
bun dev
```

Build and smoke-test the distributable Nix package with `nix build .#omp`. Wayland screencast support is off by default (linking libpipewire adds ~750 MB of runtime closure); enable it with `omp.override { withWaylandScreencast = true; }`. `nix/bun.nix` is generated only when `bun.lock` changes; releases regenerate it automatically. For dependency changes, run:

```sh
bun run gen:nix
```

The command uses `bun2nix` from `nix develop` when available, otherwise enters the development shell through Nix, then falls back to the pinned `bunx bun2nix@2.1.2`. Do not edit `nix/bun.nix` manually.

For a non-interactive smoke check:

```sh
bun dev -- --version
```

### Debug Command

`/debug` opens tools for debugging, reporting, and profiling.

For architecture and contribution guidelines, see [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

---

## Monorepo Packages

| Package                                                                       | Description                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **[@pk-nerdsaver-ai/collab-web](packages/collab-web)**                               | Browser guest client, mock host, and local relay for collab live sessions   |
| **[@pk-nerdsaver-ai/pi-ai](packages/ai)**                                            | Multi-provider LLM client with streaming and model/provider integration     |
| **[@pk-nerdsaver-ai/pi-catalog](packages/catalog)**                                  | Model catalog: bundled model database, provider descriptors, and identity   |
| **[@pk-nerdsaver-ai/pi-agent-core](packages/agent)**                                 | Agent runtime with tool calling and state management                        |
| **[@pk-nerdsaver-ai/pi-coding-agent](packages/coding-agent)**                        | Interactive coding agent CLI and SDK                                        |
| **[@pk-nerdsaver-ai/pi-tui](packages/tui)**                                          | Terminal UI library with differential rendering                             |
| **[@pk-nerdsaver-ai/pi-natives](packages/natives)**                                  | N-API bindings for grep, shell, image, text, syntax highlighting, and more  |
| **[@pk-nerdsaver-ai/omp-stats](packages/stats)**                                     | Local observability dashboard for AI usage statistics                       |
| **[@pk-nerdsaver-ai/omptype](packages/omptype)**                                     | ArkType-compatible schema validation with lazy JIT compilation              |
| **[@pk-nerdsaver-ai/pi-utils](packages/utils)**                                      | Shared utilities (logging, streams, dirs/env/process helpers)               |
| **[@pk-nerdsaver-ai/pi-wire](packages/wire)**                                        | Shared collab live-session protocol types and relay constants               |
| **[@pk-nerdsaver-ai/hashline](packages/hashline)**                                   | Line-anchored patch language and applier behind the `edit` tool             |
| **[@pk-nerdsaver-ai/pi-mnemopi](packages/mnemopi)**                                  | Local SQLite memory engine for oh-my-pk agents                              |
| **[@pk-nerdsaver-ai/snapcompact](packages/snapcompact)**                             | Bitmap-frame context compression package and SQuAD eval suite               |
| **[@pk-nerdsaver-ai/browser-relay](packages/browser-relay)**                         | Chrome extension that lets the browser tool drive your existing tabs        |
| **[@pk-nerdsaver-ai/pi-metaharness](packages/metaharness)**                          | Unified benchmark runners, Harbor run storage, REST/SSE API, live dashboard |
| **[@pk-nerdsaver-ai/typescript-edit-benchmark](packages/typescript-edit-benchmark)** | Edit benchmark suite built on TypeScript source mutations                   |

### Rust Crates

| Crate                                              | Description                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **[pi-natives](crates/pi-natives)**                | Core Rust native addon (N-API `cdylib`) used by `@pk-nerdsaver-ai/pi-natives`; aggregates the crates below |
| **[pi-shell](crates/pi-shell)**                    | Embedded shell / PTY / process management split out of `pi-natives` (wraps `brush-*`)               |
| **[pi-ast](crates/pi-ast)**                        | tree-sitter-based code summarizer and AST utilities (50+ language grammars)                         |
| **[pi-iso](crates/pi-iso)**                        | Task isolation backend resolver: APFS clones, btrfs/zfs reflinks, overlayfs, projfs, rcopy          |
| **[pi-voice](crates/pi-voice)**                    | Audio capture/playback, Opus codecs, and live WebRTC streaming primitives                           |
| **[pi-walker](crates/pi-walker)**                  | Parallel ignore-aware filesystem walker with the scan cache shared by grep, glob, and workspace     |
| **[brush-core](crates/vendor/brush-core)**         | Vendored fork of [brush-shell](https://github.com/reubeno/brush) for embedded bash execution        |
| **[pi-builtins](crates/pi-builtins)**              | Bash builtins (cd, echo, test, printf, read, export, …) plus 67 in-process command-line utilities |

## Contributing

Pull requests require a vouch before they can be accepted. This fork maintains
a vouch system to ensure quality contributions. See
**[CONTRIBUTING.md](CONTRIBUTING.md)** for how to get vouched and open a PR.
Issues are open to everyone.

---

## License

OMP is licensed under the [MIT License](LICENSE).

Third-party and vendored code, including `crates/vendor/brush-core` and the
third-party portions identified in `crates/pi-builtins/LICENSE`, remains under
its respective upstream license. See `THIRD-PARTY-NOTICES.txt` and
component-local notices for attribution and additional terms.

© 2025 Mario Zechner  
© 2025-2026 Can Bölük  
© 2026 Stencil Labs, Inc.

_made for terminals that stay open_

- [oh-my-pk.pkking.computer](https://oh-my-pk.pkking.computer)
- [GitHub](https://github.com/kingkillery/oh-my-pk)
- [Changelog](https://github.com/kingkillery/oh-my-pk/blob/main/packages/coding-agent/CHANGELOG.md)
- [npm](https://www.npmjs.com/package/@pk-nerdsaver-ai/pi-coding-agent)
- [Discord](https://discord.gg/4NMW9cdXZa)
- [MIT](https://github.com/kingkillery/oh-my-pk/blob/main/LICENSE)
