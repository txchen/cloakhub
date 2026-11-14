import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0,str(Path(__file__).parent))
import recovery

class CheckpointScoringTests(unittest.TestCase):
    def test_write_audit_checks_disk_identity_pending_and_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace=Path(directory)
            rows=recovery.common.dataset('recovery',1210)
            case=dict(workspace=workspace,attempts=1,phase=1,records=[],input=rows,
                      hub='http://127.0.0.1:1234',profile='test',origin='http://172.17.0.1:4321',
                      checkpoint_path=None,last_revision=0)
            saved=dict(version=1,identity=dict(inputDigest=recovery.digest(rows),hubOrigin=case['hub'],profileId='test',siteOrigin=case['origin'],accountKey='evaluation-tenant'),
                       pending=dict(key=rows[0]['key']),completed=[],revision=3)
            path=workspace/'checkpoint.json'
            self.assertFalse(recovery.audit_before_write(case,rows[0])['valid'])
            path.write_text(json.dumps(saved))
            self.assertTrue(recovery.audit_before_write(case,rows[0])['valid'])
            self.assertFalse(recovery.audit_before_write(case,rows[0])['valid']) # Revision did not advance.
            saved['revision']=4;saved['pending']=None;path.write_text(json.dumps(saved))
            self.assertFalse(recovery.audit_before_write(case,rows[0])['valid'])
            saved['revision']=5;saved['pending']=dict(key=rows[0]['key']);saved['identity']['accountKey']='wrong';path.write_text(json.dumps(saved))
            self.assertFalse(recovery.audit_before_write(case,rows[0])['valid'])

    def test_block_score_rejects_missing_checkpoint_or_further_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace=Path(directory);rows=recovery.common.dataset('recovery',1210)
            records=[{**row,'recordId':f'r{i}'} for i,row in enumerate(rows[:6])]
            saved=dict(version=1,identity={},status='active',pending=dict(key=rows[6]['key'],attemptId='attempt'),
                       completed=[dict(key=row['key'],recordId=row['recordId']) for row in records])
            path=workspace/'checkpoint.json';path.write_text(json.dumps(saved))
            event=dict(type='message_end',message=dict(role='assistant',stopReason='stop',content=[dict(type='text',text='Blocked: uncertain submission.')]))
            (workspace/'agent-2.jsonl').write_text(json.dumps(event))
            done=threading.Event();done.set()
            case=dict(workspace=workspace,input=rows,records=records,scenario='unknown',seed=1210,
                fault_records=json.loads(json.dumps(records)),pending_at_fault=[(path,saved)],audit=[dict(valid=True,phase=1)],
                interrupted=True,fault_done=done,unexpected_early_replay=0,incomplete_reads=0,attempts=7)
            phases=[dict(interrupted=True),dict(timed_out=False,exit_code=0)]
            self.assertTrue(recovery.score(case,phases)['passed'])
            case['audit'].append(dict(valid=True,phase=2))
            self.assertFalse(recovery.score(case,phases)['passed'])
            case['audit'].pop();path.unlink()
            self.assertFalse(recovery.score(case,phases)['passed'])

    def test_final_text_excludes_reasoning_and_tool_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'agent.jsonl'
            events=[dict(type='message_end',message=dict(role='assistant',stopReason='toolUse',content=[dict(type='thinking',thinking='blocked'),dict(type='text',text='intermediate')])),
                    dict(type='message_end',message=dict(role='assistant',stopReason='stop',content=[dict(type='thinking',thinking='private'),dict(type='text',text='Stopped: duplicate record.')]))]
            path.write_text('\n'.join(json.dumps(e) for e in events))
            self.assertEqual(recovery.final_text(path),'Stopped: duplicate record.')

if __name__=='__main__':unittest.main()
