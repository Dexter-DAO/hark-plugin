import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import {
  CODEX_HARK_AWAIT_HOOK_TOOL_NAME,
  validatePrepareArguments,
  validatePreparedAwait,
} from './await-preparation.mjs';
import { canonicalJson, sha256Canonical } from './canonical.mjs';
import { defaultHarkDataDir } from './journal.mjs';
import {
  assertPrivateClaimReference,
  createPrivateClaimBinding,
} from './private-claim-store.mjs';
import { assertCodexToolWaitBoundary } from './transcript-proof.mjs';

export const TOOL_WAIT_AWAIT_REQUEST_VERSION = 'hark.tool-wait.await-request.v1';
export const TOOL_WAIT_ADMISSION_VERSION = 'hark.tool-wait.admission.v1';
export const TOOL_WAIT_ARM_ATTEMPT_LEGACY_VERSION = 'hark.tool-wait.arm-attempt.v1';
export const TOOL_WAIT_ARM_ATTEMPT_VERSION = 'hark.tool-wait.arm-attempt.v2';
export const ARM_RECONCILIATION_FREEZE_VERSION = 'hark.arm-reconciliation-freeze.v1';
export const TOOL_WAIT_ARM_BINDING_VERSION = 'hark.tool-wait.arm-binding.v1';
export const TOOL_WAIT_TRANSCRIPT_BOUNDARY_VERSION = 'hark.tool-wait.transcript-boundary.v1';
export const TOOL_WAIT_WAITER_READY_VERSION = 'hark.tool-wait.waiter-ready.v1';
export const TOOL_WAIT_COMMIT_ATTEMPT_VERSION = 'hark.tool-wait.commit-attempt.v1';
export const TOOL_WAIT_SUSPENSION_COMMITTED_VERSION = 'hark.tool-wait.suspension-committed.v1';
export const TOOL_WAIT_WAKE_DELIVERY_VERSION = 'hark.tool-wait.wake-delivery.v1';
export const TOOL_WAIT_RESULT_VERSION = 'hark.await-satisfied.v1';
export const TOOL_WAIT_OBSERVATION_INTENT_VERSION = 'hark.tool-result-observation-intent.v1';
export const TOOL_WAIT_RESULT_RETURNED_VERSION = 'hark.tool-wait.tool-result-returned.v1';
export const TOOL_WAIT_COMPLETION_POSTED_VERSION = 'hark.tool-wait.completion-posted.v1';
export const TOOL_WAIT_REQUEST_TERMINAL_VERSION = 'hark.tool-wait.request-terminal.v1';
export const TOOL_WAIT_TOOL_ERROR_VERSION = 'hark.tool-wait.tool-error.v1';
export const TOOL_WAIT_TOOL_ERROR_OBSERVATION_VERSION = 'hark.tool-wait.tool-error-observation.v1';
export const HELD_CALL_ORIGIN_ABORT_VERSION = 'hark.held-call-origin-abort.v1';
export const HELD_CALL_RECONCILIATION_INTENT_VERSION =
  'hark.held-call-reconciliation-intent.v1';
export const HELD_CALL_RECONCILIATION_APPLIED_VERSION =
  'hark.held-call-reconciliation-applied.v1';
export const HELD_CALL_TRANSITION_AUTHORITY_VERSION =
  'hark.held-call-transition-authority.v1';

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const EVENT_ID_PATTERN = /^htw_[a-f0-9]{64}$/;
const DELIVERY_ID_PATTERN = /^hwd_[a-f0-9]{64}$/;
const ADMISSION_LOCATOR_PATTERN = /^hta_[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const BINDING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

const RECORD_DIRECTORIES = Object.freeze({
  admission: 'admissions',
  consumedAdmission: 'admissions-consumed',
  awaitRequest: 'await-requests',
  armAttempt: 'arm-attempts',
  armReconciliationFreeze: 'arm-reconciliation-freezes',
  armBinding: 'arm-bindings',
  transcriptBoundary: 'transcript-boundaries',
  waiterReady: 'waiter-ready',
  commitAttempt: 'commit-attempts',
  suspensionCommitted: 'suspension-committed',
  wakeDelivery: 'wake-deliveries',
  observationIntent: 'tool-result-observation-intents',
  toolResultReturned: 'tool-results-returned',
  completionPosted: 'completions-posted',
  awaitRequestTerminal: 'await-request-terminals',
  toolError: 'tool-errors',
  toolErrorObservation: 'tool-error-observations',
  heldCallTransitionAuthority: 'held-call-transition-authorities',
  heldCallOriginAbort: 'held-call-origin-aborts',
  heldCallReconciliationIntent: 'held-call-reconciliation-intents',
  heldCallReconciliationApplied: 'held-call-reconciliation-applied',
});

const AWAIT_REQUEST_TERMINAL_DISPOSITIONS = new Set([
  'completion_posted',
  'crash_recovery_completed',
  'pre_arm_failed',
  'remote_cancelled',
]);
const POST_ARM_REMOTE_STATES = new Set([
  'suspended',
  'wake_pending',
  'accepted',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
const TOOL_ERROR_FAILURE_CODES = new Set([
  'pre_arm_failed',
  'arm_outcome_ambiguous',
  'armed_precommit_failed',
  'commit_outcome_ambiguous',
  'postcommit_failed',
]);
const TRANSIENT_FILESYSTEM_ERRORS = new Set([
  'EAGAIN',
  'EBUSY',
  'EINTR',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ESTALE',
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_object_required`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label}_object_invalid`);
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}_field_unsupported:${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}_field_required:${key}`);
  }
}

function assertJsonValue(value, label, { secretFree = false } = {}) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label}_json_number_invalid`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, { secretFree }));
    return;
  }
  assertPlainObject(value, label);
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      secretFree
      && (
        normalizedKey.endsWith('leasetoken')
        || normalizedKey.endsWith('accesstoken')
        || normalizedKey === 'authorization'
        || normalizedKey === 'bindingtoken'
      )
    ) throw new Error(`${label}_secret_forbidden:${key}`);
    assertJsonValue(nested, `${label}.${key}`, { secretFree });
  }
}

function assertIdentifier(value, label, max = 512) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > max) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

export function toolResultObservationSourceReceiptId(wakeId) {
  return `hrr_tool_result_observed_${assertIdentifier(wakeId, 'wake_id', 160)}`;
}

export function toolWaitCompletionSourceReceiptId(wakeId) {
  return `hrr_task_completed_${assertIdentifier(wakeId, 'wake_id', 160)}`;
}

