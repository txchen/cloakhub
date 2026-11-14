import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest

spec=importlib.util.spec_from_file_location('runner',Path(__file__).with_name('run.py'))
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

class EvaluationTests(unittest.TestCase):
    def test_exact_summary_and_single_submission(self):
        rows=runner.dataset('extract',810)
        expected=runner.expected_summary(rows)
        case=dict(task='extract',input=rows,summaries=[expected])
        self.assertTrue(runner.score(case)['business_correct'])
        case['summaries']=[expected,expected]
        self.assertFalse(runner.score(case)['business_correct'])
        self.assertEqual(runner.score(case)['duplicate_writes'],1)
        case['summaries']=[{**expected,'valueCents':expected['valueCents']+1}]
        self.assertFalse(runner.score(case)['business_correct'])

    def test_batch_requires_exact_set_and_fields(self):
        rows=runner.dataset('batch',811)
        records=[{**row,'recordId':f'r{i}'} for i,row in enumerate(rows)]
        case=dict(task='batch',input=rows,records=records,interrupted=False,fault_done=threading.Event())
        self.assertTrue(runner.score(case)['business_correct'])
        case['records']=records[:-1]+[records[0]]
        result=runner.score(case)
        self.assertFalse(result['business_correct'])
        self.assertEqual(result['duplicate_writes'],1)
        self.assertEqual(result['missing_records'],1)
        case['records']=[{**record,'priceCents':record['priceCents']+1} for record in records]
        self.assertEqual(runner.score(case)['mismatched_records'],20)

    def test_usage_counts_completed_messages_not_streaming_deltas(self):
        with tempfile.TemporaryDirectory() as root:
            log=Path(root)/'agent.jsonl'
            event=dict(type='message_end',message=dict(role='assistant',stopReason='toolUse',usage=dict(input=10,output=4,cacheRead=20,cost=dict(total=.01)),content=[dict(type='toolCall',name='bash')]))
            log.write_text(json.dumps({**event,'type':'message_update'})+'\n'+json.dumps(event)+'\n')
            usage=runner.usage_from(log)
            self.assertEqual(usage['model_calls'],1)
            self.assertEqual(usage['tool_calls'],1)
            self.assertEqual(usage['usage']['cacheRead'],20)

class SummaryTests(unittest.TestCase):
    def test_pairs_keep_failures_and_direction(self):
        spec=importlib.util.spec_from_file_location('summary',Path(__file__).with_name('summarize.py'))
        summary=importlib.util.module_from_spec(spec);spec.loader.exec_module(summary)
        base=dict(task='recovery',repeat=0,seconds=100,passed=True,model_calls=10,tool_calls=9,
                  duplicate_writes=0,missing_records=0,
                  usage=dict(input=100,cacheRead=200,output=30,estimated_cost_usd=.01))
        rows=[dict(base,arm='baseline'),dict(base,arm='current',seconds=300,passed=False,missing_records=2)]
        result=summary.summarize(rows)
        self.assertEqual(result['total_runs'],2)
        task=result['tasks']['recovery']
        self.assertEqual(task['arms']['current']['passed'],0)
        self.assertEqual(task['arms']['current']['missing_records'],2)
        self.assertEqual(task['pairs'][0]['seconds_delta'],200)
        self.assertFalse(task['pairs'][0]['both_passed'])

if __name__=='__main__': unittest.main()
