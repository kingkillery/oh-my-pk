"""Create only an isolated dummy-key profile; never read the host configuration."""
import os
from pathlib import Path
import re
import sys

profile = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--profile=')), 'preflight')
if not re.fullmatch(r'[a-zA-Z0-9-]+', profile):
    raise ValueError('invalid isolated profile name')
os.environ['PI_CONFIG_DIR'] = '.h2-ompk'
directory = Path(os.environ['HOME']) / '.h2-ompk/profiles' / profile / 'agent'
directory.mkdir(parents=True, exist_ok=True)
(directory / 'models.yml').write_text(Path('/runtime/models.json').read_text())
os.execv('/runtime/bin/omp-real', ['/runtime/bin/omp-real', *sys.argv[1:]])
