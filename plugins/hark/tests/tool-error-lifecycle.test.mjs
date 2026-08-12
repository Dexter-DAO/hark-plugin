import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  armApiResponse,
  commitApiResponse,
} from './api-response-fixtures.mjs';
import { sha256Canonical } from '../lib/canonical.mjs';
import {
  assertReconciledArmApiResponse,
  assertReconciledCancelApiResponse,
  assertReconciledCommitApiResponse,
  createHeldCallCancelRequest,
  HarkToolErrorLifecycle,
} from '../lib/tool-error-lifecycle.mjs';
import { HarkToolWaitProtocol } from '../lib/tool-wait-protocol.mjs';

const CLOCK = () => new Date('2026-08-07T12:00:00.000Z');
const INSTALLATION = {
  id: '11111111-1111-4111-8111-111111111111',
  protocol: 'codex',
  runtimeId: 'runtime-1',
};
const CREDENTIALS = { installation: INSTALLATION };
const INPUT = {
  request: 'Continue after release 42 is healthy.',
  name: 'Release 42',
  source: { kind: 'release.healthy', adapter: 'release.v1', subject: 'release-42' },
  condition: { status: { equals: 'healthy' } },
};

function random(fill) {
  return (size) => Buffer.alloc(size, fill);
}

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-error-'));
  const protocol = new HarkToolWaitProtocol(dataDir);
  const request = (await protocol.publishAwaitRequest({
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolUseId: 'call-1',
    toolName: 'mcp__hark__hark_await',
    transcriptPath: '/private/codex/session-1.jsonl',
    originalInput: INPUT,
  }, CLOCK)).request;
  const prepared = {
    v: 'hark.await-prepared.v1',
    preparationNonce: `hkp_${'p'.repeat(32)}`,
    qualificationDigest: sha256Canonical({ source: INPUT.source, condition: INPUT.condition }),
    wakePolicy: 'resume',
    ...INPUT,
  };
  const checkpoint = { version: 'hark.codex-checkpoint.v1', digest: 'c'.repeat(64) };
  const armRequest = {
    v: 'hark.await.v2',
    preparationNonce: prepared.preparationNonce,
    origin: {
      protocol: 'codex',
      runtimeId: 'runtime-1',
      taskId: request.turnId,
      conversationId: request.sessionId,
    },
    checkpoint,
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
  const transcriptBoundary = {
    v: 'hark.codex-tool-wait-boundary.v1',
    historySource: 'codex.rollout-jsonl.v1',
    transcriptPath: request.transcriptPath,
    conversationId: request.sessionId,
    originTaskId: request.turnId,
    toolUseId: request.toolUseId,
    toolName: request.toolName,
    toolCallDigest: '1'.repeat(64),
    inputDigest: request.originalInputDigest,
    cliVersion: '0.147.0',
    dev: '1',
    ino: '2',
    byteLength: 128,
    prefixSha256: '2'.repeat(64),
  };
  return { protocol, request, armRequest, transcriptBoundary };
}

async function publishFailure(protocol, request, failureCode) {
  const toolError = (await protocol.publishToolError(request, {
    failureCode,
    errorDigest: 'e'.repeat(64),
  }, CLOCK)).toolError;
  await protocol.publishToolErrorObservation(request, toolError, {
    responseDigest: 'f'.repeat(64),
  }, CLOCK);
  return toolError;
}

async function publishAttempt(value) {
  return (await value.protocol.publishArmAttempt(value.request, {
    installationId: INSTALLATION.id,
    armRequest: value.armRequest,
    transcriptBoundary: value.transcriptBoundary,
  }, CLOCK, random(0x31))).armAttempt;
}

function fencedService(service = {}) {
  return {
    async getInstallationStatus() {
      return {
        v: 'hark.installation-status.v2',
        installation: structuredClone(INSTALLATION),
      };
    },
    ...service,
  };
}

function lifecycleOptions(protocol, serviceClient = {}) {
  return {
    protocol,
    credentials: CREDENTIALS,
    serviceClient: fencedService(serviceClient),
  };
}

