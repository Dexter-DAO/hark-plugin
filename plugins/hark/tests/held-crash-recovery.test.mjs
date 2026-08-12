import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Canonical } from '../lib/canonical.mjs';
import { HarkHeldCrashRecovery } from '../lib/held-crash-recovery.mjs';
import { createPrivateClaimBinding } from '../lib/private-claim-store.mjs';
import {
  createArmBinding,
  createAwaitRequest,
  createSuspensionCommitted,
  createToolResultObservationIntent,
  createToolResultReturned,
  createToolWaitResult,
  createTranscriptBoundary,
  createWaiterReady,
  createWakeDelivery,
} from '../lib/tool-wait-protocol.mjs';

const CLOCK = () => new Date('2026-08-07T12:00:00.000Z');
const WAKE_DIGEST = '3'.repeat(64);
const INPUT = {
  request: 'Continue after job 42.',
  name: 'Job 42',
  source: { kind: 'job.completed', adapter: 'webhook.v1', subject: 'job-42' },
  condition: { status: { equals: 'completed' } },
};

function records() {
  const request = createAwaitRequest({
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolUseId: 'call-1',
    toolName: 'mcp__hark__hark_await',
    transcriptPath: '/private/codex/session-1.jsonl',
    originalInput: INPUT,
  }, CLOCK);
  const armBinding = createArmBinding(request, {
    awaitId: 'await-1',
    preparationNonce: `hkp_${'p'.repeat(32)}`,
    checkpointDigest: 'c'.repeat(64),
  }, CLOCK, (size) => Buffer.alloc(size, 0x11));
  const boundary = {
    v: 'hark.codex-tool-wait-boundary.v1',
    historySource: 'codex.rollout-jsonl.v1',
    transcriptPath: '/private/codex/session-1.jsonl',
    conversationId: 'session-1',
    originTaskId: 'turn-1',
    toolUseId: 'call-1',
    toolName: 'mcp__hark__hark_await',
    toolCallDigest: '1'.repeat(64),
    inputDigest: sha256Canonical(INPUT),
    cliVersion: '0.147.0',
    dev: '1',
    ino: '2',
    byteLength: 123,
    prefixSha256: '2'.repeat(64),
  };
  const persistedBoundary = createTranscriptBoundary(
    request,
    armBinding,
    boundary,
    CLOCK,
  );
  const ready = createWaiterReady(request, armBinding, INPUT, CLOCK);
  const committed = createSuspensionCommitted(request, armBinding, ready, {
    suspensionReceiptId: 'hrr_monitoring_task_suspended_await-1',
    suspensionReceiptDigest: 'd'.repeat(64),
  }, CLOCK);
  const wake = {
    v: 'hark.wake.v2',
    wakeId: '47c4c69a-316a-4d4b-9dfb-f43aab92dfde',
    idempotencyKey: '47c4c69a-316a-4d4b-9dfb-f43aab92dfde',
    awaitId: 'await-1',
    origin: {
      protocol: 'codex', runtimeId: 'runtime-1',
      taskId: 'turn-1', conversationId: 'session-1',
    },
    checkpoint: { version: 'hark.codex-checkpoint.v1', digest: 'c'.repeat(64) },
    prepared: {
      v: 'hark.await-prepared.v1',
      preparationNonce: armBinding.preparationNonce,
      qualificationDigest: sha256Canonical({
        source: INPUT.source,
        condition: INPUT.condition,
      }),
      wakePolicy: 'resume',
      ...INPUT,
    },
    signal: {
      id: 'signal-1', sourceSignalId: 'provider-1', type: 'job.completed',
      subject: 'job-42', qualificationDigest: 'a'.repeat(64),
      sourceAdapter: 'webhook.v1', authMode: 'source_hmac',
      observedAt: '2026-08-07T12:00:03.000Z', summary: 'Job completed.',
      data: { status: 'completed' }, evidence: [],
    },
    createdAt: '2026-08-07T12:00:03.000Z',
  };
  const delivery = createWakeDelivery(
    request,
    armBinding,
    committed,
    wake,
    WAKE_DIGEST,
    CLOCK,
  );
  const result = createToolWaitResult(delivery);
  const returned = createToolResultReturned(delivery, result, {
    wakeDeliveryDigest: WAKE_DIGEST,
    transcriptBoundary: boundary,
  }, CLOCK);
  const binding = createPrivateClaimBinding({
    eventId: delivery.eventId,
    deliveryId: delivery.deliveryId,
    awaitId: delivery.awaitId,
    wakeId: delivery.wakeId,
    toolUseId: delivery.toolUseId,
    checkpointDigest: delivery.checkpointDigest,
    wakeDeliveryDigest: delivery.wakeDeliveryDigest,
    toolResultDigest: sha256Canonical(result),
  });
  const observationIntent = createToolResultObservationIntent({
    delivery,
    result,
    transcriptBoundary: boundary,
    runtimeId: 'runtime-1',
    claimReference: {
      v: 'hark.codex-held-claim-ref.v1',
      locator: `hhc_${'A'.repeat(43)}`,
      bindingDigest: sha256Canonical(binding),
      wakeDeliveryDigest: binding.wakeDeliveryDigest,
      toolResultDigest: binding.toolResultDigest,
    },
  }, CLOCK);
  const proof = {
    v: 'hark.codex-tool-wait-proof.v1',
    historySource: 'codex.rollout-jsonl.v1',
    conversationId: 'session-1', originTaskId: 'turn-1', wakeTaskId: 'turn-1',
    toolName: request.toolName, toolUseId: request.toolUseId,
    inputDigest: request.originalInputDigest, toolCallDigest: boundary.toolCallDigest,
    toolResultDigest: returned.resultDigest, wakeDeliveryDigest: WAKE_DIGEST,
    rolloutToolOutputDigest: '4'.repeat(64), assistantResponseDigest: '5'.repeat(64),
    waitingInferenceRecordCount: 0, interveningTaskIds: [],
    rollbackMarkerCount: 0, historyMutationCount: 0,
    scannedAt: '2026-08-07T12:00:05.000Z', historyDigest: '6'.repeat(64),
  };
  return {
    request, armBinding, persistedBoundary, delivery, result, returned, proof, wake,
    observationIntent,
  };
}

