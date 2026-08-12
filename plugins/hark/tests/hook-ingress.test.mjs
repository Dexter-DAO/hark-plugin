import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createPreparedAwait } from '../lib/await-preparation.mjs';
import { sha256Canonical } from '../lib/canonical.mjs';
import { HarkCredentialsStore } from '../lib/credentials.mjs';
import {
  createPrivateClaimBinding,
  HarkPrivateClaimStore,
} from '../lib/private-claim-store.mjs';
import {
  createArmBinding,
  createAwaitRequest,
  createSuspensionCommitted,
  createToolWaitResult,
  createWaiterReady,
  createWakeDelivery,
  HarkToolWaitProtocol,
} from '../lib/tool-wait-protocol.mjs';
import { handleCodexHook } from '../hooks/ingress.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_ROOT = path.resolve(ROOT, '..');
const CLOCK = () => new Date('2026-08-07T12:00:00.000Z');
const PUBLIC_INPUT = {
  request: '  Continue after job 42.  ',
  name: ' Job 42 ',
  source: { kind: ' job.completed ', adapter: ' webhook.v1 ', subject: ' job-42 ' },
  condition: { status: { equals: 'completed' } },
};
const NORMALIZED_INPUT = {
  request: 'Continue after job 42.',
  name: 'Job 42',
  source: { kind: 'job.completed', adapter: 'webhook.v1', subject: 'job-42' },
  condition: { status: { equals: 'completed' } },
};
const CREDENTIALS = {
  apiBaseUrl: 'https://api.example.test',
  accessToken: 'installation-secret',
  installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
};

function random(fill) {
  return (size) => Buffer.alloc(size, fill);
}

function preInput(overrides = {}) {
  return {
    session_id: 'session-1',
    turn_id: 'turn-1',
    transcript_path: '/tmp/codex-session-1.jsonl',
    cwd: '/tmp/workspace',
    hook_event_name: 'PreToolUse',
    model: 'gpt-5.6',
    permission_mode: 'dontAsk',
    tool_name: 'mcp__hark__hark_await',
    tool_input: PUBLIC_INPUT,
    tool_use_id: 'call-1',
    ...overrides,
  };
}

function postInput(rewrittenInput, toolResponse, overrides = {}) {
  const { hook_event_name: _ignored, ...base } = preInput();
  return {
    ...base,
    hook_event_name: 'PostToolUse',
    tool_input: rewrittenInput,
    tool_response: toolResponse,
    ...overrides,
  };
}

async function tempProtocol() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-hook-ingress-'));
  return { dataDir, protocol: new HarkToolWaitProtocol(dataDir) };
}

function serviceRecorder(overrides = {}) {
  const calls = [];
  const sequence = [];
  return {
    calls,
    sequence,
    client: {
      async getInstallationStatus() {
        sequence.push('self');
        if (overrides.selfError) throw overrides.selfError;
        return overrides.selfResponse ?? {
          v: 'hark.installation-status.v2',
          installation: overrides.installation ?? CREDENTIALS.installation,
        };
      },
      async recordRuntimeReceipt(awaitId, receipt) {
        sequence.push('receipt');
        calls.push({ awaitId, receipt });
        if (overrides.error) throw overrides.error;
        return overrides.response ?? {
          v: 'hark.runtime-receipt-result.v2',
          awaitId,
          kind: receipt.kind,
          state: 'running',
          wakeState: 'running',
          replay: false,
        };
      },
      async certifyAwait(awaitId) {
        sequence.push('certify');
        if (overrides.certificationError) throw overrides.certificationError;
        if (overrides.certification) return overrides.certification;
        throw Object.assign(new Error('certification_unexpected'), { awaitId });
      },
    },
  };
}

async function admit(protocol, overrides = {}) {
  return handleCodexHook(preInput(overrides), {
    protocol,
    clock: CLOCK,
    randomBytes: random(0x11),
  });
}

