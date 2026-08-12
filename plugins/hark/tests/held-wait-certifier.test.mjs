import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Canonical } from '../lib/canonical.mjs';
import { createPrivateClaimBinding } from '../lib/private-claim-store.mjs';
import {
  createArmBinding,
  createArmAttempt,
  createAwaitRequest,
  createAwaitRequestTerminal,
  createCompletionPosted,
  createSuspensionCommitted,
  createToolResultObservationIntent,
  createToolResultReturned,
  createToolWaitResult,
  createWaiterReady,
  createWakeDelivery,
  toolResultObservationSourceReceiptId,
  toolWaitCompletionSourceReceiptId,
} from '../lib/tool-wait-protocol.mjs';
import {
  createHeldCompletionReceipt,
  HarkHeldWaitCertifier,
} from '../lib/held-wait-certifier.mjs';

const CLOCK = () => new Date('2026-08-07T12:00:00.000Z');
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
  const arm = createArmBinding(request, {
    awaitId: 'await-1',
    preparationNonce: `hkp_${'p'.repeat(32)}`,
    checkpointDigest: 'c'.repeat(64),
  }, CLOCK, (size) => Buffer.alloc(size, 0x11));
  const ready = createWaiterReady(request, arm, INPUT, CLOCK);
  const committed = createSuspensionCommitted(request, arm, ready, {
    suspensionReceiptId: 'hrr_monitoring_task_suspended_await-1',
    suspensionReceiptDigest: 'd'.repeat(64),
  }, CLOCK);
  const wake = {
    v: 'hark.wake.v2',
    wakeId: '47c4c69a-316a-4d4b-9dfb-f43aab92dfde',
    idempotencyKey: '47c4c69a-316a-4d4b-9dfb-f43aab92dfde',
    awaitId: 'await-1',
    origin: { protocol: 'codex', runtimeId: 'runtime-1' },
    checkpoint: { version: 'hark.codex-checkpoint.v1', digest: 'c'.repeat(64) },
    prepared: { request: INPUT.request },
    signal: {
      id: 'signal-1',
      sourceSignalId: 'provider-1',
      type: 'job.completed',
      subject: 'job-42',
      qualificationDigest: 'a'.repeat(64),
      sourceAdapter: 'webhook.v1',
      authMode: 'source_hmac',
      observedAt: '2026-08-07T12:00:03.000Z',
      summary: 'Job completed.',
      data: { status: 'completed' },
      evidence: [],
    },
    createdAt: '2026-08-07T12:00:03.000Z',
  };
  const delivery = createWakeDelivery(
    request,
    arm,
    committed,
    wake,
    '3'.repeat(64),
    CLOCK,
  );
  const result = createToolWaitResult(delivery);
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
  const prepared = {
    v: 'hark.await-prepared.v1',
    preparationNonce: arm.preparationNonce,
    qualificationDigest: sha256Canonical({ source: INPUT.source, condition: INPUT.condition }),
    wakePolicy: 'resume',
    ...INPUT,
  };
  const armRequest = {
    v: 'hark.await.v2',
    preparationNonce: prepared.preparationNonce,
    origin: {
      protocol: 'codex',
      runtimeId: 'runtime-1',
      taskId: request.turnId,
      conversationId: request.sessionId,
    },
    checkpoint: { version: 'hark.codex-checkpoint.v1', digest: arm.checkpointDigest },
    prepared,
    predicate: {
      kind: 'exact_signal',
      type: INPUT.source.kind,
      subject: INPUT.source.subject,
      qualificationDigest: prepared.qualificationDigest,
    },
    wakePolicy: 'resume',
    binding: {
      continuationMode: 'held_tool',
      toolName: request.toolName,
      toolUseId: request.toolUseId,
      inputDigest: request.originalInputDigest,
    },
  };
  const armAttempt = createArmAttempt(request, {
    installationId: '11111111-1111-4111-8111-111111111111',
    armRequest,
    transcriptBoundary: boundary,
    bindingToken: arm.bindingToken,
  }, CLOCK);
  const returned = createToolResultReturned(delivery, result, {
    wakeDeliveryDigest: '3'.repeat(64),
    transcriptBoundary: boundary,
  }, CLOCK);
  const proof = {
    v: 'hark.codex-tool-wait-proof.v1',
    historySource: 'codex.rollout-jsonl.v1',
    conversationId: boundary.conversationId,
    originTaskId: boundary.originTaskId,
    wakeTaskId: boundary.originTaskId,
    toolName: boundary.toolName,
    toolUseId: boundary.toolUseId,
    inputDigest: boundary.inputDigest,
    toolCallDigest: boundary.toolCallDigest,
    toolResultDigest: returned.resultDigest,
    wakeDeliveryDigest: returned.wakeDeliveryDigest,
    rolloutToolOutputDigest: '4'.repeat(64),
    assistantResponseDigest: '5'.repeat(64),
    waitingInferenceRecordCount: 0,
    interveningTaskIds: [],
    rollbackMarkerCount: 0,
    historyMutationCount: 0,
    scannedAt: '2026-08-07T12:00:05.000Z',
    historyDigest: '6'.repeat(64),
  };
  return { request, arm, armAttempt, delivery, result, returned, proof };
}

