import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256Canonical } from './canonical.mjs';
import { CODEX_HARK_AWAIT_HOOK_TOOL_NAME, validatePreparedAwait } from './await-preparation.mjs';
import { defaultHarkDataDir } from './journal.mjs';
import { abortableDelay } from './tool-wait-protocol.mjs';

export const HOOK_INBOX_EVENT_VERSION = 'hark.codex-hook-inbox-event.v1';
export const HOOK_ARM_ACK_VERSION = 'hark.codex-hook-arm-ack.v1';
export const HOOK_WAKE_ADMISSION_VERSION = 'hark.codex-wake-admission.v1';
export const HOOK_WAKE_ADMISSION_ACK_VERSION = 'hark.codex-wake-admission-ack.v1';
export const HOOK_WAKE_DISPATCH_FENCE_VERSION = 'hark.codex-wake-dispatch-fence.v1';
export const HOOK_WAKE_DISPATCH_INTENT_VERSION = 'hark.codex-wake-dispatch-intent.v1';

const EVENT_FILE_PATTERN = /^hki_[a-f0-9]{64}\.json$/;
const WAKE_ADMISSION_FILE_PATTERN = /^hwa_[a-f0-9]{64}\.json$/;
const MAX_EVENT_BYTES = 256 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const TRANSIENT_FILESYSTEM_ERRORS = new Set([
  'EAGAIN', 'EBUSY', 'EINTR', 'EMFILE', 'ENFILE', 'ENOENT', 'ESTALE',
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_object_required`);
  }
}

function assertExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}_field_unsupported:${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}_field_required:${key}`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 512) {
    throw new Error(`${label}_invalid`);
  }
}

function eventIdentity(event) {
  if (event.kind === 'await_prepared') {
    return {
      v: event.v,
      kind: event.kind,
      sessionId: event.sessionId,
      turnId: event.turnId,
      toolUseId: event.toolUseId,
    };
  }
  throw new Error('hook_inbox_event_kind_invalid');
}

function eventId(event) {
  return `hki_${sha256Canonical(eventIdentity(event))}`;
}

function semanticEvent(event) {
  const { receivedAt: _receivedAt, ...semantic } = event;
  return semantic;
}

function semanticArmAcknowledgement(acknowledgement) {
  const { acknowledgedAt: _acknowledgedAt, ...semantic } = acknowledgement;
  return semantic;
}

function wakeAdmissionIdentity(admission) {
  return {
    v: admission.v,
    wakeId: admission.wakeId,
    awaitId: admission.awaitId,
    sessionId: admission.sessionId,
    transcriptPath: admission.transcriptPath,
    promptDigest: admission.promptDigest,
    leaseGeneration: admission.leaseGeneration,
  };
}

function wakeAdmissionId(admission) {
  return `hwa_${sha256Canonical(wakeAdmissionIdentity(admission))}`;
}

function semanticWakeAdmission(admission) {
  const { createdAt: _createdAt, ...semantic } = admission;
  return semantic;
}

function semanticWakeAdmissionAcknowledgement(acknowledgement) {
  const { admittedAt: _admittedAt, ...semantic } = acknowledgement;
  return semantic;
}

function wakeDispatchFenceId(fence) {
  return `hwf_${sha256Canonical({ v: fence.v, wakeId: fence.wakeId })}`;
}

function semanticWakeDispatchFence(fence) {
  const { createdAt: _createdAt, ...semantic } = fence;
  return semantic;
}

function wakeDispatchIntentId(intent) {
  return `hwi_${sha256Canonical({ v: intent.v, fenceId: intent.fenceId })}`;
}

function semanticWakeDispatchIntent(intent) {
  const { createdAt: _createdAt, ...semantic } = intent;
  return semantic;
}