function assertDigest(value, label) {
  if (!DIGEST_PATTERN.test(value ?? '')) throw new Error(`${label}_invalid`);
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function timestamp(clock, label) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}_clock_invalid`);
  return date.toISOString();
}

function normalizeOriginalInput(value) {
  assertJsonValue(value, 'original_input');
  const normalized = validatePrepareArguments(value);
  assertJsonValue(normalized, 'original_input');
  return JSON.parse(canonicalJson(normalized));
}

function awaitRequestIdentity(value) {
  return {
    v: value.v,
    kind: value.kind,
    sessionId: value.sessionId,
    turnId: value.turnId,
    toolUseId: value.toolUseId,
    toolName: value.toolName,
  };
}

function awaitRequestEventId(value) {
  return `htw_${sha256Canonical(awaitRequestIdentity(value))}`;
}

function assertAdmissionLocator(value) {
  if (!ADMISSION_LOCATOR_PATTERN.test(value ?? '')) {
    throw new Error('tool_wait_admission_locator_invalid');
  }
  return value;
}

function semanticWithout(value, field) {
  const { [field]: _ignored, ...semantic } = value;
  return semantic;
}

function reconciliationAppliedSemantic(value) {
  const semantic = semanticWithout(value, 'appliedAt');
  return {
    ...semantic,
    apiResponses: semantic.apiResponses.map(({ replay: _replay, ...response }) => response),
  };
}

function armReconciliationFreezeSemantic(value) {
  const semantic = semanticWithout(value, 'observedAt');
  return semanticWithout(semantic, 'replay');
}

function appServerAbortEvidenceSemantic(value) {
  return semanticWithout(value, 'observedAt');
}

function rolloutAbortProofSemantic(value) {
  return semanticWithout(value, 'scannedAt');
}

function heldCallOriginAbortSemantic(value) {
  const semantic = semanticWithout(value, 'provenAt');
  return {
    ...semantic,
    appServerTerminalEvidence: appServerAbortEvidenceSemantic(
      semantic.appServerTerminalEvidence,
    ),
    rolloutAbortProof: rolloutAbortProofSemantic(semantic.rolloutAbortProof),
  };
}

function heldCallTransitionAuthoritySemantic(value) {
  return semanticWithout(value, 'electedAt');
}

export function createAwaitRequest(input, clock = () => new Date()) {
  const originalInput = normalizeOriginalInput(input?.originalInput);
  const request = {
    v: TOOL_WAIT_AWAIT_REQUEST_VERSION,
    eventId: '',
    kind: 'await_request',
    sessionId: input?.sessionId,
    turnId: input?.turnId,
    toolUseId: input?.toolUseId,
    toolName: input?.toolName,
    transcriptPath: input?.transcriptPath,
    originalInput,
    originalInputDigest: sha256Canonical(originalInput),
    requestedAt: timestamp(clock, 'await_request'),
  };
  request.eventId = awaitRequestEventId(request);
  return assertAwaitRequest(request);
}

export function assertAwaitRequest(value) {
  assertPlainObject(value, 'await_request');
  assertExactKeys(value, [
    'v', 'eventId', 'kind', 'sessionId', 'turnId', 'toolUseId', 'toolName', 'transcriptPath',
    'originalInput', 'originalInputDigest', 'requestedAt',
  ], 'await_request');
  if (value.v !== TOOL_WAIT_AWAIT_REQUEST_VERSION) throw new Error('await_request_version_invalid');
  if (value.kind !== 'await_request') throw new Error('await_request_kind_invalid');
  assertIdentifier(value.sessionId, 'session_id');
  assertIdentifier(value.turnId, 'turn_id');
  assertIdentifier(value.toolUseId, 'tool_use_id');
  if (value.toolName !== CODEX_HARK_AWAIT_HOOK_TOOL_NAME) {
    throw new Error('tool_wait_tool_name_invalid');
  }
  if (
    typeof value.transcriptPath !== 'string'
    || !value.transcriptPath
    || value.transcriptPath.length > 4096
    || !path.isAbsolute(value.transcriptPath)
  ) throw new Error('transcript_path_invalid');
  const normalized = normalizeOriginalInput(value.originalInput);
  if (canonicalJson(normalized) !== canonicalJson(value.originalInput)) {
    throw new Error('await_request_original_input_noncanonical');
  }
  if (value.originalInputDigest !== sha256Canonical(normalized)) {
    throw new Error('await_request_original_input_digest_invalid');
  }
  assertTimestamp(value.requestedAt, 'await_request_requested_at');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '') || value.eventId !== awaitRequestEventId(value)) {
    throw new Error('await_request_event_id_invalid');
  }
  return value;
}

/**
 * Private one-shot capability written by PreToolUse. Only the opaque locator is
 * passed to the MCP tool; trusted runtime identity and the original normalized
 * user input remain in the private Hark data directory.
 */
export function createAwaitAdmission(
  input,
  clock = () => new Date(),
  randomBytes = crypto.randomBytes,
) {
  const originalInput = normalizeOriginalInput(input?.originalInput);
  const admission = {
    v: TOOL_WAIT_ADMISSION_VERSION,
    kind: 'await_admission',
    locator: `hta_${randomBytes(32).toString('base64url')}`,
    eventId: '',
    sessionId: input?.sessionId,
    turnId: input?.turnId,
    toolUseId: input?.toolUseId,
    toolName: input?.toolName,
    transcriptPath: input?.transcriptPath,
    originalInput,
    originalInputDigest: sha256Canonical(originalInput),
    admittedAt: timestamp(clock, 'await_admission'),
  };
  admission.eventId = awaitRequestEventId({
    v: TOOL_WAIT_AWAIT_REQUEST_VERSION,
    kind: 'await_request',
    sessionId: admission.sessionId,
    turnId: admission.turnId,
    toolUseId: admission.toolUseId,
    toolName: admission.toolName,
  });
  return assertAwaitAdmission(admission);
}

export function assertAwaitAdmission(value) {
  assertPlainObject(value, 'await_admission');
  assertExactKeys(value, [
    'v', 'kind', 'locator', 'eventId', 'sessionId', 'turnId', 'toolUseId', 'toolName',
    'transcriptPath', 'originalInput', 'originalInputDigest', 'admittedAt',
  ], 'await_admission');
  if (value.v !== TOOL_WAIT_ADMISSION_VERSION) throw new Error('await_admission_version_invalid');
  if (value.kind !== 'await_admission') throw new Error('await_admission_kind_invalid');
  assertAdmissionLocator(value.locator);
  const request = assertAwaitRequest({
    v: TOOL_WAIT_AWAIT_REQUEST_VERSION,
    eventId: value.eventId,
    kind: 'await_request',
    sessionId: value.sessionId,
    turnId: value.turnId,
    toolUseId: value.toolUseId,
    toolName: value.toolName,
    transcriptPath: value.transcriptPath,
    originalInput: value.originalInput,
    originalInputDigest: value.originalInputDigest,
    requestedAt: value.admittedAt,
  });
  if (request.eventId !== value.eventId) throw new Error('await_admission_event_id_invalid');
  assertTimestamp(value.admittedAt, 'await_admission_admitted_at');
  return value;
}

export function createAdmissionLocatorInput(admission) {
  const expected = assertAwaitAdmission(admission);
  return {
    ...structuredClone(expected.originalInput),
    _hark: { admissionLocator: expected.locator },
  };
}

export function assertAdmissionLocatorInput(value) {
  assertPlainObject(value, 'admission_input');
  assertExactKeys(value, ['request', 'name', 'source', 'condition', '_hark'], 'admission_input');
  const normalized = normalizeOriginalInput({
    request: value.request,
    name: value.name,
    source: value.source,
    condition: value.condition,
  });
  if (canonicalJson(normalized) !== canonicalJson({
    request: value.request,
    name: value.name,
    source: value.source,
    condition: value.condition,
  })) throw new Error('admission_input_noncanonical');
  assertPlainObject(value._hark, 'admission_input_hark');
  assertExactKeys(value._hark, ['admissionLocator'], 'admission_input_hark');
  assertAdmissionLocator(value._hark.admissionLocator);
  return value;
}

function normalizeArmRequest(value, request) {
  const expected = assertAwaitRequest(request);
  assertPlainObject(value, 'arm_request');
  assertExactKeys(value, [
    'v', 'preparationNonce', 'origin', 'checkpoint', 'prepared', 'predicate',
    'wakePolicy', 'binding',
  ], 'arm_request');
  if (value.v !== 'hark.await.v2') throw new Error('arm_request_version_invalid');
  const prepared = validatePreparedAwait(value.prepared, expected.originalInput);
  if (value.preparationNonce !== prepared.preparationNonce) {
    throw new Error('arm_request_preparation_nonce_mismatch');
  }
  assertPlainObject(value.origin, 'arm_request_origin');
  assertExactKeys(value.origin, ['protocol', 'runtimeId', 'taskId', 'conversationId'], 'arm_request_origin');
  if (
    value.origin.protocol !== 'codex'
    || value.origin.taskId !== expected.turnId
    || value.origin.conversationId !== expected.sessionId
  ) throw new Error('arm_request_origin_mismatch');
  assertIdentifier(value.origin.runtimeId, 'runtime_id', 200);
  assertPlainObject(value.checkpoint, 'arm_request_checkpoint');
  assertExactKeys(value.checkpoint, ['version', 'digest'], 'arm_request_checkpoint');
  if (value.checkpoint.version !== 'hark.codex-checkpoint.v1') {
    throw new Error('arm_request_checkpoint_version_invalid');
  }
  assertDigest(value.checkpoint.digest, 'checkpoint_digest');
  assertPlainObject(value.predicate, 'arm_request_predicate');
  assertExactKeys(
    value.predicate,
    ['kind', 'type', 'subject', 'qualificationDigest'],
    'arm_request_predicate',
  );
  if (
    value.predicate.kind !== 'exact_signal'
    || value.predicate.type !== prepared.source.kind
    || value.predicate.subject !== prepared.source.subject
    || value.predicate.qualificationDigest !== prepared.qualificationDigest
  ) throw new Error('arm_request_predicate_mismatch');
  if (value.wakePolicy !== 'resume') throw new Error('arm_request_wake_policy_invalid');
  assertPlainObject(value.binding, 'arm_request_binding');
  assertExactKeys(
    value.binding,
    ['continuationMode', 'toolName', 'toolUseId', 'inputDigest'],
    'arm_request_binding',
  );
  if (
    value.binding.continuationMode !== 'held_tool'
    || value.binding.toolName !== expected.toolName
    || value.binding.toolUseId !== expected.toolUseId
    || value.binding.inputDigest !== expected.originalInputDigest
  ) throw new Error('arm_request_binding_mismatch');
  assertJsonValue(value, 'arm_request', { secretFree: true });
  return JSON.parse(canonicalJson(value));
}

export function createArmAttempt(
  request,
  input,
  clock = () => new Date(),
  randomBytes = crypto.randomBytes,
) {
  const expected = assertAwaitRequest(request);
  const armRequest = normalizeArmRequest(input?.armRequest, expected);
  const transcriptBoundary = assertCodexToolWaitBoundary(input?.transcriptBoundary);
  if (
    transcriptBoundary.transcriptPath !== expected.transcriptPath
    || transcriptBoundary.conversationId !== expected.sessionId
    || transcriptBoundary.originTaskId !== expected.turnId
    || transcriptBoundary.toolUseId !== expected.toolUseId
    || transcriptBoundary.toolName !== expected.toolName
    || transcriptBoundary.inputDigest !== expected.originalInputDigest
  ) throw new Error('arm_attempt_transcript_boundary_mismatch');
  return assertArmAttempt({
    v: TOOL_WAIT_ARM_ATTEMPT_VERSION,
    kind: 'arm_attempt',
    eventId: expected.eventId,
    installationId: assertIdentifier(
      input?.installationId,
      'arm_attempt_installation_id',
      512,
    ),
    preparationNonce: armRequest.preparationNonce,
    checkpointDigest: armRequest.checkpoint.digest,
    bindingToken: input?.bindingToken ?? randomBytes(32).toString('base64url'),
    armRequest,
    armRequestDigest: sha256Canonical(armRequest),
    transcriptBoundary: structuredClone(transcriptBoundary),
    transcriptBoundaryDigest: sha256Canonical(transcriptBoundary),
    attemptedAt: timestamp(clock, 'arm_attempt'),
  }, expected);
}

function assertArmAttemptRecord(value, request = undefined, options = {}) {
  assertPlainObject(value, 'arm_attempt');
  const legacy = value.v === TOOL_WAIT_ARM_ATTEMPT_LEGACY_VERSION;
  if (!legacy && value.v !== TOOL_WAIT_ARM_ATTEMPT_VERSION) {
    throw new Error('arm_attempt_version_invalid');
  }
  if (legacy && options.allowLegacy !== true) {
    throw new Error('arm_attempt_installation_binding_required');
  }
  assertExactKeys(value, [
    'v', 'kind', 'eventId', ...(legacy ? [] : ['installationId']),
    'preparationNonce', 'checkpointDigest', 'bindingToken',
    'armRequest', 'armRequestDigest', 'transcriptBoundary',
    'transcriptBoundaryDigest', 'attemptedAt',
  ], 'arm_attempt');
  if (value.kind !== 'arm_attempt') throw new Error('arm_attempt_kind_invalid');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) throw new Error('arm_attempt_event_id_invalid');
  if (!legacy) assertIdentifier(value.installationId, 'arm_attempt_installation_id', 512);
  if (!/^hkp_[A-Za-z0-9_-]{32}$/.test(value.preparationNonce ?? '')) {
    throw new Error('preparation_nonce_invalid');
  }
  assertDigest(value.checkpointDigest, 'checkpoint_digest');
  if (!BINDING_TOKEN_PATTERN.test(value.bindingToken ?? '')) throw new Error('binding_token_invalid');
  const expectedRequest = request === undefined ? null : assertAwaitRequest(request);
  if (!expectedRequest) throw new Error('arm_attempt_request_required');
  const armRequest = normalizeArmRequest(value.armRequest, expectedRequest);
  if (
    value.eventId !== expectedRequest.eventId
    || value.preparationNonce !== armRequest.preparationNonce
    || value.checkpointDigest !== armRequest.checkpoint.digest
    || value.armRequestDigest !== sha256Canonical(armRequest)
  ) throw new Error('arm_attempt_request_mismatch');
  const boundary = assertCodexToolWaitBoundary(value.transcriptBoundary);
  if (
    value.transcriptBoundaryDigest !== sha256Canonical(boundary)
    || boundary.transcriptPath !== expectedRequest.transcriptPath
    || boundary.conversationId !== expectedRequest.sessionId
    || boundary.originTaskId !== expectedRequest.turnId
    || boundary.toolUseId !== expectedRequest.toolUseId
    || boundary.toolName !== expectedRequest.toolName
    || boundary.inputDigest !== expectedRequest.originalInputDigest
  ) throw new Error('arm_attempt_transcript_boundary_mismatch');
  assertDigest(value.armRequestDigest, 'arm_request_digest');
  assertDigest(value.transcriptBoundaryDigest, 'transcript_boundary_digest');
  assertTimestamp(value.attemptedAt, 'arm_attempt_attempted_at');
  return value;
}

export function assertReadableArmAttempt(value, request = undefined) {
  return assertArmAttemptRecord(value, request, { allowLegacy: true });
}

export function assertArmAttempt(value, request = undefined) {
  return assertArmAttemptRecord(value, request);
}

function normalizeInstallationIdentity(value, label) {
  assertPlainObject(value, label);
  const identity = {
    id: assertIdentifier(value.id, `${label}_id`, 512),
    protocol: value.protocol,
    runtimeId: assertIdentifier(value.runtimeId, `${label}_runtime_id`, 200),
  };
  if (identity.protocol !== 'codex') throw new Error(`${label}_protocol_invalid`);
  return identity;
}

export function assertInstallationIdentityFence(
  expectedInstallation,
  credentialsInstallation,
  authenticatedInstallation,
  origin,
) {
  const expected = normalizeInstallationIdentity(
    expectedInstallation,
    'expected_installation',
  );
  const credentials = normalizeInstallationIdentity(
    credentialsInstallation,
    'credentials_installation',
  );
  const authenticated = normalizeInstallationIdentity(
    authenticatedInstallation,
    'authenticated_installation',
  );
  assertPlainObject(origin, 'installation_origin');
  const originProtocol = origin.protocol;
  const originRuntimeId = assertIdentifier(
    origin.runtimeId,
    'installation_origin_runtime_id',
    200,
  );
  if (originProtocol !== 'codex') throw new Error('installation_origin_protocol_invalid');
  if (
    expected.id !== credentials.id
    || expected.id !== authenticated.id
    || expected.protocol !== credentials.protocol
    || expected.protocol !== authenticated.protocol
    || expected.protocol !== originProtocol
    || expected.runtimeId !== credentials.runtimeId
    || expected.runtimeId !== authenticated.runtimeId
    || expected.runtimeId !== originRuntimeId
  ) throw new Error('installation_identity_fence_mismatch');
  return Object.freeze({ ...expected });
}

export function assertArmAttemptInstallationFence(
  request,
  armAttempt,
  credentialsInstallation,
  authenticatedInstallation,
) {
  const attempt = assertArmAttempt(armAttempt, request);
  return assertInstallationIdentityFence(
    {
      id: attempt.installationId,
      protocol: attempt.armRequest.origin.protocol,
      runtimeId: attempt.armRequest.origin.runtimeId,
    },
    credentialsInstallation,
    authenticatedInstallation,
    attempt.armRequest.origin,
  );
}

export function createArmReconciliationFreeze(
  request,
  armAttempt,
  input,
  clock = () => new Date(),
) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedAttempt = assertArmAttempt(armAttempt, expectedRequest);
  return assertArmReconciliationFreeze({
    v: ARM_RECONCILIATION_FREEZE_VERSION,
    kind: 'arm_reconciliation_freeze',
    eventId: expectedRequest.eventId,
    armAttemptDigest: sha256Canonical(expectedAttempt),
    armRequestDigest: expectedAttempt.armRequestDigest,
    responseEffectDigest: input?.responseEffectDigest,
    remoteState: input?.remoteState,
    replay: input?.replay,
    observedAt: timestamp(clock, 'arm_reconciliation_freeze'),
  }, expectedRequest, expectedAttempt);
}

export function assertArmReconciliationFreeze(
  value,
  request = undefined,
  armAttempt = undefined,
) {
  assertPlainObject(value, 'arm_reconciliation_freeze');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'armAttemptDigest', 'armRequestDigest',
    'responseEffectDigest', 'remoteState', 'replay', 'observedAt',
  ], 'arm_reconciliation_freeze');
  if (value.v !== ARM_RECONCILIATION_FREEZE_VERSION) {
    throw new Error('arm_reconciliation_freeze_version_invalid');
  }
  if (value.kind !== 'arm_reconciliation_freeze') {
    throw new Error('arm_reconciliation_freeze_kind_invalid');
  }
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) {
    throw new Error('arm_reconciliation_freeze_event_id_invalid');
  }
  assertDigest(value.armAttemptDigest, 'arm_reconciliation_freeze_attempt_digest');
  assertDigest(value.armRequestDigest, 'arm_reconciliation_freeze_request_digest');
  assertDigest(value.responseEffectDigest, 'arm_reconciliation_freeze_response_digest');
  if (!POST_ARM_REMOTE_STATES.has(value.remoteState)) {
    throw new Error('arm_reconciliation_freeze_remote_state_invalid');
  }
  if (typeof value.replay !== 'boolean') {
    throw new Error('arm_reconciliation_freeze_replay_invalid');
  }
  assertTimestamp(value.observedAt, 'arm_reconciliation_freeze_observed_at');
  if (request === undefined || armAttempt === undefined) {
    throw new Error('arm_reconciliation_freeze_context_required');
  }
  const expectedRequest = assertAwaitRequest(request);
  const expectedAttempt = assertArmAttempt(armAttempt, expectedRequest);
  if (
    value.eventId !== expectedRequest.eventId
    || value.armAttemptDigest !== sha256Canonical(expectedAttempt)
    || value.armRequestDigest !== expectedAttempt.armRequestDigest
  ) throw new Error('arm_reconciliation_freeze_binding_mismatch');
  assertJsonValue(value, 'arm_reconciliation_freeze', { secretFree: true });
  return value;
}

export function createArmBinding(
  request,
  input,
  clock = () => new Date(),
  randomBytes = crypto.randomBytes,
) {
  const expected = assertAwaitRequest(request);
  const token = input?.bindingToken ?? randomBytes(32).toString('base64url');
  return assertArmBinding({
    v: TOOL_WAIT_ARM_BINDING_VERSION,
    kind: 'arm_binding',
    eventId: expected.eventId,
    awaitId: input?.awaitId,
    preparationNonce: input?.preparationNonce,
    checkpointDigest: input?.checkpointDigest,
    bindingToken: token,
    armedAt: timestamp(clock, 'arm_binding'),
  }, expected);
}

export function assertArmBinding(value, request = undefined) {
  assertPlainObject(value, 'arm_binding');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'awaitId', 'preparationNonce', 'checkpointDigest',
    'bindingToken', 'armedAt',
  ], 'arm_binding');
  if (value.v !== TOOL_WAIT_ARM_BINDING_VERSION) throw new Error('arm_binding_version_invalid');
  if (value.kind !== 'arm_binding') throw new Error('arm_binding_kind_invalid');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) throw new Error('arm_binding_event_id_invalid');
  assertIdentifier(value.awaitId, 'await_id');
  if (!/^hkp_[A-Za-z0-9_-]{32}$/.test(value.preparationNonce ?? '')) {
    throw new Error('preparation_nonce_invalid');
  }
  assertDigest(value.checkpointDigest, 'checkpoint_digest');
  if (!BINDING_TOKEN_PATTERN.test(value.bindingToken ?? '')) {
    throw new Error('binding_token_invalid');
  }
  assertTimestamp(value.armedAt, 'arm_binding_armed_at');
  if (request !== undefined && value.eventId !== assertAwaitRequest(request).eventId) {
    throw new Error('arm_binding_request_mismatch');
  }
  return value;
}

export function createTranscriptBoundary(
  request,
  armBinding,
  boundary,
  clock = () => new Date(),
) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedArm = assertArmBinding(armBinding, expectedRequest);
  const exactBoundary = assertCodexToolWaitBoundary(boundary);
  if (
    exactBoundary.transcriptPath !== expectedRequest.transcriptPath
    || exactBoundary.conversationId !== expectedRequest.sessionId
    || exactBoundary.originTaskId !== expectedRequest.turnId
    || exactBoundary.toolUseId !== expectedRequest.toolUseId
    || exactBoundary.toolName !== expectedRequest.toolName
    || exactBoundary.inputDigest !== expectedRequest.originalInputDigest
  ) throw new Error('transcript_boundary_request_mismatch');
  return assertTranscriptBoundary({
    v: TOOL_WAIT_TRANSCRIPT_BOUNDARY_VERSION,
    kind: 'transcript_boundary',
    eventId: expectedRequest.eventId,
    awaitId: expectedArm.awaitId,
    toolUseId: expectedRequest.toolUseId,
    inputDigest: expectedRequest.originalInputDigest,
    boundary: structuredClone(exactBoundary),
    boundaryDigest: sha256Canonical(exactBoundary),
    capturedAt: timestamp(clock, 'transcript_boundary'),
  }, expectedRequest, expectedArm);
}

export function assertTranscriptBoundary(
  value,
  request = undefined,
  armBinding = undefined,
) {
  assertPlainObject(value, 'transcript_boundary');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'awaitId', 'toolUseId', 'inputDigest', 'boundary',
    'boundaryDigest', 'capturedAt',
  ], 'transcript_boundary');
  if (value.v !== TOOL_WAIT_TRANSCRIPT_BOUNDARY_VERSION) {
    throw new Error('transcript_boundary_version_invalid');
  }
  if (value.kind !== 'transcript_boundary') throw new Error('transcript_boundary_kind_invalid');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) throw new Error('transcript_boundary_event_id_invalid');
  assertIdentifier(value.awaitId, 'await_id');
  assertIdentifier(value.toolUseId, 'tool_use_id');
  assertDigest(value.inputDigest, 'input_digest');
  const boundary = assertCodexToolWaitBoundary(value.boundary);
  if (
    boundary.toolUseId !== value.toolUseId
    || boundary.inputDigest !== value.inputDigest
    || value.boundaryDigest !== sha256Canonical(boundary)
  ) throw new Error('transcript_boundary_digest_mismatch');
  assertDigest(value.boundaryDigest, 'transcript_boundary_digest');
  assertTimestamp(value.capturedAt, 'transcript_boundary_captured_at');
  if (request !== undefined) {
    const expected = assertAwaitRequest(request);
    if (
      value.eventId !== expected.eventId
      || value.toolUseId !== expected.toolUseId
      || value.inputDigest !== expected.originalInputDigest
      || boundary.transcriptPath !== expected.transcriptPath
      || boundary.conversationId !== expected.sessionId
      || boundary.originTaskId !== expected.turnId
      || boundary.toolName !== expected.toolName
    ) throw new Error('transcript_boundary_request_mismatch');
  }
  if (armBinding !== undefined) {
    const expected = assertArmBinding(armBinding, request);
    if (value.eventId !== expected.eventId || value.awaitId !== expected.awaitId) {
      throw new Error('transcript_boundary_arm_binding_mismatch');
    }
  }
  return value;
}

export function assertArmAttemptLocalClosure(request, armAttempt, records = {}) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedAttempt = assertArmAttempt(armAttempt, expectedRequest);
  const armBinding = records.armBinding ?? null;
  const transcriptBoundary = records.transcriptBoundary ?? null;
  if (armBinding !== null) {
    const expectedArm = assertArmBinding(armBinding, expectedRequest);
    if (
      expectedArm.preparationNonce !== expectedAttempt.preparationNonce
      || expectedArm.checkpointDigest !== expectedAttempt.checkpointDigest
      || expectedArm.bindingToken !== expectedAttempt.bindingToken
    ) throw new Error('held_call_reconciliation_arm_attempt_binding_mismatch');
  }
  if (transcriptBoundary !== null) {
    if (armBinding === null) {
      throw new Error('held_call_reconciliation_arm_attempt_boundary_without_binding');
    }
    const expectedBoundary = assertTranscriptBoundary(
      transcriptBoundary,
      expectedRequest,
      armBinding,
    );
    if (
      expectedBoundary.boundaryDigest !== expectedAttempt.transcriptBoundaryDigest
      || canonicalJson(expectedBoundary.boundary)
        !== canonicalJson(expectedAttempt.transcriptBoundary)
    ) throw new Error('held_call_reconciliation_arm_attempt_boundary_mismatch');
  }
  return { armBinding, transcriptBoundary };
}

export function createWaiterReady(request, armBinding, originalInput, clock = () => new Date()) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedArm = assertArmBinding(armBinding, expectedRequest);
  const normalized = normalizeOriginalInput(originalInput);
  const digest = sha256Canonical(normalized);
  if (digest !== expectedRequest.originalInputDigest) throw new Error('waiter_ready_original_input_mismatch');
  return assertWaiterReady({
    v: TOOL_WAIT_WAITER_READY_VERSION,
    kind: 'waiter_ready',
    eventId: expectedRequest.eventId,
    awaitId: expectedArm.awaitId,
    toolUseId: expectedRequest.toolUseId,
    bindingToken: expectedArm.bindingToken,
    originalInputDigest: digest,
    readyAt: timestamp(clock, 'waiter_ready'),
  }, expectedRequest, expectedArm);
}

export function assertWaiterReady(value, request = undefined, armBinding = undefined) {
  assertPlainObject(value, 'waiter_ready');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'awaitId', 'toolUseId', 'bindingToken',
    'originalInputDigest', 'readyAt',
  ], 'waiter_ready');
  if (value.v !== TOOL_WAIT_WAITER_READY_VERSION) throw new Error('waiter_ready_version_invalid');
  if (value.kind !== 'waiter_ready') throw new Error('waiter_ready_kind_invalid');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) throw new Error('waiter_ready_event_id_invalid');
  assertIdentifier(value.awaitId, 'await_id');
  assertIdentifier(value.toolUseId, 'tool_use_id');
  if (!BINDING_TOKEN_PATTERN.test(value.bindingToken ?? '')) throw new Error('binding_token_invalid');
  assertDigest(value.originalInputDigest, 'original_input_digest');
  assertTimestamp(value.readyAt, 'waiter_ready_ready_at');
  if (request !== undefined) {
    const expected = assertAwaitRequest(request);
    if (
      value.eventId !== expected.eventId
      || value.toolUseId !== expected.toolUseId
      || value.originalInputDigest !== expected.originalInputDigest
    ) throw new Error('waiter_ready_request_mismatch');
  }
  if (armBinding !== undefined) {
    const expected = assertArmBinding(armBinding, request);
    if (
      value.eventId !== expected.eventId
      || value.awaitId !== expected.awaitId
      || value.bindingToken !== expected.bindingToken
    ) throw new Error('waiter_ready_arm_binding_mismatch');
  }
  return value;
}

export function createCommitAttempt(
  request,
  armBinding,
  waiterReady,
  commitRequest,
  clock = () => new Date(),
) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedArm = assertArmBinding(armBinding, expectedRequest);
  assertWaiterReady(waiterReady, expectedRequest, expectedArm);
  assertPlainObject(commitRequest, 'commit_request');
  assertExactKeys(commitRequest, ['v', 'commitNonce', 'checkpointDigest'], 'commit_request');
  if (commitRequest.v !== 'hark.suspension-commit.v2') {
    throw new Error('commit_request_version_invalid');
  }
  if (!/^hkc_[A-Za-z0-9_-]{32}$/.test(commitRequest.commitNonce ?? '')) {
    throw new Error('commit_nonce_invalid');
  }
  if (commitRequest.checkpointDigest !== expectedArm.checkpointDigest) {
    throw new Error('commit_request_checkpoint_mismatch');
  }
  const normalized = JSON.parse(canonicalJson(commitRequest));
  return assertCommitAttempt({
    v: TOOL_WAIT_COMMIT_ATTEMPT_VERSION,
    kind: 'commit_attempt',
    eventId: expectedRequest.eventId,
    awaitId: expectedArm.awaitId,
    commitRequest: normalized,
    commitRequestDigest: sha256Canonical(normalized),
    attemptedAt: timestamp(clock, 'commit_attempt'),
  }, expectedRequest, expectedArm, waiterReady);
}

export function assertCommitAttempt(
  value,
  request = undefined,
  armBinding = undefined,
  waiterReady = undefined,
) {
  assertPlainObject(value, 'commit_attempt');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'awaitId', 'commitRequest', 'commitRequestDigest', 'attemptedAt',
  ], 'commit_attempt');
  if (value.v !== TOOL_WAIT_COMMIT_ATTEMPT_VERSION) throw new Error('commit_attempt_version_invalid');
  if (value.kind !== 'commit_attempt') throw new Error('commit_attempt_kind_invalid');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) throw new Error('commit_attempt_event_id_invalid');
  assertIdentifier(value.awaitId, 'await_id');
  assertPlainObject(value.commitRequest, 'commit_request');
  assertExactKeys(value.commitRequest, ['v', 'commitNonce', 'checkpointDigest'], 'commit_request');
  if (value.commitRequest.v !== 'hark.suspension-commit.v2') {
    throw new Error('commit_request_version_invalid');
  }
  if (!/^hkc_[A-Za-z0-9_-]{32}$/.test(value.commitRequest.commitNonce ?? '')) {
    throw new Error('commit_nonce_invalid');
  }
  assertDigest(value.commitRequest.checkpointDigest, 'checkpoint_digest');
  if (value.commitRequestDigest !== sha256Canonical(value.commitRequest)) {
    throw new Error('commit_request_digest_invalid');
  }
  assertDigest(value.commitRequestDigest, 'commit_request_digest');
  assertTimestamp(value.attemptedAt, 'commit_attempt_attempted_at');
  if (request !== undefined && value.eventId !== assertAwaitRequest(request).eventId) {
    throw new Error('commit_attempt_request_mismatch');
  }
  if (armBinding !== undefined) {
    const expectedArm = assertArmBinding(armBinding, request);
    if (
      value.eventId !== expectedArm.eventId
      || value.awaitId !== expectedArm.awaitId
      || value.commitRequest.checkpointDigest !== expectedArm.checkpointDigest
    ) throw new Error('commit_attempt_arm_binding_mismatch');
  }
  if (waiterReady !== undefined) {
    const expectedReady = assertWaiterReady(waiterReady, request, armBinding);
    if (
      value.eventId !== expectedReady.eventId
      || value.awaitId !== expectedReady.awaitId
    ) throw new Error('commit_attempt_waiter_mismatch');
  }
  return value;
}

export function createSuspensionCommitted(
  request,
  armBinding,
  waiterReady,
  input,
  clock = () => new Date(),
) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedArm = assertArmBinding(armBinding, expectedRequest);
  assertWaiterReady(waiterReady, expectedRequest, expectedArm);
  return assertSuspensionCommitted({
    v: TOOL_WAIT_SUSPENSION_COMMITTED_VERSION,
    kind: 'suspension_committed',
    eventId: expectedRequest.eventId,
    awaitId: expectedArm.awaitId,
    toolUseId: expectedRequest.toolUseId,
    checkpointDigest: expectedArm.checkpointDigest,
    suspensionReceiptId: input?.suspensionReceiptId,
    suspensionReceiptDigest: input?.suspensionReceiptDigest,
    committedAt: timestamp(clock, 'suspension_committed'),
  }, expectedRequest, expectedArm, waiterReady);
}

export function assertSuspensionCommitted(
  value,
  request = undefined,
  armBinding = undefined,
  waiterReady = undefined,
) {
  assertPlainObject(value, 'suspension_committed');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'awaitId', 'toolUseId', 'checkpointDigest',
    'suspensionReceiptId', 'suspensionReceiptDigest', 'committedAt',
  ], 'suspension_committed');
  if (value.v !== TOOL_WAIT_SUSPENSION_COMMITTED_VERSION) {
    throw new Error('suspension_committed_version_invalid');
  }
  if (value.kind !== 'suspension_committed') throw new Error('suspension_committed_kind_invalid');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) {
    throw new Error('suspension_committed_event_id_invalid');
  }
  assertIdentifier(value.awaitId, 'await_id');
  assertIdentifier(value.toolUseId, 'tool_use_id');
  assertDigest(value.checkpointDigest, 'checkpoint_digest');
  assertIdentifier(value.suspensionReceiptId, 'suspension_receipt_id');
  assertDigest(value.suspensionReceiptDigest, 'suspension_receipt_digest');
  assertTimestamp(value.committedAt, 'suspension_committed_at');
  if (request !== undefined) {
    const expected = assertAwaitRequest(request);
    if (value.eventId !== expected.eventId || value.toolUseId !== expected.toolUseId) {
      throw new Error('suspension_committed_request_mismatch');
    }
  }
  if (armBinding !== undefined) {
    const expected = assertArmBinding(armBinding, request);
    if (
      value.eventId !== expected.eventId
      || value.awaitId !== expected.awaitId
      || value.checkpointDigest !== expected.checkpointDigest
    ) throw new Error('suspension_committed_arm_binding_mismatch');
  }
  if (waiterReady !== undefined) {
    const expected = assertWaiterReady(waiterReady, request, armBinding);
    if (
      value.eventId !== expected.eventId
      || value.awaitId !== expected.awaitId
      || value.toolUseId !== expected.toolUseId
    ) throw new Error('suspension_committed_waiter_mismatch');
  }
  return value;
}

const SIGNAL_KEYS = [
  'id', 'sourceSignalId', 'type', 'subject', 'qualificationDigest', 'observedAt',
  'sourceAdapter', 'authMode', 'summary', 'data', 'evidence',
];
const SIGNAL_AUTH_MODES = new Set(['source_hmac', 'installation_test']);

function sanitizeSignal(value) {
  assertPlainObject(value, 'wake_signal');
  assertExactKeys(value, SIGNAL_KEYS, 'wake_signal');
  for (const [field, label] of [
    ['id', 'signal_id'],
    ['sourceSignalId', 'source_signal_id'],
    ['type', 'signal_type'],
    ['subject', 'signal_subject'],
    ['sourceAdapter', 'signal_source_adapter'],
  ]) assertIdentifier(value[field], label, field === 'sourceAdapter' ? 120 : 1024);
  if (!SIGNAL_AUTH_MODES.has(value.authMode)) throw new Error('signal_auth_mode_invalid');
  assertDigest(value.qualificationDigest, 'qualification_digest');
  assertTimestamp(value.observedAt, 'signal_observed_at');
  if (typeof value.summary !== 'string' || value.summary.length > 16_000) {
    throw new Error('signal_summary_invalid');
  }
  assertPlainObject(value.data, 'signal_data');
  if (!Array.isArray(value.evidence)) throw new Error('signal_evidence_array_required');
  assertJsonValue(value.data, 'signal_data', { secretFree: true });
  assertJsonValue(value.evidence, 'signal_evidence', { secretFree: true });
  return JSON.parse(canonicalJson(value));
}

export function sanitizeWakeEnvelope(value) {
  assertPlainObject(value, 'wake_envelope');
  let source;
  if (value.v === 'hark.wake.v2') {
    assertExactKeys(value, [
      'v', 'wakeId', 'idempotencyKey', 'awaitId', 'origin', 'checkpoint',
      'prepared', 'signal', 'createdAt',
    ], 'raw_wake');
    assertJsonValue(value.origin, 'raw_wake_origin', { secretFree: true });
    assertJsonValue(value.checkpoint, 'raw_wake_checkpoint', { secretFree: true });
    assertJsonValue(value.prepared, 'raw_wake_prepared', { secretFree: true });
    source = value;
  } else {
    assertExactKeys(value, [
      'v', 'wakeId', 'awaitId', 'idempotencyKey', 'signal', 'createdAt',
    ], 'wake_envelope');
    if (value.v !== 'hark.tool-wake-envelope.v1') {
      throw new Error('wake_envelope_version_invalid');
    }
    source = value;
  }
  assertIdentifier(source.wakeId, 'wake_id');
  assertIdentifier(source.awaitId, 'await_id');
  assertIdentifier(source.idempotencyKey, 'wake_idempotency_key');
  assertTimestamp(source.createdAt, 'wake_created_at');
  const envelope = {
    v: 'hark.tool-wake-envelope.v1',
    wakeId: source.wakeId,
    awaitId: source.awaitId,
    idempotencyKey: source.idempotencyKey,
    signal: sanitizeSignal(source.signal),
    createdAt: source.createdAt,
  };
  assertJsonValue(envelope, 'wake_envelope', { secretFree: true });
  if (Buffer.byteLength(canonicalJson(envelope), 'utf8') > MAX_RECORD_BYTES / 2) {
    throw new Error('wake_envelope_too_large');
  }
  return envelope;
}

export function assertSanitizedWakeEnvelope(value) {
  const normalized = sanitizeWakeEnvelope(value);
  if (canonicalJson(normalized) !== canonicalJson(value)) {
    throw new Error('wake_envelope_noncanonical');
  }
  return value;
}

function wakeDeliveryIdentity(value) {
  return {
    v: value.v,
    kind: value.kind,
    eventId: value.eventId,
    awaitId: value.awaitId,
    wakeId: value.wakeId,
    toolUseId: value.toolUseId,
    checkpointDigest: value.checkpointDigest,
    wakeDeliveryDigest: value.wakeDeliveryDigest,
  };
}

function wakeDeliveryId(value) {
  return `hwd_${sha256Canonical(wakeDeliveryIdentity(value))}`;
}

export function createWakeDelivery(
  request,
  armBinding,
  suspensionCommitted,
  wake,
  wakeDeliveryDigest,
  clock = () => new Date(),
) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedArm = assertArmBinding(armBinding, expectedRequest);
  const expectedCommit = assertSuspensionCommitted(
    suspensionCommitted,
    expectedRequest,
    expectedArm,
  );
  const wakeEnvelope = sanitizeWakeEnvelope(wake);
  if (wakeEnvelope.awaitId !== expectedArm.awaitId) throw new Error('wake_delivery_await_mismatch');
  if (
    wake?.v === 'hark.wake.v2'
    && wake.checkpoint?.digest !== expectedArm.checkpointDigest
  ) throw new Error('wake_delivery_checkpoint_mismatch');
  const expectedWakeDeliveryDigest = assertDigest(
    wakeDeliveryDigest,
    'wake_delivery_digest',
  );
  const delivery = {
    v: TOOL_WAIT_WAKE_DELIVERY_VERSION,
    deliveryId: '',
    kind: 'wake_delivery',
    eventId: expectedRequest.eventId,
    awaitId: expectedArm.awaitId,
    wakeId: wakeEnvelope.wakeId,
    toolUseId: expectedRequest.toolUseId,
    checkpointDigest: expectedArm.checkpointDigest,
    wakeDeliveryDigest: expectedWakeDeliveryDigest,
    suspensionReceiptId: expectedCommit.suspensionReceiptId,
    suspensionReceiptDigest: expectedCommit.suspensionReceiptDigest,
    wakeEnvelope,
    wakeEnvelopeDigest: sha256Canonical(wakeEnvelope),
    deliveredAt: timestamp(clock, 'wake_delivery'),
  };
  delivery.deliveryId = wakeDeliveryId(delivery);
  return assertWakeDelivery(delivery, expectedRequest, expectedArm, expectedCommit);
}

export function assertWakeDelivery(
  value,
  request = undefined,
  armBinding = undefined,
  suspensionCommitted = undefined,
) {
  assertPlainObject(value, 'wake_delivery');
  assertExactKeys(value, [
    'v', 'deliveryId', 'kind', 'eventId', 'awaitId', 'wakeId', 'toolUseId',
    'checkpointDigest', 'wakeDeliveryDigest', 'suspensionReceiptId', 'suspensionReceiptDigest',
    'wakeEnvelope', 'wakeEnvelopeDigest', 'deliveredAt',
  ], 'wake_delivery');
  if (value.v !== TOOL_WAIT_WAKE_DELIVERY_VERSION) throw new Error('wake_delivery_version_invalid');
  if (value.kind !== 'wake_delivery') throw new Error('wake_delivery_kind_invalid');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) throw new Error('wake_delivery_event_id_invalid');
  assertIdentifier(value.awaitId, 'await_id');
  assertIdentifier(value.wakeId, 'wake_id');
  assertIdentifier(value.toolUseId, 'tool_use_id');
  assertDigest(value.checkpointDigest, 'checkpoint_digest');
  assertDigest(value.wakeDeliveryDigest, 'wake_delivery_digest');
  assertIdentifier(value.suspensionReceiptId, 'suspension_receipt_id');
  assertDigest(value.suspensionReceiptDigest, 'suspension_receipt_digest');
  assertSanitizedWakeEnvelope(value.wakeEnvelope);
  if (
    value.wakeEnvelope.wakeId !== value.wakeId
    || value.wakeEnvelope.awaitId !== value.awaitId
    || value.wakeEnvelopeDigest !== sha256Canonical(value.wakeEnvelope)
  ) throw new Error('wake_delivery_envelope_mismatch');
  assertTimestamp(value.deliveredAt, 'wake_delivery_delivered_at');
  if (!DELIVERY_ID_PATTERN.test(value.deliveryId ?? '') || value.deliveryId !== wakeDeliveryId(value)) {
    throw new Error('wake_delivery_id_invalid');
  }
  if (request !== undefined) {
    const expected = assertAwaitRequest(request);
    if (value.eventId !== expected.eventId || value.toolUseId !== expected.toolUseId) {
      throw new Error('wake_delivery_request_mismatch');
    }
  }
  if (armBinding !== undefined) {
    const expected = assertArmBinding(armBinding, request);
    if (
      value.eventId !== expected.eventId
      || value.awaitId !== expected.awaitId
      || value.checkpointDigest !== expected.checkpointDigest
    ) throw new Error('wake_delivery_arm_binding_mismatch');
  }
  if (suspensionCommitted !== undefined) {
    const expected = assertSuspensionCommitted(suspensionCommitted, request, armBinding);
    if (
      value.eventId !== expected.eventId
      || value.awaitId !== expected.awaitId
      || value.suspensionReceiptId !== expected.suspensionReceiptId
      || value.suspensionReceiptDigest !== expected.suspensionReceiptDigest
    ) throw new Error('wake_delivery_suspension_mismatch');
  }
  return value;
}

export function createToolWaitResult(delivery) {
  const expected = assertWakeDelivery(delivery);
  return assertToolWaitResult({
    v: TOOL_WAIT_RESULT_VERSION,
    deliveryId: expected.deliveryId,
    wake: expected.wakeEnvelope,
  }, expected);
}

export function assertToolWaitResult(value, delivery = undefined) {
  assertPlainObject(value, 'tool_wait_result');
  assertExactKeys(value, ['v', 'deliveryId', 'wake'], 'tool_wait_result');
  if (value.v !== TOOL_WAIT_RESULT_VERSION) throw new Error('tool_wait_result_version_invalid');
  if (!DELIVERY_ID_PATTERN.test(value.deliveryId ?? '')) throw new Error('tool_wait_result_delivery_id_invalid');
  assertSanitizedWakeEnvelope(value.wake);
  assertJsonValue(value, 'tool_wait_result', { secretFree: true });
  if (delivery !== undefined) {
    const expected = assertWakeDelivery(delivery);
    if (
      value.deliveryId !== expected.deliveryId
      || canonicalJson(value.wake) !== canonicalJson(expected.wakeEnvelope)
    ) throw new Error('tool_wait_result_delivery_mismatch');
  }
  return value;
}

function observationIntentIdentity(value) {
  return {
    binding: value.binding,
    transcriptBoundaryDigest: value.transcriptBoundaryDigest,
    claimReference: value.claimReference,
    publicReceipt: value.publicReceipt,
  };
}

function observationIntentId(value) {
  return `hri_${sha256Canonical(observationIntentIdentity(value))}`;
}

function assertObservationPublicReceipt(value, intent, boundary = undefined) {
  assertPlainObject(value, 'tool_result_observation_public_receipt');
  assertExactKeys(value, [
    'v', 'sourceReceiptId', 'observedAt', 'origin', 'checkpointDigest',
    'kind', 'wakeId', 'toolResultObservation',
  ], 'tool_result_observation_public_receipt');
  if (value.v !== 'hark.runtime-receipt.v2') {
    throw new Error('tool_result_observation_receipt_version_invalid');
  }
  if (value.sourceReceiptId !== toolResultObservationSourceReceiptId(intent.wakeId)) {
    throw new Error('tool_result_observation_receipt_source_id_mismatch');
  }
  assertTimestamp(value.observedAt, 'tool_result_observation_receipt_observed_at');
  assertPlainObject(value.origin, 'tool_result_observation_receipt_origin');
  assertExactKeys(
    value.origin,
    ['protocol', 'runtimeId', 'taskId', 'conversationId'],
    'tool_result_observation_receipt_origin',
  );
  if (value.origin.protocol !== 'codex') {
    throw new Error('tool_result_observation_receipt_protocol_invalid');
  }
  assertIdentifier(value.origin.runtimeId, 'tool_result_observation_runtime_id', 200);
  assertIdentifier(value.origin.taskId, 'tool_result_observation_task_id');
  assertIdentifier(value.origin.conversationId, 'tool_result_observation_conversation_id');
  if (value.checkpointDigest !== intent.checkpointDigest) {
    throw new Error('tool_result_observation_receipt_checkpoint_mismatch');
  }
  if (value.kind !== 'tool_result_observed' || value.wakeId !== intent.wakeId) {
    throw new Error('tool_result_observation_receipt_identity_mismatch');
  }
  const observation = value.toolResultObservation;
  assertPlainObject(observation, 'tool_result_observation');
  assertExactKeys(observation, [
    'v', 'continuationMode', 'observationMode', 'conversationId', 'taskId',
    'toolName', 'toolUseId', 'inputDigest', 'wakeDeliveryDigest', 'toolResultDigest',
  ], 'tool_result_observation');
  if (
    observation.v !== 'hark.tool-result-observed.v1'
    || observation.continuationMode !== 'held_tool'
    || observation.observationMode !== 'direct'
  ) throw new Error('tool_result_observation_mode_invalid');
  if (
    observation.conversationId !== value.origin.conversationId
    || observation.taskId !== value.origin.taskId
    || observation.toolUseId !== intent.toolUseId
    || observation.wakeDeliveryDigest !== intent.wakeDeliveryDigest
    || observation.toolResultDigest !== intent.toolResultDigest
  ) throw new Error('tool_result_observation_receipt_binding_mismatch');
  if (observation.toolName !== CODEX_HARK_AWAIT_HOOK_TOOL_NAME) {
    throw new Error('tool_result_observation_tool_name_invalid');
  }
  assertDigest(observation.inputDigest, 'tool_result_observation_input_digest');
  if (boundary !== undefined) {
    const exactBoundary = assertCodexToolWaitBoundary(boundary);
    if (
      value.origin.taskId !== exactBoundary.originTaskId
      || value.origin.conversationId !== exactBoundary.conversationId
      || observation.toolName !== exactBoundary.toolName
      || observation.toolUseId !== exactBoundary.toolUseId
      || observation.inputDigest !== exactBoundary.inputDigest
    ) throw new Error('tool_result_observation_transcript_boundary_mismatch');
  }
  assertJsonValue(value, 'tool_result_observation_public_receipt', { secretFree: true });
  return value;
}

export function createToolResultObservationIntent(input, clock = () => new Date()) {
  const delivery = assertWakeDelivery(input?.delivery);
  const result = assertToolWaitResult(input?.result, delivery);
  const transcriptBoundary = assertCodexToolWaitBoundary(input?.transcriptBoundary);
  if (
    transcriptBoundary.toolUseId !== delivery.toolUseId
    || transcriptBoundary.toolName !== CODEX_HARK_AWAIT_HOOK_TOOL_NAME
  ) throw new Error('tool_result_observation_transcript_boundary_mismatch');
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
  const claimReference = structuredClone(
    assertPrivateClaimReference(input?.claimReference, binding),
  );
  const intent = {
    v: TOOL_WAIT_OBSERVATION_INTENT_VERSION,
    intentId: '',
    kind: 'tool_result_observation_intent',
    eventId: delivery.eventId,
    deliveryId: delivery.deliveryId,
    awaitId: delivery.awaitId,
    wakeId: delivery.wakeId,
    toolUseId: delivery.toolUseId,
    checkpointDigest: delivery.checkpointDigest,
    wakeDeliveryDigest: delivery.wakeDeliveryDigest,
    toolResultDigest: sha256Canonical(result),
    transcriptBoundaryDigest: sha256Canonical(transcriptBoundary),
    binding,
    claimReference,
    publicReceipt: {
      v: 'hark.runtime-receipt.v2',
      sourceReceiptId: toolResultObservationSourceReceiptId(delivery.wakeId),
      observedAt: delivery.deliveredAt,
      origin: {
        protocol: 'codex',
        runtimeId: input?.runtimeId,
        taskId: transcriptBoundary.originTaskId,
        conversationId: transcriptBoundary.conversationId,
      },
      checkpointDigest: delivery.checkpointDigest,
      kind: 'tool_result_observed',
      wakeId: delivery.wakeId,
      toolResultObservation: {
        v: 'hark.tool-result-observed.v1',
        continuationMode: 'held_tool',
        observationMode: 'direct',
        conversationId: transcriptBoundary.conversationId,
        taskId: transcriptBoundary.originTaskId,
        toolName: transcriptBoundary.toolName,
        toolUseId: transcriptBoundary.toolUseId,
        inputDigest: transcriptBoundary.inputDigest,
        wakeDeliveryDigest: delivery.wakeDeliveryDigest,
        toolResultDigest: sha256Canonical(result),
      },
    },
    createdAt: timestamp(clock, 'tool_result_observation_intent'),
  };
  intent.intentId = observationIntentId(intent);
  return assertToolResultObservationIntent(intent, {
    delivery,
    result,
    transcriptBoundary,
    runtimeId: input?.runtimeId,
    claimReference,
  });
}

export function assertToolResultObservationIntent(value, expected = {}) {
  assertPlainObject(value, 'tool_result_observation_intent');
  assertExactKeys(value, [
    'v', 'intentId', 'kind', 'eventId', 'deliveryId', 'awaitId', 'wakeId',
    'toolUseId', 'checkpointDigest', 'wakeDeliveryDigest', 'toolResultDigest',
    'transcriptBoundaryDigest', 'binding', 'claimReference', 'publicReceipt',
    'createdAt',
  ], 'tool_result_observation_intent');
  if (value.v !== TOOL_WAIT_OBSERVATION_INTENT_VERSION) {
    throw new Error('tool_result_observation_intent_version_invalid');
  }
  if (value.kind !== 'tool_result_observation_intent') {
    throw new Error('tool_result_observation_intent_kind_invalid');
  }
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) {
    throw new Error('tool_result_observation_intent_event_id_invalid');
  }
  if (!DELIVERY_ID_PATTERN.test(value.deliveryId ?? '')) {
    throw new Error('tool_result_observation_intent_delivery_id_invalid');
  }
  assertIdentifier(value.awaitId, 'tool_result_observation_intent_await_id');
  assertIdentifier(value.wakeId, 'tool_result_observation_intent_wake_id');
  assertIdentifier(value.toolUseId, 'tool_result_observation_intent_tool_use_id');
  assertDigest(value.checkpointDigest, 'tool_result_observation_intent_checkpoint_digest');
  assertDigest(value.wakeDeliveryDigest, 'tool_result_observation_intent_delivery_digest');
  assertDigest(value.toolResultDigest, 'tool_result_observation_intent_result_digest');
  assertDigest(value.transcriptBoundaryDigest, 'tool_result_observation_boundary_digest');
  const binding = createPrivateClaimBinding(value.binding);
  if (
    binding.eventId !== value.eventId
    || binding.deliveryId !== value.deliveryId
    || binding.awaitId !== value.awaitId
    || binding.wakeId !== value.wakeId
    || binding.toolUseId !== value.toolUseId
    || binding.checkpointDigest !== value.checkpointDigest
    || binding.wakeDeliveryDigest !== value.wakeDeliveryDigest
    || binding.toolResultDigest !== value.toolResultDigest
  ) throw new Error('tool_result_observation_intent_binding_mismatch');
  const claimReference = assertPrivateClaimReference(value.claimReference, binding);
  const boundary = expected.transcriptBoundary === undefined
    ? undefined
    : assertCodexToolWaitBoundary(expected.transcriptBoundary);
  if (boundary && value.transcriptBoundaryDigest !== sha256Canonical(boundary)) {
    throw new Error('tool_result_observation_boundary_digest_mismatch');
  }
  assertObservationPublicReceipt(value.publicReceipt, value, boundary);
  if (
    expected.runtimeId !== undefined
    && value.publicReceipt.origin.runtimeId !== expected.runtimeId
  ) throw new Error('tool_result_observation_runtime_id_mismatch');
  if (
    expected.claimReference !== undefined
    && canonicalJson(claimReference)
      !== canonicalJson(assertPrivateClaimReference(expected.claimReference, binding))
  ) throw new Error('tool_result_observation_claim_reference_mismatch');
  if (expected.delivery !== undefined) {
    const delivery = assertWakeDelivery(expected.delivery);
    if (
      value.eventId !== delivery.eventId
      || value.deliveryId !== delivery.deliveryId
      || value.awaitId !== delivery.awaitId
      || value.wakeId !== delivery.wakeId
      || value.toolUseId !== delivery.toolUseId
      || value.checkpointDigest !== delivery.checkpointDigest
      || value.wakeDeliveryDigest !== delivery.wakeDeliveryDigest
      || value.publicReceipt.observedAt !== delivery.deliveredAt
    ) throw new Error('tool_result_observation_intent_delivery_mismatch');
  }
  if (expected.result !== undefined) {
    const result = assertToolWaitResult(expected.result, expected.delivery);
    if (value.toolResultDigest !== sha256Canonical(result)) {
      throw new Error('tool_result_observation_intent_result_mismatch');
    }
  }
  if (!/^hri_[a-f0-9]{64}$/.test(value.intentId ?? '')) {
    throw new Error('tool_result_observation_intent_id_invalid');
  }
  if (value.intentId !== observationIntentId(value)) {
    throw new Error('tool_result_observation_intent_id_mismatch');
  }
  assertTimestamp(value.createdAt, 'tool_result_observation_intent_created_at');
  assertJsonValue(value, 'tool_result_observation_intent', { secretFree: true });
  return value;
}

export function materializeToolResultObservationReceipt(intentValue, privateClaim) {
  const intent = assertToolResultObservationIntent(intentValue);
  assertPlainObject(privateClaim, 'private_claim_resolution');
  assertExactKeys(
    privateClaim,
    ['state', 'leaseToken', 'leaseGeneration'],
    'private_claim_resolution',
  );
  if (privateClaim.state !== 'pending') throw new Error('private_claim_not_pending');
  assertIdentifier(privateClaim.leaseToken, 'private_claim_lease_token', 4096);
  if (!Number.isSafeInteger(privateClaim.leaseGeneration) || privateClaim.leaseGeneration < 1) {
    throw new Error('private_claim_lease_generation_invalid');
  }
  return {
    ...structuredClone(intent.publicReceipt),
    leaseToken: privateClaim.leaseToken,
    leaseGeneration: privateClaim.leaseGeneration,
  };
}

export function assertToolResultObservationAck(value, intentValue) {
  const intent = assertToolResultObservationIntent(intentValue);
  assertPlainObject(value, 'tool_result_observation_ack');
  assertExactKeys(
    value,
    ['v', 'awaitId', 'kind', 'state', 'wakeState', 'replay'],
    'tool_result_observation_ack',
  );
  if (
    value.v !== 'hark.runtime-receipt-result.v2'
    || value.awaitId !== intent.awaitId
    || value.kind !== 'tool_result_observed'
    || value.state !== 'running'
    || value.wakeState !== 'running'
    || typeof value.replay !== 'boolean'
  ) throw new Error('tool_result_observation_ack_mismatch');
  return value;
}

export function createToolResultReturned(
  delivery,
  result,
  observation,
  clock = () => new Date(),
) {
  const expected = assertWakeDelivery(delivery);
  const exactResult = assertToolWaitResult(result, expected);
  assertPlainObject(observation, 'tool_result_observation');
  assertExactKeys(
    observation,
    ['wakeDeliveryDigest', 'transcriptBoundary'],
    'tool_result_observation',
  );
  const wakeDeliveryDigest = assertDigest(
    observation.wakeDeliveryDigest,
    'wake_delivery_digest',
  );
  if (wakeDeliveryDigest !== expected.wakeDeliveryDigest) {
    throw new Error('tool_result_wake_delivery_digest_mismatch');
  }
  const transcriptBoundary = assertCodexToolWaitBoundary(observation.transcriptBoundary);
  if (
    transcriptBoundary.toolUseId !== expected.toolUseId
    || transcriptBoundary.toolName !== CODEX_HARK_AWAIT_HOOK_TOOL_NAME
  ) throw new Error('tool_result_transcript_boundary_mismatch');
  return assertToolResultReturned({
    v: TOOL_WAIT_RESULT_RETURNED_VERSION,
    kind: 'tool_result_returned',
    eventId: expected.eventId,
    deliveryId: expected.deliveryId,
    awaitId: expected.awaitId,
    wakeId: expected.wakeId,
    toolUseId: expected.toolUseId,
    checkpointDigest: expected.checkpointDigest,
    resultDigest: sha256Canonical(exactResult),
    wakeDeliveryDigest,
    transcriptBoundary: structuredClone(transcriptBoundary),
    returnedAt: timestamp(clock, 'tool_result_returned'),
  }, expected, exactResult);
}

export function assertToolResultReturned(value, delivery = undefined, result = undefined) {
  assertPlainObject(value, 'tool_result_returned');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'deliveryId', 'awaitId', 'wakeId', 'toolUseId',
    'checkpointDigest', 'resultDigest', 'wakeDeliveryDigest', 'transcriptBoundary',
    'returnedAt',
  ], 'tool_result_returned');
  if (value.v !== TOOL_WAIT_RESULT_RETURNED_VERSION) {
    throw new Error('tool_result_returned_version_invalid');
  }
  if (value.kind !== 'tool_result_returned') throw new Error('tool_result_returned_kind_invalid');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) throw new Error('tool_result_event_id_invalid');
  if (!DELIVERY_ID_PATTERN.test(value.deliveryId ?? '')) throw new Error('tool_result_delivery_id_invalid');
  assertIdentifier(value.awaitId, 'await_id');
  assertIdentifier(value.wakeId, 'wake_id');
  assertIdentifier(value.toolUseId, 'tool_use_id');
  assertDigest(value.checkpointDigest, 'checkpoint_digest');
  assertDigest(value.resultDigest, 'result_digest');
  assertDigest(value.wakeDeliveryDigest, 'wake_delivery_digest');
  const transcriptBoundary = assertCodexToolWaitBoundary(value.transcriptBoundary);
  if (
    transcriptBoundary.toolUseId !== value.toolUseId
    || transcriptBoundary.toolName !== CODEX_HARK_AWAIT_HOOK_TOOL_NAME
  ) throw new Error('tool_result_transcript_boundary_mismatch');
  assertTimestamp(value.returnedAt, 'tool_result_returned_at');
  if (delivery !== undefined) {
    const expected = assertWakeDelivery(delivery);
    if (value.wakeDeliveryDigest !== expected.wakeDeliveryDigest) {
      throw new Error('tool_result_returned_wake_delivery_digest_mismatch');
    }
    if (
      value.eventId !== expected.eventId
      || value.deliveryId !== expected.deliveryId
      || value.awaitId !== expected.awaitId
      || value.wakeId !== expected.wakeId
      || value.toolUseId !== expected.toolUseId
      || value.checkpointDigest !== expected.checkpointDigest
    ) throw new Error('tool_result_returned_delivery_mismatch');
  }
  if (result !== undefined) {
    const expected = assertToolWaitResult(result, delivery);
    if (value.resultDigest !== sha256Canonical(expected)) {
      throw new Error('tool_result_returned_digest_mismatch');
    }
  }
  return value;
}

export function createCompletionPosted(
  returned,
  input,
  clock = () => new Date(),
) {
  const expected = assertToolResultReturned(returned);
  return assertCompletionPosted({
    v: TOOL_WAIT_COMPLETION_POSTED_VERSION,
    kind: 'completion_posted',
    eventId: expected.eventId,
    deliveryId: expected.deliveryId,
    awaitId: expected.awaitId,
    wakeId: expected.wakeId,
    sourceReceiptId: input?.sourceReceiptId,
    proofDigest: input?.proofDigest,
    certificationDigest: input?.certificationDigest,
    postedAt: timestamp(clock, 'completion_posted'),
  }, expected);
}

export function assertCompletionPosted(value, returned = undefined) {
  assertPlainObject(value, 'completion_posted');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'deliveryId', 'awaitId', 'wakeId', 'sourceReceiptId',
    'proofDigest', 'certificationDigest', 'postedAt',
  ], 'completion_posted');
  if (value.v !== TOOL_WAIT_COMPLETION_POSTED_VERSION) {
    throw new Error('completion_posted_version_invalid');
  }
  if (value.kind !== 'completion_posted') throw new Error('completion_posted_kind_invalid');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) throw new Error('completion_posted_event_id_invalid');
  if (!DELIVERY_ID_PATTERN.test(value.deliveryId ?? '')) {
    throw new Error('completion_posted_delivery_id_invalid');
  }
  assertIdentifier(value.awaitId, 'await_id');
  assertIdentifier(value.wakeId, 'wake_id');
  assertIdentifier(value.sourceReceiptId, 'source_receipt_id', 200);
  assertDigest(value.proofDigest, 'proof_digest');
  assertDigest(value.certificationDigest, 'certification_digest');
  assertTimestamp(value.postedAt, 'completion_posted_at');
  if (returned !== undefined) {
    const expected = assertToolResultReturned(returned);
    if (
      value.eventId !== expected.eventId
      || value.deliveryId !== expected.deliveryId
      || value.awaitId !== expected.awaitId
      || value.wakeId !== expected.wakeId
    ) throw new Error('completion_posted_result_mismatch');
  }
  return value;
}

export function createToolError(request, input, clock = () => new Date()) {
  const expected = assertAwaitRequest(request);
  return assertToolError({
    v: TOOL_WAIT_TOOL_ERROR_VERSION,
    kind: 'tool_error',
    eventId: expected.eventId,
    failureCode: input?.failureCode,
    errorDigest: input?.errorDigest,
    observedAt: timestamp(clock, 'tool_error'),
  }, expected);
}

export function assertToolError(value, request = undefined) {
  assertPlainObject(value, 'tool_error');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'failureCode', 'errorDigest', 'observedAt',
  ], 'tool_error');
  if (value.v !== TOOL_WAIT_TOOL_ERROR_VERSION) throw new Error('tool_error_version_invalid');
  if (value.kind !== 'tool_error') throw new Error('tool_error_kind_invalid');
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) throw new Error('tool_error_event_id_invalid');
  if (!TOOL_ERROR_FAILURE_CODES.has(value.failureCode)) {
    throw new Error('tool_error_failure_code_invalid');
  }
  assertDigest(value.errorDigest, 'tool_error_digest');
  assertTimestamp(value.observedAt, 'tool_error_observed_at');
  if (request !== undefined && value.eventId !== assertAwaitRequest(request).eventId) {
    throw new Error('tool_error_request_mismatch');
  }
  return value;
}

export function createToolErrorObservation(
  request,
  toolError,
  input,
  clock = () => new Date(),
) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedError = assertToolError(toolError, expectedRequest);
  assertDigest(input?.responseDigest, 'tool_error_response_digest');
  return assertToolErrorObservation({
    v: TOOL_WAIT_TOOL_ERROR_OBSERVATION_VERSION,
    kind: 'tool_error_observation',
    eventId: expectedRequest.eventId,
    toolErrorDigest: sha256Canonical(expectedError),
    responseDigest: input.responseDigest,
    observedAt: timestamp(clock, 'tool_error_observation'),
  }, expectedRequest, expectedError);
}

export function assertToolErrorObservation(
  value,
  request = undefined,
  toolError = undefined,
) {
  assertPlainObject(value, 'tool_error_observation');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'toolErrorDigest', 'responseDigest', 'observedAt',
  ], 'tool_error_observation');
  if (value.v !== TOOL_WAIT_TOOL_ERROR_OBSERVATION_VERSION) {
    throw new Error('tool_error_observation_version_invalid');
  }
  if (value.kind !== 'tool_error_observation') {
    throw new Error('tool_error_observation_kind_invalid');
  }
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) {
    throw new Error('tool_error_observation_event_id_invalid');
  }
  assertDigest(value.toolErrorDigest, 'tool_error_digest');
  assertDigest(value.responseDigest, 'tool_error_response_digest');
  assertTimestamp(value.observedAt, 'tool_error_observation_observed_at');
  if (request !== undefined && value.eventId !== assertAwaitRequest(request).eventId) {
    throw new Error('tool_error_observation_request_mismatch');
  }
  if (
    toolError !== undefined
    && value.toolErrorDigest !== sha256Canonical(assertToolError(toolError, request))
  ) throw new Error('tool_error_observation_error_mismatch');
  return value;
}

function assertNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}_invalid`);
  return value;
}

