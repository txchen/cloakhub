import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export const sleep = (ms, signal) => delay(ms, undefined, { signal });
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function redactor(secrets = []) {
  return value => {
    let text = String(value);
    for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, '[REDACTED]');
    return text.replace(/(?:https?|wss?):\/\/[^\s]+/g, '[URL]').replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ADDRESS]').slice(0, 4000);
  };
}
export function cpuUsage() {
  try { return Number(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8').match(/^usage_usec (\d+)$/m)[1]); }
  catch { return null; }
}
export function cpuDelta(start, end) { return start === null || end === null ? null : end - start; }
export function withSignal(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason ?? Error('Aborted')); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Error('Aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export function browserEnv(home, { key, display, fontconfig } = {}) {
  const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: home, XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`, XDG_DATA_HOME: `${home}/.local/share` };
  if (display) env.DISPLAY = display;
  if (fontconfig) env.FONTCONFIG_FILE = fontconfig;
  if (key) env.CLOAKBROWSER_LICENSE_KEY = key;
  return env;
}
export function ownedGroupAlive(child) {
  if (!child?.pid) return false;
  try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
export async function stopOwned(child, graceMs = 5000) {
  // A crashed main process can leave live children in its detached process group.
  if (!ownedGroupAlive(child)) return false;
  const killGroup = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const waitExit = ms => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(); };
    const timer = setTimeout(done, ms); child.once('exit', done);
  });
  killGroup('SIGTERM');
  await waitExit(graceMs);
  killGroup('SIGKILL'); // terminate surviving descendants even if their main process exited; init reaps them
  await waitExit(2000);
  if (child.exitCode === null && child.signalCode === null) throw Error('Owned process did not exit after SIGKILL');
  return true;
}
