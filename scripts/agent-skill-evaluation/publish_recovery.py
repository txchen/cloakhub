"""Export checkpoint audit and numeric events; keep model transcripts private."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics


def summary(rows):
    return dict(cases=len(rows),passed=sum(row['passed'] for row in rows),
        successful_completions=sum(row['passed'] and row['expected_outcome']=='complete' for row in rows),
        correct_blocks=sum(row['passed'] and row['expected_outcome']=='blocked' for row in rows),
        writes=sum(row['writes'] for row in rows),
        audited_writes=sum(event['valid'] for row in rows for event in row['audit']),
        total_estimated_cost_usd=sum(phase['usage']['estimated_cost_usd'] for row in rows for phase in row['phases']),
        median_case_seconds=statistics.median(sum(phase['seconds'] for phase in row['phases']) for row in rows))


def verify(path):
    rows=json.loads((path/'results.json').read_text());metadata=json.loads((path/'metadata.json').read_text())
    assert len(rows)==len(metadata['scenarios']), 'Incomplete matrix'
    for index,row in enumerate(rows):
        assert row['scenario']==metadata['scenarios'][index] and row['seed']==metadata['seed_start']+index
        assert len(row['audit'])==row['writes']
        assert row['checkpoint_before_every_write']==bool(row['audit'] and all(e['valid'] for e in row['audit']))
        assert row['resume_writes']==sum(e['phase']==2 for e in row['audit'])
        if row['passed']:
            assert len(row['phases'])==2 and row['checkpoint_before_every_write']
            assert row['phases'][0]['interrupted'] and not row['phases'][1]['timed_out']
            assert row['phases'][1]['exit_code']==0 and not row['fault_error'] and not row['unexpected_early_replay']
            if row['expected_outcome']=='complete':assert row['exact_records'] and row['records']==20 and row['duplicate_records']==0 and row['checkpoint_complete']
            else:assert row['resume_writes']==0 and row['pending_preserved'] and row['blocked_reported']
            if row['scenario']=='delayed':assert row['incomplete_reads']>0
    assert summary(rows)==json.loads((path/'summary.json').read_text())
    for item in json.loads((path/'events.json').read_text()):
        phase=rows[item['case']]['phases'][item['phase']-1];events=item['events']
        assert phase['model_calls']==len(events) and phase['tool_calls']==sum(len(e['tools']) for e in events)
        for key in ['input','output','cacheRead','cacheWrite','reasoning']:
            assert phase['usage'][key]==sum(e['usage'].get(key,0) for e in events)
        assert abs(phase['usage']['estimated_cost_usd']-sum(e['usage'].get('cost',{}).get('total',0) for e in events))<1e-12
    print(f'{path}: {len(rows)} cases and checkpoint/usage metrics verified')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path',type=Path);parser.add_argument('--publish',type=Path);parser.add_argument('--verify',action='store_true')
    args=parser.parse_args()
    if args.verify:verify(args.path);return
    rows=json.loads((args.path/'results.json').read_text());metrics=summary(rows);print(json.dumps(metrics,indent=2))
    if args.publish:
        args.publish.mkdir(parents=True,exist_ok=True)
        for name,data in [('results.json',rows),('summary.json',metrics),('metadata.json',json.loads((args.path/'metadata.json').read_text()))]:
            (args.publish/name).write_text(json.dumps(data,indent=2)+'\n')
        events=[]
        for index,row in enumerate(rows):
            directory=args.path/f"{index}-{row['scenario']}"
            for phase in row['phases']:
                events.append(dict(case=index,phase=phase['phase'],raw_sha256=phase['raw_sha256'],events=json.loads((directory/f"events-{phase['phase']}.json").read_text())))
        (args.publish/'events.json').write_text(json.dumps(events,indent=2)+'\n')
        verify(args.publish)

if __name__=='__main__':main()
