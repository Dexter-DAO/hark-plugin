import crypto from 'node:crypto';

import { canonicalJson, sha256Canonical } from './canonical.mjs';

export const PREPARED_AWAIT_VERSION = 'hark.await-prepared.v1';
export const HARK_AWAIT_TOOL_NAME = 'hark_await';
export const CODEX_HARK_AWAIT_HOOK_TOOL_NAME = `mcp__hark__${HARK_AWAIT_TOOL_NAME}`;
export const MAX_PREPARE_INPUT_BYTES = 24 * 1024;

const FORBIDDEN_IDENTITY_KEYS = new Set([
  'checkpointDigest',
  'conversationId',
  'installationId',
  'runtimeId',
  'sessionId',
  'taskId',
  'threadId',
  'turnId',
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_object_required`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label}_object_invalid`);
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}_field_unsupported:${key}`);
  }
}

function assertString(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${label}_invalid`);
  }
  return value.trim();
}

function rejectIdentity(value, path = 'input') {
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_IDENTITY_KEYS.has(key)) throw new Error(`host_identity_forbidden:${path}.${key}`);
    rejectIdentity(nested, `${path}.${key}`);
  }
}

function preparationFields(value) {
  return {
    request: value.request,
    name: value.name,
    source: value.source,
    condition: value.condition,
  };
}

export function validatePrepareArguments(value) {
  assertPlainObject(value, 'input');
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PREPARE_INPUT_BYTES) {
    throw new Error('input_too_large');
  }
  rejectIdentity(value);
  assertExactKeys(value, new Set(['request', 'name', 'source', 'condition']), 'input');
  assertPlainObject(value.source, 'source');
  assertExactKeys(value.source, new Set(['kind', 'adapter', 'subject']), 'source');
  assertPlainObject(value.condition, 'condition');
  if (Object.keys(value.condition).length === 0) throw new Error('condition_empty');
  return {
    request: assertString(value.request, 'request', 4000),
    name: assertString(value.name, 'name', 160),
    source: {
      kind: assertString(value.source.kind, 'source_kind', 120),
      adapter: assertString(value.source.adapter, 'source_adapter', 120),
      subject: assertString(value.source.subject, 'source_subject', 300),
    },
    condition: value.condition,
  };
}

export function createPreparedAwait(value, randomBytes = crypto.randomBytes) {
  const draft = validatePrepareArguments(value);
  return {
    v: PREPARED_AWAIT_VERSION,
    preparationNonce: `hkp_${randomBytes(24).toString('base64url')}`,
    qualificationDigest: sha256Canonical({ source: draft.source, condition: draft.condition }),
    wakePolicy: 'resume',
    ...draft,
  };
}

export function validatePreparedAwait(value, expectedInput = undefined) {
  assertPlainObject(value, 'prepared');
  assertExactKeys(value, new Set([
    'v',
    'preparationNonce',
    'qualificationDigest',
    'wakePolicy',
    'request',
    'name',
    'source',
    'condition',
  ]), 'prepared');
  if (value.v !== PREPARED_AWAIT_VERSION) throw new Error('prepared_version_invalid');
  if (!/^hkp_[A-Za-z0-9_-]{32}$/.test(value.preparationNonce ?? '')) {
    throw new Error('preparation_nonce_invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(value.qualificationDigest ?? '')) {
    throw new Error('qualification_digest_invalid');
  }
  if (value.wakePolicy !== 'resume') throw new Error('wake_policy_invalid');

  const normalized = validatePrepareArguments(preparationFields(value));
  if (canonicalJson(preparationFields(value)) !== canonicalJson(normalized)) {
    throw new Error('prepared_fields_noncanonical');
  }
  if (expectedInput !== undefined) {
    const expected = validatePrepareArguments(expectedInput);
    if (canonicalJson(normalized) !== canonicalJson(expected)) {
      throw new Error('prepared_input_mismatch');
    }
  }
  const expectedDigest = sha256Canonical({
    source: normalized.source,
    condition: normalized.condition,
  });
  if (value.qualificationDigest !== expectedDigest) {
    throw new Error('qualification_digest_mismatch');
  }
  return value;
}