function rawWake(awaitId, checkpointDigest) {
  return {
    v: 'hark.wake.v2',
    wakeId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'wake-idempotency-1',
    awaitId,
    origin: {
      protocol: 'codex',
      runtimeId: 'runtime-1',
      taskId: 'turn-1',
      conversationId: 'session-1',
    },
    checkpoint: { version: 'hark.codex-checkpoint.v1', digest: checkpointDigest },
    prepared: { request: NORMALIZED_INPUT.request },
    signal: {
      id: 'signal-1',
      sourceSignalId: 'provider-signal-1',
      type: 'job.completed',
      subject: 'job-42',
      qualificationDigest: 'a'.repeat(64),
      sourceAdapter: 'webhook.v1',
      authMode: 'source_hmac',
      observedAt: '2026-08-07T12:00:04.000Z',
      summary: 'Job completed.',
      data: { status: 'completed' },
      evidence: [{ kind: 'provider-event', digest: 'e'.repeat(64) }],
    },
    createdAt: '2026-08-07T12:00:04.000Z',
  };
}

async function heldWaitFixture(protocol) {
  const pre = await admit(protocol);
  const rewrittenInput = pre.codexOutput.hookSpecificOutput.updatedInput;
  const { admission } = await protocol.consumeAdmission(rewrittenInput);
  const request = createAwaitRequest({
    sessionId: admission.sessionId,
    turnId: admission.turnId,
    toolUseId: admission.toolUseId,
    toolName: admission.toolName,
    transcriptPath: admission.transcriptPath,
    originalInput: admission.originalInput,
  }, CLOCK);
  assert.equal(request.eventId, admission.eventId);
  await protocol.appendAwaitRequest(request);
  const transcriptBoundary = {
    v: 'hark.codex-tool-wait-boundary.v1',
    historySource: 'codex.rollout-jsonl.v1',
    transcriptPath: admission.transcriptPath,
    conversationId: admission.sessionId,
    originTaskId: admission.turnId,
    toolUseId: admission.toolUseId,
    toolName: admission.toolName,
    toolCallDigest: 'b'.repeat(64),
    inputDigest: admission.originalInputDigest,
    cliVersion: '0.147.0',
    dev: '2049',
    ino: '1234567',
    byteLength: 4096,
    prefixSha256: 'e'.repeat(64),
  };
  const prepared = createPreparedAwait(admission.originalInput, random(0x22));
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
  const armAttempt = (await protocol.publishArmAttempt(request, {
    installationId: CREDENTIALS.installation.id,
    armRequest,
    transcriptBoundary,
  }, CLOCK, random(0x22))).armAttempt;
  const armBinding = createArmBinding(request, {
    awaitId: '22222222-2222-4222-8222-222222222222',
    preparationNonce: armAttempt.preparationNonce,
    checkpointDigest: armAttempt.checkpointDigest,
    bindingToken: armAttempt.bindingToken,
  }, CLOCK, random(0x22));
  await protocol.appendArmBinding(armBinding, request);
  const waiterReady = createWaiterReady(
    request,
    armBinding,
    admission.originalInput,
    () => new Date('2026-08-07T12:00:01.000Z'),
  );
  await protocol.appendWaiterReady(waiterReady, request, armBinding);
  const committed = createSuspensionCommitted(
    request,
    armBinding,
    waiterReady,
    {
      suspensionReceiptId: 'hrr_monitoring_task_suspended_await-1',
      suspensionReceiptDigest: 'd'.repeat(64),
    },
    () => new Date('2026-08-07T12:00:02.000Z'),
  );
  await protocol.appendSuspensionCommitted(committed, request, armBinding, waiterReady);
  const delivery = createWakeDelivery(
    request,
    armBinding,
    committed,
    rawWake(armBinding.awaitId, armBinding.checkpointDigest),
    'f'.repeat(64),
    () => new Date('2026-08-07T12:00:05.000Z'),
  );
  await protocol.appendWakeDelivery(delivery, request, armBinding, committed);
  const result = createToolWaitResult(delivery);
  await protocol.publishTranscriptBoundary(request, armBinding, transcriptBoundary, CLOCK);
  const binding = createPrivateClaimBinding({
    eventId: delivery.eventId,
    deliveryId: delivery.deliveryId,
    awaitId: delivery.awaitId,
    wakeId: delivery.wakeId,
    toolUseId: delivery.toolUseId,
    checkpointDigest: delivery.checkpointDigest,
    wakeDeliveryDigest: 'f'.repeat(64),
    toolResultDigest: sha256Canonical(result),
  });
  const leaseToken = '33333333-3333-4333-8333-333333333333';
  const claimStore = new HarkPrivateClaimStore(protocol.dataDir);
  const claim = await claimStore.create({
    binding,
    waiterId: 'waiter-1',
    leaseToken,
    leaseGeneration: 1,
  }, { randomBytes: random(0x33), clock: CLOCK });
  const observationIntent = (await protocol.publishToolResultObservationIntent({
    delivery,
    result,
    transcriptBoundary,
    runtimeId: CREDENTIALS.installation.runtimeId,
    claimReference: claim,
  }, CLOCK)).observationIntent;
  const toolResponse = {
    content: [{ type: 'text', text: 'Hark wake delivered.' }],
    structuredContent: structuredClone(result),
    _meta: {
      'cash.dexter.hark/claim': claim,
    },
  };
  return {
    admission,
    armAttempt,
    binding,
    claim,
    claimStore,
    delivery,
    leaseToken,
    observationIntent,
    result,
    request,
    rewrittenInput,
    toolResponse,
    transcriptBoundary,
  };
}

