"""Acceptance and paired accuracy require complete, delivered executions."""


def comparison_result(baseline, candidate, tasks, *, core, reflection_ok):
    expected = {(task, trial) for task in tasks for trial in range(2)}

    def index(rows):
        keyed = {(row['task'], row['trial']): row for row in rows}
        complete = (len(rows) == len(expected) == len(keyed)
                    and set(keyed) == expected
                    and all(row['delivered'] for row in rows))
        return keyed, complete

    before, baseline_complete = index(baseline)
    after, candidate_complete = index(candidate)
    comparisons = []
    for task, trial in sorted(expected):
        a, b = before.get((task, trial)), after.get((task, trial))
        available = bool(a and b and a['delivered'] and b['delivered'])
        comparisons.append({'task': task, 'trial': trial, 'available': available,
                            'baseline': a['score']['all_pass'] if available else None,
                            'selected': b['score']['all_pass'] if available else None})
    complete = core and reflection_ok and baseline_complete and candidate_complete
    improved = sum(r['available'] and not r['baseline'] and r['selected'] for r in comparisons)
    regressed = sum(r['available'] and r['baseline'] and not r['selected'] for r in comparisons)
    selected_pass = candidate_complete and all(r['score']['all_pass'] for r in candidate)
    conclusion = ('comparison incomplete; no accuracy conclusion' if not complete else
                  'regression on this small pilot' if regressed > improved else
                  'no demonstrated accuracy improvement' if improved == regressed else
                  'improvement on this small pilot only')
    return {'paired_comparisons': comparisons, 'improved_pairs': improved,
            'regressed_pairs': regressed, 'performance_conclusion': conclusion,
            'all_selected_checks_pass': selected_pass,
            'baseline_complete': baseline_complete, 'selected_complete': candidate_complete,
            'experiment_completed': complete, 'pass': complete and selected_pass}