function observedResult(value, overrides = {}) {
  const boundary = value.returned.transcriptBoundary;
  return {
    v: 'hark.tool-result-observed.v1',
    continuationMode: 'held_tool',
    observationMode: 'direct',
    conversationId: boundary.conversationId,
    taskId: boundary.originTaskId,
    toolName: boundary.toolName,
    toolUseId: boundary.toolUseId,
    inputDigest: boundary.inputDigest,
    wakeDeliveryDigest: value.delivery.wakeDeliveryDigest,
    toolResultDigest: sha256Canonical(value.result),
    ...overrides,
  };
}

function directObservationCertification(value, overrides = {}) {
  const observationCount = overrides.toolResultObservationCount ?? 1;
  return {
    v: 'hark.await-certification.v2',
    awaitId: value.delivery.awaitId,
    certified: false,
    reasons: ['tool_wait_proof_missing_or_duplicate', 'task_completion_not_proven'],
    origin: {
      protocol: 'codex',
      runtimeId: 'runtime-1',
      taskId: value.returned.transcriptBoundary.originTaskId,
      conversationId: value.returned.transcriptBoundary.conversationId,
    },
    checkpoint: {
      version: 'hark.codex-checkpoint.v1',
      digest: value.delivery.checkpointDigest,
    },
    wake: {
      id: value.delivery.wakeId,
      awaitId: value.delivery.awaitId,
      state: 'running',
      deliveryMode: 'held_tool',
      heldDeliveryDigest: value.delivery.wakeDeliveryDigest,
      ...overrides.wake,
    },
    continuation: {
      mode: 'held_tool',
      proof: null,
      toolResultObservation: observationCount === 0
        ? null
        : observedResult(value, overrides.observation),
      ...overrides.continuation,
    },
    toolResultObservationCount: observationCount,
    activeToolResultObservationCount: overrides.activeToolResultObservationCount
      ?? observationCount,
    toolResultNotPersistedCount: overrides.toolResultNotPersistedCount ?? 0,
    toolResultRecoveryProof: overrides.toolResultRecoveryProof ?? null,
    ...overrides.topLevel,
  };
}

function inspection(value, state = 'tool_result_turn_terminal', overrides = {}) {
  const hasResult = [
    'tool_result_persisted',
    'tool_result_then_aborted',
    'tool_result_turn_terminal',
  ].includes(state);
  const terminalType = state.includes('aborted')
    ? 'turn_aborted'
    : state.includes('terminal') || state === 'origin_completed_without_result'
      ? 'task_complete'
      : null;
  return {
    v: 'hark.codex-tool-wait-inspection.v1',
    historySource: 'codex.rollout-jsonl.v1',
    conversationId: value.returned.transcriptBoundary.conversationId,
    originTaskId: value.returned.transcriptBoundary.originTaskId,
    toolUseId: value.returned.transcriptBoundary.toolUseId,
    toolName: value.returned.transcriptBoundary.toolName,
    inputDigest: value.returned.transcriptBoundary.inputDigest,
    toolResultDigest: sha256Canonical(value.result),
    rolloutToolOutputDigest: hasResult ? '7'.repeat(64) : null,
    state,
    originTerminal: terminalType ? {
      type: terminalType,
      reason: terminalType === 'turn_aborted' ? 'interrupted' : 'completed',
      observedAt: '2026-08-07T12:00:04.000Z',
    } : null,
    incompleteTail: state === 'ambiguous_incomplete_tail',
    inspectedAtByteLength: 2048,
    historyDigest: '8'.repeat(64),
    ...overrides,
  };
}

function recoveryHandoffCertification(value, recoveryProof) {
  return directObservationCertification(value, {
    wake: { state: 'queued', deliveryMode: 'crash_recovery' },
    continuation: { mode: 'crash_recovery', toolResultObservation: null },
    activeToolResultObservationCount: 0,
    toolResultNotPersistedCount: 1,
    toolResultRecoveryProof: recoveryProof,
  });
}

