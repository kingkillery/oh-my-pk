# Changelog

## [Unreleased]

### Added

- Added a gopk capture-daemon activity sink with capture-root validation and constrained raw-clip cleanup.
- Added a local activity-evidence ledger with privacy-first gopk-clips ingestion, raw-clip lifecycle cleanup, deterministic timeline aggregation, and model-safe synthesis facts.

### Fixed

- `gopk-clips.ts`'s `isLocalPointer` only accepted Windows drive paths (`C:\...`) or `file://` URIs, rejecting plain POSIX absolute paths — every clip derivative was silently dropped as "not local" on Linux/macOS. It now accepts single-leading-slash POSIX absolute paths while still rejecting UNC-style `//host/share` network paths.
