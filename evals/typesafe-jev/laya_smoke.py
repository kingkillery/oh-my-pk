"""Frozen Laya smoke evaluation; run on Colab with corpus at /content/corpus.jsonl.
Not a calibrated benchmark or training run. Raw responses retained for scoring.
"""
import os
os.environ['USE_TF'] = '0'
import json
import time
import importlib.metadata
from pathlib import Path
import torch
import psutil
import laya

print(json.dumps({'stage': 'load', 'laya': importlib.metadata.version('laya'), 'torch': torch.__version__, 'gpu': torch.cuda.get_device_name(0)}), flush=True)
started = time.perf_counter()
agent = laya.load('convaiinnovations/laya', subfolder='typed-decisions')
print(json.dumps({'stage': 'loaded', 'seconds': time.perf_counter()-started, 'config': agent.cfg}, default=str), flush=True)
rows = [json.loads(line) for line in Path('/content/corpus.jsonl').read_text().splitlines() if line.strip()]
results = []
for index, row in enumerate(rows):
    torch.cuda.synchronize()
    started = time.perf_counter()
    try:
        response = agent.predict(row['state'], row['questions'])
        torch.cuda.synchronize()
        result = {'id': row['id'], 'latency_ms': (time.perf_counter()-started)*1000, 'cold_first_call': index == 0, 'response': response, 'labels': row.get('labels'), 'state_chars': len(json.dumps(row['state'])), 'question_count': len(row['questions'])}
    except Exception as error:
        result = {'id': row['id'], 'error': str(error)}
    results.append(result)
    Path('/content/laya-smoke-results.json').write_text(json.dumps({'config': agent.cfg, 'warning': 'SDK truncation may discard state; raw smoke test, not whole-state validation. First call includes warmup.', 'results': results, 'rss_bytes': psutil.Process().memory_info().rss, 'peak_cuda_allocated_bytes': torch.cuda.max_memory_allocated()}, default=str, indent=2))
    print(json.dumps(result, default=str), flush=True)
