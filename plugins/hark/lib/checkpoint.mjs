import { sha256Canonical } from './canonical.mjs';

export const CODEX_CHECKPOINT_VERSION = 'hark.codex-checkpoint.v1';

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label}_required`);
  }
  return value;
}

/**
 * Bind one Hark preparation to the trusted App Server item boundary that
 * produced it. The descriptor remains local; Hark receives its stable digest.
 */
export function createCodexCheckpoint(input) {
  const descriptor = {
    v: CODEX_CHECKPOINT_VERSION,
    protocol: 'codex-app-server-v2',
    conversationId: requiredString(input?.threadId, 'thread_id'),
    taskId: requiredString(input?.turnId, 'turn_id'),
    itemId: requiredString(input?.itemId, 'item_id'),
    preparationNonce: requiredString(input?.preparationNonce, 'preparation_nonce'),
    qualificationDigest: requiredString(input?.qualificationDigest, 'qualification_digest'),
  };
  if (!/^[0-9a-f]{64}$/.test(descriptor.qualificationDigest)) {
    throw new Error('qualification_digest_invalid');
  }
  return {
    version: CODEX_CHECKPOINT_VERSION,
    digest: sha256Canonical(descriptor),
    descriptor,
  };
}
