import { sha256Canonical } from './canonical.mjs';
import { HarkPrivateClaimStore } from './private-claim-store.mjs';
import {
  abortableDelay,
  assertArmAttemptInstallationFence,
  assertToolResultObservationAck,
  createToolWaitResult,
  HarkToolWaitProtocol,
  materializeToolResultObservationReceipt,
  toolResultObservationSourceReceiptId,
  toolWaitCompletionSourceReceiptId,
} from './tool-wait-protocol.mjs';
import {
  inspectCodexToolWait,
  proveCodexToolWait,
} from './transcript-proof.mjs';
import { HarkToolErrorLifecycle } from './tool-error-lifecycle.mjs';
import { HeldCallCrashReconciler } from './held-call-crash-reconciler.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
const TOOL_RESULT_OBSERVATION_KEYS = [
  'v',
  'continuationMode',
  'observationMode',
  'conversationId',
  'taskId',
  'toolName',
  'toolUseId',
  'inputDigest',
  'wakeDeliveryDigest',
  'toolResultDigest',
];
const TOOL_WAIT_INSPECTION_KEYS = [
  'v',
  'historySource',
  'conversationId',
  'originTaskId',
  'toolUseId',
  'toolName',
  'inputDigest',
  'toolResultDigest',
  'rolloutToolOutputDigest',
  'state',
  'originTerminal',
  'incompleteTail',
  'inspectedAtByteLength',
  'historyDigest',
];
const RESULT_PERSISTED_STATES = new Set([
  'tool_result_persisted',
  'tool_result_then_aborted',
  'tool_result_turn_terminal',
]);
const PENDING_INSPECTION_STATES = new Set([
  'waiting',
  'ambiguous_incomplete_tail',
]);

const TRANSIENT_PROOF_ERRORS = new Set([
  'codex_tool_output_missing',
  'codex_tool_wait_turn_incomplete',
  'codex_rollout_incomplete_tail',
  'codex_rollout_unexpected_eof',
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_object_required`);
  }
  return value;
}

function requiredString(value, label, max = 512) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > max
  ) throw new Error(`${label}_invalid`);
  return value;
}

function exactKeys(value, expected, label) {
  const exact = object(value, label);
  const allowed = new Set(expected);
  for (const key of Object.keys(exact)) {
    if (!allowed.has(key)) throw new Error(`${label}_field_unsupported:${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(exact, key)) throw new Error(`${label}_field_required:${key}`);
  }
  return exact;
}

