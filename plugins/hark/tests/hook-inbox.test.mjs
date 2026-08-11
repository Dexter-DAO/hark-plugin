import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPreparedAwait } from '../lib/await-preparation.mjs';
import {
  createArmAcknowledgement,
  createAwaitPreparedInboxEvent,
  createWakeAdmission,
  createWakeAdmissionAcknowledgement,
  createWakeDispatchFence,
  createWakeDispatchIntent,
  HarkHookInbox,
} from '../lib/hook-inbox.mjs';

const INPUT = {
  request: 'Continue after job 42.',
  name: 'Job 42',
  source: { kind: 'job.completed', adapter: 'webhook.v1', subject: 'job-42' },
  condition: { status: { equals: 'completed' } },
};
const CLOCK = () => new Date('2026-08-07T12:00:00.000Z');

function prepared(fill = 0x11) {
  return createPreparedAwait(INPUT, (size) => Buffer.alloc(size, fill));
}

function prepareEvent(output = prepared()) {
  return createAwaitPreparedInboxEvent({
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolUseId: 'call-1',
    toolName: 'mcp__hark__hark_await',
    transcriptPath: '/tmp/codex-session-1.jsonl',
    prepared: output,
  }, CLOCK);
}

test('publishes one immutable event atomically across concurrent writers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-hook-inbox-'));
  const inboxes = Array.from({ length: 24 }, () => new HarkHookInbox(directory));
  const event = prepareEvent();
  const results = await Promise.all(inboxes.map((inbox) => inbox.append(event)));

  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results.filter((result) => !result.created).length, 23);
  assert.deepEqual(await inboxes[0].list(), [event]);
  assert.deepEqual(await readdir(inboxes[0].directory), [`${event.id}.json`]);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(inboxes[0].directory)).mode & 0o777, 0o700);
  assert.equal((await stat(inboxes[0].eventPath(event.id))).mode & 0o777, 0o600);
});

test('rejects a changed replay for the same trusted tool-use identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-hook-inbox-'));
  const inbox = new HarkHookInbox(directory);
  await inbox.append(prepareEvent(prepared(0x11)));
  await assert.rejects(
    inbox.append(prepareEvent(prepared(0x22))),
    /hook_inbox_event_conflict/,
  );
});

test('publishes one positive arm acknowledgement and rejects changed API identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-hook-inbox-'));
  const inbox = new HarkHookInbox(directory);
  const event = prepareEvent();
  await inbox.append(event);
  const first = await inbox.acknowledgeArm(event, { awaitId: 'await-1' }, CLOCK);
  const replay = await inbox.acknowledgeArm(event, { awaitId: 'await-1' }, () => (
    new Date('2026-08-07T12:00:01.000Z')
  ));
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal((await inbox.waitForArmAcknowledgement(event, { timeoutMs: 0 })).awaitId, 'await-1');
  await assert.rejects(
    inbox.acknowledgeArm(event, { awaitId: 'await-2' }, CLOCK),
    /hook_arm_ack_conflict/,
  );
  assert.deepEqual(
    createArmAcknowledgement(event, { awaitId: 'await-1' }, CLOCK),
    first.acknowledgement,
  );
  assert.deepEqual(await inbox.list(), []);
  assert.deepEqual(await readdir(inbox.directory), []);
  assert.deepEqual(await readdir(inbox.archiveDirectory), [`${event.id}.json`]);
  assert.equal((await inbox.append(event)).created, false);
  assert.deepEqual(await inbox.list(), []);
  assert.equal((await stat(inbox.ackDirectory)).mode & 0o777, 0o700);
});

test('times out without an immutable positive arm acknowledgement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-hook-inbox-'));
  const inbox = new HarkHookInbox(directory);
  const event = prepareEvent();
  await inbox.append(event);
  await assert.rejects(
    inbox.waitForArmAcknowledgement(event, { timeoutMs: 10, pollIntervalMs: 2 }),
    /hook_arm_ack_timeout/,
  );
});

test('admits one exact wake prompt hook invocation atomically', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-hook-inbox-'));
  const inbox = new HarkHookInbox(directory);
  const input = {
    wakeId: 'wake-1',
    awaitId: 'await-1',
    sessionId: 'session-1',
    transcriptPath: '/tmp/codex-session-1.jsonl',
    promptDigest: 'a'.repeat(64),
    leaseGeneration: 2,
  };
  const admission = createWakeAdmission(input, CLOCK);
  assert.equal((await inbox.publishWakeAdmission(input, CLOCK)).created, true);
  assert.deepEqual(await inbox.listWakeAdmissions(), [admission]);

  const first = await inbox.acknowledgeWakeAdmission(admission, {
    turnId: 'turn-wake-1',
    transcriptPath: input.transcriptPath,
  }, CLOCK);
  assert.equal(first.created, true);
  assert.deepEqual(
    await inbox.waitForWakeAdmissionAcknowledgement(admission, { timeoutMs: 0 }),
    first.acknowledgement,
  );
  assert.deepEqual(createWakeAdmissionAcknowledgement(admission, {
    turnId: 'turn-wake-1',
    transcriptPath: input.transcriptPath,
  }, CLOCK), first.acknowledgement);

  await assert.rejects(inbox.acknowledgeWakeAdmission(admission, {
    turnId: 'turn-wake-replay',
    transcriptPath: input.transcriptPath,
  }, CLOCK), /hook_wake_admission_ack_conflict/);
});

