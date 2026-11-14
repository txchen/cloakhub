"""Verify published metric consistency without reading private transcripts."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from summarize import summarize


def verify(path):
    rows=json.loads((path/'results.json').read_text())
    metadata=json.loads((path/'metadata.json').read_text())
    arms=metadata.get('arms',['baseline','current'])
    expected={(task,repeat,arm) for task in metadata['tasks'] for repeat in range(metadata['repeats']) for arm in arms}
    actual={(row['task'],row['repeat'],row['arm']) for row in rows}
    assert actual==expected and len(rows)==len(expected), 'Missing or duplicate trials'
    assert summarize(rows)==json.loads((path/'summary.json').read_text()), 'Summary mismatch'
    events={(item['task'],item['repeat'],item['arm']):item for item in json.loads((path/'events.json').read_text())}
    for row in rows:
        item=events[(row['task'],row['repeat'],row['arm'])]
        assert item['raw_sha256']==row['raw_sha256']
        assert len(item['events'])==row['model_calls']
        assert sum(len(e['tools']) for e in item['events'])==row['tool_calls']
        for key in ['input','output','cacheRead','cacheWrite','reasoning']:
            assert sum(e['usage'].get(key,0) for e in item['events'])==row['usage'][key]
        cost=sum(e['usage'].get('cost',{}).get('total',0) for e in item['events'])
        assert math.isclose(cost,row['usage']['estimated_cost_usd'],abs_tol=1e-12)
        passed=row['business_correct'] and not row['timed_out'] and row['exit_code']==0 and not row['fault_error']
        if row['task']=='recovery': passed=passed and row['interruption_injected'] and row['interruption_completed']
        assert bool(passed)==row['passed']
    frozen=path/'runner.py.txt'
    if frozen.exists(): assert hashlib.sha256(frozen.read_bytes()).hexdigest()==metadata['runner_hash']
    print(f'{path}: {len(rows)} trials, summaries, usage and outcome flags verified')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence',type=Path)
    verify(parser.parse_args().evidence)