function digest(value, label) {
  if (!SHA256.test(value ?? '')) throw new Error(`${label}_invalid`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}_invalid`);
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function isTransient(error) {
  return error?.name === 'AbortError'
    || error?.code === 'ENOENT'
    || error?.code === 'EAGAIN'
    || error?.code === 'EBUSY'
    || error?.code === 'EINTR'
    || error?.code === 'EMFILE'
    || error?.code === 'ENFILE'
    || error?.code === 'ESTALE'
    || error?.code === 'ECONNRESET'
    || error?.code === 'ETIMEDOUT'
    || error?.status === 408
    || error?.status === 429
    || error?.status >= 500
    || TRANSIENT_PROOF_ERRORS.has(error?.message);
}

function assertCertificationIdentity(value, delivery, boundary, runtimeId) {
  const certification = object(value, 'await_certification');
  if (
    certification.v !== 'hark.await-certification.v2'
    || certification.awaitId !== delivery.awaitId
  ) throw new Error('await_certification_identity_invalid');
  const wake = object(certification.wake, 'await_certification_wake');
  if (
    wake.id !== delivery.wakeId
    || wake.awaitId !== delivery.awaitId
    || wake.heldDeliveryDigest !== delivery.wakeDeliveryDigest
  ) throw new Error('await_certification_wake_identity_invalid');
  const origin = object(certification.origin, 'await_certification_origin');
  const checkpoint = object(certification.checkpoint, 'await_certification_checkpoint');
  if (
    origin.protocol !== 'codex'
    || origin.runtimeId !== runtimeId
    || origin.conversationId !== boundary.conversationId
    || origin.taskId !== boundary.originTaskId
    || checkpoint.digest !== delivery.checkpointDigest
  ) throw new Error('await_certification_boundary_invalid');
  const continuation = object(
    certification.continuation,
    'await_certification_continuation',
  );
  return { certification, wake, continuation };
}

function assertObservation(value, boundary, delivery, resultDigest) {
  const observation = exactKeys(
    value,
    TOOL_RESULT_OBSERVATION_KEYS,
    'tool_result_observation',
  );
  if (
    observation.v !== 'hark.tool-result-observed.v1'
    || observation.continuationMode !== 'held_tool'
    || !['direct', 'recovery_adoption'].includes(observation.observationMode)
  ) throw new Error('tool_result_observation_mode_invalid');
  if (
    observation.conversationId !== boundary.conversationId
    || observation.taskId !== boundary.originTaskId
    || observation.toolName !== boundary.toolName
    || observation.toolUseId !== boundary.toolUseId
    || observation.toolUseId !== delivery.toolUseId
    || observation.inputDigest !== boundary.inputDigest
    || observation.wakeDeliveryDigest !== delivery.wakeDeliveryDigest
    || observation.toolResultDigest !== resultDigest
  ) throw new Error('tool_result_observation_boundary_mismatch');
  return observation;
}

function assertInspection(value, boundary, resultDigest) {
  const inspection = exactKeys(
    value,
    TOOL_WAIT_INSPECTION_KEYS,
    'tool_wait_inspection',
  );
  if (
    inspection.v !== 'hark.codex-tool-wait-inspection.v1'
    || inspection.historySource !== 'codex.rollout-jsonl.v1'
    || inspection.conversationId !== boundary.conversationId
    || inspection.originTaskId !== boundary.originTaskId
    || inspection.toolName !== boundary.toolName
    || inspection.toolUseId !== boundary.toolUseId
    || inspection.inputDigest !== boundary.inputDigest
    || inspection.toolResultDigest !== resultDigest
  ) throw new Error('tool_wait_inspection_boundary_mismatch');
  if (typeof inspection.incompleteTail !== 'boolean') {
    throw new Error('tool_wait_inspection_incomplete_tail_invalid');
  }
  if (!Number.isSafeInteger(inspection.inspectedAtByteLength)
    || inspection.inspectedAtByteLength < boundary.byteLength) {
    throw new Error('tool_wait_inspection_byte_length_invalid');
  }
  digest(inspection.historyDigest, 'tool_wait_inspection_history_digest');
  if (inspection.rolloutToolOutputDigest !== null) {
    digest(inspection.rolloutToolOutputDigest, 'rollout_tool_output_digest');
  }
  if (inspection.originTerminal !== null) {
    const terminal = exactKeys(
      inspection.originTerminal,
      ['type', 'reason', 'observedAt'],
      'tool_wait_origin_terminal',
    );
    if (!['turn_aborted', 'task_complete'].includes(terminal.type)) {
      throw new Error('tool_wait_origin_terminal_type_invalid');
    }
    requiredString(terminal.reason, 'tool_wait_origin_terminal_reason', 2000);
    timestamp(terminal.observedAt, 'tool_wait_origin_terminal_observed_at');
  }
  const terminalType = inspection.originTerminal?.type ?? null;
  const hasResult = inspection.rolloutToolOutputDigest !== null;
  const consistent = (
    (inspection.state === 'waiting'
      && !hasResult && terminalType === null && inspection.incompleteTail === false)
    || (inspection.state === 'ambiguous_incomplete_tail'
      && inspection.incompleteTail === true)
    || (inspection.state === 'origin_aborted_before_result'
      && !hasResult && terminalType === 'turn_aborted' && inspection.incompleteTail === false)
    || (inspection.state === 'origin_completed_without_result'
      && !hasResult && terminalType === 'task_complete' && inspection.incompleteTail === false)
    || (inspection.state === 'tool_result_persisted'
      && hasResult && terminalType === null && inspection.incompleteTail === false)
    || (inspection.state === 'tool_result_then_aborted'
      && hasResult && terminalType === 'turn_aborted' && inspection.incompleteTail === false)
    || (inspection.state === 'tool_result_turn_terminal'
      && hasResult && terminalType === 'task_complete' && inspection.incompleteTail === false)
  );
  if (!consistent) throw new Error('tool_wait_inspection_state_mismatch');
  return inspection;
}

function assertRecoveryProof(value, boundary, resultDigest) {
  const proof = assertInspection(value, boundary, resultDigest);
  if (
    proof.state !== 'origin_aborted_before_result'
    || proof.rolloutToolOutputDigest !== null
    || proof.incompleteTail !== false
    || proof.originTerminal?.type !== 'turn_aborted'
  ) throw new Error('tool_result_recovery_proof_invalid');
  return proof;
}

export function classifyToolResultObservationCertification(value, {
  delivery,
  persistedBoundary,
  result,
  runtimeId,
}) {
  const boundary = persistedBoundary.boundary;
  const resultDigest = sha256Canonical(result);
  const { certification, wake, continuation } = assertCertificationIdentity(
    value,
    delivery,
    boundary,
    runtimeId,
  );
  const observationCount = nonNegativeInteger(
    certification.toolResultObservationCount,
    'tool_result_observation_count',
  );
  const activeObservationCount = nonNegativeInteger(
    certification.activeToolResultObservationCount,
    'active_tool_result_observation_count',
  );
  const recoveryCount = nonNegativeInteger(
    certification.toolResultNotPersistedCount,
    'tool_result_not_persisted_count',
  );

  if (recoveryCount > 0) {
    if (
      recoveryCount !== 1
      || observationCount !== 1
      || activeObservationCount !== 0
      || continuation.mode !== 'crash_recovery'
      || continuation.toolResultObservation !== null
      || wake.deliveryMode !== 'crash_recovery'
    ) throw new Error('tool_result_recovery_handoff_ambiguous');
    requiredString(wake.state, 'tool_result_recovery_wake_state', 80);
    assertRecoveryProof(certification.toolResultRecoveryProof, boundary, resultDigest);
    if (certification.certified === true) {
      if (
        wake.state !== 'completed'
        || !Array.isArray(certification.reasons)
        || certification.reasons.length !== 0
        || certification.completionReceiptCount !== 1
        || !Number.isFinite(Date.parse(wake.completedAt))
      ) throw new Error('tool_result_recovery_completion_ambiguous');
      return { kind: 'recovery_complete', certification };
    }
    if (certification.certified !== false) {
      throw new Error('tool_result_recovery_certified_state_invalid');
    }
    return { kind: 'recovery_handoff' };
  }

  if (certification.toolResultRecoveryProof !== null) {
    throw new Error('tool_result_recovery_proof_unexpected');
  }
  if (
    continuation.mode !== 'held_tool'
    || wake.deliveryMode !== 'held_tool'
  ) throw new Error('tool_result_observation_delivery_state_invalid');
  if (observationCount === 0) {
    if (
      activeObservationCount !== 0
      || continuation.toolResultObservation !== null
    ) throw new Error('tool_result_observation_absence_ambiguous');
    requiredString(wake.state, 'tool_result_observation_wake_state', 80);
    return { kind: 'absent' };
  }
  if (observationCount !== 1 || activeObservationCount !== 1) {
    throw new Error('tool_result_observation_count_ambiguous');
  }
  const completedObservation = wake.state === 'completed'
    && certification.certified === true
    && Array.isArray(certification.reasons)
    && certification.reasons.length === 0
    && certification.completionReceiptCount === 1
    && Number.isFinite(Date.parse(wake.completedAt));
  if (wake.state !== 'running' && !completedObservation) {
    throw new Error('tool_result_observation_delivery_state_invalid');
  }
  const observation = assertObservation(
    continuation.toolResultObservation,
    boundary,
    delivery,
    resultDigest,
  );
  return { kind: 'observed', observation };
}

function createToolResultNotPersistedReceipt({
  runtimeId,
  delivery,
  boundary,
  inspection,
}) {
  const proof = assertRecoveryProof(
    inspection,
    boundary,
    inspection.toolResultDigest,
  );
  return {
    v: 'hark.runtime-receipt.v2',
    sourceReceiptId: `hrr_tool_result_not_persisted_${delivery.wakeId}`,
    kind: 'tool_result_not_persisted',
    observedAt: proof.originTerminal.observedAt,
    origin: {
      protocol: 'codex',
      runtimeId,
      taskId: boundary.originTaskId,
      conversationId: boundary.conversationId,
    },
    checkpointDigest: delivery.checkpointDigest,
    wakeId: delivery.wakeId,
    toolResultObservationSourceReceiptId: toolResultObservationSourceReceiptId(
      delivery.wakeId,
    ),
    recoveryProof: structuredClone(proof),
  };
}

function createToolResultContinuationAbortedReceipt({
  runtimeId,
  delivery,
  boundary,
  inspection,
}) {
  const proof = assertInspection(
    inspection,
    boundary,
    inspection.toolResultDigest,
  );
  if (
    proof.state !== 'tool_result_then_aborted'
    || !proof.rolloutToolOutputDigest
    || proof.incompleteTail !== false
    || proof.originTerminal?.type !== 'turn_aborted'
  ) throw new Error('tool_result_continuation_abort_proof_invalid');
  return {
    v: 'hark.runtime-receipt.v2',
    sourceReceiptId: `hrr_tool_result_continuation_aborted_${delivery.wakeId}`,
    kind: 'tool_result_continuation_aborted',
    observedAt: proof.originTerminal.observedAt,
    origin: {
      protocol: 'codex',
      runtimeId,
      taskId: boundary.originTaskId,
      conversationId: boundary.conversationId,
    },
    checkpointDigest: delivery.checkpointDigest,
    wakeId: delivery.wakeId,
    toolResultObservationSourceReceiptId: toolResultObservationSourceReceiptId(
      delivery.wakeId,
    ),
    recoveryProof: structuredClone(proof),
  };
}

function assertRecoveryReceiptResult(value, delivery, kind) {
  const result = object(value, 'tool_result_recovery_result');
  if (
    result.v !== 'hark.runtime-receipt-result.v2'
    || result.awaitId !== delivery.awaitId
    || result.kind !== kind
    || result.wakeState !== 'queued'
    || typeof result.replay !== 'boolean'
    || (result.replay === false && result.state !== 'wake_pending')
  ) throw new Error('tool_result_recovery_ack_mismatch');
  return result;
}

export function createHeldCompletionReceipt({
  runtimeId,
  delivery,
  returned,
  proof,
}) {
  const exactDelivery = object(delivery, 'wake_delivery');
  const exactReturned = object(returned, 'tool_result_returned');
  const exactProof = object(proof, 'continuation_proof');
  requiredString(runtimeId, 'runtime_id', 200);
  if (exactProof.v !== 'hark.codex-tool-wait-proof.v1') {
    throw new Error('continuation_proof_version_invalid');
  }
  if (
    exactProof.conversationId !== exactReturned.transcriptBoundary?.conversationId
    || exactProof.originTaskId !== exactReturned.transcriptBoundary?.originTaskId
    || exactProof.wakeTaskId !== exactProof.originTaskId
    || exactProof.toolName !== exactReturned.transcriptBoundary?.toolName
    || exactProof.toolUseId !== exactReturned.toolUseId
    || exactProof.inputDigest !== exactReturned.transcriptBoundary?.inputDigest
    || exactProof.toolResultDigest !== exactReturned.resultDigest
    || exactProof.wakeDeliveryDigest !== exactReturned.wakeDeliveryDigest
  ) throw new Error('continuation_proof_boundary_mismatch');
  if (
    exactDelivery.eventId !== exactReturned.eventId
    || exactDelivery.deliveryId !== exactReturned.deliveryId
    || exactDelivery.awaitId !== exactReturned.awaitId
    || exactDelivery.wakeId !== exactReturned.wakeId
  ) throw new Error('continuation_delivery_mismatch');
  return {
    v: 'hark.runtime-receipt.v2',
    sourceReceiptId: toolWaitCompletionSourceReceiptId(exactReturned.wakeId),
    kind: 'task_completed',
    observedAt: exactProof.scannedAt,
    origin: {
      protocol: 'codex',
      runtimeId,
      taskId: exactProof.originTaskId,
      conversationId: exactProof.conversationId,
    },
    checkpointDigest: exactReturned.checkpointDigest,
    wakeId: exactReturned.wakeId,
    toolResultObservationSourceReceiptId: toolResultObservationSourceReceiptId(
      exactReturned.wakeId,
    ),
    continuationProof: structuredClone(exactProof),
  };
}

/**
 * Finalizes normal held-tool waits after Codex has persisted the exact tool
 * output and the assistant response in the same turn. It never dispatches a
 * turn and never retains the consumed waiter credential.
 */
export class HarkHeldWaitCertifier {
  constructor(options = {}) {
    this.protocol = options.protocol ?? new HarkToolWaitProtocol(options.dataDir);
    this.service = options.serviceClient;
    if (!this.service) throw new Error('service_client_required');
    this.claimStore = options.claimStore ?? new HarkPrivateClaimStore(
      options.dataDir ?? this.protocol.dataDir,
    );
    this.runtimeId = requiredString(options.runtimeId, 'runtime_id', 200);
    this.readCredentials = typeof options.readCredentials === 'function'
      ? options.readCredentials
      : options.credentials
        ? async () => options.credentials
        : options.credentialsStore?.read
          ? () => options.credentialsStore.read()
          : null;
    this.proveToolWait = options.proveToolWait ?? proveCodexToolWait;
    this.inspectToolWait = options.inspectToolWait ?? inspectCodexToolWait;
    this.toolErrorLifecycle = options.toolErrorLifecycle ?? new HarkToolErrorLifecycle({
      protocol: this.protocol,
      serviceClient: this.service,
      credentials: options.credentials,
      credentialsStore: options.credentialsStore,
      readCredentials: options.readCredentials,
    });
    this.crashReconciler = options.crashReconciler ?? new HeldCallCrashReconciler({
      protocol: this.protocol,
      serviceClient: this.service,
      credentials: options.credentials,
      credentialsStore: options.credentialsStore,
      readCredentials: options.readCredentials,
      clock: options.clock,
    });
    if (typeof this.crashReconciler?.reconcile !== 'function') {
      throw new Error('held_call_crash_reconciler_invalid');
    }
    this.clock = options.clock ?? (() => new Date());
    this.originAbortProofProvider = options.originAbortProofProvider ?? null;
    if (
      this.originAbortProofProvider !== null
      && typeof this.originAbortProofProvider !== 'function'
    ) throw new Error('origin_abort_proof_provider_invalid');
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    if (
      !Number.isInteger(this.pollIntervalMs)
      || this.pollIntervalMs < 25
      || this.pollIntervalMs > 60_000
    ) throw new Error('held_wait_certifier_poll_interval_invalid');
    this.logger = options.logger ?? { info() {}, warn() {}, error() {} };
  }

  async #installationFence(request, armAttempt, signal) {
    if (!this.readCredentials || typeof this.service?.getInstallationStatus !== 'function') {
      throw new Error('held_wait_certifier_installation_fence_required');
    }
    const credentials = await this.readCredentials();
    if (!credentials) throw new Error('hark_not_connected');
    const status = await this.service.getInstallationStatus({ signal });
    return assertArmAttemptInstallationFence(
      request,
      armAttempt,
      credentials.installation,
      status.installation,
    );
  }

  setOriginAbortProofProvider(provider) {
    if (typeof provider !== 'function') throw new Error('origin_abort_proof_provider_invalid');
    if (this.originAbortProofProvider && this.originAbortProofProvider !== provider) {
      throw new Error('origin_abort_proof_provider_already_set');
    }
    this.originAbortProofProvider = provider;
  }

  async reconcileHeldCallCrash(request, options = {}) {
    const armAttempt = await this.protocol.readArmAttempt(request);
    if (armAttempt) await this.#installationFence(request, armAttempt, options.signal);
    let originAbortReceipt = armAttempt
      ? await this.protocol.readHeldCallOriginAbortReceipt(request, armAttempt)
      : null;
    let originAbortProof = options.originAbortProof ?? null;
    if (
      armAttempt
      && !originAbortReceipt
      && !originAbortProof
      && this.originAbortProofProvider
    ) {
      originAbortProof = await this.originAbortProofProvider(request, armAttempt, {
        signal: options.signal,
      });
    }
    if (armAttempt && !originAbortReceipt && originAbortProof) {
      await this.#installationFence(request, armAttempt, options.signal);
      const published = await this.protocol.publishHeldCallOriginAbortReceipt(
        request,
        armAttempt,
        originAbortProof,
        this.clock,
      );
      originAbortReceipt = published.originAbortReceipt;
    }
    const disposition = await this.crashReconciler.reconcile(request, {
      ...(originAbortReceipt ? { originAbortReceipt } : {}),
      signal: options.signal,
    });
    if (!['inactive', 'owned', 'released', 'recovery_authorized'].includes(
      disposition?.kind,
    )) throw new Error('held_call_crash_reconciliation_disposition_invalid');
    return { ...disposition, originAbortReceipt };
  }

  async #resolveObservationIntent(delivery, result, persistedBoundary, fence) {
    const intent = await this.protocol.readToolResultObservationIntent?.(
      delivery,
      result,
      persistedBoundary.boundary,
      this.runtimeId,
    );
    if (!intent) return { kind: 'legacy' };
    await fence();
    const certification = await this.service.certifyAwait(delivery.awaitId);
    const remote = classifyToolResultObservationCertification(certification, {
      delivery,
      persistedBoundary,
      result,
      runtimeId: this.runtimeId,
    });
    const claim = await this.claimStore.resolve(intent.claimReference, intent.binding);
    if (remote.kind === 'observed') {
      if (claim.state === 'pending') {
        await fence();
        await this.claimStore.consume(intent.claimReference, intent.binding);
      }
      return remote;
    }
    if (remote.kind !== 'absent') return remote;
    if (claim.state === 'consumed') {
      throw new Error('consumed_private_claim_without_remote_observation');
    }
    const receipt = materializeToolResultObservationReceipt(intent, claim);
    let response;
    try {
      await fence();
      response = await this.service.recordRuntimeReceipt(delivery.awaitId, receipt);
    } catch (error) {
      const code = error?.code ?? error?.message;
      if (
        code === 'wake_lease_stale'
        || code === 'runtime_lifecycle_receipt_already_recorded'
        || code === 'runtime_receipt_replay_conflict'
      ) return { kind: 'pending' };
      throw error;
    }
    assertToolResultObservationAck(response, intent);
    await fence();
    await this.claimStore.consume(intent.claimReference, intent.binding);
    return { kind: 'observed', observation: intent.publicReceipt.toolResultObservation };
  }

  async #recoverMissingReturned(
    delivery,
    result,
    persistedBoundary,
    originAbortReceipt,
    fence,
  ) {
    await fence();
    const certification = await this.service.certifyAwait(delivery.awaitId);
    const remote = classifyToolResultObservationCertification(certification, {
      delivery,
      persistedBoundary,
      result,
      runtimeId: this.runtimeId,
    });
    if (remote.kind === 'recovery_handoff') {
      return { kind: 'pending' };
    }
    if (remote.kind === 'recovery_complete') return remote;

    let observationIntent = null;
    if (remote.kind === 'absent') {
      observationIntent = await this.protocol.readToolResultObservationIntent?.(
        delivery,
        result,
        persistedBoundary.boundary,
        this.runtimeId,
      );
      if (!observationIntent) return { kind: 'pending' };
    }

    const boundary = persistedBoundary.boundary;
    const inspection = assertInspection(
      await this.inspectToolWait(boundary, { toolResult: result }),
      boundary,
      sha256Canonical(result),
    );
    if (PENDING_INSPECTION_STATES.has(inspection.state)) return { kind: 'pending' };
    if (remote.kind === 'absent') {
      if (!['tool_result_persisted', 'tool_result_turn_terminal'].includes(inspection.state)) {
        return { kind: 'pending' };
      }
      if (!inspection.rolloutToolOutputDigest) {
        throw new Error('tool_wait_inspection_result_digest_missing');
      }
      await fence();
      const published = await this.protocol.publishToolResultReturned(
        delivery,
        result,
        {
          wakeDeliveryDigest: delivery.wakeDeliveryDigest,
          transcriptBoundary: boundary,
        },
      );
      return { kind: 'returned', returned: published.toolResultReturned };
    }
    if (RESULT_PERSISTED_STATES.has(inspection.state)) {
      if (!inspection.rolloutToolOutputDigest) {
        throw new Error('tool_wait_inspection_result_digest_missing');
      }
      await fence();
      const published = await this.protocol.publishToolResultReturned(
        delivery,
        result,
        {
          wakeDeliveryDigest: delivery.wakeDeliveryDigest,
          transcriptBoundary: boundary,
        },
      );
      return { kind: 'returned', returned: published.toolResultReturned };
    }
    if (inspection.state === 'origin_aborted_before_result') {
      if (!originAbortReceipt) return { kind: 'pending' };
      const receipt = createToolResultNotPersistedReceipt({
        runtimeId: this.runtimeId,
        delivery,
        boundary,
        inspection,
      });
      await fence();
      assertRecoveryReceiptResult(
        await this.service.recordRuntimeReceipt(delivery.awaitId, receipt),
        delivery,
        receipt.kind,
      );
      return { kind: 'pending' };
    }
    throw new Error(`tool_wait_inspection_state_ineligible:${inspection.state}`);
  }

  async #recordTerminalAndArchive(request, {
    awaitId,
    wakeId,
    disposition,
    terminalValue,
    observedAt,
  }, armAttempt, signal) {
    if (armAttempt) await this.#installationFence(request, armAttempt, signal);
    const published = await this.protocol.publishAwaitRequestTerminal(request, {
      awaitId,
      wakeId,
      disposition,
      terminalDigest: sha256Canonical(terminalValue),
    }, () => new Date(observedAt));
    if (armAttempt) await this.#installationFence(request, armAttempt, signal);
    await this.protocol.archiveAwaitRequest(request, published.awaitRequestTerminal);
  }

  async #reconcileRequest(request, options = {}) {
    const armAttempt = await this.protocol.readArmAttempt(request);
    const fence = armAttempt
      ? () => this.#installationFence(request, armAttempt, options.signal)
      : async () => undefined;
    if (armAttempt) await fence();
    if (typeof this.protocol.readToolError === 'function') {
      const toolErrorDisposition = await this.toolErrorLifecycle.reconcile(request, options);
      if (toolErrorDisposition.kind === 'released') return 'skipped';
    }
    const crashDisposition = await this.reconcileHeldCallCrash(request, options);
    if (crashDisposition.kind === 'released') return 'skipped';
    if (crashDisposition.kind === 'owned') return 'pending';
    const arm = await this.protocol.readArmBinding(request);
    if (!arm) return 'pending';
    const persistedBoundary = await this.protocol.readTranscriptBoundary(request, arm);
    if (!persistedBoundary) return 'pending';
    const delivery = await this.protocol.readWakeDelivery(request, arm);
    if (!delivery) return 'pending';
    const result = createToolWaitResult(delivery);
    if (
      sha256Canonical(persistedBoundary.boundary) !== persistedBoundary.boundaryDigest
    ) throw new Error('tool_result_transcript_boundary_conflict');
    let returned = await this.protocol.readToolResultReturned(delivery, result);
    if (!returned) {
      const recovered = await this.#recoverMissingReturned(
        delivery,
        result,
        persistedBoundary,
        crashDisposition.originAbortReceipt,
        fence,
      );
      if (recovered.kind === 'pending') return 'pending';
      if (recovered.kind === 'recovery_complete') {
        await this.#recordTerminalAndArchive(request, {
          awaitId: delivery.awaitId,
          wakeId: delivery.wakeId,
          disposition: 'crash_recovery_completed',
          terminalValue: recovered.certification,
          observedAt: recovered.certification.wake.completedAt,
        }, armAttempt, options.signal);
        return 'skipped';
      }
      returned = recovered.returned;
    }
    if (
      sha256Canonical(returned.transcriptBoundary)
      !== persistedBoundary.boundaryDigest
    ) throw new Error('tool_result_transcript_boundary_conflict');
    const observation = await this.#resolveObservationIntent(
      delivery,
      result,
      persistedBoundary,
      fence,
    );
    if (observation.kind === 'pending' || observation.kind === 'recovery_handoff') {
      return 'pending';
    }
    if (observation.kind === 'recovery_complete') {
      await this.#recordTerminalAndArchive(request, {
        awaitId: delivery.awaitId,
        wakeId: delivery.wakeId,
        disposition: 'crash_recovery_completed',
        terminalValue: observation.certification,
        observedAt: observation.certification.wake.completedAt,
      }, armAttempt, options.signal);
      return 'skipped';
    }
    const existingCompletion = await this.protocol.readCompletionPosted(returned);
    if (existingCompletion) {
      await this.#recordTerminalAndArchive(request, {
        awaitId: returned.awaitId,
        wakeId: returned.wakeId,
        disposition: 'completion_posted',
        terminalValue: existingCompletion,
        observedAt: existingCompletion.postedAt,
      }, armAttempt, options.signal);
      return 'skipped';
    }

    let proof;
    try {
      proof = await this.proveToolWait(returned.transcriptBoundary, {
        toolResult: result,
        wakeDeliveryDigest: returned.wakeDeliveryDigest,
      });
    } catch (error) {
      if (!isTransient(error)) throw error;
      const inspection = assertInspection(
        await this.inspectToolWait(returned.transcriptBoundary, { toolResult: result }),
        returned.transcriptBoundary,
        returned.resultDigest,
      );
      if (PENDING_INSPECTION_STATES.has(inspection.state)
        || inspection.state === 'tool_result_persisted') return 'pending';
      const receipt = inspection.state === 'origin_aborted_before_result'
        ? crashDisposition.originAbortReceipt && createToolResultNotPersistedReceipt({
          runtimeId: this.runtimeId,
          delivery,
          boundary: returned.transcriptBoundary,
          inspection,
        })
        : inspection.state === 'tool_result_then_aborted'
          ? crashDisposition.originAbortReceipt && createToolResultContinuationAbortedReceipt({
            runtimeId: this.runtimeId,
            delivery,
            boundary: returned.transcriptBoundary,
            inspection,
          })
          : null;
      if (!receipt) throw error;
      await fence();
      assertRecoveryReceiptResult(
        await this.service.recordRuntimeReceipt(returned.awaitId, receipt),
        delivery,
        receipt.kind,
      );
      return 'pending';
    }
    const receipt = createHeldCompletionReceipt({
      runtimeId: this.runtimeId,
      delivery,
      returned,
      proof,
    });
    await fence();
    await this.service.recordRuntimeReceipt(returned.awaitId, receipt);
    await fence();
    const certification = object(
      await this.service.certifyAwait(returned.awaitId),
      'await_certification',
    );
    if (
      certification.v !== 'hark.await-certification.v2'
      || certification.awaitId !== returned.awaitId
    ) throw new Error('await_certification_identity_invalid');
    if (
      certification.certified !== true
      || certification.continuation?.mode !== 'held_tool'
    ) {
      const reasons = Array.isArray(certification.reasons)
        ? certification.reasons.join(',')
        : 'unknown';
      throw new Error(`held_wait_certification_failed:${reasons}`);
    }
    await fence();
    const completion = await this.protocol.publishCompletionPosted(returned, {
      sourceReceiptId: receipt.sourceReceiptId,
      proofDigest: sha256Canonical(proof),
      certificationDigest: sha256Canonical(certification),
    }, () => new Date(proof.scannedAt));
    await this.#recordTerminalAndArchive(request, {
      awaitId: returned.awaitId,
      wakeId: returned.wakeId,
      disposition: 'completion_posted',
      terminalValue: completion.completionPosted,
      observedAt: completion.completionPosted.postedAt,
    }, armAttempt, options.signal);
    return 'posted';
  }

  async reconcile(options = {}) {
    const summary = { posted: 0, skipped: 0, pending: 0, failed: 0, errors: [] };
    const requests = await this.protocol.listAwaitRequests();
    for (const request of requests) {
      try {
        const disposition = await this.#reconcileRequest(request, options);
        summary[disposition] += 1;
      } catch (error) {
        const disposition = isTransient(error) ? 'pending' : 'failed';
        summary[disposition] += 1;
        summary.errors.push({
          eventId: request.eventId,
          transient: disposition === 'pending',
          error: error?.message ?? String(error),
        });
      }
    }
    return summary;
  }

  async poll(signal) {
    while (!signal?.aborted) {
      let summary;
      try {
        summary = await this.reconcile({ signal });
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') break;
        if (!isTransient(error)) throw error;
        this.logger.warn?.(
          { error: error?.message ?? String(error) },
          'Hark held wait spool poll failed transiently',
        );
        await abortableDelay(this.pollIntervalMs, signal, {
          label: 'held_wait_certifier_poll',
          rejectOnAbort: false,
          unref: true,
        });
        continue;
      }
      for (const failure of summary.errors) {
        const method = failure.transient ? 'warn' : 'error';
        this.logger[method]?.(
          { eventId: failure.eventId, error: failure.error },
          failure.transient
            ? 'Hark held wait is not ready for final certification'
            : 'Hark held wait certification failed closed',
        );
      }
      if (summary.failed > 0) {
        throw new AggregateError(
          summary.errors
            .filter((failure) => !failure.transient)
            .map((failure) => new Error(`${failure.eventId}:${failure.error}`)),
          'held_wait_certification_failed_closed',
        );
      }
      if (!signal?.aborted) {
        await abortableDelay(this.pollIntervalMs, signal, {
          label: 'held_wait_certifier_poll',
          rejectOnAbort: false,
          unref: true,
        });
      }
    }
  }
}