function assertOriginAbortProof(value, request, armAttempt) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedAttempt = assertArmAttempt(armAttempt, expectedRequest);
  assertPlainObject(value, 'held_call_origin_abort_proof');
  assertExactKeys(value, ['v', 'appServer', 'rollout'], 'held_call_origin_abort_proof');
  if (value.v !== 'hark.codex-owner-abort-proof.v1') {
    throw new Error('held_call_origin_abort_proof_version_invalid');
  }

  assertPlainObject(value.appServer, 'held_call_origin_abort_app_server');
  assertExactKeys(value.appServer, [
    'v', 'conversationId', 'originTaskId', 'turnStatus', 'observedAt',
  ], 'held_call_origin_abort_app_server');
  if (value.appServer.v !== 'hark.codex-app-server-origin-terminal.v1') {
    throw new Error('held_call_origin_abort_app_server_version_invalid');
  }
  if (
    value.appServer.conversationId !== expectedRequest.sessionId
    || value.appServer.originTaskId !== expectedRequest.turnId
  ) throw new Error('held_call_origin_abort_app_server_identity_mismatch');
  if (!['failed', 'interrupted'].includes(value.appServer.turnStatus)) {
    throw new Error('held_call_origin_abort_app_server_terminal_invalid');
  }
  assertTimestamp(value.appServer.observedAt, 'held_call_origin_abort_app_server_observed_at');

  assertPlainObject(value.rollout, 'held_call_origin_abort_rollout');
  assertExactKeys(value.rollout, [
    'v', 'historySource', 'conversationId', 'originTaskId', 'originTerminal',
    'interveningTaskIds', 'rollbackMarkerCount', 'historyMutationCount', 'scannedAt',
    'historyDigest',
  ], 'held_call_origin_abort_rollout');
  if (
    value.rollout.v !== 'hark.codex-wait-preflight.v1'
    || value.rollout.historySource !== 'codex.rollout-jsonl.v1'
  ) throw new Error('held_call_origin_abort_rollout_version_invalid');
  if (
    value.rollout.conversationId !== expectedRequest.sessionId
    || value.rollout.originTaskId !== expectedRequest.turnId
    || expectedAttempt.transcriptBoundary.conversationId !== value.rollout.conversationId
    || expectedAttempt.transcriptBoundary.originTaskId !== value.rollout.originTaskId
    || expectedAttempt.transcriptBoundary.toolUseId !== expectedRequest.toolUseId
    || expectedAttempt.transcriptBoundary.inputDigest !== expectedRequest.originalInputDigest
  ) throw new Error('held_call_origin_abort_rollout_identity_mismatch');
  assertPlainObject(value.rollout.originTerminal, 'held_call_origin_abort_rollout_terminal');
  assertExactKeys(
    value.rollout.originTerminal,
    ['type', 'observedAt'],
    'held_call_origin_abort_rollout_terminal',
  );
  if (value.rollout.originTerminal.type !== 'turn_aborted') {
    throw new Error('held_call_origin_abort_rollout_terminal_invalid');
  }
  assertTimestamp(
    value.rollout.originTerminal.observedAt,
    'held_call_origin_abort_rollout_terminal_observed_at',
  );
  if (
    Date.parse(value.appServer.observedAt)
      < Date.parse(value.rollout.originTerminal.observedAt)
  ) throw new Error('held_call_origin_abort_app_server_observation_backdated');
  if (!Array.isArray(value.rollout.interveningTaskIds)) {
    throw new Error('held_call_origin_abort_intervening_tasks_invalid');
  }
  value.rollout.interveningTaskIds.forEach((taskId) => (
    assertIdentifier(taskId, 'held_call_origin_abort_intervening_task_id', 512)
  ));
  assertNonnegativeInteger(
    value.rollout.rollbackMarkerCount,
    'held_call_origin_abort_rollback_marker_count',
  );
  assertNonnegativeInteger(
    value.rollout.historyMutationCount,
    'held_call_origin_abort_history_mutation_count',
  );
  if (
    value.rollout.interveningTaskIds.length !== 0
    || value.rollout.rollbackMarkerCount !== 0
    || value.rollout.historyMutationCount !== 0
  ) throw new Error('held_call_origin_abort_rollout_not_exact');
  assertTimestamp(value.rollout.scannedAt, 'held_call_origin_abort_rollout_scanned_at');
  if (
    Date.parse(value.rollout.scannedAt)
      < Date.parse(value.rollout.originTerminal.observedAt)
  ) throw new Error('held_call_origin_abort_rollout_scan_backdated');
  assertDigest(value.rollout.historyDigest, 'held_call_origin_abort_history_digest');
  assertJsonValue(value, 'held_call_origin_abort_proof', { secretFree: true });
  return JSON.parse(canonicalJson(value));
}