function harness({
  proofError = null,
  certification = null,
  localReturned = true,
  recoveryCertification = null,
  inspectionValue = null,
  inspectionError = null,
  recordReceipt = null,
  observationIntent = false,
  initialClaimState = 'pending',
  certificationResolver = null,
  armAttempt = null,
  originAbortReceipt = null,
  crashDisposition = { kind: 'inactive', reason: 'no_crash_gap' },
} = {}) {
  const value = records();
  let marker = null;
  let terminal = null;
  let archived = false;
  let returnedMarker = localReturned ? value.returned : null;
  const posted = [];
  const returnedPublishes = [];
  const inspections = [];
  const proofCalls = [];
  let certificationCalls = 0;
  let claimState = initialClaimState;
  let claimConsumeCount = 0;
  let intent = null;
  if (observationIntent) {
    const binding = createPrivateClaimBinding({
      eventId: value.delivery.eventId,
      deliveryId: value.delivery.deliveryId,
      awaitId: value.delivery.awaitId,
      wakeId: value.delivery.wakeId,
      toolUseId: value.delivery.toolUseId,
      checkpointDigest: value.delivery.checkpointDigest,
      wakeDeliveryDigest: value.delivery.wakeDeliveryDigest,
      toolResultDigest: sha256Canonical(value.result),
    });
    const claimReference = {
      v: 'hark.codex-held-claim-ref.v1',
      locator: `hhc_${'A'.repeat(43)}`,
      bindingDigest: sha256Canonical(binding),
      wakeDeliveryDigest: binding.wakeDeliveryDigest,
      toolResultDigest: binding.toolResultDigest,
    };
    intent = createToolResultObservationIntent({
      delivery: value.delivery,
      result: value.result,
      transcriptBoundary: value.returned.transcriptBoundary,
      runtimeId: 'runtime-1',
      claimReference,
    }, CLOCK);
  }
  const protocol = {
    async listAwaitRequests() { return archived ? [] : [value.request]; },
    async readArmAttempt() { return armAttempt ? value.armAttempt : null; },
    async readHeldCallOriginAbortReceipt() { return originAbortReceipt; },
    async readArmBinding() { return value.arm; },
    async readTranscriptBoundary() {
      return {
        boundary: value.returned.transcriptBoundary,
        boundaryDigest: sha256Canonical(value.returned.transcriptBoundary),
      };
    },
    async readWakeDelivery() { return value.delivery; },
    async readToolResultObservationIntent() { return intent; },
    async readToolResultReturned() { return returnedMarker; },
    async publishToolResultReturned(delivery, result, observation) {
      returnedPublishes.push({ delivery, result, observation });
      const created = returnedMarker === null;
      returnedMarker = createToolResultReturned(delivery, result, observation, CLOCK);
      return { created, toolResultReturned: returnedMarker };
    },
    async readCompletionPosted() { return marker; },
    async publishCompletionPosted(returned, input, clock) {
      marker = createCompletionPosted(returned, input, clock);
      return { created: true, completionPosted: marker };
    },
    async publishAwaitRequestTerminal(request, input, clock) {
      terminal = createAwaitRequestTerminal(request, input, clock);
      return { created: true, awaitRequestTerminal: terminal };
    },
    async archiveAwaitRequest(request, expectedTerminal) {
      assert.equal(request.eventId, value.request.eventId);
      assert.deepEqual(expectedTerminal, terminal);
      archived = true;
      return { archived: true, value: request };
    },
  };
  const service = {
    async getInstallationStatus() {
      return {
        v: 'hark.installation-status.v2',
        installation: {
          id: '11111111-1111-4111-8111-111111111111',
          protocol: 'codex',
          runtimeId: 'runtime-1',
        },
      };
    },
    async recordRuntimeReceipt(awaitId, receipt) {
      posted.push({ awaitId, receipt: structuredClone(receipt) });
      if (recordReceipt) return recordReceipt(awaitId, receipt, posted.length);
      if ([
        'tool_result_not_persisted',
        'tool_result_continuation_aborted',
      ].includes(receipt.kind)) {
        return {
          v: 'hark.runtime-receipt-result.v2',
          awaitId,
          kind: receipt.kind,
          state: 'wake_pending',
          wakeState: 'queued',
          replay: false,
        };
      }
      if (receipt.kind === 'tool_result_observed') {
        return {
          v: 'hark.runtime-receipt-result.v2',
          awaitId,
          kind: receipt.kind,
          state: 'running',
          wakeState: 'running',
          replay: false,
        };
      }
      return { v: 'hark.runtime-receipt-result.v2', replay: posted.length > 1 };
    },
    async certifyAwait(awaitId) {
      certificationCalls += 1;
      if (certificationResolver) {
        return certificationResolver(value, certificationCalls, posted);
      }
      if (recoveryCertification && returnedMarker === null) {
        return typeof recoveryCertification === 'function'
          ? recoveryCertification(value, certificationCalls)
          : recoveryCertification;
      }
      return certification ?? {
        v: 'hark.await-certification.v2',
        awaitId,
        certified: true,
        reasons: [],
        continuation: { mode: 'held_tool', proof: value.proof },
      };
    },
  };
  const claimStore = {
    async resolve(reference, binding) {
      assert.deepEqual(reference, intent.claimReference);
      assert.deepEqual(binding, intent.binding);
      return claimState === 'pending'
        ? { state: 'pending', leaseToken: 'lease-secret-1', leaseGeneration: 1 }
        : { state: 'consumed' };
    },
    async consume(reference, binding) {
      assert.deepEqual(reference, intent.claimReference);
      assert.deepEqual(binding, intent.binding);
      const created = claimState === 'pending';
      claimState = 'consumed';
      if (created) claimConsumeCount += 1;
      return { consumed: created, state: 'consumed' };
    },
  };
  const certifier = new HarkHeldWaitCertifier({
    protocol,
    serviceClient: service,
    crashReconciler: {
      async reconcile() { return structuredClone(crashDisposition); },
    },
    ...(intent ? { claimStore } : {}),
    runtimeId: 'runtime-1',
    credentials: {
      installation: {
        id: '11111111-1111-4111-8111-111111111111',
        protocol: 'codex',
        runtimeId: 'runtime-1',
      },
    },
    inspectToolWait: async (...args) => {
      inspections.push(args);
      if (inspectionError) throw new Error(inspectionError);
      return typeof inspectionValue === 'function'
        ? inspectionValue(value)
        : inspectionValue ?? inspection(value);
    },
    proveToolWait: async (...args) => {
      proofCalls.push(args);
      if (proofError) throw new Error(proofError);
      return value.proof;
    },
  });
  return {
    ...value,
    certifier,
    posted,
    returnedPublishes,
    inspections,
    proofCalls,
    get certificationCalls() { return certificationCalls; },
    get marker() { return marker; },
    get terminal() { return terminal; },
    get archived() { return archived; },
    get returnedMarker() { return returnedMarker; },
    get claimState() { return claimState; },
    get claimConsumeCount() { return claimConsumeCount; },
  };
}

