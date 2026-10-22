"""Regress DOM's actual scalar reply and exercise upstream's real audit cache."""
from pathlib import Path
import tempfile
import unittest

from harness2.core.proposer import Proposer, ProposerError, _call_fingerprint
from harness2.core.spec import ChannelSpec
from proposals import EDITOR_SYSTEM, require_notes
from reflection import PilotProposer

NOTES = ('Changed systemprompt.md to distinguish current evidence from earlier claims; '
         'the supplied baseline trajectory contained only the task text and one answer.')


class ProposalNotesTests(unittest.TestCase):
    def test_dom_classification_response_is_not_proposal_notes(self):
        # This is the exact response saved by the rejected clean DOM run.
        with self.assertRaisesRegex(ValueError, 'substantive <notes>'):
            require_notes('REUSE\n')

    def test_valid_notes_preserved_without_fabrication_or_padding(self):
        self.assertEqual(require_notes('<notes>\n' + NOTES + '\n</notes>'), NOTES)

    def test_short_padded_malformed_and_multiple_blocks_are_rejected(self):
        for text in ('<notes>REUSE' + ' ' * 100 + '</notes>', NOTES,
                     '<notes>' + NOTES, '<notes>' + NOTES + '</notes>extra',
                     '<notes>' + NOTES + '</notes><notes>' + NOTES + '</notes>'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                require_notes(text)

    def test_evidence_based_keep_base_is_valid(self):
        body = 'KEEP_BASE: The supplied trajectory shows no failed operation or unsupported edit; preserving the original prompt avoids adding speculative guidance.'
        self.assertEqual(require_notes('<notes>' + body + '</notes>'), body)


class ProposalCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.context = self.root / 'evidence'
        self.context.mkdir()
        (self.context / 'task.md').write_text('Synthetic target task; respond with one word.')
        self.audit = self.root / 'audit'
        self.spec = ChannelSpec('opencode', 'offline/unused')

    def seed_cache(self, label, response, *, editing):
        system = EDITOR_SYSTEM + '\n\n' if editing else ''
        key = _call_fingerprint(label, 'Edit the harness', system, self.context)
        paths = Proposer(self.spec, audit_dir=self.audit)._paths(label, key)
        paths['response'].write_text(response)
        paths['workspace'].mkdir()
        (paths['workspace'] / 'systemprompt.md').write_text('Synthetic candidate edit')
        return paths['workspace']

    def test_real_upstream_cache_cannot_reintroduce_dom_scalar_reply(self):
        self.seed_cache('dom1.a1', 'REUSE\n', editing=True)
        proposer = PilotProposer(self.spec, audit_dir=self.audit, attempts=1)
        with self.assertRaisesRegex(ProposerError, 'substantive <notes>'):
            proposer.call('Edit the harness', self.context, 'dom1.a1', harvest='context/harness')
        self.assertFalse(proposer._calls[-1].ok)
        self.assertIsNone(proposer._calls[-1].workspace)

    def test_real_upstream_cache_preserves_valid_notes_and_candidate(self):
        text = '<notes>' + NOTES + '</notes>'
        workspace = self.seed_cache('dom1.a1', text, editing=True)
        reply = PilotProposer(self.spec, audit_dir=self.audit, attempts=1).call(
            'Edit the harness', self.context, 'dom1.a1', harvest='context/harness')
        self.assertTrue(reply.cached)
        self.assertEqual(reply.text, text)
        self.assertEqual(reply.workspace, workspace)
        self.assertEqual((workspace / 'systemprompt.md').read_text(), 'Synthetic candidate edit')

    def test_non_editing_reply_keeps_its_own_contract(self):
        text = '```choice\nA\n```'
        self.seed_cache('select.agg1', text, editing=False)
        reply = PilotProposer(self.spec, audit_dir=self.audit, attempts=1).call(
            'Edit the harness', self.context, 'select.agg1')
        self.assertTrue(reply.cached)
        self.assertEqual(reply.text, text)