function cancelResponse(armRequest, replay = false) {
  const cancelledAt = '2026-08-07T12:00:01.000Z';
  const awaitView = armApiResponse(armRequest).await;
  return {
    v: 'hark.await-cancel-result.v2',
    await: {
      ...awaitView,
      waiter: {
        ...awaitView.waiter,
        releasedAt: cancelledAt,
      },
      state: 'cancelled',
      cancelledAt,
      lastError: 'codex_held_tool_failed_before_suspension',
      updatedAt: cancelledAt,
    },
    replay,
  };
}

function cancelExpectation(value) {
  return {
    awaitId: 'await-1',
    armRequest: value.armRequest,
    cancelRequest: createHeldCallCancelRequest(value.request),
  };
}

async function publishArm(value, attempt) {
  const arm = (await value.protocol.publishArmBinding(value.request, {
    awaitId: 'await-1',
    preparationNonce: attempt.preparationNonce,
    checkpointDigest: attempt.checkpointDigest,
    bindingToken: attempt.bindingToken,
  }, CLOCK)).armBinding;
  await value.protocol.publishTranscriptBoundary(
    value.request,
    arm,
    attempt.transcriptBoundary,
    CLOCK,
  );
  return arm;
}

test('reconciliation accepts fresh or replayed exact API effects and rejects identity drift', async () => {
  const value = await fixture();
  for (const replay of [false, true]) {
    const arm = armApiResponse(value.armRequest, { replay });
    assert.equal(assertReconciledArmApiResponse(arm, value.armRequest).result.replay, replay);
    const commitRequest = {
      v: 'hark.suspension-commit.v2',
      commitNonce: `hkc_${'q'.repeat(32)}`,
      checkpointDigest: value.armRequest.checkpoint.digest,
    };
    const commit = commitApiResponse({
      armRequest: value.armRequest,
      commitRequest,
      awaitId: 'await-1',
      replay,
    });
    assert.equal(assertReconciledCommitApiResponse(commit, {
      awaitId: 'await-1',
      armRequest: value.armRequest,
      commitRequest,
    }).result.replay, replay);
  }
  const altered = armApiResponse(value.armRequest, { replay: true });
  altered.await.origin.taskId = 'other-turn';
  assert.throws(
    () => assertReconciledArmApiResponse(altered, value.armRequest),
    /armed_await_origin_mismatch/,
  );
});

test('reconciled cancellation accepts the exact production-shaped await for replay and non-replay', async () => {
  const value = await fixture();
  for (const replay of [false, true]) {
    const response = cancelResponse(value.armRequest, replay);
    assert.equal(
      assertReconciledCancelApiResponse(response, cancelExpectation(value)).replay,
      replay,
    );
  }
});

