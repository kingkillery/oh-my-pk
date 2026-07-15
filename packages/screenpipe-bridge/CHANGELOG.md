# Changelog

## [Unreleased]

### Added

- Added `ScreenpipeClient`, a read-only client for a local screenpipe instance's `/raw_sql` endpoint that only returns frames where every present payload carries its matching redaction watermark — text surfaces need their text-redaction watermarks, a snapshot needs the image-redaction watermark — re-validated client-side since screenpipe is a separate, untrusted process. Zoneless SQLite timestamps are normalized as UTC, SQL `NULL` serialized as `""` is treated as absent, and dropped rows are counted in a warning rather than vanishing silently. The query touches neither `image_redaction_version`/`image_redaction_regions` (dropped by screenpipe migration `20260507000000`) nor `content_hash` (a perceptual fingerprint of pre-redaction screen content).
- Added `segmentFramesIntoClips` to group redacted frames into per-device activity segments, split on app/window change (field-wise comparison, immune to concatenation collisions) or an idle gap; single-frame segments get a one-second minimum window so the sink's `endedAt > startedAt` check accepts them.
- Added `buildClipDerivative` to turn a segment into a `GopkCapturedDerivative` for the activity-journal gopk sink: an atomically-written local JSON manifest, a `clipHash` computed over frame identity only (never screen content), and an attestation built from screenpipe's redaction watermarks. The sanitized digest is built only from app identity and browser origin, never window titles or OCR text. Keyframe hashing requires an explicit `mediaRoot` and only reads a `snapshot_path` that resolves inside it — the path comes from an untrusted process, and hashing an attacker-chosen file would leak a content fingerprint.
- Added `ScreenpipeBridge.runOnce()`, which polls for newly redacted frames, holds back segments that could still grow (newest frame within the idle window of "now", or the device's last segment when the fetch page came back full), and forwards closed segments to the gopk sink — which applies its own app allow/deny policy, so the bridge does no policy filtering itself. Overlapping runs are rejected. The shared cursor is capped behind the earliest still-open segment across all devices, and never re-fetches behind itself: a frame whose redaction completes only after the cursor passed it is deliberately dropped, because re-slicing old frames would mint overlapping clipIds and duplicate evidence.
- Added a file-based cursor store with atomic writes (temp file + rename); a missing cursor file reads as 0 (first run) while a corrupt one throws instead of silently restarting from frame 0.

### Fixed (in `@pk-nerdsaver-ai/pi-activity-journal`)

- `gopk-clips.ts`'s `isLocalPointer` rejected plain POSIX absolute paths, accepting only Windows drive paths and `file://` URIs — silently dropping every clip on Linux/macOS. It now accepts single-leading-slash POSIX paths while still rejecting UNC-style `//host/share` paths.
