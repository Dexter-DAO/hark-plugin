import { canonicalJson, sha256Canonical } from './canonical.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const AWAIT_STATES = new Set([
  'armed',
  'suspended',
  'wake_pending',
  'accepted',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
const STATE_TIMESTAMP = new Map([
  ['suspended', 'suspendedAt'],
  ['wake_pending', 'wakePendingAt'],
  ['accepted', 'acceptedAt'],
  ['running', 'runningAt'],
  ['completed', 'completedAt'],
  ['failed', 'failedAt'],
  ['cancelled', 'cancelledAt'],
]);
const LIFECYCLE_TIMESTAMPS = [
  ['suspendedAt', 'armed_await_suspended_at'],
  ['wakePendingAt', 'armed_await_wake_pending_at'],
  ['acceptedAt', 'armed_await_accepted_at'],
  ['runningAt', 'armed_await_running_at'],
  ['completedAt', 'armed_await_completed_at'],
  ['failedAt', 'armed_await_failed_at'],
  ['cancelledAt', 'armed_await_cancelled_at'],
];

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_object_required`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  object(value, label);
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}_field_unsupported:${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}_field_required:${key}`);
  }
}

function requiredString(value, label, max = 4096) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > max
  ) throw new Error(`${label}_invalid`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}_invalid`);
  return value;
}

function digest(value, label) {
  if (!SHA256.test(value ?? '')) throw new Error(`${label}_invalid`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string') throw new Error(`${label}_invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function nullableTimestamp(value, label) {
  if (value === null) return null;
  return timestamp(value, label);
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label}_invalid`);
  return value;
}

function sameJson(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label}_mismatch`);
  }
}

function assertOrigin(value, expected, label) {
  exactKeys(value, ['protocol', 'runtimeId', 'taskId', 'conversationId'], label);
  requiredString(value.protocol, `${label}_protocol`, 32);
  requiredString(value.runtimeId, `${label}_runtime_id`, 200);
  requiredString(value.taskId, `${label}_task_id`, 300);
  requiredString(value.conversationId, `${label}_conversation_id`, 300);
  sameJson(value, expected, label);
}

function assertCheckpoint(value, expected, label) {
  exactKeys(value, ['version', 'digest'], label);
  requiredString(value.version, `${label}_version`, 80);
  digest(value.digest, `${label}_digest`);
  sameJson(value, expected, label);
}

function assertBinding(value, expected) {
  exactKeys(
    value,
    ['continuationMode', 'toolName', 'toolUseId', 'inputDigest'],
    'armed_await_binding',
  );
  if (value.continuationMode !== 'held_tool') {
    throw new Error('armed_await_continuation_mode_invalid');
  }
  requiredString(value.toolName, 'armed_await_tool_name', 240);
  requiredString(value.toolUseId, 'armed_await_tool_use_id', 300);
  digest(value.inputDigest, 'armed_await_tool_input_digest');
  sameJson(value, expected, 'armed_await_binding');
}

function assertPrepared(value, expected) {
  exactKeys(value, [
    'v',
    'preparationNonce',
    'qualificationDigest',
    'wakePolicy',
    'request',
    'name',
    'source',
    'condition',
  ], 'armed_await_prepared');
  exactKeys(value.source, ['kind', 'adapter', 'subject'], 'armed_await_prepared_source');
  object(value.condition, 'armed_await_prepared_condition');
  sameJson(value, expected, 'armed_await_prepared');
}

function assertPredicate(value, expected) {
  exactKeys(
    value,
    ['kind', 'type', 'subject', 'qualificationDigest'],
    'armed_await_predicate',
  );
  digest(value.qualificationDigest, 'armed_await_predicate_qualification_digest');
  sameJson(value, expected, 'armed_await_predicate');
}

function assertPublicWaiter(value) {
  exactKeys(
    value,
    ['waiterId', 'leaseGeneration', 'leaseExpiresAt', 'releasedAt'],
    'armed_await_waiter',
  );
  requiredString(value.waiterId, 'armed_await_waiter_id', 512);
  positiveInteger(value.leaseGeneration, 'armed_await_waiter_lease_generation');
  timestamp(value.leaseExpiresAt, 'armed_await_waiter_lease_expires_at');
  nullableTimestamp(value.releasedAt, 'armed_await_waiter_released_at');
  return value;
}

function assertPrivateWaiter(value, publicWaiter) {
  exactKeys(
    value,
    ['waiterId', 'leaseToken', 'leaseGeneration', 'leaseExpiresAt'],
    'waiter',
  );
  requiredString(value.waiterId, 'waiter_id', 512);
  requiredString(value.leaseToken, 'waiter_lease_token', 2048);
  positiveInteger(value.leaseGeneration, 'waiter_lease_generation');
  timestamp(value.leaseExpiresAt, 'waiter_lease_expires_at');
  if (
    value.waiterId !== publicWaiter.waiterId
    || value.leaseGeneration !== publicWaiter.leaseGeneration
    || value.leaseExpiresAt !== publicWaiter.leaseExpiresAt
  ) throw new Error('waiter_public_binding_mismatch');
  return value;
}

function assertReplay(value, expectedReplay, label) {
  boolean(value, label);
  if (expectedReplay !== undefined && value !== expectedReplay) {
    throw new Error(`${label}_mismatch`);
  }
}

