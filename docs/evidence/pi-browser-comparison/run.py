"""Opt-in pilot, parameterized after the historical experiment. Not a sandbox.

Default invocation only validates configuration and prints a redacted plan.
--execute invokes authenticated Pi and a remote browser and can incur model costs.
"""
import argparse
import json
import os
from pathlib import Path
import random
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from uuid import uuid4

ROOT = Path(__file__).resolve().parent


def rows_for(repeat):
    rng = random.Random(810 + repeat)
    return [dict(name=f"Item-{i+1:02}", price=rng.randint(10, 90), stock=rng.randint(0, 9)) for i in range(12)]


def expected_body(rows, repeat):
    return {"reference": f"REVIEW-{repeat}", "total": sum(r['stock'] for r in rows if r['stock'] > 0 and r['price'] <= 50), "confirmed": True}


def correct_submission(values, expected):
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
        return False
    body = values[0]
    return (set(body) == set(expected) and isinstance(body['reference'], str)
            and body['reference'] == expected['reference'] and body['confirmed'] is True
            and type(body['total']) in [int, float] and body['total'] == expected['total'])


def origin(value):
    url = urlsplit(value)
    if url.scheme != 'http' or not url.hostname or url.username or url.password or url.path not in ['', '/'] or url.query or url.fragment:
        raise ValueError('COMPARISON_BROWSER_ORIGIN must be a plain HTTP origin without credentials, path or query')
    if not (url.hostname.endswith('.test') or url.hostname in ['localhost', '127.0.0.1', '::1']):
        raise ValueError('Use a reserved .test or loopback fixture origin, not a live website')
    return value.rstrip('/')


def configuration(env):
    if os.name != 'posix':
        raise ValueError('This replay harness requires a POSIX host for owned-process-group cleanup')
    required = ['COMPARISON_CLOAKHUB_SKILL_DIR', 'COMPARISON_BU_BIN', 'COMPARISON_BU_SKILL', 'COMPARISON_TARGET', 'COMPARISON_CDP_WS']
    if any(not env.get(k) for k in required):
        raise ValueError('Required configuration: ' + ', '.join(required))
    if env.get('COMPARISON_CONFIRM_ISOLATED_PROFILE') != 'yes':
        raise ValueError('Confirm both clients use the same dedicated test profile: COMPARISON_CONFIRM_ISOLATED_PROFILE=yes')
    target = env['COMPARISON_TARGET']
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', target):
        raise ValueError('Invalid target name')
    cdp = urlsplit(env['COMPARISON_CDP_WS'])
    if cdp.scheme not in ['ws', 'wss'] or not cdp.hostname or cdp.username or cdp.password or cdp.fragment:
        raise ValueError('Invalid CDP endpoint (value withheld)')
    skill = Path(env['COMPARISON_CLOAKHUB_SKILL_DIR']).resolve()
    bu = Path(env['COMPARISON_BU_BIN']).resolve()
    bu_skill = Path(env['COMPARISON_BU_SKILL']).resolve()
    for path in [skill / 'SKILL.md', skill / 'scripts/browser.mjs', bu, bu_skill]:
        if not path.is_file():
            raise ValueError('A configured CLI or skill file is missing (path withheld)')
    if not os.access(bu, os.X_OK):
        raise ValueError('Configured Browser Use CLI is not executable')
    pi = shutil.which(env.get('COMPARISON_PI_BIN', 'pi'))
    if not pi:
        raise ValueError('Pi executable is unavailable')
    repeats = int(env.get('COMPARISON_REPEATS', '3'))
    port = int(env.get('COMPARISON_LOCAL_PORT', '18765'))
    if not 1 <= repeats <= 20 or not 1024 <= port <= 65535:
        raise ValueError('Invalid repeat count or fixture port')
    arms = env.get('COMPARISON_ARMS', 'cloakhub,browser-use').split(',')
    if len(set(arms)) != len(arms) or not arms or any(a not in ['cloakhub', 'browser-use'] for a in arms):
        raise ValueError('Invalid comparison arms')
    default_output = ROOT.parents[2] / '.cloakhub/pi-browser-comparison' / uuid4().hex
    output = Path(env.get('COMPARISON_OUTPUT', str(default_output))).resolve()
    if output.exists() or output == ROOT or ROOT in output.parents:
        raise ValueError('Output must be a fresh directory outside the archived evidence')
    return dict(skill=skill, bu=bu, bu_skill=bu_skill, pi=pi, target=target, cdp=env['COMPARISON_CDP_WS'],
                origin=origin(env.get('COMPARISON_BROWSER_ORIGIN', 'http://browser-evaluation.test:18765')),
                output=output, repeats=repeats, arms=arms, port=port,
                provider=env.get('COMPARISON_PROVIDER', 'openai'), model=env.get('COMPARISON_MODEL', 'gpt-6-luna'),
                extra=env.get('COMPARISON_EXTRA_PROMPT', ''))


def make_handler(cases, submissions):
    template = (ROOT / 'fixture.html').read_text()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_args):
            pass

        def do_GET(self):
            key = self.path.split('/')[-1]
            if key not in cases:
                self.send_error(404)
                return
            data = template.replace('ROWS', json.dumps(cases[key])).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            key = self.path.split('/')[-1]
            if key not in cases:
                self.send_error(404)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 65536:
                    raise ValueError()
                body = json.loads(self.rfile.read(size))
            except (ValueError, TimeoutError):
                self.send_error(400)
                return
            submissions.setdefault(key, []).append(body)
            # Historical fixture acknowledges receipt even if the business total
            # is wrong. Scoring is independent; "Review saved" is not a pass.
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
    return Handler


