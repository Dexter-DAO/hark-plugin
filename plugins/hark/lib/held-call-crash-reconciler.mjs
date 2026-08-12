import { sha256Canonical } from './canonical.mjs';
import {
  assertArmAttemptInstallationFence,
  assertArmAttemptLocalClosure,
  assertAwaitRequest,
  assertHeldCallReconciliationApplied,
  assertHeldCallReconciliationIntent,
  assertHeldCallOriginAbortReceipt,
  createHeldCallOriginAbortReceipt,
} from './tool-wait-protocol.mjs';
import {
  assertReconciledArmApiResponse,
  assertReconciledCancelApiResponse,
  assertReconciledCommitApiResponse,
  createHeldCallCancelRequest,
  isTransientToolLifecycleError,
} from './tool-error-lifecycle.mjs';

export { createHeldCallOriginAbortReceipt, assertHeldCallOriginAbortReceipt };

function responseEffectDigest(value) {
  const { replay: _replay, ...effect } = value;
  return sha256Canonical(effect);
}

function pending(error, signal, reason) {
  if (isTransientToolLifecycleError(error, signal)) return { kind: 'owned', reason };
  throw error;
}

function apiResponse(method, response) {
  return {
    method,
    digest: responseEffectDigest(response),
    replay: response.replay,
  };
}

function cancelTerminalDigest({ receipt, intent, result, armBinding, boundary, waiterReady }) {
  return sha256Canonical({
    v: 'hark.held-call-crash-cancel.v1',
    originAbortReceiptDigest: sha256Canonical(receipt),
    reconciliationIntentDigest: sha256Canonical(intent),
    cancelResultDigest: responseEffectDigest(result),
    armBindingDigest: sha256Canonical(armBinding),
    transcriptBoundaryDigest: sha256Canonical(boundary),
    waiterReadyDigest: sha256Canonical(waiterReady),
  });
}

/**
 * Reconciles only after a durable, positive App Server plus physical-rollout
 * owner-abort receipt. It never infers authority from time, liveness, absence,
 * or an unavailable runtime.
 */