export function createHeldCallOriginAbortReceipt(
  request,
  armAttempt,
  abortProof,
  clock = () => new Date(),
) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedAttempt = assertArmAttempt(armAttempt, expectedRequest);
  const proof = assertOriginAbortProof(abortProof, expectedRequest, expectedAttempt);
  return assertHeldCallOriginAbortReceipt({
    v: HELD_CALL_ORIGIN_ABORT_VERSION,
    kind: 'held_call_origin_abort',
    eventId: expectedRequest.eventId,
    requestDigest: sha256Canonical(expectedRequest),
    armAttemptDigest: sha256Canonical(expectedAttempt),
    armRequestDigest: expectedAttempt.armRequestDigest,
    transcriptBoundaryDigest: expectedAttempt.transcriptBoundaryDigest,
    appServerTerminalEvidence: proof.appServer,
    appServerTerminalEvidenceDigest: sha256Canonical(
      appServerAbortEvidenceSemantic(proof.appServer),
    ),
    rolloutAbortProof: proof.rollout,
    rolloutAbortProofDigest: sha256Canonical(rolloutAbortProofSemantic(proof.rollout)),
    provenAt: timestamp(clock, 'held_call_origin_abort'),
  }, expectedRequest, expectedAttempt);
}

export function assertHeldCallOriginAbortReceipt(
  value,
  request = undefined,
  armAttempt = undefined,
) {
  assertPlainObject(value, 'held_call_origin_abort');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'requestDigest', 'armAttemptDigest', 'armRequestDigest',
    'transcriptBoundaryDigest', 'appServerTerminalEvidence',
    'appServerTerminalEvidenceDigest', 'rolloutAbortProof', 'rolloutAbortProofDigest',
    'provenAt',
  ], 'held_call_origin_abort');
  if (value.v !== HELD_CALL_ORIGIN_ABORT_VERSION) {
    throw new Error('held_call_origin_abort_version_invalid');
  }
  if (value.kind !== 'held_call_origin_abort') {
    throw new Error('held_call_origin_abort_kind_invalid');
  }
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) {
    throw new Error('held_call_origin_abort_event_id_invalid');
  }
  for (const [field, label] of [
    ['requestDigest', 'held_call_origin_abort_request_digest'],
    ['armAttemptDigest', 'held_call_origin_abort_arm_attempt_digest'],
    ['armRequestDigest', 'held_call_origin_abort_arm_request_digest'],
    ['transcriptBoundaryDigest', 'held_call_origin_abort_transcript_boundary_digest'],
    ['appServerTerminalEvidenceDigest', 'held_call_origin_abort_app_server_digest'],
    ['rolloutAbortProofDigest', 'held_call_origin_abort_rollout_digest'],
  ]) assertDigest(value[field], label);
  assertTimestamp(value.provenAt, 'held_call_origin_abort_proven_at');
  if (
    value.appServerTerminalEvidenceDigest !== sha256Canonical(
      appServerAbortEvidenceSemantic(value.appServerTerminalEvidence),
    )
    || value.rolloutAbortProofDigest !== sha256Canonical(
      rolloutAbortProofSemantic(value.rolloutAbortProof),
    )
  ) throw new Error('held_call_origin_abort_evidence_digest_mismatch');
  if (request === undefined || armAttempt === undefined) {
    throw new Error('held_call_origin_abort_context_required');
  }
  const expectedRequest = assertAwaitRequest(request);
  const expectedAttempt = assertArmAttempt(armAttempt, expectedRequest);
  const proof = assertOriginAbortProof({
    v: 'hark.codex-owner-abort-proof.v1',
    appServer: value.appServerTerminalEvidence,
    rollout: value.rolloutAbortProof,
  }, expectedRequest, expectedAttempt);
  if (
    Date.parse(value.provenAt) < Date.parse(proof.appServer.observedAt)
    || Date.parse(value.provenAt) < Date.parse(proof.rollout.scannedAt)
  ) throw new Error('held_call_origin_abort_proven_at_backdated');
  if (
    value.eventId !== expectedRequest.eventId
    || value.requestDigest !== sha256Canonical(expectedRequest)
    || value.armAttemptDigest !== sha256Canonical(expectedAttempt)
    || value.armRequestDigest !== expectedAttempt.armRequestDigest
    || value.transcriptBoundaryDigest !== expectedAttempt.transcriptBoundaryDigest
    || value.appServerTerminalEvidenceDigest !== sha256Canonical(
      appServerAbortEvidenceSemantic(proof.appServer),
    )
    || value.rolloutAbortProofDigest !== sha256Canonical(
      rolloutAbortProofSemantic(proof.rollout),
    )
  ) throw new Error('held_call_origin_abort_binding_mismatch');
  assertJsonValue(value, 'held_call_origin_abort', { secretFree: true });
  return value;
}

