#!/usr/bin/env bash
# Build pinned, disposable tools without mounting the operator's home or keys.
set -euo pipefail
if [ "$#" != 4 ]; then
  echo 'usage: bash sandbox/prepare.sh NEW_ROOT PYTHON_ROOT OMP_BINARY UPSTREAM_ARCHIVE' >&2
  exit 2
fi
root=$(realpath -m "$1")
python=$(realpath "$2")
binary=$(realpath "$3")
archive=$(realpath "$4")
package=$(cd "$(dirname "$0")/.." && pwd)
case "$root" in /tmp/h2-*) ;; *) echo 'Use a new /tmp/h2-* directory on Linux storage' >&2; exit 2;; esac
test ! -e "$root"
test -x "$python/bin/python3.12"
test -f "$binary"
echo '2337f91b71a130e055d8dfb99ead2667a46087c29df939d4d4f0a3c357b5748f  '"$archive" | sha256sum -c -
mkdir -m 700 "$root"
mkdir -p "$root/runtime/bin" "$root/runtime/dependencies" "$root/upstream" "$root/build-home"
cp --dereference "$binary" "$root/runtime/bin/omp-real"
chmod 755 "$root/runtime/bin/omp-real"
"$python/bin/python3.12" -B -c 'import sys,tarfile; tarfile.open(sys.argv[1]).extractall(sys.argv[2],filter="data")' "$archive" "$root/extracted"
cp -a "$root/extracted/harness2-1cfe254e8d25b15f37048c3730134686abe60335/." "$root/upstream/"
# The archive's dependencies directory also contains upstream provenance files.
# Install beside them, then move only executable dependencies into runtime.
timeout --signal=TERM --kill-after=10s 900s bwrap \
  --unshare-all --share-net --die-with-parent --new-session --cap-drop ALL --clearenv \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
  --proc /proc --dev /dev --tmpfs /tmp --dir /home --dir /etc \
  --ro-bind /etc/ssl/certs /etc/ssl/certs --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --ro-bind "$python" /python --ro-bind "$package" /package --bind "$root" /job \
  --setenv HOME /job/build-home --setenv PATH /python/bin:/usr/bin:/bin \
  --setenv PYTHONDONTWRITEBYTECODE 1 --setenv RAYON_NUM_THREADS 2 --chdir /job \
  /bin/bash --noprofile --norc /package/sandbox/build.sh 2>&1 | tee "$root/build.log"
echo PREPARE_EXIT=0