test('reconciled cancellation rejects incomplete, extra, or inconsistent production shapes', async (context) => {
  const value = await fixture();
  const cases = [
    ['missing public Await field', (response) => { delete response.await.prepared; }, /cancelled_await_field_required:prepared/],
    ['extra public Await field', (response) => { response.await.extra = true; }, /cancelled_await_field_unsupported:extra/],
    ['wrong public Await version', (response) => { response.await.v = 'hark.await.v1'; }, /cancelled_await_version_invalid/],
    ['wrong Await identity', (response) => { response.await.id = 'other-await'; }, /cancel_result_state_mismatch/],
    ['wrong preparation nonce', (response) => { response.await.preparationNonce = 'other'; }, /cancelled_await_preparation_nonce_mismatch/],
    ['wrong origin', (response) => { response.await.origin.taskId = 'other'; }, /cancelled_await_origin_mismatch/],
    ['wrong checkpoint', (response) => { response.await.checkpoint.digest = '9'.repeat(64); }, /cancelled_await_checkpoint_mismatch/],
    ['wrong binding', (response) => { response.await.binding.toolUseId = 'other'; }, /cancelled_await_binding_mismatch/],
    ['wrong prepared payload', (response) => { response.await.prepared.name = 'other'; }, /cancelled_await_prepared_mismatch/],
    ['wrong predicate', (response) => { response.await.predicate.subject = 'other'; }, /cancelled_await_predicate_mismatch/],
    ['wrong wake policy', (response) => { response.await.wakePolicy = 'other'; }, /cancelled_await_wake_policy_mismatch/],
    ['wrong cancellation reason', (response) => { response.await.lastError = 'other'; }, /cancelled_await_last_error_mismatch/],
    ['malformed waiter', (response) => { response.await.waiter.leaseGeneration = 0; }, /cancelled_await_waiter_generation_invalid/],
    ['wrong Await state', (response) => { response.await.state = 'armed'; }, /cancel_result_state_mismatch/],
    ['missing cancellation timestamp', (response) => { response.await.cancelledAt = null; }, /cancelled_await_cancelledAt_invalid/],
    ['invalid cancellation timestamp', (response) => { response.await.cancelledAt = '2026-08-07T12:00:01Z'; }, /cancelled_await_cancelledAt_invalid/],
    ['cancellation before creation', (response) => {
      response.await.createdAt = '2026-08-07T12:00:02.000Z';
    }, /cancelled_await_lifecycle_order_invalid/],
    ['updated timestamp differs from cancellation', (response) => {
      response.await.updatedAt = '2026-08-07T12:00:02.000Z';
    }, /cancelled_await_updated_at_mismatch/],
    ['waiter release differs from cancellation', (response) => {
      response.await.waiter.releasedAt = '2026-08-07T12:00:02.000Z';
    }, /cancelled_await_waiter_release_mismatch/],
    ['committed lifecycle timestamp present', (response) => {
      response.await.suspendedAt = '2026-08-07T12:00:00.500Z';
    }, /cancelled_await_lifecycle_conflict/],
    ['nonboolean replay', (response) => { response.replay = 'false'; }, /cancel_result_replay_invalid/],
  ];
  for (const [name, mutate, expected] of cases) {
    await context.test(name, () => {
      const response = cancelResponse(value.armRequest);
      mutate(response);
      assert.throws(
        () => assertReconciledCancelApiResponse(response, cancelExpectation(value)),
        expected,
      );
    });
  }
});

test('deterministic pre-arm failure releases only after exact host error observation', async () => {
  const value = await fixture();
  const toolError = (await value.protocol.publishToolError(value.request, {
    failureCode: 'pre_arm_failed',
    errorDigest: 'e'.repeat(64),
  }, CLOCK)).toolError;
  const lifecycle = new HarkToolErrorLifecycle({ protocol: value.protocol });
  assert.deepEqual(await lifecycle.reconcile(value.request), {
    kind: 'owned',
    reason: 'host_error_observation_pending',
  });
  await value.protocol.publishToolErrorObservation(value.request, toolError, {
    responseDigest: 'f'.repeat(64),
  }, CLOCK);
  const released = await lifecycle.reconcile(value.request);
  assert.equal(released.kind, 'released');
  assert.equal(released.reason, 'deterministic_pre_arm_failure');
  assert.deepEqual(await value.protocol.listAwaitRequests(), []);
});

test('a deterministic pre-arm terminal archives without relying on startup inventory mutation', async () => {
  const value = await fixture();
  const terminal = (await value.protocol.publishAwaitRequestTerminal(value.request, {
    awaitId: null,
    wakeId: null,
    disposition: 'pre_arm_failed',
    terminalDigest: 'd'.repeat(64),
  }, CLOCK)).awaitRequestTerminal;
  assert.deepEqual(
    await new HarkToolErrorLifecycle({ protocol: value.protocol }).reconcile(value.request),
    {
      kind: 'released',
      reason: 'already_terminal',
      terminal,
    },
  );
  assert.deepEqual(await value.protocol.listAwaitRequests(), []);
});