function observedCertification(fixture, overrides = {}) {
  const observation = fixture.observationIntent.publicReceipt.toolResultObservation;
  return {
    v: 'hark.await-certification.v2',
    awaitId: fixture.delivery.awaitId,
    certified: false,
    reasons: ['task_completion_not_proven'],
    origin: fixture.observationIntent.publicReceipt.origin,
    checkpoint: {
      version: 'hark.codex-checkpoint.v1',
      digest: fixture.delivery.checkpointDigest,
    },
    wake: {
      id: fixture.delivery.wakeId,
      awaitId: fixture.delivery.awaitId,
      state: 'running',
      deliveryMode: 'held_tool',
      heldDeliveryDigest: fixture.delivery.wakeDeliveryDigest,
    },
    continuation: {
      mode: 'held_tool',
      proof: null,
      toolResultObservation: observation,
    },
    toolResultObservationCount: 1,
    activeToolResultObservationCount: 1,
    toolResultNotPersistedCount: 0,
    toolResultRecoveryProof: null,
    ...overrides,
  };
}

test('PreToolUse emits only the exact allow rewrite and its opaque one-shot admission', async () => {
  const { protocol } = await tempProtocol();
  const handled = await admit(protocol);
  const updatedInput = handled.codexOutput.hookSpecificOutput.updatedInput;
  assert.deepEqual(handled.codexOutput, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        ...NORMALIZED_INPUT,
        _hark: { admissionLocator: updatedInput._hark.admissionLocator },
      },
    },
  });
  const exposed = JSON.stringify(handled.codexOutput);
  for (const secretIdentity of [
    'session-1', 'turn-1', 'call-1', '/tmp/codex-session-1.jsonl', 'runtime-1',
  ]) assert.equal(exposed.includes(secretIdentity), false);

  const pending = await protocol.readAdmission(updatedInput._hark.admissionLocator);
  assert.equal(pending.sessionId, 'session-1');
  assert.deepEqual(pending.originalInput, NORMALIZED_INPUT);
  const consumed = await protocol.consumeAdmission(updatedInput);
  assert.equal(consumed.admission.eventId, handled.eventId);
  await assert.rejects(
    protocol.consumeAdmission(updatedInput),
    /tool_wait_admission_replayed/,
  );
});

