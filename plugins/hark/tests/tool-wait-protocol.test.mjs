import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import test from 'node:test';

import { canonicalJson, sha256Canonical } from '../lib/canonical.mjs';
import { HeldCallCrashReconciler as RawHeldCallCrashReconciler } from '../lib/held-call-crash-reconciler.mjs';
import { HarkToolErrorLifecycle as RawHarkToolErrorLifecycle } from '../lib/tool-error-lifecycle.mjs';
import {
  createPrivateClaimBinding,
  HarkPrivateClaimStore,
} from '../lib/private-claim-store.mjs';
import {
  assertAdmissionLocatorInput,
  assertArmAttempt,
  assertArmAttemptInstallationFence,
  assertAwaitRequest,
  assertHeldCallTransitionAuthority,
  assertInstallationIdentityFence,
  assertToolResultReturned,
  assertToolWaitResult,
  abortableDelay,
  createAdmissionLocatorInput,
  createArmAttempt,
  createArmBinding,
  createAwaitAdmission,
  createAwaitRequest,
  createAwaitRequestTerminal,
  createCompletionPosted,
  createHeldCallOriginAbortReceipt,
  createHeldCallTransitionAuthority,
  createTranscriptBoundary,
  createSuspensionCommitted,
  createToolResultObservationIntent,
  createToolResultReturned,
  createToolWaitResult,
  createWaiterReady,
  createWakeDelivery,
  HarkToolWaitProtocol,
  materializeToolResultObservationReceipt,
  sanitizeWakeEnvelope,
  TOOL_WAIT_ARM_ATTEMPT_LEGACY_VERSION,
} from '../lib/tool-wait-protocol.mjs';
import {
  armApiResponse,
  commitApiResponse,
} from './api-response-fixtures.mjs';

const CLOCK = () => new Date('2026-08-07T12:00:00.000Z');
const LATER = () => new Date('2026-08-07T12:00:01.000Z');
const WAKE_DELIVERY_DIGEST = '3'.repeat(64);
const TEST_INSTALLATION = Object.freeze({
  id: 'installation-1',
  protocol: 'codex',
  runtimeId: 'runtime-1',
});
const TEST_CREDENTIALS = Object.freeze({ installation: TEST_INSTALLATION });