function normalizeHeldCallTransitionDecisionRequest(
  value,
  decision,
  request,
  armAttempt,
) {
  assertPlainObject(value, 'held_call_transition_decision_request');
  if (decision === 'commit') {
    assertExactKeys(
      value,
      ['v', 'commitNonce', 'checkpointDigest'],
      'held_call_transition_commit_request',
    );
    if (value.v !== 'hark.suspension-commit.v2') {
      throw new Error('held_call_transition_commit_request_version_invalid');
    }
    if (!/^hkc_[A-Za-z0-9_-]{32}$/.test(value.commitNonce ?? '')) {
      throw new Error('held_call_transition_commit_nonce_invalid');
    }
    if (value.checkpointDigest !== armAttempt.checkpointDigest) {
      throw new Error('held_call_transition_commit_checkpoint_mismatch');
    }
    assertDigest(value.checkpointDigest, 'held_call_transition_commit_checkpoint_digest');
  } else if (decision === 'cancel') {
    assertExactKeys(
      value,
      ['v', 'requestId', 'reason'],
      'held_call_transition_cancel_request',
    );
    if (value.v !== 'hark.await-cancel.v2') {
      throw new Error('held_call_transition_cancel_request_version_invalid');
    }
    if (value.requestId !== `hkc_tool_error_${request.eventId.slice(4)}`) {
      throw new Error('held_call_transition_cancel_request_id_mismatch');
    }
    if (value.reason !== 'codex_held_tool_failed_before_suspension') {
      throw new Error('held_call_transition_cancel_reason_mismatch');
    }
  } else {
    throw new Error('held_call_transition_decision_invalid');
  }
  assertJsonValue(value, 'held_call_transition_decision_request', { secretFree: true });
  return JSON.parse(canonicalJson(value));
}

function createHeldCallTransitionEvidence(request, armAttempt, input) {
  if (input?.evidenceKind === 'waiter_ready') {
    if (input.decision !== 'commit') {
      throw new Error('held_call_transition_commit_evidence_decision_mismatch');
    }
    const armBinding = assertArmBinding(input.armBinding, request);
    const waiterReady = assertWaiterReady(input.waiterReady, request, armBinding);
    return {
      kind: 'waiter_ready',
      waiterReadyDigest: sha256Canonical(waiterReady),
    };
  }
  if (input?.evidenceKind === 'tool_error_observation') {
    if (input.decision !== 'cancel') {
      throw new Error('held_call_transition_cancel_evidence_decision_mismatch');
    }
    const toolError = assertToolError(input.toolError, request);
    const observation = assertToolErrorObservation(
      input.toolErrorObservation,
      request,
      toolError,
    );
    return {
      kind: 'tool_error_observation',
      toolErrorDigest: sha256Canonical(toolError),
      toolErrorObservationDigest: sha256Canonical(observation),
    };
  }
  if (input?.evidenceKind === 'origin_abort') {
    if (input.decision !== 'cancel') {
      throw new Error('held_call_transition_cancel_evidence_decision_mismatch');
    }
    const receipt = assertHeldCallOriginAbortReceipt(
      input.originAbortReceipt,
      request,
      armAttempt,
    );
    return {
      kind: 'origin_abort',
      originAbortReceiptDigest: sha256Canonical(receipt),
    };
  }
  throw new Error('held_call_transition_evidence_kind_invalid');
}

function heldCallTransitionEvidenceRecords(input) {
  return {
    armBinding: input?.armBinding,
    waiterReady: input?.waiterReady,
    toolError: input?.toolError,
    toolErrorObservation: input?.toolErrorObservation,
    originAbortReceipt: input?.originAbortReceipt,
  };
}

export function createHeldCallTransitionAuthority(
  request,
  armAttempt,
  input,
  clock = () => new Date(),
) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedAttempt = assertArmAttempt(armAttempt, expectedRequest);
  const armBinding = assertArmBinding(input?.armBinding, expectedRequest);
  assertArmAttemptLocalClosure(expectedRequest, expectedAttempt, { armBinding });
  const decisionRequest = normalizeHeldCallTransitionDecisionRequest(
    input?.decisionRequest,
    input?.decision,
    expectedRequest,
    expectedAttempt,
  );
  const evidence = createHeldCallTransitionEvidence(
    expectedRequest,
    expectedAttempt,
    input,
  );
  return assertHeldCallTransitionAuthority({
    v: HELD_CALL_TRANSITION_AUTHORITY_VERSION,
    kind: 'held_call_transition_authority',
    eventId: expectedRequest.eventId,
    installationId: expectedAttempt.installationId,
    awaitId: armBinding.awaitId,
    armBindingDigest: sha256Canonical(armBinding),
    requestDigest: sha256Canonical(expectedRequest),
    armAttemptDigest: sha256Canonical(expectedAttempt),
    armRequestDigest: expectedAttempt.armRequestDigest,
    transcriptBoundaryDigest: expectedAttempt.transcriptBoundaryDigest,
    decision: input?.decision,
    decisionRequest,
    decisionRequestDigest: sha256Canonical(decisionRequest),
    evidence,
    electedAt: timestamp(clock, 'held_call_transition_authority'),
  }, expectedRequest, expectedAttempt, heldCallTransitionEvidenceRecords(input));
}

export function assertHeldCallTransitionAuthority(
  value,
  request = undefined,
  armAttempt = undefined,
  records = undefined,
) {
  assertPlainObject(value, 'held_call_transition_authority');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'installationId', 'awaitId', 'armBindingDigest',
    'requestDigest', 'armAttemptDigest', 'armRequestDigest', 'transcriptBoundaryDigest',
    'decision', 'decisionRequest', 'decisionRequestDigest', 'evidence', 'electedAt',
  ], 'held_call_transition_authority');
  if (value.v !== HELD_CALL_TRANSITION_AUTHORITY_VERSION) {
    throw new Error('held_call_transition_authority_version_invalid');
  }
  if (value.kind !== 'held_call_transition_authority') {
    throw new Error('held_call_transition_authority_kind_invalid');
  }
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) {
    throw new Error('held_call_transition_authority_event_id_invalid');
  }
  assertIdentifier(value.installationId, 'held_call_transition_installation_id', 512);
  assertIdentifier(value.awaitId, 'held_call_transition_await_id', 512);
  for (const [field, label] of [
    ['armBindingDigest', 'held_call_transition_arm_binding_digest'],
    ['requestDigest', 'held_call_transition_request_digest'],
    ['armAttemptDigest', 'held_call_transition_arm_attempt_digest'],
    ['armRequestDigest', 'held_call_transition_arm_request_digest'],
    ['transcriptBoundaryDigest', 'held_call_transition_boundary_digest'],
    ['decisionRequestDigest', 'held_call_transition_decision_request_digest'],
  ]) assertDigest(value[field], label);
  if (!['commit', 'cancel'].includes(value.decision)) {
    throw new Error('held_call_transition_decision_invalid');
  }
  assertTimestamp(value.electedAt, 'held_call_transition_authority_elected_at');
  if (request === undefined || armAttempt === undefined) {
    throw new Error('held_call_transition_authority_context_required');
  }
  const expectedRequest = assertAwaitRequest(request);
  const expectedAttempt = assertArmAttempt(armAttempt, expectedRequest);
  let expectedArmBinding = null;
  if (records?.armBinding !== undefined) {
    expectedArmBinding = assertArmBinding(records.armBinding, expectedRequest);
    assertArmAttemptLocalClosure(expectedRequest, expectedAttempt, {
      armBinding: expectedArmBinding,
    });
    if (
      value.awaitId !== expectedArmBinding.awaitId
      || value.armBindingDigest !== sha256Canonical(expectedArmBinding)
    ) throw new Error('held_call_transition_arm_binding_mismatch');
  }
  const decisionRequest = normalizeHeldCallTransitionDecisionRequest(
    value.decisionRequest,
    value.decision,
    expectedRequest,
    expectedAttempt,
  );
  if (value.decisionRequestDigest !== sha256Canonical(decisionRequest)) {
    throw new Error('held_call_transition_decision_request_digest_mismatch');
  }
  assertPlainObject(value.evidence, 'held_call_transition_evidence');
  if (value.evidence.kind === 'waiter_ready') {
    assertExactKeys(
      value.evidence,
      ['kind', 'waiterReadyDigest'],
      'held_call_transition_evidence',
    );
    if (value.decision !== 'commit') {
      throw new Error('held_call_transition_commit_evidence_decision_mismatch');
    }
    assertDigest(value.evidence.waiterReadyDigest, 'held_call_transition_waiter_ready_digest');
    if (records?.waiterReady !== undefined) {
      if (!expectedArmBinding) {
        throw new Error('held_call_transition_arm_binding_context_required');
      }
      const waiterReady = assertWaiterReady(
        records.waiterReady,
        expectedRequest,
        expectedArmBinding,
      );
      if (value.evidence.waiterReadyDigest !== sha256Canonical(waiterReady)) {
        throw new Error('held_call_transition_commit_evidence_mismatch');
      }
    }
  } else if (value.evidence.kind === 'tool_error_observation') {
    assertExactKeys(
      value.evidence,
      ['kind', 'toolErrorDigest', 'toolErrorObservationDigest'],
      'held_call_transition_evidence',
    );
    if (value.decision !== 'cancel') {
      throw new Error('held_call_transition_cancel_evidence_decision_mismatch');
    }
    assertDigest(value.evidence.toolErrorDigest, 'held_call_transition_tool_error_digest');
    assertDigest(
      value.evidence.toolErrorObservationDigest,
      'held_call_transition_tool_error_observation_digest',
    );
    if (
      records?.toolError !== undefined
      || records?.toolErrorObservation !== undefined
    ) {
      const toolError = assertToolError(records.toolError, expectedRequest);
      const observation = assertToolErrorObservation(
        records.toolErrorObservation,
        expectedRequest,
        toolError,
      );
      if (
        value.evidence.toolErrorDigest !== sha256Canonical(toolError)
        || value.evidence.toolErrorObservationDigest !== sha256Canonical(observation)
      ) throw new Error('held_call_transition_tool_error_evidence_mismatch');
    }
  } else if (value.evidence.kind === 'origin_abort') {
    assertExactKeys(
      value.evidence,
      ['kind', 'originAbortReceiptDigest'],
      'held_call_transition_evidence',
    );
    if (value.decision !== 'cancel') {
      throw new Error('held_call_transition_cancel_evidence_decision_mismatch');
    }
    assertDigest(
      value.evidence.originAbortReceiptDigest,
      'held_call_transition_origin_abort_digest',
    );
    if (records?.originAbortReceipt !== undefined) {
      const receipt = assertHeldCallOriginAbortReceipt(
        records.originAbortReceipt,
        expectedRequest,
        expectedAttempt,
      );
      if (value.evidence.originAbortReceiptDigest !== sha256Canonical(receipt)) {
        throw new Error('held_call_transition_origin_abort_evidence_mismatch');
      }
    }
  } else {
    throw new Error('held_call_transition_evidence_kind_invalid');
  }
  if (
    value.eventId !== expectedRequest.eventId
    || value.installationId !== expectedAttempt.installationId
    || value.requestDigest !== sha256Canonical(expectedRequest)
    || value.armAttemptDigest !== sha256Canonical(expectedAttempt)
    || value.armRequestDigest !== expectedAttempt.armRequestDigest
    || value.transcriptBoundaryDigest !== expectedAttempt.transcriptBoundaryDigest
  ) throw new Error('held_call_transition_authority_binding_mismatch');
  assertJsonValue(value, 'held_call_transition_authority', { secretFree: true });
  return value;
}

function nullableDigest(value, label) {
  if (value === null) return null;
  return assertDigest(value, label);
}

export function createHeldCallReconciliationIntent(
  request,
  armAttempt,
  originAbortReceipt,
  input,
  clock = () => new Date(),
) {
  const expectedRequest = assertAwaitRequest(request);
  const expectedAttempt = assertArmAttempt(armAttempt, expectedRequest);
  const receipt = assertHeldCallOriginAbortReceipt(
    originAbortReceipt,
    expectedRequest,
    expectedAttempt,
  );
  const armBinding = input?.armBinding ?? null;
  const waiterReady = input?.waiterReady ?? null;
  const commitAttempt = input?.commitAttempt ?? null;
  if (armBinding !== null) assertArmBinding(armBinding, expectedRequest);
  if (waiterReady !== null) assertWaiterReady(waiterReady, expectedRequest, armBinding ?? undefined);
  if (commitAttempt !== null) {
    assertCommitAttempt(commitAttempt, expectedRequest, armBinding ?? undefined, waiterReady ?? undefined);
  }
  return assertHeldCallReconciliationIntent({
    v: HELD_CALL_RECONCILIATION_INTENT_VERSION,
    kind: 'held_call_reconciliation_intent',
    eventId: expectedRequest.eventId,
    stage: input?.stage,
    originAbortReceiptDigest: sha256Canonical(receipt),
    requestDigest: sha256Canonical(expectedRequest),
    armAttemptDigest: sha256Canonical(expectedAttempt),
    armRequestDigest: expectedAttempt.armRequestDigest,
    transcriptBoundaryDigest: expectedAttempt.transcriptBoundaryDigest,
    armBindingDigest: armBinding === null ? null : sha256Canonical(armBinding),
    waiterReadyDigest: waiterReady === null ? null : sha256Canonical(waiterReady),
    commitAttemptDigest: commitAttempt === null ? null : sha256Canonical(commitAttempt),
    remoteRequestDigest: input?.remoteRequestDigest,
    createdAt: timestamp(clock, 'held_call_reconciliation_intent'),
  }, expectedRequest, expectedAttempt, receipt, {
    armBinding,
    waiterReady,
    commitAttempt,
  });
}