export function assertHookInboxEvent(value) {
  assertPlainObject(value, 'hook_inbox_event');
  if (value.v !== HOOK_INBOX_EVENT_VERSION) throw new Error('hook_inbox_event_version_invalid');
  if (value.kind === 'await_prepared') {
    assertExactKeys(value, new Set([
      'v',
      'id',
      'kind',
      'sessionId',
      'turnId',
      'toolUseId',
      'toolName',
      'transcriptPath',
      'prepared',
      'receivedAt',
    ]), 'hook_inbox_event');
    assertIdentifier(value.toolUseId, 'tool_use_id');
    if (value.toolName !== CODEX_HARK_AWAIT_HOOK_TOOL_NAME) {
      throw new Error('hook_tool_name_invalid');
    }
    if (
      typeof value.transcriptPath !== 'string'
      || !value.transcriptPath
      || value.transcriptPath.length > 4096
      || !path.isAbsolute(value.transcriptPath)
    ) {
      throw new Error('transcript_path_invalid');
    }
    validatePreparedAwait(value.prepared);
  } else {
    throw new Error('hook_inbox_event_kind_invalid');
  }
  assertIdentifier(value.sessionId, 'session_id');
  assertIdentifier(value.turnId, 'turn_id');
  if (typeof value.receivedAt !== 'string' || !Number.isFinite(Date.parse(value.receivedAt))) {
    throw new Error('received_at_invalid');
  }
  const expectedId = eventId(value);
  if (value.id !== expectedId) throw new Error('hook_inbox_event_id_invalid');
  return value;
}

function receivedAt(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('hook_inbox_clock_invalid');
  return date.toISOString();
}

export function createAwaitPreparedInboxEvent({
  sessionId,
  turnId,
  toolUseId,
  toolName,
  transcriptPath,
  prepared,
}, clock = () => new Date()) {
  const event = {
    v: HOOK_INBOX_EVENT_VERSION,
    id: '',
    kind: 'await_prepared',
    sessionId,
    turnId,
    toolUseId,
    toolName,
    transcriptPath,
    prepared,
    receivedAt: receivedAt(clock),
  };
  event.id = eventId(event);
  return assertHookInboxEvent(event);
}

export function assertWakeAdmission(value) {
  assertPlainObject(value, 'hook_wake_admission');
  assertExactKeys(value, new Set([
    'v',
    'id',
    'wakeId',
    'awaitId',
    'sessionId',
    'transcriptPath',
    'promptDigest',
    'leaseGeneration',
    'createdAt',
  ]), 'hook_wake_admission');
  if (value.v !== HOOK_WAKE_ADMISSION_VERSION) {
    throw new Error('hook_wake_admission_version_invalid');
  }
  assertIdentifier(value.wakeId, 'wake_id');
  assertIdentifier(value.awaitId, 'await_id');
  assertIdentifier(value.sessionId, 'session_id');
  if (
    typeof value.transcriptPath !== 'string'
    || !value.transcriptPath
    || value.transcriptPath.length > 4096
    || !path.isAbsolute(value.transcriptPath)
  ) throw new Error('transcript_path_invalid');
  if (!/^[a-f0-9]{64}$/.test(value.promptDigest ?? '')) {
    throw new Error('wake_prompt_digest_invalid');
  }
  if (!Number.isSafeInteger(value.leaseGeneration) || value.leaseGeneration < 1) {
    throw new Error('lease_generation_invalid');
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('created_at_invalid');
  }
  if (value.id !== wakeAdmissionId(value)) throw new Error('hook_wake_admission_id_invalid');
  return value;
}

export function createWakeAdmission(input, clock = () => new Date()) {
  const admission = {
    v: HOOK_WAKE_ADMISSION_VERSION,
    id: '',
    wakeId: input.wakeId,
    awaitId: input.awaitId,
    sessionId: input.sessionId,
    transcriptPath: input.transcriptPath,
    promptDigest: input.promptDigest,
    leaseGeneration: input.leaseGeneration,
    createdAt: receivedAt(clock),
  };
  admission.id = wakeAdmissionId(admission);
  return assertWakeAdmission(admission);
}

