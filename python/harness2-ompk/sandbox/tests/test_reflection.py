"""Verify reflection sends complete evidence once without tools or answer keys."""
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from harness2.core.spec import ChannelSpec
from reflection import TextReflection


class ReflectionTests(unittest.TestCase):
    def test_complete_text_context_and_response_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'context/harness').mkdir(parents=True)
            (root / 'context/harness/systemprompt.md').write_text('Synthetic rule')
            (root / 'context/decision.md').write_text('Original decision evidence')
            expected = '<experience>\ncue: x\nlesson: y\nevidence: z\n</experience>'
            with patch('reflection.urllib.request.urlopen') as call:
                call.return_value.__enter__.return_value = io.BytesIO(json.dumps({
                    'choices': [{'message': {'content': expected}}], 'usage': {'cost': 0}}).encode())
                result = TextReflection(ChannelSpec('opencode', 'h2/smoke'))._opencode(root, 'Reflect', '', 120)
            body = json.loads(call.call_args.args[0].data)
            self.assertEqual(result[0], expected)
            self.assertIn('Synthetic rule', body['messages'][1]['content'])
            self.assertIn('Original decision evidence', body['messages'][1]['content'])
            self.assertNotIn('tools', body)
            self.assertEqual(call.call_count, 1)

    def test_oversized_evidence_refused_without_silent_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'context').mkdir()
            (root / 'context/evidence.md').write_text('x' * (321 * 1024))
            with patch('reflection.urllib.request.urlopen') as call:
                with self.assertRaisesRegex(ValueError, 'not truncated'):
                    TextReflection(ChannelSpec('opencode', 'h2/smoke'))._opencode(root, 'Reflect', '', 120)
                call.assert_not_called()


if __name__ == '__main__':
    unittest.main()