def stop_owned(proc):
    # Popen(start_new_session=True) gives this trial its own process group.
    # Check the group, not only the main process: children can outlive it.
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        proc.wait(timeout=5)
        return
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        proc.poll()
        try:
            os.killpg(proc.pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    proc.wait(timeout=5)


def interrupted(_signal, _frame):
    raise KeyboardInterrupt('Trial interrupted; inspect remote state before resuming')


def usage_from(log):
    usage = dict(input=0, output=0, cacheRead=0, reasoning=0, estimated_cost_usd=0)
    calls = tools = 0
    for line in log.read_text().splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        message = event.get('message', {})
        if event.get('type') != 'message_end' or message.get('role') != 'assistant':
            continue
        calls += 1
        values = message.get('usage', {})
        for key in ['input', 'output', 'cacheRead', 'reasoning']:
            usage[key] += values.get(key, 0)
        usage['estimated_cost_usd'] += values.get('cost', {}).get('total', 0)
        tools += sum(c.get('type') == 'toolCall' for c in message.get('content', []))
    return calls, tools, usage


def execute(config):
    output = config['output']
    output.mkdir(parents=True, mode=0o700)
    (output / '.gitignore').write_text('*\n')
    cases, submissions, results = {}, {}, []
    server = ThreadingHTTPServer(('127.0.0.1', config['port']), make_handler(cases, submissions))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = os.environ.copy()
    env.update(BU_CDP_WS=config['cdp'], BU_NAME='comparison-' + uuid4().hex,
               BH_TAB_MARKER='0', BH_RECORD='0', BH_DOMAIN_SKILLS='0')
    previous_term = signal.signal(signal.SIGTERM, interrupted)
    try:
        for repeat in range(config['repeats']):
            rows = rows_for(repeat)
            arms = config['arms'] if repeat % 2 == 0 else list(reversed(config['arms']))
            for arm in arms:
                key = f'{arm}-{repeat}'
                cases[key] = rows
                url = f"{config['origin']}/case/{key}"
                if arm == 'cloakhub':
                    setup = (f"Read {config['skill']}/SKILL.md and its sessions reference. Use only node "
                             f"{shlex.quote(str(config['skill'] / 'scripts/browser.mjs'))} with target {config['target']}. "
                             "Start one task session and end it in cleanup.")
                else:
                    setup = (f"Read {config['bu_skill']}. Use only {shlex.quote(str(config['bu']))} via Python stdin. "
                             "BU_CDP_WS is configured for the exact remote profile; do not launch local or cloud browsers.")
                prompt = (f"{setup}\nTask: Open a NEW task tab at {url}. Review all three inventory pages. "
                          f"Sum stock for rows whose stock > 0 and price <= 50. Enter reference REVIEW-{repeat}, "
                          "enter the sum, check I reviewed all pages, click Save review once, and verify Review saved. "
                          "Finally report the total and confirmation, then close ONLY your task tab.\n"
                          "Constraints: Use browser UI/DOM reads and ordinary input/click actions. Do not fetch HTTP directly, "
                          "read server files, inspect page script variables/source, use network responses to skip pagination, "
                          "or mutate DOM/application state with JS. You may use JS to read rendered DOM. No other profiles/tabs, "
                          "no external research, no modifying skills, no saved site learnings. Read skill references if needed. "
                          "Execute autonomously. Complete within 180 seconds. No screenshots needed unless text observation fails."
                          + config['extra'])
                command = [config['pi'], '--provider', config['provider'], '--model', config['model'], '--thinking', 'medium',
                           '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates',
                           '--no-session', '--tools', 'read,bash', '--mode', 'json', '-p', prompt]
                start = time.monotonic()
                timed_out = False
                log = output / f'{key}.jsonl'
                with tempfile.TemporaryDirectory(prefix='pi-browser-trial-') as cwd, log.open('w') as stream:
                    env['BH_AGENT_WORKSPACE'] = cwd
                    proc = subprocess.Popen(command, cwd=cwd, env=env, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
                    try:
                        code = proc.wait(timeout=180)
                    except subprocess.TimeoutExpired:
                        timed_out = True
                        stop_owned(proc)
                        code = proc.returncode
                    finally:
                        elapsed = time.monotonic() - start
                        stop_owned(proc)
                        if arm == 'browser-use':
                            subprocess.run([str(config['bu']), '--reload'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
                calls, tools, usage = usage_from(log)
                expected = expected_body(rows, repeat)
                # Public results contain no free-form model text or submitted data.
                # Full transcripts stay in the private, Git-ignored run directory.
                result = dict(arm=arm, repeat=repeat, seconds=round(elapsed, 2), exit_code=code,
                              timed_out=timed_out, expected=expected['total'], submission_count=len(submissions.get(key, [])),
                              passed=not timed_out and code == 0 and correct_submission(submissions.get(key, []), expected),
                              model_calls=calls, tool_calls=tools, usage=usage)
                results.append(result)
                (output / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
                print(json.dumps(result), flush=True)
                if timed_out:
                    raise RuntimeError('Trial timed out; matrix stopped. Inspect the dedicated profile for pending operations and leftover sessions; do not replay writes automatically.')
    finally:
        signal.signal(signal.SIGTERM, previous_term)
        server.shutdown()
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true', help='Explicitly permit paid model calls and remote browser actions')
    args = parser.parse_args()
    config = configuration(os.environ)
    if not args.execute:
        print(json.dumps(dict(status='planned-only', arms=config['arms'], repeats=config['repeats'], provider=config['provider'],
                              model=config['model'], dedicated_profile_acknowledged=True, cdp_configured=True)))
        return
    execute(config)


if __name__ == '__main__':
    main()
