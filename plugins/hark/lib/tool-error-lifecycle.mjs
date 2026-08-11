import { sha256Canonical } from './canonical.mjs';
import {
  assertArmApiResponse,
  assertCommitApiResponse,
} from './api-response-contracts.mjs';
import {
  assertArmAttemptInstallationFence,
  assertArmAttemptLocalClosure,
} from './tool-wait-protocol.mjs';

const TRANSIENT_STATUS = new Set([408, 425, 429]);
const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_object_required`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const result = object(value, label);
  const allowed = new Set(keys);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) throw new Error(`${label}_field_unsupported:${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(result, key)) throw new Error(`${label}_field_required:${key}`);
  }
  return result;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}_invalid`);
  }
  return value;
}

function responseEffectDigest(value) {
  const { replay: _replay, ...effect } = value;
  return sha256Canonical(effect);
}

export function isTransientToolLifecycleError(error, signal = undefined) {
  if (signal?.aborted || error?.name === 'AbortError') return false;
  return TRANSIENT_STATUS.has(error?.status)
    || error?.status >= 500
    || ['AbortError', 'TimeoutError'].includes(error?.name)
    || TRANSIENT_CODES.has(error?.code);
}

export function assertReconciledCancelApiResponse(value, awaitId) {
  const result = exactKeys(value, ['v', 'await', 'replay'], 'cancel_result');
  if (result.v !== 'hark.await-cancel-result.v2') {
    throw new Error('cancel_result_version_invalid');
  }
  const cancelled = exactKeys(
    result.await,
    ['id', 'state', 'cancelledAt'],
    'cancelled_await',
  );
  if (cancelled.id !== awaitId || cancelled.state !== 'cancelled') {
    throw new Error('cancel_result_state_mismatch');
  }
  timestamp(cancelled.cancelledAt, 'cancelled_at');
  if (typeof result.replay !== 'boolean') throw new Error('cancel_result_replay_invalid');
  return result;
}

export function createHeldCallCancelRequest(request) {
  return {
    v: 'hark.await-cancel.v2',
    requestId: `hkc_tool_error_${request.eventId.slice(4)}`,
    reason: 'codex_held_tool_failed_before_suspension',
  };
}

export function assertReconciledArmApiResponse(value, armRequest) {
  const initial = assertArmApiResponse(value, armRequest);
  return assertArmApiResponse(value, armRequest, {
    expectedReplay: initial.result.replay,
  });
}

export function assertReconciledCommitApiResponse(value, expected) {
  const initial = assertCommitApiResponse(value, expected);
  return assertCommitApiResponse(value, expected, {
    expectedReplay: initial.result.replay,
  });
}

export class HarkToolErrorLifecycle {
  constructor(options = {}) {
    this.protocol = options.protocol;
    this.service = options.serviceClient;
    this.readCredentials = typeof options.readCredentials === 'function'
      ? options.readCredentials
      : options.credentials
        ? async () => options.credentials
        : options.credentialsStore?.read
          ? () => options.credentialsStore.read()
          : null;
    this.clock = options.clock ?? (() => new Date());
    if (!this.protocol) throw new Error('tool_error_protocol_required');
  }

  async #installationFence(request, attempt, signal) {
    if (!this.readCredentials || typeof this.service?.getInstallationStatus !== 'function') {
      throw new Error('tool_error_installation_fence_required');
    }
    const credentials = await this.readCredentials();
    if (!credentials) throw new Error('hark_not_connected');
    const status = await this.service.getInstallationStatus({ signal });
    return assertArmAttemptInstallationFence(
      request,
      attempt,
      credentials.installation,
      status.installation,
    );
  }

  async #terminalize(request, input, clock = this.clock) {
    const published = await this.protocol.publishAwaitRequestTerminal(request, input, clock);
    await this.protocol.archiveAwaitRequest(request, published.awaitRequestTerminal);
    return published.awaitRequestTerminal;
  }

  async #replayArm(request, attempt, signal) {
    if (!this.service?.armAwait) throw new Error('tool_error_service_required');
    try {
      await this.#installationFence(request, attempt, signal);
      const replayed = assertReconciledArmApiResponse(
        await this.service.armAwait(attempt.armRequest, { signal }),
        attempt.armRequest,
      );
      if (replayed.armed.state !== 'armed') {
        await this.#installationFence(request, attempt, signal);
        const freeze = (await this.protocol.publishArmReconciliationFreeze(
          request,
          attempt,
          {
            responseEffectDigest: responseEffectDigest(replayed.result),
            remoteState: replayed.armed.state,
            replay: replayed.result.replay,
          },
          this.clock,
        )).armReconciliationFreeze;
        return {
          kind: 'owned',
          reason: 'remote_post_arm_state_without_commit_attempt',
          remoteState: replayed.armed.state,
          armReconciliationFreeze: freeze,
        };
      }
      await this.#installationFence(request, attempt, signal);
      const arm = await this.protocol.publishArmBinding(request, {
        awaitId: replayed.awaitId,
        preparationNonce: attempt.preparationNonce,
        checkpointDigest: attempt.checkpointDigest,
        bindingToken: attempt.bindingToken,
      });
      await this.#installationFence(request, attempt, signal);
      await this.protocol.publishTranscriptBoundary(
        request,
        arm.armBinding,
        attempt.transcriptBoundary,
      );
      return { kind: 'armed', armBinding: arm.armBinding };
    } catch (error) {
      if (isTransientToolLifecycleError(error, signal)) {
        return { kind: 'owned', reason: 'arm_reconciliation_pending' };
      }
      throw error;
    }
  }

  async #replayCommit(
    request,
    armAttempt,
    armBinding,
    waiterReady,
    commitAttempt,
    signal,
  ) {
    if (!this.service?.commitAwait) throw new Error('tool_error_service_required');
    try {
      await this.#installationFence(request, armAttempt, signal);
      const committed = assertReconciledCommitApiResponse(
        await this.service.commitAwait(
          armBinding.awaitId,
          commitAttempt.commitRequest,
          { signal },
        ),
        {
          awaitId: armBinding.awaitId,
          armRequest: armAttempt.armRequest,
          commitRequest: commitAttempt.commitRequest,
        },
      );
      await this.#installationFence(request, armAttempt, signal);
      const published = await this.protocol.publishSuspensionCommitted(
        request,
        armBinding,
        waiterReady,
        {
          suspensionReceiptId: committed.suspensionReceiptId,
          suspensionReceiptDigest: committed.suspensionReceiptDigest,
        },
      );
      return { kind: 'committed', suspensionCommitted: published.suspensionCommitted };
    } catch (error) {
      if (isTransientToolLifecycleError(error, signal)) {
        return { kind: 'owned', reason: 'commit_reconciliation_pending' };
      }
      throw error;
    }
  }

  async #cancel(
    request,
    attempt,
    armBinding,
    toolError,
    observation,
    cancelRequest,
    signal,
  ) {
    if (!this.service?.cancelAwait) throw new Error('tool_error_service_required');
    let result;
    try {
      await this.#installationFence(request, attempt, signal);
      result = assertReconciledCancelApiResponse(
        await this.service.cancelAwait(
          armBinding.awaitId,
          cancelRequest,
          { signal },
        ),
        armBinding.awaitId,
      );
    } catch (error) {
      if (isTransientToolLifecycleError(error, signal)) {
        return { kind: 'owned', reason: 'authoritative_cancel_pending' };
      }
      throw error;
    }
    await this.#installationFence(request, attempt, signal);
    let terminal;
    try {
      terminal = (await this.protocol.publishAwaitRequestTerminal(request, {
        awaitId: armBinding.awaitId,
        wakeId: null,
        disposition: 'remote_cancelled',
        terminalDigest: sha256Canonical({
          v: 'hark.tool-error-cancel.v1',
          cancelResult: result,
          toolErrorDigest: sha256Canonical(toolError),
          toolErrorObservationDigest: sha256Canonical(observation),
        }),
      }, () => new Date(result.await.cancelledAt))).awaitRequestTerminal;
    } catch (error) {
      if (error?.message !== 'await_request_terminal_conflict') throw error;
      terminal = await this.protocol.readAwaitRequestTerminal(request);
      if (!terminal) throw error;
    }
    if (
      terminal.disposition !== 'remote_cancelled'
      || terminal.awaitId !== armBinding.awaitId
      || terminal.wakeId !== null
    ) throw new Error('tool_error_cancel_terminal_mismatch');
    await this.#installationFence(request, attempt, signal);
    await this.protocol.archiveAwaitRequest(request, terminal);
    return { kind: 'released', reason: 'authoritatively_cancelled', terminal };
  }

  async reconcile(request, options = {}) {
    const attempt = await this.protocol.readArmAttempt(request);
    if (attempt) await this.#installationFence(request, attempt, options.signal);
    const existingTerminal = await this.protocol.readAwaitRequestTerminal(request);
    if (existingTerminal) {
      if (attempt) {
        const originAbortReceipt = await this.protocol.readHeldCallOriginAbortReceipt(
          request,
          attempt,
        );
        const reconciliationIntent = originAbortReceipt
          ? await this.protocol.readHeldCallReconciliationIntent(
            request,
            attempt,
            originAbortReceipt,
          )
          : null;
        const reconciliationApplied = reconciliationIntent
          ? await this.protocol.readHeldCallReconciliationApplied(
            request,
            reconciliationIntent,
          )
          : null;
        if (reconciliationIntent && !reconciliationApplied) {
          return {
            kind: 'owned',
            reason: 'terminal_reconciliation_pending',
            terminal: existingTerminal,
          };
        }
      }
      if (attempt) await this.#installationFence(request, attempt, options.signal);
      await this.protocol.archiveAwaitRequest(request, existingTerminal);
      return { kind: 'released', reason: 'already_terminal', terminal: existingTerminal };
    }
    const toolError = await this.protocol.readToolError(request);
    if (!toolError) return { kind: 'inactive', reason: 'tool_error_not_observed' };
    const observation = await this.protocol.readToolErrorObservation(request, toolError);
    if (!observation) return { kind: 'owned', reason: 'host_error_observation_pending' };

    if (!attempt) {
      const terminal = await this.#terminalize(request, {
        awaitId: null,
        wakeId: null,
        disposition: 'pre_arm_failed',
        terminalDigest: sha256Canonical({ toolError, observation }),
      }, () => new Date(toolError.observedAt));
      return { kind: 'released', reason: 'deterministic_pre_arm_failure', terminal };
    }

    const frozen = await this.protocol.readArmReconciliationFreeze(request, attempt);
    if (frozen) {
      return {
        kind: 'owned',
        reason: 'remote_post_arm_state_without_commit_attempt',
        remoteState: frozen.remoteState,
        armReconciliationFreeze: frozen,
      };
    }

    const originAbortReceipt = await this.protocol.readHeldCallOriginAbortReceipt(
      request,
      attempt,
    );
    if (originAbortReceipt) {
      const reconciliationIntent = await this.protocol.readHeldCallReconciliationIntent(
        request,
        attempt,
        originAbortReceipt,
      );
      if (reconciliationIntent) {
        return {
          kind: 'owned',
          reason: 'held_call_crash_reconciliation_authoritative',
        };
      }
    }

    let armBinding = await this.protocol.readArmBinding(request);
    if (!armBinding) {
      const replayed = await this.#replayArm(request, attempt, options.signal);
      if (replayed.kind !== 'armed') return replayed;
      armBinding = replayed.armBinding;
    }

    let transcriptBoundary = await this.protocol.readTranscriptBoundary(
      request,
      armBinding,
    );
    if (!transcriptBoundary) {
      await this.#installationFence(request, attempt, options.signal);
      transcriptBoundary = (await this.protocol.publishTranscriptBoundary(
        request,
        armBinding,
        attempt.transcriptBoundary,
        this.clock,
      )).transcriptBoundary;
    }
    assertArmAttemptLocalClosure(request, attempt, {
      armBinding,
      transcriptBoundary,
    });

    const waiterReady = await this.protocol.readWaiterReady(request, armBinding);
    let commitAttempt = waiterReady
      ? await this.protocol.readCommitAttempt(request, armBinding, waiterReady)
      : null;
    let transitionAuthority = await this.protocol.readHeldCallTransitionAuthority(
      request,
      attempt,
      { armBinding },
    );
    if (!transitionAuthority) {
      await this.#installationFence(request, attempt, options.signal);
      if (commitAttempt) {
        transitionAuthority = (await this.protocol.electHeldCallTransitionAuthority(
          request,
          attempt,
          {
            decision: 'commit',
            decisionRequest: commitAttempt.commitRequest,
            evidenceKind: 'waiter_ready',
            armBinding,
            waiterReady,
          },
          this.clock,
        )).transitionAuthority;
      } else {
        transitionAuthority = (await this.protocol.electHeldCallTransitionAuthority(
          request,
          attempt,
          {
            decision: 'cancel',
            decisionRequest: createHeldCallCancelRequest(request),
            evidenceKind: 'tool_error_observation',
            armBinding,
            toolError,
            toolErrorObservation: observation,
          },
          this.clock,
        )).transitionAuthority;
      }
    }
    if (transitionAuthority.decision === 'cancel') {
      if (commitAttempt) throw new Error('held_call_cancel_authority_commit_conflict');
      const cancelEvidence = { armBinding };
      if (transitionAuthority.evidence.kind === 'tool_error_observation') {
        cancelEvidence.toolError = toolError;
        cancelEvidence.toolErrorObservation = observation;
      } else if (transitionAuthority.evidence.kind === 'origin_abort') {
        const originAbortReceipt = await this.protocol.readHeldCallOriginAbortReceipt(
          request,
          attempt,
        );
        if (!originAbortReceipt) {
          throw new Error('held_call_cancel_authority_evidence_missing');
        }
        cancelEvidence.originAbortReceipt = originAbortReceipt;
      }
      await this.protocol.readHeldCallTransitionAuthority(
        request,
        attempt,
        cancelEvidence,
      );
      return this.#cancel(
        request,
        attempt,
        armBinding,
        toolError,
        observation,
        transitionAuthority.decisionRequest,
        options.signal,
      );
    }

    if (!waiterReady) throw new Error('held_call_commit_authority_waiter_missing');
    await this.protocol.readHeldCallTransitionAuthority(
      request,
      attempt,
      { armBinding, waiterReady },
    );
    if (!commitAttempt) {
      await this.#installationFence(request, attempt, options.signal);
      commitAttempt = (await this.protocol.publishCommitAttempt(
        request,
        armBinding,
        waiterReady,
        transitionAuthority.decisionRequest,
        this.clock,
      )).commitAttempt;
    }

    let committed = await this.protocol.readSuspensionCommitted(
      request,
      armBinding,
      waiterReady,
    );
    if (!committed) {
      const replayed = await this.#replayCommit(
        request,
        attempt,
        armBinding,
        waiterReady,
        commitAttempt,
        options.signal,
      );
      if (replayed.kind !== 'committed') return replayed;
      committed = replayed.suspensionCommitted;
    }
    return {
      kind: 'owned',
      reason: 'suspension_committed_recovery_required',
      suspensionCommitted: committed,
    };
  }
}
