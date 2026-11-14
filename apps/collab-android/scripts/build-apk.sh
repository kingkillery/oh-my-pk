#!/usr/bin/env bash
# Debug-signed APK for the collab phone remote.
# Needs bun 1.3.14, JDK 21, and an Android SDK with platform android-37.0 and build-tools 36.0.0.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

if [[ -z "${ANDROID_HOME:-}" ]]; then
	echo "ANDROID_HOME is not set" >&2
	exit 1
fi

export PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"

if [[ ! -d node_modules ]]; then
	bun install --frozen-lockfile
fi

cd apps/collab-android
./gradlew :link:test :app:testDebugUnitTest assembleDebug --no-daemon "$@"
sha256sum app/build/outputs/apk/debug/app-debug.apk
