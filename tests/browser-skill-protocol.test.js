import { test, expect } from 'bun:test';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../skills/cloakhub-browser/scripts/session.mjs';

test('response decoder preserves UTF-8 characters split across socket chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cloakhub-protocol-'));
  const path = join(directory, 's.sock');
  const payload = Buffer.from(JSON.stringify({ok:true, output:'库存中文 📦'}) + '\n');
  const split = payload.indexOf(Buffer.from('中')) + 1;
  const server = net.createServer(socket => {
    socket.once('data', () => {
      socket.write(payload.subarray(0, split));
      setTimeout(() => socket.end(payload.subarray(split)), 20);
    });
  });
  try {
    await new Promise(resolve => server.listen(path, resolve));
    expect(await request(path, {command:'status'})).toEqual({ok:true, output:'库存中文 📦'});
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive:true, force:true});
  }
});