function harness({
  returned = true,
  delivery = true,
  observationIntent = true,
  proofError = null,
  inspectionState = 'waiting',
} = {}) {
  const value = records();
  let completionPosted = null;
  let recoveredReturned = returned ? value.returned : null;
  const receipts = [];
  const protocol = {
    async listAwaitRequests() { return [value.request]; },
    async readArmBinding() { return value.armBinding; },
    async readTranscriptBoundary() { return value.persistedBoundary; },
    async readWakeDelivery() { return delivery ? value.delivery : null; },
    async readToolResultObservationIntent() {
      return observationIntent ? value.observationIntent : null;
    },
    async readToolResultReturned() { return recoveredReturned; },
    async publishToolResultReturned() {
      recoveredReturned = value.returned;
      return { created: true, toolResultReturned: recoveredReturned };
    },
    async readCompletionPosted() { return completionPosted; },
    async publishCompletionPosted(_returned, input) {
      completionPosted = input;
      return { created: true, completionPosted };
    },
  };
  const service = {
    async recordRuntimeReceipt(awaitId, receipt) {
      receipts.push({ awaitId, receipt: structuredClone(receipt) });
      return { v: 'hark.runtime-receipt-result.v2', replay: false };
    },
    async certifyAwait(awaitId) {
      return {
        v: 'hark.await-certification.v2', awaitId, certified: true, reasons: [],
        continuation: { mode: 'held_tool', proof: value.proof },
      };
    },
  };
  const recovery = new HarkHeldCrashRecovery({
    protocol,
    serviceClient: service,
    runtimeId: 'runtime-1',
    proveToolWait: async () => {
      if (proofError) throw new Error(proofError);
      return value.proof;
    },
    inspectToolWait: async () => ({
      v: 'hark.codex-tool-wait-inspection.v1',
      state: inspectionState,
    }),
  });
  return {
    ...value,
    recovery,
    receipts,
    get recoveredReturned() { return recoveredReturned; },
    get completionPosted() { return completionPosted; },
  };
}

