import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertArmApiResponse,
  assertCommitApiResponse,
} from '../lib/api-response-contracts.mjs';
import { sha256Canonical } from '../lib/canonical.mjs';
import {
  armApiResponse,
  commitApiResponse,
} from './api-response-fixtures.mjs';

const PUBLIC_INPUT = {
  request: 'Continue after release 42 is healthy.',
  name: 'Release 42',
  source: { kind: 'release.healthy', adapter: 'release.v1', subject: 'release-42' },
  condition: { status: { equals: 'healthy' } },
};
const QUALIFICATION_DIGEST = sha256Canonical({
  source: PUBLIC_INPUT.source,
  condition: PUBLIC_INPUT.condition,
});
const ARM_REQUEST = {
  v: 'hark.await.v2',
  preparationNonce: `hkp_${'p'.repeat(32)}`,
  origin: {
    protocol: 'codex',
    runtimeId: 'runtime-1',
    taskId: 'turn-1',
    conversationId: 'session-1',
  },
  checkpoint: { version: 'hark.codex-checkpoint.v1', digest: 'c'.repeat(64) },
  binding: {
    continuationMode: 'held_tool',
    toolName: 'mcp__hark__hark_await',
    toolUseId: 'call-1',
    inputDigest: sha256Canonical(PUBLIC_INPUT),
  },
  prepared: {
    v: 'hark.await-prepared.v1',
    preparationNonce: `hkp_${'p'.repeat(32)}`,
    qualificationDigest: QUALIFICATION_DIGEST,
    wakePolicy: 'resume',
    ...PUBLIC_INPUT,
  },
  predicate: {
    kind: 'exact_signal',
    type: PUBLIC_INPUT.source.kind,
    subject: PUBLIC_INPUT.source.subject,
    qualificationDigest: QUALIFICATION_DIGEST,
  },
  wakePolicy: 'resume',
};
const COMMIT_REQUEST = {
  v: 'hark.suspension-commit.v2',
  commitNonce: `hkc_${'q'.repeat(32)}`,
  checkpointDigest: ARM_REQUEST.checkpoint.digest,
};

test('accepts only the full bound arm and suspension-commit API contracts', () => {
  const checkedArm = assertArmApiResponse(
    armApiResponse(ARM_REQUEST),
    ARM_REQUEST,
    { expectedReplay: false },
  );
  assert.equal(checkedArm.awaitId, 'await-1');
  assert.equal(checkedArm.waiter.leaseToken, 'private-lease-token');

  const checkedCommit = assertCommitApiResponse(
    commitApiResponse({ armRequest: ARM_REQUEST, commitRequest: COMMIT_REQUEST }),
    { awaitId: 'await-1', armRequest: ARM_REQUEST, commitRequest: COMMIT_REQUEST },
    { expectedReplay: false },
  );
  assert.equal(checkedCommit.suspensionReceiptId, 'suspension-receipt-1');
  assert.equal(
    checkedCommit.suspensionReceiptDigest,
    sha256Canonical(checkedCommit.receipt),
  );
});

test('accepts a strict replayed arm after lifecycle progress', () => {
  const replay = armApiResponse(ARM_REQUEST, {
    replay: true,
    state: 'completed',
    releasedAt: '2026-08-07T12:00:05.000Z',
  });
  assert.equal(
    assertArmApiResponse(replay, ARM_REQUEST, { expectedReplay: true }).armed.state,
    'completed',
  );
});

test('accepts armedAt before or equal to createdAt and rejects armedAt after createdAt', async (context) => {
  await context.test('armedAt before createdAt', () => {
    const value = armApiResponse(ARM_REQUEST);
    value.await.createdAt = '2026-08-07T12:00:00.005Z';
    value.await.updatedAt = '2026-08-07T12:00:00.005Z';
    assert.equal(
      assertArmApiResponse(value, ARM_REQUEST, { expectedReplay: false }).armed.armedAt,
      '2026-08-07T12:00:00.000Z',
    );
  });

  await context.test('armedAt equal to createdAt', () => {
    const value = armApiResponse(ARM_REQUEST);
    assert.equal(
      assertArmApiResponse(value, ARM_REQUEST, { expectedReplay: false }).armed.armedAt,
      value.await.createdAt,
    );
  });

  await context.test('armedAt after createdAt', () => {
    const value = armApiResponse(ARM_REQUEST);
    value.await.createdAt = '2026-08-07T12:00:00.005Z';
    value.await.armedAt = '2026-08-07T12:00:00.006Z';
    value.await.updatedAt = '2026-08-07T12:00:00.006Z';
    assert.throws(
      () => assertArmApiResponse(value, ARM_REQUEST, { expectedReplay: false }),
      /armed_await_armed_at_order_invalid/,
    );
  });
});