function installationFencedService(service) {
  if (!service) return service;
  return new Proxy(service, {
    get(target, property) {
      if (property === 'getInstallationStatus') {
        return async () => ({
          v: 'hark.installation-status.v2',
          installation: TEST_INSTALLATION,
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

class HeldCallCrashReconciler extends RawHeldCallCrashReconciler {
  constructor(options = {}) {
    super({
      ...options,
      credentials: options.credentials ?? TEST_CREDENTIALS,
      serviceClient: installationFencedService(options.serviceClient),
    });
  }
}

class HarkToolErrorLifecycle extends RawHarkToolErrorLifecycle {
  constructor(options = {}) {
    super({
      ...options,
      credentials: options.credentials ?? TEST_CREDENTIALS,
      serviceClient: installationFencedService(options.serviceClient),
    });
  }
}

const ORIGINAL_INPUT = {
  request: '  Continue after job 42.  ',
  name: '  Job 42  ',
  source: { kind: ' job.completed ', adapter: ' webhook.v1 ', subject: ' job-42 ' },
  condition: { status: { equals: 'completed' } },
};

function transcriptBoundary() {
  return {
    v: 'hark.codex-tool-wait-boundary.v1',
    historySource: 'codex.rollout-jsonl.v1',
    transcriptPath: '/private/codex/session-1.jsonl',
    conversationId: 'session-1',
    originTaskId: 'turn-1',
    toolUseId: 'call-1',
    toolName: 'mcp__hark__hark_await',
    toolCallDigest: '1'.repeat(64),
    inputDigest: sha256Canonical({
      request: 'Continue after job 42.',
      name: 'Job 42',
      source: { kind: 'job.completed', adapter: 'webhook.v1', subject: 'job-42' },
      condition: { status: { equals: 'completed' } },
    }),
    cliVersion: '0.147.0',
    dev: '2049',
    ino: '4097',
    byteLength: 1024,
    prefixSha256: '2'.repeat(64),
  };
}

function random(fill) {
  return (size) => Buffer.alloc(size, fill);
}

function requestInput(originalInput = ORIGINAL_INPUT) {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolUseId: 'call-1',
    toolName: 'mcp__hark__hark_await',
    transcriptPath: '/private/codex/session-1.jsonl',
    originalInput,
  };
}

function rawWake(overrides = {}) {
  return {
    v: 'hark.wake.v2',
    wakeId: 'wake-1',
    idempotencyKey: 'wake-idem-1',
    awaitId: 'await-1',
    origin: { protocol: 'codex', runtimeId: 'runtime-1' },
    checkpoint: { version: 'hark.codex-checkpoint.v1', digest: 'c'.repeat(64) },
    prepared: { request: 'Continue after job 42.' },
    signal: {
      id: 'signal-1',
      sourceSignalId: 'provider-1',
      type: 'job.completed',
      subject: 'job-42',
      qualificationDigest: 'q'.replace('q', 'a').repeat(64),
      observedAt: '2026-08-07T12:00:04.000Z',
      summary: 'Job completed.',
      data: { status: 'completed', output: { artifactId: 'artifact-1' } },
      evidence: [{ kind: 'provider-event', digest: 'e'.repeat(64) }],
    },
    createdAt: '2026-08-07T12:00:04.000Z',
    ...overrides,
  };
}

function cancelApiResponse({
  awaitId,
  armRequest,
  cancelRequest,
  replay = false,
}) {
  const cancelledAt = '2026-08-07T12:00:05.000Z';
  const armed = armApiResponse(armRequest, { awaitId }).await;
  return {
    v: 'hark.await-cancel-result.v2',
    await: {
      ...armed,
      waiter: {
        ...armed.waiter,
        releasedAt: cancelledAt,
      },
      state: 'cancelled',
      suspendedAt: null,
      wakePendingAt: null,
      acceptedAt: null,
      runningAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt,
      lastError: cancelRequest.reason,
      updatedAt: cancelledAt,
    },
    replay,
  };
}

function recoveryRecords() {
  const request = createAwaitRequest(requestInput(), CLOCK);
  const armBinding = createArmBinding(request, {
    awaitId: 'await-1',
    preparationNonce: `hkp_${'p'.repeat(32)}`,
    checkpointDigest: 'c'.repeat(64),
  }, CLOCK, random(0x22));
  const persistedTranscriptBoundary = createTranscriptBoundary(
    request,
    armBinding,
    transcriptBoundary(),
    CLOCK,
  );
  const waiterReady = createWaiterReady(request, armBinding, ORIGINAL_INPUT, LATER);
  const suspensionCommitted = createSuspensionCommitted(
    request,
    armBinding,
    waiterReady,
    {
      suspensionReceiptId: 'hrr_monitoring_task_suspended_await-1',
      suspensionReceiptDigest: 'd'.repeat(64),
    },
    () => new Date('2026-08-07T12:00:02.000Z'),
  );
  const wakeDelivery = createWakeDelivery(
    request,
    armBinding,
    suspensionCommitted,
    rawWake(),
    WAKE_DELIVERY_DIGEST,
    () => new Date('2026-08-07T12:00:05.000Z'),
  );
  const toolResult = createToolWaitResult(wakeDelivery);
  const toolResultReturned = createToolResultReturned(
    wakeDelivery,
    toolResult,
    {
      wakeDeliveryDigest: WAKE_DELIVERY_DIGEST,
      transcriptBoundary: transcriptBoundary(),
    },
    () => new Date('2026-08-07T12:00:06.000Z'),
  );
  const completionPosted = createCompletionPosted(toolResultReturned, {
    sourceReceiptId: 'hrr_task_completed_wake-1',
    proofDigest: '4'.repeat(64),
    certificationDigest: '5'.repeat(64),
  }, () => new Date('2026-08-07T12:00:07.000Z'));
  return {
    request,
    armBinding,
    persistedTranscriptBoundary,
    waiterReady,
    suspensionCommitted,
    wakeDelivery,
    toolResult,
    toolResultReturned,
    completionPosted,
  };
}

async function crashReconciliationFixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-reconcile-'));
  const protocol = new HarkToolWaitProtocol(dataDir);
  const request = (await protocol.publishAwaitRequest(requestInput(), CLOCK)).request;
  const normalizedInput = request.originalInput;
  const prepared = {
    v: 'hark.await-prepared.v1',
    preparationNonce: `hkp_${'p'.repeat(32)}`,
    qualificationDigest: sha256Canonical({
      source: normalizedInput.source,
      condition: normalizedInput.condition,
    }),
    wakePolicy: 'resume',
    ...normalizedInput,
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
    checkpoint: { version: 'hark.codex-checkpoint.v1', digest: 'c'.repeat(64) },
    prepared,
    predicate: {
      kind: 'exact_signal',
      type: prepared.source.kind,
      subject: prepared.source.subject,
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
  const attempt = (await protocol.publishArmAttempt(request, {
    installationId: 'installation-1',
    armRequest,
    transcriptBoundary: transcriptBoundary(),
  }, CLOCK, random(0x44))).armAttempt;
  const abortProof = {
    v: 'hark.codex-owner-abort-proof.v1',
    appServer: {
      v: 'hark.codex-app-server-origin-terminal.v1',
      conversationId: request.sessionId,
      originTaskId: request.turnId,
      turnStatus: 'interrupted',
      observedAt: '2026-08-07T12:00:03.000Z',
    },
    rollout: {
      v: 'hark.codex-wait-preflight.v1',
      historySource: 'codex.rollout-jsonl.v1',
      conversationId: request.sessionId,
      originTaskId: request.turnId,
      originTerminal: {
        type: 'turn_aborted',
        observedAt: '2026-08-07T12:00:02.000Z',
      },
      interveningTaskIds: [],
      rollbackMarkerCount: 0,
      historyMutationCount: 0,
      scannedAt: '2026-08-07T12:00:03.000Z',
      historyDigest: '7'.repeat(64),
    },
  };
  const receipt = createHeldCallOriginAbortReceipt(
    request,
    attempt,
    abortProof,
    () => new Date('2026-08-07T12:00:04.000Z'),
  );
  await protocol.appendHeldCallOriginAbortReceipt(receipt, request, attempt);
  const calls = { arm: 0, cancel: 0, cancelApply: 0, commit: 0, commitApply: 0 };
  const service = {
    async armAwait() {
      calls.arm += 1;
      return armApiResponse(armRequest, { replay: calls.arm > 1 });
    },
    async cancelAwait(awaitId, cancelRequest) {
      calls.cancel += 1;
      if (calls.cancel === 1) calls.cancelApply += 1;
      return cancelApiResponse({
        awaitId,
        armRequest,
        cancelRequest,
        replay: calls.cancel > 1,
      });
    },
    async commitAwait(awaitId, commitRequest) {
      calls.commit += 1;
      if (calls.commit === 1) calls.commitApply += 1;
      return commitApiResponse({
        armRequest,
        commitRequest,
        awaitId,
        replay: calls.commit > 1,
      });
    },
  };
  return {
    dataDir,
    protocol,
    request,
    armRequest,
    attempt,
    receipt,
    service,
    calls,
  };
}

function cancelTransitionRequest(request) {
  return {
    v: 'hark.await-cancel.v2',
    requestId: `hkc_tool_error_${request.eventId.slice(4)}`,
    reason: 'codex_held_tool_failed_before_suspension',
  };
}

async function commitTransitionInput(value, nonce = 'q') {
  const armBinding = (await value.protocol.publishArmBinding(value.request, {
    awaitId: 'await-1',
    preparationNonce: value.attempt.preparationNonce,
    checkpointDigest: value.attempt.checkpointDigest,
    bindingToken: value.attempt.bindingToken,
  }, CLOCK)).armBinding;
  const waiterReady = (await value.protocol.publishWaiterReady(
    value.request,
    armBinding,
    value.request.originalInput,
    CLOCK,
  )).waiterReady;
  return {
    decision: 'commit',
    decisionRequest: {
      v: 'hark.suspension-commit.v2',
      commitNonce: `hkc_${nonce.repeat(32)}`,
      checkpointDigest: value.attempt.checkpointDigest,
    },
    evidenceKind: 'waiter_ready',
    armBinding,
    waiterReady,
  };
}

test('arm-attempt v2 durably binds installation identity and legacy v1 remains inventory-only', async () => {
  const value = await crashReconciliationFixture();
  assert.equal(value.attempt.v, 'hark.tool-wait.arm-attempt.v2');
  assert.equal(value.attempt.installationId, 'installation-1');
  assert.deepEqual(assertArmAttemptInstallationFence(
    value.request,
    value.attempt,
    { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
    { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
  ), { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' });
  assert.deepEqual(assertInstallationIdentityFence(
    { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
    { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
    { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
    value.attempt.armRequest.origin,
  ), { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' });
  for (const [credentials, authenticated] of [
    [
      { id: 'installation-2', protocol: 'codex', runtimeId: 'runtime-1' },
      { id: 'installation-2', protocol: 'codex', runtimeId: 'runtime-1' },
    ],
    [
      { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-2' },
      { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-2' },
    ],
    [
      { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
      { id: 'installation-2', protocol: 'codex', runtimeId: 'runtime-1' },
    ],
  ]) {
    assert.throws(() => assertArmAttemptInstallationFence(
      value.request,
      value.attempt,
      credentials,
      authenticated,
    ), /installation_identity_fence_mismatch/);
  }
  const rebound = createArmAttempt(value.request, {
    installationId: 'installation-2',
    armRequest: value.attempt.armRequest,
    transcriptBoundary: value.attempt.transcriptBoundary,
    bindingToken: value.attempt.bindingToken,
  }, CLOCK, random(0x44));
  assert.notEqual(sha256Canonical(rebound), sha256Canonical(value.attempt));

  const legacyDataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-legacy-'));
  const legacyProtocol = new HarkToolWaitProtocol(legacyDataDir);
  await legacyProtocol.appendAwaitRequest(value.request);
  await legacyProtocol.ensureDirectories();
  const legacyAttempt = structuredClone(value.attempt);
  legacyAttempt.v = TOOL_WAIT_ARM_ATTEMPT_LEGACY_VERSION;
  delete legacyAttempt.installationId;
  await writeFile(
    path.join(legacyProtocol.armAttemptDirectory, `${value.request.eventId}.json`),
    `${canonicalJson(legacyAttempt)}\n`,
    { mode: 0o600 },
  );
  const terminal = createAwaitRequestTerminal(value.request, {
    awaitId: 'await-legacy',
    wakeId: null,
    disposition: 'remote_cancelled',
    terminalDigest: '8'.repeat(64),
  }, CLOCK);
  await legacyProtocol.appendAwaitRequestTerminal(terminal, value.request);

  const restarted = new HarkToolWaitProtocol(legacyDataDir);
  assert.deepEqual(await restarted.readArmAttempt(value.request), legacyAttempt);
  assert.deepEqual(await restarted.listAwaitRequests(), [value.request]);
  assert.deepEqual(
    await readdir(restarted.awaitRequestDirectory),
    [`${value.request.eventId}.json`],
  );
  assert.deepEqual(await readdir(restarted.awaitRequestArchiveDirectory), []);
  assert.throws(
    () => assertArmAttempt(legacyAttempt, value.request),
    /arm_attempt_installation_binding_required/,
  );
  assert.throws(
    () => createHeldCallTransitionAuthority(
      value.request,
      legacyAttempt,
      {
        decision: 'cancel',
        decisionRequest: cancelTransitionRequest(value.request),
        evidenceKind: 'origin_abort',
        originAbortReceipt: value.receipt,
      },
      CLOCK,
    ),
    /arm_attempt_installation_binding_required/,
  );
  assert.deepEqual(await readdir(restarted.heldCallTransitionAuthorityDirectory), []);
});

test('one O_EXCL transition authority permanently elects commit or cancel', async () => {
  const value = await crashReconciliationFixture();
  const commitInput = await commitTransitionInput(value);
  const cancelInput = {
    decision: 'cancel',
    decisionRequest: cancelTransitionRequest(value.request),
    evidenceKind: 'origin_abort',
    armBinding: commitInput.armBinding,
    originAbortReceipt: value.receipt,
  };
  const committed = await value.protocol.electHeldCallTransitionAuthority(
    value.request,
    value.attempt,
    commitInput,
    CLOCK,
  );
  assert.equal(committed.created, true);
  assert.equal(committed.transitionAuthority.decision, 'commit');
  assert.deepEqual(committed.transitionAuthority.decisionRequest, commitInput.decisionRequest);
  assertHeldCallTransitionAuthority(
    committed.transitionAuthority,
    value.request,
    value.attempt,
    commitInput,
  );

  const losingCancel = await new HarkToolWaitProtocol(value.dataDir)
    .electHeldCallTransitionAuthority(
      value.request,
      value.attempt,
      cancelInput,
      LATER,
    );
  assert.equal(losingCancel.created, false);
  assert.deepEqual(losingCancel.transitionAuthority, committed.transitionAuthority);
  const replay = await value.protocol.electHeldCallTransitionAuthority(
    value.request,
    value.attempt,
    commitInput,
    LATER,
  );
  assert.equal(replay.created, false);
  assert.deepEqual(replay.transitionAuthority, committed.transitionAuthority);
  await assert.rejects(
    value.protocol.electHeldCallTransitionAuthority(
      value.request,
      value.attempt,
      await commitTransitionInput(value, 'z'),
      LATER,
    ),
    /held_call_transition_authority_conflict/,
  );
  const raw = await readFile(path.join(
    value.protocol.heldCallTransitionAuthorityDirectory,
    `${value.request.eventId}.json`,
  ), 'utf8');
  assert.equal(raw.includes('installation-1'), true);
  for (const forbidden of ['accessToken', 'leaseToken', 'bindingToken']) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
});

test('cancel authorities require exact immutable tool-error or owner-abort evidence', async () => {
  const value = await crashReconciliationFixture();
  const { armBinding } = await commitTransitionInput(value);
  const toolError = (await value.protocol.publishToolError(value.request, {
    failureCode: 'arm_outcome_ambiguous',
    errorDigest: 'e'.repeat(64),
  }, CLOCK)).toolError;
  const observation = (await value.protocol.publishToolErrorObservation(
    value.request,
    toolError,
    { responseDigest: 'f'.repeat(64) },
    CLOCK,
  )).toolErrorObservation;
  const input = {
    decision: 'cancel',
    decisionRequest: cancelTransitionRequest(value.request),
    evidenceKind: 'tool_error_observation',
    armBinding,
    toolError,
    toolErrorObservation: observation,
  };
  const authority = createHeldCallTransitionAuthority(
    value.request,
    value.attempt,
    input,
    CLOCK,
  );
  assert.equal(authority.evidence.kind, 'tool_error_observation');
  assertHeldCallTransitionAuthority(authority, value.request, value.attempt, input);
  assert.throws(
    () => assertHeldCallTransitionAuthority(
      authority,
      value.request,
      value.attempt,
      { ...input, toolErrorObservation: { ...observation, responseDigest: '0'.repeat(64) } },
    ),
    /tool_error_observation_error_mismatch|held_call_transition_tool_error_evidence_mismatch/,
  );

  const ownerAbortAuthority = createHeldCallTransitionAuthority(
    value.request,
    value.attempt,
    {
      decision: 'cancel',
      decisionRequest: cancelTransitionRequest(value.request),
      evidenceKind: 'origin_abort',
      armBinding,
      originAbortReceipt: value.receipt,
    },
    CLOCK,
  );
  assert.equal(ownerAbortAuthority.evidence.kind, 'origin_abort');
  assertHeldCallTransitionAuthority(
    ownerAbortAuthority,
    value.request,
    value.attempt,
    { armBinding, originAbortReceipt: value.receipt },
  );
});

function withProtocolFailpoint(protocol, method, phase = 'after') {
  let failed = false;
  return new Proxy(protocol, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === method && typeof value === 'function') {
        return async (...args) => {
          if (!failed && phase === 'before') {
            failed = true;
            throw new Error(`fail_before_${String(method)}`);
          }
          const result = await value.apply(target, args);
          if (!failed && phase === 'after') {
            failed = true;
            throw new Error(`fail_after_${String(method)}`);
          }
          return result;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('PreToolUse publishes only an opaque private admission and MCP consumes it once', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-'));
  const protocol = new HarkToolWaitProtocol(dataDir);
  const published = await protocol.publishAdmission(requestInput(), CLOCK, random(0x11));

  assert.deepEqual(Object.keys(published.rewrittenInput._hark), ['admissionLocator']);
  assert.deepEqual(published.rewrittenInput, createAdmissionLocatorInput(published.admission));
  assertAdmissionLocatorInput(published.rewrittenInput);
  assert.equal(Object.hasOwn(published.rewrittenInput, 'sessionId'), false);
  assert.equal(Object.hasOwn(published.rewrittenInput, 'toolUseId'), false);
  assert.equal(published.admission.originalInput.request, 'Continue after job 42.');
  assert.equal(published.admission.originalInput.source.subject, 'job-42');

  const attempts = await Promise.allSettled(Array.from({ length: 16 }, () => (
    protocol.consumeAdmission(published.rewrittenInput)
  )));
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.deepEqual(fulfilled[0].value.originalInput, published.admission.originalInput);
  assert.equal(rejected.length, 15);
  rejected.forEach((attempt) => assert.match(attempt.reason.message, /tool_wait_admission_replayed/));

  assert.equal(await protocol.readAdmission(published.admission.locator), null);
  assert.deepEqual(
    await protocol.readConsumedAdmission(published.admission.locator),
    published.admission,
  );
  await assert.rejects(
    protocol.consumeAdmission(published.rewrittenInput),
    /tool_wait_admission_replayed/,
  );
  assert.equal((await stat(protocol.rootDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(protocol.admissionDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(protocol.consumedAdmissionDirectory)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(path.join(
      protocol.consumedAdmissionDirectory,
      `${published.admission.locator}.json`,
    ))).mode & 0o777,
    0o600,
  );
});

test('admission is strict, idempotent before consumption, and permanent after consumption', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-'));
  const protocol = new HarkToolWaitProtocol(dataDir);
  const admission = createAwaitAdmission(requestInput(), CLOCK, random(0x33));
  assert.equal((await protocol.appendAdmission(admission)).created, true);
  const replay = createAwaitAdmission(requestInput(), LATER, random(0x33));
  assert.equal((await protocol.appendAdmission(replay)).created, false);

  const changed = createAwaitAdmission({ ...requestInput(), turnId: 'turn-2' }, CLOCK, random(0x33));
  await assert.rejects(protocol.appendAdmission(changed), /await_admission_conflict/);
  assert.throws(() => createAwaitAdmission({
    ...requestInput(),
    toolName: 'mcp__other__hark_await',
  }, CLOCK, random(0x55)), /tool_wait_tool_name_invalid/);
  await assert.rejects(
    protocol.consumeAdmission({
      ...createAdmissionLocatorInput(admission),
      extra: true,
    }),
    /admission_input_field_unsupported:extra/,
  );
  await protocol.consumeAdmission(createAdmissionLocatorInput(admission));
  await assert.rejects(protocol.appendAdmission(admission), /tool_wait_admission_replayed/);

  const missing = createAwaitAdmission(requestInput(), CLOCK, random(0x44));
  await assert.rejects(
    protocol.consumeAdmission(createAdmissionLocatorInput(missing)),
    /tool_wait_admission_missing/,
  );

  const tamperProof = await protocol.publishAdmission(requestInput(), CLOCK, random(0x66));
  await assert.rejects(protocol.consumeAdmission({
    ...tamperProof.rewrittenInput,
    request: 'Continue after a different job.',
  }), /tool_wait_admission_input_mismatch/);
  assert.deepEqual(
    (await protocol.consumeAdmission(tamperProof.rewrittenInput)).originalInput,
    tamperProof.admission.originalInput,
  );
});

test('recovery protocol binds every immutable record and exact result digest', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-'));
  const protocols = Array.from({ length: 12 }, () => new HarkToolWaitProtocol(dataDir));
  const records = recoveryRecords();

  const requestWrites = await Promise.all(protocols.map((protocol) => (
    protocol.appendAwaitRequest(records.request)
  )));
  assert.equal(requestWrites.filter((result) => result.created).length, 1);
  assert.equal((await protocols[0].appendArmBinding(records.armBinding, records.request)).created, true);
  assert.equal((await protocols[0].appendTranscriptBoundary(
    records.persistedTranscriptBoundary,
    records.request,
    records.armBinding,
  )).created, true);
  assert.equal((await protocols[0].appendWaiterReady(
    records.waiterReady,
    records.request,
    records.armBinding,
  )).created, true);
  assert.equal((await protocols[0].appendSuspensionCommitted(
    records.suspensionCommitted,
    records.request,
    records.armBinding,
    records.waiterReady,
  )).created, true);
  assert.equal((await protocols[0].appendWakeDelivery(
    records.wakeDelivery,
    records.request,
    records.armBinding,
    records.suspensionCommitted,
  )).created, true);
  assert.equal((await protocols[0].appendToolResultReturned(
    records.toolResultReturned,
    records.wakeDelivery,
    records.toolResult,
  )).created, true);
  assert.equal((await protocols[0].appendCompletionPosted(
    records.completionPosted,
    records.toolResultReturned,
  )).created, true);

  assert.deepEqual(
    await protocols[0].waitForArmBinding(records.request, { timeoutMs: 0 }),
    records.armBinding,
  );
  assert.deepEqual(
    await protocols[0].readTranscriptBoundary(records.request, records.armBinding),
    records.persistedTranscriptBoundary,
  );
  assert.deepEqual(
    await protocols[0].waitForWaiterReady(
      records.request,
      records.armBinding,
      { timeoutMs: 0 },
    ),
    records.waiterReady,
  );
  assert.deepEqual(
    await protocols[0].waitForSuspensionCommitted(
      records.request,
      records.armBinding,
      records.waiterReady,
      { timeoutMs: 0 },
    ),
    records.suspensionCommitted,
  );
  assert.deepEqual(
    await protocols[0].waitForWakeDelivery(
      records.request,
      records.armBinding,
      records.suspensionCommitted,
      { timeoutMs: 0 },
    ),
    records.wakeDelivery,
  );
  assert.deepEqual(
    await protocols[0].waitForToolResultReturned(
      records.wakeDelivery,
      records.toolResult,
      { timeoutMs: 0 },
    ),
    records.toolResultReturned,
  );
  assert.deepEqual(
    await protocols[0].readCompletionPosted(records.toolResultReturned),
    records.completionPosted,
  );
  assert.equal(records.toolResultReturned.resultDigest, sha256Canonical(records.toolResult));
  assert.equal(records.wakeDelivery.wakeDeliveryDigest, WAKE_DELIVERY_DIGEST);
  assert.equal(records.toolResultReturned.wakeDeliveryDigest, WAKE_DELIVERY_DIGEST);
  assert.equal(JSON.stringify(records.toolResult).includes('wakeDeliveryDigest'), false);
  assert.deepEqual(records.toolResultReturned.transcriptBoundary, transcriptBoundary());
  assert.equal(Object.hasOwn(records.toolResultReturned, 'result'), false);
  assert.deepEqual(await protocols[0].listAwaitRequests(), []);
  assert.deepEqual(await protocols[0].readAwaitRequest(records.request.eventId), records.request);
  assert.equal((await readdir(protocols[0].awaitRequestArchiveDirectory)).length, 1);
  assert.equal(
    (await protocols[0].readAwaitRequestTerminal(records.request)).disposition,
    'completion_posted',
  );

  const raw = await readFile(path.join(
    protocols[0].wakeDeliveryDirectory,
    `${records.request.eventId}.json`,
  ), 'utf8');
  assert.equal(raw, `${canonicalJson(records.wakeDelivery)}\n`);
  for (const directory of Object.values({
    a: protocols[0].awaitRequestDirectory,
    b: protocols[0].armBindingDirectory,
    c: protocols[0].transcriptBoundaryDirectory,
    d: protocols[0].waiterReadyDirectory,
    e: protocols[0].suspensionCommittedDirectory,
    f: protocols[0].wakeDeliveryDirectory,
    g: protocols[0].toolResultReturnedDirectory,
    h: protocols[0].completionPostedDirectory,
  })) assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(
    protocols[0].wakeDeliveryDirectory,
    `${records.request.eventId}.json`,
  ))).mode & 0o777, 0o600);
});

test('owner-abort reconciliation records are exact, secret-free, and replay-idempotent', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-abort-'));
  const protocol = new HarkToolWaitProtocol(dataDir);
  const request = (await protocol.appendAwaitRequest(
    createAwaitRequest(requestInput(), CLOCK),
  )).request;
  const prepared = {
    v: 'hark.await-prepared.v1',
    preparationNonce: `hkp_${'p'.repeat(32)}`,
    qualificationDigest: sha256Canonical({
      source: {
        kind: 'job.completed',
        adapter: 'webhook.v1',
        subject: 'job-42',
      },
      condition: { status: { equals: 'completed' } },
    }),
    wakePolicy: 'resume',
    request: 'Continue after job 42.',
    name: 'Job 42',
    source: { kind: 'job.completed', adapter: 'webhook.v1', subject: 'job-42' },
    condition: { status: { equals: 'completed' } },
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
    checkpoint: { version: 'hark.codex-checkpoint.v1', digest: 'c'.repeat(64) },
    prepared,
    predicate: {
      kind: 'exact_signal',
      type: prepared.source.kind,
      subject: prepared.source.subject,
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
  const attempt = createArmAttempt(request, {
    installationId: 'installation-1',
    armRequest,
    transcriptBoundary: transcriptBoundary(),
  }, CLOCK, random(0x44));
  await protocol.appendArmAttempt(attempt, request);
  const abortProof = {
    v: 'hark.codex-owner-abort-proof.v1',
    appServer: {
      v: 'hark.codex-app-server-origin-terminal.v1',
      conversationId: request.sessionId,
      originTaskId: request.turnId,
      turnStatus: 'interrupted',
      observedAt: '2026-08-07T12:00:03.000Z',
    },
    rollout: {
      v: 'hark.codex-wait-preflight.v1',
      historySource: 'codex.rollout-jsonl.v1',
      conversationId: request.sessionId,
      originTaskId: request.turnId,
      originTerminal: {
        type: 'turn_aborted',
        observedAt: '2026-08-07T12:00:02.000Z',
      },
      interveningTaskIds: [],
      rollbackMarkerCount: 0,
      historyMutationCount: 0,
      scannedAt: '2026-08-07T12:00:03.000Z',
      historyDigest: '7'.repeat(64),
    },
  };
  const receipt = createHeldCallOriginAbortReceipt(
    request,
    attempt,
    abortProof,
    () => new Date('2026-08-07T12:00:04.000Z'),
  );
  const competingReceipt = createHeldCallOriginAbortReceipt(
    request,
    attempt,
    {
      ...abortProof,
      appServer: {
        ...abortProof.appServer,
        observedAt: '2026-08-07T12:00:05.000Z',
      },
      rollout: {
        ...abortProof.rollout,
        scannedAt: '2026-08-07T12:00:05.000Z',
      },
    },
    () => new Date('2026-08-07T12:00:06.000Z'),
  );
  const writes = await Promise.all([
    protocol.appendHeldCallOriginAbortReceipt(receipt, request, attempt),
    new HarkToolWaitProtocol(dataDir).appendHeldCallOriginAbortReceipt(
      competingReceipt,
      request,
      attempt,
    ),
  ]);
  assert.equal(writes.filter(({ created }) => created).length, 1);
  assert.deepEqual(writes[0].originAbortReceipt, writes[1].originAbortReceipt);
  const originAbortReceipt = writes[0].originAbortReceipt;
  assert.ok(Date.parse(originAbortReceipt.appServerTerminalEvidence.observedAt)
    > Date.parse(originAbortReceipt.rolloutAbortProof.originTerminal.observedAt));
  assert.ok(Date.parse(originAbortReceipt.provenAt)
    >= Date.parse(originAbortReceipt.appServerTerminalEvidence.observedAt));
  assert.ok(Date.parse(originAbortReceipt.provenAt)
    >= Date.parse(originAbortReceipt.rolloutAbortProof.scannedAt));
  const intent = (await protocol.publishHeldCallReconciliationIntent(
    request,
    attempt,
    originAbortReceipt,
    {
      stage: 'arm',
      armBinding: null,
      waiterReady: null,
      commitAttempt: null,
      remoteRequestDigest: attempt.armRequestDigest,
    },
    CLOCK,
  )).reconciliationIntent;
  const armBinding = (await protocol.publishArmBinding(request, {
    awaitId: 'await-1',
    preparationNonce: attempt.preparationNonce,
    checkpointDigest: attempt.checkpointDigest,
    bindingToken: attempt.bindingToken,
  }, CLOCK)).armBinding;
  const boundary = (await protocol.publishTranscriptBoundary(
    request,
    armBinding,
    attempt.transcriptBoundary,
    CLOCK,
  )).transcriptBoundary;
  const waiterReady = (await protocol.publishWaiterReady(
    request,
    armBinding,
    request.originalInput,
    CLOCK,
  )).waiterReady;
  const terminal = (await protocol.publishAwaitRequestTerminal(request, {
    awaitId: armBinding.awaitId,
    wakeId: null,
    disposition: 'remote_cancelled',
    terminalDigest: '8'.repeat(64),
  }, CLOCK)).awaitRequestTerminal;
  const appliedInput = {
    apiResponses: [
      { method: 'arm', digest: '9'.repeat(64), replay: false },
      { method: 'cancel', digest: 'a'.repeat(64), replay: false },
    ],
    armBinding,
    transcriptBoundary: boundary,
    waiterReady,
    suspensionCommitted: null,
    terminal,
    outcome: 'remote_cancelled',
  };
  assert.equal((await protocol.publishHeldCallReconciliationApplied(
    request,
    intent,
    appliedInput,
    CLOCK,
  )).created, true);
  assert.equal((await protocol.publishHeldCallReconciliationApplied(
    request,
    intent,
    {
      ...appliedInput,
      apiResponses: appliedInput.apiResponses.map((response) => ({
        ...response,
        replay: true,
      })),
    },
    LATER,
  )).created, false);
  const persisted = JSON.stringify({
    receipt: await protocol.readHeldCallOriginAbortReceipt(request, attempt),
    intent: await protocol.readHeldCallReconciliationIntent(
      request,
      attempt,
      originAbortReceipt,
    ),
    applied: await protocol.readHeldCallReconciliationApplied(request, intent),
  });
  for (const forbidden of ['bindingToken', 'leaseToken', 'accessToken', 'authorization']) {
    assert.equal(persisted.includes(forbidden), false, forbidden);
  }
  assert.throws(() => createHeldCallOriginAbortReceipt(request, attempt, {
    ...abortProof,
    rollout: {
      ...abortProof.rollout,
      interveningTaskIds: ['another-turn'],
    },
  }, CLOCK), /held_call_origin_abort_rollout_not_exact/);
});

test('derived arm writes cannot publish recovery intent or authority before the exact election', async (t) => {
  for (const method of [
    'publishArmBinding',
    'publishTranscriptBoundary',
    'publishWaiterReady',
  ]) {
    await t.test(method, async () => {
      const value = await crashReconciliationFixture();
      const interrupted = new HeldCallCrashReconciler({
        protocol: withProtocolFailpoint(value.protocol, method),
        serviceClient: value.service,
        clock: LATER,
      });
      await assert.rejects(
        interrupted.reconcile(value.request),
        new RegExp(`fail_after_${method}`),
      );

      const freshProtocol = new HarkToolWaitProtocol(value.dataDir);
      const [pending] = await freshProtocol.listAwaitRequests();
      assert.deepEqual(pending, value.request);
      const persistedIntent = await freshProtocol.readHeldCallReconciliationIntent(
        value.request,
        value.attempt,
        value.receipt,
      );
      assert.equal(persistedIntent, null);
      const persistedBinding = await freshProtocol.readArmBinding(value.request);
      assert.ok(persistedBinding);
      assert.equal(
        await freshProtocol.readHeldCallTransitionAuthority(
          value.request,
          value.attempt,
          { armBinding: persistedBinding },
        ),
        null,
      );

      const repaired = await new HeldCallCrashReconciler({
        protocol: freshProtocol,
        serviceClient: value.service,
        clock: LATER,
      }).reconcile(value.request);
      assert.equal(repaired.kind, 'released');
      assert.equal(repaired.reconciliationApplied.outcome, 'remote_cancelled');
      const transitionAuthority = await freshProtocol.readHeldCallTransitionAuthority(
        value.request,
        value.attempt,
        { armBinding: persistedBinding },
      );
      assert.equal(transitionAuthority.decision, 'cancel');
      assert.equal(transitionAuthority.evidence.kind, 'origin_abort');
      assert.ok(await freshProtocol.readHeldCallReconciliationIntent(
        value.request,
        value.attempt,
        value.receipt,
      ));
      assert.deepEqual(
        repaired.reconciliationApplied.apiResponses.map(({ method: apiMethod }) => apiMethod),
        ['cancel'],
      );
      assert.deepEqual(value.calls, {
        arm: 1,
        cancel: 1,
        cancelApply: 1,
        commit: 0,
        commitApply: 0,
      });
      assert.deepEqual(await freshProtocol.listAwaitRequests(), []);
    });
  }
});

test('startup retains a reconciler terminal until missing applied is repaired', async () => {
  const value = await crashReconciliationFixture();
  const interrupted = new HeldCallCrashReconciler({
    protocol: withProtocolFailpoint(
      value.protocol,
      'publishHeldCallReconciliationApplied',
      'before',
    ),
    serviceClient: value.service,
    clock: LATER,
  });
  await assert.rejects(
    interrupted.reconcile(value.request),
    /fail_before_publishHeldCallReconciliationApplied/,
  );
  assert.ok(await value.protocol.readAwaitRequestTerminal(value.request));

  const freshProtocol = new HarkToolWaitProtocol(value.dataDir);
  assert.deepEqual(await freshProtocol.listAwaitRequests(), [value.request]);
  const repaired = await new HeldCallCrashReconciler({
    protocol: freshProtocol,
    serviceClient: value.service,
    clock: LATER,
  }).reconcile(value.request);
  assert.equal(repaired.kind, 'released');
  assert.equal(repaired.reconciliationApplied.outcome, 'remote_cancelled');
  assert.deepEqual(
    repaired.reconciliationApplied.apiResponses.map(({ method, replay }) => ({ method, replay })),
    [{ method: 'cancel', replay: true }],
  );
  assert.deepEqual(value.calls, {
    arm: 1,
    cancel: 2,
    cancelApply: 1,
    commit: 0,
    commitApply: 0,
  });
  assert.deepEqual(await freshProtocol.listAwaitRequests(), []);
});

test('a commit marker without applied replays exact commit before authorizing recovery', async () => {
  const value = await crashReconciliationFixture();
  const armBinding = (await value.protocol.publishArmBinding(value.request, {
    awaitId: 'await-1',
    preparationNonce: value.attempt.preparationNonce,
    checkpointDigest: value.attempt.checkpointDigest,
    bindingToken: value.attempt.bindingToken,
  }, CLOCK)).armBinding;
  await value.protocol.publishTranscriptBoundary(
    value.request,
    armBinding,
    value.attempt.transcriptBoundary,
    CLOCK,
  );
  const waiterReady = (await value.protocol.publishWaiterReady(
    value.request,
    armBinding,
    value.request.originalInput,
    CLOCK,
  )).waiterReady;
  const commitRequest = {
    v: 'hark.suspension-commit.v2',
    commitNonce: `hkc_${'q'.repeat(32)}`,
    checkpointDigest: armBinding.checkpointDigest,
  };
  await value.protocol.publishCommitAttempt(
    value.request,
    armBinding,
    waiterReady,
    commitRequest,
    CLOCK,
  );
  const firstCommit = await value.service.commitAwait(armBinding.awaitId, commitRequest);
  await value.protocol.publishSuspensionCommitted(
    value.request,
    armBinding,
    waiterReady,
    {
      suspensionReceiptId: firstCommit.suspensionReceipt.sourceReceiptId,
      suspensionReceiptDigest: sha256Canonical(firstCommit.suspensionReceipt),
    },
    () => new Date('2026-08-07T12:00:02.000Z'),
  );
  const toolError = (await value.protocol.publishToolError(value.request, {
    failureCode: 'commit_outcome_ambiguous',
    errorDigest: 'e'.repeat(64),
  }, CLOCK)).toolError;
  await value.protocol.publishToolErrorObservation(
    value.request,
    toolError,
    { responseDigest: 'f'.repeat(64) },
    CLOCK,
  );

  const freshProtocol = new HarkToolWaitProtocol(value.dataDir);
  const repaired = await new HeldCallCrashReconciler({
    protocol: freshProtocol,
    serviceClient: value.service,
    clock: LATER,
  }).reconcile(value.request);
  assert.equal(repaired.kind, 'recovery_authorized');
  assert.equal(repaired.reconciliationApplied.outcome, 'suspension_committed');
  assert.deepEqual(repaired.reconciliationApplied.apiResponses, [{
    method: 'commit',
    digest: repaired.reconciliationApplied.apiResponses[0].digest,
    replay: true,
  }]);
  assert.deepEqual(value.calls, {
    arm: 0,
    cancel: 0,
    cancelApply: 0,
    commit: 2,
    commitApply: 1,
  });
  const intent = await freshProtocol.readHeldCallReconciliationIntent(
    value.request,
    value.attempt,
    value.receipt,
  );
  assert.ok(await freshProtocol.readHeldCallReconciliationApplied(value.request, intent));
  await new HeldCallCrashReconciler({
    protocol: new HarkToolWaitProtocol(value.dataDir),
    serviceClient: value.service,
  }).reconcile(value.request);
  assert.equal(value.calls.commit, 2);

  const terminal = (await freshProtocol.publishAwaitRequestTerminal(value.request, {
    awaitId: armBinding.awaitId,
    wakeId: 'wake-1',
    disposition: 'crash_recovery_completed',
    terminalDigest: 'b'.repeat(64),
  }, () => new Date('2026-08-07T12:00:03.000Z'))).awaitRequestTerminal;
  const restartedProtocol = new HarkToolWaitProtocol(value.dataDir);
  assert.deepEqual(await restartedProtocol.listAwaitRequests(), [value.request]);
  assert.deepEqual(
    await readdir(restartedProtocol.awaitRequestDirectory),
    [`${value.request.eventId}.json`],
  );
  assert.deepEqual(await readdir(restartedProtocol.awaitRequestArchiveDirectory), []);
  assert.deepEqual(
    await restartedProtocol.readHeldCallReconciliationApplied(value.request, intent),
    repaired.reconciliationApplied,
  );
  assert.deepEqual(await restartedProtocol.readAwaitRequestTerminal(value.request), terminal);
  assert.equal(value.calls.commit, 2);
});

test('a later recovery terminal cannot bypass missing commit reconciliation applied', async () => {
  const value = await crashReconciliationFixture();
  const armBinding = (await value.protocol.publishArmBinding(value.request, {
    awaitId: 'await-1',
    preparationNonce: value.attempt.preparationNonce,
    checkpointDigest: value.attempt.checkpointDigest,
    bindingToken: value.attempt.bindingToken,
  }, CLOCK)).armBinding;
  await value.protocol.publishTranscriptBoundary(
    value.request,
    armBinding,
    value.attempt.transcriptBoundary,
    CLOCK,
  );
  const waiterReady = (await value.protocol.publishWaiterReady(
    value.request,
    armBinding,
    value.request.originalInput,
    CLOCK,
  )).waiterReady;
  const commitRequest = {
    v: 'hark.suspension-commit.v2',
    commitNonce: `hkc_${'q'.repeat(32)}`,
    checkpointDigest: armBinding.checkpointDigest,
  };
  await value.protocol.publishCommitAttempt(
    value.request,
    armBinding,
    waiterReady,
    commitRequest,
    CLOCK,
  );
  const firstCommit = await value.service.commitAwait(armBinding.awaitId, commitRequest);
  await value.protocol.publishSuspensionCommitted(
    value.request,
    armBinding,
    waiterReady,
    {
      suspensionReceiptId: firstCommit.suspensionReceipt.sourceReceiptId,
      suspensionReceiptDigest: sha256Canonical(firstCommit.suspensionReceipt),
    },
    () => new Date('2026-08-07T12:00:02.000Z'),
  );

  const interruptedProtocol = withProtocolFailpoint(
    value.protocol,
    'publishHeldCallReconciliationApplied',
    'before',
  );
  await assert.rejects(
    new HeldCallCrashReconciler({
      protocol: interruptedProtocol,
      serviceClient: value.service,
      clock: LATER,
    }).reconcile(value.request),
    /fail_before_publishHeldCallReconciliationApplied/,
  );
  const intent = await value.protocol.readHeldCallReconciliationIntent(
    value.request,
    value.attempt,
    value.receipt,
  );
  assert.equal(await value.protocol.readHeldCallReconciliationApplied(
    value.request,
    intent,
  ), null);
  await value.protocol.publishAwaitRequestTerminal(value.request, {
    awaitId: armBinding.awaitId,
    wakeId: 'wake-1',
    disposition: 'crash_recovery_completed',
    terminalDigest: 'd'.repeat(64),
  }, () => new Date('2026-08-07T12:00:03.000Z'));

  const restartedProtocol = new HarkToolWaitProtocol(value.dataDir);
  assert.deepEqual(await restartedProtocol.listAwaitRequests(), [value.request]);
  const repaired = await new HeldCallCrashReconciler({
    protocol: restartedProtocol,
    serviceClient: value.service,
    clock: LATER,
  }).reconcile(value.request);
  assert.equal(repaired.kind, 'released');
  assert.equal(repaired.reason, 'terminal_archived_after_commit_reconciliation');
  assert.equal(repaired.reconciliationApplied.outcome, 'suspension_committed');
  assert.deepEqual(await restartedProtocol.listAwaitRequests(), []);
  assert.deepEqual(value.calls, {
    arm: 0,
    cancel: 0,
    cancelApply: 0,
    commit: 3,
    commitApply: 1,
  });
});

test('post-arm remote state is frozen once and never replayed or cancelled', async () => {
  const value = await crashReconciliationFixture();
  let armCalls = 0;
  let cancelCalls = 0;
  const service = {
    async armAwait() {
      armCalls += 1;
      return armApiResponse(value.armRequest, {
        replay: true,
        state: 'wake_pending',
        releasedAt: '2026-08-07T12:00:05.000Z',
      });
    },
    async cancelAwait() {
      cancelCalls += 1;
      throw new Error('cancel_forbidden');
    },
  };
  const first = await new HeldCallCrashReconciler({
    protocol: value.protocol,
    serviceClient: service,
    clock: LATER,
  }).reconcile(value.request);
  assert.equal(first.kind, 'owned');
  assert.equal(first.remoteState, 'wake_pending');
  assert.equal(first.armReconciliationFreeze.remoteState, 'wake_pending');
  assert.match(first.armReconciliationFreeze.responseEffectDigest, /^[a-f0-9]{64}$/u);

  const second = await new HeldCallCrashReconciler({
    protocol: new HarkToolWaitProtocol(value.dataDir),
    serviceClient: service,
    clock: LATER,
  }).reconcile(value.request);
  assert.equal(second.kind, 'owned');
  assert.equal(second.remoteState, 'wake_pending');
  assert.deepEqual(second.armReconciliationFreeze, first.armReconciliationFreeze);
  assert.equal(armCalls, 1);
  assert.equal(cancelCalls, 0);
  assert.equal(await value.protocol.readArmBinding(value.request), null);
  assert.equal(await value.protocol.readAwaitRequestTerminal(value.request), null);
});

test('exact arm reconciliation progress dominates a stale concurrent freeze', async () => {
  const value = await crashReconciliationFixture();
  const intent = (await value.protocol.publishHeldCallReconciliationIntent(
    value.request,
    value.attempt,
    value.receipt,
    {
      stage: 'arm',
      armBinding: null,
      waiterReady: null,
      commitAttempt: null,
      remoteRequestDigest: value.attempt.armRequestDigest,
    },
    CLOCK,
  )).reconciliationIntent;
  await value.protocol.publishArmReconciliationFreeze(
    value.request,
    value.attempt,
    {
      responseEffectDigest: 'e'.repeat(64),
      remoteState: 'cancelled',
      replay: true,
    },
    CLOCK,
  );
  const armBinding = (await value.protocol.publishArmBinding(value.request, {
    awaitId: 'await-1',
    preparationNonce: value.attempt.preparationNonce,
    checkpointDigest: value.attempt.checkpointDigest,
    bindingToken: value.attempt.bindingToken,
  }, CLOCK)).armBinding;
  await value.protocol.publishTranscriptBoundary(
    value.request,
    armBinding,
    value.attempt.transcriptBoundary,
    CLOCK,
  );
  await value.protocol.publishWaiterReady(
    value.request,
    armBinding,
    value.request.originalInput,
    CLOCK,
  );

  const repaired = await new HeldCallCrashReconciler({
    protocol: new HarkToolWaitProtocol(value.dataDir),
    serviceClient: value.service,
    clock: LATER,
  }).reconcile(value.request);
  assert.equal(repaired.kind, 'released');
  assert.equal(repaired.reconciliationApplied.outcome, 'remote_cancelled');
  assert.ok(await value.protocol.readHeldCallReconciliationApplied(value.request, intent));
  assert.deepEqual(value.calls, {
    arm: 0,
    cancel: 1,
    cancelApply: 1,
    commit: 0,
    commitApply: 0,
  });
  assert.deepEqual(await value.protocol.listAwaitRequests(), []);
});

test('tool-error and owner-abort reconciliation elect one cancellation authority', async (t) => {
  await t.test('bare tool error without host observation grants no competing authority', async () => {
    const value = await crashReconciliationFixture();
    await value.protocol.publishToolError(value.request, {
      failureCode: 'arm_outcome_ambiguous',
      errorDigest: 'e'.repeat(64),
    }, CLOCK);
    const released = await new HeldCallCrashReconciler({
      protocol: value.protocol,
      serviceClient: value.service,
      clock: LATER,
    }).reconcile(value.request);
    assert.equal(released.kind, 'released');
    assert.equal(released.reconciliationApplied.outcome, 'remote_cancelled');
    assert.deepEqual(value.calls, {
      arm: 1,
      cancel: 1,
      cancelApply: 1,
      commit: 0,
      commitApply: 0,
    });
  });

  await t.test('persisted tool error before crash intent owns cancellation', async () => {
    const value = await crashReconciliationFixture();
    const toolError = (await value.protocol.publishToolError(value.request, {
      failureCode: 'arm_outcome_ambiguous',
      errorDigest: 'e'.repeat(64),
    }, CLOCK)).toolError;
    await value.protocol.publishToolErrorObservation(
      value.request,
      toolError,
      { responseDigest: 'f'.repeat(64) },
      CLOCK,
    );
    assert.deepEqual(
      await new HeldCallCrashReconciler({
        protocol: value.protocol,
        serviceClient: value.service,
      }).reconcile(value.request),
      { kind: 'owned', reason: 'tool_error_lifecycle_authoritative' },
    );
    assert.deepEqual(value.calls, {
      arm: 0,
      cancel: 0,
      cancelApply: 0,
      commit: 0,
      commitApply: 0,
    });
    const released = await new HarkToolErrorLifecycle({
      protocol: new HarkToolWaitProtocol(value.dataDir),
      serviceClient: value.service,
    }).reconcile(value.request);
    assert.equal(released.kind, 'released');
    assert.equal(released.reason, 'authoritatively_cancelled');
    assert.deepEqual(value.calls, {
      arm: 1,
      cancel: 1,
      cancelApply: 1,
      commit: 0,
      commitApply: 0,
    });
  });

  await t.test('immutable crash intent before tool-error pass owns cancellation', async () => {
    const value = await crashReconciliationFixture();
    await value.protocol.publishHeldCallReconciliationIntent(
      value.request,
      value.attempt,
      value.receipt,
      {
        stage: 'arm',
        armBinding: null,
        waiterReady: null,
        commitAttempt: null,
        remoteRequestDigest: value.attempt.armRequestDigest,
      },
      CLOCK,
    );
    const toolError = (await value.protocol.publishToolError(value.request, {
      failureCode: 'arm_outcome_ambiguous',
      errorDigest: 'e'.repeat(64),
    }, CLOCK)).toolError;
    await value.protocol.publishToolErrorObservation(
      value.request,
      toolError,
      { responseDigest: 'f'.repeat(64) },
      CLOCK,
    );
    assert.deepEqual(
      await new HarkToolErrorLifecycle({
        protocol: value.protocol,
        serviceClient: value.service,
      }).reconcile(value.request),
      { kind: 'owned', reason: 'held_call_crash_reconciliation_authoritative' },
    );
    const released = await new HeldCallCrashReconciler({
      protocol: new HarkToolWaitProtocol(value.dataDir),
      serviceClient: value.service,
      clock: LATER,
    }).reconcile(value.request);
    assert.equal(released.kind, 'released');
    assert.equal(released.reconciliationApplied.outcome, 'remote_cancelled');
    assert.deepEqual(value.calls, {
      arm: 1,
      cancel: 1,
      cancelApply: 1,
      commit: 0,
      commitApply: 0,
    });
  });
});

test('altered arm binding or transcript boundary fails before every remote method', async (t) => {
  for (const variant of ['arm-binding', 'transcript-boundary']) {
    await t.test(variant, async () => {
      const value = await crashReconciliationFixture();
      const armBinding = (await value.protocol.publishArmBinding(value.request, {
        awaitId: 'await-1',
        preparationNonce: variant === 'arm-binding'
          ? `hkp_${'z'.repeat(32)}`
          : value.attempt.preparationNonce,
        checkpointDigest: value.attempt.checkpointDigest,
        bindingToken: value.attempt.bindingToken,
      }, CLOCK)).armBinding;
      if (variant === 'transcript-boundary') {
        await value.protocol.publishTranscriptBoundary(
          value.request,
          armBinding,
          { ...value.attempt.transcriptBoundary, prefixSha256: '9'.repeat(64) },
          CLOCK,
        );
      }
      await assert.rejects(
        new HeldCallCrashReconciler({
          protocol: value.protocol,
          serviceClient: value.service,
        }).reconcile(value.request),
        variant === 'arm-binding'
          ? /held_call_reconciliation_arm_attempt_binding_mismatch/
          : /held_call_reconciliation_arm_attempt_boundary_mismatch/,
      );
      assert.deepEqual(value.calls, {
        arm: 0,
        cancel: 0,
        cancelApply: 0,
        commit: 0,
        commitApply: 0,
      });
    });
  }
});

test('durably binds one secret-free observation intent before materializing the private lease', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-'));
  const protocol = new HarkToolWaitProtocol(dataDir);
  const records = recoveryRecords();
  const binding = createPrivateClaimBinding({
    eventId: records.wakeDelivery.eventId,
    deliveryId: records.wakeDelivery.deliveryId,
    awaitId: records.wakeDelivery.awaitId,
    wakeId: records.wakeDelivery.wakeId,
    toolUseId: records.wakeDelivery.toolUseId,
    checkpointDigest: records.wakeDelivery.checkpointDigest,
    wakeDeliveryDigest: records.wakeDelivery.wakeDeliveryDigest,
    toolResultDigest: sha256Canonical(records.toolResult),
  });
  const claimStore = new HarkPrivateClaimStore(dataDir);
  const claimReference = await claimStore.create({
    binding,
    waiterId: 'waiter-1',
    leaseToken: 'lease-secret-1',
    leaseGeneration: 3,
  }, { randomBytes: random(0x77), clock: CLOCK });
  const input = {
    delivery: records.wakeDelivery,
    result: records.toolResult,
    transcriptBoundary: transcriptBoundary(),
    runtimeId: 'runtime-1',
    claimReference,
  };
  const created = createToolResultObservationIntent(input, CLOCK);
  const published = await protocol.publishToolResultObservationIntent(input, CLOCK);
  assert.equal(published.created, true);
  assert.deepEqual(published.observationIntent, created);
  assert.equal((await protocol.publishToolResultObservationIntent(input, LATER)).created, false);
  assert.deepEqual(await protocol.readToolResultObservationIntent(
    records.wakeDelivery,
    records.toolResult,
    transcriptBoundary(),
    'runtime-1',
    claimReference,
  ), created);

  const raw = await readFile(path.join(
    protocol.observationIntentDirectory,
    `${records.request.eventId}.json`,
  ), 'utf8');
  assert.equal(raw, `${canonicalJson(created)}\n`);
  assert.equal((await stat(protocol.observationIntentDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(
    protocol.observationIntentDirectory,
    `${records.request.eventId}.json`,
  ))).mode & 0o777, 0o600);
  for (const forbidden of ['lease-secret-1', 'waiter-1', 'leaseToken', 'accessToken']) {
    assert.equal(raw.includes(forbidden), false, forbidden);
  }
  assert.equal(created.publicReceipt.toolResultObservation.observationMode, 'direct');
  const receipt = materializeToolResultObservationReceipt(created, {
    state: 'pending',
    leaseToken: 'lease-secret-1',
    leaseGeneration: 3,
  });
  assert.equal(receipt.leaseToken, 'lease-secret-1');
  assert.equal(receipt.leaseGeneration, 3);
  assert.equal(Object.hasOwn(created.publicReceipt, 'leaseToken'), false);

  const changed = structuredClone(created);
  changed.publicReceipt.toolResultObservation.toolResultDigest = '9'.repeat(64);
  await assert.rejects(
    protocol.appendToolResultObservationIntent(
      changed,
      records.wakeDelivery,
      records.toolResult,
      transcriptBoundary(),
      'runtime-1',
      claimReference,
    ),
    /tool_result_observation_receipt_binding_mismatch|tool_result_observation_intent_id_mismatch/,
  );
});

test('same-content replay is idempotent but changed arm or second wake conflicts', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-'));
  const protocol = new HarkToolWaitProtocol(dataDir);
  const records = recoveryRecords();
  await protocol.appendArmBinding(records.armBinding, records.request);
  assert.equal((await protocol.appendArmBinding({
    ...records.armBinding,
    armedAt: '2026-08-07T12:00:09.000Z',
  }, records.request)).created, false);
  await assert.rejects(protocol.appendArmBinding({
    ...records.armBinding,
    bindingToken: random(0x99)(32).toString('base64url'),
  }, records.request), /arm_binding_conflict/);

  await protocol.appendWakeDelivery(
    records.wakeDelivery,
    records.request,
    records.armBinding,
    records.suspensionCommitted,
  );
  const secondDelivery = createWakeDelivery(
    records.request,
    records.armBinding,
    records.suspensionCommitted,
    rawWake({ wakeId: 'wake-2', idempotencyKey: 'wake-idem-2' }),
    WAKE_DELIVERY_DIGEST,
    LATER,
  );
  await assert.rejects(protocol.appendWakeDelivery(
    secondDelivery,
    records.request,
    records.armBinding,
    records.suspensionCommitted,
  ), /wake_delivery_conflict/);
});

test('delivery and tool result default-deny raw lease, access, binding, and extra fields', () => {
  const records = recoveryRecords();
  const serialized = JSON.stringify({
    delivery: records.wakeDelivery,
    result: records.toolResult,
    returned: records.toolResultReturned,
  });
  assert.equal(/leaseToken|accessToken|bindingToken|authorization/.test(serialized), false);

  const withAccessSecret = rawWake();
  withAccessSecret.signal.data.accessToken = 'secret';
  assert.throws(() => sanitizeWakeEnvelope(withAccessSecret), /signal_data_secret_forbidden:accessToken/);
  const withLeaseSecret = rawWake();
  withLeaseSecret.signal.evidence.push({ leaseToken: 'secret' });
  assert.throws(() => sanitizeWakeEnvelope(withLeaseSecret), /signal_evidence.*secret_forbidden:leaseToken/);
  assert.throws(() => sanitizeWakeEnvelope({
    ...rawWake(),
    claim: { leaseToken: 'secret' },
  }), /raw_wake_field_unsupported:claim/);
  assert.throws(() => assertToolWaitResult({
    ...records.toolResult,
    accessToken: 'secret',
  }, records.wakeDelivery), /tool_wait_result_field_unsupported:accessToken/);
  assert.throws(() => createWakeDelivery(
    records.request,
    records.armBinding,
    records.suspensionCommitted,
    rawWake(),
  ), /wake_delivery_digest_invalid/);
  assert.throws(() => createWakeDelivery(
    records.request,
    records.armBinding,
    records.suspensionCommitted,
    rawWake(),
    'not-a-sha256',
  ), /wake_delivery_digest_invalid/);
  assert.throws(() => createToolResultReturned(
    records.wakeDelivery,
    records.toolResult,
    {
      wakeDeliveryDigest: '4'.repeat(64),
      transcriptBoundary: transcriptBoundary(),
    },
    CLOCK,
  ), /tool_result_wake_delivery_digest_mismatch/);
  assert.throws(() => assertToolResultReturned({
    ...records.toolResultReturned,
    wakeDeliveryDigest: '4'.repeat(64),
  }, records.wakeDelivery, records.toolResult), /tool_result_returned_wake_delivery_digest_mismatch/);
});

test('validation is exact and bounded wait polls succeed or time out', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-'));
  const protocol = new HarkToolWaitProtocol(dataDir);
  const request = createAwaitRequest(requestInput(), CLOCK);
  assert.throws(() => assertAwaitRequest({ ...request, extra: true }), /await_request_field_unsupported:extra/);

  const waiting = protocol.waitForAwaitRequest(request.eventId, {
    timeoutMs: 100,
    pollIntervalMs: 2,
  });
  setTimeout(() => { void protocol.appendAwaitRequest(request); }, 5);
  assert.deepEqual(await waiting, request);

  const absent = createAwaitRequest({ ...requestInput(), turnId: 'turn-absent' }, CLOCK);
  await assert.rejects(
    protocol.waitForAwaitRequest(absent.eventId, { timeoutMs: 5, pollIntervalMs: 1 }),
    /await_request_timeout/,
  );
  await assert.rejects(
    protocol.waitForAwaitRequest(absent.eventId, { timeoutMs: 300_001 }),
    /await_request_timeout_invalid/,
  );
  assert.deepEqual(await readdir(protocol.awaitRequestDirectory), [`${request.eventId}.json`]);
});

test('abortable polling clears its listener after more than one hundred ticks and abort', async () => {
  const controller = new AbortController();
  for (let tick = 0; tick < 101; tick += 1) {
    await abortableDelay(0, controller.signal, { label: 'listener_test' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  const pending = abortableDelay(10_000, controller.signal, { label: 'listener_test' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await assert.rejects(pending, /listener_test_aborted/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('steady request scans ignore ten thousand archived records and discover new pending work', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-spool-'));
  const protocol = new HarkToolWaitProtocol(dataDir);
  await protocol.ensureDirectories();
  const archivedNames = Array.from({ length: 10_000 }, (_, index) => (
    `historical-${String(index).padStart(5, '0')}.record`
  ));
  for (let offset = 0; offset < archivedNames.length; offset += 200) {
    await Promise.all(archivedNames.slice(offset, offset + 200).map((name) => (
      writeFile(path.join(protocol.awaitRequestArchiveDirectory, name), 'historical\n', {
        mode: 0o600,
      })
    )));
  }
  assert.deepEqual(await protocol.listAwaitRequests(), []);

  const pending = Array.from({ length: 3 }, (_, index) => createAwaitRequest({
    ...requestInput(),
    turnId: `turn-pending-${index}`,
    toolUseId: `call-pending-${index}`,
  }, CLOCK));
  for (const request of pending) await protocol.appendAwaitRequest(request);
  assert.deepEqual(
    (await protocol.listAwaitRequests()).map((request) => request.eventId).sort(),
    pending.map((request) => request.eventId).sort(),
  );
  assert.equal((await readdir(protocol.awaitRequestArchiveDirectory)).length, 10_000);
});

test('startup reconciles a terminal-fsynced request into the archive exactly once', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-crash-'));
  const writer = new HarkToolWaitProtocol(dataDir);
  const request = createAwaitRequest({
    ...requestInput(),
    turnId: 'turn-crash-window',
    toolUseId: 'call-crash-window',
  }, CLOCK);
  await writer.appendAwaitRequest(request);
  const terminal = createAwaitRequestTerminal(request, {
    awaitId: 'await-crash-window',
    wakeId: 'wake-crash-window',
    disposition: 'crash_recovery_completed',
    terminalDigest: '9'.repeat(64),
  }, CLOCK);
  await writer.appendAwaitRequestTerminal(terminal, request);

  const recovered = new HarkToolWaitProtocol(dataDir);
  assert.deepEqual(await recovered.listAwaitRequests(), []);
  assert.deepEqual(await recovered.readAwaitRequest(request.eventId), request);
  assert.deepEqual(await recovered.readAwaitRequestTerminal(request), terminal);
  assert.deepEqual(await readdir(recovered.awaitRequestDirectory), []);
  assert.deepEqual(
    await readdir(recovered.awaitRequestArchiveDirectory),
    [`${request.eventId}.json`],
  );

  const replay = new HarkToolWaitProtocol(dataDir);
  assert.deepEqual(await replay.listAwaitRequests(), []);
  assert.deepEqual(
    await readdir(replay.awaitRequestArchiveDirectory),
    [`${request.eventId}.json`],
  );
});

test('a malformed pending request is quarantined deterministically once', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-tool-wait-corrupt-'));
  const protocol = new HarkToolWaitProtocol(dataDir);
  await protocol.ensureDirectories();
  const request = createAwaitRequest({
    ...requestInput(),
    turnId: 'turn-corrupt',
    toolUseId: 'call-corrupt',
  }, CLOCK);
  await writeFile(
    path.join(protocol.awaitRequestDirectory, `${request.eventId}.json`),
    '{not-json\n',
    { mode: 0o600 },
  );
  assert.deepEqual(await protocol.listAwaitRequests(), []);
  const quarantined = await readdir(protocol.awaitRequestQuarantineDirectory);
  assert.equal(quarantined.length, 1);
  assert.deepEqual(await protocol.listAwaitRequests(), []);
  assert.deepEqual(await readdir(protocol.awaitRequestQuarantineDirectory), quarantined);
});
