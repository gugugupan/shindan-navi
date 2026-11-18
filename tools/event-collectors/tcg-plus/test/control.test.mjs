import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareControl, sendControl, startControl } from '../control.mjs';

test('control channel rejects absent server, serializes commands and preserves pre-created files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcg-control-'));
  let stop;
  try {
    await prepareControl(dir);
    const inode = (await fs.stat(path.join(dir, 'response.json'))).ino;
    await assert.rejects(sendControl('status', {}, { dir }), /No live control server/);
    let calls = 0;
    stop = await startControl(async (command, args) => {
      calls++;
      if (command !== 'status') throw new Error('Unsupported action');
      return { count: calls, value: args.value };
    }, dir);
    const first = sendControl('status', { value: 3 }, { dir });
    await new Promise(resolve => setTimeout(resolve, 100));
    await assert.rejects(sendControl('status', {}, { dir }), /Another control command/);
    assert.deepEqual(await first, { count: 1, value: 3 });
    await assert.rejects(sendControl('apply', {}, { dir }), /Unsupported action/);
    assert.equal(calls, 2);
    assert.equal((await fs.stat(path.join(dir, 'response.json'))).ino, inode);
    await stop();
    await assert.rejects(sendControl('status', {}, { dir }), /No live control server/);
  } finally { await stop?.(); await fs.rm(dir, { recursive: true, force: true }); }
});