test('ambiguous arm stays owned until exact replay and authoritative cancel', async () => {
  const value = await fixture();
  const attempt = await publishAttempt(value);
  await publishFailure(value.protocol, value.request, 'arm_outcome_ambiguous');
  let armCalls = 0;
  const calls = [];
  const service = {
    async armAwait(body) {
      calls.push(['arm', structuredClone(body)]);
      armCalls += 1;
      if (armCalls === 1) throw Object.assign(new Error('unavailable'), { status: 503 });
      return armApiResponse(value.armRequest, { replay: true });
    },
    async cancelAwait(awaitId, body) {
      calls.push(['cancel', awaitId, structuredClone(body)]);
      return cancelResponse(value.armRequest);
    },
  };
  const lifecycle = new HarkToolErrorLifecycle({
    ...lifecycleOptions(value.protocol, service),
  });
  const pending = await lifecycle.reconcile(value.request);
  assert.equal(pending.kind, 'owned');
  assert.equal(pending.reason, 'arm_reconciliation_pending');
  assert.equal(await value.protocol.readArmBinding(value.request), null);
  assert.equal(await value.protocol.readAwaitRequestTerminal(value.request), null);

  const released = await lifecycle.reconcile(value.request);
  assert.equal(released.kind, 'released');
  assert.deepEqual(calls[0][1], attempt.armRequest);
  assert.deepEqual(calls[1][1], attempt.armRequest);
  assert.equal(calls.filter(([kind]) => kind === 'cancel').length, 1);
  assert.equal((await value.protocol.readAwaitRequestTerminal(value.request)).disposition, 'remote_cancelled');

  const replay = await lifecycle.reconcile(value.request);
  assert.equal(replay.reason, 'already_terminal');
  assert.equal(calls.filter(([kind]) => kind === 'cancel').length, 1);
});

test('post-arm replay state never authorizes a local bind or cancellation', async (t) => {
  for (const state of ['suspended', 'wake_pending']) {
    await t.test(state, async () => {
      const value = await fixture();
      await publishAttempt(value);
      await publishFailure(value.protocol, value.request, 'arm_outcome_ambiguous');
      let armCalls = 0;
      let cancelCalls = 0;
      const service = {
        async armAwait() {
          armCalls += 1;
          return armApiResponse(value.armRequest, {
            replay: true,
            state,
            releasedAt: '2026-08-07T12:00:05.000Z',
          });
        },
        async cancelAwait() {
          cancelCalls += 1;
          return cancelResponse(value.armRequest);
        },
      };
      const lifecycle = new HarkToolErrorLifecycle({
        ...lifecycleOptions(value.protocol, service),
      });

      const first = await lifecycle.reconcile(value.request);
      assert.equal(first.kind, 'owned');
      assert.equal(first.reason, 'remote_post_arm_state_without_commit_attempt');
      assert.equal(first.remoteState, state);
      assert.equal(first.armReconciliationFreeze.remoteState, state);
      const second = await new HarkToolErrorLifecycle({
        ...lifecycleOptions(new HarkToolWaitProtocol(value.protocol.dataDir), service),
      }).reconcile(value.request);
      assert.equal(second.kind, 'owned');
      assert.equal(second.armReconciliationFreeze.remoteState, state);
      assert.equal(await value.protocol.readArmBinding(value.request), null);
      assert.equal(await value.protocol.readAwaitRequestTerminal(value.request), null);
      assert.equal(armCalls, 1);
      assert.equal(cancelCalls, 0);
    });
  }
});

test('altered local arm closure blocks tool-error cancellation before the API', async (t) => {
  for (const variant of ['arm-binding', 'transcript-boundary']) {
    await t.test(variant, async () => {
      const value = await fixture();
      const attempt = await publishAttempt(value);
      const arm = (await value.protocol.publishArmBinding(value.request, {
        awaitId: 'await-1',
        preparationNonce: variant === 'arm-binding'
          ? `hkp_${'z'.repeat(32)}`
          : attempt.preparationNonce,
        checkpointDigest: attempt.checkpointDigest,
        bindingToken: attempt.bindingToken,
      }, CLOCK)).armBinding;
      if (variant === 'transcript-boundary') {
        await value.protocol.publishTranscriptBoundary(
          value.request,
          arm,
          { ...attempt.transcriptBoundary, prefixSha256: '9'.repeat(64) },
          CLOCK,
        );
      }
      await publishFailure(value.protocol, value.request, 'armed_precommit_failed');
      let cancelCalls = 0;
      const lifecycle = new HarkToolErrorLifecycle({
        ...lifecycleOptions(value.protocol, {
          async cancelAwait() {
            cancelCalls += 1;
            return cancelResponse(value.armRequest);
          },
        }),
      });
      await assert.rejects(
        lifecycle.reconcile(value.request),
        variant === 'arm-binding'
          ? /held_call_reconciliation_arm_attempt_binding_mismatch/
          : /held_call_reconciliation_arm_attempt_boundary_mismatch/,
      );
      assert.equal(cancelCalls, 0);
    });
  }
});

