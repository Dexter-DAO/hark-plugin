import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Canonical } from '../lib/canonical.mjs';
import { HarkApiError, HarkServiceClient } from '../lib/service-client.mjs';

const AWAIT_ID = '11111111-1111-4111-8111-111111111111';
const INSTALLATION_ID = '22222222-2222-4222-8222-222222222222';
const WAKE_ID = '33333333-3333-4333-8333-333333333333';

function crashRecoveryRequest() {
  return {
    v: 'hark.crash-recovery-claim.v1',
    awaitId: AWAIT_ID,
    installation: {
      id: INSTALLATION_ID,
      protocol: 'codex',
      runtimeId: 'codex-runtime-1',
    },
    wake: { wakeId: WAKE_ID, wakeDeliveryDigest: 'a'.repeat(64) },
    origin: {
      protocol: 'codex',
      runtimeId: 'codex-runtime-1',
      taskId: 'turn-42',
      conversationId: 'thread-42',
    },
    binding: {
      continuationMode: 'held_tool',
      toolName: 'mcp__hark__hark_await',
      toolUseId: 'tool-use-42',
      inputDigest: 'b'.repeat(64),
    },
    checkpointDigest: 'c'.repeat(64),
    qualificationDigest: 'd'.repeat(64),
    proof: {
      v: 'hark.held-call-origin-abort-ref.v1',
      originAbortReceiptDigest: 'e'.repeat(64),
      appServerTerminalEvidenceDigest: 'f'.repeat(64),
      rolloutAbortProofDigest: '1'.repeat(64),
    },
  };
}

function crashRecoveryResult(request, overrides = {}) {
  return {
    v: 'hark.crash-recovery-claim-result.v1',
    wake: {
      v: 'hark.wake.v2',
      wakeId: request.wake.wakeId,
      idempotencyKey: request.wake.wakeId,
      awaitId: request.awaitId,
      origin: request.origin,
      checkpoint: {
        version: 'hark.codex-checkpoint.v1',
        digest: request.checkpointDigest,
      },
      prepared: { qualificationDigest: request.qualificationDigest },
      signal: {},
      createdAt: '2026-08-08T00:00:00.000Z',
    },
    claim: {
      continuationMode: 'crash_recovery',
      leaseToken: '44444444-4444-4444-8444-444444444444',
      leaseGeneration: 2,
      leaseExpiresAt: '2026-08-08T00:00:30.000Z',
      disposition: 'recover_waiter',
      wakeDeliveryDigest: request.wake.wakeDeliveryDigest,
      recoveryProofDigest: sha256Canonical(request),
    },
    replay: false,
    ...overrides,
  };
}

function response(status, body = undefined) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

test('requires HTTPS and limits explicit insecure development to exact loopback hosts', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return response(500, {});
  };
  for (const baseUrl of [
    'http://api.example.test',
    'http://127.0.0.2:3030',
    'http://localhost.example.test:3030',
    'ftp://127.0.0.1',
  ]) {
    assert.throws(
      () => new HarkServiceClient({
        baseUrl,
        accessToken: 'must-not-leak',
        allowInsecureLoopback: true,
        fetchImpl,
      }),
      /hark_api_https_required/,
    );
  }
  assert.equal(fetchCalls, 0);

  const requests = [];
  const local = new HarkServiceClient({
    baseUrl: 'http://127.0.0.1:3030/',
    accessToken: 'local-secret',
    allowInsecureLoopback: true,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response(200, {
        v: 'hark.installation-status.v2',
        installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
      });
    },
  });
  await local.getInstallationStatus();
  assert.equal(requests[0].url, 'http://127.0.0.1:3030/api/hark/v2/installations/self');
  assert.equal(requests[0].init.headers.authorization, 'Bearer local-secret');
  assert.equal(requests[0].init.redirect, 'error');

  const rebound = local.withAccessToken('replacement-secret');
  assert.equal(rebound.baseUrl, local.baseUrl);
  assert.equal(rebound.allowInsecureLoopback, true);
});

test('rejects insecure loopback unless development mode is explicitly enabled', () => {
  for (const baseUrl of ['http://localhost:3030', 'http://127.0.0.1', 'http://[::1]:3030']) {
    assert.throws(
      () => new HarkServiceClient({ baseUrl, fetchImpl: async () => response(204) }),
      /hark_api_https_required/,
    );
    assert.doesNotThrow(
      () => new HarkServiceClient({
        baseUrl,
        allowInsecureLoopback: true,
        fetchImpl: async () => response(204),
      }),
    );
  }
});

