"""Launch one resource-capped clean worker and a host-only free model gateway."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

from gateway import Gateway


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', required=True, type=Path)
    parser.add_argument('--python', required=True, type=Path)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--credential-env', default='OPENROUTER_API_KEY')
    parser.add_argument('--seconds', type=int, default=1200)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args(argv)
    if not args.execute or os.environ.get('OMPK_HARNESS2_ENABLED') != '1':
        parser.error('--execute and OMPK_HARNESS2_ENABLED=1 required')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,47}', args.run_id) or not 120 <= args.seconds <= 1200:
        parser.error('run-id or bounded seconds invalid')
    job, python = args.job.resolve(strict=True), args.python.resolve(strict=True)
    if not str(job).startswith('/tmp/h2-'):
        parser.error('job must be on private Linux /tmp/h2-* storage')
    runtime, upstream = job / 'runtime', job / 'upstream'
    for path in (runtime / 'bin/omp-real', runtime / 'opencode.json', upstream / 'harness2/core/proposer.py', python / 'bin/python3.12'):
        if not path.is_file():
            parser.error('prepare runtime first: missing ' + str(path))
    run = job / 'runs' / args.run_id
    run.mkdir(parents=True, exist_ok=False)
    route = run / 'route'
    route.mkdir(mode=0o700)
    output = run / 'output'
    output.mkdir()
    source = run / 'source'
    package = Path(__file__).resolve().parent.parent
    source.mkdir()
    # Copy code/tests only, never ambient .env files, local profiles or run output.
    for folder in ('ompk_harness2', 'tests', 'sandbox'):
        for path in sorted((package / folder).rglob('*')):
            if path.is_symlink():
                raise ValueError('symlinks are not allowed in the source package')
            if path.is_file() and path.suffix in ('.py', '.sh') and '__pycache__' not in path.parts:
                target = source / path.relative_to(package)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
    manifest = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in sorted(source.rglob('*')) if p.is_file()}
    (run / 'source-manifest.json').write_text(json.dumps(manifest, indent=2))
    key = os.environ.get(args.credential_env, '')
    gateway = Gateway(route, args.model, key, args.seconds)
    key = ''
    unit = 'h2-' + args.run_id
    command = ['systemd-run', '--user', '--wait', '--pipe', '--collect', '--unit=' + unit,
        '-p', 'MemoryMax=2147483648', '-p', 'MemorySwapMax=0', '-p', 'CPUQuota=200%',
        '-p', 'TasksMax=128', '-p', f'RuntimeMaxSec={args.seconds}', '-p', 'TimeoutStopSec=5',
        '/bin/bash', str(source / 'sandbox/contained.sh'), str(source), str(upstream),
        str(runtime), str(python), str(route), str(output)]
    (run / 'command.json').write_text(json.dumps(command, indent=2))
    # Do not propagate the host credential or other ambient environment into systemd.
    clean_env = {k: os.environ[k] for k in ('PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS') if k in os.environ}
    process = None
    code = 2
    started = time.monotonic()
    try:
        gateway.start()
        with (run / 'worker.log').open('w') as log:
            process = subprocess.Popen(command, env=clean_env, stdout=log, stderr=subprocess.STDOUT)
            try:
                code = process.wait(timeout=args.seconds + 15)
            except subprocess.TimeoutExpired:
                code = 124
    finally:
        subprocess.run(['systemctl', '--user', 'stop', unit], env=clean_env, capture_output=True, timeout=15)
        if process and process.poll() is None:
            process.wait(timeout=15)
        gateway.close()
        active = subprocess.run(['systemctl', '--user', 'is-active', unit], env=clean_env,
                                capture_output=True, text=True, timeout=10).stdout.strip()
        cleanup = {'unit': unit, 'worker_exit': code, 'worker_active': active,
                   'gateway_stopped': True, 'socket_removed': not (route / 'model.sock').exists(),
                   'elapsed_seconds': round(time.monotonic() - started, 2), 'resumed': False}
        (run / 'cleanup.json').write_text(json.dumps(cleanup, indent=2))
        print('WORKER_EXIT', code, 'UNIT_STATE', active, 'RECEIPTS', run, flush=True)
    if active == 'active' or not cleanup['socket_removed']:
        return 3
    return code


if __name__ == '__main__':
    raise SystemExit(main())
