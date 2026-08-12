import { canonicalJson, sha256Canonical } from './canonical.mjs';
import {
  createToolWaitResult,
  sanitizeWakeEnvelope,
  toolResultObservationSourceReceiptId,
} from './tool-wait-protocol.mjs';
import {
  inspectCodexToolWait,
  proveCodexToolWait,
} from './transcript-proof.mjs';

const SHA256 = /^[a-f0-9]{64}$/u;
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

function digest(value, label) {
  if (!SHA256.test(value ?? '')) throw new Error(`${label}_invalid`);
  return value;
}

function exact(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(`${label}_mismatch`);
}

function isTransient(error) {
  return error?.code === 'ENOENT' || TRANSIENT_PROOF_ERRORS.has(error?.message);
}

function dispatchBoundary(boundary) {
  return {
    v: 'hark.codex-rollout-boundary.v1',
    historySource: boundary.historySource,
    transcriptPath: boundary.transcriptPath,
    sessionId: boundary.conversationId,
    originTaskId: boundary.originTaskId,
    dev: boundary.dev,
    ino: boundary.ino,
    byteLength: boundary.byteLength,
    prefixSha256: boundary.prefixSha256,
  };
}

function preparedInput(prepared, armBinding) {
  const value = object(prepared, 'wake_prepared');
  if (
    value.v !== 'hark.await-prepared.v1'
    || value.preparationNonce !== armBinding.preparationNonce
    || value.wakePolicy !== 'resume'
    || value.qualificationDigest !== sha256Canonical({
      source: value.source,
      condition: value.condition,
    })
  ) throw new Error('held_recovery_prepared_binding_mismatch');
  return {
    request: value.request,
    name: value.name,
    source: value.source,
    condition: value.condition,
  };
}

export function createRecoveryToolResultReceipt({ runtimeId, wake, claim, request, returned, proof }) {
  const exactWake = object(wake, 'wake');
  const exactClaim = object(claim, 'claim');
  const exactRequest = object(request, 'await_request');
  const exactReturned = object(returned, 'tool_result_returned');
  const exactProof = object(proof, 'continuation_proof');
  const priorWakeDeliveryDigest = digest(
    exactClaim.priorWakeDeliveryDigest,
    'prior_wake_delivery_digest',
  );
  if (
    exactProof.v !== 'hark.codex-tool-wait-proof.v1'
    || exactProof.conversationId !== exactRequest.sessionId
    || exactProof.originTaskId !== exactRequest.turnId
    || exactProof.wakeTaskId !== exactRequest.turnId
    || exactProof.toolName !== exactRequest.toolName
    || exactProof.toolUseId !== exactRequest.toolUseId
    || exactProof.inputDigest !== exactRequest.originalInputDigest
    || exactProof.toolResultDigest !== exactReturned.resultDigest
    || exactProof.wakeDeliveryDigest !== priorWakeDeliveryDigest
    || exactReturned.wakeDeliveryDigest !== priorWakeDeliveryDigest
    || exactProof.waitingInferenceRecordCount !== 0
    || exactProof.interveningTaskIds?.length !== 0
    || exactProof.rollbackMarkerCount !== 0
    || exactProof.historyMutationCount !== 0
    || exactWake.wakeId !== exactReturned.wakeId
  ) throw new Error('held_recovery_proof_boundary_mismatch');
  if (!Number.isSafeInteger(exactClaim.leaseGeneration) || exactClaim.leaseGeneration < 1) {
    throw new Error('lease_generation_invalid');
  }
  return {
    v: 'hark.runtime-receipt.v2',
    sourceReceiptId: toolResultObservationSourceReceiptId(exactWake.wakeId),
    kind: 'tool_result_observed',
    observedAt: exactProof.scannedAt,
    origin: {
      protocol: 'codex',
      runtimeId: requiredString(runtimeId, 'runtime_id', 200),
      taskId: exactRequest.turnId,
      conversationId: exactRequest.sessionId,
    },
    checkpointDigest: exactReturned.checkpointDigest,
    wakeId: exactWake.wakeId,
    leaseToken: requiredString(exactClaim.leaseToken, 'lease_token'),
    leaseGeneration: exactClaim.leaseGeneration,
    toolResultObservation: {
      v: 'hark.tool-result-observed.v1',
      continuationMode: 'held_tool',
      observationMode: 'recovery_adoption',
      conversationId: exactRequest.sessionId,
      taskId: exactRequest.turnId,
      toolName: exactRequest.toolName,
      toolUseId: exactRequest.toolUseId,
      inputDigest: exactRequest.originalInputDigest,
      wakeDeliveryDigest: priorWakeDeliveryDigest,
      toolResultDigest: exactReturned.resultDigest,
    },
  };
}