test('PreToolUse rejects subagents, prewritten private input, and prompt-supplied host identity', async () => {
  const { protocol } = await tempProtocol();
  await assert.rejects(admit(protocol, {
    agent_id: 'child-thread-1',
    agent_type: 'worker',
  }), /subagent_context_rejected/);
  await assert.rejects(admit(protocol, {
    tool_input: { ...PUBLIC_INPUT, _hark: { admissionLocator: `hta_${'a'.repeat(43)}` } },
  }), /input_field_unsupported:_hark/);
  await assert.rejects(admit(protocol, {
    tool_input: {
      ...PUBLIC_INPUT,
      condition: { status: { equals: 'completed' }, sessionId: 'forged-session' },
    },
  }), /host_identity_forbidden:input\.condition\.sessionId/);
  const ignored = await admit(protocol, { tool_name: 'mcp__other__hark_await' });
  assert.deepEqual(ignored, { accepted: false, reason: 'tool_not_hark_await' });
});

test('command writes exact Codex 0.147 PreToolUse JSON and stores no data in PLUGIN_DATA', async () => {
  const canonicalDir = await mkdtemp(path.join(os.tmpdir(), 'hark-canonical-data-'));
  const pluginDir = await mkdtemp(path.join(os.tmpdir(), 'hark-plugin-data-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'hooks/ingress.mjs')], {
    cwd: ROOT,
    env: { ...process.env, HARK_DATA_DIR: canonicalDir, PLUGIN_DATA: pluginDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(preInput()));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  assert.equal(stdout.endsWith('\n'), true);
  const output = JSON.parse(stdout);
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.deepEqual(output.hookSpecificOutput.updatedInput.request, NORMALIZED_INPUT.request);
  const locator = output.hookSpecificOutput.updatedInput._hark.admissionLocator;
  assert.ok(await new HarkToolWaitProtocol(canonicalDir).readAdmission(locator));
  assert.equal(await new HarkToolWaitProtocol(pluginDir).readAdmission(locator), null);
});

test('command failures exit 2 with stderr and never emit an allow rewrite', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-rejected-data-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'hooks/ingress.mjs')], {
    cwd: ROOT,
    env: { ...process.env, HARK_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(preInput({ agent_id: 'child-1' })));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /subagent_context_rejected/);
});

test('PostToolUse binds and releases a deterministic pre-arm MCP error', async () => {
  const { protocol } = await tempProtocol();
  const pre = await admit(protocol);
  const rewrittenInput = pre.codexOutput.hookSpecificOutput.updatedInput;
  const consumed = await protocol.consumeAdmission(rewrittenInput);
  const request = (await protocol.publishAwaitRequest({
    sessionId: consumed.admission.sessionId,
    turnId: consumed.admission.turnId,
    toolUseId: consumed.admission.toolUseId,
    toolName: consumed.admission.toolName,
    transcriptPath: consumed.admission.transcriptPath,
    originalInput: consumed.admission.originalInput,
  }, CLOCK)).request;
  const service = serviceRecorder();
  const result = await handleCodexHook(postInput(rewrittenInput, {
    content: [{ type: 'text', text: 'Hark wait failed closed.' }],
    isError: true,
  }), {
    protocol,
    clock: CLOCK,
    credentials: CREDENTIALS,
    serviceClient: service.client,
  });
  assert.deepEqual(result, { accepted: false, reason: 'tool_result_error' });
  assert.deepEqual(service.calls, []);
  assert.equal(await protocol.readWakeDelivery(consumed.admission.eventId), null);
  assert.deepEqual(await protocol.listAwaitRequests(), []);
  const terminal = await protocol.readAwaitRequestTerminal(request);
  assert.equal(terminal.disposition, 'pre_arm_failed');
  const observation = await protocol.readToolErrorObservation(
    request,
    await protocol.readToolError(request),
  );
  assert.equal(observation.responseDigest, sha256Canonical({
    content: [{ type: 'text', text: 'Hark wait failed closed.' }],
    isError: true,
  }));
});