test('posts and certifies one secret-free same-turn completion exactly once locally', async () => {
  const value = harness();
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 1, skipped: 0, pending: 0, failed: 0, errors: [],
  });
  assert.equal(value.posted.length, 1);
  const { receipt } = value.posted[0];
  assert.equal(receipt.sourceReceiptId, toolWaitCompletionSourceReceiptId(value.delivery.wakeId));
  assert.equal(
    receipt.toolResultObservationSourceReceiptId,
    toolResultObservationSourceReceiptId(value.delivery.wakeId),
  );
  assert.equal(receipt.kind, 'task_completed');
  assert.equal(receipt.origin.taskId, 'turn-1');
  assert.equal(receipt.continuationProof.wakeTaskId, 'turn-1');
  assert.equal(/leaseToken|leaseGeneration/.test(JSON.stringify(receipt)), false);

  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 0, skipped: 0, pending: 0, failed: 0, errors: [],
  });
  assert.equal(value.posted.length, 1);
  assert.ok(value.marker);
  assert.ok(value.terminal);
  assert.equal(value.archived, true);
});

test('crash reconciliation ownership leaves an ambiguous held call completely untouched', async () => {
  const value = harness({
    crashDisposition: { kind: 'owned', reason: 'origin_abort_proof_missing' },
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 0, skipped: 0, pending: 1, failed: 0, errors: [],
  });
  assert.equal(value.certificationCalls, 0);
  assert.equal(value.proofCalls.length, 0);
  assert.equal(value.returnedPublishes.length, 0);
  assert.equal(value.posted.length, 0);
  assert.equal(value.archived, false);
});

test('flushes one durable observation intent before posting same-turn completion', async () => {
  const value = harness({
    observationIntent: true,
    certificationResolver: (recordsValue, call) => (
      call === 1
        ? directObservationCertification(recordsValue, {
          toolResultObservationCount: 0,
          activeToolResultObservationCount: 0,
        })
        : {
          v: 'hark.await-certification.v2',
          awaitId: recordsValue.delivery.awaitId,
          certified: true,
          reasons: [],
          continuation: { mode: 'held_tool', proof: recordsValue.proof },
        }
    ),
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 1, skipped: 0, pending: 0, failed: 0, errors: [],
  });
  assert.deepEqual(value.posted.map(({ receipt }) => receipt.kind), [
    'tool_result_observed',
    'task_completed',
  ]);
  assert.equal(value.posted[0].receipt.leaseToken, 'lease-secret-1');
  assert.equal(value.posted[0].receipt.toolResultObservation.observationMode, 'direct');
  assert.equal(value.claimState, 'consumed');
  assert.equal(value.claimConsumeCount, 1);
});

test('certification repairs API-accepted-before-consume without replaying the receipt', async () => {
  const value = harness({
    observationIntent: true,
    certificationResolver: (recordsValue, call) => (
      call === 1
        ? directObservationCertification(recordsValue)
        : {
          v: 'hark.await-certification.v2',
          awaitId: recordsValue.delivery.awaitId,
          certified: true,
          reasons: [],
          continuation: { mode: 'held_tool', proof: recordsValue.proof },
        }
    ),
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 1, skipped: 0, pending: 0, failed: 0, errors: [],
  });
  assert.deepEqual(value.posted.map(({ receipt }) => receipt.kind), ['task_completed']);
  assert.equal(value.claimState, 'consumed');
  assert.equal(value.claimConsumeCount, 1);
});