/**
 * Resolves only the already-persisted held-call branch. It may reconstruct the
 * immutable local marker, but only after the exact result and terminal response
 * are proven in Codex's append-only rollout. It never dispatches a turn.
 */
export class HarkHeldCrashRecovery {
  constructor(options = {}) {
    this.protocol = options.protocol;
    this.service = options.serviceClient;
    this.runtimeId = requiredString(options.runtimeId, 'runtime_id', 200);
    this.proveToolWait = options.proveToolWait ?? proveCodexToolWait;
    this.inspectToolWait = options.inspectToolWait ?? inspectCodexToolWait;
    if (!this.protocol) throw new Error('held_recovery_protocol_required');
    if (!this.service) throw new Error('service_client_required');
  }

  async resolveContext(wakeValue) {
    const wake = object(wakeValue, 'wake');
    const origin = object(wake.origin, 'wake_origin');
    if (
      origin.protocol !== 'codex'
      || origin.runtimeId !== this.runtimeId
    ) throw new Error('held_recovery_origin_mismatch');
    const awaitId = requiredString(wake.awaitId, 'await_id');
    const requests = await this.protocol.listAwaitRequests();
    const matches = [];
    for (const request of requests) {
      const armBinding = await this.protocol.readArmBinding(request);
      if (armBinding?.awaitId === awaitId) matches.push({ request, armBinding });
    }
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new Error('held_recovery_local_await_ambiguous');
    const { request, armBinding } = matches[0];
    if (
      request.sessionId !== origin.conversationId
      || request.turnId !== origin.taskId
      || armBinding.checkpointDigest !== wake.checkpoint?.digest
    ) throw new Error('held_recovery_local_boundary_mismatch');
    exact(
      request.originalInput,
      preparedInput(wake.prepared, armBinding),
      'held_recovery_prepared_input',
    );
    const persistedBoundary = await this.protocol.readTranscriptBoundary(request, armBinding);
    if (!persistedBoundary) return null;
    if (
      persistedBoundary.awaitId !== awaitId
      || persistedBoundary.toolUseId !== request.toolUseId
      || persistedBoundary.inputDigest !== request.originalInputDigest
      || sha256Canonical(persistedBoundary.boundary) !== persistedBoundary.boundaryDigest
    ) throw new Error('held_recovery_transcript_boundary_mismatch');
    return {
      request,
      armBinding,
      persistedBoundary,
      dispatchBoundary: dispatchBoundary(persistedBoundary.boundary),
    };
  }

  async recoverWaiter({ wake }) {
    const context = await this.resolveContext(wake);
    if (!context) return { action: 'pending', reason: 'local_boundary_missing' };
    const delivery = await this.protocol.readWakeDelivery(
      context.request,
      context.armBinding,
    );
    if (!delivery) return { action: 'probe_origin', context, reason: 'held_waiter_lost' };
    if (
      delivery.awaitId !== wake.awaitId
      || delivery.wakeId !== wake.wakeId
      || delivery.checkpointDigest !== wake.checkpoint.digest
      || canonicalJson(delivery.wakeEnvelope) !== canonicalJson(sanitizeWakeEnvelope(wake))
    ) throw new Error('recover_waiter_local_delivery_conflict');
    const result = createToolWaitResult(delivery);
    const observationIntent = await this.protocol.readToolResultObservationIntent?.(
      delivery,
      result,
      context.persistedBoundary.boundary,
      this.runtimeId,
    );
    try {
      const inspection = await this.inspectToolWait(context.persistedBoundary.boundary, {
        toolResult: result,
        wakeDeliveryDigest: delivery.wakeDeliveryDigest,
        claimReference: observationIntent?.claimReference,
      });
      if (
        inspection.state === 'origin_aborted_before_result'
        || inspection.state === 'tool_result_then_aborted'
      ) return { action: 'fallback', context, inspection };
      if (
        inspection.state === 'waiting'
        || inspection.state === 'ambiguous_incomplete_tail'
        || inspection.state === 'tool_result_persisted'
      ) return { action: 'pending', context, reason: inspection.state, inspection };
      throw new Error(`recover_waiter_local_delivery_ineligible:${inspection.state}`);
    } catch (error) {
      if (!isTransient(error)) throw error;
      return { action: 'pending', context, reason: error.message };
    }
  }