export class HeldCallCrashReconciler {
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
    if (!this.protocol) throw new Error('held_call_reconciler_protocol_required');
  }

  async #installationFence(request, armAttempt, signal) {
    if (!this.readCredentials || typeof this.service?.getInstallationStatus !== 'function') {
      throw new Error('held_call_reconciler_installation_fence_required');
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

  async #persistAbortReceipt(request, armAttempt, supplied, signal) {
    if (supplied !== undefined && supplied !== null) {
      const receipt = assertHeldCallOriginAbortReceipt(supplied, request, armAttempt);
      await this.#installationFence(request, armAttempt, signal);
      return (await this.protocol.appendHeldCallOriginAbortReceipt(
        receipt,
        request,
        armAttempt,
      )).originAbortReceipt;
    }
    return this.protocol.readHeldCallOriginAbortReceipt(request, armAttempt);
  }

  async #records(request) {
    const armBinding = await this.protocol.readArmBinding(request);
    const transcriptBoundary = armBinding
      ? await this.protocol.readTranscriptBoundary(request, armBinding)
      : null;
    const waiterReady = armBinding
      ? await this.protocol.readWaiterReady(request, armBinding)
      : null;
    const commitAttempt = await this.protocol.readCommitAttempt(
      request,
      armBinding ?? undefined,
      waiterReady ?? undefined,
    );
    const suspensionCommitted = armBinding && waiterReady
      ? await this.protocol.readSuspensionCommitted(request, armBinding, waiterReady)
      : null;
    const terminal = await this.protocol.readAwaitRequestTerminal(request);
    return {
      armBinding,
      transcriptBoundary,
      waiterReady,
      commitAttempt,
      suspensionCommitted,
      terminal,
    };
  }

  #intentRecords(intent, records) {
    return {
      armBinding: intent.armBindingDigest === null ? null : records.armBinding,
      waiterReady: intent.waiterReadyDigest === null ? null : records.waiterReady,
      commitAttempt: intent.commitAttemptDigest === null ? null : records.commitAttempt,
    };
  }

  async #existingDisposition(request, armAttempt, intent, records, options) {
    const applied = await this.protocol.readHeldCallReconciliationApplied(request, intent);
    if (!applied) return null;
    assertHeldCallReconciliationApplied(
      applied,
      request,
      intent,
      intent.stage === 'commit' ? { ...records, terminal: null } : records,
    );
    if (applied.outcome === 'remote_cancelled') {
      await this.#installationFence(request, armAttempt, options.signal);
      await this.protocol.archiveAwaitRequest(request, records.terminal);
      return {
        kind: 'released',
        reason: 'already_authoritatively_cancelled',
        terminal: records.terminal,
        reconciliationApplied: applied,
      };
    }
    if (records.terminal) {
      if (records.terminal.disposition === 'remote_cancelled') {
        throw new Error('held_call_reconciliation_commit_terminal_conflict');
      }
      await this.#installationFence(request, armAttempt, options.signal);
      await this.protocol.archiveAwaitRequest(request, records.terminal);
      return {
        kind: 'released',
        reason: 'already_terminal_after_commit_reconciliation',
        terminal: records.terminal,
        suspensionCommitted: records.suspensionCommitted,
        reconciliationApplied: applied,
      };
    }
    return {
      kind: 'recovery_authorized',
      reason: 'already_suspension_committed_after_origin_abort',
      suspensionCommitted: records.suspensionCommitted,
      reconciliationApplied: applied,
    };
  }

  async #intent(
    request,
    armAttempt,
    receipt,
    intentInput,
    initial,
    existingIntent = null,
    options = {},
  ) {
    let intent = existingIntent;
    if (!intent) {
      try {
        await this.#installationFence(request, armAttempt, options.signal);
        intent = (await this.protocol.publishHeldCallReconciliationIntent(
          request,
          armAttempt,
          receipt,
          intentInput,
          this.clock,
        )).reconciliationIntent;
      } catch (error) {
        if (error?.message !== 'held_call_reconciliation_intent_conflict') throw error;
        intent = await this.protocol.readHeldCallReconciliationIntent(
          request,
          armAttempt,
          receipt,
        );
        if (!intent) throw error;
      }
    }
    if (intent.stage !== intentInput.stage) {
      throw new Error('held_call_reconciliation_intent_stage_conflict');
    }
    return assertHeldCallReconciliationIntent(
      intent,
      request,
      armAttempt,
      receipt,
      this.#intentRecords(intent, initial),
    );
  }

  async #armStage(request, armAttempt, receipt, initial, options, existingIntent = null) {
    if (existingIntent) {
      const already = await this.#existingDisposition(
        request,
        armAttempt,
        existingIntent,
        initial,
        options,
      );
      if (already) return already;
    }

    let armBinding = initial.armBinding;
    if (!armBinding) {
      if (!this.service?.armAwait) throw new Error('held_call_reconciler_service_required');
      let raw;
      try {
        await this.#installationFence(request, armAttempt, options.signal);
        raw = await this.service.armAwait(armAttempt.armRequest, { signal: options.signal });
      } catch (error) {
        return pending(error, options.signal, 'arm_reconciliation_pending');
      }
      const replayed = assertReconciledArmApiResponse(raw, armAttempt.armRequest);
      if (replayed.armed.state !== 'armed') {
        // A competing reconciler may have durably bound and cancelled this
        // exact arm before our replay response arrived. Only that terminal
        // cancellation can converge on the bound cancel path. Every other
        // post-arm state remains frozen: it grants no cancellation authority.
        const concurrentArmBinding = replayed.armed.state === 'cancelled'
          ? await this.protocol.readArmBinding(request)
          : null;
        if (concurrentArmBinding) {
          assertArmAttemptLocalClosure(request, armAttempt, {
            armBinding: concurrentArmBinding,
          });
          armBinding = concurrentArmBinding;
        } else {
          await this.#installationFence(request, armAttempt, options.signal);
          const freeze = (await this.protocol.publishArmReconciliationFreeze(
            request,
            armAttempt,
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
      } else {
        await this.#installationFence(request, armAttempt, options.signal);
        armBinding = (await this.protocol.publishArmBinding(request, {
          awaitId: replayed.awaitId,
          preparationNonce: armAttempt.preparationNonce,
          checkpointDigest: armAttempt.checkpointDigest,
          bindingToken: armAttempt.bindingToken,
        }, () => new Date(replayed.armed.armedAt))).armBinding;
      }
    }

    await this.#installationFence(request, armAttempt, options.signal);
    const transcriptBoundary = initial.transcriptBoundary
      ?? (await this.protocol.publishTranscriptBoundary(
        request,
        armBinding,
        armAttempt.transcriptBoundary,
        this.clock,
      )).transcriptBoundary;
    await this.#installationFence(request, armAttempt, options.signal);
    const waiterReady = initial.waiterReady
      ?? (await this.protocol.publishWaiterReady(
        request,
        armBinding,
        request.originalInput,
        this.clock,
      )).waiterReady;

    let commitAttempt = await this.protocol.readCommitAttempt(
      request,
      armBinding,
      waiterReady,
    );
    let transitionAuthority = await this.protocol.readHeldCallTransitionAuthority(
      request,
      armAttempt,
      { armBinding },
    );
    if (!transitionAuthority) {
      await this.#installationFence(request, armAttempt, options.signal);
      transitionAuthority = (await this.protocol.electHeldCallTransitionAuthority(
        request,
        armAttempt,
        commitAttempt
          ? {
            decision: 'commit',
            decisionRequest: commitAttempt.commitRequest,
            evidenceKind: 'waiter_ready',
            armBinding,
            waiterReady,
          }
          : {
            decision: 'cancel',
            decisionRequest: createHeldCallCancelRequest(request),
            evidenceKind: 'origin_abort',
            armBinding,
            originAbortReceipt: receipt,
          },
        this.clock,
      )).transitionAuthority;
    }

    if (transitionAuthority.decision === 'commit') {
      if (existingIntent?.stage === 'arm') {
        throw new Error('held_call_commit_authority_arm_intent_conflict');
      }
      await this.protocol.readHeldCallTransitionAuthority(
        request,
        armAttempt,
        { armBinding, waiterReady },
      );
      if (!commitAttempt) {
        await this.#installationFence(request, armAttempt, options.signal);
        commitAttempt = (await this.protocol.publishCommitAttempt(
          request,
          armBinding,
          waiterReady,
          transitionAuthority.decisionRequest,
          this.clock,
        )).commitAttempt;
      }
      return this.#commitStage(
        request,
        armAttempt,
        receipt,
        {
          ...initial,
          armBinding,
          transcriptBoundary,
          waiterReady,
          commitAttempt,
        },
        options,
        existingIntent,
      );
    }

    if (commitAttempt) throw new Error('held_call_cancel_authority_commit_conflict');
    if (existingIntent?.stage === 'commit') {
      throw new Error('held_call_cancel_authority_commit_intent_conflict');
    }
    const cancelEvidence = { armBinding };
    if (transitionAuthority.evidence.kind === 'origin_abort') {
      cancelEvidence.originAbortReceipt = receipt;
    } else if (transitionAuthority.evidence.kind === 'tool_error_observation') {
      const toolError = await this.protocol.readToolError(request);
      const observation = toolError
        ? await this.protocol.readToolErrorObservation(request, toolError)
        : null;
      if (!toolError || !observation) {
        throw new Error('held_call_cancel_authority_evidence_missing');
      }
      cancelEvidence.toolError = toolError;
      cancelEvidence.toolErrorObservation = observation;
    }
    await this.protocol.readHeldCallTransitionAuthority(
      request,
      armAttempt,
      cancelEvidence,
    );

    const intentInput = {
      stage: 'arm',
      armBinding,
      waiterReady,
      commitAttempt: null,
      remoteRequestDigest: armAttempt.armRequestDigest,
    };
    const intent = await this.#intent(
      request,
      armAttempt,
      receipt,
      intentInput,
      { ...initial, armBinding, waiterReady },
      existingIntent,
      options,
    );
    const already = await this.#existingDisposition(
      request,
      armAttempt,
      intent,
      { ...initial, armBinding, transcriptBoundary, waiterReady },
      options,
    );
    if (already) return already;

    if (!this.service?.cancelAwait) throw new Error('held_call_reconciler_service_required');
    let rawCancel;
    try {
      await this.#installationFence(request, armAttempt, options.signal);
      rawCancel = await this.service.cancelAwait(
        armBinding.awaitId,
        transitionAuthority.decisionRequest,
        { signal: options.signal },
      );
    } catch (error) {
      return pending(error, options.signal, 'cancel_reconciliation_pending');
    }
    const cancelled = assertReconciledCancelApiResponse(rawCancel, {
      awaitId: armBinding.awaitId,
      armRequest: armAttempt.armRequest,
      cancelRequest: transitionAuthority.decisionRequest,
    });
    let terminal = initial.terminal;
    if (!terminal) {
      try {
        await this.#installationFence(request, armAttempt, options.signal);
        terminal = (await this.protocol.publishAwaitRequestTerminal(
          request,
          {
            awaitId: armBinding.awaitId,
            wakeId: null,
            disposition: 'remote_cancelled',
            terminalDigest: cancelTerminalDigest({
              receipt,
              intent,
              result: cancelled,
              armBinding,
              boundary: transcriptBoundary,
              waiterReady,
            }),
          },
          () => new Date(cancelled.await.cancelledAt),
        )).awaitRequestTerminal;
      } catch (error) {
        if (error?.message !== 'await_request_terminal_conflict') throw error;
        terminal = await this.protocol.readAwaitRequestTerminal(request);
        if (!terminal) throw error;
      }
    }
    if (
      terminal.disposition !== 'remote_cancelled'
      || terminal.awaitId !== armBinding.awaitId
      || terminal.wakeId !== null
    ) throw new Error('held_call_reconciliation_cancel_terminal_mismatch');
    await this.#installationFence(request, armAttempt, options.signal);
    const applied = (await this.protocol.publishHeldCallReconciliationApplied(
      request,
      intent,
      {
        // The arm replay is only discovery. The one authoritative effect of
        // this reconciliation is cancellation, so this receipt stays
        // deterministic when a second reconciler starts after arm binding.
        apiResponses: [apiResponse('cancel', cancelled)],
        armBinding,
        transcriptBoundary,
        waiterReady,
        suspensionCommitted: null,
        terminal,
        outcome: 'remote_cancelled',
      },
      this.clock,
    )).reconciliationApplied;
    await this.#installationFence(request, armAttempt, options.signal);
    await this.protocol.archiveAwaitRequest(request, terminal);
    return {
      kind: 'released',
      reason: 'authoritatively_cancelled_after_origin_abort',
      terminal,
      reconciliationApplied: applied,
    };
  }

  async #commitStage(
    request,
    armAttempt,
    receipt,
    initial,
    options,
    existingIntent = null,
  ) {
    if (!initial.armBinding || !initial.waiterReady || !initial.commitAttempt) {
      return { kind: 'owned', reason: 'commit_reconciliation_context_incomplete' };
    }
    if (!initial.transcriptBoundary) {
      return { kind: 'owned', reason: 'commit_reconciliation_boundary_missing' };
    }
    let transitionAuthority = await this.protocol.readHeldCallTransitionAuthority(
      request,
      armAttempt,
      { armBinding: initial.armBinding },
    );
    if (!transitionAuthority) {
      await this.#installationFence(request, armAttempt, options.signal);
      transitionAuthority = (await this.protocol.electHeldCallTransitionAuthority(
        request,
        armAttempt,
        {
          decision: 'commit',
          decisionRequest: initial.commitAttempt.commitRequest,
          evidenceKind: 'waiter_ready',
          armBinding: initial.armBinding,
          waiterReady: initial.waiterReady,
        },
        this.clock,
      )).transitionAuthority;
    }
    if (transitionAuthority.decision !== 'commit') {
      throw new Error('held_call_cancel_authority_commit_conflict');
    }
    await this.protocol.readHeldCallTransitionAuthority(
      request,
      armAttempt,
      {
        armBinding: initial.armBinding,
        waiterReady: initial.waiterReady,
      },
    );
    if (
      transitionAuthority.decisionRequestDigest
      !== initial.commitAttempt.commitRequestDigest
    ) throw new Error('held_call_commit_authority_attempt_mismatch');
    const intentInput = {
      stage: 'commit',
      armBinding: initial.armBinding,
      waiterReady: initial.waiterReady,
      commitAttempt: initial.commitAttempt,
      remoteRequestDigest: initial.commitAttempt.commitRequestDigest,
    };
    const intent = await this.#intent(
      request,
      armAttempt,
      receipt,
      intentInput,
      initial,
      existingIntent,
      options,
    );
    const already = await this.#existingDisposition(
      request,
      armAttempt,
      intent,
      initial,
      options,
    );
    if (already) return already;

    if (!this.service?.commitAwait) throw new Error('held_call_reconciler_service_required');
    let raw;
    try {
      await this.#installationFence(request, armAttempt, options.signal);
      raw = await this.service.commitAwait(
        initial.armBinding.awaitId,
        initial.commitAttempt.commitRequest,
        { signal: options.signal },
      );
    } catch (error) {
      return pending(error, options.signal, 'commit_reconciliation_pending');
    }
    const committed = assertReconciledCommitApiResponse(raw, {
      awaitId: initial.armBinding.awaitId,
      armRequest: armAttempt.armRequest,
      commitRequest: initial.commitAttempt.commitRequest,
    });
    await this.#installationFence(request, armAttempt, options.signal);
    const suspensionCommitted = (await this.protocol.publishSuspensionCommitted(
      request,
      initial.armBinding,
      initial.waiterReady,
      {
        suspensionReceiptId: committed.suspensionReceiptId,
        suspensionReceiptDigest: committed.suspensionReceiptDigest,
      },
      () => new Date(committed.result.suspendedAt),
    )).suspensionCommitted;
    if (
      Date.parse(suspensionCommitted.committedAt)
        < Date.parse(committed.result.suspendedAt)
    ) throw new Error('held_call_reconciliation_commit_marker_timestamp_backdated');
    await this.#installationFence(request, armAttempt, options.signal);
    const applied = (await this.protocol.publishHeldCallReconciliationApplied(
      request,
      intent,
      {
        apiResponses: [apiResponse('commit', committed.result)],
        armBinding: initial.armBinding,
        transcriptBoundary: initial.transcriptBoundary,
        waiterReady: initial.waiterReady,
        suspensionCommitted,
        terminal: null,
        outcome: 'suspension_committed',
      },
      this.clock,
    )).reconciliationApplied;
    if (initial.terminal) {
      if (initial.terminal.disposition === 'remote_cancelled') {
        throw new Error('held_call_reconciliation_commit_terminal_conflict');
      }
      await this.#installationFence(request, armAttempt, options.signal);
      await this.protocol.archiveAwaitRequest(request, initial.terminal);
      return {
        kind: 'released',
        reason: 'terminal_archived_after_commit_reconciliation',
        terminal: initial.terminal,
        suspensionCommitted,
        reconciliationApplied: applied,
      };
    }
    return {
      kind: 'recovery_authorized',
      reason: 'suspension_committed_after_origin_abort',
      suspensionCommitted,
      reconciliationApplied: applied,
    };
  }

  async reconcile(requestValue, options = {}) {
    const request = assertAwaitRequest(requestValue);
    const armAttempt = await this.protocol.readArmAttempt(request);
    if (!armAttempt) return { kind: 'inactive', reason: 'arm_attempt_missing' };
    await this.#installationFence(request, armAttempt, options.signal);

    const receipt = await this.#persistAbortReceipt(
      request,
      armAttempt,
      options.originAbortReceipt,
      options.signal,
    );
    if (!receipt) return { kind: 'inactive', reason: 'origin_abort_receipt_required' };
    assertHeldCallOriginAbortReceipt(receipt, request, armAttempt);

    const records = await this.#records(request);
    assertArmAttemptLocalClosure(request, armAttempt, records);
    const existingIntent = await this.protocol.readHeldCallReconciliationIntent(
      request,
      armAttempt,
      receipt,
    );
    const armReconciliationFreeze = await this.protocol.readArmReconciliationFreeze(
      request,
      armAttempt,
    );
    let existingDisposition = null;
    if (existingIntent) {
      assertHeldCallReconciliationIntent(
        existingIntent,
        request,
        armAttempt,
        receipt,
        this.#intentRecords(existingIntent, records),
      );
      existingDisposition = await this.#existingDisposition(
        request,
        armAttempt,
        existingIntent,
        records,
        options,
      );
      if (existingDisposition) return existingDisposition;
    }
    if (!existingIntent) {
      const toolError = await this.protocol.readToolError(request);
      if (toolError) {
        const observation = await this.protocol.readToolErrorObservation(request, toolError);
        if (observation && !records.commitAttempt) {
          return {
            kind: 'owned',
            reason: 'tool_error_lifecycle_authoritative',
          };
        }
      }
    }
    if (
      armReconciliationFreeze
      && (
        !existingIntent
        || (
          existingIntent.stage === 'arm'
          && (
            armReconciliationFreeze.remoteState !== 'cancelled'
            || (!records.armBinding && !records.terminal)
          )
        )
      )
    ) {
      return {
        kind: 'owned',
        reason: 'remote_post_arm_state_without_commit_attempt',
        remoteState: armReconciliationFreeze.remoteState,
        armReconciliationFreeze,
      };
    }
    if (existingIntent) {
      if (
        existingIntent.stage === 'arm'
        && records.terminal
        && records.terminal.disposition !== 'remote_cancelled'
      ) {
        return {
          kind: 'owned',
          reason: 'arm_reconciliation_terminal_conflict',
        };
      }
      if (existingIntent.stage === 'commit') {
        return this.#commitStage(
          request,
          armAttempt,
          receipt,
          records,
          options,
          existingIntent,
        );
      }
      if (existingIntent.stage === 'arm' && records.commitAttempt) {
        return { kind: 'owned', reason: 'commit_attempt_after_arm_reconciliation' };
      }
      return this.#armStage(
        request,
        armAttempt,
        receipt,
        records,
        options,
        existingIntent,
      );
    }

    if (records.terminal && records.terminal.disposition !== 'remote_cancelled') {
      await this.#installationFence(request, armAttempt, options.signal);
      await this.protocol.archiveAwaitRequest(request, records.terminal);
      return { kind: 'released', reason: 'already_terminal', terminal: records.terminal };
    }

    if (records.commitAttempt) {
      return this.#commitStage(request, armAttempt, receipt, records, options);
    }
    if (records.suspensionCommitted) {
      return {
        kind: 'owned',
        reason: 'suspension_commit_attempt_linkage_missing',
      };
    }
    return this.#armStage(request, armAttempt, receipt, records, options);
  }
}