test('rejects credentials embedded in the API URL', () => {
  assert.throws(
    () => new HarkServiceClient({ baseUrl: 'https://user:secret@api.example.test' }),
    /hark_api_url_credentials_forbidden/,
  );
});

test('uses unauthenticated v2 device exchange and never leaks a bearer header', async () => {
  const requests = [];
  const client = new HarkServiceClient({
    baseUrl: 'https://api.example.test/',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/device-codes')) {
        return response(201, {
          v: 'hark.installation-device-code-result.v2', deviceCode: 'secret', userCode: 'ABCD-EFGH',
        });
      }
      return response(200, {
        v: 'hark.installation-token.v2', accessToken: 'hki_secret',
        installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
      });
    },
  });
  await client.createDeviceCode({ runtimeId: 'runtime-1', name: 'Laptop' });
  await client.exchangeDeviceCode('secret');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers.authorization, undefined);
  assert.equal(requests[1].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    v: 'hark.installation-device-code.v2',
    installation: { protocol: 'codex', runtimeId: 'runtime-1', name: 'Laptop' },
  });
});

test('binds strict arm, commit, wake, receipt, and certification routes', async () => {
  const requests = [];
  const queue = [
    [201, { v: 'hark.await-arm-result.v2', await: { id: 'await-1' }, replay: false }],
    [201, { v: 'hark.suspension-receipt.v2', awaitId: 'await-1', replay: false }],
    [200, {
      v: 'hark.wake-next-result.v2',
      wake: { wakeId: 'wake-1' },
      claim: { leaseToken: 'lease-1', leaseGeneration: 1 },
    }],
    [200, {
      v: 'hark.await-wake-result.v2',
      wake: { wakeId: 'wake-held-1' },
      claim: { continuationMode: 'held_tool', wakeDeliveryDigest: 'a'.repeat(64) },
    }],
    [201, { v: 'hark.runtime-receipt-result.v2', awaitId: 'await-1', kind: 'wake_received' }],
    [200, { v: 'hark.await-certification.v2', awaitId: 'await-1', certified: true }],
  ];
  const client = new HarkServiceClient({
    baseUrl: 'https://api.example.test',
    accessToken: 'hki_secret',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const [status, body] = queue.shift();
      return response(status, body);
    },
  });
  await client.armAwait({ v: 'hark.await.v2' });
  await client.commitAwait('await-1', { v: 'hark.suspension-commit.v2' });
  assert.equal((await client.nextWake({ waitSeconds: 25 })).wake.wakeId, 'wake-1');
  assert.equal((await client.waitForAwait('await-1', {
    v: 'hark.await-wake-claim.v2', leaseToken: 'waiter-secret', leaseGeneration: 1,
  }, { waitSeconds: 25 })).wake.wakeId, 'wake-held-1');
  await client.recordRuntimeReceipt('await-1', { v: 'hark.runtime-receipt.v2' });
  await client.certifyAwait('await-1');
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
    '/api/hark/v2/awaits',
    '/api/hark/v2/awaits/await-1/commit',
    '/api/hark/v2/wakes/next',
    '/api/hark/v2/awaits/await-1/wake',
    '/api/hark/v2/awaits/await-1/runtime-receipts',
    '/api/hark/v2/awaits/await-1/certification',
  ]);
  assert.ok(requests.every((request) => request.init.headers.authorization === 'Bearer hki_secret'));
});

test('posts one exact proof-bound crash claim and accepts byte-identical replay', async () => {
  const input = crashRecoveryRequest();
  const requests = [];
  let call = 0;
  const client = new HarkServiceClient({
    baseUrl: 'https://api.example.test',
    accessToken: 'hki_secret',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      call += 1;
      return response(call === 1 ? 201 : 200, crashRecoveryResult(input, {
        replay: call > 1,
      }));
    },
  });
  const first = await client.claimCrashRecovery(AWAIT_ID, input);
  const replay = await client.claimCrashRecovery(AWAIT_ID, input);
  assert.equal(first.replay, false);
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.claim, first.claim);
  assert.equal(requests.length, 2);
  assert.equal(
    new URL(requests[0].url).pathname,
    `/api/hark/v2/awaits/${AWAIT_ID}/crash-recovery-claim`,
  );
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.authorization, 'Bearer hki_secret');
  assert.equal(requests[0].init.body, requests[1].init.body);
  assert.deepEqual(JSON.parse(requests[0].init.body), input);
});

