const ARMED_AT = '2026-08-07T12:00:00.000Z';
const SUSPENDED_AT = '2026-08-07T12:00:01.000Z';
const WAKE_PENDING_AT = '2026-08-07T12:00:02.000Z';

function transitionTimestamps(state) {
  return {
    suspendedAt: state === 'armed' ? null : SUSPENDED_AT,
    wakePendingAt: [
      'wake_pending',
      'accepted',
      'running',
      'completed',
      'failed',
      'cancelled',
    ].includes(state) ? WAKE_PENDING_AT : null,
    acceptedAt: ['accepted', 'running', 'completed', 'failed', 'cancelled'].includes(state)
      ? '2026-08-07T12:00:03.000Z'
      : null,
    runningAt: ['running', 'completed', 'failed', 'cancelled'].includes(state)
      ? '2026-08-07T12:00:04.000Z'
      : null,
    completedAt: state === 'completed' ? '2026-08-07T12:00:05.000Z' : null,
    failedAt: state === 'failed' ? '2026-08-07T12:00:05.000Z' : null,
    cancelledAt: state === 'cancelled' ? '2026-08-07T12:00:05.000Z' : null,
  };
}

export function armApiResponse(armRequest, options = {}) {
  const state = options.state ?? 'armed';
  const waiterId = options.waiterId ?? 'waiter-1';
  const leaseGeneration = options.leaseGeneration ?? 1;
  const leaseExpiresAt = options.leaseExpiresAt ?? '2026-08-07T12:10:00.000Z';
  const releasedAt = options.releasedAt ?? null;
  const updatedAt = state === 'armed' ? ARMED_AT : '2026-08-07T12:00:05.000Z';
  return {
    v: 'hark.await-arm-result.v2',
    await: {
      v: 'hark.await.v2',
      id: options.awaitId ?? 'await-1',
      preparationNonce: armRequest.preparationNonce,
      origin: structuredClone(armRequest.origin),
      checkpoint: structuredClone(armRequest.checkpoint),
      binding: structuredClone(armRequest.binding),
      waiter: {
        waiterId,
        leaseGeneration,
        leaseExpiresAt,
        releasedAt,
      },
      prepared: structuredClone(armRequest.prepared),
      predicate: structuredClone(armRequest.predicate),
      wakePolicy: armRequest.wakePolicy,
      state,
      armedAt: ARMED_AT,
      ...transitionTimestamps(state),
      lastError: options.lastError ?? null,
      createdAt: ARMED_AT,
      updatedAt,
    },
    waiter: {
      waiterId,
      leaseToken: options.leaseToken ?? 'private-lease-token',
      leaseGeneration,
      leaseExpiresAt,
    },
    replay: options.replay ?? false,
  };
}

export function commitApiResponse({
  armRequest,
  commitRequest,
  awaitId = 'await-1',
  replay = false,
  alreadyWoken = false,
  state = alreadyWoken ? 'wake_pending' : 'suspended',
  sourceReceiptId = 'suspension-receipt-1',
} = {}) {
  return {
    v: 'hark.suspension-receipt.v2',
    awaitId,
    commitNonce: commitRequest.commitNonce,
    state,
    suspendedAt: SUSPENDED_AT,
    suspensionReceipt: {
      v: 'hark.runtime-receipt.v2',
      sourceReceiptId,
      kind: 'monitoring_task_suspended',
      observedAt: SUSPENDED_AT,
      origin: structuredClone(armRequest.origin),
      checkpointDigest: armRequest.checkpoint.digest,
    },
    alreadyWoken,
    replay,
  };
}