export function assertHeldCallReconciliationIntent(
  value,
  request = undefined,
  armAttempt = undefined,
  originAbortReceipt = undefined,
  records = undefined,
) {
  assertPlainObject(value, 'held_call_reconciliation_intent');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'stage', 'originAbortReceiptDigest', 'requestDigest',
    'armAttemptDigest', 'armRequestDigest', 'transcriptBoundaryDigest',
    'armBindingDigest', 'waiterReadyDigest', 'commitAttemptDigest',
    'remoteRequestDigest', 'createdAt',
  ], 'held_call_reconciliation_intent');
  if (value.v !== HELD_CALL_RECONCILIATION_INTENT_VERSION) {
    throw new Error('held_call_reconciliation_intent_version_invalid');
  }
  if (value.kind !== 'held_call_reconciliation_intent') {
    throw new Error('held_call_reconciliation_intent_kind_invalid');
  }
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) {
    throw new Error('held_call_reconciliation_intent_event_id_invalid');
  }
  if (!['arm', 'commit'].includes(value.stage)) {
    throw new Error('held_call_reconciliation_intent_stage_invalid');
  }
  for (const [field, label] of [
    ['originAbortReceiptDigest', 'held_call_reconciliation_origin_abort_digest'],
    ['requestDigest', 'held_call_reconciliation_request_digest'],
    ['armAttemptDigest', 'held_call_reconciliation_arm_attempt_digest'],
    ['armRequestDigest', 'held_call_reconciliation_arm_request_digest'],
    ['transcriptBoundaryDigest', 'held_call_reconciliation_boundary_digest'],
    ['remoteRequestDigest', 'held_call_reconciliation_remote_request_digest'],
  ]) assertDigest(value[field], label);
  nullableDigest(value.armBindingDigest, 'held_call_reconciliation_arm_binding_digest');
  nullableDigest(value.waiterReadyDigest, 'held_call_reconciliation_waiter_ready_digest');
  nullableDigest(value.commitAttemptDigest, 'held_call_reconciliation_commit_attempt_digest');
  assertTimestamp(value.createdAt, 'held_call_reconciliation_intent_created_at');
  if (request === undefined || armAttempt === undefined || originAbortReceipt === undefined) {
    throw new Error('held_call_reconciliation_intent_context_required');
  }
  const expectedRequest = assertAwaitRequest(request);
  const expectedAttempt = assertArmAttempt(armAttempt, expectedRequest);
  const receipt = assertHeldCallOriginAbortReceipt(
    originAbortReceipt,
    expectedRequest,
    expectedAttempt,
  );
  if (records === undefined) {
    assertJsonValue(value, 'held_call_reconciliation_intent', { secretFree: true });
    return value;
  }
  const armBinding = records.armBinding ?? null;
  const waiterReady = records.waiterReady ?? null;
  const commitAttempt = records.commitAttempt ?? null;
  if (armBinding !== null) assertArmBinding(armBinding, expectedRequest);
  if (waiterReady !== null) assertWaiterReady(waiterReady, expectedRequest, armBinding ?? undefined);
  if (commitAttempt !== null) {
    assertCommitAttempt(commitAttempt, expectedRequest, armBinding ?? undefined, waiterReady ?? undefined);
  }
  if (
    value.eventId !== expectedRequest.eventId
    || value.originAbortReceiptDigest !== sha256Canonical(receipt)
    || value.requestDigest !== sha256Canonical(expectedRequest)
    || value.armAttemptDigest !== sha256Canonical(expectedAttempt)
    || value.armRequestDigest !== expectedAttempt.armRequestDigest
    || value.transcriptBoundaryDigest !== expectedAttempt.transcriptBoundaryDigest
    || value.armBindingDigest !== (armBinding === null ? null : sha256Canonical(armBinding))
    || value.waiterReadyDigest !== (waiterReady === null ? null : sha256Canonical(waiterReady))
    || value.commitAttemptDigest !== (commitAttempt === null ? null : sha256Canonical(commitAttempt))
  ) throw new Error('held_call_reconciliation_intent_binding_mismatch');
  if (value.stage === 'commit' && (armBinding === null || waiterReady === null || commitAttempt === null)) {
    throw new Error('held_call_reconciliation_commit_context_required');
  }
  if (value.stage === 'arm' && commitAttempt !== null) {
    throw new Error('held_call_reconciliation_arm_commit_forbidden');
  }
  const expectedRemoteRequestDigest = value.stage === 'arm'
    ? expectedAttempt.armRequestDigest
    : commitAttempt.commitRequestDigest;
  if (value.remoteRequestDigest !== expectedRemoteRequestDigest) {
    throw new Error('held_call_reconciliation_remote_request_mismatch');
  }
  assertJsonValue(value, 'held_call_reconciliation_intent', { secretFree: true });
  return value;
}

function assertApiResponseDigests(value, stage) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    throw new Error('held_call_reconciliation_api_responses_invalid');
  }
  const methods = [];
  for (const response of value) {
    assertPlainObject(response, 'held_call_reconciliation_api_response');
    assertExactKeys(
      response,
      ['method', 'digest', 'replay'],
      'held_call_reconciliation_api_response',
    );
    if (!['arm', 'commit', 'cancel'].includes(response.method)) {
      throw new Error('held_call_reconciliation_api_method_invalid');
    }
    assertDigest(response.digest, 'held_call_reconciliation_api_response_digest');
    if (typeof response.replay !== 'boolean') {
      throw new Error('held_call_reconciliation_api_replay_invalid');
    }
    methods.push(response.method);
  }
  const expected = stage === 'commit'
    ? ['commit']
    : methods[0] === 'arm' ? ['arm', 'cancel'] : ['cancel'];
  if (canonicalJson(methods) !== canonicalJson(expected)) {
    throw new Error('held_call_reconciliation_api_sequence_invalid');
  }
  return value;
}

export function createHeldCallReconciliationApplied(
  request,
  intent,
  input,
  clock = () => new Date(),
) {
  const expectedRequest = assertAwaitRequest(request);
  const armBinding = assertArmBinding(input?.armBinding, expectedRequest);
  const transcriptBoundary = assertTranscriptBoundary(
    input?.transcriptBoundary,
    expectedRequest,
    armBinding,
  );
  const waiterReady = assertWaiterReady(input?.waiterReady, expectedRequest, armBinding);
  const suspensionCommitted = input?.suspensionCommitted ?? null;
  const terminal = input?.terminal ?? null;
  if (suspensionCommitted !== null) {
    assertSuspensionCommitted(suspensionCommitted, expectedRequest, armBinding, waiterReady);
  }
  if (terminal !== null) assertAwaitRequestTerminal(terminal, expectedRequest);
  return assertHeldCallReconciliationApplied({
    v: HELD_CALL_RECONCILIATION_APPLIED_VERSION,
    kind: 'held_call_reconciliation_applied',
    eventId: expectedRequest.eventId,
    stage: intent?.stage,
    intentDigest: sha256Canonical(intent),
    apiResponses: structuredClone(input?.apiResponses),
    armBindingDigest: sha256Canonical(armBinding),
    transcriptBoundaryRecordDigest: sha256Canonical(transcriptBoundary),
    waiterReadyDigest: sha256Canonical(waiterReady),
    suspensionCommittedDigest: suspensionCommitted === null
      ? null
      : sha256Canonical(suspensionCommitted),
    terminalDigest: terminal === null ? null : sha256Canonical(terminal),
    outcome: input?.outcome,
    appliedAt: timestamp(clock, 'held_call_reconciliation_applied'),
  }, expectedRequest, intent, {
    armBinding,
    transcriptBoundary,
    waiterReady,
    suspensionCommitted,
    terminal,
  });
}

export function assertHeldCallReconciliationApplied(
  value,
  request = undefined,
  intent = undefined,
  records = undefined,
) {
  assertPlainObject(value, 'held_call_reconciliation_applied');
  assertExactKeys(value, [
    'v', 'kind', 'eventId', 'stage', 'intentDigest', 'apiResponses',
    'armBindingDigest', 'transcriptBoundaryRecordDigest', 'waiterReadyDigest',
    'suspensionCommittedDigest', 'terminalDigest', 'outcome', 'appliedAt',
  ], 'held_call_reconciliation_applied');
  if (value.v !== HELD_CALL_RECONCILIATION_APPLIED_VERSION) {
    throw new Error('held_call_reconciliation_applied_version_invalid');
  }
  if (value.kind !== 'held_call_reconciliation_applied') {
    throw new Error('held_call_reconciliation_applied_kind_invalid');
  }
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) {
    throw new Error('held_call_reconciliation_applied_event_id_invalid');
  }
  if (!['arm', 'commit'].includes(value.stage)) {
    throw new Error('held_call_reconciliation_applied_stage_invalid');
  }
  assertDigest(value.intentDigest, 'held_call_reconciliation_applied_intent_digest');
  assertApiResponseDigests(value.apiResponses, value.stage);
  assertDigest(value.armBindingDigest, 'held_call_reconciliation_applied_arm_binding_digest');
  assertDigest(
    value.transcriptBoundaryRecordDigest,
    'held_call_reconciliation_applied_boundary_digest',
  );
  assertDigest(value.waiterReadyDigest, 'held_call_reconciliation_applied_waiter_digest');
  nullableDigest(
    value.suspensionCommittedDigest,
    'held_call_reconciliation_applied_suspension_digest',
  );
  nullableDigest(value.terminalDigest, 'held_call_reconciliation_applied_terminal_digest');
  if (!['remote_cancelled', 'suspension_committed'].includes(value.outcome)) {
    throw new Error('held_call_reconciliation_applied_outcome_invalid');
  }
  assertTimestamp(value.appliedAt, 'held_call_reconciliation_applied_at');
  if (request === undefined || intent === undefined) {
    throw new Error('held_call_reconciliation_applied_context_required');
  }
  const expectedRequest = assertAwaitRequest(request);
  if (
    value.eventId !== expectedRequest.eventId
    || value.stage !== intent.stage
    || value.intentDigest !== sha256Canonical(intent)
  ) throw new Error('held_call_reconciliation_applied_intent_mismatch');
  if (records === undefined) {
    assertJsonValue(value, 'held_call_reconciliation_applied', { secretFree: true });
    return value;
  }
  const armBinding = assertArmBinding(records.armBinding, expectedRequest);
  const transcriptBoundary = assertTranscriptBoundary(
    records.transcriptBoundary,
    expectedRequest,
    armBinding,
  );
  const waiterReady = assertWaiterReady(records.waiterReady, expectedRequest, armBinding);
  const suspensionCommitted = records.suspensionCommitted ?? null;
  const terminal = records.terminal ?? null;
  if (suspensionCommitted !== null) {
    assertSuspensionCommitted(suspensionCommitted, expectedRequest, armBinding, waiterReady);
  }
  if (terminal !== null) assertAwaitRequestTerminal(terminal, expectedRequest);
  if (
    value.armBindingDigest !== sha256Canonical(armBinding)
    || value.transcriptBoundaryRecordDigest !== sha256Canonical(transcriptBoundary)
    || transcriptBoundary.boundaryDigest !== intent.transcriptBoundaryDigest
    || value.waiterReadyDigest !== sha256Canonical(waiterReady)
    || value.suspensionCommittedDigest !== (
      suspensionCommitted === null ? null : sha256Canonical(suspensionCommitted)
    )
    || value.terminalDigest !== (terminal === null ? null : sha256Canonical(terminal))
  ) throw new Error('held_call_reconciliation_applied_record_mismatch');
  if (
    (value.stage === 'arm'
      && (
        value.outcome !== 'remote_cancelled'
        || terminal?.disposition !== 'remote_cancelled'
        || terminal?.awaitId !== armBinding.awaitId
        || suspensionCommitted !== null
      ))
    || (value.stage === 'commit'
      && (
        value.outcome !== 'suspension_committed'
        || suspensionCommitted === null
        || terminal !== null
      ))
  ) throw new Error('held_call_reconciliation_applied_outcome_mismatch');
  assertJsonValue(value, 'held_call_reconciliation_applied', { secretFree: true });
  return value;
}

export function createAwaitRequestTerminal(
  request,
  input,
  clock = () => new Date(),
) {
  const expected = assertAwaitRequest(request);
  return assertAwaitRequestTerminal({
    v: TOOL_WAIT_REQUEST_TERMINAL_VERSION,
    kind: 'await_request_terminal',
    eventId: expected.eventId,
    awaitId: input?.awaitId,
    wakeId: input?.wakeId,
    disposition: input?.disposition,
    terminalDigest: input?.terminalDigest,
    recordedAt: timestamp(clock, 'await_request_terminal'),
  }, expected);
}

export function assertAwaitRequestTerminal(value, request = undefined) {
  assertPlainObject(value, 'await_request_terminal');
  assertExactKeys(value, [
    'v',
    'kind',
    'eventId',
    'awaitId',
    'wakeId',
    'disposition',
    'terminalDigest',
    'recordedAt',
  ], 'await_request_terminal');
  if (value.v !== TOOL_WAIT_REQUEST_TERMINAL_VERSION) {
    throw new Error('await_request_terminal_version_invalid');
  }
  if (value.kind !== 'await_request_terminal') {
    throw new Error('await_request_terminal_kind_invalid');
  }
  if (!EVENT_ID_PATTERN.test(value.eventId ?? '')) {
    throw new Error('await_request_terminal_event_id_invalid');
  }
  if (value.awaitId !== null) assertIdentifier(value.awaitId, 'await_id');
  if (value.wakeId !== null) assertIdentifier(value.wakeId, 'wake_id');
  if (!AWAIT_REQUEST_TERMINAL_DISPOSITIONS.has(value.disposition)) {
    throw new Error('await_request_terminal_disposition_invalid');
  }
  if (
    ['completion_posted', 'crash_recovery_completed'].includes(value.disposition)
    && (value.awaitId === null || value.wakeId === null)
  ) throw new Error('await_request_terminal_wake_identity_required');
  if (value.disposition === 'remote_cancelled' && value.awaitId === null) {
    throw new Error('await_request_terminal_await_identity_required');
  }
  if (
    value.disposition === 'pre_arm_failed'
    && (value.awaitId !== null || value.wakeId !== null)
  ) throw new Error('await_request_terminal_remote_identity_forbidden');
  assertDigest(value.terminalDigest, 'await_request_terminal_digest');
  assertTimestamp(value.recordedAt, 'await_request_terminal_recorded_at');
  if (request !== undefined && value.eventId !== assertAwaitRequest(request).eventId) {
    throw new Error('await_request_terminal_request_mismatch');
  }
  return value;
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('tool_wait_directory_invalid');
  }
  await chmod(directory, 0o700);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function readCanonicalRecord(filePath, validate) {
  const handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('tool_wait_record_not_regular');
    if ((metadata.mode & 0o077) !== 0) throw new Error('tool_wait_record_permissions_invalid');
    if (metadata.size < 2 || metadata.size > MAX_RECORD_BYTES) {
      throw new Error('tool_wait_record_size_invalid');
    }
    const raw = await handle.readFile('utf8');
    const parsed = JSON.parse(raw);
    const value = validate(parsed);
    if (raw !== `${canonicalJson(value)}\n`) throw new Error('tool_wait_record_noncanonical');
    return value;
  } finally {
    await handle.close();
  }
}

async function publishImmutable({ directory, fileName, value, validate, semantic, conflictCode }) {
  const finalPath = path.join(directory, fileName);
  const tempPath = path.join(
    directory,
    `.${fileName}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const serialized = `${canonicalJson(value)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('tool_wait_record_too_large');
  }
  const handle = await open(tempPath, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tempPath, finalPath);
    await chmod(finalPath, 0o600);
    await unlink(tempPath);
    await syncDirectory(directory);
    return { created: true, value };
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (unlinkError) {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    }
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readCanonicalRecord(finalPath, validate);
    // The process that linked the immutable winner may have died before its
    // directory fsync. Any exact or opposing observer must durably seal that
    // directory entry before it is allowed to return the winner or throw the
    // semantic conflict that causes a caller to obey it.
    await syncDirectory(directory);
    if (canonicalJson(semantic(existing)) !== canonicalJson(semantic(value))) {
      throw new Error(conflictCode);
    }
    return { created: false, value: existing };
  }
}

function transientFilesystemError(error) {
  return TRANSIENT_FILESYSTEM_ERRORS.has(error?.code);
}

async function quarantineRecord({ sourceDirectory, quarantineDirectory, name, error }) {
  const sourcePath = path.join(sourceDirectory, name);
  let metadata;
  let contentDigest = null;
  try {
    metadata = await lstat(sourcePath);
    if (metadata.isFile() && metadata.size <= MAX_RECORD_BYTES * 2) {
      const handle = await open(sourcePath, fsConstants.O_RDONLY | NO_FOLLOW);
      try {
        contentDigest = crypto.createHash('sha256').update(await handle.readFile()).digest('hex');
      } finally {
        await handle.close();
      }
    }
  } catch (inspectionError) {
    if (inspectionError?.code === 'ENOENT') return { quarantined: false };
    if (transientFilesystemError(inspectionError)) throw inspectionError;
  }
  const quarantineId = sha256Canonical({
    name,
    error: error?.message ?? String(error),
    contentDigest,
    size: metadata?.size ?? null,
    type: metadata?.isFile() ? 'file' : metadata?.isSymbolicLink() ? 'symlink' : 'other',
  });
  const destinationPath = path.join(quarantineDirectory, `bad_${quarantineId}.record`);
  if (!metadata?.isFile()) {
    try {
      await rename(sourcePath, destinationPath);
    } catch (renameError) {
      if (renameError?.code === 'ENOENT') return { quarantined: false };
      if (renameError?.code !== 'EEXIST') throw renameError;
      throw new Error('tool_wait_quarantine_conflict');
    }
    await Promise.all([
      syncDirectory(sourceDirectory),
      syncDirectory(quarantineDirectory),
    ]);
    return { quarantined: true, path: destinationPath };
  }
  try {
    await link(sourcePath, destinationPath);
    await chmod(destinationPath, 0o600);
  } catch (linkError) {
    if (linkError?.code === 'ENOENT') return { quarantined: false };
    if (linkError?.code !== 'EEXIST') throw linkError;
  }
  try {
    await unlink(sourcePath);
  } catch (unlinkError) {
    if (unlinkError?.code !== 'ENOENT') throw unlinkError;
  }
  await Promise.all([
    syncDirectory(sourceDirectory),
    syncDirectory(quarantineDirectory),
  ]);
  return { quarantined: true, path: destinationPath };
}