export function assertWakeAdmissionAcknowledgement(value, admission = undefined) {
  assertPlainObject(value, 'hook_wake_admission_ack');
  assertExactKeys(value, new Set([
    'v',
    'admissionId',
    'wakeId',
    'awaitId',
    'sessionId',
    'turnId',
    'transcriptPath',
    'promptDigest',
    'leaseGeneration',
    'admittedAt',
  ]), 'hook_wake_admission_ack');
  if (value.v !== HOOK_WAKE_ADMISSION_ACK_VERSION) {
    throw new Error('hook_wake_admission_ack_version_invalid');
  }
  if (!/^hwa_[a-f0-9]{64}$/.test(value.admissionId ?? '')) {
    throw new Error('hook_wake_admission_ack_id_invalid');
  }
  for (const [field, label] of [
    ['wakeId', 'wake_id'],
    ['awaitId', 'await_id'],
    ['sessionId', 'session_id'],
    ['turnId', 'turn_id'],
  ]) assertIdentifier(value[field], label);
  if (
    typeof value.transcriptPath !== 'string'
    || !value.transcriptPath
    || value.transcriptPath.length > 4096
    || !path.isAbsolute(value.transcriptPath)
  ) throw new Error('transcript_path_invalid');
  if (!/^[a-f0-9]{64}$/.test(value.promptDigest ?? '')) {
    throw new Error('wake_prompt_digest_invalid');
  }
  if (!Number.isSafeInteger(value.leaseGeneration) || value.leaseGeneration < 1) {
    throw new Error('lease_generation_invalid');
  }
  if (typeof value.admittedAt !== 'string' || !Number.isFinite(Date.parse(value.admittedAt))) {
    throw new Error('admitted_at_invalid');
  }
  if (admission !== undefined) {
    const expected = assertWakeAdmission(admission);
    if (
      value.admissionId !== expected.id
      || value.wakeId !== expected.wakeId
      || value.awaitId !== expected.awaitId
      || value.sessionId !== expected.sessionId
      || value.transcriptPath !== expected.transcriptPath
      || value.promptDigest !== expected.promptDigest
      || value.leaseGeneration !== expected.leaseGeneration
    ) throw new Error('hook_wake_admission_ack_mismatch');
  }
  return value;
}

export function createWakeAdmissionAcknowledgement(
  admission,
  { turnId, transcriptPath },
  clock = () => new Date(),
) {
  const expected = assertWakeAdmission(admission);
  if (transcriptPath !== expected.transcriptPath) {
    throw new Error('hook_wake_admission_transcript_mismatch');
  }
  return assertWakeAdmissionAcknowledgement({
    v: HOOK_WAKE_ADMISSION_ACK_VERSION,
    admissionId: expected.id,
    wakeId: expected.wakeId,
    awaitId: expected.awaitId,
    sessionId: expected.sessionId,
    turnId,
    transcriptPath,
    promptDigest: expected.promptDigest,
    leaseGeneration: expected.leaseGeneration,
    admittedAt: receivedAt(clock),
  }, expected);
}

