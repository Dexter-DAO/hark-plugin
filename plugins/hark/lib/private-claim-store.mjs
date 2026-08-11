import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256Canonical } from './canonical.mjs';
import { defaultHarkDataDir } from './journal.mjs';

export const PRIVATE_CLAIM_REFERENCE_VERSION = 'hark.codex-held-claim-ref.v1';
const PRIVATE_CLAIM_VERSION = 'hark.private-held-claim.v1';
const CONSUMED_CLAIM_VERSION = 'hark.private-held-claim-consumed.v1';
const CLAIM_LOCATOR_PATTERN = /^hhc_[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 64 * 1024;
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

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

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}_field_unsupported:${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}_field_required:${key}`);
  }
}

function assertString(value, label, max = 4096) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.includes('\0')
    || value.length > max
  ) throw new Error(`${label}_invalid`);
  return value;
}

function assertDigest(value, label) {
  if (!DIGEST_PATTERN.test(value ?? '')) throw new Error(`${label}_invalid`);
  return value;
}

function assertLocator(value) {
  if (!CLAIM_LOCATOR_PATTERN.test(value ?? '')) throw new Error('private_claim_locator_invalid');
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

export function createPrivateClaimBinding(value) {
  const binding = {
    eventId: value?.eventId,
    deliveryId: value?.deliveryId,
    awaitId: value?.awaitId,
    wakeId: value?.wakeId,
    toolUseId: value?.toolUseId,
    checkpointDigest: value?.checkpointDigest,
    wakeDeliveryDigest: value?.wakeDeliveryDigest,
    toolResultDigest: value?.toolResultDigest,
  };
  return assertPrivateClaimBinding(binding);
}

export function assertPrivateClaimBinding(value) {
  assertExactKeys(value, [
    'eventId',
    'deliveryId',
    'awaitId',
    'wakeId',
    'toolUseId',
    'checkpointDigest',
    'wakeDeliveryDigest',
    'toolResultDigest',
  ], 'private_claim_binding');
  assertString(value.eventId, 'private_claim_event_id', 160);
  assertString(value.deliveryId, 'private_claim_delivery_id', 160);
  assertString(value.awaitId, 'private_claim_await_id', 512);
  assertString(value.wakeId, 'private_claim_wake_id', 512);
  assertString(value.toolUseId, 'private_claim_tool_use_id', 512);
  assertDigest(value.checkpointDigest, 'private_claim_checkpoint_digest');
  assertDigest(value.wakeDeliveryDigest, 'private_claim_wake_delivery_digest');
  assertDigest(value.toolResultDigest, 'private_claim_tool_result_digest');
  return value;
}

function bindingDigest(binding) {
  return sha256Canonical(assertPrivateClaimBinding(binding));
}

export function assertPrivateClaimReference(value, expectedBinding = undefined) {
  assertExactKeys(value, [
    'v',
    'locator',
    'bindingDigest',
    'wakeDeliveryDigest',
    'toolResultDigest',
  ], 'private_claim_reference');
  if (value.v !== PRIVATE_CLAIM_REFERENCE_VERSION) {
    throw new Error('private_claim_reference_version_invalid');
  }
  assertLocator(value.locator);
  assertDigest(value.bindingDigest, 'private_claim_binding_digest');
  assertDigest(value.wakeDeliveryDigest, 'private_claim_wake_delivery_digest');
  assertDigest(value.toolResultDigest, 'private_claim_tool_result_digest');
  if (expectedBinding !== undefined) {
    const expected = assertPrivateClaimBinding(expectedBinding);
    if (
      value.bindingDigest !== bindingDigest(expected)
      || value.wakeDeliveryDigest !== expected.wakeDeliveryDigest
      || value.toolResultDigest !== expected.toolResultDigest
    ) throw new Error('private_claim_reference_binding_mismatch');
  }
  return value;
}

function assertPrivateClaim(value) {
  assertExactKeys(value, [
    'v',
    'locator',
    'binding',
    'bindingDigest',
    'waiterId',
    'leaseToken',
    'leaseGeneration',
    'createdAt',
  ], 'private_claim');
  if (value.v !== PRIVATE_CLAIM_VERSION) throw new Error('private_claim_version_invalid');
  assertLocator(value.locator);
  const binding = assertPrivateClaimBinding(value.binding);
  if (value.bindingDigest !== bindingDigest(binding)) {
    throw new Error('private_claim_binding_digest_mismatch');
  }
  assertString(value.waiterId, 'private_claim_waiter_id', 512);
  assertString(value.leaseToken, 'private_claim_lease_token', 4096);
  if (!Number.isSafeInteger(value.leaseGeneration) || value.leaseGeneration < 1) {
    throw new Error('private_claim_lease_generation_invalid');
  }
  assertTimestamp(value.createdAt, 'private_claim_created_at');
  return value;
}

function assertConsumedClaim(value) {
  assertExactKeys(value, [
    'v',
    'locator',
    'binding',
    'bindingDigest',
    'consumedAt',
  ], 'consumed_private_claim');
  if (value.v !== CONSUMED_CLAIM_VERSION) {
    throw new Error('consumed_private_claim_version_invalid');
  }
  assertLocator(value.locator);
  const binding = assertPrivateClaimBinding(value.binding);
  if (value.bindingDigest !== bindingDigest(binding)) {
    throw new Error('consumed_private_claim_binding_digest_mismatch');
  }
  assertTimestamp(value.consumedAt, 'private_claim_consumed_at');
  return value;
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('private_claim_directory_invalid');
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
    if (!metadata.isFile()) throw new Error('private_claim_record_not_regular');
    if ((metadata.mode & 0o077) !== 0) throw new Error('private_claim_record_permissions_invalid');
    if (metadata.size < 2 || metadata.size > MAX_RECORD_BYTES) {
      throw new Error('private_claim_record_size_invalid');
    }
    const raw = await handle.readFile('utf8');
    const value = validate(JSON.parse(raw));
    if (raw !== `${canonicalJson(value)}\n`) throw new Error('private_claim_record_noncanonical');
    return value;
  } finally {
    await handle.close();
  }
}

async function publishExclusive(directory, fileName, value, validate, collisionCode) {
  const finalPath = path.join(directory, fileName);
  const tempPath = path.join(
    directory,
    `.${fileName}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const serialized = `${canonicalJson(validate(value))}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('private_claim_record_too_large');
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
    return value;
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (unlinkError) {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    }
    if (error?.code === 'EEXIST') throw new Error(collisionCode);
    throw error;
  }
}

function assertRecordBinding(record, reference, expectedBinding) {
  if (
    record.locator !== reference.locator
    || record.bindingDigest !== reference.bindingDigest
    || canonicalJson(record.binding) !== canonicalJson(expectedBinding)
  ) throw new Error('private_claim_record_binding_mismatch');
  return record;
}

export class HarkPrivateClaimStore {
  constructor(dataDir = defaultHarkDataDir()) {
    this.dataDir = path.resolve(dataDir);
    this.rootDirectory = path.join(this.dataDir, 'private-held-claims');
    this.pendingDirectory = path.join(this.rootDirectory, 'pending');
    this.consumedDirectory = path.join(this.rootDirectory, 'consumed');
  }

  async ensureDirectories() {
    await ensurePrivateDirectory(this.rootDirectory);
    await Promise.all([
      ensurePrivateDirectory(this.pendingDirectory),
      ensurePrivateDirectory(this.consumedDirectory),
    ]);
  }

  #path(directory, locator) {
    return path.join(directory, `${assertLocator(locator)}.json`);
  }

  async create(input, options = {}) {
    const binding = createPrivateClaimBinding(input?.binding);
    const locator = `hhc_${(options.randomBytes ?? crypto.randomBytes)(32).toString('base64url')}`;
    const record = assertPrivateClaim({
      v: PRIVATE_CLAIM_VERSION,
      locator,
      binding,
      bindingDigest: bindingDigest(binding),
      waiterId: input?.waiterId,
      leaseToken: input?.leaseToken,
      leaseGeneration: input?.leaseGeneration,
      createdAt: timestamp(options.clock ?? (() => new Date()), 'private_claim_created_at'),
    });
    await this.ensureDirectories();
    await publishExclusive(
      this.pendingDirectory,
      `${locator}.json`,
      record,
      assertPrivateClaim,
      'private_claim_locator_collision',
    );
    return assertPrivateClaimReference({
      v: PRIVATE_CLAIM_REFERENCE_VERSION,
      locator,
      bindingDigest: record.bindingDigest,
      wakeDeliveryDigest: binding.wakeDeliveryDigest,
      toolResultDigest: binding.toolResultDigest,
    }, binding);
  }

  async resolve(referenceValue, expectedBindingValue) {
    const expectedBinding = createPrivateClaimBinding(expectedBindingValue);
    const reference = assertPrivateClaimReference(referenceValue, expectedBinding);
    await this.ensureDirectories();
    const consumedPath = this.#path(this.consumedDirectory, reference.locator);
    try {
      const consumed = await readCanonicalRecord(consumedPath, assertConsumedClaim);
      assertRecordBinding(consumed, reference, expectedBinding);
      return { state: 'consumed' };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const pendingPath = this.#path(this.pendingDirectory, reference.locator);
    let pending;
    try {
      pending = await readCanonicalRecord(pendingPath, assertPrivateClaim);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('private_claim_missing');
      throw error;
    }
    assertRecordBinding(pending, reference, expectedBinding);
    return {
      state: 'pending',
      leaseToken: pending.leaseToken,
      leaseGeneration: pending.leaseGeneration,
    };
  }

  async consume(referenceValue, expectedBindingValue, options = {}) {
    const expectedBinding = createPrivateClaimBinding(expectedBindingValue);
    const reference = assertPrivateClaimReference(referenceValue, expectedBinding);
    const resolved = await this.resolve(reference, expectedBinding);
    if (resolved.state === 'consumed') return { consumed: false, state: 'consumed' };
    const tombstone = assertConsumedClaim({
      v: CONSUMED_CLAIM_VERSION,
      locator: reference.locator,
      binding: expectedBinding,
      bindingDigest: reference.bindingDigest,
      consumedAt: timestamp(options.clock ?? (() => new Date()), 'private_claim_consumed_at'),
    });
    let created = true;
    try {
      await publishExclusive(
        this.consumedDirectory,
        `${reference.locator}.json`,
        tombstone,
        assertConsumedClaim,
        'private_claim_consumed_collision',
      );
    } catch (error) {
      if (error?.message !== 'private_claim_consumed_collision') throw error;
      const existing = await readCanonicalRecord(
        this.#path(this.consumedDirectory, reference.locator),
        assertConsumedClaim,
      );
      assertRecordBinding(existing, reference, expectedBinding);
      created = false;
    }
    try {
      await unlink(this.#path(this.pendingDirectory, reference.locator));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await Promise.all([
      syncDirectory(this.pendingDirectory),
      syncDirectory(this.consumedDirectory),
    ]);
    return { consumed: created, state: 'consumed' };
  }
}