test('repairs API-accepted completion before the local marker with one exact replay', async () => {
  const completedCertification = (recordsValue) => directObservationCertification(
    recordsValue,
    {
      wake: {
        state: 'completed',
        completedAt: '2026-08-07T12:00:06.000Z',
      },
      continuation: { proof: recordsValue.proof },
      topLevel: {
        certified: true,
        reasons: [],
        completionReceiptCount: 1,
      },
    },
  );
  const value = harness({
    observationIntent: true,
    initialClaimState: 'consumed',
    certificationResolver: completedCertification,
    recordReceipt: (awaitId, receipt) => ({
      v: 'hark.runtime-receipt-result.v2',
      awaitId,
      kind: receipt.kind,
      state: 'completed',
      wakeState: 'completed',
      replay: true,
    }),
  });

  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 1, skipped: 0, pending: 0, failed: 0, errors: [],
  });
  assert.deepEqual(value.posted.map(({ receipt }) => receipt.kind), ['task_completed']);
  assert.ok(value.marker);
  assert.ok(value.terminal);
  assert.equal(value.archived, true);
});

test('accepts one recovery-adoption observation as the same held result after lease expiry', async () => {
  const value = harness({
    observationIntent: true,
    certificationResolver: (recordsValue, call) => (
      call === 1
        ? directObservationCertification(recordsValue, {
          observation: { observationMode: 'recovery_adoption' },
        })
        : {
          v: 'hark.await-certification.v2',
          awaitId: recordsValue.delivery.awaitId,
          certified: true,
          reasons: [],
          continuation: { mode: 'held_tool', proof: recordsValue.proof },
        }
    ),
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 1, skipped: 0, pending: 0, failed: 0, errors: [],
  });
  assert.deepEqual(value.posted.map(({ receipt }) => receipt.kind), ['task_completed']);
  assert.equal(value.claimState, 'consumed');
  assert.equal(value.claimConsumeCount, 1);
});

test('never assumes a consumed claim succeeded when certification says observation absent', async () => {
  const value = harness({
    observationIntent: true,
    initialClaimState: 'consumed',
    certificationResolver: (recordsValue) => directObservationCertification(recordsValue, {
      toolResultObservationCount: 0,
      activeToolResultObservationCount: 0,
    }),
  });
  const summary = await value.certifier.reconcile();
  assert.equal(summary.failed, 1);
  assert.match(summary.errors[0].error, /consumed_private_claim_without_remote_observation/);
  assert.deepEqual(value.posted, []);
});

test('keeps a stale original observation lease pending for existing recovery adoption', async () => {
  const value = harness({
    observationIntent: true,
    certificationResolver: (recordsValue) => directObservationCertification(recordsValue, {
      toolResultObservationCount: 0,
      activeToolResultObservationCount: 0,
    }),
    recordReceipt: (_awaitId, receipt) => {
      if (receipt.kind === 'tool_result_observed') {
        throw Object.assign(new Error('wake_lease_stale'), {
          status: 409,
          code: 'wake_lease_stale',
        });
      }
      return null;
    },
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 0, skipped: 0, pending: 1, failed: 0, errors: [],
  });
  assert.equal(value.posted.length, 1);
  assert.equal(value.posted[0].receipt.kind, 'tool_result_observed');
  assert.equal(value.claimState, 'pending');
  assert.equal(value.claimConsumeCount, 0);
  assert.equal(value.marker, null);
});

test('reconstructs a missing local return from exact transcript proof before flushing intent', async () => {
  const value = harness({
    observationIntent: true,
    localReturned: false,
    inspectionValue: (recordsValue) => inspection(recordsValue, 'tool_result_persisted'),
    certificationResolver: (recordsValue, call) => (
      call < 3
        ? directObservationCertification(recordsValue, {
          toolResultObservationCount: 0,
          activeToolResultObservationCount: 0,
        })
        : {
          v: 'hark.await-certification.v2',
          awaitId: recordsValue.delivery.awaitId,
          certified: true,
          reasons: [],
          continuation: { mode: 'held_tool', proof: recordsValue.proof },
        }
    ),
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 1, skipped: 0, pending: 0, failed: 0, errors: [],
  });
  assert.equal(value.returnedPublishes.length, 1);
  assert.deepEqual(value.posted.map(({ receipt }) => receipt.kind), [
    'tool_result_observed',
    'task_completed',
  ]);
  assert.equal(value.claimState, 'consumed');
});