function recoveryClaim(overrides = {}) {
  return {
    leaseToken: '99999999-9999-4999-8999-999999999999',
    leaseGeneration: 2,
    disposition: 'recover_held_tool',
    priorWakeDeliveryDigest: WAKE_DIGEST,
    ...overrides,
  };
}

test('adopts an exact persisted same-turn result and leaves final certification to the certifier', async () => {
  const value = harness();
  const resolution = await value.recovery.recoverHeldTool({
    wake: value.wake,
    claim: recoveryClaim(),
  });
  assert.equal(resolution.action, 'adopted');
  assert.deepEqual(value.receipts.map(({ receipt }) => receipt.kind), ['tool_result_observed']);
  assert.equal(value.receipts[0].receipt.toolResultObservation.observationMode, 'recovery_adoption');
  assert.equal(value.receipts[0].receipt.leaseGeneration, 2);
  assert.equal(value.completionPosted, null);
});

test('reconstructs the immutable local marker only after the exact transcript proof succeeds', async () => {
  const value = harness({ returned: false });
  const resolution = await value.recovery.recoverHeldTool({
    wake: value.wake,
    claim: recoveryClaim(),
  });
  assert.equal(resolution.action, 'adopted');
  assert.deepEqual(value.recoveredReturned, value.returned);
  assert.equal(value.receipts.length, 1);
});

test('stays pending on ambiguous proof and exposes a hard abort only to the supervisor fallback', async () => {
  const pending = harness({
    proofError: 'codex_tool_wait_turn_incomplete',
    inspectionState: 'waiting',
  });
  const pendingResult = await pending.recovery.recoverHeldTool({
    wake: pending.wake,
    claim: recoveryClaim(),
  });
  assert.equal(pendingResult.action, 'pending');
  assert.equal(pending.receipts.length, 0);

  const aborted = harness({
    proofError: 'codex_tool_wait_turn_incomplete',
    inspectionState: 'origin_aborted_before_result',
  });
  const abortedResult = await aborted.recovery.recoverHeldTool({
    wake: aborted.wake,
    claim: recoveryClaim(),
  });
  assert.equal(abortedResult.action, 'fallback');
  assert.equal(aborted.receipts.length, 0);
});

test('recovery without a durable claim intent falls back only after an exact abort', async () => {
  const value = harness({
    observationIntent: false,
    proofError: 'codex_tool_output_missing',
    inspectionState: 'origin_aborted_before_result',
  });
  let proofCalls = 0;
  let inspectionCalls = 0;
  value.recovery.proveToolWait = async () => {
    proofCalls += 1;
    throw new Error('codex_tool_output_missing');
  };
  value.recovery.inspectToolWait = async () => {
    inspectionCalls += 1;
    return { v: 'hark.codex-tool-wait-inspection.v1', state: 'origin_aborted_before_result' };
  };
  const resolution = await value.recovery.recoverHeldTool({
    wake: value.wake,
    claim: recoveryClaim(),
  });
  assert.equal(resolution.action, 'fallback');
  assert.equal(resolution.inspection.state, 'origin_aborted_before_result');
  assert.equal(proofCalls, 1);
  assert.equal(inspectionCalls, 1);
  assert.equal(value.receipts.length, 0);
  assert.deepEqual(value.recoveredReturned, value.returned);
  assert.equal(value.completionPosted, null);

  const waiting = harness({
    observationIntent: false,
    proofError: 'codex_tool_output_missing',
    inspectionState: 'waiting',
  });
  const pending = await waiting.recovery.recoverHeldTool({
    wake: waiting.wake,
    claim: recoveryClaim(),
  });
  assert.equal(pending.action, 'pending');
  assert.equal(pending.reason, 'waiting');
  assert.equal(waiting.receipts.length, 0);
});

