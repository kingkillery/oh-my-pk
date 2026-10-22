"""Unique transient service identity and ownership-checked cleanup."""
import shlex
import subprocess
import uuid


class WorkerUnit:
    def __init__(self, run_id):
        self.token = uuid.uuid4().hex
        self.name = 'h2-' + run_id + '-' + self.token

    def launch_options(self):
        return ['--unit=' + self.name, '-p', 'Environment=H2_UNIT_OWNER=' + self.token]

    def stop(self, env):
        result = subprocess.run(['systemctl', '--user', 'show', self.name,
                                 '-p', 'Environment', '--value'], env=env,
                                capture_output=True, text=True, timeout=10)
        if result.returncode or 'H2_UNIT_OWNER=' + self.token not in shlex.split(result.stdout):
            return False
        subprocess.run(['systemctl', '--user', 'stop', self.name], env=env,
                       capture_output=True, timeout=15, check=True)
        return True
