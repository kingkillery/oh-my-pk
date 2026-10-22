"""Installer bundle exports only the two required inputs from a dirty package."""
from pathlib import Path
import tempfile
import unittest

from stage_prepare import stage


class PrepareTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        self.package, self.bundle = root / 'package', root / 'bundle'
        (self.package / 'sandbox').mkdir(parents=True)
        self.bundle.mkdir()
        (self.package / 'sandbox/build.sh').write_text('public installer')
        (self.package / 'sandbox/configure_runtime.py').write_text('public configuration')

    def test_dirty_package_exports_only_required_regular_files(self):
        for path in ('.env', 'credential.json', 'sandbox/debug.log', 'sandbox/private.py'):
            (self.package / path).write_text('synthetic private sentinel')
        stage(self.package, self.bundle)
        self.assertEqual(sorted(p.name for p in self.bundle.iterdir()), ['build.sh', 'configure_runtime.py'])
        self.assertEqual((self.bundle / 'build.sh').read_text(), 'public installer')
        self.assertEqual((self.bundle / 'configure_runtime.py').read_text(), 'public configuration')

    def test_existing_bundle_is_rejected(self):
        (self.bundle / '.env').write_text('synthetic private sentinel')
        with self.assertRaisesRegex(ValueError, 'empty'):
            stage(self.package, self.bundle)

    def test_symlinked_installer_input_is_rejected(self):
        source = self.package / 'sandbox/build.sh'
        source.unlink()
        try:
            source.symlink_to(self.package / 'sandbox/configure_runtime.py')
        except OSError:
            self.skipTest('Symlinks unavailable')
        with self.assertRaisesRegex(ValueError, 'regular file'):
            stage(self.package, self.bundle)