test('PostToolUse posts the fenced observation, then persists the secret-free exact return', async () => {
  const { protocol } = await tempProtocol();
  const fixture = await heldWaitFixture(protocol);
  const service = serviceRecorder();
  const options = {
    protocol,
    clock: () => new Date('2026-08-07T12:00:06.000Z'),
    credentials: CREDENTIALS,
    serviceClient: service.client,
  };
  const handled = await handleCodexHook(
    postInput(fixture.rewrittenInput, fixture.toolResponse),
    options,
  );
  assert.equal(handled.accepted, true);
  assert.equal(handled.kind, 'tool_result_returned');
  assert.equal(handled.deliveryId, fixture.delivery.deliveryId);
  const hookReturn = JSON.stringify(handled);
  assert.equal(hookReturn.includes(fixture.leaseToken), false);
  assert.equal(hookReturn.includes('waiter-1'), false);
  assert.equal(hookReturn.includes('transcript-boundary'), false);
  assert.equal(service.calls.length, 1);
  const receiptIndex = service.sequence.indexOf('receipt');
  assert.ok(receiptIndex > 0);
  assert.equal(service.sequence[0], 'self');
  assert.equal(service.sequence[receiptIndex - 1], 'self');
  assert.equal(fixture.armAttempt.v, 'hark.tool-wait.arm-attempt.v2');
  assert.equal(fixture.armAttempt.installationId, CREDENTIALS.installation.id);
  const [{ awaitId, receipt }] = service.calls;
  assert.equal(awaitId, fixture.delivery.awaitId);
  assert.deepEqual(receipt, {
    v: 'hark.runtime-receipt.v2',
    sourceReceiptId: `hrr_tool_result_observed_${fixture.delivery.wakeId}`,
    observedAt: fixture.delivery.deliveredAt,
    origin: {
      protocol: 'codex', runtimeId: 'runtime-1', taskId: 'turn-1', conversationId: 'session-1',
    },
    checkpointDigest: fixture.delivery.checkpointDigest,
    kind: 'tool_result_observed',
    wakeId: fixture.delivery.wakeId,
    leaseToken: fixture.leaseToken,
    leaseGeneration: 1,
    toolResultObservation: {
      v: 'hark.tool-result-observed.v1',
      continuationMode: 'held_tool',
      observationMode: 'direct',
      conversationId: 'session-1',
      taskId: 'turn-1',
      toolName: 'mcp__hark__hark_await',
      toolUseId: 'call-1',
      inputDigest: fixture.admission.originalInputDigest,
      wakeDeliveryDigest: fixture.delivery.wakeDeliveryDigest,
      toolResultDigest: sha256Canonical(fixture.result),
    },
  });

  const returned = await protocol.readToolResultReturned(fixture.delivery, fixture.result);
  assert.equal(returned.wakeDeliveryDigest, fixture.delivery.wakeDeliveryDigest);
  assert.deepEqual(returned.transcriptBoundary, fixture.transcriptBoundary);
  const persisted = JSON.stringify(returned);
  assert.equal(persisted.includes(fixture.leaseToken), false);
  assert.equal(persisted.includes('waiter-1'), false);

  const serializedToolResponse = JSON.stringify(fixture.toolResponse);
  assert.equal(serializedToolResponse.includes(fixture.leaseToken), false);
  assert.equal(serializedToolResponse.includes('waiter-1'), false);
  assert.equal(serializedToolResponse.includes('leaseToken'), false);
  assert.deepEqual(Object.keys(fixture.toolResponse._meta), ['cash.dexter.hark/claim']);
  const claimRoot = path.join(protocol.dataDir, 'private-held-claims');
  const pendingDirectory = path.join(claimRoot, 'pending');
  const consumedDirectory = path.join(claimRoot, 'consumed');
  assert.equal((await stat(claimRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(pendingDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(consumedDirectory)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(pendingDirectory), []);
  const consumedFiles = await readdir(consumedDirectory);
  assert.deepEqual(consumedFiles, [`${fixture.claim.locator}.json`]);
  const consumedPath = path.join(consumedDirectory, consumedFiles[0]);
  assert.equal((await stat(consumedPath)).mode & 0o777, 0o600);
  const consumedRaw = await readFile(consumedPath, 'utf8');
  assert.equal(consumedRaw.includes(fixture.leaseToken), false);
  assert.equal(consumedRaw.includes('waiter-1'), false);
  assert.deepEqual(
    await fixture.claimStore.resolve(fixture.claim, fixture.binding),
    { state: 'consumed' },
  );

  const replay = await handleCodexHook(
    postInput(fixture.rewrittenInput, fixture.toolResponse),
    options,
  );
  assert.equal(replay.created, false);
  assert.equal(service.calls.length, 1);
});

test('PostToolUse installation mismatch or unavailable self makes zero local or remote progress', async (t) => {
  for (const specimen of [
    {
      label: 'replacement installation',
      service: { installation: { ...CREDENTIALS.installation, id: 'installation-2' } },
      error: /installation_identity_fence_mismatch/,
    },
    {
      label: 'unavailable authenticated self',
      service: { selfError: new Error('self_unavailable') },
      error: /self_unavailable/,
    },
  ]) {
    await t.test(specimen.label, async () => {
      const { protocol } = await tempProtocol();
      const fixture = await heldWaitFixture(protocol);
      const service = serviceRecorder(specimen.service);
      await assert.rejects(handleCodexHook(
        postInput(fixture.rewrittenInput, fixture.toolResponse),
        {
          protocol,
          clock: CLOCK,
          credentials: CREDENTIALS,
          serviceClient: service.client,
        },
      ), specimen.error);

      assert.deepEqual(service.sequence, ['self']);
      assert.deepEqual(service.calls, []);
      assert.equal(await protocol.readToolResultReturned(fixture.delivery, fixture.result), null);
      assert.equal(await protocol.readToolError(fixture.request), null);
      assert.equal(await protocol.readAwaitRequestTerminal(fixture.request), null);
      assert.deepEqual(await protocol.listAwaitRequests(), [fixture.request]);
      assert.equal(
        (await fixture.claimStore.resolve(fixture.claim, fixture.binding)).state,
        'pending',
      );
    });
  }
});

test('attempt-bearing PostToolUse error is fenced before any lifecycle write or stateful call', async (t) => {
  for (const specimen of [
    {
      label: 'replacement installation',
      service: { installation: { ...CREDENTIALS.installation, id: 'installation-2' } },
      error: /installation_identity_fence_mismatch/,
    },
    {
      label: 'unavailable authenticated self',
      service: { selfError: new Error('self_unavailable') },
      error: /self_unavailable/,
    },
  ]) {
    await t.test(specimen.label, async () => {
      const { protocol } = await tempProtocol();
      const fixture = await heldWaitFixture(protocol);
      const service = serviceRecorder(specimen.service);
      const response = {
        content: [{ type: 'text', text: 'Held wait failed.' }],
        isError: true,
      };
      await assert.rejects(handleCodexHook(
        postInput(fixture.rewrittenInput, response),
        {
          protocol,
          clock: CLOCK,
          credentials: CREDENTIALS,
          serviceClient: service.client,
        },
      ), specimen.error);

      assert.deepEqual(service.sequence, ['self']);
      assert.deepEqual(service.calls, []);
      assert.equal(await protocol.readToolError(fixture.request), null);
      assert.equal(await protocol.readAwaitRequestTerminal(fixture.request), null);
      assert.deepEqual(await protocol.listAwaitRequests(), [fixture.request]);
    });
  }
});

test('PostToolUse preserves the exact return and defers a stale or transient observation', async () => {
  for (const error of [
    Object.assign(new Error('wake_lease_stale'), { status: 409, code: 'wake_lease_stale' }),
    Object.assign(new Error('network reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('service unavailable'), { status: 503 }),
  ]) {
    const { protocol } = await tempProtocol();
    const fixture = await heldWaitFixture(protocol);
    const service = serviceRecorder({ error });
    const handled = await handleCodexHook(
      postInput(fixture.rewrittenInput, fixture.toolResponse),
      {
        protocol,
        clock: CLOCK,
        credentials: CREDENTIALS,
        serviceClient: service.client,
      },
    );
    assert.equal(handled.accepted, true);
    assert.equal(handled.reason, 'tool_result_observation_deferred');
    assert.ok(await protocol.readToolResultReturned(fixture.delivery, fixture.result));
    assert.equal(
      (await fixture.claimStore.resolve(fixture.claim, fixture.binding)).state,
      'pending',
    );
  }
});

test('PostToolUse command exits zero and silent after durably deferring a transient API outage', async () => {
  const { dataDir, protocol } = await tempProtocol();
  const fixture = await heldWaitFixture(protocol);
  const server = createServer((request, response) => {
    if (request.url === '/api/hark/v2/installations/self') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        v: 'hark.installation-status.v2',
        installation: CREDENTIALS.installation,
      }));
      return;
    }
    assert.match(request.url, /\/api\/hark\/v2\/awaits\/.*\/runtime-receipts/);
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'service_unavailable' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    await new HarkCredentialsStore(dataDir).save({
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
      accessToken: CREDENTIALS.accessToken,
      installation: CREDENTIALS.installation,
    });
    const child = spawn(process.execPath, [path.join(ROOT, 'hooks/ingress.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        HARK_DATA_DIR: dataDir,
        HARK_ALLOW_INSECURE_LOOPBACK: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify(postInput(fixture.rewrittenInput, fixture.toolResponse)));
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
    assert.ok(await protocol.readToolResultReturned(fixture.delivery, fixture.result));
    assert.equal(
      (await fixture.claimStore.resolve(fixture.claim, fixture.binding)).state,
      'pending',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('PostToolUse fails closed on a malformed acknowledgement after durable local return', async () => {
  const { protocol } = await tempProtocol();
  const fixture = await heldWaitFixture(protocol);
  const service = serviceRecorder({ response: {
    v: 'hark.runtime-receipt-result.v2',
    awaitId: 'wrong-await',
    kind: 'tool_result_observed',
  } });
  await assert.rejects(handleCodexHook(
    postInput(fixture.rewrittenInput, fixture.toolResponse),
    {
      protocol,
      clock: CLOCK,
      credentials: CREDENTIALS,
      serviceClient: service.client,
    },
  ), /tool_result_observation_ack_field_required:(state|wakeState)|tool_result_observation_ack_mismatch/);
  assert.ok(await protocol.readToolResultReturned(fixture.delivery, fixture.result));
  assert.equal(
    (await fixture.claimStore.resolve(fixture.claim, fixture.binding)).state,
    'pending',
  );
});

test('PostToolUse resolves one ambiguous 409 only from exact remote certification', async () => {
  const { protocol } = await tempProtocol();
  const fixture = await heldWaitFixture(protocol);
  const service = serviceRecorder({
    error: Object.assign(new Error('runtime_lifecycle_receipt_already_recorded'), {
      status: 409,
      code: 'runtime_lifecycle_receipt_already_recorded',
    }),
    certification: observedCertification(fixture),
  });
  const handled = await handleCodexHook(
    postInput(fixture.rewrittenInput, fixture.toolResponse),
    {
      protocol,
      clock: CLOCK,
      credentials: CREDENTIALS,
      serviceClient: service.client,
    },
  );
  assert.equal(handled.accepted, true);
  assert.equal(handled.reason, undefined);
  assert.equal(service.calls.length, 1);
  assert.equal(
    (await fixture.claimStore.resolve(fixture.claim, fixture.binding)).state,
    'consumed',
  );
});

test('PostToolUse refuses a private claim record whose mode exposes the lease', async () => {
  const { protocol } = await tempProtocol();
  const fixture = await heldWaitFixture(protocol);
  const pendingPath = path.join(
    protocol.dataDir,
    'private-held-claims',
    'pending',
    `${fixture.claim.locator}.json`,
  );
  await chmod(pendingPath, 0o644);
  const service = serviceRecorder();
  await assert.rejects(handleCodexHook(
    postInput(fixture.rewrittenInput, fixture.toolResponse),
    {
      protocol,
      clock: CLOCK,
      credentials: CREDENTIALS,
      serviceClient: service.client,
    },
  ), /private_claim_record_permissions_invalid/);
  assert.deepEqual(service.calls, []);
  assert.equal(await protocol.readToolResultReturned(fixture.delivery, fixture.result), null);
});

test('PostToolUse rejects missing or mismatched claim, boundary, result, and rewritten input', async () => {
  const cases = [
    {
      label: 'missing host metadata',
      mutate: (fixture) => { delete fixture.toolResponse._meta; },
      error: /tool_response_field_required:_meta/,
    },
    {
      label: 'claim binding substitution',
      mutate: (fixture) => {
        fixture.toolResponse._meta['cash.dexter.hark/claim'].bindingDigest = '0'.repeat(64);
      },
      error: /private_claim_reference_binding_mismatch/,
    },
    {
      label: 'claim digest missing',
      mutate: (fixture) => {
        delete fixture.toolResponse._meta['cash.dexter.hark/claim'].wakeDeliveryDigest;
      },
      error: /private_claim_reference_field_required:wakeDeliveryDigest/,
    },
    {
      label: 'claim locator substitution',
      mutate: (fixture) => {
        fixture.toolResponse._meta['cash.dexter.hark/claim'].locator = `hhc_${'a'.repeat(43)}`;
      },
      error: /tool_result_observation_claim_reference_mismatch|private_claim_missing/,
    },
    {
      label: 'private data smuggled into MCP metadata',
      mutate: (fixture) => {
        fixture.toolResponse._meta['cash.dexter.hark/claim'].leaseToken = fixture.leaseToken;
      },
      error: /private_claim_reference_field_unsupported:leaseToken/,
    },
    {
      label: 'persisted boundary conversation mismatch',
      mutate: (_fixture, protocol) => {
        const readTranscriptBoundary = protocol.readTranscriptBoundary.bind(protocol);
        protocol.readTranscriptBoundary = async (...args) => {
          const record = await readTranscriptBoundary(...args);
          return {
            ...record,
            boundary: { ...record.boundary, conversationId: 'other' },
          };
        };
      },
      error: /transcript_boundary_conversationId_mismatch/,
    },
    {
      label: 'result mismatch',
      mutate: (fixture) => { fixture.toolResponse.structuredContent.wake.wakeId = 'other-wake'; },
      error: /tool_wait_result_delivery_mismatch/,
    },
    {
      label: 'public input rewrite',
      mutate: (fixture) => { fixture.rewrittenInput.request = 'Changed by another hook.'; },
      error: /tool_wait_post_use_input_mismatch/,
    },
  ];
  for (const specimen of cases) {
    const { protocol } = await tempProtocol();
    const fixture = await heldWaitFixture(protocol);
    specimen.mutate(fixture, protocol);
    const service = serviceRecorder();
    await assert.rejects(handleCodexHook(
      postInput(fixture.rewrittenInput, fixture.toolResponse),
      {
        protocol,
        clock: CLOCK,
        credentials: CREDENTIALS,
        serviceClient: service.client,
      },
    ), specimen.error, specimen.label);
    assert.deepEqual(service.calls, [], specimen.label);
    assert.equal(await protocol.readToolResultReturned(fixture.delivery, fixture.result), null);
  }
});

test('Codex wrapper installs PreToolUse before PostToolUse for only hark_await', async () => {
  const hooks = JSON.parse(await readFile(path.join(CODEX_ROOT, 'hooks/hooks.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(path.join(CODEX_ROOT, '.mcp.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks), [
    'SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit',
  ]);
  assert.equal(Object.hasOwn(hooks.hooks, 'Stop'), false);
  assert.equal(hooks.hooks.PreToolUse[0].matcher, 'mcp__hark__hark_await');
  assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /hooks\/ingress\.mjs/);
  assert.equal(hooks.hooks.PreToolUse[0].hooks[0].timeout, 10);
  assert.equal(hooks.hooks.PostToolUse[0].matcher, 'mcp__hark__hark_await');
  assert.match(hooks.hooks.PostToolUse[0].hooks[0].command, /hooks\/ingress\.mjs/);
  assert.equal(hooks.hooks.PostToolUse[0].hooks[0].timeout, 40);
  assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /hooks\/prompt-guard\.mjs/);
  assert.equal(mcp.mcpServers.hark.cwd, '.');
  assert.deepEqual(mcp.mcpServers.hark.args, ['./hark/mcp/server.mjs']);
});