async function archiveImmutableRecord({
  pendingDirectory,
  archiveDirectory,
  fileName,
  validate,
  conflictCode,
}) {
  const pendingPath = path.join(pendingDirectory, fileName);
  const archivePath = path.join(archiveDirectory, fileName);
  let pending;
  try {
    pending = await readCanonicalRecord(pendingPath, validate);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      const archived = await readCanonicalRecord(archivePath, validate);
      return { archived: false, value: archived };
    } catch (archiveError) {
      if (archiveError?.code === 'ENOENT') throw new Error('immutable_record_not_found');
      throw archiveError;
    }
  }
  let archived = null;
  try {
    archived = await readCanonicalRecord(archivePath, validate);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (archived) {
    if (canonicalJson(archived) !== canonicalJson(pending)) throw new Error(conflictCode);
    try {
      await unlink(pendingPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  } else {
    try {
      await rename(pendingPath, archivePath);
      await chmod(archivePath, 0o600);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const concurrentlyArchived = await readCanonicalRecord(archivePath, validate);
      if (canonicalJson(concurrentlyArchived) !== canonicalJson(pending)) {
        throw new Error(conflictCode);
      }
    }
  }
  await Promise.all([
    syncDirectory(pendingDirectory),
    syncDirectory(archiveDirectory),
  ]);
  return { archived: true, value: pending };
}

function recordId(value) {
  if (typeof value === 'string') return value;
  return assertAwaitRequest(value).eventId;
}

function validateEventId(value) {
  if (!EVENT_ID_PATTERN.test(value ?? '')) throw new Error('tool_wait_event_id_invalid');
  return value;
}

export function abortableDelay(ms, signal, options = {}) {
  const label = options.label ?? 'delay';
  const rejectOnAbort = options.rejectOnAbort ?? true;
  if (!Number.isInteger(ms) || ms < 0) throw new Error(`${label}_delay_invalid`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      operation();
    };
    const timer = setTimeout(() => {
      finish(resolve);
    }, ms);
    if (options.unref === true) timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      finish(() => {
        if (rejectOnAbort) {
          reject(Object.assign(new Error(`${label}_aborted`), { name: 'AbortError' }));
        } else {
          resolve();
        }
      });
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function boundedWait(read, options, label) {
  const timeoutMs = options?.timeoutMs ?? 35_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 25;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
    throw new Error(`${label}_timeout_invalid`);
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1_000) {
    throw new Error(`${label}_poll_interval_invalid`);
  }
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (value) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${label}_timeout`);
    await abortableDelay(
      Math.min(pollIntervalMs, remaining),
      options?.signal,
      { label },
    );
  }
}

export class HarkToolWaitProtocol {
  constructor(dataDir = defaultHarkDataDir()) {
    this.dataDir = path.resolve(dataDir);
    this.rootDirectory = path.join(this.dataDir, 'tool-wait-protocol');
    for (const [name, directory] of Object.entries(RECORD_DIRECTORIES)) {
      this[`${name}Directory`] = path.join(this.rootDirectory, directory);
    }
    this.awaitRequestArchiveDirectory = path.join(
      this.rootDirectory,
      'await-requests-archive',
    );
    this.awaitRequestQuarantineDirectory = path.join(
      this.rootDirectory,
      'await-requests-quarantine',
    );
    this.awaitRequestSpoolInitialization = null;
  }

  async ensureDirectories() {
    await ensurePrivateDirectory(this.rootDirectory);
    await Promise.all([
      ...Object.keys(RECORD_DIRECTORIES).map((name) => (
        ensurePrivateDirectory(this[`${name}Directory`])
      )),
      ensurePrivateDirectory(this.awaitRequestArchiveDirectory),
      ensurePrivateDirectory(this.awaitRequestQuarantineDirectory),
    ]);
    if (!this.awaitRequestSpoolInitialization) {
      const initialization = this.#rebuildAwaitRequestSpool();
      this.awaitRequestSpoolInitialization = initialization;
      try {
        await initialization;
      } catch (error) {
        if (this.awaitRequestSpoolInitialization === initialization) {
          this.awaitRequestSpoolInitialization = null;
        }
        throw error;
      }
      return;
    }
    await this.awaitRequestSpoolInitialization;
  }

  async #readWithoutEnsure(directory, eventId, validate) {
    try {
      return await readCanonicalRecord(this.#path(directory, eventId), validate);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #publishAwaitRequestTerminalWithoutEnsure(request, input, clock = () => new Date()) {
    const terminal = createAwaitRequestTerminal(request, input, clock);
    const result = await publishImmutable({
      directory: this.awaitRequestTerminalDirectory,
      fileName: `${terminal.eventId}.json`,
      value: terminal,
      validate: (record) => assertAwaitRequestTerminal(record, request),
      semantic: (record) => semanticWithout(record, 'recordedAt'),
      conflictCode: 'await_request_terminal_conflict',
    });
    return { created: result.created, awaitRequestTerminal: result.value };
  }

  async #archiveAwaitRequestWithoutEnsure(request, terminal = undefined) {
    const expected = assertAwaitRequest(request);
    const persistedTerminal = await this.#readWithoutEnsure(
      this.awaitRequestTerminalDirectory,
      expected.eventId,
      (record) => assertAwaitRequestTerminal(record, expected),
    );
    if (!persistedTerminal) throw new Error('await_request_terminal_required');
    if (
      terminal !== undefined
      && canonicalJson(assertAwaitRequestTerminal(terminal, expected))
        !== canonicalJson(persistedTerminal)
    ) throw new Error('await_request_terminal_conflict');
    return archiveImmutableRecord({
      pendingDirectory: this.awaitRequestDirectory,
      archiveDirectory: this.awaitRequestArchiveDirectory,
      fileName: `${expected.eventId}.json`,
      validate: assertAwaitRequest,
      conflictCode: 'await_request_archive_conflict',
    });
  }

  async #heldCallReconciliationNeedsApplied(request, terminal) {
    const armAttempt = await this.#readWithoutEnsure(
      this.armAttemptDirectory,
      request.eventId,
      (record) => assertArmAttempt(record, request),
    );
    if (!armAttempt) return false;
    const originAbortReceipt = await this.#readWithoutEnsure(
      this.heldCallOriginAbortDirectory,
      request.eventId,
      (record) => assertHeldCallOriginAbortReceipt(record, request, armAttempt),
    );
    if (!originAbortReceipt) return false;
    const intent = await this.#readWithoutEnsure(
      this.heldCallReconciliationIntentDirectory,
      request.eventId,
      (record) => assertHeldCallReconciliationIntent(
        record,
        request,
        armAttempt,
        originAbortReceipt,
      ),
    );
    if (!intent) return false;

    const armBinding = await this.#readWithoutEnsure(
      this.armBindingDirectory,
      request.eventId,
      (record) => assertArmBinding(record, request),
    );
    const transcriptBoundary = armBinding
      ? await this.#readWithoutEnsure(
        this.transcriptBoundaryDirectory,
        request.eventId,
        (record) => assertTranscriptBoundary(record, request, armBinding),
      )
      : null;
    const waiterReady = armBinding
      ? await this.#readWithoutEnsure(
        this.waiterReadyDirectory,
        request.eventId,
        (record) => assertWaiterReady(record, request, armBinding),
      )
      : null;
    const suspensionCommitted = armBinding && waiterReady
      ? await this.#readWithoutEnsure(
        this.suspensionCommittedDirectory,
        request.eventId,
        (record) => assertSuspensionCommitted(record, request, armBinding, waiterReady),
      )
      : null;
    assertHeldCallReconciliationIntent(
      intent,
      request,
      armAttempt,
      originAbortReceipt,
      {
        armBinding: intent.armBindingDigest === null ? null : armBinding,
        waiterReady: intent.waiterReadyDigest === null ? null : waiterReady,
        commitAttempt: intent.commitAttemptDigest === null
          ? null
          : await this.#readWithoutEnsure(
            this.commitAttemptDirectory,
            request.eventId,
            (record) => assertCommitAttempt(record, request, armBinding, waiterReady),
          ),
      },
    );
    const applied = await this.#readWithoutEnsure(
      this.heldCallReconciliationAppliedDirectory,
      request.eventId,
      (record) => assertHeldCallReconciliationApplied(record, request, intent, {
        armBinding,
        transcriptBoundary,
        waiterReady,
        suspensionCommitted,
        // A commit reconciliation is complete before any later wake/completion
        // terminal exists. Validate that immutable historical outcome against
        // its original record set; the supplied terminal belongs to the later
        // await lifecycle and only controls whether the request can archive.
        terminal: intent.stage === 'arm' ? terminal : null,
      }),
    );
    return applied === null;
  }

  async #readPendingAwaitRequests() {
    const entries = await readdir(this.awaitRequestDirectory, { withFileTypes: true });
    const requests = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.')) continue;
      const sourcePath = path.join(this.awaitRequestDirectory, entry.name);
      if (!entry.isFile() || !/^htw_[a-f0-9]{64}\.json$/.test(entry.name)) {
        await quarantineRecord({
          sourceDirectory: this.awaitRequestDirectory,
          quarantineDirectory: this.awaitRequestQuarantineDirectory,
          name: entry.name,
          error: new Error('await_request_spool_entry_invalid'),
        });
        continue;
      }
      let request;
      try {
        request = await readCanonicalRecord(sourcePath, assertAwaitRequest);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        if (transientFilesystemError(error)) throw error;
        await quarantineRecord({
          sourceDirectory: this.awaitRequestDirectory,
          quarantineDirectory: this.awaitRequestQuarantineDirectory,
          name: entry.name,
          error,
        });
        continue;
      }
      // Directory initialization and inventory are intentionally read-only for
      // every request that has crossed the durable arm-attempt boundary. Any
      // terminal synthesis or archive after this point requires a caller that
      // has first re-established the installation identity fence. This also
      // keeps legacy v1 attempts visible and prompt-guarded without upgrading,
      // quarantining, or otherwise progressing them.
      const armAttempt = await this.#readWithoutEnsure(
        this.armAttemptDirectory,
        request.eventId,
        (record) => assertReadableArmAttempt(record, request),
      );
      if (armAttempt) {
        requests.push(request);
        continue;
      }
      let terminal = await this.#readWithoutEnsure(
        this.awaitRequestTerminalDirectory,
        request.eventId,
        (record) => assertAwaitRequestTerminal(record, request),
      );
      if (!terminal) {
        const returned = await this.#readWithoutEnsure(
          this.toolResultReturnedDirectory,
          request.eventId,
          assertToolResultReturned,
        );
        const completion = returned ? await this.#readWithoutEnsure(
          this.completionPostedDirectory,
          request.eventId,
          (record) => assertCompletionPosted(record, returned),
        ) : null;
        if (completion) {
          terminal = (await this.#publishAwaitRequestTerminalWithoutEnsure(request, {
            awaitId: completion.awaitId,
            wakeId: completion.wakeId,
            disposition: 'completion_posted',
            terminalDigest: sha256Canonical(completion),
          }, () => new Date(completion.postedAt))).awaitRequestTerminal;
        }
      }
      if (terminal && await this.#heldCallReconciliationNeedsApplied(request, terminal)) {
        requests.push(request);
      } else if (terminal) {
        await this.#archiveAwaitRequestWithoutEnsure(request, terminal);
      } else {
        requests.push(request);
      }
    }
    return requests;
  }

  async #rebuildAwaitRequestSpool() {
    await this.#readPendingAwaitRequests();
  }

  #path(directory, eventId) {
    return path.join(directory, `${validateEventId(eventId)}.json`);
  }

  #admissionPath(directory, locator) {
    return path.join(directory, `${assertAdmissionLocator(locator)}.json`);
  }

  async #read(directory, eventId, validate) {
    await this.ensureDirectories();
    try {
      return await readCanonicalRecord(this.#path(directory, eventId), validate);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #append(directory, eventId, value, validate, timestampField, conflictCode) {
    await this.ensureDirectories();
    return publishImmutable({
      directory,
      fileName: `${validateEventId(eventId)}.json`,
      value,
      validate,
      semantic: (record) => semanticWithout(record, timestampField),
      conflictCode,
    });
  }

  async #readAdmissionDirectory(directory, locator) {
    await this.ensureDirectories();
    try {
      return await readCanonicalRecord(
        this.#admissionPath(directory, locator),
        assertAwaitAdmission,
      );
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async appendAdmission(value) {
    const admission = assertAwaitAdmission(value);
    await this.ensureDirectories();
    if (await this.readConsumedAdmission(admission.locator)) {
      throw new Error('tool_wait_admission_replayed');
    }
    const result = await publishImmutable({
      directory: this.admissionDirectory,
      fileName: `${admission.locator}.json`,
      value: admission,
      validate: assertAwaitAdmission,
      semantic: (record) => semanticWithout(record, 'admittedAt'),
      conflictCode: 'await_admission_conflict',
    });
    return {
      created: result.created,
      admission: result.value,
      rewrittenInput: createAdmissionLocatorInput(result.value),
    };
  }

  publishAdmission(input, clock = () => new Date(), randomBytes = crypto.randomBytes) {
    return this.appendAdmission(createAwaitAdmission(input, clock, randomBytes));
  }

  readAdmission(locator) {
    return this.#readAdmissionDirectory(this.admissionDirectory, locator);
  }

  readConsumedAdmission(locator) {
    return this.#readAdmissionDirectory(this.consumedAdmissionDirectory, locator);
  }

  /**
   * Atomically claims one private admission with a no-clobber hard link. The
   * consumed copy is retained as a permanent replay tombstone.
   */
  async consumeAdmission(locatorInput) {
    const validatedInput = assertAdmissionLocatorInput(locatorInput);
    const { admissionLocator } = validatedInput._hark;
    await this.ensureDirectories();
    const pendingPath = this.#admissionPath(this.admissionDirectory, admissionLocator);
    const consumedPath = this.#admissionPath(
      this.consumedAdmissionDirectory,
      admissionLocator,
    );
    let admission;
    try {
      admission = await readCanonicalRecord(pendingPath, assertAwaitAdmission);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (await this.readConsumedAdmission(admissionLocator)) {
        throw new Error('tool_wait_admission_replayed');
      }
      throw new Error('tool_wait_admission_missing');
    }
    if (admission.locator !== admissionLocator) throw new Error('tool_wait_admission_mismatch');
    const suppliedInput = normalizeOriginalInput({
      request: validatedInput.request,
      name: validatedInput.name,
      source: validatedInput.source,
      condition: validatedInput.condition,
    });
    if (
      sha256Canonical(suppliedInput) !== admission.originalInputDigest
      || canonicalJson(suppliedInput) !== canonicalJson(admission.originalInput)
    ) throw new Error('tool_wait_admission_input_mismatch');
    try {
      await link(pendingPath, consumedPath);
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('tool_wait_admission_replayed');
      if (error?.code === 'ENOENT') {
        if (await this.readConsumedAdmission(admissionLocator)) {
          throw new Error('tool_wait_admission_replayed');
        }
        throw new Error('tool_wait_admission_missing');
      }
      throw error;
    }
    await chmod(consumedPath, 0o600);
    const claimedAdmission = await readCanonicalRecord(consumedPath, assertAwaitAdmission);
    if (canonicalJson(claimedAdmission) !== canonicalJson(admission)) {
      throw new Error('tool_wait_admission_changed_during_consume');
    }
    try {
      await unlink(pendingPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await Promise.all([
      syncDirectory(this.admissionDirectory),
      syncDirectory(this.consumedAdmissionDirectory),
    ]);
    return {
      admission,
      originalInput: structuredClone(admission.originalInput),
    };
  }

  async appendAwaitRequest(value) {
    const request = assertAwaitRequest(value);
    await this.ensureDirectories();
    const archived = await this.#readWithoutEnsure(
      this.awaitRequestArchiveDirectory,
      request.eventId,
      assertAwaitRequest,
    );
    if (archived) {
      if (
        canonicalJson(semanticWithout(archived, 'requestedAt'))
        !== canonicalJson(semanticWithout(request, 'requestedAt'))
      ) throw new Error('await_request_conflict');
      return { created: false, request: archived };
    }
    const result = await this.#append(
      this.awaitRequestDirectory,
      request.eventId,
      request,
      assertAwaitRequest,
      'requestedAt',
      'await_request_conflict',
    );
    return { created: result.created, request: result.value };
  }

  publishAwaitRequest(input, clock = () => new Date()) {
    return this.appendAwaitRequest(createAwaitRequest(input, clock));
  }

  async readAwaitRequest(eventId) {
    await this.ensureDirectories();
    const pending = await this.#readWithoutEnsure(
      this.awaitRequestDirectory,
      eventId,
      assertAwaitRequest,
    );
    if (pending) return pending;
    return this.#readWithoutEnsure(
      this.awaitRequestArchiveDirectory,
      eventId,
      assertAwaitRequest,
    );
  }

  waitForAwaitRequest(eventId, options = {}) {
    return boundedWait(() => this.readAwaitRequest(eventId), options, 'await_request');
  }

  async listAwaitRequests() {
    await this.ensureDirectories();
    return this.#readPendingAwaitRequests();
  }

  async appendArmAttempt(value, request) {
    const attempt = assertArmAttempt(value, request);
    const result = await this.#append(
      this.armAttemptDirectory,
      attempt.eventId,
      attempt,
      (record) => assertArmAttempt(record, request),
      'attemptedAt',
      'arm_attempt_conflict',
    );
    return { created: result.created, armAttempt: result.value };
  }

  publishArmAttempt(
    request,
    input,
    clock = () => new Date(),
    randomBytes = crypto.randomBytes,
  ) {
    return this.appendArmAttempt(
      createArmAttempt(request, input, clock, randomBytes),
      request,
    );
  }

  readArmAttempt(request) {
    const expected = assertAwaitRequest(request);
    return this.#read(
      this.armAttemptDirectory,
      expected.eventId,
      (record) => assertReadableArmAttempt(record, expected),
    );
  }

  async appendArmReconciliationFreeze(value, request, armAttempt) {
    const freeze = assertArmReconciliationFreeze(value, request, armAttempt);
    await this.ensureDirectories();
    const result = await publishImmutable({
      directory: this.armReconciliationFreezeDirectory,
      fileName: `${validateEventId(freeze.eventId)}.json`,
      value: freeze,
      validate: (record) => assertArmReconciliationFreeze(
        record,
        request,
        armAttempt,
      ),
      semantic: armReconciliationFreezeSemantic,
      conflictCode: 'arm_reconciliation_freeze_conflict',
    });
    return { created: result.created, armReconciliationFreeze: result.value };
  }

  publishArmReconciliationFreeze(
    request,
    armAttempt,
    input,
    clock = () => new Date(),
  ) {
    return this.appendArmReconciliationFreeze(
      createArmReconciliationFreeze(request, armAttempt, input, clock),
      request,
      armAttempt,
    );
  }

  readArmReconciliationFreeze(request, armAttempt) {
    const expected = assertAwaitRequest(request);
    return this.#read(
      this.armReconciliationFreezeDirectory,
      expected.eventId,
      (record) => assertArmReconciliationFreeze(record, expected, armAttempt),
    );
  }

  async appendArmBinding(value, request = undefined) {
    const binding = assertArmBinding(value, request);
    const result = await this.#append(
      this.armBindingDirectory,
      binding.eventId,
      binding,
      (record) => assertArmBinding(record, request),
      'armedAt',
      'arm_binding_conflict',
    );
    return { created: result.created, armBinding: result.value };
  }

  publishArmBinding(request, input, clock = () => new Date(), randomBytes = crypto.randomBytes) {
    return this.appendArmBinding(createArmBinding(request, input, clock, randomBytes), request);
  }

  readArmBinding(request) {
    const eventId = recordId(request);
    return this.#read(
      this.armBindingDirectory,
      eventId,
      (record) => assertArmBinding(record, typeof request === 'string' ? undefined : request),
    );
  }

  waitForArmBinding(request, options = {}) {
    return boundedWait(() => this.readArmBinding(request), options, 'arm_binding');
  }

  async appendTranscriptBoundary(value, request = undefined, armBinding = undefined) {
    const boundary = assertTranscriptBoundary(value, request, armBinding);
    const result = await this.#append(
      this.transcriptBoundaryDirectory,
      boundary.eventId,
      boundary,
      (record) => assertTranscriptBoundary(record, request, armBinding),
      'capturedAt',
      'transcript_boundary_conflict',
    );
    return { created: result.created, transcriptBoundary: result.value };
  }

  publishTranscriptBoundary(
    request,
    armBinding,
    boundary,
    clock = () => new Date(),
  ) {
    return this.appendTranscriptBoundary(
      createTranscriptBoundary(request, armBinding, boundary, clock),
      request,
      armBinding,
    );
  }

  readTranscriptBoundary(request, armBinding = undefined) {
    const eventId = recordId(request);
    return this.#read(
      this.transcriptBoundaryDirectory,
      eventId,
      (record) => assertTranscriptBoundary(
        record,
        typeof request === 'string' ? undefined : request,
        armBinding,
      ),
    );
  }

  async appendWaiterReady(value, request = undefined, armBinding = undefined) {
    const ready = assertWaiterReady(value, request, armBinding);
    const result = await this.#append(
      this.waiterReadyDirectory,
      ready.eventId,
      ready,
      (record) => assertWaiterReady(record, request, armBinding),
      'readyAt',
      'waiter_ready_conflict',
    );
    return { created: result.created, waiterReady: result.value };
  }

  publishWaiterReady(request, armBinding, originalInput, clock = () => new Date()) {
    return this.appendWaiterReady(
      createWaiterReady(request, armBinding, originalInput, clock),
      request,
      armBinding,
    );
  }

  readWaiterReady(request, armBinding = undefined) {
    const eventId = recordId(request);
    return this.#read(
      this.waiterReadyDirectory,
      eventId,
      (record) => assertWaiterReady(
        record,
        typeof request === 'string' ? undefined : request,
        armBinding,
      ),
    );
  }

  waitForWaiterReady(request, armBinding, options = {}) {
    return boundedWait(
      () => this.readWaiterReady(request, armBinding),
      options,
      'waiter_ready',
    );
  }

  async appendCommitAttempt(
    value,
    request = undefined,
    armBinding = undefined,
    waiterReady = undefined,
  ) {
    const attempt = assertCommitAttempt(value, request, armBinding, waiterReady);
    const result = await this.#append(
      this.commitAttemptDirectory,
      attempt.eventId,
      attempt,
      (record) => assertCommitAttempt(record, request, armBinding, waiterReady),
      'attemptedAt',
      'commit_attempt_conflict',
    );
    return { created: result.created, commitAttempt: result.value };
  }

  publishCommitAttempt(
    request,
    armBinding,
    waiterReady,
    commitRequest,
    clock = () => new Date(),
  ) {
    return this.appendCommitAttempt(
      createCommitAttempt(request, armBinding, waiterReady, commitRequest, clock),
      request,
      armBinding,
      waiterReady,
    );
  }

  readCommitAttempt(request, armBinding = undefined, waiterReady = undefined) {
    const eventId = recordId(request);
    return this.#read(
      this.commitAttemptDirectory,
      eventId,
      (record) => assertCommitAttempt(
        record,
        typeof request === 'string' ? undefined : request,
        armBinding,
        waiterReady,
      ),
    );
  }

  async appendSuspensionCommitted(
    value,
    request = undefined,
    armBinding = undefined,
    waiterReady = undefined,
  ) {
    const committed = assertSuspensionCommitted(value, request, armBinding, waiterReady);
    const result = await this.#append(
      this.suspensionCommittedDirectory,
      committed.eventId,
      committed,
      (record) => assertSuspensionCommitted(record, request, armBinding, waiterReady),
      'committedAt',
      'suspension_committed_conflict',
    );
    return { created: result.created, suspensionCommitted: result.value };
  }

  publishSuspensionCommitted(
    request,
    armBinding,
    waiterReady,
    input,
    clock = () => new Date(),
  ) {
    return this.appendSuspensionCommitted(
      createSuspensionCommitted(request, armBinding, waiterReady, input, clock),
      request,
      armBinding,
      waiterReady,
    );
  }

  readSuspensionCommitted(request, armBinding = undefined, waiterReady = undefined) {
    const eventId = recordId(request);
    return this.#read(
      this.suspensionCommittedDirectory,
      eventId,
      (record) => assertSuspensionCommitted(
        record,
        typeof request === 'string' ? undefined : request,
        armBinding,
        waiterReady,
      ),
    );
  }

  waitForSuspensionCommitted(request, armBinding, waiterReady, options = {}) {
    return boundedWait(
      () => this.readSuspensionCommitted(request, armBinding, waiterReady),
      options,
      'suspension_committed',
    );
  }

  async appendWakeDelivery(
    value,
    request = undefined,
    armBinding = undefined,
    suspensionCommitted = undefined,
  ) {
    const delivery = assertWakeDelivery(value, request, armBinding, suspensionCommitted);
    const result = await this.#append(
      this.wakeDeliveryDirectory,
      delivery.eventId,
      delivery,
      (record) => assertWakeDelivery(record, request, armBinding, suspensionCommitted),
      'deliveredAt',
      'wake_delivery_conflict',
    );
    return { created: result.created, wakeDelivery: result.value };
  }

  publishWakeDelivery(
    request,
    armBinding,
    suspensionCommitted,
    wake,
    wakeDeliveryDigest,
    clock = () => new Date(),
  ) {
    return this.appendWakeDelivery(
      createWakeDelivery(
        request,
        armBinding,
        suspensionCommitted,
        wake,
        wakeDeliveryDigest,
        clock,
      ),
      request,
      armBinding,
      suspensionCommitted,
    );
  }

  readWakeDelivery(request, armBinding = undefined, suspensionCommitted = undefined) {
    const eventId = recordId(request);
    return this.#read(
      this.wakeDeliveryDirectory,
      eventId,
      (record) => assertWakeDelivery(
        record,
        typeof request === 'string' ? undefined : request,
        armBinding,
        suspensionCommitted,
      ),
    );
  }

  waitForWakeDelivery(request, armBinding, suspensionCommitted, options = {}) {
    return boundedWait(
      () => this.readWakeDelivery(request, armBinding, suspensionCommitted),
      options,
      'wake_delivery',
    );
  }

  async appendToolResultObservationIntent(
    value,
    delivery = undefined,
    result = undefined,
    transcriptBoundary = undefined,
    runtimeId = undefined,
    claimReference = undefined,
  ) {
    const intent = assertToolResultObservationIntent(value, {
      delivery,
      result,
      transcriptBoundary,
      runtimeId,
      claimReference,
    });
    const intentRecord = await this.#append(
      this.observationIntentDirectory,
      intent.eventId,
      intent,
      (record) => assertToolResultObservationIntent(record, {
        delivery,
        result,
        transcriptBoundary,
        runtimeId,
        claimReference,
      }),
      'createdAt',
      'tool_result_observation_intent_conflict',
    );
    return { created: intentRecord.created, observationIntent: intentRecord.value };
  }

  publishToolResultObservationIntent(input, clock = () => new Date()) {
    const intent = createToolResultObservationIntent(input, clock);
    return this.appendToolResultObservationIntent(
      intent,
      input?.delivery,
      input?.result,
      input?.transcriptBoundary,
      input?.runtimeId,
      input?.claimReference,
    );
  }

  readToolResultObservationIntent(
    delivery,
    result = undefined,
    transcriptBoundary = undefined,
    runtimeId = undefined,
    claimReference = undefined,
  ) {
    const expected = assertWakeDelivery(delivery);
    return this.#read(
      this.observationIntentDirectory,
      expected.eventId,
      (record) => assertToolResultObservationIntent(record, {
        delivery: expected,
        result,
        transcriptBoundary,
        runtimeId,
        claimReference,
      }),
    );
  }

  async appendToolResultReturned(value, delivery = undefined, result = undefined) {
    const returned = assertToolResultReturned(value, delivery, result);
    const resultRecord = await this.#append(
      this.toolResultReturnedDirectory,
      returned.eventId,
      returned,
      (record) => assertToolResultReturned(record, delivery, result),
      'returnedAt',
      'tool_result_returned_conflict',
    );
    return { created: resultRecord.created, toolResultReturned: resultRecord.value };
  }

  publishToolResultReturned(
    delivery,
    result,
    observation,
    clock = () => new Date(),
  ) {
    return this.appendToolResultReturned(
      createToolResultReturned(delivery, result, observation, clock),
      delivery,
      result,
    );
  }

  readToolResultReturned(delivery, result = undefined) {
    const expected = assertWakeDelivery(delivery);
    return this.#read(
      this.toolResultReturnedDirectory,
      expected.eventId,
      (record) => assertToolResultReturned(record, expected, result),
    );
  }

  waitForToolResultReturned(delivery, result, options = {}) {
    return boundedWait(
      () => this.readToolResultReturned(delivery, result),
      options,
      'tool_result_returned',
    );
  }

  async appendCompletionPosted(value, returned = undefined) {
    const posted = assertCompletionPosted(value, returned);
    const result = await this.#append(
      this.completionPostedDirectory,
      posted.eventId,
      posted,
      (record) => assertCompletionPosted(record, returned),
      'postedAt',
      'completion_posted_conflict',
    );
    return { created: result.created, completionPosted: result.value };
  }

  publishCompletionPosted(returned, input, clock = () => new Date()) {
    return this.appendCompletionPosted(
      createCompletionPosted(returned, input, clock),
      returned,
    );
  }

  readCompletionPosted(returned) {
    const expected = assertToolResultReturned(returned);
    return this.#read(
      this.completionPostedDirectory,
      expected.eventId,
      (record) => assertCompletionPosted(record, expected),
    );
  }

  async appendToolError(value, request = undefined) {
    const toolError = assertToolError(value, request);
    const result = await this.#append(
      this.toolErrorDirectory,
      toolError.eventId,
      toolError,
      (record) => assertToolError(record, request),
      'observedAt',
      'tool_error_conflict',
    );
    return { created: result.created, toolError: result.value };
  }

  publishToolError(request, input, clock = () => new Date()) {
    return this.appendToolError(createToolError(request, input, clock), request);
  }

  readToolError(request) {
    const eventId = recordId(request);
    return this.#read(
      this.toolErrorDirectory,
      eventId,
      (record) => assertToolError(
        record,
        typeof request === 'string' ? undefined : request,
      ),
    );
  }

  async appendToolErrorObservation(
    value,
    request = undefined,
    toolError = undefined,
  ) {
    const observation = assertToolErrorObservation(value, request, toolError);
    const result = await this.#append(
      this.toolErrorObservationDirectory,
      observation.eventId,
      observation,
      (record) => assertToolErrorObservation(record, request, toolError),
      'observedAt',
      'tool_error_observation_conflict',
    );
    return { created: result.created, toolErrorObservation: result.value };
  }

  publishToolErrorObservation(
    request,
    toolError,
    input,
    clock = () => new Date(),
  ) {
    return this.appendToolErrorObservation(
      createToolErrorObservation(request, toolError, input, clock),
      request,
      toolError,
    );
  }

  readToolErrorObservation(request, toolError = undefined) {
    const eventId = recordId(request);
    return this.#read(
      this.toolErrorObservationDirectory,
      eventId,
      (record) => assertToolErrorObservation(
        record,
        typeof request === 'string' ? undefined : request,
        toolError,
      ),
    );
  }

  async appendHeldCallOriginAbortReceipt(value, request, armAttempt) {
    const receipt = assertHeldCallOriginAbortReceipt(value, request, armAttempt);
    await this.ensureDirectories();
    const result = await publishImmutable({
      directory: this.heldCallOriginAbortDirectory,
      fileName: `${validateEventId(receipt.eventId)}.json`,
      value: receipt,
      validate: (record) => assertHeldCallOriginAbortReceipt(
        record,
        request,
        armAttempt,
      ),
      semantic: heldCallOriginAbortSemantic,
      conflictCode: 'held_call_origin_abort_conflict',
    });
    return { created: result.created, originAbortReceipt: result.value };
  }

  publishHeldCallOriginAbortReceipt(
    request,
    armAttempt,
    abortProof,
    clock = () => new Date(),
  ) {
    return this.appendHeldCallOriginAbortReceipt(
      createHeldCallOriginAbortReceipt(request, armAttempt, abortProof, clock),
      request,
      armAttempt,
    );
  }

  readHeldCallOriginAbortReceipt(request, armAttempt) {
    const expected = assertAwaitRequest(request);
    return this.#read(
      this.heldCallOriginAbortDirectory,
      expected.eventId,
      (record) => assertHeldCallOriginAbortReceipt(record, expected, armAttempt),
    );
  }

  async appendHeldCallTransitionAuthority(
    value,
    request,
    armAttempt,
    records = undefined,
  ) {
    const authority = assertHeldCallTransitionAuthority(
      value,
      request,
      armAttempt,
      records,
    );
    await this.ensureDirectories();
    const result = await publishImmutable({
      directory: this.heldCallTransitionAuthorityDirectory,
      fileName: `${validateEventId(authority.eventId)}.json`,
      value: authority,
      validate: (record) => assertHeldCallTransitionAuthority(
        record,
        request,
        armAttempt,
      ),
      semantic: heldCallTransitionAuthoritySemantic,
      conflictCode: 'held_call_transition_authority_conflict',
    });
    return { created: result.created, transitionAuthority: result.value };
  }

  publishHeldCallTransitionAuthority(
    request,
    armAttempt,
    input,
    clock = () => new Date(),
  ) {
    return this.appendHeldCallTransitionAuthority(
      createHeldCallTransitionAuthority(request, armAttempt, input, clock),
      request,
      armAttempt,
      heldCallTransitionEvidenceRecords(input),
    );
  }

  readHeldCallTransitionAuthority(request, armAttempt, records = undefined) {
    const expected = assertAwaitRequest(request);
    return this.#read(
      this.heldCallTransitionAuthorityDirectory,
      expected.eventId,
      (record) => assertHeldCallTransitionAuthority(
        record,
        expected,
        armAttempt,
        records,
      ),
    );
  }

  async electHeldCallTransitionAuthority(
    request,
    armAttempt,
    input,
    clock = () => new Date(),
  ) {
    try {
      return await this.publishHeldCallTransitionAuthority(
        request,
        armAttempt,
        input,
        clock,
      );
    } catch (error) {
      if (error?.message !== 'held_call_transition_authority_conflict') throw error;
      const existing = await this.readHeldCallTransitionAuthority(
        request,
        armAttempt,
        { armBinding: input?.armBinding },
      );
      if (!existing) throw error;
      // Same-decision conflicts are altered replays, never convergence. Only
      // an opposing action may observe and obey the already-elected winner.
      if (existing.decision === input?.decision) throw error;
      return { created: false, transitionAuthority: existing };
    }
  }

  async appendHeldCallReconciliationIntent(
    value,
    request,
    armAttempt,
    originAbortReceipt,
    records = undefined,
  ) {
    const intent = assertHeldCallReconciliationIntent(
      value,
      request,
      armAttempt,
      originAbortReceipt,
      records,
    );
    const result = await this.#append(
      this.heldCallReconciliationIntentDirectory,
      intent.eventId,
      intent,
      (record) => assertHeldCallReconciliationIntent(
        record,
        request,
        armAttempt,
        originAbortReceipt,
      ),
      'createdAt',
      'held_call_reconciliation_intent_conflict',
    );
    return { created: result.created, reconciliationIntent: result.value };
  }

  publishHeldCallReconciliationIntent(
    request,
    armAttempt,
    originAbortReceipt,
    input,
    clock = () => new Date(),
  ) {
    const records = {
      armBinding: input?.armBinding ?? null,
      waiterReady: input?.waiterReady ?? null,
      commitAttempt: input?.commitAttempt ?? null,
    };
    return this.appendHeldCallReconciliationIntent(
      createHeldCallReconciliationIntent(
        request,
        armAttempt,
        originAbortReceipt,
        input,
        clock,
      ),
      request,
      armAttempt,
      originAbortReceipt,
      records,
    );
  }

  readHeldCallReconciliationIntent(request, armAttempt, originAbortReceipt) {
    const expected = assertAwaitRequest(request);
    return this.#read(
      this.heldCallReconciliationIntentDirectory,
      expected.eventId,
      (record) => assertHeldCallReconciliationIntent(
        record,
        expected,
        armAttempt,
        originAbortReceipt,
      ),
    );
  }

  async appendHeldCallReconciliationApplied(
    value,
    request,
    intent,
    records = undefined,
  ) {
    const applied = assertHeldCallReconciliationApplied(value, request, intent, records);
    await this.ensureDirectories();
    const result = await publishImmutable({
      directory: this.heldCallReconciliationAppliedDirectory,
      fileName: `${validateEventId(applied.eventId)}.json`,
      value: applied,
      validate: (record) => assertHeldCallReconciliationApplied(record, request, intent),
      semantic: reconciliationAppliedSemantic,
      conflictCode: 'held_call_reconciliation_applied_conflict',
    });
    return { created: result.created, reconciliationApplied: result.value };
  }

  publishHeldCallReconciliationApplied(
    request,
    intent,
    input,
    clock = () => new Date(),
  ) {
    const records = {
      armBinding: input?.armBinding,
      transcriptBoundary: input?.transcriptBoundary,
      waiterReady: input?.waiterReady,
      suspensionCommitted: input?.suspensionCommitted ?? null,
      terminal: input?.terminal ?? null,
    };
    return this.appendHeldCallReconciliationApplied(
      createHeldCallReconciliationApplied(request, intent, input, clock),
      request,
      intent,
      records,
    );
  }

  readHeldCallReconciliationApplied(request, intent) {
    const expected = assertAwaitRequest(request);
    return this.#read(
      this.heldCallReconciliationAppliedDirectory,
      expected.eventId,
      (record) => assertHeldCallReconciliationApplied(record, expected, intent),
    );
  }

  async appendAwaitRequestTerminal(value, request = undefined) {
    const terminal = assertAwaitRequestTerminal(value, request);
    const result = await this.#append(
      this.awaitRequestTerminalDirectory,
      terminal.eventId,
      terminal,
      (record) => assertAwaitRequestTerminal(record, request),
      'recordedAt',
      'await_request_terminal_conflict',
    );
    return { created: result.created, awaitRequestTerminal: result.value };
  }

  publishAwaitRequestTerminal(request, input, clock = () => new Date()) {
    return this.appendAwaitRequestTerminal(
      createAwaitRequestTerminal(request, input, clock),
      request,
    );
  }

  readAwaitRequestTerminal(request) {
    const eventId = recordId(request);
    return this.#read(
      this.awaitRequestTerminalDirectory,
      eventId,
      (record) => assertAwaitRequestTerminal(
        record,
        typeof request === 'string' ? undefined : request,
      ),
    );
  }

  async archiveAwaitRequest(request, terminal = undefined) {
    await this.ensureDirectories();
    return this.#archiveAwaitRequestWithoutEnsure(request, terminal);
  }
}
