# Changelog

## [Unreleased]

### Added

- `@pk-nerdsaver-ai/pi-chatgpt-connector`: remote MCP server that lets ChatGPT
  launch and drive autonomous ompk coding tasks inside an allowlisted set of
  workspaces, plus the reverse `ask_chatgpt` custom tool that delegates bounded
  questions to ChatGPT over the OpenAI Responses API.
- `createConnector()` composition root + `ompk-chatgpt` CLI (`serve` / `init` /
  `token` / `doctor`).
- Nine MCP tools (`list_workspaces`, `launch_task`, `get_task`, `wait_task`,
  `get_task_result`, `get_task_diff`, `follow_up_task`, `cancel_task`,
  `list_tasks`) with ChatGPT-facing annotations (`readOnlyHint`,
  `destructiveHint`, `openWorldHint`, `idempotentHint`) and `outputSchema`s.
- Three auth modes: `bearer` (constant-time token compare, optional `?token=`
  fallback), `none` (tunnel-only), and `oauth` — an RFC 9728 OAuth 2.1
  protected-resource surface (`/.well-known/oauth-protected-resource`,
  `WWW-Authenticate` `resource_metadata` challenge) backed by a
  JWKS-verifying RS256/ES256 JWT checker with cache + `kid` rotation refresh.
- The in-process runner fails closed until an enforced workspace sandbox exists.
- Runners that ignore cancellation retain their concurrency slot until they stop;
  follow-ups use the same bounded queue as initial tasks.
- OAuth access tokens require an expiry and all configured scopes.
- `followup_task` fix: a settled task's state is now rewound before the new
  turn so follow-ups actually run (the previous code silently dropped them).
- Model-facing output hygiene: workspace paths and `sessionFile` are stripped
  from `tools/call` text and structured content; task text previews only.
- 89-test suite covering protocol negotiation, all three auth modes (including
  a real JWT round-trip), config validation, manager lifecycle (queue / timeout
  / cancel / follow-up / idle disposal / eviction / shutdown), the full HTTP
  surface, and the ChatGPT client + custom tool.
