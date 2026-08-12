import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners } from 'node:events';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  armApiResponse,
  commitApiResponse,
} from './api-response-fixtures.mjs';
import { HarkToolWaitProtocol } from '../lib/tool-wait-protocol.mjs';
import {
  CLAIM_META_KEY,
  executeHeldAwait,
  handleMcpMessage,
  retryDelay,
} from '../mcp/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = '019fdb40-d729-7012-bd07-305032f8ede1';
const TURN = '019fdb40-d874-7122-9af5-2f9409508e53';
const TOOL_USE = 'call_hark_wait_1';
const INSTALLATION = Object.freeze({
  id: 'installation-1',
  protocol: 'codex',
  runtimeId: 'runtime-1',
});
const CREDENTIALS = Object.freeze({
  apiBaseUrl: 'https://api.example.test',
  accessToken: 'hki_secret',
  installation: INSTALLATION,
});
const INPUT = {
  request: 'Continue after job 42.',
  name: 'Job 42',
  source: { kind: 'job.completed', adapter: 'webhook.v1', subject: 'job-42' },
  condition: { status: { equals: 'completed' } },
};

function line(type, payload) {
  return `${JSON.stringify({ timestamp: '2026-08-07T12:00:00.000Z', type, payload })}\n`;
}

async function exchange(requests) {
  const child = spawn(process.execPath, [path.join(ROOT, 'mcp/server.mjs')], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const responses = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const lineValue = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (lineValue.trim()) responses.push(JSON.parse(lineValue));
    }
  });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`server exited ${code}`)));
  });
  return responses;
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('wait_until_timeout');
}

async function environment(options = {}) {
  const cliVersion = Object.hasOwn(options, 'cliVersion')
    ? options.cliVersion
    : '0.147.0';
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-mcp-held-'));
  const codexHome = path.join(directory, 'codex-home');
  const sessionDirectory = path.join(codexHome, 'sessions', '2026', '08', '07');
  await mkdir(sessionDirectory, { recursive: true });
  const transcriptPath = path.join(sessionDirectory, `rollout-${SESSION}.jsonl`);
  await writeFile(transcriptPath, [
    line('session_meta', {
      id: SESSION,
      ...(cliVersion === undefined ? {} : { cli_version: cliVersion }),
    }),
    line('turn_context', { turn_id: TURN }),
    line('response_item', {
      type: 'function_call',
      call_id: TOOL_USE,
      namespace: 'hark',
      name: 'hark_await',
      arguments: JSON.stringify(INPUT),
    }),
  ].join(''));
  const protocol = new HarkToolWaitProtocol(directory);
  const admission = await protocol.publishAdmission({
    sessionId: SESSION,
    turnId: TURN,
    toolUseId: TOOL_USE,
    toolName: 'mcp__hark__hark_await',
    transcriptPath,
    originalInput: INPUT,
  });
  return { directory, codexHome, transcriptPath, protocol, admission };
}

async function assertNoStatefulProgression(protocol, request, armAttempt = null) {
  assert.equal(await protocol.readArmBinding(request), null);
  assert.equal(await protocol.readTranscriptBoundary(request), null);
  assert.equal(await protocol.readWaiterReady(request), null);
  assert.equal(await protocol.readCommitAttempt(request), null);
  assert.equal(await protocol.readSuspensionCommitted(request), null);
  assert.equal(await protocol.readWakeDelivery(request), null);
  assert.equal(await protocol.readToolError(request), null);
  assert.equal(await protocol.readAwaitRequestTerminal(request), null);
  if (armAttempt) {
    assert.equal(
      await protocol.readHeldCallTransitionAuthority(request, armAttempt),
      null,
    );
  }
  assert.deepEqual(await protocol.listAwaitRequests(), [request]);
}

class FakeHeldService {
  calls = [];
  sequence = [];

  constructor(options = {}) {
    this.installations = options.installations ?? [INSTALLATION];
    this.selfError = options.selfError ?? null;
    this.selfReads = 0;
  }

  async getInstallationStatus() {
    this.sequence.push('self');
    if (this.selfError) throw this.selfError;
    const installation = this.installations[
      Math.min(this.selfReads, this.installations.length - 1)
    ];
    this.selfReads += 1;
    return { v: 'hark.installation-status.v2', installation };
  }

  async armAwait(body) {
    this.sequence.push('arm');
    this.calls.push(['arm', body]);
    this.arm = body;
    return armApiResponse(body, {
      leaseToken: 'waiter-lease-secret',
      leaseExpiresAt: '2026-08-07T12:01:00.000Z',
    });
  }

