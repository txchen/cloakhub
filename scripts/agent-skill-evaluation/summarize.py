"""Export allowlisted metrics and paired summaries; raw model transcripts remain private."""
import argparse
import json
from pathlib import Path
import statistics


def summarize(rows):
    tasks={}
    for task in sorted({row['task'] for row in rows}):
        arms={}
        for arm in ['baseline','current']:
            values=[row for row in rows if row['task']==task and row['arm']==arm]
            if not values: continue
            arms[arm]=dict(runs=len(values),passed=sum(row['passed'] for row in values),
                median_seconds=round(statistics.median(row['seconds'] for row in values),3),
                mean_model_calls=round(statistics.mean(row['model_calls'] for row in values),2),
                mean_tool_calls=round(statistics.mean(row['tool_calls'] for row in values),2),
                mean_input_tokens=round(statistics.mean(row['usage']['input'] for row in values),2),
                mean_cache_read_tokens=round(statistics.mean(row['usage']['cacheRead'] for row in values),2),
                mean_output_tokens=round(statistics.mean(row['usage']['output'] for row in values),2),
                mean_estimated_cost_usd=round(statistics.mean(row['usage']['estimated_cost_usd'] for row in values),6),
                duplicate_writes=sum(row['duplicate_writes'] for row in values),missing_records=sum(row['missing_records'] for row in values))
        pairs=[]
        for repeat in sorted({row['repeat'] for row in rows if row['task']==task}):
            pair={row['arm']:row for row in rows if row['task']==task and row['repeat']==repeat}
            if len(pair)!=2: continue
            old,new=pair['baseline'],pair['current']
            pairs.append(dict(repeat=repeat,both_passed=old['passed'] and new['passed'],
                seconds_delta=round(new['seconds']-old['seconds'],3),model_calls_delta=new['model_calls']-old['model_calls'],
                estimated_cost_delta=round(new['usage']['estimated_cost_usd']-old['usage']['estimated_cost_usd'],6)))
        tasks[task]=dict(arms=arms,pairs=pairs)
    return dict(total_runs=len(rows),tasks=tasks)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('private_run',type=Path);parser.add_argument('--publish',type=Path)
    args=parser.parse_args()
    rows=json.loads((args.private_run/'results.json').read_text())
    summary=summarize(rows)
    print(json.dumps(summary,indent=2))
    if args.publish:
        args.publish.mkdir(parents=True,exist_ok=True)
        for name,value in [('results.json',rows),('summary.json',summary),('metadata.json',json.loads((args.private_run/'metadata.json').read_text()))]:
            (args.publish/name).write_text(json.dumps(value,indent=2)+'\n')
        compact=[]
        for row in rows:
            path=args.private_run/f"{row['task']}-{row['repeat']}-{row['arm']}"/'events.json'
            events=json.loads(path.read_text())
            compact.append(dict(arm=row['arm'],task=row['task'],repeat=row['repeat'],raw_sha256=row['raw_sha256'],events=events))
        (args.publish/'events.json').write_text(json.dumps(compact,indent=2)+'\n')

if __name__=='__main__': main()
