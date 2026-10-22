"""Real user-systemd services exercise unit collision and cleanup ownership.

Run on the Linux host before live work, outside the network-denied namespace.
No model calls, credentials, or production services are used.
"""
import os
import shutil
import subprocess
import unittest

from lifecycle import WorkerUnit


@unittest.skipUnless(shutil.which('systemd-run') and os.environ.get('XDG_RUNTIME_DIR'),
                     'Requires a systemd user manager on the host')
class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.env = {k: os.environ[k] for k in ('PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS')
                    if k in os.environ}
        probe = subprocess.run(['systemctl', '--user', 'show-environment'], env=self.env,
                               capture_output=True, timeout=10)
        if probe.returncode:
            self.skipTest('User systemd manager unavailable')

    def launch(self, unit):
        result = subprocess.run(['systemd-run', '--user', '--collect', *unit.launch_options(),
                                 '-p', 'RuntimeMaxSec=30', '/bin/sleep', '30'], env=self.env,
                                capture_output=True, timeout=10)
        if result.returncode == 0:
            self.addCleanup(unit.stop, self.env)
        return result

    def active(self, unit):
        result = subprocess.run(['systemctl', '--user', 'is-active', unit.name], env=self.env,
                                capture_output=True, text=True, timeout=10)
        return result.stdout.strip() == 'active'

    def test_same_run_id_has_independent_cleanup(self):
        first, second = WorkerUnit('lifecycle-test'), WorkerUnit('lifecycle-test')
        self.assertNotEqual(first.name, second.name)
        self.assertEqual(self.launch(first).returncode, 0)
        self.assertEqual(self.launch(second).returncode, 0)
        self.assertTrue(second.stop(self.env))
        self.assertTrue(self.active(first))
        self.assertFalse(self.active(second))

    def test_failed_colliding_launch_cannot_stop_existing_service(self):
        first, second = WorkerUnit('collision-test'), WorkerUnit('collision-test')
        self.assertEqual(self.launch(first).returncode, 0)
        second.name = first.name  # Exercise the original collision with real systemd.
        self.assertNotEqual(self.launch(second).returncode, 0)
        self.assertFalse(second.stop(self.env))
        self.assertTrue(self.active(first))

    def test_cleanup_before_launch_does_not_stop_other_worker(self):
        first, never_started = WorkerUnit('early-failure'), WorkerUnit('early-failure')
        self.assertEqual(self.launch(first).returncode, 0)
        self.assertFalse(never_started.stop(self.env))
        self.assertTrue(self.active(first))
