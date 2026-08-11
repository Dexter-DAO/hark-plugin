import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { defaultHarkDataDir, HarkJournal } from '../lib/journal.mjs';

test('uses one stable data root instead of plugin-isolated storage', () => {
  const previousHarkData = process.env.HARK_DATA_DIR;
  const previousPluginData = process.env.PLUGIN_DATA;
  try {
    process.env.HARK_DATA_DIR = '/tmp/hark-explicit-data';
    process.env.PLUGIN_DATA = '/tmp/hark-plugin-isolated-data';
    assert.equal(defaultHarkDataDir(), '/tmp/hark-explicit-data');
    delete process.env.HARK_DATA_DIR;
    assert.equal(defaultHarkDataDir(), path.join(os.homedir(), '.hark'));
    process.env.HARK_DATA_DIR = 'relative/hark-data';
    assert.throws(() => defaultHarkDataDir(), /hark_data_dir_must_be_absolute/);
  } finally {
    if (previousHarkData === undefined) delete process.env.HARK_DATA_DIR;
    else process.env.HARK_DATA_DIR = previousHarkData;
    if (previousPluginData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = previousPluginData;
  }
});

test('persists a private runtime identity and monotonic revisions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-journal-'));
  const journal = new HarkJournal(directory);
  const first = await journal.ensureRuntimeId(() => 'runtime-one');
  const second = await new HarkJournal(directory).ensureRuntimeId(() => 'runtime-two');
  const floor = await journal.ensureHistoryFloor(1234);
  const sameFloor = await new HarkJournal(directory).ensureHistoryFloor(9999);
  assert.equal(first, 'runtime-one');
  assert.equal(second, 'runtime-one');
  assert.equal(floor, 1234);
  assert.equal(sameFloor, 1234);
  const stored = await journal.read();
  assert.equal(stored.revision, 2);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(directory, 'codex-journal.json'))).mode & 0o777, 0o600);
});

test('records one preparation and rejects changed replay', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-journal-'));
  const journal = new HarkJournal(directory);
  const prepared = { preparationNonce: 'nonce-1', qualificationDigest: 'a'.repeat(64) };
  const binding = { threadId: 'thread-1', turnId: 'turn-1' };
  await journal.recordPreparation(prepared, binding);
  await journal.recordPreparation(prepared, binding);
  await assert.rejects(
    journal.recordPreparation({ ...prepared, qualificationDigest: 'b'.repeat(64) }, binding),
    /preparation_replay_conflict/,
  );
  await assert.rejects(
    journal.recordPreparation(prepared, { ...binding, threadId: 'thread-2' }),
    /preparation_binding_conflict/,
  );
  await journal.transitionPreparation('nonce-1', ['observed'], { state: 'armed', awaitId: 'await-1' });
  const stored = await journal.read();
  assert.equal(stored.preparations['nonce-1'].binding.threadId, 'thread-1');
  assert.equal(stored.preparations['nonce-1'].state, 'armed');
});

test('persists authoritative turn completion before suspension commit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-journal-'));
  const journal = new HarkJournal(directory);
  const event = {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'completed', items: [], error: null },
  };
  await journal.recordTurnCompletion(event);
  await journal.recordTurnCompletion(event);
  await assert.rejects(
    journal.recordTurnCompletion({ ...event, threadId: 'thread-2' }),
    /turn_completion_replay_conflict/,
  );
  const stored = (await journal.read()).turnCompletions['turn-1'].event;
  assert.equal(stored.threadId, 'thread-1');
  assert.equal(Object.hasOwn(stored.turn, 'items'), false);
});

test('fences await transitions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-journal-'));
  const journal = new HarkJournal(directory);
  await journal.recordAwait({ id: 'await-1', state: 'armed', checkpointDigest: 'a'.repeat(64) });
  await journal.transitionAwait('await-1', ['armed'], { state: 'suspended' });
  await assert.rejects(
    journal.transitionAwait('await-1', ['armed'], { state: 'cancelled' }),
    /await_state_conflict:suspended/,
  );
});

test('fences wake transitions and survives a new journal instance', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-journal-'));
  const journal = new HarkJournal(directory);
  await journal.transitionWake('wake-1', ['new'], { state: 'claimed', threadId: 'thread-1' });
  await assert.rejects(
    journal.transitionWake('wake-1', ['new'], { state: 'claimed' }),
    /wake_state_conflict:claimed/,
  );
  await new HarkJournal(directory).transitionWake(
    'wake-1',
    ['claimed'],
    { state: 'dispatching', clientUserMessageId: 'wake-1' },
  );
  assert.equal((await journal.read()).wakes['wake-1'].state, 'dispatching');
});

test('journals certification-invalidating inference before remote delivery', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-journal-'));
  const journal = new HarkJournal(directory);
  const receipt = {
    v: 'hark.runtime-receipt.v2',
    sourceReceiptId: 'hrr_model_call_turn-2',
    kind: 'model_call',
  };
  await journal.recordViolation('await-1', receipt);
  await journal.recordViolation('await-1', receipt);
  await journal.markViolationPosted(receipt.sourceReceiptId);
  const stored = await journal.read();
  assert.equal(stored.violations[receipt.sourceReceiptId].state, 'posted');
});
