"""Publish frozen adapter evidence, counters and synthetic write audits, never model text."""
import argparse, hashlib, json, statistics
from pathlib import Path

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def summary(rows):
    return dict(cases=len(rows),passed=sum(r['passed'] for r in rows),writes=sum(r['writes'] for r in rows),
        audited_writes=sum(e['valid'] for r in rows for e in r['audit']),wrong_scope_cases=sum(r['wrong_scope_writes'] for r in rows),
        phases=sum(len(r['phases']) for r in rows),
        estimated_cost_usd=sum(p['usage']['estimated_cost_usd'] for r in rows for p in r['phases']),
        median_case_seconds=statistics.median(sum(p['seconds'] for p in r['phases']) for r in rows))

def verify(root):
    meta=json.loads((root/'metadata.json').read_text());rows=json.loads((root/'results.json').read_text())
    assert len(rows)==len(meta['scenarios']), 'Incomplete matrix'
    for index,row in enumerate(rows):
        assert row['scenario']==meta['scenarios'][index]
        assert len(row['audit'])==row['writes']
        assert row['checkpoint_before_every_write']==all(e['valid'] for e in row['audit'])
        if row['passed']:
            assert not row['wrong_scope_writes'] and row['checkpoint_before_every_write']
            for phase in row['phases']:
                assert not phase['timed_out']
                assert phase['exit_code']==0 or (row['scenario'] in ['restart','disconnect'] and phase['phase']==1 and phase['interrupted'])
            if row['scenario'] in ['pagination','preflight','restart','disconnect','submit-retry']:
                assert row['exact_records'] and row['checkpoint_complete']
                assert row['writes']==(2 if row['scenario']=='pagination' else 3)
            else:
                assert row['blocked_reported'] and not row['checkpoint_complete']
                assert row['writes']==(0 if row['scenario']=='scope-flip' else 1)
                assert not any(e['phase']==2 for e in row['audit'])
                if row['scenario']!='scope-flip':
                    assert row['pending']['stage']=='sent' and row['pending']['key']==row['audit'][0]['key']
                    if 'pending_preserved' in row:assert row['pending_preserved']
        if row['audit'] and 'path' in row['audit'][0]:
            assert len({e['path'] for e in row['audit']})==1
            assert all(a['revision']<b['revision'] for a,b in zip(row['audit'],row['audit'][1:]))
    assert summary(rows)==json.loads((root/'summary.json').read_text())
    for name,sha in meta['skill_hashes'].items():assert digest(root/'snapshot'/(name+'.txt'))==sha,name
    assert digest(root/'run-source/adapter.py.txt')==meta['runner_sha256']
    assert digest(root/'run-source/adapter-fixture.html.txt')==meta['fixture_sha256']
    for entry in json.loads((root/'events.json').read_text()):
        phase=rows[entry['case']]['phases'][entry['phase']-1];events=entry['events']
        assert phase['model_calls']==len(events) and phase['tool_calls']==sum(len(e['tools']) for e in events)
        for key in ['input','output','cacheRead','cacheWrite','reasoning']:assert phase['usage'][key]==sum(e['usage'].get(key,0) for e in events)
    print(f'{root}: {len(rows)} cases, snapshots and counters verified')

def publish(source,destination):
    rows=json.loads((source/'results.json').read_text());meta=json.loads((source/'metadata.json').read_text())
    destination.mkdir(parents=True,exist_ok=False)
    for name,data in [('results.json',rows),('metadata.json',meta),('summary.json',summary(rows))]:
        (destination/name).write_text(json.dumps(data,indent=2)+'\n')
    for name,sha in meta['skill_hashes'].items():
        src=source/'skill'/name;assert digest(src)==sha
        dst=destination/'snapshot'/(name+'.txt');dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(src.read_bytes())
    (destination/'run-source').mkdir()
    for src in (source/'run-source').iterdir():(destination/'run-source'/(src.name+'.txt')).write_bytes(src.read_bytes())
    events=[]
    for i,row in enumerate(rows):
        for phase in row['phases']:
            p=source/f"{i}-{row['scenario']}"/f"events-{phase['phase']}.json"
            events.append(dict(case=i,phase=phase['phase'],raw_sha256=phase['raw_sha256'],events=json.loads(p.read_text())))
    (destination/'events.json').write_text(json.dumps(events,indent=2)+'\n')
    assessment=[]
    for row in rows:
        exercised=bool(row['writes']) if row['scenario']!='scope-flip' else row['not_sent']>0
        assessment.append(dict(scenario=row['scenario'],raw_passed=row['passed'],boundary_exercised=exercised,
            accepted=bool(row['passed'] and exercised),note='Raw score retained; zero writes alone do not prove a gate attempt.' if row['passed'] and not exercised else ''))
    (destination/'assessment.json').write_text(json.dumps(assessment,indent=2)+'\n')
    verify(destination)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('path',type=Path);parser.add_argument('--publish',type=Path);parser.add_argument('--verify',action='store_true');args=parser.parse_args()
    if args.verify:verify(args.path)
    elif args.publish:publish(args.path,args.publish)
    else:print(json.dumps(summary(json.loads((args.path/'results.json').read_text())),indent=2))
