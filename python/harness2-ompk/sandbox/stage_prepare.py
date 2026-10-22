"""Export the exact two reviewed installer inputs, never ambient package files."""
from pathlib import Path
import shutil
import sys

FILES = ('build.sh', 'configure_runtime.py')


def stage(package, destination):
    sandbox = Path(package) / 'sandbox'
    destination = Path(destination)
    if sandbox.is_symlink() or not sandbox.is_dir():
        raise ValueError('Installer source must be a real directory')
    if any(destination.iterdir()):
        raise ValueError('Installer bundle must be empty')
    for name in FILES:
        source = sandbox / name
        if source.is_symlink() or not source.is_file():
            raise ValueError('Installer input must be a regular file: ' + name)
        shutil.copyfile(source, destination / name)
        (destination / name).chmod(0o444)


if __name__ == '__main__':
    stage(sys.argv[1], sys.argv[2])