  async commitAwait(awaitId, body) {
    this.sequence.push('commit');
    this.calls.push(['commit', awaitId, body]);
    return commitApiResponse({
      armRequest: this.arm,
      commitRequest: body,
      awaitId,
    });
  }

  async waitForAwait(awaitId, body, options) {
    this.sequence.push('wait');
    this.calls.push(['wait', awaitId, body, options.waitSeconds]);
    return {
      v: 'hark.await-wake-result.v2',
      wake: {
        v: 'hark.wake.v2',
        wakeId: 'wake-1',
        idempotencyKey: 'wake-key-1',
        awaitId,
        origin: this.arm.origin,
        checkpoint: this.arm.checkpoint,
        prepared: this.arm.prepared,
        signal: {
          id: 'signal-1',
          sourceSignalId: 'source-signal-1',
          type: this.arm.predicate.type,
          subject: this.arm.predicate.subject,
          qualificationDigest: this.arm.predicate.qualificationDigest,
          sourceAdapter: 'webhook.v1',
          authMode: 'source_hmac',
          observedAt: '2026-08-07T12:00:02.000Z',
          summary: 'Job 42 completed.',
          data: { status: 'completed' },
          evidence: [],
        },
        createdAt: '2026-08-07T12:00:02.000Z',
      },
      claim: {
        continuationMode: 'held_tool',
        leaseGeneration: 1,
        leaseExpiresAt: '2026-08-07T12:01:30.000Z',
        wakeDeliveryDigest: 'a'.repeat(64),
        disposition: 'deliver_tool_result',
        replay: false,
      },
      replay: false,
    };
  }
}

test('lists only the elegant one-call durable wait tool', async () => {
  const responses = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  assert.equal(responses[0].result.serverInfo.name, 'hark');
  assert.equal(responses[0].result.serverInfo.version, '0.1.10');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['hark_await']);
  assert.deepEqual(responses[1].result.tools[0].inputSchema.required, [
    'request', 'name', 'source', 'condition',
  ]);
  assert.equal(responses[1].result.tools[0].annotations.readOnlyHint, false);
  assert.match(responses[1].result.tools[0].description, /same tool call/);
});

test('negotiates only the protocol version implemented by the server', async () => {
  const initialized = await handleMcpMessage({
    method: 'initialize',
    params: { protocolVersion: '2099-12-31' },
  });
  assert.equal(initialized.protocolVersion, '2025-06-18');
});

