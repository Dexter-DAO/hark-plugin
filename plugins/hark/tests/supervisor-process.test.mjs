import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SupervisorProcessLock } from '../lib/supervisor-process.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  if (!Number.isSafeInteger(port)) throw new Error('test_free_port_invalid');
  return port;
}

test('acquires and releases one private supervisor process lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-process-'));
  const port = await freePort();
  const lock = new SupervisorProcessLock(directory, { port });
  await lock.acquire();
  assert.equal((await lock.inspect()).pid, process.pid);
  assert.equal(await lock.inspectReady(), null);
  const ready = await lock.markReady({ runtimeId: 'runtime-1' });
  assert.equal(ready.runtimeId, 'runtime-1');
  assert.equal((await new SupervisorProcessLock(directory, { port }).inspectReady()).runtimeId, 'runtime-1');
  await assert.rejects(new SupervisorProcessLock(directory, { port }).acquire(), /already_running/);
  await lock.release();
  assert.equal(await lock.inspect(), null);
  assert.equal(await lock.inspectReady(), null);
});

test('replaces a stale process record', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-process-'));
  const lock = new SupervisorProcessLock(directory, { port: await freePort() });
  await writeFile(lock.filePath, `${JSON.stringify({ pid: 999_999_999 })}\n`, { mode: 0o600 });
  await lock.acquire();
  assert.equal((await lock.inspect()).pid, process.pid);
  await lock.release();
});

test('cannot publish readiness after process ownership is released mid-write', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-process-'));
  let beginWrite;
  let finishWrite;
  const writeStarted = new Promise((resolve) => { beginWrite = resolve; });
  const writeAllowed = new Promise((resolve) => { finishWrite = resolve; });
  const lock = new SupervisorProcessLock(directory, {
    port: await freePort(),
    async writeReadyJson(filePath, value) {
      beginWrite();
      await writeAllowed;
      await writeFile(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    },
  });
  await lock.acquire();
  const marking = lock.markReady({ runtimeId: 'runtime-1' });
  await writeStarted;
  await lock.release();
  finishWrite();
  await assert.rejects(marking, /lock_lost_before_ready/);
  assert.equal(await new SupervisorProcessLock(directory, { port: lock.port }).inspectReady(), null);
  await assert.rejects(readFile(lock.readyPath, 'utf8'), { code: 'ENOENT' });
});
