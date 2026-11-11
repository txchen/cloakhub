"""Offline tests only: no Pi, remote CDP, model calls or network listeners."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load('comparison_runner', 'run.py')
exporter = load('comparison_exporter', 'summarize-private-logs.py')


class OfflineChecks(unittest.TestCase):
    def test_known_inventory_totals(self):
        self.assertEqual([runner.expected_body(runner.rows_for(i), i)['total'] for i in range(3)], [43, 19, 25])
        self.assertTrue(all(len(runner.rows_for(i)) == 12 for i in range(3)))

    def test_exactly_one_correct_business_submission(self):
        body = runner.expected_body(runner.rows_for(1), 1)
        self.assertTrue(runner.correct_submission([body], body))
        for bad in [[], [body, body], [dict(body, total=17)], [dict(body, confirmed=1)], [dict(body, extra='x')], [None]]:
            self.assertFalse(runner.correct_submission(bad, body))

    def test_owned_process_cleanup_without_an_agent(self):
        proc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        try:
            runner.stop_owned(proc)
            self.assertIsNotNone(proc.poll())
        finally:
            runner.stop_owned(proc)

    def test_fixture_origin_does_not_intercept_real_sites(self):
        self.assertEqual(runner.origin('http://example.test:18765/'), 'http://example.test:18765')
        for bad in ['https://example.test', 'http://example.com', 'http://secret@example.test', 'http://example.test/?token=secret', 'http://example.test/path']:
            with self.assertRaises(ValueError):
                runner.origin(bad)

    def test_configuration_requires_explicit_profile_and_is_nonexecuting(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            skill = directory / 'skill'
            (skill / 'scripts').mkdir(parents=True)
            (skill / 'SKILL.md').write_text('stub')
            (skill / 'scripts/browser.mjs').write_text('stub')
            bu_skill = directory / 'bu-skill.md'
            bu_skill.write_text('stub')
            output = directory / 'new-output'
            env = dict(COMPARISON_CLOAKHUB_SKILL_DIR=str(skill), COMPARISON_BU_BIN=sys.executable,
                       COMPARISON_BU_SKILL=str(bu_skill), COMPARISON_TARGET='dedicated-test',
                       COMPARISON_CDP_WS='wss://example.invalid/cdp?token=never-publish-this',
                       COMPARISON_PI_BIN=sys.executable, COMPARISON_OUTPUT=str(output))
            with self.assertRaises(ValueError):
                runner.configuration(env)
            env['COMPARISON_CONFIRM_ISOLATED_PROFILE'] = 'yes'
            planned = subprocess.run([sys.executable, str(ROOT / 'run.py')], env=env, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(planned.stdout)['status'], 'planned-only')
            self.assertNotIn('never-publish-this', planned.stdout + planned.stderr)
            self.assertFalse(output.exists())
            for updates in [{'COMPARISON_ARMS': 'unknown'}, {'COMPARISON_OUTPUT': str(ROOT)}, {'COMPARISON_REPEATS': '0'}]:
                with self.assertRaises(ValueError):
                    runner.configuration({**env, **updates})

    def test_exporter_omits_reasoning_prompts_commands_and_outputs(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            original_root = exporter.ROOT
            exporter.ROOT = root
            try:
                event = {'type': 'message_end', 'message': {'role': 'assistant', 'usage': {'input': 1, 'output': 2, 'cacheRead': 0, 'reasoning': 3, 'cost': {'total': 0.1}},
                         'content': [{'type': 'thinking', 'thinking': 'private-reasoning'}, {'type': 'text', 'text': 'private-output'},
                                     {'type': 'toolCall', 'name': 'bash', 'arguments': {'command': 'private-command'}}]}}
                file = root / 'cloakhub-0.jsonl'
                file.write_text(json.dumps(event) + '\n')
                summary = exporter.summarize(file)
                encoded = json.dumps(summary)
                for secret in ['private-reasoning', 'private-output', 'private-command']:
                    self.assertNotIn(secret, encoded)
                self.assertEqual(summary['assistant_calls'][0]['tools'], ['bash'])
                self.assertEqual(summary['assistant_calls'][0]['usage']['reasoning'], 3)
                self.assertFalse(summary['has_result'])
            finally:
                exporter.ROOT = original_root


if __name__ == '__main__':
    unittest.main()