test('rejects malformed crash claims before the first network call', async () => {
  const input = crashRecoveryRequest();
  let calls = 0;
  const client = new HarkServiceClient({
    accessToken: 'hki_secret',
    fetchImpl: async () => {
      calls += 1;
      return response(500, {});
    },
  });
  const withoutProofDigest = structuredClone(input);
  delete withoutProofDigest.proof.rolloutAbortProofDigest;
  for (const changed of [
    { ...input, extra: true },
    { ...input, awaitId: 'not-a-uuid' },
    { ...input, installation: { ...input.installation, id: 'not-a-uuid' } },
    { ...input, origin: { ...input.origin, runtimeId: 'other-runtime' } },
    { ...input, binding: { ...input.binding, continuationMode: 'crash_recovery' } },
    { ...input, wake: { ...input.wake, wakeDeliveryDigest: 'A'.repeat(64) } },
    withoutProofDigest,
  ]) {
    await assert.rejects(
      async () => client.claimCrashRecovery(AWAIT_ID, changed),
      /crash_recovery_/,
    );
  }
  assert.equal(calls, 0);
});

test('fails closed on substituted targeted-claim responses', async () => {
  const input = crashRecoveryRequest();
  const mutations = [
    (value) => { value.extra = true; },
    (value) => { value.v = 'hark.crash-recovery-claim-result.v2'; },
    (value) => { value.replay = 'yes'; },
    (value) => { value.wake.wakeId = '99999999-9999-4999-8999-999999999999'; },
    (value) => { value.wake.awaitId = '99999999-9999-4999-8999-999999999999'; },
    (value) => { value.wake.origin.taskId = 'other-turn'; },
    (value) => { value.wake.checkpoint.digest = '9'.repeat(64); },
    (value) => { value.wake.prepared.qualificationDigest = '8'.repeat(64); },
    (value) => { value.claim.continuationMode = 'held_tool'; },
    (value) => { value.claim.leaseToken = 'not-a-uuid'; },
    (value) => { value.claim.leaseGeneration = 0; },
    (value) => { value.claim.leaseExpiresAt = 'not-a-time'; },
    (value) => { value.claim.disposition = 'recover_dispatch'; },
    (value) => { value.claim.wakeDeliveryDigest = '7'.repeat(64); },
    (value) => { value.claim.recoveryProofDigest = '6'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const body = crashRecoveryResult(input);
    mutate(body);
    const client = new HarkServiceClient({
      accessToken: 'hki_secret',
      fetchImpl: async () => response(200, body),
    });
    await assert.rejects(
      client.claimCrashRecovery(AWAIT_ID, input),
      /crash_recovery_/,
    );
  }
});

test('checks its installation credential without touching the wake queue', async () => {
  let request;
  const client = new HarkServiceClient({
    baseUrl: 'https://api.example.test',
    accessToken: 'hki_secret',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(200, {
        v: 'hark.installation-status.v2',
        installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
      });
    },
  });
  assert.equal((await client.getInstallationStatus()).installation.runtimeId, 'runtime-1');
  assert.equal(new URL(request.url).pathname, '/api/hark/v2/installations/self');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.headers.authorization, 'Bearer hki_secret');
});

test('treats 204 as an empty wake and preserves structured API failures', async () => {
  const noWake = new HarkServiceClient({
    accessToken: 'token', fetchImpl: async () => response(204),
  });
  assert.equal(await noWake.nextWake({ waitSeconds: 0 }), null);

  const failing = new HarkServiceClient({
    accessToken: 'token', fetchImpl: async () => response(409, {
      v: 'hark.error.v2', error: 'await_checkpoint_mismatch', details: { expected: 'a' },
    }),
  });
  await assert.rejects(
    failing.getAwait('await-1'),
    (error) => error instanceof HarkApiError
      && error.status === 409
      && error.code === 'await_checkpoint_mismatch'
      && error.details.expected === 'a',
  );
});

test('fails closed on response version drift', async () => {
  const client = new HarkServiceClient({
    accessToken: 'token',
    fetchImpl: async () => response(200, { v: 'hark.wake-next-result.v3', wake: {}, claim: {} }),
  });
  await assert.rejects(client.nextWake({ waitSeconds: 0 }), /hark_response_version/);
});
