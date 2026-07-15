# Changelog

## [Unreleased]

### Added

- Added `ScreenpipeClient`, a read-only client for a local screenpipe instance's `/raw_sql` endpoint that only ever returns frames whose text and image redaction watermarks are already set, re-validated client-side since screenpipe is a separate, untrusted process.
- Added `segmentFramesIntoClips` to group redacted frames into per-device activity segments, split on app/window change or an idle gap.
- Added `buildClipDerivative` to turn a segment into a `GopkCapturedDerivative` for the activity-journal gopk sink: a local JSON manifest, a bridge-computed `clipHash`/`keyframeHash` (screenpipe's own `content_hash` is a perceptual dedup hash, not an integrity hash), and an attestation built from screenpipe's redaction watermarks. The sanitized digest is built only from app identity and browser origin, never window titles or OCR text.
- Added `ScreenpipeBridge.runOnce()`, which polls for newly redacted frames, holds back segments that could still be extended (segment end within the idle window of "now"), and forwards closed segments to the gopk sink — which applies its own app allow/deny policy, so the bridge does no policy filtering itself.
- Added a file-based cursor store; polls re-fetch a small margin of already-cursored frames on every run so a frame whose redaction completes out of order (screenpipe's worker does not guarantee FIFO completion) still gets picked up, at the cost of a bounded worst-case miss window if redaction lags past that margin.

### Fixed (in `@pk-nerdsaver-ai/pi-activity-journal`)

- `gopk-clips.ts`'s `isLocalPointer` rejected plain POSIX absolute paths, accepting only Windows drive paths and `file://` URIs — silently dropping every clip on Linux/macOS. It now accepts POSIX absolute paths too.
