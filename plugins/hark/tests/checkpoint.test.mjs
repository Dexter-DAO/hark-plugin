import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexCheckpoint, CODEX_CHECKPOINT_VERSION } from '../lib/checkpoint.mjs';

const input = {
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  preparationNonce: 'hkp_nonce-1',
  qualificationDigest: 'a'.repeat(64),
};

test('builds a deterministic exact App Server item checkpoint', () => {
  const first = createCodexCheckpoint(input);
  const second = createCodexCheckpoint({ ...input });
  assert.equal(first.version, CODEX_CHECKPOINT_VERSION);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.descriptor, {
    v: CODEX_CHECKPOINT_VERSION,
    protocol: 'codex-app-server-v2',
    conversationId: 'thread-1',
    taskId: 'turn-1',
    itemId: 'item-1',
    preparationNonce: 'hkp_nonce-1',
    qualificationDigest: 'a'.repeat(64),
  });
});

test('changes the digest for every trusted binding dimension', () => {
  const baseline = createCodexCheckpoint(input).digest;
  for (const [key, value] of [
    ['threadId', 'thread-2'],
    ['turnId', 'turn-2'],
    ['itemId', 'item-2'],
    ['preparationNonce', 'hkp_nonce-2'],
    ['qualificationDigest', 'b'.repeat(64)],
  ]) {
    assert.notEqual(createCodexCheckpoint({ ...input, [key]: value }).digest, baseline, key);
  }
});

test('rejects incomplete or malformed checkpoint material', () => {
  assert.throws(() => createCodexCheckpoint({ ...input, threadId: '' }), /thread_id_required/);
  assert.throws(
    () => createCodexCheckpoint({ ...input, qualificationDigest: 'not-a-digest' }),
    /qualification_digest_invalid/,
  );
});
