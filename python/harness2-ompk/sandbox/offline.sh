#!/usr/bin/env bash
set -euo pipefail
if [ "$#" != 2 ]; then echo 'usage: bash sandbox/offline.sh PYTHON_ROOT UPSTREAM_ROOT' >&2; exit 2; fi
python=$(realpath "$1") upstream=$(realpath "$2")
source=$(cd "$(dirname "$0")/.." && pwd)
timeout --signal=TERM --kill-after=5s 180s bwrap \
  --unshare-all --die-with-parent --new-session --cap-drop ALL --clearenv \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --proc /proc --dev /dev --tmpfs /tmp --dir /home --tmpfs /home/sandbox \
  --ro-bind "$python" /python --ro-bind "$source" /src --ro-bind "$upstream" /upstream \
  --setenv HOME /home/sandbox --setenv PATH /python/bin:/usr/bin:/bin \
  --setenv PYTHONPATH /src:/src/sandbox:/upstream --setenv PYTHONDONTWRITEBYTECODE 1 \
  --chdir /src /bin/bash --noprofile --norc -c \
  'python3.12 -B -m unittest discover -s tests -v && python3.12 -B -m unittest discover -s sandbox/tests -v && python3.12 -B -m ompk_harness2.cli check --output=/tmp/offline-check'
