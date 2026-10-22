"""One clean, non-resuming recursion plus paired baseline/candidate checks."""
from __future__ import annotations

import dataclasses
import json
from pathlib import Path
import socket
import subprocess
import time
import urllib.error
import urllib.request

from ompk_harness2.adapter import OmpkBenchmarkAdapter
from harness2.core.schedule import run_domain
from reflection import PilotProposer, valid_reflection
from results import comparison_result

ROOT = Path('/work')


def preflight():
    for path in ('/home/prest', '/mnt', '/var/run/docker.sock'):
        if Path(path).exists():
            raise RuntimeError('host path exposed: ' + path)
    for name, expected in (('memory.max', '2147483648'), ('memory.swap.max', '0'),
                           ('pids.max', '128'), ('cpu.max', '200000 100000')):
        if (Path('/limits') / name).read_text().strip() != expected:
            raise RuntimeError('cgroup limit missing: ' + name)
    for path in ('/src/ompk_harness2/adapter.py', '/runtime/bin/omp-real', '/upstream/harness2/core/proposer.py'):
        try:
            with open(path, 'a'):
                pass
        except OSError:
            pass
        else:
            raise RuntimeError('read-only mount not enforced: ' + path)
    with socket.socket() as probe:
        probe.settimeout(1)
        try:
            probe.connect(('1.1.1.1', 443))
        except OSError:
            pass
        else:
            raise RuntimeError('external network available')
    for _ in range(30):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8000/v1/models', timeout=1) as response:
                assert [m['id'] for m in json.load(response)['data']] == ['smoke']
            break
        except OSError:
            time.sleep(.1)
    else:
        raise RuntimeError('relay unavailable')
    for path, payload in (('/admin', None), ('/v1/chat/completions', {'model': 'paid/model', 'messages': [{'role': 'user', 'content': 'blocked'}]})):
        request = urllib.request.Request('http://127.0.0.1:8000' + path,
            json.dumps(payload).encode() if payload else None, {'Content-Type': 'application/json'})
        try:
            urllib.request.urlopen(request, timeout=3)
        except urllib.error.HTTPError as error:
            assert error.code in (400, 403, 404)
        else:
            raise RuntimeError('gateway policy bypass')
    version = subprocess.check_output(['/runtime/bin/omp', '--version'], text=True, timeout=60).strip()
    (ROOT / 'containment.json').write_text(json.dumps({'external_network_denied': True,
        'source_runtime_readonly': True, 'host_paths_absent': True, 'paid_routes_denied': True,
        'kernel_limits_verified': True, 'runtime_version': version}, indent=2))


def evaluate(adapter, tree, prefix):
    rows = []
    # Keep the original tasks and grader unchanged; two independent draws per task.
    for trial in range(2):
        for task in adapter.tasks():
            run = adapter.execute(task, tree, f'{prefix}-{trial}-{task}')
            rows.append({'task': task, 'trial': trial, 'answer': adapter.deliverable_text(run).strip(),
                         'score': adapter.score(run, task), 'delivered': adapter.delivered(run),
                         'run_dir': str(run)})
    return rows


def main():
    preflight()
    if (ROOT / 'experiment').exists():
        raise RuntimeError('Fresh output required; no receipt or model-cache resume')
    adapter = OmpkBenchmarkAdapter(ROOT / 'experiment', binary='/runtime/bin/omp',
        solver_model='h2/smoke', improver_model='h2/smoke', allow_execution=True,
        solver_prompt_mode='classification')
    channel = dataclasses.replace(adapter.spec.channels['proposer'], steps=20, timeout=180, effort='')
    guidance = ('Edit only systemprompt.md and tool_descriptions/tool_guidance.md under context/harness/. '
                'Keep guardrails.md and LongTermMEMORY.md unchanged. No added files, scripts, skills or subagents. '
                'This is a text-only classifier with no solver tools. Make a concise evidence-based edit, '
                'save the requested notes to output/answer.md and stop.')
    adapter.spec = dataclasses.replace(adapter.spec, channels={'proposer': channel, 'selector': channel},
        prompts=dataclasses.replace(adapter.spec.prompts, domain_guidance=guidance))
    baseline = evaluate(adapter, adapter.base_harness(), 'baseline')
    (ROOT / 'baseline.json').write_text(json.dumps(baseline, indent=2))
    proposer = PilotProposer(channel, audit_dir=ROOT / 'proposer-audit', attempts=1)
    result = run_domain('agent-operations', adapter.tasks('train')[:1], 1, adapter=adapter,
        prop=proposer, runs_root=adapter.spec.runs_root, library_root=ROOT / 'library', modes=('agg',))
    summary = json.loads((adapter.spec.runs_root / 'ompk-oc-agg1/existing-proof/summary.json').read_text())
    stages = summary['modes']['agg']['stages']
    selection = summary['selections']['agg']
    core = (result.get('done') == 1 and result.get('failed') == 0 and len(stages) == 3
            and all(not s['fell_back'] and not s['error'] and len(s['notes'].strip()) > 60 for s in stages))
    selected = adapter.spec.runs_root / 'ompk-oc-agg1/existing-proof/harnesses' / selection['chosen_label']
    adapter._read_candidate(selected)
    candidate = evaluate(adapter, selected, 'selected') if core else []
    reflections = [r for r in proposer._calls if r.label.startswith('experience.')]
    reflection_ok = len(reflections) == 1 and valid_reflection(
        reflections[0], selection.get('experience'))
    report = {'fresh_worker': True, 'resumed': False, 'scheduler': result, 'core_recursion_pass': core,
              'stages': stages, 'reflection_completed': reflection_ok,
              'experience_entry_recorded': bool(selection.get('experience')),
              'selected_tree_is_base': selection.get('chosen_tree_is_base'),
              'baseline': baseline, 'selected': candidate,
              'limits': 'Three fixed tasks, two draws each, one training task, k=1; not a general quality benchmark.'}
    report.update(comparison_result(baseline, candidate, adapter.tasks(),
                                    core=core, reflection_ok=reflection_ok))
    (ROOT / 'result.json').write_text(json.dumps(report, indent=2))
    print('CLEAN_SMOKE_RESULT', json.dumps({k: report[k] for k in ('pass', 'core_recursion_pass', 'reflection_completed', 'improved_pairs', 'regressed_pairs', 'performance_conclusion')}), flush=True)
    return 0 if report['pass'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