test('repairs a missing local return only from one exact remote observation and persisted output', async () => {
  const value = harness({
    localReturned: false,
    recoveryCertification: directObservationCertification,
    inspectionValue: (recordsValue) => inspection(
      recordsValue,
      'tool_result_turn_terminal',
    ),
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 1, skipped: 0, pending: 0, failed: 0, errors: [],
  });
  assert.equal(value.certificationCalls, 2);
  assert.equal(value.inspections.length, 1);
  assert.equal(value.returnedPublishes.length, 1);
  assert.equal(value.proofCalls.length, 1);
  assert.equal(value.returnedMarker.deliveryId, value.delivery.deliveryId);
  assert.equal(value.returnedMarker.wakeDeliveryDigest, value.delivery.wakeDeliveryDigest);
  assert.deepEqual(
    value.returnedMarker.transcriptBoundary,
    value.returned.transcriptBoundary,
  );
  assert.deepEqual(value.posted.map(({ receipt }) => receipt.kind), ['task_completed']);
  assert.ok(value.marker);
});

test('keeps a genuinely absent observation and incomplete transcript states pending', async () => {
  const absent = harness({
    localReturned: false,
    recoveryCertification: (value) => directObservationCertification(value, {
      toolResultObservationCount: 0,
      wake: { state: 'leased' },
    }),
  });
  assert.deepEqual(await absent.certifier.reconcile(), {
    posted: 0, skipped: 0, pending: 1, failed: 0, errors: [],
  });
  assert.equal(absent.inspections.length, 0);
  assert.equal(absent.returnedPublishes.length, 0);
  assert.equal(absent.posted.length, 0);

  for (const state of ['waiting', 'ambiguous_incomplete_tail']) {
    const pending = harness({
      localReturned: false,
      recoveryCertification: directObservationCertification,
      inspectionValue: (value) => inspection(value, state),
    });
    const summary = await pending.certifier.reconcile();
    assert.equal(summary.pending, 1, state);
    assert.equal(summary.failed, 0, state);
    assert.equal(pending.returnedPublishes.length, 0, state);
    assert.equal(pending.posted.length, 0, state);
  }
});

test('hands an exact origin-aborted gap back to crash recovery without a lease', async () => {
  const value = harness({
    armAttempt: { eventId: 'event-1' },
    originAbortReceipt: { v: 'hark.held-call-origin-abort.v1' },
    crashDisposition: { kind: 'recovery_authorized', reason: 'commit_replayed' },
    localReturned: false,
    recoveryCertification: directObservationCertification,
    inspectionValue: (recordsValue) => inspection(
      recordsValue,
      'origin_aborted_before_result',
    ),
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 0, skipped: 0, pending: 1, failed: 0, errors: [],
  });
  assert.equal(value.returnedPublishes.length, 0);
  assert.equal(value.proofCalls.length, 0);
  assert.equal(value.posted.length, 1);
  const [{ awaitId, receipt }] = value.posted;
  assert.equal(awaitId, value.delivery.awaitId);
  assert.equal(receipt.sourceReceiptId, `hrr_tool_result_not_persisted_${value.delivery.wakeId}`);
  assert.equal(
    receipt.toolResultObservationSourceReceiptId,
    toolResultObservationSourceReceiptId(value.delivery.wakeId),
  );
  assert.equal(receipt.kind, 'tool_result_not_persisted');
  assert.equal(receipt.wakeId, value.delivery.wakeId);
  assert.equal(receipt.checkpointDigest, value.delivery.checkpointDigest);
  assert.equal(receipt.observedAt, receipt.recoveryProof.originTerminal.observedAt);
  assert.equal(receipt.recoveryProof.state, 'origin_aborted_before_result');
  assert.equal(receipt.recoveryProof.toolResultDigest, sha256Canonical(value.result));
  assert.equal(/leaseToken|leaseGeneration/.test(JSON.stringify(receipt)), false);
});

test('rollout abort evidence alone cannot post a recovery lifecycle receipt', async () => {
  const value = harness({
    localReturned: false,
    recoveryCertification: directObservationCertification,
    inspectionValue: (recordsValue) => inspection(
      recordsValue,
      'origin_aborted_before_result',
    ),
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 0, skipped: 0, pending: 1, failed: 0, errors: [],
  });
  assert.equal(value.inspections.length, 1);
  assert.equal(value.posted.length, 0);
  assert.equal(value.returnedPublishes.length, 0);
});

