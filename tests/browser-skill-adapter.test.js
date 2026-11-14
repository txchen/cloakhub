import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
const integration = process.env.CLOAKHUB_TEST_BROWSER ? test : test.skip;
integration('v2 adapter boundaries against real Chromium (Node Playwright driver)', async () => {
  const child = spawn('node', ['--test', 'scripts/agent-skill-evaluation/test-adapter-browser.mjs'], { env: process.env });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 55000);
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  try {
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    if (code !== 0) console.error(output);
    expect(code).toBe(0);
  } finally { clearTimeout(timeout); child.kill('SIGKILL'); }
}, 60000);
