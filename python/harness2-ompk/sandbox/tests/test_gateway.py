"""Offline contract checks; these never contact a model provider."""
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from gateway import Gateway, MAX_CALLS


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name) / 'route'
        directory.mkdir()
        # Exercise the real request policy/file writer without model discovery.
        self.gateway = object.__new__(Gateway)
        self.gateway.directory = directory
        self.gateway.model = 'example/free:free'
        self.gateway._key = 'never-written-secret'
        self.gateway.deadline = time.monotonic() + 120
        self.gateway.lock = threading.Lock()
        self.gateway.state = {'calls': 0, 'input_bytes': 0, 'requests': []}

    def payload(self, **updates):
        body = {'model': 'smoke', 'messages': [{'role': 'user', 'content': 'synthetic'}]}
        body.update(updates)
        return json.dumps(body).encode()

    def test_price_and_routing_overrides_are_forced(self):
        body, _ = self.gateway.reserve(self.payload(provider={'allow_fallbacks': True},
            plugins=[{'id': 'web'}], max_tokens=999999))
        self.assertEqual(body['provider'], {'max_price': {'prompt': 0, 'completion': 0}, 'allow_fallbacks': False})
        self.assertEqual(body['plugins'], [])
        self.assertEqual(body['max_tokens'], 4096)
        self.assertEqual(body['model'], 'example/free:free')

    def test_arbitrary_models_fail_before_spending_budget(self):
        with self.assertRaises(ValueError):
            self.gateway.reserve(self.payload(model='paid/model'))
        self.assertEqual(self.gateway.state['calls'], 0)

    def test_exhausted_budget_refuses_and_does_not_reset(self):
        for _ in range(MAX_CALLS):
            self.gateway.reserve(self.payload())
        with self.assertRaises(TimeoutError):
            self.gateway.reserve(self.payload())
        self.assertEqual(self.gateway.state['calls'], MAX_CALLS)

    def test_metadata_excludes_credentials_and_prompt_text(self):
        self.gateway.reserve(self.payload())
        text = (self.gateway.directory.parent / 'gateway.json').read_text()
        self.assertNotIn('never-written-secret', text)
        self.assertNotIn('synthetic', text)
        self.assertIn('request_sha256', text)


if __name__ == '__main__':
    unittest.main()