test('hands an exact persisted result with an aborted continuation to crash recovery', async () => {
  const value = harness({
    armAttempt: { eventId: 'event-1' },
    originAbortReceipt: { v: 'hark.held-call-origin-abort.v1' },
    crashDisposition: { kind: 'recovery_authorized', reason: 'commit_replayed' },
    proofError: 'codex_tool_wait_turn_incomplete',
    inspectionValue: (recordsValue) => inspection(
      recordsValue,
      'tool_result_then_aborted',
    ),
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 0, skipped: 0, pending: 1, failed: 0, errors: [],
  });
  assert.equal(value.posted.length, 1);
  const [{ awaitId, receipt }] = value.posted;
  assert.equal(awaitId, value.delivery.awaitId);
  assert.equal(
    receipt.sourceReceiptId,
    `hrr_tool_result_continuation_aborted_${value.delivery.wakeId}`,
  );
  assert.equal(receipt.kind, 'tool_result_continuation_aborted');
  assert.equal(
    receipt.toolResultObservationSourceReceiptId,
    toolResultObservationSourceReceiptId(value.delivery.wakeId),
  );
  assert.equal(receipt.recoveryProof.state, 'tool_result_then_aborted');
  assert.equal(receipt.recoveryProof.originTerminal.type, 'turn_aborted');
  assert.match(receipt.recoveryProof.rolloutToolOutputDigest, /^[a-f0-9]{64}$/u);
  assert.equal(/leaseToken|leaseGeneration/.test(JSON.stringify(receipt)), false);
});

test('recognizes an exact prior crash-recovery handoff and remains pending', async () => {
  const value = harness({
    localReturned: false,
    recoveryCertification: (recordsValue) => recoveryHandoffCertification(
      recordsValue,
      inspection(recordsValue, 'origin_aborted_before_result'),
    ),
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 0, skipped: 0, pending: 1, failed: 0, errors: [],
  });
  assert.equal(value.inspections.length, 0);
  assert.equal(value.returnedPublishes.length, 0);
  assert.equal(value.posted.length, 0);
});

test('archives a held request only after crash recovery is remotely certified complete', async () => {
  const value = harness({
    localReturned: false,
    recoveryCertification: (recordsValue) => {
      const certification = recoveryHandoffCertification(
        recordsValue,
        inspection(recordsValue, 'origin_aborted_before_result'),
      );
      certification.certified = true;
      certification.reasons = [];
      certification.completionReceiptCount = 1;
      certification.wake.state = 'completed';
      certification.wake.completedAt = '2026-08-07T12:00:06.000Z';
      return certification;
    },
  });
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 0, skipped: 1, pending: 0, failed: 0, errors: [],
  });
  assert.equal(value.archived, true);
  assert.equal(value.terminal.disposition, 'crash_recovery_completed');
  assert.deepEqual(await value.certifier.reconcile(), {
    posted: 0, skipped: 0, pending: 0, failed: 0, errors: [],
  });
});

test('retries the same deterministic recovery receipt after an ambiguous response', async () => {
  let attempts = 0;
  const value = harness({
    armAttempt: { eventId: 'event-1' },
    originAbortReceipt: { v: 'hark.held-call-origin-abort.v1' },
    crashDisposition: { kind: 'recovery_authorized', reason: 'commit_replayed' },
    localReturned: false,
    recoveryCertification: directObservationCertification,
    inspectionValue: (recordsValue) => inspection(
      recordsValue,
      'origin_aborted_before_result',
    ),
    recordReceipt: (awaitId, receipt) => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('response_lost');
        error.name = 'AbortError';
        throw error;
      }
      return {
        v: 'hark.runtime-receipt-result.v2',
        awaitId,
        kind: receipt.kind,
        state: 'wake_pending',
        wakeState: 'queued',
        replay: false,
      };
    },
  });
  assert.equal((await value.certifier.reconcile()).pending, 1);
  assert.equal((await value.certifier.reconcile()).pending, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(value.posted[0], value.posted[1]);
});

test('fails closed on remote observation identity, count, digest, or shape drift', async () => {
  const cases = [
    ['await identity', (certificationValue) => { certificationValue.awaitId = 'await-2'; }],
    ['wake identity', (certificationValue) => { certificationValue.wake.id = 'wake-2'; }],
    ['wake await', (certificationValue) => { certificationValue.wake.awaitId = 'await-2'; }],
    ['delivery digest', (certificationValue) => {
      certificationValue.wake.heldDeliveryDigest = '9'.repeat(64);
    }],
    ['delivery mode', (certificationValue) => {
      certificationValue.wake.deliveryMode = 'crash_recovery';
    }],
    ['delivery state', (certificationValue) => { certificationValue.wake.state = 'queued'; }],
    ['origin boundary', (certificationValue) => {
      certificationValue.origin.taskId = 'turn-2';
    }],
    ['checkpoint boundary', (certificationValue) => {
      certificationValue.checkpoint.digest = '9'.repeat(64);
    }],
    ['duplicate observation', (certificationValue) => {
      certificationValue.toolResultObservationCount = 2;
      certificationValue.activeToolResultObservationCount = 2;
    }],
    ['call identity', (certificationValue) => {
      certificationValue.continuation.toolResultObservation.toolUseId = 'call-2';
    }],
    ['result digest', (certificationValue) => {
      certificationValue.continuation.toolResultObservation.toolResultDigest = '9'.repeat(64);
    }],
    ['observation shape', (certificationValue) => {
      certificationValue.continuation.toolResultObservation.extra = true;
    }],
    ['missing wake field', (certificationValue) => {
      delete certificationValue.wake.heldDeliveryDigest;
    }],
  ];
  for (const [label, mutate] of cases) {
    const value = harness({
      localReturned: false,
      recoveryCertification: (recordsValue) => {
        const certificationValue = directObservationCertification(recordsValue);
        mutate(certificationValue);
        return certificationValue;
      },
    });
    const summary = await value.certifier.reconcile();
    assert.equal(summary.failed, 1, label);
    assert.equal(summary.pending, 0, label);
    assert.equal(value.inspections.length, 0, label);
    assert.equal(value.returnedPublishes.length, 0, label);
    assert.equal(value.posted.length, 0, label);
  }
});

