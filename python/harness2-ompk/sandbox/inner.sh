#!/usr/bin/env bash
set -euo pipefail
python3.12 -B -m unittest discover -s /src/tests -v
python3.12 -B -m unittest discover -s /src/sandbox/tests -v
python3.12 -B /src/sandbox/relay.py &
relay=$!
trap 'kill "$relay" 2>/dev/null || true' EXIT
python3.12 -B /src/sandbox/worker.py
