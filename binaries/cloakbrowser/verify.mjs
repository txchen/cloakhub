import assert from 'node:assert/strict';
import { readFile, open, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const version = '156.0.8078.47.1';
const root = new URL(`./${version}/`, import.meta.url);
const manifest = await readFile(new URL('SHA256SUMS', root));
const sig = (await readFile(new URL('SHA256SUMS.sig', root), 'utf8')).trim();
const rawKey = Buffer.from('MKFKwIhUcKWq5xTuNA0Ovg99njcDEcEJvmWYYhApvaU=', 'base64');
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), format: 'der', type: 'spki' });
assert.equal(Buffer.from(sig, 'base64').toString('base64'), sig);
assert.ok(verify(null, manifest, key, Buffer.from(sig, 'base64')), 'Official manifest signature invalid');
assert.equal(manifest.toString().match(/^version=(.+)$/m)?.[1], version);
const checksums = new Map(manifest.toString().split('\n').filter(line => /^[a-f0-9]{64}\s/.test(line)).map(line => { const [hash, name] = line.trim().split(/\s+/); return [name, hash]; }));
async function digest(stream) { const h = createHash('sha256'); for await (const chunk of stream) h.update(chunk); return h.digest('hex'); }
for (const [platform, machine] of [['linux-x64', 62], ['linux-arm64', 183]]) {
  const name = `cloakbrowser-${platform}.tar.gz`;
  const archive = new URL(name, root);
  assert.equal(await digest(createReadStream(archive)), checksums.get(name), `Signed archive checksum: ${platform}`);
  const executable = new URL(`${platform}/chrome`, root);
  const actualHash = await digest(createReadStream(executable));
  // Derive the executable hash from the authenticated archive, not unsigned metadata.
  const tar = spawn('tar', ['-xOzf', fileURLToPath(archive), 'chrome'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const done = new Promise((resolve, reject) => { tar.once('error', reject); tar.once('close', code => code === 0 ? resolve() : reject(Error(`tar failed: ${code}`))); });
  done.catch(() => {});
  const archivedHash = await digest(tar.stdout); await done;
  assert.equal(actualHash, archivedHash, `Extracted chrome differs from signed archive: ${platform}`);
  const handle = await open(executable);
  const header = Buffer.alloc(20);
  try { await handle.read(header, 0, 20, 0); } finally { await handle.close(); }
  assert.equal(header.subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(header[4], 2); assert.equal(header[5], 1);
  assert.equal(header.readUInt16LE(18), machine);
  assert.ok((await stat(executable)).mode & 0o111, 'Executable permission missing');
  console.log(`${platform}: signed archive, extracted chrome SHA-256, ELF64 architecture and executable permission verified`);
}
console.log('Offline integrity verification only; ARM64 execution is not tested on this x64 host.');