test('wake admission fails closed on transcript substitution and missing acknowledgement', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-hook-inbox-'));
  const inbox = new HarkHookInbox(directory);
  const admission = (await inbox.publishWakeAdmission({
    wakeId: 'wake-1',
    awaitId: 'await-1',
    sessionId: 'session-1',
    transcriptPath: '/tmp/codex-session-1.jsonl',
    promptDigest: 'a'.repeat(64),
    leaseGeneration: 2,
  }, CLOCK)).admission;
  await assert.rejects(inbox.acknowledgeWakeAdmission(admission, {
    turnId: 'turn-wake-1',
    transcriptPath: '/tmp/copied.jsonl',
  }, CLOCK), /hook_wake_admission_transcript_mismatch/);
  await assert.rejects(
    inbox.waitForWakeAdmissionAcknowledgement(admission, { timeoutMs: 5, pollIntervalMs: 1 }),
    /hook_wake_admission_ack_timeout/,
  );
});

test('publishes one global no-clobber dispatch intent across every lease generation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-hook-inbox-fence-'));
  const inbox = new HarkHookInbox(directory);
  const fenceInput = {
    wakeId: 'wake-1',
    awaitId: 'await-1',
    sessionId: 'session-1',
    transcriptPath: '/tmp/codex-session-1.jsonl',
    marker: 'hark:wake:wake-1',
    promptDigest: 'a'.repeat(64),
  };
  const expectedFence = createWakeDispatchFence(fenceInput, CLOCK);
  const firstFence = await inbox.publishWakeDispatchFence(fenceInput, CLOCK);
  assert.equal(firstFence.created, true);
  assert.deepEqual(firstFence.fence, expectedFence);
  assert.equal((await inbox.publishWakeDispatchFence(fenceInput, CLOCK)).created, false);
  await assert.rejects(
    inbox.publishWakeDispatchFence({ ...fenceInput, promptDigest: 'b'.repeat(64) }, CLOCK),
    /hook_wake_dispatch_fence_conflict/,
  );
  await assert.rejects(
    inbox.publishWakeDispatchFence({ ...fenceInput, marker: 'hark:wake:other' }, CLOCK),
    /hook_wake_dispatch_marker_invalid/,
  );

  const firstAdmission = (await inbox.publishWakeAdmission({
    wakeId: 'wake-1', awaitId: 'await-1', sessionId: 'session-1',
    transcriptPath: fenceInput.transcriptPath, promptDigest: fenceInput.promptDigest,
    leaseGeneration: 1,
  }, CLOCK)).admission;
  const expectedIntent = createWakeDispatchIntent(expectedFence, firstAdmission, CLOCK);
  const writers = Array.from({ length: 16 }, () => new HarkHookInbox(directory));
  const intents = await Promise.all(writers.map((writer) => (
    writer.publishWakeDispatchIntent(expectedFence, firstAdmission, CLOCK)
  )));
  assert.equal(intents.filter((result) => result.created).length, 1);
  assert.deepEqual(await inbox.readWakeDispatchIntent(expectedFence), expectedIntent);

  const laterAdmission = (await inbox.publishWakeAdmission({
    wakeId: 'wake-1', awaitId: 'await-1', sessionId: 'session-1',
    transcriptPath: fenceInput.transcriptPath, promptDigest: fenceInput.promptDigest,
    leaseGeneration: 3,
  }, CLOCK)).admission;
  await assert.rejects(
    inbox.publishWakeDispatchIntent(expectedFence, laterAdmission, CLOCK),
    /hook_wake_dispatch_intent_conflict/,
  );
  assert.deepEqual(await inbox.readWakeDispatchFence('wake-1'), expectedFence);
  assert.equal((await stat(inbox.wakeDispatchFenceDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(inbox.wakeDispatchIntentDirectory)).mode & 0o777, 0o700);
});

test('malformed pending hook work is quarantined once without blocking new work', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-hook-inbox-corrupt-'));
  const inbox = new HarkHookInbox(directory);
  await inbox.ensureDirectory();
  const corrupt = prepareEvent();
  await writeFile(inbox.eventPath(corrupt.id), '{not-json\n', { mode: 0o600 });
  assert.deepEqual(await inbox.list(), []);
  const quarantined = await readdir(inbox.quarantineDirectory);
  assert.equal(quarantined.length, 1);
  assert.deepEqual(await inbox.list(), []);
  assert.deepEqual(await readdir(inbox.quarantineDirectory), quarantined);

  const fresh = createAwaitPreparedInboxEvent({
    sessionId: 'session-2',
    turnId: 'turn-2',
    toolUseId: 'call-2',
    toolName: 'mcp__hark__hark_await',
    transcriptPath: '/tmp/codex-session-2.jsonl',
    prepared: prepared(0x22),
  }, CLOCK);
  await inbox.append(fresh);
  assert.deepEqual(await inbox.list(), [fresh]);
});