test('confirmed arm and precommit error does not release before cancel acknowledgement', async () => {
  const value = await fixture();
  const attempt = await publishAttempt(value);
  await publishArm(value, attempt);
  await publishFailure(value.protocol, value.request, 'armed_precommit_failed');
  let cancelCalls = 0;
  const lifecycle = new HarkToolErrorLifecycle({
    ...lifecycleOptions(value.protocol, {
      async cancelAwait() {
        cancelCalls += 1;
        if (cancelCalls === 1) throw Object.assign(new Error('unavailable'), { status: 503 });
        return cancelResponse(value.armRequest, true);
      },
    }),
  });
  assert.equal((await lifecycle.reconcile(value.request)).reason, 'authoritative_cancel_pending');
  assert.equal(await value.protocol.readAwaitRequestTerminal(value.request), null);
  assert.equal((await lifecycle.reconcile(value.request)).kind, 'released');
  assert.equal(cancelCalls, 2);
});

test('ambiguous commit replays exact commit once and remains owned after confirmed suspension', async () => {
  const value = await fixture();
  const attempt = await publishAttempt(value);
  const arm = await publishArm(value, attempt);
  const ready = (await value.protocol.publishWaiterReady(
    value.request,
    arm,
    INPUT,
    CLOCK,
  )).waiterReady;
  const commitRequest = {
    v: 'hark.suspension-commit.v2',
    commitNonce: `hkc_${'q'.repeat(32)}`,
    checkpointDigest: arm.checkpointDigest,
  };
  await value.protocol.publishCommitAttempt(
    value.request,
    arm,
    ready,
    commitRequest,
    CLOCK,
  );
  await publishFailure(value.protocol, value.request, 'commit_outcome_ambiguous');
  const calls = [];
  const lifecycle = new HarkToolErrorLifecycle({
    ...lifecycleOptions(value.protocol, {
      async commitAwait(awaitId, body) {
        calls.push([awaitId, structuredClone(body)]);
        return commitApiResponse({
          armRequest: value.armRequest,
          commitRequest: body,
          awaitId,
          replay: true,
        });
      },
      async cancelAwait() {
        throw new Error('cancel_must_not_run_after_commit_attempt');
      },
    }),
  });
  const disposition = await lifecycle.reconcile(value.request);
  assert.equal(disposition.kind, 'owned');
  assert.equal(disposition.reason, 'suspension_committed_recovery_required');
  assert.deepEqual(calls, [['await-1', commitRequest]]);
  assert.ok(await value.protocol.readSuspensionCommitted(value.request, arm, ready));
  assert.equal(await value.protocol.readAwaitRequestTerminal(value.request), null);
});

test('postcommit error remains owned and never invokes cancellation', async () => {
  const value = await fixture();
  const attempt = await publishAttempt(value);
  const arm = await publishArm(value, attempt);
  const ready = (await value.protocol.publishWaiterReady(
    value.request,
    arm,
    INPUT,
    CLOCK,
  )).waiterReady;
  const commitRequest = {
    v: 'hark.suspension-commit.v2',
    commitNonce: `hkc_${'q'.repeat(32)}`,
    checkpointDigest: arm.checkpointDigest,
  };
  await value.protocol.publishCommitAttempt(value.request, arm, ready, commitRequest, CLOCK);
  await value.protocol.publishSuspensionCommitted(value.request, arm, ready, {
    suspensionReceiptId: 'suspension-receipt-1',
    suspensionReceiptDigest: 'd'.repeat(64),
  }, CLOCK);
  await publishFailure(value.protocol, value.request, 'postcommit_failed');
  let cancelled = false;
  const lifecycle = new HarkToolErrorLifecycle({
    ...lifecycleOptions(value.protocol, { async cancelAwait() { cancelled = true; } }),
  });
  const disposition = await lifecycle.reconcile(value.request);
  assert.equal(disposition.kind, 'owned');
  assert.equal(disposition.reason, 'suspension_committed_recovery_required');
  assert.equal(cancelled, false);
  assert.equal((await value.protocol.listAwaitRequests()).length, 1);
});