  async #proveOrInspect(context, delivery, result) {
    const observationIntent = await this.protocol.readToolResultObservationIntent?.(
      delivery,
      result,
      context.persistedBoundary.boundary,
      this.runtimeId,
    );
    try {
      const proof = await this.proveToolWait(context.persistedBoundary.boundary, {
        toolResult: result,
        wakeDeliveryDigest: delivery.wakeDeliveryDigest,
        claimReference: observationIntent?.claimReference,
      });
      return { action: 'proved', proof };
    } catch (error) {
      if (!isTransient(error)) throw error;
      try {
        const inspection = await this.inspectToolWait(context.persistedBoundary.boundary, {
          toolResult: result,
          wakeDeliveryDigest: delivery.wakeDeliveryDigest,
          claimReference: observationIntent?.claimReference,
        });
        if (
          inspection.state === 'origin_aborted_before_result'
          || inspection.state === 'tool_result_then_aborted'
        ) return { action: 'fallback', inspection };
        return { action: 'pending', reason: inspection.state, inspection };
      } catch (inspectionError) {
        if (!isTransient(inspectionError)) throw inspectionError;
        return { action: 'pending', reason: inspectionError.message };
      }
    }
  }

  async recoverHeldTool({ wake: wakeValue, claim: claimValue }) {
    const wake = object(wakeValue, 'wake');
    const claim = object(claimValue, 'claim');
    if (claim.disposition !== 'recover_held_tool') {
      throw new Error('held_recovery_disposition_invalid');
    }
    if (!Number.isSafeInteger(claim.leaseGeneration) || claim.leaseGeneration < 1) {
      throw new Error('lease_generation_invalid');
    }
    const expectedDigest = digest(
      claim.priorWakeDeliveryDigest,
      'prior_wake_delivery_digest',
    );
    const context = await this.resolveContext(wake);
    if (!context) return { action: 'pending', reason: 'local_boundary_missing' };
    const delivery = await this.protocol.readWakeDelivery(
      context.request,
      context.armBinding,
    );
    if (!delivery) return { action: 'probe_origin', context, reason: 'wake_delivery_missing' };
    if (
      delivery.awaitId !== wake.awaitId
      || delivery.wakeId !== wake.wakeId
      || delivery.wakeDeliveryDigest !== expectedDigest
    ) throw new Error('held_recovery_delivery_digest_mismatch');
    const result = createToolWaitResult(delivery);
    let returned = await this.protocol.readToolResultReturned(delivery, result);
    if (returned && returned.wakeDeliveryDigest !== expectedDigest) {
      throw new Error('held_recovery_returned_digest_mismatch');
    }
    if (
      returned
      && sha256Canonical(returned.transcriptBoundary)
        !== context.persistedBoundary.boundaryDigest
    ) throw new Error('held_recovery_returned_boundary_conflict');
    const resolution = await this.#proveOrInspect(context, delivery, result);
    if (resolution.action !== 'proved') {
      return { ...resolution, context };
    }
    if (!returned) {
      const published = await this.protocol.publishToolResultReturned(
        delivery,
        result,
        {
          wakeDeliveryDigest: expectedDigest,
          transcriptBoundary: context.persistedBoundary.boundary,
        },
        () => new Date(resolution.proof.scannedAt),
      );
      returned = published.toolResultReturned;
    }
    if (await this.protocol.readCompletionPosted(returned)) {
      throw new Error('held_recovery_completed_wake_reclaimed');
    }
    const observation = createRecoveryToolResultReceipt({
      runtimeId: this.runtimeId,
      wake,
      claim,
      request: context.request,
      returned,
      proof: resolution.proof,
    });
    await this.service.recordRuntimeReceipt(wake.awaitId, observation);
    return {
      action: 'adopted',
      context,
      observation,
      proof: resolution.proof,
    };
  }
}
