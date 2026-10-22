"""Exercise the reflection HTTP path with a local protocol fixture, no provider."""
import http.server
import json
from pathlib import Path
import tempfile
import threading
import unittest

from harness2.core.spec import ChannelSpec
from harness2.core.proposer import Reply
from reflection import TextReflection, valid_reflection


class ReflectionAcceptanceTests(unittest.TestCase):
    def test_exact_no_entry_with_optional_edits_is_valid(self):
        for text in ('NO_ENTRY', ' \nNO_ENTRY\n', '<edits>Prompt shortened.</edits>\nNO_ENTRY'):
            self.assertTrue(valid_reflection(Reply(label='experience.agg1', text=text, ok=True), {}))

    def test_malformed_no_entry_mentions_are_rejected(self):
        for text in ('Cannot finish; the template says NO_ENTRY', 'NO_ENTRY because I failed',
                     '<edits>NO_ENTRY</edits>', '<edits>unfinished NO_ENTRY',
                     '```\nNO_ENTRY\n```', 'NO_ENTRY\n<experience>invalid</experience>'):
            self.assertFalse(valid_reflection(Reply(label='experience.agg1', text=text, ok=True), {}))

    def test_only_successful_upstream_accepted_experience_is_valid(self):
        accepted = {'cue': 'x', 'lesson': 'y', 'evidence': 'z'}
        self.assertTrue(valid_reflection(Reply(label='experience.agg1', text='experience XML', ok=True), accepted))
        self.assertFalse(valid_reflection(Reply(label='experience.agg1', text='NO_ENTRY', ok=False), {}))
        self.assertFalse(valid_reflection(Reply(label='experience.agg1', text='experience XML', ok=False), accepted))


class ReflectionTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.reply = '<experience>\ncue: x\nlesson: y\nevidence: z\n</experience>'
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                owner.requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                body = json.dumps({'choices': [{'message': {'content': owner.reply}}], 'usage': {'cost': 0}}).encode()
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        # Tests run in a private, network-unshared namespace before relay starts.
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 8000), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_complete_text_context_and_response_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'context/harness').mkdir(parents=True)
            (root / 'context/harness/systemprompt.md').write_text('Synthetic rule')
            (root / 'context/decision.md').write_text('Original decision evidence')
            result = TextReflection(ChannelSpec('opencode', 'h2/smoke'))._opencode(root, 'Reflect', '', 120)
            self.assertEqual(result[0], self.reply)
            self.assertEqual(len(self.requests), 1)
            body = self.requests[0]
            self.assertIn('Synthetic rule', body['messages'][1]['content'])
            self.assertIn('Original decision evidence', body['messages'][1]['content'])
            self.assertNotIn('tools', body)

    def test_oversized_evidence_refused_without_silent_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'context').mkdir()
            (root / 'context/evidence.md').write_text('x' * (321 * 1024))
            with self.assertRaisesRegex(ValueError, 'not truncated'):
                TextReflection(ChannelSpec('opencode', 'h2/smoke'))._opencode(root, 'Reflect', '', 120)
            self.assertEqual(self.requests, [])


if __name__ == '__main__':
    unittest.main()
