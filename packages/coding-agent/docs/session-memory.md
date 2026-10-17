# Session memory pilot

Session memory keeps a local, repository-scoped archive and lexical search index.
The pilot uses oh-my-pk's saved sessions. It leaves every source file in place and
does not change session locks, compaction, resume, memory backend selection or
provider settings. Indexing and retrieval make no model or embedding API calls.

## Use inside OMPK

Run /session-memory build from the repository to refresh the archive. Unchanged
files are skipped; appends and rewrites keep earlier revisions recoverable.

- /session-memory status reports indexed files, revisions, records and missing blobs.
- /session-memory search multiline paste searches all indexed textual evidence.
- /session-memory wake lists recent sessions with short extractive summaries.
- /session-memory expand <id> follows session → segment → record links.
- /session-memory source <record-id> [byte-offset] returns exact saved record bytes.

The agent has the read-only session_memory tool with the same retrieval actions.
It respects tool profiles and explicit tool allowlists. Build is an operator action;
retrieval never refreshes or writes the index. Repeat build when history changes.
The pilot deliberately has no automatic background scanner.

Search is lexical AND matching with BM25 ranking, not semantic similarity.
Use concrete identifiers, paths or words; punctuation is treated as separators.
Source pages include SHA-256, total bytes, byte offsets, nextOffset, readable text
and base64. Base64 is authoritative at UTF-8 page boundaries. Agent retrieval
supports offset and limit; counts are bounded to 50 items or 65,536 source bytes.
Blob dependencies expose b: IDs that the source action can read byte-exactly.

## Preservation and evidence

The SQLite index lives beside the configured sessions directory in session-memory,
under a filename derived from the primary Git worktree's canonical path. Linked
worktrees share that index. All JSONL headers are checked against the primary repository and registered
worktrees. Independent nested Git repositories and sibling projects are excluded.
Retired external worktrees that cannot be linked to this repository are excluded;
their original sessions are untouched.

Every saved record has an independent gzip snapshot, exact byte length and hash.
Manifests retain source path, file hash, record order and byte offsets. Blank lines,
invalid JSON, Unicode, CRLF and incomplete tails remain byte-exact. Referenced
image blobs are copied by content hash. Already missing or corrupt blobs are
reported; the archive cannot recreate evidence that was lost before ingestion.
Existing persistence truncation is preserved as saved, not reversed.

The graph is repository → session revision → 32-record segment → exact record,
with links to original parent entry IDs and blob dependencies. Summaries quote
the first user request and last assistant response in each group, with evidence
IDs. They are navigation aids, not semantic summaries, proof of success or current
instructions. Every other record, including tool results and branches, stays
searchable and expandable. No summary replaces source evidence.

Record and FTS batches commit atomically; complete manifests publish only after
reading the bounded file snapshot. Interrupted builds can safely be rerun. Files
that change during the read are marked unstable and re-read next time. An unchanged
refresh trusts size and mtime; the internal force option can re-read all candidates.
Published revisions and their records are never pruned by the pilot.

## Source operator CLI

From the source checkout, using Bun in a managed PK-Herdr pane:

    bun packages/coding-agent/scripts/session-memory.ts build
    bun packages/coding-agent/scripts/session-memory.ts status
    bun packages/coding-agent/scripts/session-memory.ts search <repository-cwd> "multiline paste"
    bun packages/coding-agent/scripts/session-memory.ts verify
    bun packages/coding-agent/scripts/session-memory.ts restore <repository-cwd> <archive-id> <new-directory>

Verify hashes every archived record, reassembled session and captured blob.
Restore writes session.jsonl and a blobs subdirectory into a new directory,
refuses an existing destination, verifies the reconstructed session hash, and
reports missing dependencies. A restore exception leaves the new partial directory
for inspection. It never writes over a source session or installs restored data.

This pilot adds storage. It does not reclaim space or authorize deletion of originals.
The installed executable must be rebuilt from this source to expose the commands.