test('arms, commits, and returns one authenticated wake through the held call', async () => {
  const value = await environment();
  const service = new FakeHeldService();
  const result = await executeHeldAwait(value.admission.rewrittenInput, {
    protocol: value.protocol,
    serviceClient: service,
    codexHome: value.codexHome,
    credentials: CREDENTIALS,
    randomBytes: (size) => Buffer.alloc(size, 0x11),
  });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.v, 'hark.await-satisfied.v1');
  assert.equal(result.structuredContent.wake.wakeId, 'wake-1');
  assert.equal(result.structuredContent.wake.awaitId, 'await-1');
  assert.deepEqual({
    sourceAdapter: result.structuredContent.wake.signal.sourceAdapter,
    authMode: result.structuredContent.wake.signal.authMode,
  }, {
    sourceAdapter: 'webhook.v1',
    authMode: 'source_hmac',
  });
  assert.equal(JSON.stringify(result.structuredContent).includes('waiter-lease-secret'), false);
  assert.equal(JSON.stringify(result.structuredContent).includes('wakeDeliveryDigest'), false);
  const claim = result._meta[CLAIM_META_KEY];
  assert.deepEqual(Object.keys(result._meta), [CLAIM_META_KEY]);
  assert.deepEqual(Object.keys(claim), [
    'v', 'locator', 'bindingDigest', 'wakeDeliveryDigest', 'toolResultDigest',
  ]);
  assert.equal(claim.v, 'hark.codex-held-claim-ref.v1');
  assert.match(claim.locator, /^hhc_[A-Za-z0-9_-]{43}$/);
  assert.equal(claim.wakeDeliveryDigest, 'a'.repeat(64));
  const delivery = await value.protocol.readWakeDelivery(value.admission.admission.eventId);
  assert.equal(delivery.wakeDeliveryDigest, claim.wakeDeliveryDigest);
  const persistedBoundary = await value.protocol.readTranscriptBoundary(
    value.admission.admission.eventId,
  );
  const intent = await value.protocol.readToolResultObservationIntent(
    delivery,
    result.structuredContent,
    persistedBoundary.boundary,
    'runtime-1',
    claim,
  );
  assert.equal(intent.kind, 'tool_result_observation_intent');
  assert.equal(intent.claimReference.locator, claim.locator);
  assert.equal(intent.publicReceipt.toolResultObservation.observationMode, 'direct');
  const intentRaw = await readFile(path.join(
    value.protocol.observationIntentDirectory,
    `${value.admission.admission.eventId}.json`,
  ), 'utf8');
  for (const forbidden of ['waiter-lease-secret', 'waiter-1', 'leaseToken', 'accessToken']) {
    assert.equal(intentRaw.includes(forbidden), false, forbidden);
  }
  const serializedResult = JSON.stringify({ jsonrpc: '2.0', id: 7, result });
  for (const forbidden of [
    'waiter-lease-secret', 'waiter-1', 'leaseToken', 'leaseGeneration',
    'transcriptPath', value.transcriptPath, TURN, TOOL_USE,
  ]) assert.equal(serializedResult.includes(forbidden), false, forbidden);
  const claimRoot = path.join(value.directory, 'private-held-claims');
  const pendingDirectory = path.join(claimRoot, 'pending');
  assert.equal((await stat(claimRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(pendingDirectory)).mode & 0o777, 0o700);
  const pendingFiles = await readdir(pendingDirectory);
  assert.deepEqual(pendingFiles, [`${claim.locator}.json`]);
  const pendingPath = path.join(pendingDirectory, pendingFiles[0]);
  assert.equal((await stat(pendingPath)).mode & 0o777, 0o600);
  const privateRecord = await readFile(pendingPath, 'utf8');
  assert.equal(privateRecord.includes('waiter-lease-secret'), true);
  assert.deepEqual(service.calls.map((call) => call[0]), ['arm', 'commit', 'wait']);
  for (const method of ['arm', 'commit']) {
    const index = service.sequence.indexOf(method);
    assert.ok(index > 0, `${method} was called`);
    assert.equal(service.sequence[index - 1], 'self', `${method} follows authenticated self`);
  }
  const request = await value.protocol.readAwaitRequest(value.admission.admission.eventId);
  const armAttempt = await value.protocol.readArmAttempt(request);
  assert.equal(armAttempt.v, 'hark.tool-wait.arm-attempt.v2');
  assert.equal(armAttempt.installationId, INSTALLATION.id);
  assert.equal(service.calls[0][1].binding.continuationMode, 'held_tool');
  assert.equal(service.calls[0][1].binding.toolUseId, TOOL_USE);
  assert.equal(service.calls[0][1].origin.taskId, TURN);
  assert.equal(service.calls[2][2].leaseToken, 'waiter-lease-secret');

  await assert.rejects(
    executeHeldAwait(value.admission.rewrittenInput, {
      protocol: value.protocol,
      serviceClient: service,
      codexHome: value.codexHome,
      credentials: CREDENTIALS,
    }),
    /tool_wait_admission_replayed/,
  );
});

test('unavailable authenticated self fails before arm attempt and all stateful progression', async () => {
  const value = await environment();
  const service = new FakeHeldService({ selfError: new Error('self_unavailable') });
  await assert.rejects(executeHeldAwait(value.admission.rewrittenInput, {
    protocol: value.protocol,
    serviceClient: service,
    codexHome: value.codexHome,
    credentials: CREDENTIALS,
    randomBytes: (size) => Buffer.alloc(size, 0x11),
  }), /tool_error_persistence_failed_closed/);

  const request = await value.protocol.readAwaitRequest(value.admission.admission.eventId);
  assert.deepEqual(service.sequence, ['self']);
  assert.deepEqual(service.calls, []);
  assert.equal(await value.protocol.readArmAttempt(request), null);
  await assertNoStatefulProgression(value.protocol, request);
});

test('replacement installation after v2 attempt cannot arm or advance local lifecycle', async () => {
  const value = await environment();
  const replacement = { ...INSTALLATION, id: 'installation-2' };
  const service = new FakeHeldService({ installations: [INSTALLATION, replacement] });
  await assert.rejects(executeHeldAwait(value.admission.rewrittenInput, {
    protocol: value.protocol,
    serviceClient: service,
    codexHome: value.codexHome,
    credentials: CREDENTIALS,
    randomBytes: (size) => Buffer.alloc(size, 0x11),
  }), /tool_error_persistence_failed_closed/);

  const request = await value.protocol.readAwaitRequest(value.admission.admission.eventId);
  const armAttempt = await value.protocol.readArmAttempt(request);
  assert.deepEqual(service.sequence, ['self', 'self']);
  assert.deepEqual(service.calls, []);
  assert.equal(armAttempt.v, 'hark.tool-wait.arm-attempt.v2');
  assert.equal(armAttempt.installationId, INSTALLATION.id);
  await assertNoStatefulProgression(value.protocol, request, armAttempt);
});