test('continues to reject updatedAt before createdAt', () => {
  const value = armApiResponse(ARM_REQUEST);
  value.await.createdAt = '2026-08-07T12:00:00.005Z';
  value.await.updatedAt = '2026-08-07T12:00:00.004Z';
  assert.throws(
    () => assertArmApiResponse(value, ARM_REQUEST, { expectedReplay: false }),
    /armed_await_updated_at_order_invalid/,
  );
});

test('rejects arm responses with any incomplete, unbound, or malformed field', async (context) => {
  const cases = [
    ['extra top-level field', (value) => { value.extra = true; }, /arm_result_field_unsupported:extra/],
    ['missing lifecycle field', (value) => { delete value.await.failedAt; }, /armed_await_field_required:failedAt/],
    ['origin mismatch', (value) => { value.await.origin.taskId = 'other'; }, /armed_await_origin_mismatch/],
    ['checkpoint mismatch', (value) => { value.await.checkpoint.digest = 'd'.repeat(64); }, /armed_await_checkpoint_mismatch/],
    ['binding mismatch', (value) => { value.await.binding.toolUseId = 'other'; }, /armed_await_binding_mismatch/],
    ['public waiter mismatch', (value) => { value.await.waiter.waiterId = 'other'; }, /waiter_public_binding_mismatch/],
    ['noncanonical timestamp', (value) => { value.await.armedAt = '2026-08-07T12:00:00Z'; }, /armed_await_armed_at_invalid/],
    ['nonboolean replay', (value) => { value.replay = 'false'; }, /arm_result_replay_invalid/],
    ['advanced initial lifecycle', (value) => { value.await.suspendedAt = '2026-08-07T12:00:01.000Z'; }, /armed_await_initial_lifecycle_invalid/],
  ];
  for (const [name, mutate, expected] of cases) {
    await context.test(name, () => {
      const value = armApiResponse(ARM_REQUEST);
      mutate(value);
      assert.throws(
        () => assertArmApiResponse(value, ARM_REQUEST, { expectedReplay: false }),
        expected,
      );
    });
  }
});

test('rejects commit responses with any unbound receipt, state, timestamp, or boolean', async (context) => {
  const cases = [
    ['legacy wake field', (value) => { value.wake = null; }, /commit_result_field_unsupported:wake/],
    ['receipt origin mismatch', (value) => { value.suspensionReceipt.origin.taskId = 'other'; }, /suspension_receipt_origin_mismatch/],
    ['receipt checkpoint mismatch', (value) => { value.suspensionReceipt.checkpointDigest = 'd'.repeat(64); }, /suspension_receipt_checkpoint_mismatch/],
    ['receipt timestamp mismatch', (value) => { value.suspensionReceipt.observedAt = '2026-08-07T12:00:02.000Z'; }, /suspension_receipt_timestamp_mismatch/],
    ['nonboolean already-woken', (value) => { value.alreadyWoken = 0; }, /suspension_receipt_already_woken_invalid/],
    ['nonboolean replay', (value) => { value.replay = 0; }, /suspension_receipt_replay_invalid/],
    ['normal state mismatch', (value) => { value.state = 'wake_pending'; }, /suspension_receipt_state_mismatch/],
  ];
  for (const [name, mutate, expected] of cases) {
    await context.test(name, () => {
      const value = commitApiResponse({
        armRequest: ARM_REQUEST,
        commitRequest: COMMIT_REQUEST,
      });
      mutate(value);
      assert.throws(
        () => assertCommitApiResponse(
          value,
          { awaitId: 'await-1', armRequest: ARM_REQUEST, commitRequest: COMMIT_REQUEST },
          { expectedReplay: false },
        ),
        expected,
      );
    });
  }
});
