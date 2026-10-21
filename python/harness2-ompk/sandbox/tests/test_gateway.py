"""Offline contract checks; these never contact a model provider."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from gateway import Gateway, MAX_CALLS


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        directory = Path(self.temp.name) / 'route'
        directory.mkdir()
        catalog = {'data': [{'id': 'example/free:free', 'pricing': {'prompt': '0', 'completion': '0'}, 'supported_parameters': ['tools']}]}
        with patch('gateway.urllib.request.build_opener') as build:
            build.return_value.open.return_value.__enter__.return_value = io.BytesIO(json.dumps(catalog).encode())
            self.gateway = Gateway(directory, 'example/free:free', 'never-written-secret', 120)

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
        self.gateway.state['calls'] = MAX_CALLS
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