test('never releases MCP success when durable observation intent persistence fails', async () => {
  const value = await environment();
  const service = new FakeHeldService();
  const publishIntent = value.protocol.publishToolResultObservationIntent.bind(value.protocol);
  let attempted = false;
  value.protocol.publishToolResultObservationIntent = async (...args) => {
    attempted = true;
    assert.equal(await value.protocol.readToolResultObservationIntent(
      args[0].delivery,
      args[0].result,
      args[0].transcriptBoundary,
      args[0].runtimeId,
      args[0].claimReference,
    ), null);
    throw new Error('observation_intent_fsync_failed');
  };
  await assert.rejects(executeHeldAwait(value.admission.rewrittenInput, {
    protocol: value.protocol,
    serviceClient: service,
    codexHome: value.codexHome,
    credentials: CREDENTIALS,
    randomBytes: (size) => Buffer.alloc(size, 0x11),
  }), /observation_intent_fsync_failed/);
  assert.equal(attempted, true);
  const delivery = await value.protocol.readWakeDelivery(value.admission.admission.eventId);
  assert.ok(delivery);
  assert.equal(await value.protocol.readToolResultObservationIntent(
    delivery,
    undefined,
    undefined,
    undefined,
    undefined,
  ), null);
  const toolError = await value.protocol.readToolError(value.admission.admission.eventId);
  assert.equal(toolError.failureCode, 'postcommit_failed');
  value.protocol.publishToolResultObservationIntent = publishIntent;
});

test('refuses missing, older, or future Codex rollout versions before remote arm', async () => {
  for (const cliVersion of [undefined, '0.146.1', '0.148.0']) {
    const value = await environment({ cliVersion });
    const service = new FakeHeldService();
    await assert.rejects(
      executeHeldAwait(value.admission.rewrittenInput, {
        protocol: value.protocol,
        serviceClient: service,
        codexHome: value.codexHome,
        credentials: CREDENTIALS,
        randomBytes: (size) => Buffer.alloc(size, 0x11),
      }),
      /codex_rollout_cli_version_(?:invalid|mismatch)/,
    );
    assert.deepEqual(service.calls, []);
  }
});

test('keeps one held call alive across transient transport failures and long polling', async () => {
  const value = await environment();
  const service = new FakeHeldService();
  const deliver = service.waitForAwait.bind(service);
  let attempt = 0;
  service.waitForAwait = async (...args) => {
    attempt += 1;
    if (attempt <= 2 || attempt === 7) {
      const error = new Error('temporary_transport_failure');
      error.name = attempt === 1 ? 'TimeoutError' : 'Error';
      if (attempt !== 1) error.code = 'ECONNRESET';
      throw error;
    }
    if (attempt <= 6) {
      service.calls.push(['wait', args[0], args[1], args[2].waitSeconds]);
      return null;
    }
    return deliver(...args);
  };
  const delays = [];
  const result = await executeHeldAwait(value.admission.rewrittenInput, {
    protocol: value.protocol,
    serviceClient: service,
    codexHome: value.codexHome,
    credentials: CREDENTIALS,
    randomBytes: (size) => Buffer.alloc(size, 0x11),
    retryDelay: async (ms, signal) => {
      assert.equal(signal?.aborted, false);
      delays.push(ms);
    },
  }, { signal: new AbortController().signal });

  assert.equal(result.structuredContent.wake.wakeId, 'wake-1');
  assert.equal(attempt, 8);
  assert.deepEqual(delays, [100, 200, 100]);
  assert.equal(
    service.calls.filter((call) => call[0] === 'wait').length,
    5,
  );
});

test('held-call retry remains immediately abortable', async () => {
  const value = await environment();
  const service = new FakeHeldService();
  const controller = new AbortController();
  service.waitForAwait = async () => {
    controller.abort();
    throw Object.assign(new Error('request_aborted'), { name: 'AbortError' });
  };
  let delayed = false;
  await assert.rejects(executeHeldAwait(value.admission.rewrittenInput, {
    protocol: value.protocol,
    serviceClient: service,
    codexHome: value.codexHome,
    credentials: CREDENTIALS,
    randomBytes: (size) => Buffer.alloc(size, 0x11),
    retryDelay: async () => { delayed = true; },
  }, { signal: controller.signal }), /request_aborted/);
  assert.equal(delayed, false);
});