export function assertWakeDispatchFence(value) {
  assertPlainObject(value, 'hook_wake_dispatch_fence');
  assertExactKeys(value, new Set([
    'v',
    'id',
    'wakeId',
    'awaitId',
    'sessionId',
    'transcriptPath',
    'marker',
    'promptDigest',
    'createdAt',
  ]), 'hook_wake_dispatch_fence');
  if (value.v !== HOOK_WAKE_DISPATCH_FENCE_VERSION) {
    throw new Error('hook_wake_dispatch_fence_version_invalid');
  }
  assertIdentifier(value.wakeId, 'wake_id');
  assertIdentifier(value.awaitId, 'await_id');
  assertIdentifier(value.sessionId, 'session_id');
  if (
    typeof value.transcriptPath !== 'string'
    || !value.transcriptPath
    || value.transcriptPath.length > 4096
    || !path.isAbsolute(value.transcriptPath)
  ) throw new Error('transcript_path_invalid');
  if (value.marker !== `hark:wake:${value.wakeId}`) {
    throw new Error('hook_wake_dispatch_marker_invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(value.promptDigest ?? '')) {
    throw new Error('wake_prompt_digest_invalid');
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('created_at_invalid');
  }
  if (value.id !== wakeDispatchFenceId(value)) {
    throw new Error('hook_wake_dispatch_fence_id_invalid');
  }
  return value;
}

export function createWakeDispatchFence(input, clock = () => new Date()) {
  const fence = {
    v: HOOK_WAKE_DISPATCH_FENCE_VERSION,
    id: '',
    wakeId: input.wakeId,
    awaitId: input.awaitId,
    sessionId: input.sessionId,
    transcriptPath: input.transcriptPath,
    marker: input.marker,
    promptDigest: input.promptDigest,
    createdAt: receivedAt(clock),
  };
  fence.id = wakeDispatchFenceId(fence);
  return assertWakeDispatchFence(fence);
}

export function assertWakeDispatchIntent(value, fence = undefined) {
  assertPlainObject(value, 'hook_wake_dispatch_intent');
  assertExactKeys(value, new Set([
    'v',
    'id',
    'fenceId',
    'wakeId',
    'marker',
    'promptDigest',
    'admissionId',
    'leaseGeneration',
    'createdAt',
  ]), 'hook_wake_dispatch_intent');
  if (value.v !== HOOK_WAKE_DISPATCH_INTENT_VERSION) {
    throw new Error('hook_wake_dispatch_intent_version_invalid');
  }
  if (!/^hwf_[a-f0-9]{64}$/.test(value.fenceId ?? '')) {
    throw new Error('hook_wake_dispatch_fence_id_invalid');
  }
  if (!/^hwa_[a-f0-9]{64}$/.test(value.admissionId ?? '')) {
    throw new Error('hook_wake_admission_id_invalid');
  }
  assertIdentifier(value.wakeId, 'wake_id');
  if (value.marker !== `hark:wake:${value.wakeId}`) {
    throw new Error('hook_wake_dispatch_marker_invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(value.promptDigest ?? '')) {
    throw new Error('wake_prompt_digest_invalid');
  }
  if (!Number.isSafeInteger(value.leaseGeneration) || value.leaseGeneration < 1) {
    throw new Error('lease_generation_invalid');
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('created_at_invalid');
  }
  if (value.id !== wakeDispatchIntentId(value)) {
    throw new Error('hook_wake_dispatch_intent_id_invalid');
  }
  if (fence !== undefined) {
    const expected = assertWakeDispatchFence(fence);
    if (
      value.fenceId !== expected.id
      || value.wakeId !== expected.wakeId
      || value.marker !== expected.marker
      || value.promptDigest !== expected.promptDigest
    ) throw new Error('hook_wake_dispatch_intent_fence_mismatch');
  }
  return value;
}

export function createWakeDispatchIntent(fence, admission, clock = () => new Date()) {
  const expectedFence = assertWakeDispatchFence(fence);
  const expectedAdmission = assertWakeAdmission(admission);
  if (
    expectedAdmission.wakeId !== expectedFence.wakeId
    || expectedAdmission.awaitId !== expectedFence.awaitId
    || expectedAdmission.sessionId !== expectedFence.sessionId
    || expectedAdmission.transcriptPath !== expectedFence.transcriptPath
    || expectedAdmission.promptDigest !== expectedFence.promptDigest
  ) throw new Error('hook_wake_dispatch_intent_admission_mismatch');
  const intent = {
    v: HOOK_WAKE_DISPATCH_INTENT_VERSION,
    id: '',
    fenceId: expectedFence.id,
    wakeId: expectedFence.wakeId,
    marker: expectedFence.marker,
    promptDigest: expectedFence.promptDigest,
    admissionId: expectedAdmission.id,
    leaseGeneration: expectedAdmission.leaseGeneration,
    createdAt: receivedAt(clock),
  };
  intent.id = wakeDispatchIntentId(intent);
  return assertWakeDispatchIntent(intent, expectedFence);
}

export function assertArmAcknowledgement(value, event = undefined) {
  assertPlainObject(value, 'hook_arm_ack');
  assertExactKeys(value, new Set([
    'v',
    'eventId',
    'preparationNonce',
    'awaitId',
    'state',
    'apiResultVersion',
    'acknowledgedAt',
  ]), 'hook_arm_ack');
  if (value.v !== HOOK_ARM_ACK_VERSION) throw new Error('hook_arm_ack_version_invalid');
  if (!/^hki_[a-f0-9]{64}$/.test(value.eventId ?? '')) {
    throw new Error('hook_arm_ack_event_id_invalid');
  }
  assertIdentifier(value.preparationNonce, 'preparation_nonce');
  assertIdentifier(value.awaitId, 'await_id');
  if (value.state !== 'armed') throw new Error('hook_arm_ack_state_invalid');
  if (value.apiResultVersion !== 'hark.await-arm-result.v2') {
    throw new Error('hook_arm_ack_api_version_invalid');
  }
  if (
    typeof value.acknowledgedAt !== 'string'
    || !Number.isFinite(Date.parse(value.acknowledgedAt))
  ) {
    throw new Error('acknowledged_at_invalid');
  }
  if (event !== undefined) {
    const preparedEvent = assertHookInboxEvent(event);
    if (value.eventId !== preparedEvent.id) throw new Error('hook_arm_ack_event_mismatch');
    if (value.preparationNonce !== preparedEvent.prepared.preparationNonce) {
      throw new Error('hook_arm_ack_preparation_mismatch');
    }
  }
  return value;
}

export function createArmAcknowledgement(event, { awaitId }, clock = () => new Date()) {
  const preparedEvent = assertHookInboxEvent(event);
  return assertArmAcknowledgement({
    v: HOOK_ARM_ACK_VERSION,
    eventId: preparedEvent.id,
    preparationNonce: preparedEvent.prepared.preparationNonce,
    awaitId,
    state: 'armed',
    apiResultVersion: 'hark.await-arm-result.v2',
    acknowledgedAt: receivedAt(clock),
  }, preparedEvent);
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

async function publishImmutable({
  directory,
  fileName,
  value,
  validate,
  semantic,
  conflictCode,
}) {
  const finalPath = path.join(directory, fileName);
  const tempPath = path.join(
    directory,
    `.${fileName}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const serialized = `${canonicalJson(value)}\n`;
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
    const existing = validate(JSON.parse(await readFile(finalPath, 'utf8')));
    if (canonicalJson(semantic(existing)) !== canonicalJson(semantic(value))) {
      throw new Error(conflictCode);
    }
    return { created: false, value: existing };
  }
}

function transientFilesystemError(error) {
  return TRANSIENT_FILESYSTEM_ERRORS.has(error?.code);
}

async function readCanonicalEvent(filePath) {
  const handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('hook_inbox_event_file_invalid');
    if ((metadata.mode & 0o077) !== 0) throw new Error('hook_inbox_event_permissions_invalid');
    if (metadata.size < 2 || metadata.size > MAX_EVENT_BYTES) {
      throw new Error('hook_inbox_event_size_invalid');
    }
    const raw = await handle.readFile('utf8');
    const event = assertHookInboxEvent(JSON.parse(raw));
    if (raw !== `${canonicalJson(event)}\n`) throw new Error('hook_inbox_event_noncanonical');
    return event;
  } finally {
    await handle.close();
  }
}

async function readCanonicalWakeAdmission(filePath) {
  const handle = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('hook_wake_admission_file_invalid');
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('hook_wake_admission_permissions_invalid');
    }
    if (metadata.size < 2 || metadata.size > MAX_EVENT_BYTES) {
      throw new Error('hook_wake_admission_size_invalid');
    }
    const raw = await handle.readFile('utf8');
    const admission = assertWakeAdmission(JSON.parse(raw));
    if (raw !== `${canonicalJson(admission)}\n`) {
      throw new Error('hook_wake_admission_noncanonical');
    }
    return admission;
  } finally {
    await handle.close();
  }
}

async function quarantineEvent({ sourceDirectory, quarantineDirectory, name, error }) {
  const sourcePath = path.join(sourceDirectory, name);
  let raw = null;
  let metadata = null;
  try {
    metadata = await lstat(sourcePath);
    if (metadata.isFile() && metadata.size <= MAX_EVENT_BYTES * 2) {
      raw = await readFile(sourcePath);
    }
  } catch (inspectionError) {
    if (inspectionError?.code === 'ENOENT') return false;
    if (transientFilesystemError(inspectionError)) throw inspectionError;
  }
  const quarantineId = sha256Canonical({
    name,
    error: error?.message ?? String(error),
    contentDigest: raw === null
      ? null
      : crypto.createHash('sha256').update(raw).digest('hex'),
    size: metadata?.size ?? null,
  });
  const destinationPath = path.join(quarantineDirectory, `bad_${quarantineId}.record`);
  if (!metadata?.isFile()) {
    try {
      await rename(sourcePath, destinationPath);
    } catch (renameError) {
      if (renameError?.code === 'ENOENT') return false;
      if (renameError?.code !== 'EEXIST') throw renameError;
      throw new Error('hook_inbox_quarantine_conflict');
    }
    await Promise.all([
      syncDirectory(sourceDirectory),
      syncDirectory(quarantineDirectory),
    ]);
    return true;
  }
  try {
    await link(sourcePath, destinationPath);
    await chmod(destinationPath, 0o600);
  } catch (linkError) {
    if (linkError?.code === 'ENOENT') return false;
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
  return true;
}

async function archiveEvent({ pendingDirectory, archiveDirectory, event }) {
  const fileName = `${event.id}.json`;
  const pendingPath = path.join(pendingDirectory, fileName);
  const archivePath = path.join(archiveDirectory, fileName);
  let archived = null;
  try {
    archived = await readCanonicalEvent(archivePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (archived) {
    if (canonicalJson(archived) !== canonicalJson(event)) {
      throw new Error('hook_inbox_archive_conflict');
    }
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
      const concurrentlyArchived = await readCanonicalEvent(archivePath);
      if (canonicalJson(concurrentlyArchived) !== canonicalJson(event)) {
        throw new Error('hook_inbox_archive_conflict');
      }
    }
  }
  await Promise.all([
    syncDirectory(pendingDirectory),
    syncDirectory(archiveDirectory),
  ]);
}

export class HarkHookInbox {
  constructor(dataDir = defaultHarkDataDir()) {
    this.dataDir = path.resolve(dataDir);
    this.directory = path.join(this.dataDir, 'hook-inbox', 'events');
    this.archiveDirectory = path.join(this.dataDir, 'hook-inbox', 'events-archive');
    this.quarantineDirectory = path.join(this.dataDir, 'hook-inbox', 'events-quarantine');
    this.ackDirectory = path.join(this.dataDir, 'hook-inbox', 'arm-acks');
    this.wakeAdmissionDirectory = path.join(this.dataDir, 'hook-inbox', 'wake-admissions');
    this.wakeAdmissionAckDirectory = path.join(this.dataDir, 'hook-inbox', 'wake-admission-acks');
    this.wakeDispatchFenceDirectory = path.join(this.dataDir, 'hook-inbox', 'wake-dispatch-fences');
    this.wakeDispatchIntentDirectory = path.join(this.dataDir, 'hook-inbox', 'wake-dispatch-intents');
    this.spoolInitialization = null;
  }

  async ensureDirectory() {
    await Promise.all([
      mkdir(this.directory, { recursive: true, mode: 0o700 }),
      mkdir(this.archiveDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.quarantineDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.ackDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.wakeAdmissionDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.wakeAdmissionAckDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.wakeDispatchFenceDirectory, { recursive: true, mode: 0o700 }),
      mkdir(this.wakeDispatchIntentDirectory, { recursive: true, mode: 0o700 }),
    ]);
    await chmod(path.join(this.dataDir, 'hook-inbox'), 0o700);
    await chmod(this.directory, 0o700);
    await chmod(this.archiveDirectory, 0o700);
    await chmod(this.quarantineDirectory, 0o700);
    await chmod(this.ackDirectory, 0o700);
    await chmod(this.wakeAdmissionDirectory, 0o700);
    await chmod(this.wakeAdmissionAckDirectory, 0o700);
    await chmod(this.wakeDispatchFenceDirectory, 0o700);
    await chmod(this.wakeDispatchIntentDirectory, 0o700);
    if (!this.spoolInitialization) {
      const initialization = this.#readPendingEvents();
      this.spoolInitialization = initialization;
      try {
        await initialization;
      } catch (error) {
        if (this.spoolInitialization === initialization) this.spoolInitialization = null;
        throw error;
      }
      return;
    }
    await this.spoolInitialization;
  }

  async #readArmAcknowledgementWithoutEnsure(event) {
    try {
      const value = JSON.parse(await readFile(
        path.join(this.ackDirectory, `${event.id}.json`),
        'utf8',
      ));
      return assertArmAcknowledgement(value, event);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #readPendingEvents() {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const events = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isFile() || !EVENT_FILE_PATTERN.test(entry.name)) {
        await quarantineEvent({
          sourceDirectory: this.directory,
          quarantineDirectory: this.quarantineDirectory,
          name: entry.name,
          error: new Error('hook_inbox_spool_entry_invalid'),
        });
        continue;
      }
      let event;
      try {
        event = await readCanonicalEvent(path.join(this.directory, entry.name));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        if (transientFilesystemError(error)) throw error;
        await quarantineEvent({
          sourceDirectory: this.directory,
          quarantineDirectory: this.quarantineDirectory,
          name: entry.name,
          error,
        });
        continue;
      }
      if (await this.#readArmAcknowledgementWithoutEnsure(event)) {
        await archiveEvent({
          pendingDirectory: this.directory,
          archiveDirectory: this.archiveDirectory,
          event,
        });
      } else {
        events.push(event);
      }
    }
    return events;
  }

  eventPath(id) {
    if (!/^hki_[a-f0-9]{64}$/.test(id)) throw new Error('hook_inbox_event_id_invalid');
    return path.join(this.directory, `${id}.json`);
  }

  async append(value) {
    const event = assertHookInboxEvent(value);
    await this.ensureDirectory();
    try {
      const archived = await readCanonicalEvent(path.join(
        this.archiveDirectory,
        `${event.id}.json`,
      ));
      if (canonicalJson(semanticEvent(archived)) !== canonicalJson(semanticEvent(event))) {
        throw new Error('hook_inbox_event_conflict');
      }
      return { created: false, event: archived };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const result = await publishImmutable({
      directory: this.directory,
      fileName: `${event.id}.json`,
      value: event,
      validate: assertHookInboxEvent,
      semantic: semanticEvent,
      conflictCode: 'hook_inbox_event_conflict',
    });
    return { created: result.created, event: result.value };
  }

  async list() {
    await this.ensureDirectory();
    return this.#readPendingEvents();
  }

  async acknowledgeArm(event, { awaitId }, clock = () => new Date()) {
    const preparedEvent = assertHookInboxEvent(event);
    const acknowledgement = createArmAcknowledgement(preparedEvent, { awaitId }, clock);
    await this.ensureDirectory();
    const result = await publishImmutable({
      directory: this.ackDirectory,
      fileName: `${preparedEvent.id}.json`,
      value: acknowledgement,
      validate: (value) => assertArmAcknowledgement(value, preparedEvent),
      semantic: semanticArmAcknowledgement,
      conflictCode: 'hook_arm_ack_conflict',
    });
    await archiveEvent({
      pendingDirectory: this.directory,
      archiveDirectory: this.archiveDirectory,
      event: preparedEvent,
    });
    return { created: result.created, acknowledgement: result.value };
  }

  async readArmAcknowledgement(event) {
    const preparedEvent = assertHookInboxEvent(event);
    await this.ensureDirectory();
    return this.#readArmAcknowledgementWithoutEnsure(preparedEvent);
  }

  async waitForArmAcknowledgement(event, options = {}) {
    const preparedEvent = assertHookInboxEvent(event);
    const timeoutMs = options.timeoutMs ?? 35_000;
    const pollIntervalMs = options.pollIntervalMs ?? 25;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 35_000) {
      throw new Error('hook_arm_ack_timeout_invalid');
    }
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1_000) {
      throw new Error('hook_arm_ack_poll_interval_invalid');
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const acknowledgement = await this.readArmAcknowledgement(preparedEvent);
      if (acknowledgement) return acknowledgement;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('hook_arm_ack_timeout');
      await abortableDelay(
        Math.min(pollIntervalMs, remaining),
        options.signal,
        { label: 'hook_arm_ack' },
      );
    }
  }

  async publishWakeAdmission(input, clock = () => new Date()) {
    const admission = createWakeAdmission(input, clock);
    await this.ensureDirectory();
    const result = await publishImmutable({
      directory: this.wakeAdmissionDirectory,
      fileName: `${admission.id}.json`,
      value: admission,
      validate: assertWakeAdmission,
      semantic: semanticWakeAdmission,
      conflictCode: 'hook_wake_admission_conflict',
    });
    return { created: result.created, admission: result.value };
  }

  async listWakeAdmissions() {
    await this.ensureDirectory();
    const entries = await readdir(this.wakeAdmissionDirectory, { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isFile() && WAKE_ADMISSION_FILE_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    return Promise.all(names.map(async (name) => (
      assertWakeAdmission(JSON.parse(await readFile(
        path.join(this.wakeAdmissionDirectory, name),
        'utf8',
      )))
    )));
  }

  async readWakeAdmission(admissionId) {
    if (!/^hwa_[a-f0-9]{64}$/.test(admissionId ?? '')) {
      throw new Error('hook_wake_admission_id_invalid');
    }
    await this.ensureDirectory();
    try {
      return await readCanonicalWakeAdmission(path.join(
        this.wakeAdmissionDirectory,
        `${admissionId}.json`,
      ));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async acknowledgeWakeAdmission(admission, input, clock = () => new Date()) {
    const expected = assertWakeAdmission(admission);
    const acknowledgement = createWakeAdmissionAcknowledgement(expected, input, clock);
    await this.ensureDirectory();
    const result = await publishImmutable({
      directory: this.wakeAdmissionAckDirectory,
      fileName: `${expected.id}.json`,
      value: acknowledgement,
      validate: (value) => assertWakeAdmissionAcknowledgement(value, expected),
      semantic: semanticWakeAdmissionAcknowledgement,
      conflictCode: 'hook_wake_admission_ack_conflict',
    });
    return { created: result.created, acknowledgement: result.value };
  }

  async readWakeAdmissionAcknowledgement(admission) {
    const expected = assertWakeAdmission(admission);
    await this.ensureDirectory();
    try {
      const value = JSON.parse(await readFile(
        path.join(this.wakeAdmissionAckDirectory, `${expected.id}.json`),
        'utf8',
      ));
      return assertWakeAdmissionAcknowledgement(value, expected);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async waitForWakeAdmissionAcknowledgement(admission, options = {}) {
    const expected = assertWakeAdmission(admission);
    const timeoutMs = options.timeoutMs ?? 7_000;
    const pollIntervalMs = options.pollIntervalMs ?? 25;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 7_000) {
      throw new Error('hook_wake_admission_ack_timeout_invalid');
    }
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1_000) {
      throw new Error('hook_wake_admission_ack_poll_interval_invalid');
    }
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const acknowledgement = await this.readWakeAdmissionAcknowledgement(expected);
      if (acknowledgement) return acknowledgement;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('hook_wake_admission_ack_timeout');
      await abortableDelay(
        Math.min(pollIntervalMs, remaining),
        options.signal,
        { label: 'hook_wake_admission_ack' },
      );
    }
  }

  async publishWakeDispatchFence(input, clock = () => new Date()) {
    const fence = createWakeDispatchFence(input, clock);
    await this.ensureDirectory();
    const result = await publishImmutable({
      directory: this.wakeDispatchFenceDirectory,
      fileName: `${fence.id}.json`,
      value: fence,
      validate: assertWakeDispatchFence,
      semantic: semanticWakeDispatchFence,
      conflictCode: 'hook_wake_dispatch_fence_conflict',
    });
    return { created: result.created, fence: result.value };
  }

  async readWakeDispatchFence(wakeId) {
    assertIdentifier(wakeId, 'wake_id');
    await this.ensureDirectory();
    const id = wakeDispatchFenceId({ v: HOOK_WAKE_DISPATCH_FENCE_VERSION, wakeId });
    try {
      return assertWakeDispatchFence(JSON.parse(await readFile(
        path.join(this.wakeDispatchFenceDirectory, `${id}.json`),
        'utf8',
      )));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async publishWakeDispatchIntent(fence, admission, clock = () => new Date()) {
    const expectedFence = assertWakeDispatchFence(fence);
    const intent = createWakeDispatchIntent(expectedFence, admission, clock);
    await this.ensureDirectory();
    const result = await publishImmutable({
      directory: this.wakeDispatchIntentDirectory,
      fileName: `${intent.id}.json`,
      value: intent,
      validate: (value) => assertWakeDispatchIntent(value, expectedFence),
      semantic: semanticWakeDispatchIntent,
      conflictCode: 'hook_wake_dispatch_intent_conflict',
    });
    return { created: result.created, intent: result.value };
  }

  async readWakeDispatchIntent(fence) {
    const expectedFence = assertWakeDispatchFence(fence);
    await this.ensureDirectory();
    const id = wakeDispatchIntentId({
      v: HOOK_WAKE_DISPATCH_INTENT_VERSION,
      fenceId: expectedFence.id,
    });
    try {
      return assertWakeDispatchIntent(JSON.parse(await readFile(
        path.join(this.wakeDispatchIntentDirectory, `${id}.json`),
        'utf8',
      )), expectedFence);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
}
