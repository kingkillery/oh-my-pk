"""Real adapter artifacts distinguish missing executions from wrong answers."""
import os
from pathlib import Path
import tempfile
import unittest

from ompk_harness2.adapter import OmpkBenchmarkAdapter, TASKS
from results import comparison_result
from worker import evaluate


class ResultTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.adapter = OmpkBenchmarkAdapter(self.root / 'adapter', binary='/usr/bin/false',
                                            solver_model='offline/unused', allow_execution=True)

    def rows(self, name):
        rows = []
        for trial in range(2):
            for task, (_, expected) in TASKS.items():
                run = self.root / name / f'{trial}-{task}'
                run.mkdir(parents=True)
                (run / 'answer.txt').write_text(expected)
                rows.append({'task': task, 'trial': trial, 'run_dir': str(run),
                             'delivered': self.adapter.delivered(run),
                             'score': self.adapter.score(run, task)})
        return rows

    def compare(self, before, after, **overrides):
        options = {'core': True, 'reflection_ok': True, **overrides}
        return comparison_result(before, after, self.adapter.tasks(), **options)

    @unittest.skipIf(os.name == 'nt', 'Uses real POSIX failure executable')
    def test_baseline_process_failure_cannot_pass_or_claim_improvement(self):
        previous = os.environ.get('OMPK_HARNESS2_ENABLED')
        os.environ['OMPK_HARNESS2_ENABLED'] = '1'
        try:
            baseline = evaluate(self.adapter, self.adapter.base_harness(), 'failed')
        finally:
            if previous is None:
                os.environ.pop('OMPK_HARNESS2_ENABLED', None)
            else:
                os.environ['OMPK_HARNESS2_ENABLED'] = previous
        before = self.rows('before')
        before[0] = baseline[0]  # One intermittent failure among otherwise valid results.
        result = self.compare(before, self.rows('after'))
        self.assertFalse(result['pass'])
        self.assertFalse(result['experiment_completed'])
        self.assertEqual(result['improved_pairs'], 0)
        unavailable = [r for r in result['paired_comparisons'] if not r['available']]
        self.assertEqual(len(unavailable), 1)
        self.assertIsNone(unavailable[0]['baseline'])
        self.assertIn('incomplete', result['performance_conclusion'])

    def test_delivered_wrong_answer_is_still_a_valid_accuracy_comparison(self):
        before, after = self.rows('before'), self.rows('after')
        run = Path(before[0]['run_dir'])
        (run / 'answer.txt').write_text('WRONG')
        before[0]['score'] = self.adapter.score(run, before[0]['task'])
        result = self.compare(before, after)
        self.assertTrue(result['pass'])
        self.assertTrue(result['experiment_completed'])
        self.assertEqual(result['improved_pairs'], 1)

    def test_complete_regression_is_completed_but_rejected(self):
        before, after = self.rows('before'), self.rows('after')
        (Path(after[0]['run_dir']) / 'answer.txt').write_text('WRONG')
        after[0]['score'] = self.adapter.score(Path(after[0]['run_dir']), after[0]['task'])
        result = self.compare(before, after)
        self.assertTrue(result['experiment_completed'])
        self.assertFalse(result['pass'])
        self.assertEqual(result['regressed_pairs'], 1)

    def test_pairing_uses_task_and_trial_not_row_order(self):
        result = self.compare(self.rows('before'), list(reversed(self.rows('after'))))
        self.assertTrue(result['pass'])
        self.assertEqual((result['improved_pairs'], result['regressed_pairs']), (0, 0))

    def test_missing_duplicate_or_undelivered_candidate_is_rejected(self):
        before, after = self.rows('before'), self.rows('after')
        missing = after[:-1]
        duplicate = after[:-1] + [after[0]]
        undelivered = [dict(r) for r in after]
        undelivered[0]['delivered'] = False
        for invalid in (missing, duplicate, undelivered):
            with self.subTest(invalid=invalid):
                result = self.compare(before, invalid)
                self.assertFalse(result['experiment_completed'])
                self.assertFalse(result['pass'])

    def test_core_or_reflection_failure_blocks_acceptance(self):
        before, after = self.rows('before'), self.rows('after')
        for options in ({'core': False}, {'reflection_ok': False}):
            result = self.compare(before, after, **options)
            self.assertFalse(result['pass'])
            self.assertFalse(result['experiment_completed'])