export function assertArmApiResponse(value, armRequest, options = {}) {
  const result = object(value, 'arm_result');
  exactKeys(result, ['v', 'await', 'waiter', 'replay'], 'arm_result');
  if (result.v !== 'hark.await-arm-result.v2') throw new Error('arm_result_version_invalid');
  assertReplay(result.replay, options.expectedReplay, 'arm_result_replay');

  const armed = object(result.await, 'armed_await');
  exactKeys(armed, [
    'v',
    'id',
    'preparationNonce',
    'origin',
    'checkpoint',
    'binding',
    'waiter',
    'prepared',
    'predicate',
    'wakePolicy',
    'state',
    'armedAt',
    'suspendedAt',
    'wakePendingAt',
    'acceptedAt',
    'runningAt',
    'completedAt',
    'failedAt',
    'cancelledAt',
    'lastError',
    'createdAt',
    'updatedAt',
  ], 'armed_await');
  if (armed.v !== 'hark.await.v2') throw new Error('armed_await_version_invalid');
  const awaitId = requiredString(armed.id, 'await_id', 512);
  if (armed.preparationNonce !== armRequest.preparationNonce) {
    throw new Error('armed_await_preparation_nonce_mismatch');
  }
  assertOrigin(armed.origin, armRequest.origin, 'armed_await_origin');
  assertCheckpoint(armed.checkpoint, armRequest.checkpoint, 'armed_await_checkpoint');
  assertBinding(armed.binding, armRequest.binding);
  assertPrepared(armed.prepared, armRequest.prepared);
  assertPredicate(armed.predicate, armRequest.predicate);
  if (armed.wakePolicy !== armRequest.wakePolicy) {
    throw new Error('armed_await_wake_policy_mismatch');
  }
  if (!AWAIT_STATES.has(armed.state)) throw new Error('armed_await_state_invalid');
  timestamp(armed.armedAt, 'armed_await_armed_at');
  for (const [field, label] of LIFECYCLE_TIMESTAMPS) {
    nullableTimestamp(armed[field], label);
  }
  const createdAt = timestamp(armed.createdAt, 'armed_await_created_at');
  const updatedAt = timestamp(armed.updatedAt, 'armed_await_updated_at');
  if (Date.parse(armed.armedAt) > Date.parse(createdAt)) {
    throw new Error('armed_await_armed_at_order_invalid');
  }
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error('armed_await_updated_at_order_invalid');
  }
  if (armed.lastError !== null) requiredString(armed.lastError, 'armed_await_last_error');
  const stateTimestamp = STATE_TIMESTAMP.get(armed.state);
  if (stateTimestamp && armed[stateTimestamp] === null) {
    throw new Error(`armed_await_state_timestamp_missing:${stateTimestamp}`);
  }
  const publicWaiter = assertPublicWaiter(armed.waiter);
  const waiter = assertPrivateWaiter(result.waiter, publicWaiter);
  if (options.expectedReplay === false) {
    if (armed.state !== 'armed') throw new Error('armed_await_initial_state_invalid');
    if (
      LIFECYCLE_TIMESTAMPS.some(([field]) => armed[field] !== null)
      || armed.lastError !== null
      || publicWaiter.releasedAt !== null
    ) throw new Error('armed_await_initial_lifecycle_invalid');
  }
  return { result, armed, awaitId, waiter };
}

export function assertCommitApiResponse(value, expected, options = {}) {
  const result = object(value, 'commit_result');
  exactKeys(result, [
    'v',
    'awaitId',
    'commitNonce',
    'state',
    'suspendedAt',
    'suspensionReceipt',
    'alreadyWoken',
    'replay',
  ], 'commit_result');
  if (result.v !== 'hark.suspension-receipt.v2') {
    throw new Error('suspension_receipt_version_invalid');
  }
  if (
    result.awaitId !== expected.awaitId
    || result.commitNonce !== expected.commitRequest.commitNonce
  ) throw new Error('suspension_receipt_identity_mismatch');
  if (!AWAIT_STATES.has(result.state) || result.state === 'armed') {
    throw new Error('suspension_receipt_state_invalid');
  }
  timestamp(result.suspendedAt, 'suspension_receipt_suspended_at');
  boolean(result.alreadyWoken, 'suspension_receipt_already_woken');
  assertReplay(result.replay, options.expectedReplay, 'suspension_receipt_replay');
  if (options.expectedReplay === false) {
    const expectedState = result.alreadyWoken ? 'wake_pending' : 'suspended';
    if (result.state !== expectedState) throw new Error('suspension_receipt_state_mismatch');
  }

  const receipt = object(result.suspensionReceipt, 'suspension_receipt');
  exactKeys(receipt, [
    'v',
    'sourceReceiptId',
    'kind',
    'observedAt',
    'origin',
    'checkpointDigest',
  ], 'suspension_receipt');
  if (receipt.v !== 'hark.runtime-receipt.v2') {
    throw new Error('suspension_receipt_payload_version_invalid');
  }
  const suspensionReceiptId = requiredString(
    receipt.sourceReceiptId,
    'suspension_receipt_id',
    512,
  );
  if (receipt.kind !== 'monitoring_task_suspended') {
    throw new Error('suspension_receipt_kind_invalid');
  }
  timestamp(receipt.observedAt, 'suspension_receipt_observed_at');
  if (receipt.observedAt !== result.suspendedAt) {
    throw new Error('suspension_receipt_timestamp_mismatch');
  }
  assertOrigin(receipt.origin, expected.armRequest.origin, 'suspension_receipt_origin');
  digest(receipt.checkpointDigest, 'suspension_receipt_checkpoint_digest');
  if (
    receipt.checkpointDigest !== expected.armRequest.checkpoint.digest
    || receipt.checkpointDigest !== expected.commitRequest.checkpointDigest
  ) throw new Error('suspension_receipt_checkpoint_mismatch');
  return {
    result,
    receipt,
    suspensionReceiptId,
    suspensionReceiptDigest: sha256Canonical(receipt),
  };
}
