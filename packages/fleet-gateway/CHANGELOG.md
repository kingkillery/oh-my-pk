# Changelog

## [Unreleased]

### Added

- Initial `ompk-fleet-gateway`: one MCP front door routing coding work to ompk connectors on enrolled machines.
  - 11 tools: `fleet_status`, `fleet_workspaces`, `work_list`, `work_status`, `work_result`, `work_diff`, `work_feed`, `work_messages`, `work_start`, `work_continue`, `work_cancel`.
  - Job engine: `queued → dispatching → running → idle`, reconciliation by `[job:<id>]` marker, per-host slots and backoff, `task_lost` honesty.
  - OAuth 2.1 enrollment: approval codes (`pair`), Read/Operate over All/Selected hosts, rotating refresh tokens; plus long-lived bearer clients (`token`).
  - CLI: `serve`, `init`, `pair`, `token`, `clients`, `hosts`, `jobs`, `doctor`.
