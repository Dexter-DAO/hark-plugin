import { canonicalJson, sha256Canonical } from './canonical.mjs';

const DEFAULT_BASE_URL = 'https://api.dexter.cash';
const DEFAULT_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export class HarkApiError extends Error {
  constructor(status, code, details = undefined) {
    super(code || `hark_http_${status}`);
    this.name = 'HarkApiError';
    this.status = status;
    this.code = code || `hark_http_${status}`;
    this.details = details;
  }
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_object_required`);
  }
  return value;
}

function version(value, expected) {
  const body = object(value, 'hark_response');
  if (body.v !== expected) throw new Error(`hark_response_version:${String(body.v)}`);
  return body;
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}_required`);
  return value;
}

function exactKeys(value, keys, label) {
  const body = object(value, label);
  const actual = Object.keys(body).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) throw new Error(`${label}_shape_invalid`);
  return body;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`${label}_invalid`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function exact(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(`${label}_mismatch`);
}

function assertCrashRecoveryClaimRequest(value, awaitId) {
  const input = exactKeys(value, [
    'v', 'awaitId', 'installation', 'wake', 'origin', 'binding',
    'checkpointDigest', 'qualificationDigest', 'proof',
  ], 'crash_recovery_request');
  if (input.v !== 'hark.crash-recovery-claim.v1') {
    throw new Error('crash_recovery_request_version_invalid');
  }
  uuid(input.awaitId, 'crash_recovery_await_id');
  if (input.awaitId !== awaitId) throw new Error('crash_recovery_await_id_mismatch');
  const installation = exactKeys(
    input.installation,
    ['id', 'protocol', 'runtimeId'],
    'crash_recovery_installation',
  );
  uuid(installation.id, 'crash_recovery_installation_id');
  if (installation.protocol !== 'codex') throw new Error('crash_recovery_protocol_invalid');
  text(installation.runtimeId, 'crash_recovery_runtime_id');
  const wake = exactKeys(
    input.wake,
    ['wakeId', 'wakeDeliveryDigest'],
    'crash_recovery_wake',
  );
  uuid(wake.wakeId, 'crash_recovery_wake_id');
  digest(wake.wakeDeliveryDigest, 'crash_recovery_wake_delivery_digest');
  const origin = exactKeys(
    input.origin,
    ['protocol', 'runtimeId', 'taskId', 'conversationId'],
    'crash_recovery_origin',
  );
  if (origin.protocol !== 'codex') throw new Error('crash_recovery_origin_protocol_invalid');
  if (origin.runtimeId !== installation.runtimeId) {
    throw new Error('crash_recovery_origin_runtime_mismatch');
  }
  text(origin.taskId, 'crash_recovery_origin_task_id');
  text(origin.conversationId, 'crash_recovery_conversation_id');
  const binding = exactKeys(input.binding, [
    'continuationMode', 'toolName', 'toolUseId', 'inputDigest',
  ], 'crash_recovery_binding');
  if (binding.continuationMode !== 'held_tool') {
    throw new Error('crash_recovery_continuation_mode_invalid');
  }
  text(binding.toolName, 'crash_recovery_tool_name');
  text(binding.toolUseId, 'crash_recovery_tool_use_id');
  digest(binding.inputDigest, 'crash_recovery_input_digest');
  digest(input.checkpointDigest, 'crash_recovery_checkpoint_digest');
  digest(input.qualificationDigest, 'crash_recovery_qualification_digest');
  const proof = exactKeys(input.proof, [
    'v', 'originAbortReceiptDigest', 'appServerTerminalEvidenceDigest',
    'rolloutAbortProofDigest',
  ], 'crash_recovery_proof');
  if (proof.v !== 'hark.held-call-origin-abort-ref.v1') {
    throw new Error('crash_recovery_proof_version_invalid');
  }
  digest(proof.originAbortReceiptDigest, 'crash_recovery_abort_receipt_digest');
  digest(proof.appServerTerminalEvidenceDigest, 'crash_recovery_app_server_digest');
  digest(proof.rolloutAbortProofDigest, 'crash_recovery_rollout_digest');
  return input;
}

