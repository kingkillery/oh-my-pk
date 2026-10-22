#!/usr/bin/env bash
set -euo pipefail
export PYTHONPATH=/job/upstream
python3.12 -B -c 'from harness2 import install; install.clone("opencode"); install.patch("opencode")'
npm install --prefix /job/upstream/dependencies/tools --ignore-scripts bun@1.3.11
node /job/upstream/dependencies/tools/node_modules/bun/install.js
/job/upstream/dependencies/tools/node_modules/.bin/bun install --frozen-lockfile --ignore-scripts --cwd /job/upstream/dependencies/opencode
mv /job/upstream/dependencies/opencode /job/upstream/dependencies/tools /job/runtime/dependencies/
# These credential-free download caches are not runtime inputs. Do not retain
# gigabytes per clean worker on a small /tmp volume.
rm -rf -- /job/build-home/.bun /job/build-home/.npm
python3.12 -B /package/configure_runtime.py