test('fails closed when the server recovery digest differs from the persisted delivery', async () => {
  const value = harness();
  await assert.rejects(
    value.recovery.recoverHeldTool({
      wake: value.wake,
      claim: recoveryClaim({ priorWakeDeliveryDigest: '9'.repeat(64) }),
    }),
    /held_recovery_delivery_digest_mismatch/,
  );
  assert.equal(value.receipts.length, 0);
});

test('recover_waiter distinguishes a lost waiter from an exact requeued held result', async () => {
  const lost = harness({ delivery: false });
  const lostResolution = await lost.recovery.recoverWaiter({ wake: lost.wake });
  assert.equal(lostResolution.action, 'probe_origin');
  assert.equal(lostResolution.reason, 'held_waiter_lost');

  const beforeResult = harness({ inspectionState: 'origin_aborted_before_result' });
  const beforeResultResolution = await beforeResult.recovery.recoverWaiter({
    wake: beforeResult.wake,
  });
  assert.equal(beforeResultResolution.action, 'fallback');

  const afterResult = harness({ inspectionState: 'tool_result_then_aborted' });
  const afterResultResolution = await afterResult.recovery.recoverWaiter({
    wake: afterResult.wake,
  });
  assert.equal(afterResultResolution.action, 'fallback');
});

test('recover_waiter falls back after abort in the delivery-before-intent crash window', async () => {
  const value = harness({
    observationIntent: false,
    inspectionState: 'origin_aborted_before_result',
  });
  const resolution = await value.recovery.recoverWaiter({ wake: value.wake });
  assert.equal(resolution.action, 'fallback');
  assert.equal(resolution.inspection.state, 'origin_aborted_before_result');
  assert.equal(value.receipts.length, 0);
  assert.deepEqual(value.recoveredReturned, value.returned);
  assert.equal(value.completionPosted, null);
});

test('recover_waiter keeps an exact local result silent while its origin is ambiguous', async () => {
  for (const inspectionState of [
    'waiting',
    'ambiguous_incomplete_tail',
    'tool_result_persisted',
  ]) {
    const value = harness({ inspectionState });
    const resolution = await value.recovery.recoverWaiter({ wake: value.wake });
    assert.equal(resolution.action, 'pending');
    assert.equal(resolution.reason, inspectionState);
    assert.equal(value.receipts.length, 0);
  }
});

test('a later recovery generation adopts when the same held result becomes terminal', async () => {
  const value = harness({ inspectionState: 'tool_result_persisted' });
  let terminal = false;
  value.recovery.proveToolWait = async () => {
    if (!terminal) throw new Error('codex_tool_wait_turn_incomplete');
    return value.proof;
  };

  const pending = await value.recovery.recoverHeldTool({
    wake: value.wake,
    claim: recoveryClaim(),
  });
  assert.equal(pending.action, 'pending');
  assert.equal(value.receipts.length, 0);

  terminal = true;
  const adopted = await value.recovery.recoverHeldTool({
    wake: value.wake,
    claim: recoveryClaim({
      leaseToken: '88888888-8888-4888-8888-888888888888',
      leaseGeneration: 3,
    }),
  });
  assert.equal(adopted.action, 'adopted');
  assert.equal(value.receipts.length, 1);
  assert.equal(value.receipts[0].receipt.leaseGeneration, 3);
});

test('fails closed when recovery changes the durable preparation binding', async () => {
  const value = harness();
  await assert.rejects(value.recovery.recoverHeldTool({
    wake: {
      ...value.wake,
      prepared: {
        ...value.wake.prepared,
        preparationNonce: `hkp_${'z'.repeat(32)}`,
      },
    },
    claim: recoveryClaim(),
  }), /held_recovery_prepared_binding_mismatch/);
  assert.equal(value.receipts.length, 0);
});