function assertCrashRecoveryClaimResult(value, request) {
  const result = exactKeys(value, ['v', 'wake', 'claim', 'replay'], 'crash_recovery_result');
  if (result.v !== 'hark.crash-recovery-claim-result.v1') {
    throw new Error('crash_recovery_result_version_invalid');
  }
  if (typeof result.replay !== 'boolean') throw new Error('crash_recovery_replay_invalid');
  const wake = object(result.wake, 'crash_recovery_result_wake');
  if (wake.v !== 'hark.wake.v2') throw new Error('crash_recovery_wake_version_invalid');
  uuid(wake.wakeId, 'crash_recovery_result_wake_id');
  uuid(wake.awaitId, 'crash_recovery_result_await_id');
  if (wake.wakeId !== request.wake.wakeId || wake.awaitId !== request.awaitId) {
    throw new Error('crash_recovery_result_wake_mismatch');
  }
  if (wake.idempotencyKey !== wake.wakeId) {
    throw new Error('crash_recovery_result_idempotency_mismatch');
  }
  exact(wake.origin, request.origin, 'crash_recovery_result_origin');
  if (wake.checkpoint?.digest !== request.checkpointDigest) {
    throw new Error('crash_recovery_result_checkpoint_mismatch');
  }
  if (wake.prepared?.qualificationDigest !== request.qualificationDigest) {
    throw new Error('crash_recovery_result_qualification_mismatch');
  }
  const claim = exactKeys(result.claim, [
    'continuationMode', 'leaseToken', 'leaseGeneration', 'leaseExpiresAt',
    'disposition', 'wakeDeliveryDigest', 'recoveryProofDigest',
  ], 'crash_recovery_result_claim');
  if (claim.continuationMode !== 'crash_recovery') {
    throw new Error('crash_recovery_result_mode_invalid');
  }
  uuid(claim.leaseToken, 'crash_recovery_result_lease_token');
  if (!Number.isSafeInteger(claim.leaseGeneration) || claim.leaseGeneration < 1) {
    throw new Error('crash_recovery_result_lease_generation_invalid');
  }
  timestamp(claim.leaseExpiresAt, 'crash_recovery_result_lease_expiry');
  if (!['recover_held_tool', 'recover_waiter'].includes(claim.disposition)) {
    throw new Error('crash_recovery_result_disposition_invalid');
  }
  if (claim.wakeDeliveryDigest !== request.wake.wakeDeliveryDigest) {
    throw new Error('crash_recovery_result_delivery_digest_mismatch');
  }
  digest(claim.wakeDeliveryDigest, 'crash_recovery_result_delivery_digest');
  const requestDigest = sha256Canonical(request);
  if (claim.recoveryProofDigest !== requestDigest) {
    throw new Error('crash_recovery_result_proof_digest_mismatch');
  }
  return result;
}

