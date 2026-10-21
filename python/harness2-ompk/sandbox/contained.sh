#!/usr/bin/env bash
set -euo pipefail
source=$1 upstream=$2 runtime=$3 python=$4 route=$5 output=$6
group=$(cut -d: -f3 /proc/self/cgroup)
limits=/sys/fs/cgroup$group
test "$(cat "$limits/memory.max")" = 2147483648
test "$(cat "$limits/memory.swap.max")" = 0
test "$(cat "$limits/pids.max")" = 128
test "$(cat "$limits/cpu.max")" = '200000 100000'
ulimit -c 0
exec bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL --clearenv \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --proc /proc --dev /dev --tmpfs /tmp --dir /etc --dir /home --tmpfs /home/sandbox \
  --ro-bind "$limits" /limits --ro-bind "$source" /src --ro-bind "$upstream" /upstream \
  --ro-bind "$runtime" /runtime --ro-bind "$runtime/dependencies" /upstream/dependencies \
  --ro-bind "$python" /python --ro-bind "$route" /gateway --bind "$output" /work \
  --setenv HOME /home/sandbox --setenv PATH /runtime/bin:/python/bin:/usr/bin:/bin \
  --setenv PYTHONPATH /src:/src/sandbox:/upstream --setenv PYTHONDONTWRITEBYTECODE 1 \
  --setenv OMPK_HARNESS2_ENABLED 1 --setenv OMPK_COLLECTOR_SKIP 1 \
  --setenv OPENCODE_DISABLE_MODELS_FETCH true --setenv OPENCODE_CONFIG /runtime/opencode.json \
  --setenv RAYON_NUM_THREADS 2 --setenv UV_THREADPOOL_SIZE 2 --setenv TMPDIR /tmp \
  --chdir /src /bin/bash --noprofile --norc /src/sandbox/inner.sh