test('fails closed when the origin completed without the remotely observed result', async () => {
  const value = harness({
    localReturned: false,
    recoveryCertification: directObservationCertification,
    inspectionValue: (recordsValue) => inspection(
      recordsValue,
      'origin_completed_without_result',
    ),
  });
  const summary = await value.certifier.reconcile();
  assert.equal(summary.failed, 1);
  assert.match(summary.errors[0].error, /origin_completed_without_result/);
  assert.equal(value.returnedPublishes.length, 0);
  assert.equal(value.posted.length, 0);
});

test('fails closed on contaminated or internally inconsistent inspection evidence', async () => {
  const contaminated = harness({
    localReturned: false,
    recoveryCertification: directObservationCertification,
    inspectionError: 'codex_tool_wait_pre_result_contaminated',
  });
  const contaminatedSummary = await contaminated.certifier.reconcile();
  assert.equal(contaminatedSummary.failed, 1);
  assert.match(
    contaminatedSummary.errors[0].error,
    /codex_tool_wait_pre_result_contaminated/,
  );

  const inconsistent = harness({
    localReturned: false,
    recoveryCertification: directObservationCertification,
    inspectionValue: (value) => inspection(value, 'tool_result_persisted', {
      rolloutToolOutputDigest: null,
    }),
  });
  const inconsistentSummary = await inconsistent.certifier.reconcile();
  assert.equal(inconsistentSummary.failed, 1);
  assert.match(inconsistentSummary.errors[0].error, /tool_wait_inspection_state_mismatch/);
  assert.equal(inconsistent.returnedPublishes.length, 0);
  assert.equal(inconsistent.posted.length, 0);
});

test('build helper rejects a proof for any other task, result, or delivery', () => {
  const value = records();
  const receipt = createHeldCompletionReceipt({
    runtimeId: 'runtime-1',
    delivery: value.delivery,
    returned: value.returned,
    proof: value.proof,
  });
  assert.equal(receipt.continuationProof.toolResultDigest, value.returned.resultDigest);
  assert.throws(() => createHeldCompletionReceipt({
    runtimeId: 'runtime-1',
    delivery: value.delivery,
    returned: value.returned,
    proof: { ...value.proof, wakeTaskId: 'turn-2' },
  }), /continuation_proof_boundary_mismatch/);
});

test('keeps an incomplete Codex turn pending and refuses an uncertified completion', async () => {
  const pending = harness({ proofError: 'codex_tool_wait_turn_incomplete' });
  const pendingResult = await pending.certifier.reconcile();
  assert.equal(pendingResult.pending, 1);
  assert.equal(pendingResult.failed, 0);
  assert.equal(pending.posted.length, 0);

  const rejected = harness({
    certification: {
      v: 'hark.await-certification.v2',
      awaitId: 'await-1',
      certified: false,
      reasons: ['model_call_during_wait'],
      continuation: { mode: 'held_tool' },
    },
  });
  const rejectedResult = await rejected.certifier.reconcile();
  assert.equal(rejectedResult.failed, 1);
  assert.match(rejectedResult.errors[0].error, /model_call_during_wait/);
  assert.equal(rejected.marker, null);
});

test('poll retries a transient spool failure and remains abort-responsive', async () => {
  const controller = new AbortController();
  let scans = 0;
  const warnings = [];
  const certifier = new HarkHeldWaitCertifier({
    protocol: {
      async listAwaitRequests() {
        scans += 1;
        if (scans === 1) {
          const error = new Error('descriptor_pressure');
          error.code = 'EMFILE';
          throw error;
        }
        controller.abort();
        return [];
      },
    },
    serviceClient: {},
    runtimeId: 'runtime-1',
    pollIntervalMs: 25,
    logger: { info() {}, error() {}, warn(...args) { warnings.push(args); } },
  });
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await certifier.poll(controller.signal);
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(scans, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0].error, /descriptor_pressure/);
});