function normalizeBaseUrl(value, { allowInsecureLoopback = false } = {}) {
  let url;
  try {
    url = new URL(value || DEFAULT_BASE_URL);
  } catch {
    throw new Error('hark_api_url_invalid');
  }
  if (url.username || url.password) throw new Error('hark_api_url_credentials_forbidden');
  if (url.protocol !== 'https:') {
    if (
      url.protocol !== 'http:'
      || allowInsecureLoopback !== true
      || !LOOPBACK_HOSTNAMES.has(url.hostname)
    ) {
      throw new Error('hark_api_https_required');
    }
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class HarkServiceClient {
  constructor(options = {}) {
    this.allowInsecureLoopback = options.allowInsecureLoopback
      ?? process.env.HARK_ALLOW_INSECURE_LOOPBACK === '1';
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env.HARK_API_URL,
      { allowInsecureLoopback: this.allowInsecureLoopback },
    );
    this.accessToken = options.accessToken ?? null;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch_unavailable');
  }

  withAccessToken(accessToken) {
    return new HarkServiceClient({
      baseUrl: this.baseUrl,
      accessToken: text(accessToken, 'access_token'),
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      allowInsecureLoopback: this.allowInsecureLoopback,
    });
  }

  createDeviceCode({ runtimeId, name = undefined }, options = {}) {
    return this.#request('/api/hark/v2/installations/device-codes', {
      method: 'POST',
      authenticated: false,
      body: {
        v: 'hark.installation-device-code.v2',
        installation: {
          protocol: 'codex',
          runtimeId: text(runtimeId, 'runtime_id'),
          ...(name ? { name } : {}),
        },
      },
      signal: options.signal,
    }).then((body) => version(body, 'hark.installation-device-code-result.v2'));
  }

  exchangeDeviceCode(deviceCode, options = {}) {
    return this.#request('/api/hark/v2/installations/device-codes/token', {
      method: 'POST',
      authenticated: false,
      body: { v: 'hark.installation-token.v2', deviceCode: text(deviceCode, 'device_code') },
      signal: options.signal,
    }).then((body) => {
      const result = version(body, 'hark.installation-token.v2');
      text(result.accessToken, 'access_token');
      object(result.installation, 'installation');
      return result;
    });
  }

  getInstallationStatus(options = {}) {
    return this.#request('/api/hark/v2/installations/self', {
      signal: options.signal,
    }).then((body) => {
      const result = version(body, 'hark.installation-status.v2');
      const installation = object(result.installation, 'installation');
      text(installation.id, 'installation_id');
      text(installation.runtimeId, 'runtime_id');
      if (installation.protocol !== 'codex') throw new Error('installation_protocol_invalid');
      return result;
    });
  }

  armAwait(input, options = {}) {
    return this.#request('/api/hark/v2/awaits', {
      method: 'POST', body: input, signal: options.signal,
    }).then((body) => {
      const result = version(body, 'hark.await-arm-result.v2');
      text(object(result.await, 'await').id, 'await_id');
      return result;
    });
  }

  commitAwait(awaitId, input, options = {}) {
    return this.#request(`/api/hark/v2/awaits/${encodeURIComponent(text(awaitId, 'await_id'))}/commit`, {
      method: 'POST', body: input, signal: options.signal,
    }).then((body) => version(body, 'hark.suspension-receipt.v2'));
  }

  getAwait(awaitId, options = {}) {
    return this.#request(`/api/hark/v2/awaits/${encodeURIComponent(text(awaitId, 'await_id'))}`, {
      signal: options.signal,
    }).then((body) => version(body, 'hark.await-detail.v2'));
  }

  claimCrashRecovery(awaitId, input, options = {}) {
    const exactAwaitId = uuid(text(awaitId, 'await_id'), 'await_id');
    const request = assertCrashRecoveryClaimRequest(input, exactAwaitId);
    return this.#request(
      `/api/hark/v2/awaits/${encodeURIComponent(exactAwaitId)}/crash-recovery-claim`,
      { method: 'POST', body: request, signal: options.signal },
    ).then((body) => assertCrashRecoveryClaimResult(body, request));
  }

  cancelAwait(awaitId, input, options = {}) {
    return this.#request(`/api/hark/v2/awaits/${encodeURIComponent(text(awaitId, 'await_id'))}/cancel`, {
      method: 'POST', body: input, signal: options.signal,
    }).then((body) => version(body, 'hark.await-cancel-result.v2'));
  }

  async nextWake({ waitSeconds = 25, signal = undefined } = {}) {
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 25) {
      throw new Error('wait_seconds_invalid');
    }
    const body = await this.#request(`/api/hark/v2/wakes/next?wait=${waitSeconds}`, {
      signal,
      allowNoContent: true,
      timeoutMs: Math.max(this.timeoutMs, (waitSeconds + 5) * 1000),
    });
    if (body === null) return null;
    const result = version(body, 'hark.wake-next-result.v2');
    text(object(result.wake, 'wake').wakeId, 'wake_id');
    text(object(result.claim, 'claim').leaseToken, 'lease_token');
    return result;
  }

  async waitForAwait(awaitId, input, { waitSeconds = 25, signal = undefined } = {}) {
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 25) {
      throw new Error('wait_seconds_invalid');
    }
    const body = await this.#request(
      `/api/hark/v2/awaits/${encodeURIComponent(text(awaitId, 'await_id'))}/wake?wait=${waitSeconds}`,
      {
        method: 'POST',
        body: input,
        signal,
        allowNoContent: true,
        timeoutMs: Math.max(this.timeoutMs, (waitSeconds + 5) * 1000),
      },
    );
    if (body === null) return null;
    const result = version(body, 'hark.await-wake-result.v2');
    text(object(result.wake, 'wake').wakeId, 'wake_id');
    const claim = object(result.claim, 'claim');
    if (claim.continuationMode !== 'held_tool') {
      throw new Error('wake_continuation_mode_invalid');
    }
    text(claim.wakeDeliveryDigest, 'wake_delivery_digest');
    return result;
  }

  recordRuntimeReceipt(awaitId, input, options = {}) {
    return this.#request(
      `/api/hark/v2/awaits/${encodeURIComponent(text(awaitId, 'await_id'))}/runtime-receipts`,
      { method: 'POST', body: input, signal: options.signal },
    ).then((body) => version(body, 'hark.runtime-receipt-result.v2'));
  }

  certifyAwait(awaitId, options = {}) {
    return this.#request(
      `/api/hark/v2/awaits/${encodeURIComponent(text(awaitId, 'await_id'))}/certification`,
      { signal: options.signal },
    ).then((body) => version(body, 'hark.await-certification.v2'));
  }

  async #request(path, options = {}) {
    const headers = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.authenticated !== false) {
      headers.authorization = `Bearer ${text(this.accessToken, 'access_token')}`;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      redirect: 'error',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: combineSignals(options.signal, options.timeoutMs ?? this.timeoutMs),
    });
    if (response.status === 204 && options.allowNoContent) return null;
    let body;
    try {
      body = await response.json();
    } catch {
      throw new HarkApiError(response.status, 'hark_response_not_json');
    }
    if (!response.ok) {
      throw new HarkApiError(response.status, body?.error, body?.details);
    }
    return body;
  }
}