test('never returns an MCP error after suspension while Hark still owns recovery', async () => {
  const value = await environment();
  const service = new FakeHeldService();
  let cancelCalled = false;
  service.waitForAwait = async () => {
    throw Object.assign(new Error('installation_revoked'), { status: 401 });
  };
  service.cancelAwait = async () => {
    cancelCalled = true;
    throw new Error('cancel_must_not_run_postcommit');
  };
  const controller = new AbortController();
  const pending = handleMcpMessage({
    method: 'tools/call',
    params: { name: 'hark_await', arguments: value.admission.rewrittenInput },
  }, {
    protocol: value.protocol,
    serviceClient: service,
    codexHome: value.codexHome,
    credentials: CREDENTIALS,
    randomBytes: (size) => Buffer.alloc(size, 0x11),
  }, { signal: controller.signal });

  const request = await waitUntil(async () => {
    const candidate = (await value.protocol.listAwaitRequests())[0];
    if (!candidate) return null;
    return await value.protocol.readSuspensionCommitted(candidate) ? candidate : null;
  });
  const outcome = await Promise.race([
    pending.then(() => 'returned', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('still-held'), 30)),
  ]);
  assert.equal(outcome, 'still-held');
  assert.equal(cancelCalled, false);
  assert.equal(await value.protocol.readAwaitRequestTerminal(request), null);
  assert.ok(await waitUntil(async () => {
    const toolError = await value.protocol.readToolError(request);
    if (!toolError) return null;
    return value.protocol.readToolErrorObservation(request, toolError);
  }));

  controller.abort();
  await assert.rejects(pending, /held_wait_aborted/);
});

test('transient retry delay removes its abort listener after success', async () => {
  const controller = new AbortController();
  await retryDelay(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('requires a valid API wake-delivery digest before persisting a local delivery', async () => {
  for (const [digest, error] of [
    [undefined, /wake_claim_field_required:wakeDeliveryDigest/],
    ['not-a-sha256', /wake_delivery_digest_invalid/],
  ]) {
    const value = await environment();
    const service = new FakeHeldService();
    const waitForAwait = service.waitForAwait.bind(service);
    service.waitForAwait = async (...args) => {
      const response = await waitForAwait(...args);
      if (digest === undefined) delete response.claim.wakeDeliveryDigest;
      else response.claim.wakeDeliveryDigest = digest;
      return response;
    };
    await assert.rejects(executeHeldAwait(value.admission.rewrittenInput, {
      protocol: value.protocol,
      serviceClient: service,
      codexHome: value.codexHome,
      credentials: CREDENTIALS,
      randomBytes: (size) => Buffer.alloc(size, 0x11),
    }), error);
    assert.equal(await value.protocol.readWakeDelivery(value.admission.admission.eventId), null);
  }
});

test('fails closed when durable delivery and API claim digests differ', async () => {
  const value = await environment();
  const publishWakeDelivery = value.protocol.publishWakeDelivery.bind(value.protocol);
  value.protocol.publishWakeDelivery = (request, armBinding, committed, wake) => (
    publishWakeDelivery(
      request,
      armBinding,
      committed,
      wake,
      'b'.repeat(64),
    )
  );
  await assert.rejects(executeHeldAwait(value.admission.rewrittenInput, {
    protocol: value.protocol,
    serviceClient: new FakeHeldService(),
    codexHome: value.codexHome,
    credentials: CREDENTIALS,
    randomBytes: (size) => Buffer.alloc(size, 0x11),
  }), /wake_delivery_digest_mismatch/);
});

test('fails closed when the trusted PreToolUse admission is absent or altered', async () => {
  let durableWrites = 0;
  const missing = await handleMcpMessage({
    method: 'tools/call',
    params: { name: 'hark_await', arguments: INPUT },
  }, {
    credentials: CREDENTIALS,
    serviceClient: {
      armAwait: async () => { durableWrites += 1; },
      commitAwait: async () => { durableWrites += 1; },
      waitForAwait: async () => { durableWrites += 1; },
    },
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /hark_host_adapter_required/);
  assert.equal(durableWrites, 0);

  const value = await environment();
  const altered = {
    ...value.admission.rewrittenInput,
    request: 'A model-supplied rewrite.',
  };
  const result = await handleMcpMessage({
    method: 'tools/call',
    params: { name: 'hark_await', arguments: altered },
  }, {
    protocol: value.protocol,
    serviceClient: new FakeHeldService(),
    codexHome: value.codexHome,
    credentials: CREDENTIALS,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /tool_wait_admission_input_mismatch/);
});
