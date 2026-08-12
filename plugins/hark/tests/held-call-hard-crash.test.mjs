import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { canonicalJson, sha256Canonical } from '../lib/canonical.mjs';
import { HeldCallCrashReconciler } from '../lib/held-call-crash-reconciler.mjs';
import { HarkHeldCrashRecovery } from '../lib/held-crash-recovery.mjs';
import { HarkHeldWaitCertifier } from '../lib/held-wait-certifier.mjs';
import { HarkHookInbox } from '../lib/hook-inbox.mjs';
import { HarkJournal } from '../lib/journal.mjs';
import { HarkPrivateClaimStore } from '../lib/private-claim-store.mjs';
import { HarkServiceClient } from '../lib/service-client.mjs';
import { HarkToolErrorLifecycle } from '../lib/tool-error-lifecycle.mjs';
import {
  createAdmissionLocatorInput,
  createHeldCallOriginAbortReceipt,
  createToolWaitResult,
  HarkToolWaitProtocol,
} from '../lib/tool-wait-protocol.mjs';
import {
  preflightCodexWaitHistory,
  proveCodexWaitHistory,
} from '../lib/transcript-proof.mjs';
import { HarkCodexSupervisor } from '../lib/supervisor.mjs';
import { evaluatePromptGuard } from '../hooks/prompt-guard.mjs';
import {
  armApiResponse,
  commitApiResponse,
} from './api-response-fixtures.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL_WAIT_PROTOCOL_URL = pathToFileURL(
  path.join(PLUGIN_ROOT, 'lib/tool-wait-protocol.mjs'),
).href;
const SERVICE_CLIENT_URL = pathToFileURL(
  path.join(PLUGIN_ROOT, 'lib/service-client.mjs'),
).href;
const API_CONTRACTS_URL = pathToFileURL(
  path.join(PLUGIN_ROOT, 'lib/api-response-contracts.mjs'),
).href;
const CANONICAL_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib/canonical.mjs')).href;
const MCP_SERVER_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'mcp/server.mjs')).href;
const HOOK_INGRESS_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'hooks/ingress.mjs')).href;
const HELD_WAIT_CERTIFIER_URL = pathToFileURL(
  path.join(PLUGIN_ROOT, 'lib/held-wait-certifier.mjs'),
).href;
const HELD_CALL_RECONCILER_URL = pathToFileURL(
  path.join(PLUGIN_ROOT, 'lib/held-call-crash-reconciler.mjs'),
).href;
const TOOL_ERROR_LIFECYCLE_URL = pathToFileURL(
  path.join(PLUGIN_ROOT, 'lib/tool-error-lifecycle.mjs'),
).href;
const HELD_CRASH_RECOVERY_URL = pathToFileURL(
  path.join(PLUGIN_ROOT, 'lib/held-crash-recovery.mjs'),
).href;
const HOOK_INBOX_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib/hook-inbox.mjs')).href;
const JOURNAL_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib/journal.mjs')).href;
const SUPERVISOR_URL = pathToFileURL(path.join(PLUGIN_ROOT, 'lib/supervisor.mjs')).href;
const TRANSCRIPT_PROOF_URL = pathToFileURL(
  path.join(PLUGIN_ROOT, 'lib/transcript-proof.mjs'),
).href;
const TEST_ACCESS_TOKEN = 'hard-crash-test-access-token';
const TEST_ACCESS_TOKEN_B = 'hard-crash-test-access-token-b';
const TARGET_INSTALLATION_ID = '11111111-1111-4111-8111-111111111111';
const REPLACEMENT_INSTALLATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_AWAIT_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_WAKE_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';

const CHILD_SOURCE = String.raw`
  import { createHash } from 'node:crypto';
  import { appendFile, open, readFile, stat, writeFile } from 'node:fs/promises';
  import path from 'node:path';

  const scenario = process.env.HARK_CRASH_SCENARIO;
  const dataDir = process.env.HARK_CRASH_DATA_DIR;
  const apiBaseUrl = process.env.HARK_CRASH_API_URL;
  const accessToken = process.env.HARK_CRASH_ACCESS_TOKEN;
  const installation = JSON.parse(process.env.HARK_CRASH_INSTALLATION_JSON);
  const activeCredentials = { apiBaseUrl, accessToken, installation };
  const credentialsStore = {
    async read() { return structuredClone(activeCredentials); },
  };
  const { canonicalJson, sha256Canonical } = await import(process.env.HARK_CANONICAL_URL);
  const {
    HarkToolWaitProtocol,
    assertArmAttemptInstallationFence,
    createToolWaitResult,
  } = await import(process.env.HARK_TOOL_WAIT_PROTOCOL_URL);
  const { HarkServiceClient } = await import(process.env.HARK_SERVICE_CLIENT_URL);
  const {
    assertArmApiResponse,
    assertCommitApiResponse,
  } = await import(process.env.HARK_API_CONTRACTS_URL);

  const emit = (stage, extra = {}) => {
    process.stdout.write(canonicalJson({ stage, pid: process.pid, ...extra }) + '\n');
  };
  const hold = () => {
    process.stdin.resume();
    return new Promise(() => {});
  };
  const releaseGate = () => new Promise((resolve) => {
    process.stdin.once('data', resolve);
    process.stdin.resume();
  });
  const transitionGatedProtocol = (protocol) => {
    if (process.env.HARK_TRANSITION_AUTHORITY_GATE !== '1') return protocol;
    return new Proxy(protocol, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property !== 'electHeldCallTransitionAuthority') return value.bind(target);
        return async (...args) => {
          emit('transition_authority_contender_ready', {
            contender: process.env.HARK_TRANSITION_AUTHORITY_CONTENDER ?? 'reconciler',
          });
          await releaseGate();
          const openatPad = Number(process.env.HARK_TRANSITION_OPENAT_PAD ?? 0);
          for (let index = 0; index < openatPad; index += 1) {
            const handle = await open('/dev/null', 'r');
            await handle.close();
          }
          const result = await value.apply(target, args);
          emit('transition_authority_contender_elected', {
            contender: process.env.HARK_TRANSITION_AUTHORITY_CONTENDER ?? 'reconciler',
            created: result.created,
            decision: result.transitionAuthority.decision,
          });
          return result;
        };
      },
    });
  };

  if (process.env.HARK_CRASH_ROLE === 'transition_commit_contender') {
    const protocol = transitionGatedProtocol(new HarkToolWaitProtocol(dataDir));
    const service = new HarkServiceClient({
      baseUrl: apiBaseUrl,
      accessToken,
      allowInsecureLoopback: true,
      timeoutMs: 60_000,
    });
    const request = JSON.parse(process.env.HARK_RECONCILE_REQUEST_JSON);
    const attempt = await protocol.readArmAttempt(request);
    const armBinding = await protocol.readArmBinding(request);
    const waiterReady = await protocol.readWaiterReady(request, armBinding);
    const status = await service.getInstallationStatus();
    assertArmAttemptInstallationFence(
      request,
      attempt,
      installation,
      status.installation,
    );
    const decisionRequest = {
      v: 'hark.suspension-commit.v2',
      commitNonce: 'hkc_' + 'r'.repeat(32),
      checkpointDigest: armBinding.checkpointDigest,
    };
    const election = await protocol.electHeldCallTransitionAuthority(
      request,
      attempt,
      {
        decision: 'commit',
        decisionRequest,
        evidenceKind: 'waiter_ready',
        armBinding,
        waiterReady,
      },
      () => new Date('2026-08-07T12:00:02.000Z'),
    );
    if (election.transitionAuthority.decision !== 'commit') {
      emit('transition_commit_contender_obeyed', {
        decision: election.transitionAuthority.decision,
      });
      process.exit(0);
    }
    const commitAttempt = (await protocol.publishCommitAttempt(
      request,
      armBinding,
      waiterReady,
      election.transitionAuthority.decisionRequest,
      () => new Date('2026-08-07T12:00:02.000Z'),
    )).commitAttempt;
    emit('transition_remote_action_start', { decision: 'commit' });
    const committedResult = await service.commitAwait(
      armBinding.awaitId,
      commitAttempt.commitRequest,
    );
    const committed = assertCommitApiResponse(
      committedResult,
      {
        awaitId: armBinding.awaitId,
        armRequest: attempt.armRequest,
        commitRequest: commitAttempt.commitRequest,
      },
      { expectedReplay: committedResult.replay },
    );
    await protocol.publishSuspensionCommitted(
      request,
      armBinding,
      waiterReady,
      {
        suspensionReceiptId: committed.suspensionReceiptId,
        suspensionReceiptDigest: committed.suspensionReceiptDigest,
      },
      () => new Date('2026-08-07T12:00:03.000Z'),
    );
    emit('transition_commit_contender_complete', { decision: 'commit' });
    process.exit(0);
  }

  if (process.env.HARK_CRASH_ROLE === 'transition_cancel_contender') {
    const protocol = transitionGatedProtocol(new HarkToolWaitProtocol(dataDir));
    const service = new HarkServiceClient({
      baseUrl: apiBaseUrl,
      accessToken,
      allowInsecureLoopback: true,
      timeoutMs: 60_000,
    });
    const { createHeldCallCancelRequest } = await import(
      process.env.HARK_TOOL_ERROR_LIFECYCLE_URL
    );
    const request = JSON.parse(process.env.HARK_RECONCILE_REQUEST_JSON);
    const attempt = await protocol.readArmAttempt(request);
    const armBinding = await protocol.readArmBinding(request);
    const waiterReady = await protocol.readWaiterReady(request, armBinding);
    const toolError = await protocol.readToolError(request);
    const toolErrorObservation = await protocol.readToolErrorObservation(request, toolError);
    const status = await service.getInstallationStatus();
    assertArmAttemptInstallationFence(
      request,
      attempt,
      installation,
      status.installation,
    );
    const election = await protocol.electHeldCallTransitionAuthority(
      request,
      attempt,
      {
        decision: 'cancel',
        decisionRequest: createHeldCallCancelRequest(request),
        evidenceKind: 'tool_error_observation',
        armBinding,
        toolError,
        toolErrorObservation,
      },
      () => new Date('2026-08-07T12:00:02.000Z'),
    );
    if (election.transitionAuthority.decision === 'cancel') {
      emit('transition_remote_action_start', { decision: 'cancel' });
      await service.cancelAwait(
        armBinding.awaitId,
        election.transitionAuthority.decisionRequest,
      );
      emit('transition_cancel_contender_complete', { decision: 'cancel' });
      process.exit(0);
    }
    const commitAttempt = (await protocol.publishCommitAttempt(
      request,
      armBinding,
      waiterReady,
      election.transitionAuthority.decisionRequest,
      () => new Date('2026-08-07T12:00:02.000Z'),
    )).commitAttempt;
    emit('transition_remote_action_start', { decision: 'commit' });
    const committedResult = await service.commitAwait(
      armBinding.awaitId,
      commitAttempt.commitRequest,
    );
    const committed = assertCommitApiResponse(
      committedResult,
      {
        awaitId: armBinding.awaitId,
        armRequest: attempt.armRequest,
        commitRequest: commitAttempt.commitRequest,
      },
      { expectedReplay: committedResult.replay },
    );
    await protocol.publishSuspensionCommitted(
      request,
      armBinding,
      waiterReady,
      {
        suspensionReceiptId: committed.suspensionReceiptId,
        suspensionReceiptDigest: committed.suspensionReceiptDigest,
      },
      () => new Date('2026-08-07T12:00:03.000Z'),
    );
    emit('transition_cancel_contender_complete', { decision: 'commit' });
    process.exit(0);
  }

  if (process.env.HARK_CRASH_ROLE === 'installation_post_tool_error') {
    const protocol = transitionGatedProtocol(new HarkToolWaitProtocol(dataDir));
    const service = new HarkServiceClient({
      baseUrl: apiBaseUrl,
      accessToken,
      allowInsecureLoopback: true,
      timeoutMs: 60_000,
    });
    const { handleCodexHook } = await import(process.env.HARK_HOOK_INGRESS_URL);
    const hookInput = JSON.parse(process.env.HARK_HOOK_INPUT_JSON);
    try {
      const result = await handleCodexHook(hookInput, {
        protocol,
        serviceClient: service,
        credentials: activeCredentials,
        credentialsStore,
        dataDir,
        clock: () => new Date('2026-08-07T12:00:15.000Z'),
      });
      emit('installation_tool_error_complete', { result });
    } catch (error) {
      emit('installation_tool_error_rejected', {
        error: error?.message ?? String(error),
        cause: error?.cause?.message ?? null,
      });
    }
    process.exit(0);
  }

  if (process.env.HARK_CRASH_ROLE === 'legacy_supervisor') {
    const { EventEmitter } = await import('node:events');
    const { HarkJournal } = await import(process.env.HARK_JOURNAL_URL);
    const { HarkCodexSupervisor } = await import(process.env.HARK_SUPERVISOR_URL);
    class CompatibilityAppServer extends EventEmitter {
      async start() { return { codexHome: dataDir }; }
      async close() {}
      async readConfig() {
        return { config: { features: { current_time_reminder: { clock_source: 'system' } } } };
      }
    }
    const service = new HarkServiceClient({
      baseUrl: apiBaseUrl,
      accessToken,
      allowInsecureLoopback: true,
      timeoutMs: 60_000,
    });
    const journal = new HarkJournal(dataDir);
    const supervisor = new HarkCodexSupervisor({
      appServerClientFactory: () => new CompatibilityAppServer(),
      serviceClient: service,
      credentialsStore,
      journal,
      runtimeId: installation.runtimeId,
      installation,
      now: () => new Date('2026-08-07T12:00:20.000Z'),
    });
    try {
      await supervisor.start({ poll: false });
      const state = await journal.read();
      emit('legacy_supervisor_complete', {
        preparations: state.preparations,
        awaits: state.awaits,
      });
      await supervisor.stop();
    } catch (error) {
      emit('legacy_supervisor_rejected', {
        error: error?.message ?? String(error),
        cause: error?.cause?.message ?? null,
      });
    }
    process.exit(0);
  }

  if (process.env.HARK_CRASH_ROLE === 'reconciler') {
    const protocol = transitionGatedProtocol(new HarkToolWaitProtocol(dataDir));
    const service = new HarkServiceClient({
      baseUrl: apiBaseUrl,
      accessToken,
      allowInsecureLoopback: true,
      timeoutMs: 60_000,
    });
    const failpoint = process.env.HARK_RECONCILE_FAILPOINT;
    const trip = async (phase, label) => {
      if (failpoint !== phase + ':' + label) return;
      emit('reconciler_' + phase + '_' + label);
      await hold();
    };
    const protocolLabels = new Map([
      ['appendHeldCallOriginAbortReceipt', 'abort_receipt'],
      ['electHeldCallTransitionAuthority', 'transition_authority'],
      ['publishHeldCallReconciliationIntent', 'intent'],
      ['publishArmReconciliationFreeze', 'arm_reconciliation_freeze'],
      ['publishArmBinding', 'arm_binding'],
      ['publishTranscriptBoundary', 'transcript_boundary'],
      ['publishWaiterReady', 'waiter_ready'],
      ['publishCommitAttempt', 'commit_attempt'],
      ['publishSuspensionCommitted', 'suspension_marker'],
      ['publishAwaitRequestTerminal', 'terminal'],
      ['publishHeldCallReconciliationApplied', 'applied'],
      ['archiveAwaitRequest', 'archive'],
    ]);
    const wrappedProtocol = new Proxy(protocol, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        const label = protocolLabels.get(property);
        if (!label) return value.bind(target);
        return async (...args) => {
          await trip('before', label);
          const result = await value.apply(target, args);
          await trip('after', label);
          return result;
        };
      },
    });
    const wrappedService = new Proxy(service, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        const operation = property === 'armAwait'
          ? 'arm'
          : property === 'cancelAwait'
            ? 'cancel'
            : property === 'commitAwait'
              ? 'commit'
              : null;
        if (!operation) return value.bind(target);
        return async (...args) => {
          await trip('before', operation + '_request');
          const result = await value.apply(target, args);
          await trip('after', operation + '_response');
          return result;
        };
      },
    });
    const { HeldCallCrashReconciler } = await import(
      process.env.HARK_HELD_CALL_RECONCILER_URL
    );
    const reconciler = new HeldCallCrashReconciler({
      protocol: wrappedProtocol,
      serviceClient: wrappedService,
      credentials: activeCredentials,
      credentialsStore,
      readCredentials: () => credentialsStore.read(),
      clock: () => new Date('2026-08-07T12:00:13.000Z'),
    });
    const request = JSON.parse(process.env.HARK_RECONCILE_REQUEST_JSON);
    const receipt = process.env.HARK_RECONCILE_RECEIPT_JSON
      ? JSON.parse(process.env.HARK_RECONCILE_RECEIPT_JSON)
      : null;
    try {
      const disposition = await reconciler.reconcile(request, {
        ...(receipt ? { originAbortReceipt: receipt } : {}),
      });
      emit('reconcile_complete', { kind: disposition.kind, reason: disposition.reason });
    } catch (error) {
      emit('reconcile_rejected', {
        error: error?.message ?? String(error),
        cause: error?.cause?.message ?? null,
      });
    }
    process.exit(0);
  }

  if (process.env.HARK_CRASH_ROLE === 'terminal_archiver') {
    const protocol = new HarkToolWaitProtocol(dataDir);
    const request = JSON.parse(process.env.HARK_RECONCILE_REQUEST_JSON);
    const terminalInput = JSON.parse(process.env.HARK_TERMINAL_INPUT_JSON);
    const published = await protocol.publishAwaitRequestTerminal(
      request,
      terminalInput,
      () => new Date('2026-08-07T12:00:20.000Z'),
    );
    emit('crash_recovery_terminal_durable', {
      terminal: published.awaitRequestTerminal,
    });
    await hold();
    await protocol.archiveAwaitRequest(request, published.awaitRequestTerminal);
    emit('crash_recovery_request_archived');
    process.exit(0);
  }

  if (process.env.HARK_CRASH_ROLE === 'tool_error_lifecycle') {
    const protocol = transitionGatedProtocol(new HarkToolWaitProtocol(dataDir));
    const rawService = new HarkServiceClient({
      baseUrl: apiBaseUrl,
      accessToken,
      allowInsecureLoopback: true,
      timeoutMs: 60_000,
    });
    const service = process.env.HARK_TRANSITION_AUTHORITY_GATE === '1'
      ? new Proxy(rawService, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          if (!['commitAwait', 'cancelAwait'].includes(property)) return value.bind(target);
          return async (...args) => {
            emit('transition_remote_action_start', {
              decision: property === 'commitAwait' ? 'commit' : 'cancel',
            });
            return value.apply(target, args);
          };
        },
      })
      : rawService;
    const { HarkToolErrorLifecycle } = await import(
      process.env.HARK_TOOL_ERROR_LIFECYCLE_URL
    );
    const lifecycle = new HarkToolErrorLifecycle({
      protocol,
      serviceClient: service,
      credentials: activeCredentials,
      credentialsStore,
      readCredentials: () => credentialsStore.read(),
    });
    const request = JSON.parse(process.env.HARK_RECONCILE_REQUEST_JSON);
    try {
      const disposition = await lifecycle.reconcile(request);
      emit('tool_error_lifecycle_complete', {
        kind: disposition.kind,
        reason: disposition.reason,
      });
    } catch (error) {
      emit('tool_error_lifecycle_rejected', {
        error: error?.message ?? String(error),
        cause: error?.cause?.message ?? null,
      });
    }
    process.exit(0);
  }

  if (process.env.HARK_CRASH_ROLE === 'tool_error_writer') {
    const protocol = new HarkToolWaitProtocol(dataDir);
    const request = JSON.parse(process.env.HARK_RECONCILE_REQUEST_JSON);
    const toolError = (await protocol.publishToolError(request, {
      failureCode: 'arm_outcome_ambiguous',
      errorDigest: 'd'.repeat(64),
    }, () => new Date('2026-08-07T12:00:14.000Z'))).toolError;
    emit('bare_tool_error_durable');
    await hold();
    await protocol.publishToolErrorObservation(
      request,
      toolError,
      { responseDigest: 'f'.repeat(64) },
      () => new Date('2026-08-07T12:00:15.000Z'),
    );
    emit('tool_error_observation_durable');
    process.exit(0);
  }

  if (process.env.HARK_CRASH_ROLE === 'targeted_supervisor') {
    const { EventEmitter } = await import('node:events');
    const { HarkHeldWaitCertifier } = await import(
      process.env.HARK_HELD_WAIT_CERTIFIER_URL
    );
    const { HarkHeldCrashRecovery } = await import(
      process.env.HARK_HELD_CRASH_RECOVERY_URL
    );
    const { HarkHookInbox } = await import(process.env.HARK_HOOK_INBOX_URL);
    const { HarkJournal } = await import(process.env.HARK_JOURNAL_URL);
    const { HarkCodexSupervisor } = await import(process.env.HARK_SUPERVISOR_URL);
    const {
      preflightCodexWaitHistory,
      proveCodexWaitHistory,
    } = await import(process.env.HARK_TRANSCRIPT_PROOF_URL);

    const protocol = new HarkToolWaitProtocol(dataDir);
    const requests = await protocol.listAwaitRequests();
    if (requests.length !== 1) throw new Error('targeted_request_count_invalid');
    const [request] = requests;
    const journal = new HarkJournal(dataDir);
    const hookInbox = new HarkHookInbox(dataDir);
    const service = new HarkServiceClient({
      baseUrl: apiBaseUrl,
      accessToken,
      allowInsecureLoopback: true,
      timeoutMs: 60_000,
    });
    const failpoint = process.env.HARK_TARGET_FAILPOINT;
    const wrappedService = new Proxy(service, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (property !== 'claimCrashRecovery') return value.bind(target);
        return async (...args) => {
          const result = await value.apply(target, args);
          if (failpoint === 'after_claim_response') {
            emit('targeted_claim_response_received', {
              replay: result.replay,
              recoveryProofDigest: result.claim.recoveryProofDigest,
            });
            await hold();
          }
          return result;
        };
      },
    });

    const hostedTurnPath = path.join(dataDir, 'targeted-hosted-turn.json');
    const hostedTurnOwnerPath = path.join(dataDir, 'targeted-hosted-turn.owner');
    const thread = {
      id: request.sessionId,
      sessionId: request.sessionId,
      parentThreadId: null,
      canAcceptDirectInput: null,
      status: { type: 'idle' },
      path: request.transcriptPath,
      turns: [{
        id: request.turnId,
        status: 'interrupted',
        startedAt: 1_786_086_000,
        completedAt: 1_786_086_010,
        items: [],
        error: { message: 'owner_process_sigkill' },
      }],
    };
    const syncHostedTurn = async () => {
      let hosted;
      try {
        hosted = JSON.parse(await readFile(hostedTurnPath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      if (!thread.turns.some((candidate) => candidate.id === hosted.id)) {
        thread.turns.push(hosted);
      }
      return hosted;
    };
    let startedTurn = null;
    class TargetedAppServer extends EventEmitter {
      async start() { return { codexHome: dataDir }; }
      async close() {}
      async readConfig() {
        return { config: { features: { current_time_reminder: { clock_source: 'system' } } } };
      }
      async listLoadedThreads() { return { data: [thread.id], nextCursor: null }; }
      async readThread(threadId) {
        if (threadId !== thread.id) throw new Error('targeted_thread_mismatch');
        await syncHostedTurn();
        return { thread: structuredClone(thread) };
      }
      async resumeThread(threadId) {
        if (threadId !== thread.id) throw new Error('targeted_thread_mismatch');
        await syncHostedTurn();
        return { thread: structuredClone(thread) };
      }
      async unsubscribeThread() {}
      async startTurn(threadId, prompt, options) {
        if (threadId !== thread.id) throw new Error('targeted_thread_mismatch');
        const turn = {
          id: 'targeted-crash-recovery-turn',
          status: 'inProgress',
          startedAt: 1_786_086_020,
          items: [{
            id: 'targeted-crash-recovery-message',
            type: 'userMessage',
            clientId: options.clientUserMessageId,
            content: [{ type: 'text', text: prompt }],
          }],
          error: null,
        };
        const admissions = (await hookInbox.listWakeAdmissions()).filter((candidate) => (
          candidate.sessionId === threadId
          && candidate.promptDigest === sha256Canonical(prompt)
        ));
        if (admissions.length !== 1) throw new Error('targeted_wake_admission_missing');
        let created = false;
        try {
          await writeFile(hostedTurnOwnerPath, canonicalJson({ pid: process.pid }) + '\n', {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          });
          created = true;
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
        }
        if (created) {
          await appendFile(request.transcriptPath, [
            {
              timestamp: '2026-08-07T12:00:19.000Z',
              type: 'turn_context',
              payload: { turn_id: turn.id },
            },
            {
              timestamp: '2026-08-07T12:00:20.000Z',
              type: 'event_msg',
              payload: {
                type: 'task_complete',
                turn_id: turn.id,
                last_agent_message: 'Recovered release 42 after the origin process was killed.',
                time_to_first_token_ms: 1,
              },
            },
          ].map((entry) => JSON.stringify(entry) + '\n').join(''));
          await writeFile(hostedTurnPath, canonicalJson(turn) + '\n', {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
          });
        }
        let exactTurn = created ? turn : await syncHostedTurn();
        const deadline = Date.now() + 5_000;
        while (!exactTurn && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          exactTurn = await syncHostedTurn();
        }
        if (!exactTurn) throw new Error('targeted_hosted_turn_missing');
        await hookInbox.acknowledgeWakeAdmission(admissions[0], {
          turnId: exactTurn.id,
          transcriptPath: admissions[0].transcriptPath,
        });
        if (!thread.turns.some((candidate) => candidate.id === exactTurn.id)) {
          thread.turns.push(exactTurn);
        }
        startedTurn = exactTurn;
        if (created) emit('targeted_turn_start', { turnId: exactTurn.id });
        return { turn: structuredClone(exactTurn) };
      }
    }

    const actualCertifier = new HarkHeldWaitCertifier({
      protocol,
      serviceClient: wrappedService,
      dataDir,
      runtimeId: 'hard-crash-runtime',
      credentials: activeCredentials,
      credentialsStore,
      readCredentials: () => credentialsStore.read(),
      clock: () => new Date('2026-08-07T12:00:20.000Z'),
    });
    const certifier = {
      protocol,
      setOriginAbortProofProvider(provider) {
        actualCertifier.setOriginAbortProofProvider(provider);
      },
      reconcileHeldCallCrash(...args) {
        return actualCertifier.reconcileHeldCallCrash(...args);
      },
      async poll(signal) {
        if (signal?.aborted) return;
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
    };
    const heldRecovery = new HarkHeldCrashRecovery({
      protocol,
      serviceClient: wrappedService,
      runtimeId: 'hard-crash-runtime',
    });
    const transcriptProof = {
      preflight(boundary, { scannedAt }) {
        return preflightCodexWaitHistory(boundary, { scannedAt: new Date(scannedAt) });
      },
      prove(boundary, { wakeTaskId, scannedAt }) {
        return proveCodexWaitHistory(boundary, {
          wakeTaskId,
          scannedAt: new Date(scannedAt),
        });
      },
    };
    const supervisor = new HarkCodexSupervisor({
      appServerClientFactory: () => new TargetedAppServer(),
      serviceClient: wrappedService,
      journal,
      hookInbox,
      heldRecovery,
      heldWaitCertifier: certifier,
      transcriptProof,
      runtimeId: 'hard-crash-runtime',
      installation: {
        ...installation,
      },
      credentialsStore,
      now: () => new Date('2026-08-07T12:00:20.000Z'),
      pollWaitSeconds: 0,
      heldCrashRecoveryPollIntervalMs: 60_000,
      hookPollIntervalMs: 25,
    });
    supervisor.on('supervisorError', (error) => {
      emit('targeted_supervisor_error', { error: error.message });
    });
    await supervisor.start({ poll: true });
    emit('targeted_supervisor_started');
    const targetWakeId = process.env.HARK_TARGET_WAKE_ID;
    const deadline = Date.now() + 10_000;
    let wakeRecord = null;
    while (Date.now() < deadline) {
      supervisor.assertHealthy();
      wakeRecord = (await journal.read()).wakes[targetWakeId] ?? null;
      if (['submitted', 'dispatched', 'running'].includes(wakeRecord?.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!['submitted', 'dispatched', 'running'].includes(wakeRecord?.state)) {
      throw new Error('targeted_dispatch_timeout');
    }
    if (wakeRecord?.state === 'submitted' && startedTurn) {
      await supervisor.observeTurnStarted({ threadId: thread.id, turn: startedTurn });
      await supervisor.drain();
      wakeRecord = (await journal.read()).wakes[targetWakeId] ?? null;
    }
    emit('targeted_dispatch_complete', {
      wakeId: wakeRecord.wake.wakeId,
      leaseGeneration: wakeRecord.claim.leaseGeneration,
      recoveryProofDigest: wakeRecord.claim.recoveryProofDigest,
      state: wakeRecord.state,
    });
    await supervisor.stop();
    process.exit(0);
  }

  const input = {
    request: 'Continue after release 42 is healthy.',
    name: 'Release 42',
    source: { kind: 'release.healthy', adapter: 'release.v1', subject: 'release-42' },
    condition: { status: { equals: 'healthy' } },
  };
  const sessionId = 'hard-crash-session';
  const turnId = 'hard-crash-turn';
  const toolUseId = 'hard-crash-tool-call';
  const toolName = 'mcp__hark__hark_await';
  const transcriptPath = path.join(dataDir, 'origin-rollout.jsonl');
  const transcriptPrefix = [
    {
      timestamp: '2026-08-07T12:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cli_version: '0.147.0' },
    },
    {
      timestamp: '2026-08-07T12:00:00.000Z',
      type: 'turn_context',
      payload: { turn_id: turnId },
    },
    {
      timestamp: '2026-08-07T12:00:00.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: toolUseId,
        namespace: 'hark',
        name: 'hark_await',
        arguments: JSON.stringify(input),
      },
    },
  ].map((value) => JSON.stringify(value) + '\n').join('');
  await writeFile(transcriptPath, transcriptPrefix, { mode: 0o600 });
  const transcriptStat = await stat(transcriptPath, { bigint: true });

  const protocol = transitionGatedProtocol(new HarkToolWaitProtocol(dataDir));
  const service = new HarkServiceClient({
    baseUrl: apiBaseUrl,
    accessToken,
    allowInsecureLoopback: true,
    timeoutMs: 60_000,
  });

  if ([
    'N0',
    'I_ARM',
    'I_BEFORE_COMMIT_AUTHORITY',
    'I_COMMIT_AUTHORITY',
    'I_COMMIT_CONTENDER',
    'W2',
    'O0',
    'O1',
    'T0',
    'T1',
    'F0',
    'F1',
  ].includes(scenario)) {
    const { executeHeldAwait } = await import(process.env.HARK_MCP_SERVER_URL);
    const admission = await protocol.publishAdmission({
      sessionId,
      turnId,
      toolUseId,
      toolName,
      transcriptPath,
      originalInput: input,
    }, () => new Date('2026-08-07T12:00:00.000Z'), (size) => Buffer.alloc(size, 0x41));
    const executionProtocol = ['I_BEFORE_COMMIT_AUTHORITY', 'I_COMMIT_AUTHORITY'].includes(
      scenario,
    )
      ? new Proxy(protocol, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== 'function') return value;
          if (property !== 'electHeldCallTransitionAuthority') return value.bind(target);
          return async (...args) => {
            if (scenario === 'I_BEFORE_COMMIT_AUTHORITY') {
              emit('before_commit_transition_authority');
              await releaseGate();
            }
            const result = await value.apply(target, args);
            emit(
              result.transitionAuthority.decision === 'commit'
                ? 'commit_transition_authority_durable'
                : 'commit_transition_authority_lost',
              { decision: result.transitionAuthority.decision },
            );
            if (
              scenario === 'I_COMMIT_AUTHORITY'
              && result.transitionAuthority.decision === 'commit'
            ) await hold();
            return result;
          };
        },
      })
      : protocol;
    const result = await executeHeldAwait(admission.rewrittenInput, {
      protocol: executionProtocol,
      serviceClient: service,
      codexHome: dataDir,
      dataDir,
      credentials: {
        ...activeCredentials,
      },
      credentialsStore,
      randomBytes: (size) => Buffer.alloc(size, 0x41),
    });
    emit('normal_result', {
      version: result.structuredContent.v,
      wakeId: result.structuredContent.wake.wakeId,
    });
    if (scenario === 'W2') {
      emit('observation_intent_durable');
      await hold();
    }

    const appendToolOutput = async ({ terminal = null } = {}) => {
      const values = [{
        timestamp: '2026-08-07T12:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: toolUseId,
          output: 'Wall time: 86400.0000 seconds\nOutput:\n'
            + JSON.stringify(result.structuredContent),
        },
      }];
      if (terminal === 'completed') {
        values.push({
          timestamp: '2026-08-07T12:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Release 42 is healthy.' }],
            internal_chat_message_metadata_passthrough: { turn_id: turnId },
          },
        }, {
          timestamp: '2026-08-07T12:00:06.000Z',
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: turnId,
            last_agent_message: 'Release 42 is healthy.',
            started_at: 1_786_086_000,
            completed_at: 1_786_086_006,
            duration_ms: 6_000,
            time_to_first_token_ms: 1,
          },
        });
      }
      await import('node:fs/promises').then(({ appendFile }) => appendFile(
        transcriptPath,
        values.map((value) => JSON.stringify(value) + '\n').join(''),
      ));
    };

    const n0Request = scenario === 'N0'
      ? (await protocol.listAwaitRequests())[0]
      : null;
    if (scenario === 'N0') {
      if (!n0Request) throw new Error('n0_request_missing');
      await appendToolOutput({ terminal: 'completed' });
    }

    if (scenario === 'T0') {
      await appendToolOutput({ terminal: 'completed' });
      emit('tool_result_terminal_durable');
      await hold();
    }

    const { handleCodexHook } = await import(process.env.HARK_HOOK_INGRESS_URL);
    const credentials = {
      apiBaseUrl,
      accessToken,
      installation: {
        ...installation,
      },
    };
    const hookService = {
      getInstallationStatus: (...args) => service.getInstallationStatus(...args),
      async recordRuntimeReceipt(awaitId, receipt, options) {
        const response = await service.recordRuntimeReceipt(awaitId, receipt, options);
        if (['O0', 'O1'].includes(scenario) && receipt.kind === 'tool_result_observed') {
          emit('observation_remote_accepted');
          await hold();
        }
        return response;
      },
      certifyAwait: (...args) => service.certifyAwait(...args),
    };
    await handleCodexHook({
      session_id: sessionId,
      turn_id: turnId,
      transcript_path: transcriptPath,
      cwd: process.cwd(),
      hook_event_name: 'PostToolUse',
      model: 'gpt-5.6',
      permission_mode: 'dontAsk',
      tool_name: toolName,
      tool_input: admission.rewrittenInput,
      tool_response: result,
      tool_use_id: toolUseId,
    }, {
      protocol,
      serviceClient: hookService,
      credentials,
      dataDir,
      clock: () => new Date('2026-08-07T12:00:05.000Z'),
    });

    if (scenario === 'N0') {
      const { HarkHeldWaitCertifier } = await import(
        process.env.HARK_HELD_WAIT_CERTIFIER_URL
      );
      const certifier = new HarkHeldWaitCertifier({
        protocol,
        serviceClient: service,
        dataDir,
        runtimeId: 'hard-crash-runtime',
        credentials: activeCredentials,
        credentialsStore,
        readCredentials: () => credentialsStore.read(),
        clock: () => new Date('2026-08-07T12:00:07.000Z'),
      });
      const summary = await certifier.reconcile();
      const terminal = await protocol.readAwaitRequestTerminal(n0Request);
      emit('n0_certified', {
        summary,
        terminal,
        pendingRequestCount: (await protocol.listAwaitRequests()).length,
      });
      process.exit(0);
    }

    if (scenario === 'T1') {
      await appendToolOutput();
      emit('tool_result_output_durable');
      await hold();
    }

    if (['F0', 'F1'].includes(scenario)) {
      await appendToolOutput({ terminal: 'completed' });
      emit('tool_result_terminal_durable');
      const { HarkHeldWaitCertifier } = await import(
        process.env.HARK_HELD_WAIT_CERTIFIER_URL
      );
      const certifierService = {
        getInstallationStatus: (...args) => service.getInstallationStatus(...args),
        armAwait: (...args) => service.armAwait(...args),
        cancelAwait: (...args) => service.cancelAwait(...args),
        commitAwait: (...args) => service.commitAwait(...args),
        certifyAwait: (...args) => service.certifyAwait(...args),
        async recordRuntimeReceipt(awaitId, receipt, options) {
          const response = await service.recordRuntimeReceipt(awaitId, receipt, options);
          if (scenario === 'F0' && receipt.kind === 'task_completed') {
            emit('completion_remote_accepted');
            await hold();
          }
          return response;
        },
      };
      const certifierProtocol = new Proxy(protocol, {
        get(target, property) {
          if (scenario === 'F1' && property === 'publishCompletionPosted') {
            return async (...args) => {
              const published = await target.publishCompletionPosted(...args);
              emit('completion_marker_durable');
              await hold();
              return published;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const certifier = new HarkHeldWaitCertifier({
        protocol: certifierProtocol,
        serviceClient: certifierService,
        dataDir,
        runtimeId: 'hard-crash-runtime',
        credentials: activeCredentials,
        credentialsStore,
        readCredentials: () => credentialsStore.read(),
        clock: () => new Date('2026-08-07T12:00:07.000Z'),
      });
      await certifier.reconcile();
      throw new Error('hard_crash_certifier_failpoint_not_reached');
    }

    throw new Error('hard_crash_scenario_failpoint_not_reached');
  }

  const request = (await protocol.publishAwaitRequest({
    sessionId,
    turnId,
    toolUseId,
    toolName,
    transcriptPath,
    originalInput: input,
  }, () => new Date('2026-08-07T12:00:00.000Z'))).request;
  const qualificationDigest = sha256Canonical({ source: input.source, condition: input.condition });
  const prepared = {
    v: 'hark.await-prepared.v1',
    preparationNonce: 'hkp_' + 'p'.repeat(32),
    qualificationDigest,
    wakePolicy: 'resume',
    ...input,
  };
  const checkpoint = {
    version: 'hark.codex-checkpoint.v1',
    digest: 'c'.repeat(64),
  };
  const armRequest = {
    v: 'hark.await.v2',
    preparationNonce: prepared.preparationNonce,
    origin: {
      protocol: 'codex',
      runtimeId: 'hard-crash-runtime',
      taskId: turnId,
      conversationId: sessionId,
    },
    checkpoint,
    prepared,
    predicate: {
      kind: 'exact_signal',
      type: input.source.kind,
      subject: input.source.subject,
      qualificationDigest,
    },
    wakePolicy: 'resume',
    binding: {
      continuationMode: 'held_tool',
      toolName,
      toolUseId,
      inputDigest: request.originalInputDigest,
    },
  };
  const transcriptBoundary = {
    v: 'hark.codex-tool-wait-boundary.v1',
    historySource: 'codex.rollout-jsonl.v1',
    transcriptPath,
    conversationId: sessionId,
    originTaskId: turnId,
    toolUseId,
    toolName,
    toolCallDigest: '1'.repeat(64),
    inputDigest: request.originalInputDigest,
    cliVersion: '0.147.0',
    dev: transcriptStat.dev.toString(),
    ino: transcriptStat.ino.toString(),
    byteLength: Buffer.byteLength(transcriptPrefix),
    prefixSha256: createHash('sha256').update(transcriptPrefix).digest('hex'),
  };
  const attempt = (await protocol.publishArmAttempt(request, {
    installationId: installation.id,
    armRequest,
    transcriptBoundary,
  }, () => new Date('2026-08-07T12:00:00.000Z'), (size) => Buffer.alloc(size, 0x42))).armAttempt;
  emit('arm_attempt_durable', { eventId: request.eventId });
  if (scenario === 'A0') await hold();

  const checkedArm = assertArmApiResponse(
    await service.armAwait(attempt.armRequest),
    attempt.armRequest,
    { expectedReplay: false },
  );
  emit('arm_response_returned', { awaitId: checkedArm.awaitId });
  if (scenario === 'A2') await hold();

  const armBinding = (await protocol.publishArmBinding(request, {
    awaitId: checkedArm.awaitId,
    preparationNonce: attempt.preparationNonce,
    checkpointDigest: attempt.checkpointDigest,
    bindingToken: attempt.bindingToken,
  }, () => new Date('2026-08-07T12:00:01.000Z'))).armBinding;
  emit('arm_binding_durable');
  if (scenario === 'A3_BINDING') await hold();

  await protocol.publishTranscriptBoundary(
    request,
    armBinding,
    attempt.transcriptBoundary,
    () => new Date('2026-08-07T12:00:01.000Z'),
  );
  emit('transcript_boundary_durable');
  if (scenario === 'A3_BOUNDARY') await hold();

  const waiterReady = (await protocol.publishWaiterReady(
    request,
    armBinding,
    input,
    () => new Date('2026-08-07T12:00:01.000Z'),
  )).waiterReady;
  emit('waiter_ready_durable');
  if (scenario === 'A3_READY') await hold();

  const commitRequest = {
    v: 'hark.suspension-commit.v2',
    commitNonce: 'hkc_' + 'q'.repeat(32),
    checkpointDigest: armBinding.checkpointDigest,
  };
  const commitAttempt = (await protocol.publishCommitAttempt(
    request,
    armBinding,
    waiterReady,
    commitRequest,
    () => new Date('2026-08-07T12:00:02.000Z'),
  )).commitAttempt;
  emit('commit_attempt_durable');
  if (scenario === 'C0') await hold();

  const checkedCommit = assertCommitApiResponse(
    await service.commitAwait(armBinding.awaitId, commitAttempt.commitRequest),
    {
      awaitId: armBinding.awaitId,
      armRequest: attempt.armRequest,
      commitRequest: commitAttempt.commitRequest,
    },
    { expectedReplay: false },
  );
  emit('commit_response_returned');
  if (scenario === 'C2') await hold();

  const suspensionCommitted = (await protocol.publishSuspensionCommitted(
    request,
    armBinding,
    waiterReady,
    {
      suspensionReceiptId: checkedCommit.suspensionReceiptId,
      suspensionReceiptDigest: checkedCommit.suspensionReceiptDigest,
    },
    () => new Date('2026-08-07T12:00:03.000Z'),
  )).suspensionCommitted;
  emit('suspension_committed_durable');

  if (scenario === 'W0') await hold();

  if (scenario === 'LIVE') {
    await service.waitForAwait(armBinding.awaitId, {
      v: 'hark.await-wake-claim.v2',
      leaseToken: checkedArm.waiter.leaseToken,
      leaseGeneration: checkedArm.waiter.leaseGeneration,
    }, { waitSeconds: 25 });
    await hold();
  }

  const wakeResult = await service.waitForAwait(armBinding.awaitId, {
    v: 'hark.await-wake-claim.v2',
    leaseToken: checkedArm.waiter.leaseToken,
    leaseGeneration: checkedArm.waiter.leaseGeneration,
  }, { waitSeconds: 25 });
  emit('wake_response_returned');
  if (scenario === 'W1') await hold();
  const delivered = await protocol.publishWakeDelivery(
    request,
    armBinding,
    suspensionCommitted,
    wakeResult.wake,
    wakeResult.claim.wakeDeliveryDigest,
    () => new Date('2026-08-07T12:00:04.000Z'),
  );
  emit('wake_delivery_durable', {
    result: createToolWaitResult(delivered.wakeDelivery),
  });
`;

function waitUntil(predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
        if (Date.now() >= deadline) return reject(new Error('wait_until_timeout'));
        setTimeout(poll, 5);
      } catch (error) {
        reject(error);
      }
    };
    void poll();
  });
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function cancelApiResponse({
  awaitId,
  armRequest,
  cancelRequest,
  replay = false,
}) {
  const cancelledAt = '2026-08-07T12:00:06.000Z';
  const armed = armApiResponse(armRequest, { awaitId }).await;
  return {
    v: 'hark.await-cancel-result.v2',
    await: {
      ...armed,
      waiter: {
        ...armed.waiter,
        releasedAt: cancelledAt,
      },
      state: 'cancelled',
      suspendedAt: null,
      wakePendingAt: null,
      acceptedAt: null,
      runningAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt,
      lastError: cancelRequest.reason,
      updatedAt: cancelledAt,
    },
    replay,
  };
}

class LoopbackAwaitApi {
  constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      });
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  sockets = new Set();
  heldResponses = new Set();
  armRequests = [];
  commitRequests = [];
  cancelRequests = [];
  armResponseReplays = [];
  commitResponseReplays = [];
  cancelResponseReplays = [];
  wakeRequests = [];
  genericWakeRequests = [];
  targetNetworkRequests = [];
  targetClaimRequests = [];
  targetClaimResponseReplays = [];
  pendingTargetClaimResponses = [];
  runtimeReceiptAttempts = [];
  runtimeReceiptRequests = [];
  armApplyCount = 0;
  commitApplyCount = 0;
  cancelApplyCount = 0;
  wakeApplyCount = 0;
  targetClaimApplyCount = 0;
  armResponseState = 'armed';
  armRaceGate = false;
  pendingArmRaceResponses = [];
  commitResponseBarrier = 0;
  pendingCommitResponses = [];
  holdArm = false;
  holdCommit = false;
  holdCancel = false;
  holdWake = false;
  holdTargetClaim = false;
  targetClaimResponseBarrier = 0;
  serializeTargetClaimReplay = false;
  targetDisposition = 'recover_waiter';
  targetedRecovery = false;
  targetProofInspector = null;
  armRequest = null;
  commitRequest = null;
  cancelRequest = null;
  wakeRequest = null;
  state = null;
  lastWakeResult = null;
  targetClaimRequest = null;
  targetClaimResult = null;
  targetRemoteEffect = null;
  installationStatusRequests = [];
  networkRequests = [];
  statefulRequests = [];
  armInstallationId = null;

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async stop() {
    for (const response of this.heldResponses) response.destroy();
    this.heldResponses.clear();
    this.server.closeAllConnections?.();
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  release(method) {
    if (method === 'arm') this.holdArm = false;
    if (method === 'commit') this.holdCommit = false;
    if (method === 'cancel') this.holdCancel = false;
    if (method === 'wake') this.holdWake = false;
    if (method === 'targetClaim') this.holdTargetClaim = false;
  }

  releaseArmRaceReplay() {
    const pending = this.pendingArmRaceResponses.splice(0);
    this.armRaceGate = false;
    for (const entry of pending) {
      this.send(entry.response, 200, armApiResponse(this.armRequest, {
        awaitId: TARGET_AWAIT_ID,
        replay: entry.replay,
        state: this.state,
        releasedAt: this.state === 'armed' ? null : '2026-08-07T12:00:06.000Z',
      }));
    }
    return pending.length;
  }

  send(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  withhold(response) {
    this.heldResponses.add(response);
    response.once('close', () => this.heldResponses.delete(response));
  }

  wakeResult(awaitId) {
    const wakeId = TARGET_WAKE_ID;
    return {
      v: 'hark.await-wake-result.v2',
      wake: {
        v: 'hark.wake.v2',
        wakeId,
        idempotencyKey: wakeId,
        awaitId,
        origin: structuredClone(this.armRequest.origin),
        checkpoint: structuredClone(this.armRequest.checkpoint),
        prepared: structuredClone(this.armRequest.prepared),
        signal: {
          id: 'hard-crash-signal',
          sourceSignalId: 'hard-crash-source-signal',
          type: this.armRequest.predicate.type,
          subject: this.armRequest.predicate.subject,
          qualificationDigest: this.armRequest.predicate.qualificationDigest,
          sourceAdapter: 'webhook.v1',
          authMode: 'source_hmac',
          observedAt: '2026-08-07T12:00:04.000Z',
          summary: 'Release 42 is healthy.',
          data: { status: 'healthy' },
          evidence: [],
        },
        createdAt: '2026-08-07T12:00:04.000Z',
      },
      claim: {
        continuationMode: 'held_tool',
        leaseGeneration: 1,
        leaseExpiresAt: '2026-08-07T12:10:00.000Z',
        wakeDeliveryDigest: 'a'.repeat(64),
        disposition: 'deliver_tool_result',
        replay: this.wakeRequests.length > 1,
      },
      replay: this.wakeRequests.length > 1,
    };
  }

  async inspectTargetNetwork(method, pathname, body = null) {
    const proof = this.targetProofInspector
      ? await this.targetProofInspector({ method, pathname, body })
      : null;
    this.targetNetworkRequests.push({ method, pathname, proof });
  }

  targetAwaitDetail(awaitId) {
    const claimed = Boolean(this.targetClaimResult);
    const held = !claimed && this.targetDisposition === 'recover_held_tool';
    return {
      v: 'hark.await-detail.v2',
      await: {
        ...structuredClone(this.armRequest),
        id: awaitId,
        state: 'wake_pending',
      },
      wake: {
        id: TARGET_WAKE_ID,
        awaitId,
        state: claimed || held ? 'leased' : 'queued',
        deliveryMode: claimed ? 'crash_recovery' : held ? 'held_tool' : null,
        wakeDeliveryDigest: 'a'.repeat(64),
        heldDeliveryDigest: held ? 'a'.repeat(64) : null,
      },
    };
  }

  targetRecoveryResult(awaitId, body, replay) {
    return {
      v: 'hark.crash-recovery-claim-result.v1',
      wake: this.wakeResult(awaitId).wake,
      claim: {
        continuationMode: 'crash_recovery',
        leaseToken: TARGET_LEASE_TOKEN,
        leaseGeneration: 2,
        leaseExpiresAt: '2026-08-07T12:10:00.000Z',
        disposition: this.targetDisposition,
        wakeDeliveryDigest: body.wake.wakeDeliveryDigest,
        recoveryProofDigest: sha256Canonical(body),
      },
      replay,
    };
  }

  certification(awaitId) {
    const observation = this.runtimeReceiptRequests.find(
      (receipt) => receipt.kind === 'tool_result_observed',
    );
    const recovery = this.runtimeReceiptRequests.find((receipt) => [
      'tool_result_not_persisted',
      'tool_result_continuation_aborted',
    ].includes(receipt.kind));
    const completion = this.runtimeReceiptRequests.find(
      (receipt) => receipt.kind === 'task_completed',
    );
    const wake = this.lastWakeResult?.wake ?? this.wakeResult(awaitId).wake;
    const recoveryMode = Boolean(recovery);
    return {
      v: 'hark.await-certification.v2',
      awaitId,
      certified: Boolean(completion),
      reasons: completion
        ? []
        : ['tool_wait_proof_missing_or_duplicate', 'task_completion_not_proven'],
      origin: structuredClone(this.armRequest.origin),
      checkpoint: structuredClone(this.armRequest.checkpoint),
      wake: {
        id: wake.wakeId,
        awaitId,
        state: completion ? 'completed' : recoveryMode ? 'queued' : observation ? 'running' : 'leased',
        deliveryMode: recoveryMode ? 'crash_recovery' : 'held_tool',
        heldDeliveryDigest: 'a'.repeat(64),
        ...(completion ? { completedAt: completion.observedAt } : {}),
      },
      continuation: {
        mode: recoveryMode ? 'crash_recovery' : 'held_tool',
        proof: completion?.continuationProof ?? null,
        toolResultObservation: recoveryMode
          ? null
          : observation?.toolResultObservation ?? null,
      },
      toolResultObservationCount: observation ? 1 : 0,
      activeToolResultObservationCount: observation && !recoveryMode ? 1 : 0,
      toolResultNotPersistedCount: recovery ? 1 : 0,
      toolResultRecoveryProof: recovery?.recoveryProof ?? null,
      completionReceiptCount: completion ? 1 : 0,
    };
  }

  async handle(request, response) {
    const accessToken = request.headers.authorization?.replace(/^Bearer /u, '');
    const installation = accessToken === TEST_ACCESS_TOKEN
      ? {
        id: TARGET_INSTALLATION_ID,
        protocol: 'codex',
        runtimeId: 'hard-crash-runtime',
      }
      : accessToken === TEST_ACCESS_TOKEN_B
        ? {
          id: REPLACEMENT_INSTALLATION_ID,
          protocol: 'codex',
          runtimeId: 'hard-crash-runtime',
        }
        : null;
    assert.ok(installation, 'hard_crash_test_access_token_invalid');
    const url = new URL(request.url, this.baseUrl);
    this.networkRequests.push({
      installationId: installation.id,
      method: request.method,
      pathname: url.pathname,
    });
    if (request.method !== 'GET') {
      this.statefulRequests.push({
        installationId: installation.id,
        method: request.method,
        pathname: url.pathname,
      });
    }
    if (
      request.method === 'GET'
      && url.pathname === '/api/hark/v2/installations/self'
    ) {
      this.installationStatusRequests.push(structuredClone(installation));
      if (this.targetedRecovery) {
        await this.inspectTargetNetwork(request.method, url.pathname);
      }
      return this.send(response, 200, {
        v: 'hark.installation-status.v2',
        installation,
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/hark/v2/wakes/next') {
      this.genericWakeRequests.push({ wait: url.searchParams.get('wait') });
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/hark/v2/awaits') {
      const body = await readRequestBody(request);
      if (this.armInstallationId && this.armInstallationId !== installation.id) {
        return this.send(response, 403, { error: 'await_installation_mismatch' });
      }
      this.armRequests.push(structuredClone(body));
      if (!this.armRequest) {
        this.armInstallationId = installation.id;
        this.armRequest = structuredClone(body);
        this.armApplyCount += 1;
        this.state = this.armResponseState;
      } else if (canonicalJson(body) !== canonicalJson(this.armRequest)) {
        return this.send(response, 409, { error: 'altered_arm_replay' });
      }
      const replay = this.armRequests.length > 1;
      this.armResponseReplays.push(replay);
      if (this.armRaceGate) {
        this.withhold(response);
        this.pendingArmRaceResponses.push({ response, replay });
        if (this.pendingArmRaceResponses.length === 2) {
          const [winner] = this.pendingArmRaceResponses.splice(0, 1);
          this.send(winner.response, 200, armApiResponse(this.armRequest, {
            awaitId: TARGET_AWAIT_ID,
            replay: winner.replay,
            state: this.state,
            releasedAt: this.state === 'armed' ? null : '2026-08-07T12:00:06.000Z',
          }));
        }
        return;
      }
      if (this.holdArm) return this.withhold(response);
      return this.send(response, 200, armApiResponse(this.armRequest, {
        awaitId: TARGET_AWAIT_ID,
        replay,
        state: this.state,
        releasedAt: this.state === 'armed' ? null : '2026-08-07T12:00:06.000Z',
      }));
    }

    const awaitMatch = url.pathname.match(/^\/api\/hark\/v2\/awaits\/([^/]+)(.*)$/u);
    if (!awaitMatch) return this.send(response, 404, { error: 'not_found' });
    const awaitId = decodeURIComponent(awaitMatch[1]);
    const operation = awaitMatch[2];

    if (
      this.targetedRecovery
      && request.method === 'GET'
      && operation === ''
      && awaitId === TARGET_AWAIT_ID
    ) {
      await this.inspectTargetNetwork(request.method, url.pathname);
      return this.send(response, 200, this.targetAwaitDetail(awaitId));
    }

    if (
      this.targetedRecovery
      && request.method === 'POST'
      && operation === '/crash-recovery-claim'
      && awaitId === TARGET_AWAIT_ID
    ) {
      const body = await readRequestBody(request);
      await this.inspectTargetNetwork(request.method, url.pathname, body);
      this.targetClaimRequests.push(structuredClone(body));
      if (!this.targetClaimRequest) {
        this.targetClaimRequest = structuredClone(body);
        this.targetClaimApplyCount += 1;
        this.targetRemoteEffect = {
          wakeId: TARGET_WAKE_ID,
          deliveryCount: 1,
          leaseGeneration: 2,
          leaseToken: TARGET_LEASE_TOKEN,
          recoveryProofDigest: sha256Canonical(body),
        };
      } else if (canonicalJson(body) !== canonicalJson(this.targetClaimRequest)) {
        return this.send(response, 409, { error: 'altered_crash_recovery_claim' });
      }
      const replay = this.targetClaimRequests.length > 1;
      this.targetClaimResponseReplays.push(replay);
      const claimResult = this.targetRecoveryResult(awaitId, body, replay);
      this.targetClaimResult ??= structuredClone(claimResult);
      if (this.serializeTargetClaimReplay) {
        this.withhold(response);
        this.pendingTargetClaimResponses.push({
          response,
          body: claimResult,
          status: replay ? 200 : 201,
        });
        if (this.pendingTargetClaimResponses.length === 2) {
          const first = this.pendingTargetClaimResponses.shift();
          this.send(first.response, first.status, first.body);
        }
        return;
      }
      if (this.targetClaimResponseBarrier > 0) {
        this.withhold(response);
        this.pendingTargetClaimResponses.push({ response, body: claimResult, status: replay ? 200 : 201 });
        if (this.pendingTargetClaimResponses.length >= this.targetClaimResponseBarrier) {
          this.targetClaimResponseBarrier = 0;
          const pending = this.pendingTargetClaimResponses.splice(0);
          for (const entry of pending) this.send(entry.response, entry.status, entry.body);
        }
        return;
      }
      if (this.holdTargetClaim) return this.withhold(response);
      return this.send(response, replay ? 200 : 201, claimResult);
    }

    if (request.method === 'POST' && operation === '/commit') {
      if (this.armInstallationId !== installation.id) {
        return this.send(response, 403, { error: 'await_installation_mismatch' });
      }
      const body = await readRequestBody(request);
      this.commitRequests.push(structuredClone(body));
      if (!this.commitRequest) {
        this.commitRequest = structuredClone(body);
        this.commitApplyCount += 1;
        this.state = 'suspended';
      } else if (canonicalJson(body) !== canonicalJson(this.commitRequest)) {
        return this.send(response, 409, { error: 'altered_commit_replay' });
      }
      const replay = this.commitRequests.length > 1;
      this.commitResponseReplays.push(replay);
      const commitResponse = commitApiResponse({
        armRequest: this.armRequest,
        commitRequest: this.commitRequest,
        awaitId,
        replay,
      });
      if (this.commitResponseBarrier > 0) {
        this.withhold(response);
        this.pendingCommitResponses.push({ response, body: commitResponse });
        if (this.pendingCommitResponses.length >= this.commitResponseBarrier) {
          this.commitResponseBarrier = 0;
          const pending = this.pendingCommitResponses.splice(0);
          for (const entry of pending) this.send(entry.response, 200, entry.body);
        }
        return;
      }
      if (this.holdCommit) return this.withhold(response);
      return this.send(response, 200, commitResponse);
    }

    if (request.method === 'POST' && operation === '/cancel') {
      if (this.armInstallationId !== installation.id) {
        return this.send(response, 403, { error: 'await_installation_mismatch' });
      }
      const body = await readRequestBody(request);
      this.cancelRequests.push(structuredClone(body));
      if (this.commitRequest || ['suspended', 'wake_pending'].includes(this.state)) {
        return this.send(response, 409, { error: 'cancel_forbidden_after_commit' });
      }
      if (!this.cancelRequest) {
        this.cancelRequest = structuredClone(body);
        this.cancelApplyCount += 1;
        this.state = 'cancelled';
      } else if (canonicalJson(body) !== canonicalJson(this.cancelRequest)) {
        return this.send(response, 409, { error: 'altered_cancel_replay' });
      }
      const replay = this.cancelRequests.length > 1;
      this.cancelResponseReplays.push(replay);
      if (this.holdCancel) return this.withhold(response);
      return this.send(
        response,
        200,
        cancelApiResponse({
          awaitId,
          armRequest: this.armRequest,
          cancelRequest: this.cancelRequest,
          replay,
        }),
      );
    }

    if (request.method === 'POST' && operation === '/wake') {
      const body = await readRequestBody(request);
      this.wakeRequests.push(structuredClone(body));
      if (!this.wakeRequest) {
        this.wakeRequest = structuredClone(body);
        this.wakeApplyCount += 1;
      } else if (canonicalJson(body) !== canonicalJson(this.wakeRequest)) {
        return this.send(response, 409, { error: 'altered_wake_replay' });
      }
      if (this.holdWake) return this.withhold(response);
      this.state = 'wake_pending';
      this.lastWakeResult = this.wakeResult(awaitId);
      return this.send(response, 200, this.lastWakeResult);
    }

    if (request.method === 'GET' && operation === '/certification') {
      return this.send(response, 200, this.certification(awaitId));
    }

    if (request.method === 'POST' && operation === '/runtime-receipts') {
      const body = await readRequestBody(request);
      this.runtimeReceiptAttempts.push(structuredClone(body));
      const existing = this.runtimeReceiptRequests.find((candidate) => (
        candidate.sourceReceiptId === body.sourceReceiptId
      ));
      if (existing && canonicalJson(existing) !== canonicalJson(body)) {
        return this.send(response, 409, { error: 'runtime_receipt_replay_conflict' });
      }
      if (!existing) this.runtimeReceiptRequests.push(structuredClone(body));
      const recovery = [
        'tool_result_not_persisted',
        'tool_result_continuation_aborted',
      ].includes(body.kind);
      const completed = body.kind === 'task_completed';
      this.send(response, 200, {
        v: 'hark.runtime-receipt-result.v2',
        awaitId,
        kind: body.kind,
        state: completed ? 'completed' : recovery ? 'wake_pending' : 'running',
        wakeState: completed ? 'completed' : recovery ? 'queued' : 'running',
        replay: Boolean(existing),
      });
      if (body.kind === 'task_woken' && this.pendingTargetClaimResponses.length > 0) {
        const pending = this.pendingTargetClaimResponses.splice(0);
        for (const entry of pending) this.send(entry.response, entry.status, entry.body);
      }
      return;
    }

    return this.send(response, 404, { error: 'not_found' });
  }
}

function crashChildEnvironment(scenario, dataDir, api, extraEnv = {}) {
  return {
    PATH: process.env.PATH,
    HARK_CRASH_SCENARIO: scenario,
    HARK_CRASH_DATA_DIR: dataDir,
    HARK_CRASH_API_URL: api.baseUrl,
    HARK_CRASH_ACCESS_TOKEN: TEST_ACCESS_TOKEN,
    HARK_CRASH_INSTALLATION_JSON: canonicalJson({
      id: TARGET_INSTALLATION_ID,
      protocol: 'codex',
      runtimeId: 'hard-crash-runtime',
    }),
    HARK_TOOL_WAIT_PROTOCOL_URL: TOOL_WAIT_PROTOCOL_URL,
    HARK_SERVICE_CLIENT_URL: SERVICE_CLIENT_URL,
    HARK_API_CONTRACTS_URL: API_CONTRACTS_URL,
    HARK_CANONICAL_URL: CANONICAL_URL,
    HARK_MCP_SERVER_URL: MCP_SERVER_URL,
    HARK_HOOK_INGRESS_URL: HOOK_INGRESS_URL,
    HARK_HELD_WAIT_CERTIFIER_URL: HELD_WAIT_CERTIFIER_URL,
    HARK_HELD_CALL_RECONCILER_URL: HELD_CALL_RECONCILER_URL,
    HARK_TOOL_ERROR_LIFECYCLE_URL: TOOL_ERROR_LIFECYCLE_URL,
    HARK_HELD_CRASH_RECOVERY_URL: HELD_CRASH_RECOVERY_URL,
    HARK_HOOK_INBOX_URL: HOOK_INBOX_URL,
    HARK_JOURNAL_URL: JOURNAL_URL,
    HARK_SUPERVISOR_URL: SUPERVISOR_URL,
    HARK_TRANSCRIPT_PROOF_URL: TRANSCRIPT_PROOF_URL,
    ...extraEnv,
  };
}

function trackCrashChild(child) {
  const stages = [];
  let stdout = '';
  let stderr = '';
  let spawnError = null;
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    while (stdout.includes('\n')) {
      const index = stdout.indexOf('\n');
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      if (line.trim()) stages.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => { spawnError = error; });
  return { child, stages, stderr: () => stderr, spawnError: () => spawnError };
}

function startCrashChild(scenario, dataDir, api, extraEnv = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', CHILD_SOURCE], {
    cwd: PLUGIN_ROOT,
    env: crashChildEnvironment(scenario, dataDir, api, extraEnv),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return trackCrashChild(child);
}

function startStracedCrashChild(
  scenario,
  dataDir,
  api,
  { tracePath, inject, extraEnv = {} },
) {
  const child = spawn('strace', [
    '--kill-on-exit',
    '-f',
    '-qq',
    '-yy',
    '-s',
    '512',
    '-o',
    tracePath,
    '-e',
    'trace=fsync,link,linkat,openat,openat2',
    ...(inject ? ['-e', `inject=${inject}`] : []),
    process.execPath,
    '--input-type=module',
    '--eval',
    CHILD_SOURCE,
  ], {
    cwd: PLUGIN_ROOT,
    env: crashChildEnvironment(scenario, dataDir, api, {
      UV_THREADPOOL_SIZE: '1',
      ...extraEnv,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { ...trackCrashChild(child), tracePath };
}

function installationChildEnv({
  installationId = TARGET_INSTALLATION_ID,
  accessToken = TEST_ACCESS_TOKEN,
} = {}) {
  return {
    HARK_CRASH_ACCESS_TOKEN: accessToken,
    HARK_CRASH_INSTALLATION_JSON: canonicalJson({
      id: installationId,
      protocol: 'codex',
      runtimeId: 'hard-crash-runtime',
    }),
  };
}

function startReconcilerChild(value, failpoint, receipt = value.receipt, identity = {}) {
  return startCrashChild('RECONCILER', value.dataDir, value.api, {
    HARK_CRASH_ROLE: 'reconciler',
    HARK_RECONCILE_FAILPOINT: failpoint,
    HARK_RECONCILE_REQUEST_JSON: canonicalJson(value.request),
    ...(receipt ? { HARK_RECONCILE_RECEIPT_JSON: canonicalJson(receipt) } : {}),
    ...installationChildEnv(identity),
  });
}

function startStracedReconcilerChild(value, {
  inject,
  traceName,
  receipt = value.receipt,
} = {}) {
  return startStracedCrashChild('STRACED_RECONCILER', value.dataDir, value.api, {
    tracePath: path.join(value.dataDir, `${traceName}.strace`),
    inject,
    extraEnv: {
      HARK_CRASH_ROLE: 'reconciler',
      HARK_RECONCILE_FAILPOINT: '',
      HARK_RECONCILE_REQUEST_JSON: canonicalJson(value.request),
      ...(receipt ? { HARK_RECONCILE_RECEIPT_JSON: canonicalJson(receipt) } : {}),
      HARK_TRANSITION_AUTHORITY_GATE: '1',
      HARK_TRANSITION_AUTHORITY_CONTENDER: 'reconciler',
    },
  });
}

function startStracedCommitContender(value, { inject, traceName, openatPad = 0 }) {
  return startStracedCrashChild('STRACED_COMMIT_CONTENDER', value.dataDir, value.api, {
    tracePath: path.join(value.dataDir, `${traceName}.strace`),
    inject,
    extraEnv: {
      HARK_CRASH_ROLE: 'transition_commit_contender',
      HARK_RECONCILE_REQUEST_JSON: canonicalJson(value.request),
      HARK_TRANSITION_AUTHORITY_GATE: '1',
      HARK_TRANSITION_AUTHORITY_CONTENDER: 'commit',
      HARK_TRANSITION_OPENAT_PAD: String(openatPad),
    },
  });
}

function startStracedCancelContender(value, { inject, traceName }) {
  return startStracedCrashChild('STRACED_CANCEL_CONTENDER', value.dataDir, value.api, {
    tracePath: path.join(value.dataDir, `${traceName}.strace`),
    inject,
    extraEnv: {
      HARK_CRASH_ROLE: 'transition_cancel_contender',
      HARK_RECONCILE_REQUEST_JSON: canonicalJson(value.request),
      HARK_TRANSITION_AUTHORITY_GATE: '1',
      HARK_TRANSITION_AUTHORITY_CONTENDER: 'cancel',
    },
  });
}

function startStracedToolErrorLifecycle(value, { inject, traceName }) {
  return startStracedCrashChild('STRACED_CANCEL_CONTENDER', value.dataDir, value.api, {
    tracePath: path.join(value.dataDir, `${traceName}.strace`),
    inject,
    extraEnv: {
      HARK_CRASH_ROLE: 'tool_error_lifecycle',
      HARK_RECONCILE_REQUEST_JSON: canonicalJson(value.request),
      HARK_TRANSITION_AUTHORITY_GATE: '1',
      HARK_TRANSITION_AUTHORITY_CONTENDER: 'cancel',
    },
  });
}

function startInstallationToolErrorChild(value, hookInput, identity = {}) {
  return startCrashChild('INSTALLATION_TOOL_ERROR', value.dataDir, value.api, {
    HARK_CRASH_ROLE: 'installation_post_tool_error',
    HARK_HOOK_INPUT_JSON: canonicalJson(hookInput),
    ...installationChildEnv(identity),
  });
}

function startLegacySupervisorChild(value, identity = {}) {
  return startCrashChild('LEGACY_SUPERVISOR', value.dataDir, value.api, {
    HARK_CRASH_ROLE: 'legacy_supervisor',
    ...installationChildEnv(identity),
  });
}

async function sigkillReconcilerAt(value, failpoint, receipt = value.receipt) {
  const running = startReconcilerChild(value, failpoint, receipt);
  try {
    const stage = `reconciler_${failpoint.replace(':', '_')}`;
    await waitForStage(running, stage);
    return await sigkill(running);
  } catch (error) {
    await terminateIfRunning(running);
    throw error;
  }
}

async function runFreshReconciler(value, receipt = value.receipt) {
  const running = startReconcilerChild(value, '', receipt);
  try {
    const completed = await waitForStage(running, 'reconcile_complete');
    await waitForCleanExit(running);
    return completed;
  } catch (error) {
    await terminateIfRunning(running);
    throw error;
  }
}

function startTargetedSupervisorChild(value, { failpoint = '' } = {}) {
  return startCrashChild('TARGETED_SUPERVISOR', value.dataDir, value.api, {
    HARK_CRASH_ROLE: 'targeted_supervisor',
    HARK_TARGET_FAILPOINT: failpoint,
    HARK_TARGET_WAKE_ID: TARGET_WAKE_ID,
  });
}

async function prepareTargetedRecoveryScenario() {
  const value = await crashScenario('C0', { targetedRecovery: true });
  const repaired = await runFreshReconciler(value);
  assert.equal(repaired.kind, 'recovery_authorized');
  const records = await reconciliationRecords(value);
  assert.ok(records.suspensionCommitted);
  assert.equal(records.applied?.outcome, 'suspension_committed');
  assert.equal(records.armBinding.awaitId, TARGET_AWAIT_ID);
  assert.equal(value.api.commitApplyCount, 1);
  assert.equal(value.api.cancelApplyCount, 0);
  value.api.state = 'wake_pending';
  value.api.targetNetworkRequests = [];
  const abortFilesBeforeTarget = await findJsonFiles(
    value.protocol.heldCallOriginAbortDirectory,
  );
  assert.equal(abortFilesBeforeTarget.length, 1);
  const [abortFileBeforeTarget] = abortFilesBeforeTarget;
  const abortRawBeforeTarget = await readFile(abortFileBeforeTarget, 'utf8');
  const abortStatBeforeTarget = await stat(abortFileBeforeTarget, { bigint: true });
  value.targetAbortReceiptPreflight = {
    file: abortFileBeforeTarget,
    rawSha256: sha256Canonical(JSON.parse(abortRawBeforeTarget)),
    dev: abortStatBeforeTarget.dev.toString(),
    ino: abortStatBeforeTarget.ino.toString(),
    size: abortStatBeforeTarget.size.toString(),
    mtimeNs: abortStatBeforeTarget.mtimeNs.toString(),
  };
  value.api.targetProofInspector = async () => {
    const persisted = await value.protocol.readHeldCallOriginAbortReceipt(
      value.request,
      value.attempt,
    );
    assert.deepEqual(persisted, value.receipt);
    const files = await findJsonFiles(value.protocol.heldCallOriginAbortDirectory);
    assert.equal(files.length, 1);
    assert.equal(files[0], value.targetAbortReceiptPreflight.file);
    const raw = await readFile(files[0], 'utf8');
    assert.deepEqual(JSON.parse(raw), value.receipt);
    const currentStat = await stat(files[0], { bigint: true });
    assert.deepEqual({
      rawSha256: sha256Canonical(JSON.parse(raw)),
      dev: currentStat.dev.toString(),
      ino: currentStat.ino.toString(),
      size: currentStat.size.toString(),
      mtimeNs: currentStat.mtimeNs.toString(),
    }, {
      rawSha256: value.targetAbortReceiptPreflight.rawSha256,
      dev: value.targetAbortReceiptPreflight.dev,
      ino: value.targetAbortReceiptPreflight.ino,
      size: value.targetAbortReceiptPreflight.size,
      mtimeNs: value.targetAbortReceiptPreflight.mtimeNs,
    });
    for (const forbidden of [
      TEST_ACCESS_TOKEN,
      'private-lease-token',
      value.attempt.bindingToken,
      'bindingToken',
      'leaseToken',
      'accessToken',
    ]) assert.equal(raw.includes(forbidden), false, forbidden);
    return {
      receiptDigest: sha256Canonical(persisted),
      appServerTerminalEvidenceDigest: persisted.appServerTerminalEvidenceDigest,
      rolloutAbortProofDigest: persisted.rolloutAbortProofDigest,
      originTerminal: structuredClone(persisted.rolloutAbortProof.originTerminal),
    };
  };
  return value;
}

async function assertTargetProofPrecededEveryNetworkRequest(value) {
  assert.equal(value.api.targetNetworkRequests.length >= 3, true);
  const first = value.api.targetNetworkRequests[0];
  assert.deepEqual({ method: first.method, pathname: first.pathname }, {
    method: 'GET',
    pathname: '/api/hark/v2/installations/self',
  });
  for (const request of value.api.targetNetworkRequests) {
    assert.deepEqual(request.proof, {
      receiptDigest: sha256Canonical(value.receipt),
      appServerTerminalEvidenceDigest: value.receipt.appServerTerminalEvidenceDigest,
      rolloutAbortProofDigest: value.receipt.rolloutAbortProofDigest,
      originTerminal: {
        type: 'turn_aborted',
        observedAt: '2026-08-07T12:00:10.000Z',
      },
    });
  }
}

async function assertTargetedRecoveryAppliedAndDispatchedOnce(value, {
  exactClaimRequestCount,
} = {}) {
  assert.equal(value.api.targetClaimApplyCount, 1);
  assert.deepEqual(value.api.targetRemoteEffect, {
    wakeId: TARGET_WAKE_ID,
    deliveryCount: 1,
    leaseGeneration: 2,
    leaseToken: TARGET_LEASE_TOKEN,
    recoveryProofDigest: sha256Canonical(value.api.targetClaimRequest),
  });
  if (exactClaimRequestCount !== undefined) {
    assert.equal(value.api.targetClaimRequests.length, exactClaimRequestCount);
  }
  const exactRequests = value.api.targetClaimRequests.filter((candidate) => (
    canonicalJson(candidate) === canonicalJson(value.api.targetClaimRequest)
  ));
  assert.equal(exactRequests.length >= 1, true);
  for (const request of exactRequests) {
    assert.equal(canonicalJson(request), canonicalJson(value.api.targetClaimRequest));
    assert.equal(sha256Canonical(request), value.api.targetRemoteEffect.recoveryProofDigest);
  }
  const claim = value.api.targetClaimRequest;
  assert.equal(claim.awaitId, TARGET_AWAIT_ID);
  assert.equal(claim.installation.id, TARGET_INSTALLATION_ID);
  assert.equal(claim.wake.wakeId, TARGET_WAKE_ID);
  assert.equal(claim.proof.originAbortReceiptDigest, sha256Canonical(value.receipt));
  assert.equal(
    claim.proof.appServerTerminalEvidenceDigest,
    value.receipt.appServerTerminalEvidenceDigest,
  );
  assert.equal(claim.proof.rolloutAbortProofDigest, value.receipt.rolloutAbortProofDigest);
  const rawClaim = canonicalJson(claim);
  for (const forbidden of [
    TEST_ACCESS_TOKEN,
    'private-lease-token',
    value.attempt.bindingToken,
    'bindingToken',
    'leaseToken',
    'accessToken',
  ]) assert.equal(rawClaim.includes(forbidden), false, forbidden);
  assert.equal(value.api.genericWakeRequests.length, 0);
  assert.equal(value.api.cancelRequests.length, 0);
  const logicalReceipts = value.api.runtimeReceiptRequests.map(({ kind }) => kind);
  assert.equal(logicalReceipts.filter((kind) => kind === 'wake_received').length, 1);
  assert.equal(logicalReceipts.filter((kind) => kind === 'task_woken').length, 1);
  const state = await new HarkJournal(value.dataDir).read();
  assert.equal(state.wakes[TARGET_WAKE_ID]?.state, 'running');
  assert.equal(state.wakes[TARGET_WAKE_ID]?.claim.leaseGeneration, 2);
  assert.equal(
    state.wakes[TARGET_WAKE_ID]?.claim.recoveryProofDigest,
    value.api.targetRemoteEffect.recoveryProofDigest,
  );
  await assertTargetProofPrecededEveryNetworkRequest(value);
  await assertReconciliationReceiptsSecretFree(value);
}

async function waitForStage(running, stage) {
  return waitUntil(() => {
    const value = running.stages.find((entry) => entry.stage === stage);
    if (value) return value;
    if (running.spawnError?.()) throw running.spawnError();
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`child_exited_before_${stage}:${running.stderr()}`);
    }
    return null;
  });
}

function transitionSyscallInjection(boundary) {
  const syscall = boundary.operation === 'temp_create'
    ? 'openat'
    : boundary.operation === 'final_link'
      ? 'link,linkat'
      : 'fsync';
  const occurrence = boundary.operation === 'temp_create'
    ? 107
    : boundary.operation === 'directory_fsync'
      ? 2
      : 1;
  const action = boundary.phase === 'before'
    ? 'delay_enter=30s'
    : 'signal=SIGSTOP';
  return `${syscall}:${action}:when=${occurrence}`;
}

async function readTrace(running) {
  try {
    return await readFile(running.tracePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

async function traceeStopped(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    return /^State:\s+[Tt]/mu.test(status);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function delayedAuthoritySyscallEntered(trace, value, operation) {
  const lines = trace.split('\n');
  const pending = lines.at(-1) || lines.at(-2) || '';
  if (pending.includes(' = ') || !pending.includes(
    value.protocol.heldCallTransitionAuthorityDirectory,
  )) return false;
  if (operation === 'temp_create') {
    return /\bopenat\(/u.test(pending)
      && pending.includes('.tmp')
      && pending.includes('O_EXCL');
  }
  if (operation === 'final_link') return /\b(?:link|linkat)\(/u.test(pending);
  if (!/\bfsync\(/u.test(pending)) return false;
  return operation === 'temp_fsync'
    ? pending.includes('.tmp>')
    : !pending.includes('.tmp>');
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function authorityFileState(protocol, request) {
  let entries = [];
  try {
    entries = await readdir(protocol.heldCallTransitionAuthorityDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const finalName = `${request.eventId}.json`;
  return {
    entries,
    finalName,
    finalExists: entries.some((entry) => entry.isFile() && entry.name === finalName),
    tempNames: entries.filter((entry) => (
      entry.isFile()
      && entry.name.startsWith(`.${finalName}.`)
      && entry.name.endsWith('.tmp')
    )).map((entry) => entry.name),
  };
}

function authorityTraceFacts(trace, value) {
  const directory = value.protocol.heldCallTransitionAuthorityDirectory;
  const finalName = `${value.request.eventId}.json`;
  const lines = trace.split('\n').filter(Boolean);
  const inAuthorityDirectory = (line) => line.includes(directory);
  const tempOpenLines = lines.filter((line) => (
    /\bopenat\(/u.test(line)
    && inAuthorityDirectory(line)
    && line.includes(`.${finalName}.`)
    && line.includes('.tmp')
    && line.includes('O_EXCL')
  ));
  const tempFsyncLines = lines.filter((line) => (
    /\bfsync\(/u.test(line)
    && inAuthorityDirectory(line)
    && line.includes(`.${finalName}.`)
    && line.includes('.tmp>')
  ));
  const directoryFsyncLines = lines.filter((line) => (
    /\bfsync\(/u.test(line)
    && line.includes(`<${directory}>`)
  ));
  const linkLines = lines.filter((line) => (
    /\b(?:link|linkat)\(/u.test(line)
    && inAuthorityDirectory(line)
    && line.includes(`.${finalName}.`)
    && line.includes(`/${finalName}`)
  ));
  return {
    tempOpenLines,
    tempOpenSuccesses: tempOpenLines.filter((line) => /\s=\s+\d+/u.test(line)),
    tempFsyncLines,
    tempFsyncSuccesses: tempFsyncLines.filter((line) => /\s=\s+0\b/u.test(line)),
    directoryFsyncLines,
    directoryFsyncSuccesses: directoryFsyncLines.filter(
      (line) => /\s=\s+0\b/u.test(line),
    ),
    linkLines,
    linkSuccesses: linkLines.filter((line) => /\s=\s+0\b/u.test(line)),
    linkEexists: linkLines.filter((line) => /EEXIST/u.test(line)),
  };
}

function authorityLinkSyscall(line) {
  const match = line.match(/\b(linkat|link)\(/u);
  assert.ok(match, line);
  return match[1];
}

async function waitForAuthoritySyscallBoundary(running, value, boundary, traceePid) {
  return waitUntil(async () => {
    if (running.spawnError?.()) throw running.spawnError();
    if (running.child.exitCode !== null || running.child.signalCode !== null) {
      throw new Error(`strace_exited_before_${boundary.phase}_${boundary.operation}:${running.stderr()}`);
    }
    const files = await authorityFileState(value.protocol, value.request);
    const trace = await readTrace(running);
    const facts = authorityTraceFacts(trace, value);
    const stopped = boundary.phase === 'after' && await traceeStopped(traceePid);
    const delayed = boundary.phase === 'before'
      && delayedAuthoritySyscallEntered(trace, value, boundary.operation);
    if (boundary.phase === 'before' && !delayed) return null;
    if (boundary.operation === 'temp_create') {
      if (files.finalExists || files.tempNames.length !== (boundary.phase === 'after' ? 1 : 0)) {
        return null;
      }
      if (boundary.phase === 'after' && (!stopped || facts.tempOpenSuccesses.length < 1)) {
        return null;
      }
    } else if (boundary.operation === 'temp_fsync') {
      if (files.tempNames.length !== 1 || files.finalExists) return null;
      if (
        boundary.phase === 'after'
        && (!stopped || facts.tempFsyncSuccesses.length < 1)
      ) return null;
    } else if (boundary.operation === 'final_link') {
      if (files.tempNames.length !== 1 || files.finalExists !== (boundary.phase === 'after')) {
        return null;
      }
      if (boundary.phase === 'before' && facts.tempFsyncSuccesses.length < 1) return null;
      if (boundary.phase === 'after' && (!stopped || facts.linkSuccesses.length < 1)) {
        return null;
      }
    } else {
      if (!files.finalExists || files.tempNames.length !== 0 || facts.linkSuccesses.length < 1) {
        return null;
      }
      if (boundary.phase === 'before' && facts.directoryFsyncSuccesses.length !== 0) {
        return null;
      }
      if (
        boundary.phase === 'after'
        && (!stopped || facts.directoryFsyncSuccesses.length < 1)
      ) return null;
    }
    return { files, trace, facts, stopped, delayed };
  }, 10_000);
}

async function sigkillStraced(running, traceePid) {
  const exit = await sigkill(running);
  await waitUntil(() => !processExists(traceePid), 10_000);
  return exit;
}

async function assertAuthorityArtifactsSecretFree(value) {
  const files = await authorityFileState(value.protocol, value.request);
  const names = files.entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  assert.equal(names.includes(files.finalName), true);
  for (const name of names) {
    const file = path.join(value.protocol.heldCallTransitionAuthorityDirectory, name);
    const metadata = await stat(file);
    assert.equal(metadata.mode & 0o077, 0, name);
    const raw = await readFile(file, 'utf8');
    for (const forbidden of [
      TEST_ACCESS_TOKEN,
      TEST_ACCESS_TOKEN_B,
      value.attempt.bindingToken,
      'bindingToken',
      'leaseToken',
      'accessToken',
    ]) assert.equal(raw.includes(forbidden), false, `${name}:${forbidden}`);
  }
}

async function sigkill(running) {
  assert.equal(running.child.stdin.destroyed, false, 'child stdin stayed open until crash');
  assert.equal(running.child.kill('SIGKILL'), true);
  const exit = await new Promise((resolve, reject) => {
    running.child.once('error', reject);
    running.child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
  return exit;
}

async function terminateIfRunning(running) {
  if (!running || running.child.exitCode !== null || running.child.signalCode !== null) return;
  running.child.kill('SIGKILL');
  await new Promise((resolve) => running.child.once('exit', resolve));
}

async function findJsonFiles(directory) {
  const files = [];
  const visit = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith('.json')) files.push(target);
    }
  };
  await visit(directory);
  return files.sort();
}

async function snapshotJsonTree(directory) {
  const files = await findJsonFiles(directory);
  return Promise.all(files.map(async (file) => ({
    file: path.relative(directory, file),
    raw: await readFile(file, 'utf8'),
  })));
}

async function postToolErrorInput(value) {
  const [admissionFile] = await findJsonFiles(value.protocol.consumedAdmissionDirectory);
  assert.ok(admissionFile, 'consumed admission is durable before the error hook');
  const admission = JSON.parse(await readFile(admissionFile, 'utf8'));
  return {
    session_id: admission.sessionId,
    turn_id: admission.turnId,
    transcript_path: admission.transcriptPath,
    cwd: PLUGIN_ROOT,
    hook_event_name: 'PostToolUse',
    model: 'gpt-5.6',
    permission_mode: 'dontAsk',
    tool_name: admission.toolName,
    tool_input: createAdmissionLocatorInput(admission),
    tool_response: {
      content: [{ type: 'text', text: 'Hark arm response was interrupted.' }],
      isError: true,
    },
    tool_use_id: admission.toolUseId,
  };
}

async function publishObservedToolError(value) {
  const toolError = (await value.protocol.publishToolError(value.request, {
    failureCode: 'armed_precommit_failed',
    errorDigest: 'd'.repeat(64),
  }, () => new Date('2026-08-07T12:00:14.000Z'))).toolError;
  const toolErrorObservation = (await value.protocol.publishToolErrorObservation(
    value.request,
    toolError,
    { responseDigest: 'f'.repeat(64) },
    () => new Date('2026-08-07T12:00:15.000Z'),
  )).toolErrorObservation;
  return { toolError, toolErrorObservation };
}

async function prepareLegacyObservedPreparation({ installation = true } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-legacy-installation-'));
  const api = await new LoopbackAwaitApi().start();
  const journal = new HarkJournal(dataDir);
  await journal.ensureHistoryFloor(new Date('2026-08-07T12:00:00.000Z').getTime());
  const transcriptPath = path.join(dataDir, 'legacy-origin-rollout.jsonl');
  await writeFile(transcriptPath, '', { mode: 0o600 });
  const prepared = {
    v: 'hark.await-prepared.v1',
    preparationNonce: `hkp_${'l'.repeat(32)}`,
    qualificationDigest: sha256Canonical({
      source: { kind: 'release.healthy', adapter: 'release.v1', subject: 'release-legacy' },
      condition: { status: { equals: 'healthy' } },
    }),
    wakePolicy: 'resume',
    request: 'Continue after the legacy release is healthy.',
    name: 'Legacy release',
    source: { kind: 'release.healthy', adapter: 'release.v1', subject: 'release-legacy' },
    condition: { status: { equals: 'healthy' } },
  };
  const origin = {
    protocol: 'codex',
    runtimeId: 'hard-crash-runtime',
    taskId: 'legacy-turn',
    conversationId: 'legacy-session',
  };
  const binding = {
    threadId: origin.conversationId,
    turnId: origin.taskId,
    itemId: 'legacy-tool-call',
    toolName: 'mcp__hark__hark_await',
    inputDigest: sha256Canonical({
      request: prepared.request,
      name: prepared.name,
      source: prepared.source,
      condition: prepared.condition,
    }),
    origin,
    ...(installation ? {
      installation: {
        id: TARGET_INSTALLATION_ID,
        protocol: 'codex',
        runtimeId: 'hard-crash-runtime',
      },
    } : {}),
    checkpoint: {
      version: 'hark.codex-checkpoint.v1',
      digest: 'c'.repeat(64),
    },
    transcriptBoundary: null,
  };
  await journal.recordPreparation(prepared, binding);
  return {
    api,
    dataDir,
    journal,
    protocol: new HarkToolWaitProtocol(dataDir),
    request: { sessionId: origin.conversationId, transcriptPath },
    preparationNonce: prepared.preparationNonce,
  };
}

function serviceFor(api) {
  return new HarkServiceClient({
    baseUrl: api.baseUrl,
    accessToken: TEST_ACCESS_TOKEN,
    allowInsecureLoopback: true,
    timeoutMs: 5_000,
  });
}

function credentialsFor(api, {
  accessToken = TEST_ACCESS_TOKEN,
  installationId = TARGET_INSTALLATION_ID,
} = {}) {
  return {
    apiBaseUrl: api.baseUrl,
    accessToken,
    installation: {
      id: installationId,
      protocol: 'codex',
      runtimeId: 'hard-crash-runtime',
    },
  };
}

class CrashRecoveryAppServer extends EventEmitter {
  constructor(request, hookInbox) {
    super();
    this.hookInbox = hookInbox;
    this.calls = [];
    this.thread = {
      id: request.sessionId,
      sessionId: request.sessionId,
      parentThreadId: null,
      canAcceptDirectInput: null,
      status: { type: 'idle' },
      path: request.transcriptPath,
      turns: [{
        id: request.turnId,
        status: 'interrupted',
        startedAt: 1_786_086_000,
        completedAt: 1_786_086_010,
        items: [],
        error: { message: 'owner_process_sigkill' },
      }],
    };
  }

  async start() { this.calls.push(['start']); }
  async close() { this.calls.push(['close']); }
  async readConfig() {
    this.calls.push(['config/read']);
    return { config: { features: { current_time_reminder: { clock_source: 'system' } } } };
  }
  async listLoadedThreads() {
    this.calls.push(['thread/loaded/list']);
    return { data: [this.thread.id], nextCursor: null };
  }
  async readThread(threadId) {
    this.calls.push(['thread/read', threadId]);
    return { thread: structuredClone(this.thread) };
  }
  async resumeThread(threadId) {
    this.calls.push(['thread/resume', threadId]);
    return { thread: structuredClone(this.thread) };
  }
  async unsubscribeThread(threadId) { this.calls.push(['thread/unsubscribe', threadId]); }

  async startTurn(threadId, prompt, options) {
    this.calls.push(['turn/start', threadId, prompt, structuredClone(options)]);
    const turn = {
      id: 'hard-crash-recovery-turn',
      status: 'inProgress',
      startedAt: 1_786_086_020,
      items: [{
        id: 'hard-crash-recovery-message',
        type: 'userMessage',
        clientId: options.clientUserMessageId,
        content: [{ type: 'text', text: prompt }],
      }],
      error: null,
    };
    this.thread.turns.push(turn);
    const admissions = (await this.hookInbox.listWakeAdmissions()).filter((candidate) => (
      candidate.sessionId === threadId && candidate.promptDigest.length === 64
    ));
    assert.equal(admissions.length, 1);
    const [exactAdmission] = admissions;
    if (!exactAdmission) throw new Error('hard_crash_wake_admission_missing');
    await this.hookInbox.acknowledgeWakeAdmission(exactAdmission, {
      turnId: turn.id,
      transcriptPath: exactAdmission.transcriptPath,
    });
    return { turn: structuredClone(turn) };
  }

  callsFor(method) {
    return this.calls.filter((call) => call[0] === method);
  }
}

function physicalTranscriptProof() {
  return {
    preflight(boundary, { scannedAt }) {
      const exact = boundary.v === 'hark.codex-rollout-boundary.v1'
        ? boundary
        : rolloutBoundary({ transcriptBoundary: boundary });
      return preflightCodexWaitHistory(exact, { scannedAt: new Date(scannedAt) });
    },
    prove(boundary, { wakeTaskId, scannedAt }) {
      return proveCodexWaitHistory(boundary, {
        wakeTaskId,
        scannedAt: new Date(scannedAt),
      });
    },
  };
}

async function appendRecoveryTurnToTranscript(request) {
  const turnId = 'hard-crash-recovery-turn';
  await appendFile(request.transcriptPath, [
    {
      timestamp: '2026-08-07T12:00:19.000Z',
      type: 'turn_context',
      payload: { turn_id: turnId },
    },
    {
      timestamp: '2026-08-07T12:00:20.000Z',
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: 'Recovered release 42 after the origin process was killed.',
        time_to_first_token_ms: 1,
      },
    },
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

function recoveryWakeResult(api, disposition) {
  const result = structuredClone(api.lastWakeResult);
  assert.ok(result?.wake);
  result.claim = {
    leaseToken: 'hard-crash-recovery-lease',
    leaseGeneration: 2,
    disposition,
    ...(disposition === 'recover_held_tool'
      ? { priorWakeDeliveryDigest: 'a'.repeat(64) }
      : {}),
  };
  result.replay = true;
  return result;
}

async function dispatchOneCrashRecoveryTurn(value, disposition) {
  value.api.targetedRecovery = true;
  value.api.targetDisposition = disposition;
  value.api.state = 'wake_pending';
  const service = serviceFor(value.api);
  const credentials = credentialsFor(value.api);
  const credentialsStore = {
    async read() { return structuredClone(credentials); },
  };
  const hookInbox = new HarkHookInbox(value.dataDir);
  const journal = new HarkJournal(value.dataDir);
  const appServer = new CrashRecoveryAppServer(value.request, hookInbox);
  const heldRecovery = new HarkHeldCrashRecovery({
    protocol: value.protocol,
    serviceClient: service,
    runtimeId: 'hard-crash-runtime',
  });
  const actualCertifier = new HarkHeldWaitCertifier({
    protocol: value.protocol,
    serviceClient: service,
    runtimeId: 'hard-crash-runtime',
    credentials,
    credentialsStore,
    readCredentials: () => credentialsStore.read(),
  });
  const certifier = {
    protocol: value.protocol,
    setOriginAbortProofProvider(provider) {
      actualCertifier.setOriginAbortProofProvider(provider);
    },
    reconcileHeldCallCrash(...args) {
      return actualCertifier.reconcileHeldCallCrash(...args);
    },
    async poll(signal) {
      if (signal?.aborted) return;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [
    level,
    (details, message) => logs.push({ level, details, message }),
  ]));
  const supervisor = new HarkCodexSupervisor({
    appServerClientFactory: () => appServer,
    serviceClient: service,
    journal,
    hookInbox,
    heldRecovery,
    heldWaitCertifier: certifier,
    transcriptProof: physicalTranscriptProof(),
    runtimeId: 'hard-crash-runtime',
    credentialsStore,
    installation: {
      id: TARGET_INSTALLATION_ID,
      protocol: 'codex',
      runtimeId: 'hard-crash-runtime',
    },
    now: () => new Date('2026-08-07T12:00:20.000Z'),
    pollWaitSeconds: 0,
    heldCrashRecoveryPollIntervalMs: 60_000,
    logger,
  });
  await supervisor.start({ poll: true });
  await waitUntil(() => {
    supervisor.assertHealthy();
    return appServer.callsFor('turn/start').length === 1;
  });
  assert.equal(appServer.callsFor('turn/start').length, 1, canonicalJson(logs));
  const recoveryTurn = appServer.thread.turns.find(
    (turn) => turn.id === 'hard-crash-recovery-turn',
  );
  assert.ok(recoveryTurn);
  if (!value.api.runtimeReceiptRequests.some((receipt) => receipt.kind === 'task_woken')) {
    await appendRecoveryTurnToTranscript(value.request);
    await supervisor.observeTurnStarted({
      threadId: value.request.sessionId,
      turn: recoveryTurn,
    });
    await supervisor.drain();
  }
  await waitUntil(() => {
    supervisor.assertHealthy();
    return value.api.runtimeReceiptRequests.filter(
      (receipt) => receipt.kind === 'task_woken',
    ).length === 1;
  });
  const receiptKinds = value.api.runtimeReceiptRequests.map((receipt) => receipt.kind);
  assert.equal(receiptKinds.filter((kind) => kind === 'wake_received').length, 1);
  assert.equal(receiptKinds.filter((kind) => kind === 'task_woken').length, 1);
  assert.equal((await journal.read()).wakes[TARGET_WAKE_ID].recoveryRequiresOriginAbort, true);

  await new Promise((resolve) => setTimeout(resolve, 75));
  supervisor.assertHealthy();
  assert.equal(appServer.callsFor('turn/start').length, 1);
  assert.equal(value.api.runtimeReceiptRequests.filter(
    (receipt) => receipt.kind === 'wake_received',
  ).length, 1);
  assert.equal(value.api.runtimeReceiptRequests.filter(
    (receipt) => receipt.kind === 'task_woken',
  ).length, 1);
  await supervisor.stop();
  return { appServer, journal, wakeResult: value.api.targetClaimResult };
}

function rolloutBoundary(attempt) {
  const boundary = attempt.transcriptBoundary;
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

async function preparePositiveAbortProof(protocol, request, exit, { persist = true } = {}) {
  assert.deepEqual(exit, { code: null, signal: 'SIGKILL' });
  const attempt = await protocol.readArmAttempt(request);
  assert.ok(attempt);
  const observedAt = '2026-08-07T12:00:10.000Z';
  await appendFile(attempt.transcriptBoundary.transcriptPath, `${JSON.stringify({
    timestamp: observedAt,
    type: 'event_msg',
    payload: {
      type: 'turn_aborted',
      turn_id: request.turnId,
      reason: 'owner_process_sigkill',
    },
  })}\n`);
  const rollout = await preflightCodexWaitHistory(rolloutBoundary(attempt), {
    scannedAt: new Date('2026-08-07T12:00:11.000Z'),
  });
  assert.equal(rollout.originTerminal.type, 'turn_aborted');
  const proof = {
    v: 'hark.codex-owner-abort-proof.v1',
    appServer: {
      v: 'hark.codex-app-server-origin-terminal.v1',
      conversationId: request.sessionId,
      originTaskId: request.turnId,
      turnStatus: 'interrupted',
      observedAt,
    },
    rollout,
  };
  const receipt = createHeldCallOriginAbortReceipt(
    request,
    attempt,
    proof,
    () => new Date('2026-08-07T12:00:12.000Z'),
  );
  if (!persist) {
    return { attempt, receipt, created: false };
  }
  const published = await protocol.appendHeldCallOriginAbortReceipt(
    receipt,
    request,
    attempt,
  );
  return {
    attempt,
    receipt: published.originAbortReceipt,
    created: published.created,
  };
}

async function publishPositiveAbortProof(protocol, request, exit) {
  return preparePositiveAbortProof(protocol, request, exit);
}

async function waitForCleanExit(running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    assert.deepEqual({
      code: running.child.exitCode,
      signal: running.child.signalCode,
    }, { code: 0, signal: null }, running.stderr());
    return;
  }
  const exit = await new Promise((resolve, reject) => {
    running.child.once('error', reject);
    running.child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: 0, signal: null }, running.stderr());
}

async function crashScenario(scenario, { publishAbort = true, targetedRecovery = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `hark-hard-crash-${scenario}-`));
  const api = await new LoopbackAwaitApi().start();
  api.targetedRecovery = targetedRecovery;
  api.holdArm = ['A1', 'I_ARM'].includes(scenario);
  api.holdCommit = scenario === 'C1';
  api.holdWake = scenario === 'LIVE';
  const running = startCrashChild(scenario, dataDir, api);
  try {
    if (scenario === 'I_ARM') {
      await waitUntil(() => api.armRequests.length === 1);
      const protocol = new HarkToolWaitProtocol(dataDir);
      await waitUntil(async () => {
        const [request] = await protocol.listAwaitRequests();
        return request && await protocol.readArmAttempt(request);
      });
    } else if (scenario === 'A1') {
      await waitForStage(running, 'arm_attempt_durable');
      await waitUntil(() => api.armRequests.length === 1);
    } else if (scenario === 'C1') {
      await waitForStage(running, 'commit_attempt_durable');
      await waitUntil(() => api.commitRequests.length === 1);
    } else {
      const stage = {
        A0: 'arm_attempt_durable',
        I_COMMIT_AUTHORITY: 'commit_transition_authority_durable',
        A2: 'arm_response_returned',
        A3_BINDING: 'arm_binding_durable',
        A3_BOUNDARY: 'transcript_boundary_durable',
        A3_READY: 'waiter_ready_durable',
        C0: 'commit_attempt_durable',
        C2: 'commit_response_returned',
        LIVE: 'suspension_committed_durable',
        W0: 'suspension_committed_durable',
        W1: 'wake_response_returned',
        W2: 'observation_intent_durable',
        O0: 'observation_remote_accepted',
        O1: 'observation_remote_accepted',
        T0: 'tool_result_terminal_durable',
        T1: 'tool_result_output_durable',
        F0: 'completion_remote_accepted',
        F1: 'completion_marker_durable',
      }[scenario];
      await waitForStage(running, stage);
      if (scenario === 'LIVE') await waitUntil(() => api.wakeRequests.length === 1);
    }
    const exit = await sigkill(running);
    api.release('arm');
    api.release('commit');
    api.release('wake');
    const protocol = new HarkToolWaitProtocol(dataDir);
    const pendingRequestFiles = await findJsonFiles(protocol.awaitRequestDirectory);
    const archivedRequestFiles = pendingRequestFiles.length === 0
      ? await findJsonFiles(protocol.awaitRequestArchiveDirectory)
      : [];
    const [requestFile] = pendingRequestFiles.length > 0
      ? pendingRequestFiles
      : archivedRequestFiles;
    const request = requestFile
      ? JSON.parse(await readFile(requestFile, 'utf8'))
      : null;
    assert.ok(request);
    if (!publishAbort) {
      const [attemptFile] = await findJsonFiles(protocol.armAttemptDirectory);
      const attempt = attemptFile
        ? JSON.parse(await readFile(attemptFile, 'utf8'))
        : null;
      assert.ok(attempt);
      return { api, dataDir, protocol, request, attempt, exit, receipt: null };
    }
    const abort = await publishPositiveAbortProof(protocol, request, exit);
    assert.equal(abort.created, true);
    return { api, dataDir, protocol, request, ...abort };
  } catch (error) {
    await terminateIfRunning(running);
    await api.stop();
    throw error;
  }
}

function reconcilerFor(value) {
  const credentials = credentialsFor(value.api);
  return new HeldCallCrashReconciler({
    protocol: value.protocol,
    serviceClient: serviceFor(value.api),
    credentials,
    readCredentials: async () => structuredClone(credentials),
    clock: () => new Date('2026-08-07T12:00:13.000Z'),
  });
}

function certifierFor(value) {
  const credentials = credentialsFor(value.api);
  return new HarkHeldWaitCertifier({
    protocol: new HarkToolWaitProtocol(value.dataDir),
    serviceClient: serviceFor(value.api),
    dataDir: value.dataDir,
    runtimeId: 'hard-crash-runtime',
    credentials,
    readCredentials: async () => structuredClone(credentials),
    clock: () => new Date('2026-08-07T12:00:30.000Z'),
  });
}

async function heldResultRecords(value) {
  const armBinding = await value.protocol.readArmBinding(value.request);
  const boundary = await value.protocol.readTranscriptBoundary(value.request, armBinding);
  const delivery = await value.protocol.readWakeDelivery(value.request, armBinding);
  const result = delivery ? createToolWaitResult(delivery) : null;
  const returned = delivery
    ? await value.protocol.readToolResultReturned(delivery, result)
    : null;
  const intent = delivery && boundary
    ? await value.protocol.readToolResultObservationIntent(
      delivery,
      result,
      boundary.boundary,
      'hard-crash-runtime',
    )
    : null;
  const completion = returned
    ? await value.protocol.readCompletionPosted(returned)
    : null;
  return { armBinding, boundary, delivery, result, returned, intent, completion };
}

function evaluateOrdinaryPrompt(value) {
  return evaluatePromptGuard({
    session_id: value.request.sessionId,
    turn_id: 'hard-crash-competing-turn',
    transcript_path: value.request.transcriptPath,
    cwd: PLUGIN_ROOT,
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5.6',
    permission_mode: 'never',
    prompt: 'Competing user prompt.',
  }, {
    journal: new HarkJournal(value.dataDir),
    inbox: new HarkHookInbox(value.dataDir),
    protocol: value.protocol,
  });
}

async function reconciliationRecords(value) {
  const armBinding = await value.protocol.readArmBinding(value.request);
  const transcriptBoundary = await value.protocol.readTranscriptBoundary(
    value.request,
    armBinding,
  );
  const waiterReady = await value.protocol.readWaiterReady(value.request, armBinding);
  const commitAttempt = waiterReady
    ? await value.protocol.readCommitAttempt(value.request, armBinding, waiterReady)
    : null;
  const suspensionCommitted = waiterReady
    ? await value.protocol.readSuspensionCommitted(value.request, armBinding, waiterReady)
    : null;
  const terminal = await value.protocol.readAwaitRequestTerminal(value.request);
  const intent = await value.protocol.readHeldCallReconciliationIntent(
    value.request,
    value.attempt,
    value.receipt,
  );
  const applied = intent
    ? await value.protocol.readHeldCallReconciliationApplied(value.request, intent)
    : null;
  return {
    armBinding,
    transcriptBoundary,
    waiterReady,
    commitAttempt,
    suspensionCommitted,
    terminal,
    intent,
    applied,
  };
}

async function assertReconciliationReceiptsSecretFree(value) {
  const directories = [
    value.protocol.heldCallOriginAbortDirectory,
    value.protocol.heldCallReconciliationIntentDirectory,
    value.protocol.heldCallReconciliationAppliedDirectory,
  ];
  const files = (await Promise.all(directories.map(findJsonFiles))).flat();
  assert.equal(files.length, 3);
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    for (const forbidden of [
      TEST_ACCESS_TOKEN,
      'private-lease-token',
      value.attempt.bindingToken,
      'bindingToken',
      'leaseToken',
      'accessToken',
    ]) assert.equal(raw.includes(forbidden), false, `${path.basename(file)}:${forbidden}`);
  }
}

async function assertArmCrashRepaired(value, expected) {
  const disposition = await reconcilerFor(value).reconcile(value.request, {
    originAbortReceipt: value.receipt,
  });
  assert.equal(disposition.kind, 'released');
  const records = await reconciliationRecords(value);
  assert.ok(records.armBinding);
  assert.ok(records.transcriptBoundary);
  assert.ok(records.waiterReady);
  assert.equal(records.commitAttempt, null);
  assert.equal(records.suspensionCommitted, null);
  assert.equal(records.terminal.disposition, 'remote_cancelled');
  assert.equal(records.intent.stage, 'arm');
  assert.equal(records.applied.stage, 'arm');
  assert.equal(records.applied.outcome, 'remote_cancelled');
  assert.deepEqual(records.applied.apiResponses.map(({ method, replay }) => ({ method, replay })),
    expected.apiResponses);
  assert.deepEqual(await value.protocol.listAwaitRequests(), []);
  assert.deepEqual(await evaluateOrdinaryPrompt(value), {
    allowed: true,
    reason: 'thread_not_owned',
  });
  assert.deepEqual({
    armRequests: value.api.armRequests.length,
    armApplies: value.api.armApplyCount,
    cancelRequests: value.api.cancelRequests.length,
    cancelApplies: value.api.cancelApplyCount,
    commitRequests: value.api.commitRequests.length,
    commitApplies: value.api.commitApplyCount,
  }, expected.counts);
  assert.deepEqual(value.api.armResponseReplays, expected.armResponseReplays);
  assert.deepEqual(value.api.cancelResponseReplays, expected.cancelResponseReplays);
  await assertReconciliationReceiptsSecretFree(value);

  const duplicate = await reconcilerFor(value).reconcile(value.request, {
    originAbortReceipt: value.receipt,
  });
  assert.equal(duplicate.kind, 'released');
  assert.deepEqual({
    armRequests: value.api.armRequests.length,
    cancelRequests: value.api.cancelRequests.length,
    commitRequests: value.api.commitRequests.length,
  }, {
    armRequests: expected.counts.armRequests,
    cancelRequests: expected.counts.cancelRequests,
    commitRequests: expected.counts.commitRequests,
  });
}

async function assertCommitCrashRepaired(value, expected) {
  const disposition = await reconcilerFor(value).reconcile(value.request, {
    originAbortReceipt: value.receipt,
  });
  assert.equal(disposition.kind, 'recovery_authorized');
  const records = await reconciliationRecords(value);
  assert.ok(records.armBinding);
  assert.ok(records.transcriptBoundary);
  assert.ok(records.waiterReady);
  assert.ok(records.commitAttempt);
  assert.ok(records.suspensionCommitted);
  assert.equal(records.terminal, null);
  assert.equal(records.intent.stage, 'commit');
  assert.equal(records.applied.stage, 'commit');
  assert.equal(records.applied.outcome, 'suspension_committed');
  assert.deepEqual(records.applied.apiResponses.map(({ method, replay }) => ({ method, replay })),
    expected.apiResponses);
  assert.equal((await value.protocol.listAwaitRequests()).length, 1);
  assert.equal((await evaluateOrdinaryPrompt(value)).allowed, false);
  assert.deepEqual({
    armRequests: value.api.armRequests.length,
    armApplies: value.api.armApplyCount,
    cancelRequests: value.api.cancelRequests.length,
    cancelApplies: value.api.cancelApplyCount,
    commitRequests: value.api.commitRequests.length,
    commitApplies: value.api.commitApplyCount,
  }, expected.counts);
  await assertReconciliationReceiptsSecretFree(value);

  const duplicate = await reconcilerFor(value).reconcile(value.request, {
    originAbortReceipt: value.receipt,
  });
  assert.equal(duplicate.kind, 'recovery_authorized');
  assert.deepEqual({
    armRequests: value.api.armRequests.length,
    cancelRequests: value.api.cancelRequests.length,
    commitRequests: value.api.commitRequests.length,
  }, {
    armRequests: expected.counts.armRequests,
    cancelRequests: expected.counts.cancelRequests,
    commitRequests: expected.counts.commitRequests,
  });
}

test('N0: a real child returns one Wake through the original held call', {
  timeout: 15_000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-hard-crash-n0-'));
  const api = await new LoopbackAwaitApi().start();
  try {
    const running = startCrashChild('N0', dataDir, api);
    const result = await waitForStage(running, 'normal_result');
    assert.deepEqual(result, {
      pid: running.child.pid,
      stage: 'normal_result',
      version: 'hark.await-satisfied.v1',
      wakeId: TARGET_WAKE_ID,
    });
    const certified = await waitForStage(running, 'n0_certified');
    assert.deepEqual(certified.summary, {
      posted: 1,
      skipped: 0,
      pending: 0,
      failed: 0,
      errors: [],
    });
    assert.equal(certified.terminal.disposition, 'completion_posted');
    assert.equal(certified.terminal.awaitId, TARGET_AWAIT_ID);
    assert.equal(certified.terminal.wakeId, TARGET_WAKE_ID);
    assert.equal(certified.pendingRequestCount, 0);
    await waitForCleanExit(running);

    const protocol = new HarkToolWaitProtocol(dataDir);
    assert.deepEqual(await protocol.listAwaitRequests(), []);
    const [archivedRequestFile] = await findJsonFiles(protocol.awaitRequestArchiveDirectory);
    assert.ok(archivedRequestFile);
    const request = JSON.parse(await readFile(archivedRequestFile, 'utf8'));
    const armBinding = await protocol.readArmBinding(request);
    const waiterReady = await protocol.readWaiterReady(request, armBinding);
    const committed = await protocol.readSuspensionCommitted(request, armBinding, waiterReady);
    const delivery = await protocol.readWakeDelivery(request, armBinding, committed);
    const boundary = await protocol.readTranscriptBoundary(request, armBinding);
    assert.ok(armBinding);
    assert.ok(waiterReady);
    assert.ok(committed);
    assert.equal(delivery.wakeId, TARGET_WAKE_ID);
    assert.ok(await protocol.readToolResultObservationIntent(
      delivery,
      undefined,
      boundary.boundary,
      'hard-crash-runtime',
      undefined,
    ));
    assert.equal(
      (await protocol.readAwaitRequestTerminal(request)).disposition,
      'completion_posted',
    );
    const receiptKinds = api.runtimeReceiptRequests.map(({ kind }) => kind);
    assert.deepEqual(receiptKinds, ['tool_result_observed', 'task_completed']);
    assert.equal(api.runtimeReceiptAttempts.length, 2);
    assert.equal(receiptKinds.includes('model_call'), false);

    const transcript = (await readFile(request.transcriptPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    const functionCallIndex = transcript.findIndex(
      (entry) => entry.payload?.type === 'function_call'
        && entry.payload.call_id === request.toolUseId,
    );
    const toolOutputIndex = transcript.findIndex(
      (entry) => entry.payload?.type === 'function_call_output'
        && entry.payload.call_id === request.toolUseId,
    );
    assert.equal(functionCallIndex >= 0, true);
    assert.equal(toolOutputIndex > functionCallIndex, true);
    assert.equal(transcript.filter((entry) => entry.type === 'turn_context').length, 1);
    assert.equal(transcript.slice(functionCallIndex + 1, toolOutputIndex).some(
      (entry) => entry.type === 'turn_context'
        || entry.payload?.type === 'message'
        || entry.payload?.type === 'model_call',
    ), false);
    const assistant = transcript.find(
      (entry) => entry.payload?.type === 'message' && entry.payload.role === 'assistant',
    );
    const completion = transcript.find(
      (entry) => entry.payload?.type === 'task_complete',
    );
    assert.equal(
      assistant.payload.internal_chat_message_metadata_passthrough.turn_id,
      request.turnId,
    );
    assert.equal(completion.payload.turn_id, request.turnId);
    assert.deepEqual({
      armRequests: api.armRequests.length,
      armApplies: api.armApplyCount,
      commitRequests: api.commitRequests.length,
      commitApplies: api.commitApplyCount,
      wakeRequests: api.wakeRequests.length,
      cancels: api.cancelApplyCount,
    }, {
      armRequests: 1,
      armApplies: 1,
      commitRequests: 1,
      commitApplies: 1,
      wakeRequests: 1,
      cancels: 0,
    });
    assert.deepEqual(await evaluateOrdinaryPrompt({ dataDir, protocol, request }), {
      allowed: true,
      reason: 'thread_not_owned',
    });
  } finally {
    await api.stop();
  }
});

test('A0-A3: actual SIGKILL reconciles every arm/local-bind window once', {
  timeout: 45_000,
}, async (t) => {
  const cases = [
    {
      scenario: 'A0',
      apiResponses: [{ method: 'cancel', replay: false }],
      armResponseReplays: [false],
      cancelResponseReplays: [false],
      counts: {
        armRequests: 1,
        armApplies: 1,
        cancelRequests: 1,
        cancelApplies: 1,
        commitRequests: 0,
        commitApplies: 0,
      },
    },
    ...['A1', 'A2'].map((scenario) => ({
      scenario,
      apiResponses: [{ method: 'cancel', replay: false }],
      armResponseReplays: [false, true],
      cancelResponseReplays: [false],
      counts: {
        armRequests: 2,
        armApplies: 1,
        cancelRequests: 1,
        cancelApplies: 1,
        commitRequests: 0,
        commitApplies: 0,
      },
    })),
    ...['A3_BINDING', 'A3_BOUNDARY', 'A3_READY'].map((scenario) => ({
      scenario,
      apiResponses: [{ method: 'cancel', replay: false }],
      armResponseReplays: [false],
      cancelResponseReplays: [false],
      counts: {
        armRequests: 1,
        armApplies: 1,
        cancelRequests: 1,
        cancelApplies: 1,
        commitRequests: 0,
        commitApplies: 0,
      },
    })),
  ];
  for (const value of cases) {
    await t.test(value.scenario, async () => {
      const crashed = await crashScenario(value.scenario);
      try {
        await assertArmCrashRepaired(crashed, value);
      } finally {
        await crashed.api.stop();
      }
    });
  }
});

test('installation A arm response loss rejects replacement B and replays exactly once for A', {
  timeout: 30_000,
}, async () => {
  const crashed = await crashScenario('I_ARM', { publishAbort: false });
  let replacement;
  let restored;
  try {
    assert.deepEqual(crashed.exit, { code: null, signal: 'SIGKILL' });
    assert.equal(crashed.attempt.v, 'hark.tool-wait.arm-attempt.v2');
    assert.equal(crashed.attempt.installationId, TARGET_INSTALLATION_ID);
    assert.equal(crashed.api.armRequests.length, 1);
    assert.equal(crashed.api.armApplyCount, 1);
    assert.equal(crashed.api.commitApplyCount, 0);
    assert.equal(crashed.api.cancelApplyCount, 0);
    assert.equal(crashed.api.targetClaimApplyCount, 0);
    assert.equal(crashed.api.installationStatusRequests.every(
      ({ id }) => id === TARGET_INSTALLATION_ID,
    ), true);

    const preparedAbort = await preparePositiveAbortProof(
      crashed.protocol,
      crashed.request,
      crashed.exit,
      { persist: false },
    );
    crashed.receipt = preparedAbort.receipt;
    const beforeReplacement = await snapshotJsonTree(crashed.dataDir);
    const networkBeforeReplacement = crashed.api.networkRequests.length;
    const statefulBeforeReplacement = crashed.api.statefulRequests.length;
    assert.deepEqual(await evaluateOrdinaryPrompt(crashed), {
      allowed: false,
      reason: 'This Codex thread is asleep in Hark. Cancel its Await or let Hark wake it.',
    });

    replacement = startReconcilerChild(
      crashed,
      '',
      crashed.receipt,
      {
        installationId: REPLACEMENT_INSTALLATION_ID,
        accessToken: TEST_ACCESS_TOKEN_B,
      },
    );
    const rejected = await waitForStage(replacement, 'reconcile_rejected');
    assert.equal([
      rejected.error,
      rejected.cause,
    ].some((value) => value?.includes('installation_identity_fence')), true);
    await waitForCleanExit(replacement);
    replacement = null;
    assert.deepEqual(
      crashed.api.networkRequests.slice(networkBeforeReplacement),
      [{
        installationId: REPLACEMENT_INSTALLATION_ID,
        method: 'GET',
        pathname: '/api/hark/v2/installations/self',
      }],
    );
    assert.equal(crashed.api.statefulRequests.length, statefulBeforeReplacement);
    assert.deepEqual(await snapshotJsonTree(crashed.dataDir), beforeReplacement);
    assert.deepEqual(await evaluateOrdinaryPrompt(crashed), {
      allowed: false,
      reason: 'This Codex thread is asleep in Hark. Cancel its Await or let Hark wake it.',
    });

    restored = startReconcilerChild(crashed, '', crashed.receipt);
    const completed = await waitForStage(restored, 'reconcile_complete');
    assert.equal(completed.kind, 'released');
    await waitForCleanExit(restored);
    restored = null;
    assert.deepEqual({
      armRequests: crashed.api.armRequests.length,
      armApplies: crashed.api.armApplyCount,
      cancelRequests: crashed.api.cancelRequests.length,
      cancelApplies: crashed.api.cancelApplyCount,
      commitApplies: crashed.api.commitApplyCount,
      targetClaimApplies: crashed.api.targetClaimApplyCount,
    }, {
      armRequests: 2,
      armApplies: 1,
      cancelRequests: 1,
      cancelApplies: 1,
      commitApplies: 0,
      targetClaimApplies: 0,
    });
    assert.deepEqual(crashed.api.armResponseReplays, [false, true]);
    assert.deepEqual(await crashed.protocol.listAwaitRequests(), []);
    assert.deepEqual(await evaluateOrdinaryPrompt(crashed), {
      allowed: true,
      reason: 'thread_not_owned',
    });

    const statefulAfterRecovery = crashed.api.statefulRequests.length;
    const duplicate = await runFreshReconciler(crashed);
    assert.equal(duplicate.kind, 'released');
    assert.equal(crashed.api.statefulRequests.length, statefulAfterRecovery);
  } finally {
    await terminateIfRunning(replacement);
    await terminateIfRunning(restored);
    crashed.api.release('arm');
    await crashed.api.stop();
  }
});

test('PostToolUse error lifecycle refuses installation B and completes once after A returns', {
  timeout: 30_000,
}, async () => {
  const crashed = await crashScenario('I_ARM', { publishAbort: false });
  const children = [];
  try {
    const hookInput = await postToolErrorInput(crashed);
    const beforeReplacement = await snapshotJsonTree(crashed.dataDir);
    const networkBeforeReplacement = crashed.api.networkRequests.length;
    const statefulBeforeReplacement = crashed.api.statefulRequests.length;

    const replacement = startInstallationToolErrorChild(crashed, hookInput, {
      installationId: REPLACEMENT_INSTALLATION_ID,
      accessToken: TEST_ACCESS_TOKEN_B,
    });
    children.push(replacement);
    const rejected = await waitForStage(replacement, 'installation_tool_error_rejected');
    assert.equal([
      rejected.error,
      rejected.cause,
    ].some((value) => value?.includes('installation_identity_fence')), true);
    await waitForCleanExit(replacement);
    children.splice(children.indexOf(replacement), 1);
    assert.deepEqual(
      crashed.api.networkRequests.slice(networkBeforeReplacement),
      [{
        installationId: REPLACEMENT_INSTALLATION_ID,
        method: 'GET',
        pathname: '/api/hark/v2/installations/self',
      }],
    );
    assert.equal(crashed.api.statefulRequests.length, statefulBeforeReplacement);
    assert.deepEqual(await snapshotJsonTree(crashed.dataDir), beforeReplacement);
    assert.equal(await crashed.protocol.readToolError(crashed.request), null);
    assert.equal(await crashed.protocol.readArmBinding(crashed.request), null);
    assert.deepEqual(await evaluateOrdinaryPrompt(crashed), {
      allowed: false,
      reason: 'This Codex thread is asleep in Hark. Cancel its Await or let Hark wake it.',
    });

    const restored = startInstallationToolErrorChild(crashed, hookInput);
    children.push(restored);
    const completed = await waitForStage(restored, 'installation_tool_error_complete');
    assert.deepEqual(completed.result, {
      accepted: false,
      reason: 'tool_result_error',
    });
    await waitForCleanExit(restored);
    children.splice(children.indexOf(restored), 1);
    assert.deepEqual({
      armRequests: crashed.api.armRequests.length,
      armApplies: crashed.api.armApplyCount,
      cancelRequests: crashed.api.cancelRequests.length,
      cancelApplies: crashed.api.cancelApplyCount,
      commitApplies: crashed.api.commitApplyCount,
      targetClaimApplies: crashed.api.targetClaimApplyCount,
    }, {
      armRequests: 2,
      armApplies: 1,
      cancelRequests: 1,
      cancelApplies: 1,
      commitApplies: 0,
      targetClaimApplies: 0,
    });
    assert.deepEqual(crashed.api.armResponseReplays, [false, true]);
    assert.deepEqual(await crashed.protocol.listAwaitRequests(), []);
    assert.deepEqual(await evaluateOrdinaryPrompt(crashed), {
      allowed: true,
      reason: 'thread_not_owned',
    });
  } finally {
    await Promise.all(children.map(terminateIfRunning));
    crashed.api.release('arm');
    await crashed.api.stop();
  }
});

test('legacy supervisor observed preparation cannot arm under replacement or missing identity', {
  timeout: 30_000,
}, async (t) => {
  await t.test('installation A binding rejects B and arms once when A returns', async () => {
    const value = await prepareLegacyObservedPreparation();
    const children = [];
    try {
      const beforeReplacement = await snapshotJsonTree(value.dataDir);
      assert.deepEqual(await evaluateOrdinaryPrompt(value), {
        allowed: false,
        reason: 'This Codex thread is asleep in Hark. Cancel its Await or let Hark wake it.',
      });
      const replacement = startLegacySupervisorChild(value, {
        installationId: REPLACEMENT_INSTALLATION_ID,
        accessToken: TEST_ACCESS_TOKEN_B,
      });
      children.push(replacement);
      const rejected = await waitForStage(replacement, 'legacy_supervisor_rejected');
      assert.equal([
        rejected.error,
        rejected.cause,
      ].some((candidate) => candidate?.includes('installation_identity')), true);
      await waitForCleanExit(replacement);
      children.splice(children.indexOf(replacement), 1);
      assert.deepEqual(value.api.networkRequests, [{
        installationId: REPLACEMENT_INSTALLATION_ID,
        method: 'GET',
        pathname: '/api/hark/v2/installations/self',
      }]);
      assert.equal(value.api.statefulRequests.length, 0);
      assert.deepEqual(await snapshotJsonTree(value.dataDir), beforeReplacement);
      assert.equal(
        (await value.journal.read()).preparations[value.preparationNonce].state,
        'observed',
      );

      const restored = startLegacySupervisorChild(value);
      children.push(restored);
      const completed = await waitForStage(restored, 'legacy_supervisor_complete');
      await waitForCleanExit(restored);
      children.splice(children.indexOf(restored), 1);
      assert.equal(completed.preparations[value.preparationNonce].state, 'armed');
      assert.equal(Object.keys(completed.awaits).length, 1);
      assert.equal(value.api.armRequests.length, 1);
      assert.equal(value.api.armApplyCount, 1);
      assert.equal(value.api.commitApplyCount, 0);
      assert.equal(value.api.cancelApplyCount, 0);
      assert.equal(value.api.statefulRequests.filter(
        ({ pathname }) => pathname === '/api/hark/v2/awaits',
      ).length, 1);

      const statefulAfterArm = value.api.statefulRequests.length;
      const duplicate = startLegacySupervisorChild(value);
      children.push(duplicate);
      await waitForStage(duplicate, 'legacy_supervisor_complete');
      await waitForCleanExit(duplicate);
      children.splice(children.indexOf(duplicate), 1);
      assert.equal(value.api.statefulRequests.length, statefulAfterArm);
    } finally {
      await Promise.all(children.map(terminateIfRunning));
      await value.api.stop();
    }
  });

  await t.test('missing installation identity remains observed and guarded', async () => {
    const value = await prepareLegacyObservedPreparation({ installation: false });
    let child;
    try {
      const before = await snapshotJsonTree(value.dataDir);
      child = startLegacySupervisorChild(value);
      const rejected = await waitForStage(child, 'legacy_supervisor_rejected');
      assert.equal(rejected.error.includes('installation'), true);
      await waitForCleanExit(child);
      child = null;
      assert.equal(value.api.statefulRequests.length, 0);
      assert.deepEqual(await snapshotJsonTree(value.dataDir), before);
      assert.equal(
        (await value.journal.read()).preparations[value.preparationNonce].state,
        'observed',
      );
      assert.deepEqual(await evaluateOrdinaryPrompt(value), {
        allowed: false,
        reason: 'This Codex thread is asleep in Hark. Cancel its Await or let Hark wake it.',
      });
    } finally {
      await terminateIfRunning(child);
      await value.api.stop();
    }
  });
});

test('C0-C2: actual SIGKILL reconciles commit/local-marker without cancellation', {
  timeout: 30_000,
}, async (t) => {
  const cases = [
    {
      scenario: 'C0',
      apiResponses: [{ method: 'commit', replay: false }],
      counts: {
        armRequests: 1,
        armApplies: 1,
        cancelRequests: 0,
        cancelApplies: 0,
        commitRequests: 1,
        commitApplies: 1,
      },
    },
    ...['C1', 'C2'].map((scenario) => ({
      scenario,
      apiResponses: [{ method: 'commit', replay: true }],
      counts: {
        armRequests: 1,
        armApplies: 1,
        cancelRequests: 0,
        cancelApplies: 0,
        commitRequests: 2,
        commitApplies: 1,
      },
    })),
  ];
  for (const value of cases) {
    await t.test(value.scenario, async () => {
      const crashed = await crashScenario(value.scenario);
      try {
        await assertCommitCrashRepaired(crashed, value);
      } finally {
        await crashed.api.stop();
      }
    });
  }
});

test('commit and cancel contenders obey one O_EXCL transition authority across SIGKILL', {
  timeout: 45_000,
}, async (t) => {
  await t.test('commit authority survives owner SIGKILL and forbids cancellation', async () => {
    const crashed = await crashScenario('I_COMMIT_AUTHORITY', { publishAbort: false });
    let lifecycle;
    try {
      const armBinding = await crashed.protocol.readArmBinding(crashed.request);
      const waiterReady = await crashed.protocol.readWaiterReady(crashed.request, armBinding);
      const authority = await crashed.protocol.readHeldCallTransitionAuthority(
        crashed.request,
        crashed.attempt,
        { armBinding, waiterReady },
      );
      assert.equal(authority.decision, 'commit');
      assert.equal(authority.installationId, TARGET_INSTALLATION_ID);
      assert.equal(await crashed.protocol.readCommitAttempt(
        crashed.request,
        armBinding,
        waiterReady,
      ), null);
      assert.equal(crashed.api.commitApplyCount, 0);
      assert.equal(crashed.api.cancelApplyCount, 0);

      lifecycle = startInstallationToolErrorChild(
        crashed,
        await postToolErrorInput(crashed),
      );
      const completed = await waitForStage(lifecycle, 'installation_tool_error_complete');
      assert.deepEqual(completed.result, {
        accepted: false,
        reason: 'tool_result_error',
      });
      await waitForCleanExit(lifecycle);
      lifecycle = null;
      assert.equal(crashed.api.armApplyCount, 1);
      assert.equal(crashed.api.commitRequests.length, 1);
      assert.equal(crashed.api.commitApplyCount, 1);
      assert.equal(crashed.api.cancelRequests.length, 0);
      assert.equal(crashed.api.cancelApplyCount, 0);
      assert.ok(await crashed.protocol.readCommitAttempt(
        crashed.request,
        armBinding,
        waiterReady,
      ));
      assert.ok(await crashed.protocol.readSuspensionCommitted(
        crashed.request,
        armBinding,
        waiterReady,
      ));
      assert.equal((await crashed.protocol.listAwaitRequests()).length, 1);
      assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
    } finally {
      await terminateIfRunning(lifecycle);
      await crashed.api.stop();
    }
  });

  await t.test('cancel authority blocks the paused normal MCP commit contender', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-transition-cancel-wins-'));
    const api = await new LoopbackAwaitApi().start();
    const protocol = new HarkToolWaitProtocol(dataDir);
    const running = startCrashChild('I_BEFORE_COMMIT_AUTHORITY', dataDir, api);
    let lifecycle;
    try {
      await waitForStage(running, 'before_commit_transition_authority');
      const [request] = await protocol.listAwaitRequests();
      assert.ok(request);
      const attempt = await protocol.readArmAttempt(request);
      const armBinding = await protocol.readArmBinding(request);
      const waiterReady = await protocol.readWaiterReady(request, armBinding);
      assert.ok(attempt);
      assert.ok(armBinding);
      assert.ok(waiterReady);
      assert.equal(await protocol.readHeldCallTransitionAuthority(request, attempt), null);
      const value = { api, dataDir, protocol, request };
      lifecycle = startInstallationToolErrorChild(value, await postToolErrorInput(value));
      const completed = await waitForStage(lifecycle, 'installation_tool_error_complete');
      assert.deepEqual(completed.result, {
        accepted: false,
        reason: 'tool_result_error',
      });
      await waitForCleanExit(lifecycle);
      lifecycle = null;
      const toolError = await protocol.readToolError(request);
      const observation = await protocol.readToolErrorObservation(request, toolError);
      const authority = await protocol.readHeldCallTransitionAuthority(
        request,
        attempt,
        { armBinding, toolError, toolErrorObservation: observation },
      );
      assert.equal(authority.decision, 'cancel');
      assert.equal(authority.installationId, TARGET_INSTALLATION_ID);
      assert.equal(api.cancelRequests.length, 1);
      assert.equal(api.cancelApplyCount, 1);
      assert.equal(api.commitRequests.length, 0);
      assert.equal(api.commitApplyCount, 0);

      running.child.stdin.write('continue\n');
      const lost = await waitForStage(running, 'commit_transition_authority_lost');
      assert.equal(lost.decision, 'cancel');
      await sigkill(running);
      assert.equal(api.commitRequests.length, 0);
      assert.equal(api.commitApplyCount, 0);
      assert.deepEqual(await protocol.listAwaitRequests(), []);
      assert.deepEqual(await evaluateOrdinaryPrompt(value), {
        allowed: true,
        reason: 'thread_not_owned',
      });
      const authorityFiles = await findJsonFiles(
        protocol.heldCallTransitionAuthorityDirectory,
      );
      assert.equal(authorityFiles.length, 1);
      const rawAuthority = await readFile(authorityFiles[0], 'utf8');
      for (const forbidden of [TEST_ACCESS_TOKEN, TEST_ACCESS_TOKEN_B, 'accessToken']) {
        assert.equal(rawAuthority.includes(forbidden), false, forbidden);
      }
    } finally {
      await terminateIfRunning(lifecycle);
      await terminateIfRunning(running);
      await api.stop();
    }
  });
});

test('EEXIST observer seals a SIGKILLed transition winner before its remote action', {
  timeout: 30_000,
  skip: process.platform === 'linux' ? false : 'requires Linux strace syscall injection',
}, async () => {
  const value = await crashScenario('A3_READY');
  let linker;
  let observer;
  try {
    const evidence = await publishObservedToolError(value);
    linker = startStracedCommitContender(value, {
      inject: 'link,linkat:signal=SIGSTOP:when=1',
      traceName: 'transition-linker-after-link',
    });
    const linkerReady = await waitForStage(linker, 'transition_authority_contender_ready');
    assert.equal(linkerReady.contender, 'commit');
    linker.child.stdin.write('release\n');
    const linkBoundary = await waitForAuthoritySyscallBoundary(
      linker,
      value,
      { operation: 'final_link', phase: 'after' },
      linkerReady.pid,
    );
    assert.equal(linkBoundary.stopped, true);
    assert.equal(linkBoundary.files.finalExists, true);
    assert.equal(linkBoundary.files.tempNames.length, 1);
    assert.equal(value.api.commitApplyCount, 0);
    assert.equal(value.api.cancelApplyCount, 0);
    assert.equal((await evaluateOrdinaryPrompt(value)).allowed, false);
    await sigkillStraced(linker, linkerReady.pid);
    linker = null;

    observer = startStracedCancelContender(value, {
      inject: 'fsync:signal=SIGSTOP:when=2',
      traceName: 'transition-eexist-observer',
    });
    const observerReady = await waitForStage(
      observer,
      'transition_authority_contender_ready',
    );
    assert.equal(observerReady.contender, 'cancel');
    observer.child.stdin.write('release\n');
    const observerSealed = await waitUntil(async () => {
      const trace = await readTrace(observer);
      const facts = authorityTraceFacts(trace, value);
      if (
        !await traceeStopped(observerReady.pid)
        || facts.linkEexists.length !== 1
        || facts.directoryFsyncSuccesses.length !== 1
      ) return null;
      return { trace, facts };
    }, 10_000);
    assert.equal(value.api.commitRequests.length, 0);
    assert.equal(value.api.commitApplyCount, 0);
    assert.equal(value.api.cancelRequests.length, 0);
    assert.equal(value.api.cancelApplyCount, 0);
    process.kill(observerReady.pid, 'SIGCONT');
    const elected = await waitForStage(observer, 'transition_authority_contender_elected');
    assert.deepEqual({ created: elected.created, decision: elected.decision }, {
      created: false,
      decision: 'commit',
    });
    const remoteStart = await waitForStage(observer, 'transition_remote_action_start');
    assert.equal(remoteStart.decision, 'commit');
    const completed = await waitForStage(observer, 'transition_cancel_contender_complete');
    assert.equal(completed.decision, 'commit');
    await waitForCleanExit(observer);
    const observerTrace = await readTrace(observer);
    const observerStages = observer.stages.slice();

    const eexistIndex = observerTrace.indexOf(observerSealed.facts.linkEexists[0]);
    assert.notEqual(eexistIndex, -1, observerTrace);
    const sealIndex = observerTrace.indexOf(
      observerSealed.facts.directoryFsyncSuccesses[0],
    );
    assert.equal(sealIndex > eexistIndex, true, observerTrace);
    const hostLinkSyscalls = new Set([
      ...linkBoundary.facts.linkSuccesses,
      ...observerSealed.facts.linkEexists,
    ].map(authorityLinkSyscall));
    assert.equal(hostLinkSyscalls.size, 1);
    assert.equal(['link', 'linkat'].includes([...hostLinkSyscalls][0]), true);
    const electedIndex = observerStages.findIndex(
      (stage) => stage.stage === 'transition_authority_contender_elected',
    );
    const remoteIndex = observerStages.findIndex(
      (stage) => stage.stage === 'transition_remote_action_start',
    );
    assert.equal(electedIndex >= 0 && remoteIndex > electedIndex, true);
    observer = null;

    const armBinding = await value.protocol.readArmBinding(value.request);
    const waiterReady = await value.protocol.readWaiterReady(value.request, armBinding);
    const authority = await value.protocol.readHeldCallTransitionAuthority(
      value.request,
      value.attempt,
      { armBinding, waiterReady },
    );
    assert.equal(authority.decision, 'commit');
    assert.equal((await findJsonFiles(
      value.protocol.heldCallTransitionAuthorityDirectory,
    )).length, 1);
    assert.equal(value.api.commitRequests.length, 1);
    assert.equal(value.api.commitApplyCount, 1);
    assert.equal(value.api.cancelRequests.length, 0);
    assert.equal(value.api.cancelApplyCount, 0);
    assert.equal((await evaluateOrdinaryPrompt(value)).allowed, false);
    const recovered = await runFreshReconciler(value);
    assert.equal(recovered.kind, 'recovery_authorized');
    assert.equal(value.api.commitRequests.length, 2);
    assert.equal(value.api.commitApplyCount, 1);
    assert.deepEqual(value.api.commitResponseReplays, [false, true]);
    assert.equal(value.api.cancelRequests.length, 0);
    await assertAuthorityArtifactsSecretFree(value);
    assert.ok(evidence.toolError);
  } finally {
    await terminateIfRunning(linker);
    await terminateIfRunning(observer);
    await value.api.stop();
  }
});

test('simultaneous straced commit and cancel contenders race at the atomic link once', {
  timeout: 30_000,
  skip: process.platform === 'linux' ? false : 'requires Linux strace syscall injection',
}, async () => {
  const value = await crashScenario('A3_READY');
  let commit;
  let cancel;
  try {
    const { toolError, toolErrorObservation } = await publishObservedToolError(value);
    const inject = 'link,linkat:delay_enter=1500ms:when=1';
    commit = startStracedCommitContender(value, {
      inject,
      traceName: 'transition-simultaneous-commit',
    });
    cancel = startStracedToolErrorLifecycle(value, {
      inject,
      traceName: 'transition-simultaneous-cancel',
    });
    const [commitReady, cancelReady] = await Promise.all([
      waitForStage(commit, 'transition_authority_contender_ready'),
      waitForStage(cancel, 'transition_authority_contender_ready'),
    ]);
    assert.equal(commitReady.contender, 'commit');
    assert.equal(cancelReady.contender, 'cancel');
    assert.equal(await value.protocol.readHeldCallTransitionAuthority(
      value.request,
      value.attempt,
      { armBinding: await value.protocol.readArmBinding(value.request) },
    ), null);
    commit.child.stdin.write('release\n');
    cancel.child.stdin.write('release\n');

    await waitUntil(async () => {
      const files = await authorityFileState(value.protocol, value.request);
      const [commitTrace, cancelTrace] = await Promise.all([
        readTrace(commit),
        readTrace(cancel),
      ]);
      const commitFacts = authorityTraceFacts(commitTrace, value);
      const cancelFacts = authorityTraceFacts(cancelTrace, value);
      return files.finalExists === false
        && files.tempNames.length === 2
        && commitFacts.tempFsyncSuccesses.length === 1
        && cancelFacts.tempFsyncSuccesses.length === 1
        && delayedAuthoritySyscallEntered(commitTrace, value, 'final_link')
        && delayedAuthoritySyscallEntered(cancelTrace, value, 'final_link');
    }, 10_000);

    const [commitElection, cancelElection] = await Promise.all([
      waitForStage(commit, 'transition_authority_contender_elected'),
      waitForStage(cancel, 'transition_authority_contender_elected'),
    ]);
    await Promise.all([waitForCleanExit(commit), waitForCleanExit(cancel)]);
    const [commitTrace, cancelTrace] = await Promise.all([
      readTrace(commit),
      readTrace(cancel),
    ]);
    commit = null;
    cancel = null;

    const elections = [commitElection, cancelElection];
    const [winner] = elections.filter((election) => election.created);
    const [loser] = elections.filter((election) => !election.created);
    assert.ok(winner);
    assert.ok(loser);
    assert.equal(loser.decision, winner.decision);
    assert.equal(winner.contender, winner.decision);
    assert.notEqual(loser.contender, winner.decision);
    const facts = [
      authorityTraceFacts(commitTrace, value),
      authorityTraceFacts(cancelTrace, value),
    ];
    assert.equal(facts.reduce((count, entry) => count + entry.linkSuccesses.length, 0), 1);
    assert.equal(facts.reduce((count, entry) => count + entry.linkEexists.length, 0), 1);
    const hostLinkSyscalls = new Set(facts.flatMap((entry) => [
      ...entry.linkSuccesses,
      ...entry.linkEexists,
    ]).map(authorityLinkSyscall));
    assert.equal(hostLinkSyscalls.size, 1);
    assert.equal(['link', 'linkat'].includes([...hostLinkSyscalls][0]), true);
    const loserTrace = loser.contender === 'commit' ? commitTrace : cancelTrace;
    const loserFacts = authorityTraceFacts(loserTrace, value);
    assert.equal(loserFacts.linkEexists.length, 1);
    assert.equal(loserFacts.directoryFsyncSuccesses.length, 1);
    assert.equal(
      loserTrace.indexOf(loserFacts.directoryFsyncSuccesses[0])
        > loserTrace.indexOf(loserFacts.linkEexists[0]),
      true,
      loserTrace,
    );

    const armBinding = await value.protocol.readArmBinding(value.request);
    const waiterReady = await value.protocol.readWaiterReady(value.request, armBinding);
    const authority = await value.protocol.readHeldCallTransitionAuthority(
      value.request,
      value.attempt,
      winner.decision === 'commit'
        ? { armBinding, waiterReady }
        : { armBinding, toolError, toolErrorObservation },
    );
    assert.equal(authority.decision, winner.decision);
    assert.equal((await findJsonFiles(
      value.protocol.heldCallTransitionAuthorityDirectory,
    )).length, 1);
    assert.equal(value.api.commitApplyCount, winner.decision === 'commit' ? 1 : 0);
    assert.equal(value.api.cancelApplyCount, winner.decision === 'cancel' ? 1 : 0);
    assert.equal(value.api.commitApplyCount + value.api.cancelApplyCount, 1);
    assert.equal(value.api.commitRequests.length > 0, winner.decision === 'commit');
    assert.equal(value.api.cancelRequests.length > 0, winner.decision === 'cancel');
    assert.equal(
      (await evaluateOrdinaryPrompt(value)).allowed,
      winner.decision === 'cancel',
    );
    await assertAuthorityArtifactsSecretFree(value);
  } finally {
    await terminateIfRunning(commit);
    await terminateIfRunning(cancel);
    await value.api.stop();
  }
});

test('transition authority temp O_EXCL creation is a real straced SIGKILL boundary', {
  timeout: 45_000,
  skip: process.platform === 'linux' ? false : 'requires Linux strace syscall injection',
}, async (t) => {
  for (const phase of ['before', 'after']) {
    await t.test(phase, async () => {
      const value = await crashScenario('C0');
      let running;
      try {
        const boundary = { operation: 'temp_create', phase };
        running = startStracedCommitContender(value, {
          inject: transitionSyscallInjection(boundary),
          traceName: `transition-temp-create-${phase}`,
          // With one libuv worker, six pre-existing worker openat calls plus
          // these 100 pads make the authority O_EXCL openat exactly #107.
          openatPad: 100,
        });
        const ready = await waitForStage(running, 'transition_authority_contender_ready');
        running.child.stdin.write('release\n');
        const hit = await waitForAuthoritySyscallBoundary(
          running,
          value,
          boundary,
          ready.pid,
        );
        assert.equal(hit.delayed, phase === 'before');
        assert.equal(hit.stopped, phase === 'after');
        assert.equal(hit.facts.tempOpenLines.length, 1);
        assert.equal(hit.facts.tempOpenSuccesses.length, phase === 'after' ? 1 : 0);
        assert.equal(value.api.commitApplyCount, 0);
        assert.equal(value.api.cancelApplyCount, 0);
        assert.equal((await evaluateOrdinaryPrompt(value)).allowed, false);
        if (phase === 'after') {
          const [tempName] = hit.files.tempNames;
          const tempMetadata = await stat(path.join(
            value.protocol.heldCallTransitionAuthorityDirectory,
            tempName,
          ));
          assert.equal(tempMetadata.size, 0);
          assert.equal(tempMetadata.mode & 0o077, 0);
        }
        await sigkillStraced(running, ready.pid);
        running = null;

        const recovered = await runFreshReconciler(value);
        assert.equal(recovered.kind, 'recovery_authorized');
        const records = await reconciliationRecords(value);
        const authority = await value.protocol.readHeldCallTransitionAuthority(
          value.request,
          value.attempt,
          { armBinding: records.armBinding, waiterReady: records.waiterReady },
        );
        assert.equal(authority.decision, 'commit');
        assert.equal((await findJsonFiles(
          value.protocol.heldCallTransitionAuthorityDirectory,
        )).length, 1);
        assert.equal(value.api.commitApplyCount, 1);
        assert.equal(value.api.cancelApplyCount, 0);
        assert.equal((await evaluateOrdinaryPrompt(value)).allowed, false);
        await assertAuthorityArtifactsSecretFree(value);
      } finally {
        await terminateIfRunning(running);
        await value.api.stop();
      }
    });
  }
});

test('transition authority publishImmutable survives every internal straced SIGKILL boundary', {
  timeout: 180_000,
  skip: process.platform === 'linux' ? false : 'requires Linux strace syscall injection',
}, async (t) => {
  const boundaries = ['temp_fsync', 'final_link', 'directory_fsync'].flatMap(
    (operation) => ['before', 'after'].map((phase) => ({ operation, phase })),
  );
  for (const decision of ['commit', 'cancel']) {
    for (const boundary of boundaries) {
      await t.test(`${decision}:${boundary.phase}:${boundary.operation}`, async () => {
        const value = await crashScenario(decision === 'commit' ? 'C0' : 'A3_READY');
        let running;
        try {
          assert.equal(await value.protocol.readHeldCallTransitionAuthority(
            value.request,
            value.attempt,
            { armBinding: await value.protocol.readArmBinding(value.request) },
          ), null);
          running = startStracedReconcilerChild(value, {
            inject: transitionSyscallInjection(boundary),
            traceName: `transition-${decision}-${boundary.phase}-${boundary.operation}`,
            // The positive receipt is already immutable. Passing it again
            // would make its idempotent append, not authority publication,
            // the first traced fsync/link sequence.
            receipt: null,
          });
          const ready = await waitForStage(
            running,
            'transition_authority_contender_ready',
          );
          running.child.stdin.write('release\n');
          const hit = await waitForAuthoritySyscallBoundary(
            running,
            value,
            boundary,
            ready.pid,
          );
          assert.equal(hit.delayed, boundary.phase === 'before');
          assert.equal(hit.stopped, boundary.phase === 'after');
          assert.equal(value.api.commitApplyCount, 0);
          assert.equal(value.api.cancelApplyCount, 0);
          assert.equal((await evaluateOrdinaryPrompt(value)).allowed, false);
          await sigkillStraced(running, ready.pid);
          running = null;

          const recovered = await runFreshReconciler(value);
          assert.equal(recovered.kind, decision === 'commit' ? 'recovery_authorized' : 'released');
          const records = await reconciliationRecords(value);
          const authority = await value.protocol.readHeldCallTransitionAuthority(
            value.request,
            value.attempt,
            decision === 'commit'
              ? { armBinding: records.armBinding, waiterReady: records.waiterReady }
              : { armBinding: records.armBinding, originAbortReceipt: value.receipt },
          );
          assert.equal(authority.decision, decision);
          assert.equal((await findJsonFiles(
            value.protocol.heldCallTransitionAuthorityDirectory,
          )).length, 1);
          assert.equal(value.api.commitApplyCount, decision === 'commit' ? 1 : 0);
          assert.equal(value.api.cancelApplyCount, decision === 'cancel' ? 1 : 0);
          assert.equal(value.api.commitApplyCount + value.api.cancelApplyCount, 1);
          assert.equal(
            (await evaluateOrdinaryPrompt(value)).allowed,
            decision === 'cancel',
          );
          await assertAuthorityArtifactsSecretFree(value);
        } finally {
          await terminateIfRunning(running);
          await value.api.stop();
        }
      });
    }
  }
});

test('a durable observed tool error cannot override an existing commit attempt', {
  timeout: 15_000,
}, async () => {
  const crashed = await crashScenario('C0');
  try {
    const toolError = (await crashed.protocol.publishToolError(crashed.request, {
      failureCode: 'commit_outcome_ambiguous',
      errorDigest: 'd'.repeat(64),
    }, () => new Date('2026-08-07T12:00:14.000Z'))).toolError;
    await crashed.protocol.publishToolErrorObservation(
      crashed.request,
      toolError,
      { responseDigest: 'f'.repeat(64) },
      () => new Date('2026-08-07T12:00:15.000Z'),
    );

    const repaired = await runFreshReconciler(crashed);
    assert.equal(repaired.kind, 'recovery_authorized');
    const records = await reconciliationRecords(crashed);
    assert.equal(records.intent.stage, 'commit');
    assert.equal(records.applied.stage, 'commit');
    assert.equal(records.applied.outcome, 'suspension_committed');
    assert.ok(records.suspensionCommitted);
    assert.equal(records.terminal, null);
    assert.equal(crashed.api.commitRequests.length, 1);
    assert.equal(crashed.api.commitApplyCount, 1);
    assert.equal(crashed.api.cancelRequests.length, 0);
    assert.equal(crashed.api.cancelApplyCount, 0);
    assert.equal((await crashed.protocol.listAwaitRequests()).length, 1);
    assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);

    const remoteCounts = {
      commit: crashed.api.commitRequests.length,
      cancel: crashed.api.cancelRequests.length,
    };
    assert.equal((await runFreshReconciler(crashed)).kind, 'recovery_authorized');
    assert.deepEqual({
      commit: crashed.api.commitRequests.length,
      cancel: crashed.api.cancelRequests.length,
    }, remoteCounts);
  } finally {
    await crashed.api.stop();
  }
});

test('reconciler arm path survives SIGKILL before and after every write and response', {
  timeout: 180_000,
}, async (t) => {
  const failpoints = [
    ...[
      'intent',
      'transition_authority',
      'arm_binding',
      'transcript_boundary',
      'waiter_ready',
      'terminal',
      'applied',
      'archive',
    ].flatMap((label) => ['before', 'after'].map((phase) => `${phase}:${label}`)),
    'before:arm_request',
    'after:arm_response',
    'before:cancel_request',
    'after:cancel_response',
  ];
  for (const failpoint of failpoints) {
      await t.test(failpoint, async () => {
        const crashed = await crashScenario('A0');
        try {
          await sigkillReconcilerAt(crashed, failpoint);
          const expectedOpen = failpoint === 'after:archive';
          const guardBeforeRestart = await evaluateOrdinaryPrompt(crashed);
          assert.equal(guardBeforeRestart.allowed, expectedOpen, failpoint);
          const completed = await runFreshReconciler(crashed);
          assert.equal(completed.kind, 'released');
          const records = await reconciliationRecords(crashed);
          assert.equal(records.terminal.disposition, 'remote_cancelled');
          assert.equal(records.intent.stage, 'arm');
          assert.equal(records.applied.outcome, 'remote_cancelled');
          assert.deepEqual(await crashed.protocol.listAwaitRequests(), []);
          assert.equal(crashed.api.armApplyCount, 1);
          assert.equal(crashed.api.cancelApplyCount, 1);
          assert.equal(crashed.api.commitApplyCount, 0);
          assert.equal(crashed.api.cancelRequests.length <= 2, true);
          assert.equal(crashed.api.commitRequests.length, 0);
          assert.deepEqual(await evaluateOrdinaryPrompt(crashed), {
            allowed: true,
            reason: 'thread_not_owned',
          });
          await assertReconciliationReceiptsSecretFree(crashed);
        } finally {
          await crashed.api.stop();
        }
      });
  }
});

test('reconciler commit path survives SIGKILL before and after every write and response', {
  timeout: 90_000,
}, async (t) => {
  const failpoints = [
    ...['transition_authority', 'intent', 'suspension_marker', 'applied'].flatMap(
      (label) => ['before', 'after'].map((phase) => `${phase}:${label}`),
    ),
    'before:commit_request',
    'after:commit_response',
  ];
  for (const failpoint of failpoints) {
      await t.test(failpoint, async () => {
        const crashed = await crashScenario('C0');
        try {
          await sigkillReconcilerAt(crashed, failpoint);
          assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false, failpoint);
          const completed = await runFreshReconciler(crashed);
          assert.equal(completed.kind, 'recovery_authorized');
          const records = await reconciliationRecords(crashed);
          assert.equal(records.intent.stage, 'commit');
          assert.ok(records.suspensionCommitted);
          assert.equal(records.applied?.outcome, 'suspension_committed');
          assert.equal((await crashed.protocol.listAwaitRequests()).length, 1);
          assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
          assert.equal(crashed.api.armApplyCount, 1);
          assert.equal(crashed.api.commitApplyCount, 1);
          assert.equal(crashed.api.cancelApplyCount, 0);
          assert.equal(crashed.api.commitRequests.length <= 2, true);
          assert.equal(crashed.api.cancelRequests.length, 0);
          await assertReconciliationReceiptsSecretFree(crashed);
        } finally {
          await crashed.api.stop();
        }
      });
  }
});

test('commit-applied recovery terminal survives actual SIGKILL before archive without remote replay', {
  timeout: 20_000,
}, async () => {
  const crashed = await crashScenario('C0');
  let terminalWriter;
  try {
    assert.equal((await runFreshReconciler(crashed)).kind, 'recovery_authorized');
    const before = await reconciliationRecords(crashed);
    assert.equal(before.intent.stage, 'commit');
    assert.equal(before.applied.stage, 'commit');
    assert.equal(before.applied.outcome, 'suspension_committed');
    assert.equal(before.applied.terminalDigest, null);
    assert.equal(before.terminal, null);
    assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);

    const remoteCounts = {
      armRequests: crashed.api.armRequests.length,
      armApplies: crashed.api.armApplyCount,
      commitRequests: crashed.api.commitRequests.length,
      commitApplies: crashed.api.commitApplyCount,
      cancelRequests: crashed.api.cancelRequests.length,
      cancelApplies: crashed.api.cancelApplyCount,
    };
    const terminalInput = {
      awaitId: before.armBinding.awaitId,
      wakeId: TARGET_WAKE_ID,
      disposition: 'crash_recovery_completed',
      terminalDigest: 'e'.repeat(64),
    };
    terminalWriter = startCrashChild('TERMINAL_ARCHIVE', crashed.dataDir, crashed.api, {
      HARK_CRASH_ROLE: 'terminal_archiver',
      HARK_RECONCILE_REQUEST_JSON: canonicalJson(crashed.request),
      HARK_TERMINAL_INPUT_JSON: canonicalJson(terminalInput),
    });
    const durable = await waitForStage(terminalWriter, 'crash_recovery_terminal_durable');
    assert.equal(durable.pid, terminalWriter.child.pid);
    assert.equal(durable.terminal.disposition, 'crash_recovery_completed');
    assert.equal(durable.terminal.awaitId, before.armBinding.awaitId);
    assert.equal(durable.terminal.wakeId, terminalInput.wakeId);
    assert.equal(durable.terminal.terminalDigest, terminalInput.terminalDigest);
    assert.equal((await findJsonFiles(crashed.protocol.awaitRequestDirectory)).length, 1);
    assert.equal((await findJsonFiles(crashed.protocol.awaitRequestArchiveDirectory)).length, 0);
    const [terminalFile] = await findJsonFiles(crashed.protocol.awaitRequestTerminalDirectory);
    assert.ok(terminalFile);
    assert.deepEqual(JSON.parse(await readFile(terminalFile, 'utf8')), durable.terminal);

    await sigkill(terminalWriter);
    terminalWriter = null;

    const restartedProtocol = new HarkToolWaitProtocol(crashed.dataDir);
    assert.deepEqual(await restartedProtocol.listAwaitRequests(), [crashed.request]);
    assert.deepEqual(
      await restartedProtocol.readAwaitRequestTerminal(crashed.request),
      durable.terminal,
    );
    assert.equal((await findJsonFiles(restartedProtocol.awaitRequestDirectory)).length, 1);
    assert.equal((await findJsonFiles(
      restartedProtocol.awaitRequestArchiveDirectory,
    )).length, 0);
    assert.equal((await evaluateOrdinaryPrompt({
      ...crashed,
      protocol: restartedProtocol,
    })).allowed, false);

    const archived = await runFreshReconciler(crashed);
    assert.equal(archived.kind, 'released');
    assert.equal(archived.reason, 'already_terminal_after_commit_reconciliation');
    assert.deepEqual(await restartedProtocol.listAwaitRequests(), []);
    assert.equal((await findJsonFiles(restartedProtocol.awaitRequestDirectory)).length, 0);
    const [archivedRequestFile] = await findJsonFiles(
      restartedProtocol.awaitRequestArchiveDirectory,
    );
    assert.ok(archivedRequestFile);
    assert.deepEqual(
      JSON.parse(await readFile(archivedRequestFile, 'utf8')),
      crashed.request,
    );
    assert.deepEqual(
      await restartedProtocol.readHeldCallReconciliationApplied(
        crashed.request,
        before.intent,
      ),
      before.applied,
    );
    assert.deepEqual(await evaluateOrdinaryPrompt({
      ...crashed,
      protocol: restartedProtocol,
    }), {
      allowed: true,
      reason: 'thread_not_owned',
    });
    assert.deepEqual({
      armRequests: crashed.api.armRequests.length,
      armApplies: crashed.api.armApplyCount,
      commitRequests: crashed.api.commitRequests.length,
      commitApplies: crashed.api.commitApplyCount,
      cancelRequests: crashed.api.cancelRequests.length,
      cancelApplies: crashed.api.cancelApplyCount,
    }, remoteCounts);
  } finally {
    await terminateIfRunning(terminalWriter);
    await crashed.api.stop();
  }
});

test('P1: missing commit applied retains a later terminal until exact replay repairs and archives', {
  timeout: 20_000,
}, async () => {
  const crashed = await crashScenario('C0');
  let terminalWriter;
  let lifecycleChild;
  try {
    await sigkillReconcilerAt(crashed, 'before:applied');
    const incomplete = await reconciliationRecords(crashed);
    assert.equal(incomplete.intent.stage, 'commit');
    assert.ok(incomplete.suspensionCommitted);
    assert.equal(incomplete.applied, null);
    assert.equal(incomplete.terminal, null);
    assert.equal(crashed.api.commitApplyCount, 1);
    assert.equal(crashed.api.commitRequests.length, 1);
    assert.equal(crashed.api.cancelRequests.length, 0);

    const terminalInput = {
      awaitId: incomplete.armBinding.awaitId,
      wakeId: TARGET_WAKE_ID,
      disposition: 'crash_recovery_completed',
      terminalDigest: '1'.repeat(64),
    };
    terminalWriter = startCrashChild('TERMINAL_ARCHIVE', crashed.dataDir, crashed.api, {
      HARK_CRASH_ROLE: 'terminal_archiver',
      HARK_RECONCILE_REQUEST_JSON: canonicalJson(crashed.request),
      HARK_TERMINAL_INPUT_JSON: canonicalJson(terminalInput),
    });
    const durable = await waitForStage(terminalWriter, 'crash_recovery_terminal_durable');
    assert.equal(durable.pid, terminalWriter.child.pid);
    assert.equal(durable.terminal.disposition, 'crash_recovery_completed');
    assert.equal((await findJsonFiles(crashed.protocol.awaitRequestDirectory)).length, 1);
    assert.equal((await findJsonFiles(crashed.protocol.awaitRequestArchiveDirectory)).length, 0);
    assert.equal((await findJsonFiles(
      crashed.protocol.heldCallReconciliationAppliedDirectory,
    )).length, 0);
    await sigkill(terminalWriter);
    terminalWriter = null;

    const remoteBeforeRetentionPasses = {
      arm: crashed.api.armRequests.length,
      commit: crashed.api.commitRequests.length,
      cancel: crashed.api.cancelRequests.length,
      wake: crashed.api.wakeRequests.length,
      runtimeReceipts: crashed.api.runtimeReceiptAttempts.length,
    };
    lifecycleChild = startCrashChild(
      'TOOL_ERROR_LIFECYCLE',
      crashed.dataDir,
      crashed.api,
      {
        HARK_CRASH_ROLE: 'tool_error_lifecycle',
        HARK_RECONCILE_REQUEST_JSON: canonicalJson(crashed.request),
      },
    );
    const lifecycle = await waitForStage(
      lifecycleChild,
      'tool_error_lifecycle_complete',
    );
    assert.equal(lifecycle.kind, 'owned');
    assert.equal(lifecycle.reason, 'terminal_reconciliation_pending');
    await waitForCleanExit(lifecycleChild);
    lifecycleChild = null;
    assert.deepEqual({
      arm: crashed.api.armRequests.length,
      commit: crashed.api.commitRequests.length,
      cancel: crashed.api.cancelRequests.length,
      wake: crashed.api.wakeRequests.length,
      runtimeReceipts: crashed.api.runtimeReceiptAttempts.length,
    }, remoteBeforeRetentionPasses);
    assert.equal((await findJsonFiles(crashed.protocol.awaitRequestDirectory)).length, 1);
    assert.equal((await findJsonFiles(crashed.protocol.awaitRequestArchiveDirectory)).length, 0);
    assert.equal((await findJsonFiles(
      crashed.protocol.heldCallReconciliationAppliedDirectory,
    )).length, 0);
    assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);

    const repaired = await runFreshReconciler(crashed);
    assert.equal(repaired.kind, 'released');
    assert.equal(repaired.reason, 'terminal_archived_after_commit_reconciliation');
    assert.equal(crashed.api.commitRequests.length, 2);
    assert.equal(crashed.api.commitApplyCount, 1);
    assert.deepEqual(crashed.api.commitResponseReplays, [false, true]);
    assert.equal(
      canonicalJson(crashed.api.commitRequests[0]),
      canonicalJson(crashed.api.commitRequests[1]),
    );
    assert.equal(crashed.api.cancelRequests.length, 0);
    assert.equal(crashed.api.wakeRequests.length, 0);
    assert.equal(crashed.api.runtimeReceiptAttempts.length, 0);

    const restartedProtocol = new HarkToolWaitProtocol(crashed.dataDir);
    assert.deepEqual(await restartedProtocol.listAwaitRequests(), []);
    assert.deepEqual(
      await restartedProtocol.readAwaitRequestTerminal(crashed.request),
      durable.terminal,
    );
    assert.equal((await findJsonFiles(restartedProtocol.awaitRequestDirectory)).length, 0);
    assert.equal((await findJsonFiles(restartedProtocol.awaitRequestArchiveDirectory)).length, 1);
    const repairedRecords = await reconciliationRecords({
      ...crashed,
      protocol: restartedProtocol,
    });
    assert.equal(repairedRecords.applied.stage, 'commit');
    assert.equal(repairedRecords.applied.outcome, 'suspension_committed');
    assert.deepEqual(repairedRecords.applied.apiResponses.map((response) => ({
      method: response.method,
      replay: response.replay,
    })), [{ method: 'commit', replay: true }]);
    assert.deepEqual(await evaluateOrdinaryPrompt({
      ...crashed,
      protocol: restartedProtocol,
    }), {
      allowed: true,
      reason: 'thread_not_owned',
    });
  } finally {
    await terminateIfRunning(terminalWriter);
    await terminateIfRunning(lifecycleChild);
    await crashed.api.stop();
  }
});

test('post-arm freeze survives real SIGKILL before and after durability without cancellation', {
  timeout: 45_000,
}, async (t) => {
  for (const remoteState of ['suspended', 'wake_pending']) {
    for (const phase of ['before', 'after']) {
      await t.test(`${remoteState}:${phase}`, async () => {
        const crashed = await crashScenario('A0');
        try {
          const seeded = await serviceFor(crashed.api).armAwait(crashed.attempt.armRequest);
          assert.equal(seeded.await.state, 'armed');
          assert.equal(seeded.replay, false);
          crashed.api.state = remoteState;
          await sigkillReconcilerAt(
            crashed,
            `${phase}:arm_reconciliation_freeze`,
          );
          assert.equal(crashed.api.armApplyCount, 1);
          assert.equal(crashed.api.armRequests.length, 2);
          assert.equal(crashed.api.commitRequests.length, 0);
          assert.equal(crashed.api.cancelRequests.length, 0);
          assert.equal((await findJsonFiles(
            crashed.protocol.armReconciliationFreezeDirectory,
          )).length, phase === 'after' ? 1 : 0);
          assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);

          const firstRestart = await runFreshReconciler(crashed);
          assert.equal(firstRestart.kind, 'owned');
          assert.equal(firstRestart.reason, 'remote_post_arm_state_without_commit_attempt');
          const freeze = await crashed.protocol.readArmReconciliationFreeze(
            crashed.request,
            crashed.attempt,
          );
          assert.ok(freeze);
          assert.equal(freeze.remoteState, remoteState);
          assert.equal(await crashed.protocol.readArmBinding(crashed.request), null);
          const [freezeFile] = await findJsonFiles(
            crashed.protocol.armReconciliationFreezeDirectory,
          );
          assert.ok(freezeFile);
          const immutableFreeze = await readFile(freezeFile, 'utf8');
          for (const forbidden of [
            TEST_ACCESS_TOKEN,
            'private-lease-token',
            crashed.attempt.bindingToken,
            'bindingToken',
            'leaseToken',
            'accessToken',
          ]) assert.equal(immutableFreeze.includes(forbidden), false, forbidden);

          const toolError = (await crashed.protocol.publishToolError(crashed.request, {
            failureCode: 'arm_outcome_ambiguous',
            errorDigest: 'd'.repeat(64),
          }, () => new Date('2026-08-07T12:00:14.000Z'))).toolError;
          await crashed.protocol.publishToolErrorObservation(
            crashed.request,
            toolError,
            { responseDigest: 'f'.repeat(64) },
            () => new Date('2026-08-07T12:00:15.000Z'),
          );
          const callsAfterRepair = {
            arm: crashed.api.armRequests.length,
            commit: crashed.api.commitRequests.length,
            cancel: crashed.api.cancelRequests.length,
          };
          assert.deepEqual(callsAfterRepair, {
            arm: phase === 'before' ? 3 : 2,
            commit: 0,
            cancel: 0,
          });

          const lifecycle = await new HarkToolErrorLifecycle({
            protocol: new HarkToolWaitProtocol(crashed.dataDir),
            serviceClient: serviceFor(crashed.api),
            credentials: credentialsFor(crashed.api),
          }).reconcile(crashed.request);
          assert.equal(lifecycle.kind, 'owned');
          assert.equal(lifecycle.reason, 'remote_post_arm_state_without_commit_attempt');
          assert.equal(lifecycle.remoteState, remoteState);
          const duplicateRestart = await runFreshReconciler(crashed);
          assert.equal(duplicateRestart.kind, 'owned');
          assert.equal(duplicateRestart.reason, 'tool_error_lifecycle_authoritative');
          assert.deepEqual({
            arm: crashed.api.armRequests.length,
            commit: crashed.api.commitRequests.length,
            cancel: crashed.api.cancelRequests.length,
          }, callsAfterRepair);
          assert.equal(crashed.api.armApplyCount, 1);
          assert.equal(crashed.api.commitApplyCount, 0);
          assert.equal(crashed.api.cancelApplyCount, 0);
          assert.equal(await readFile(freezeFile, 'utf8'), immutableFreeze);
          assert.equal((await findJsonFiles(
            crashed.protocol.armReconciliationFreezeDirectory,
          )).length, 1);
          assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
        } finally {
          await crashed.api.stop();
        }
      });
    }
  }
});

test('simultaneous reconciler children converge on one commit disposition without stealing', {
  timeout: 20_000,
}, async () => {
  const crashed = await crashScenario('C0');
  const children = [];
  try {
    crashed.api.commitResponseBarrier = 2;
    children.push(
      startReconcilerChild(crashed, ''),
      startReconcilerChild(crashed, ''),
    );
    const outcomes = await Promise.all(children.map((child) => (
      waitForStage(child, 'reconcile_complete')
    )));
    await Promise.all(children.map(waitForCleanExit));
    outcomes.forEach((outcome, index) => {
      assert.equal(outcome.kind, 'recovery_authorized', `child ${index}`);
    });

    const records = await reconciliationRecords(crashed);
    assert.equal(records.intent.stage, 'commit');
    assert.equal(records.applied.stage, 'commit');
    assert.equal(records.applied.outcome, 'suspension_committed');
    assert.ok(records.suspensionCommitted);
    assert.equal(records.terminal, null);
    assert.equal((await findJsonFiles(
      crashed.protocol.heldCallReconciliationIntentDirectory,
    )).length, 1);
    assert.equal((await findJsonFiles(
      crashed.protocol.heldCallReconciliationAppliedDirectory,
    )).length, 1);
    assert.equal(crashed.api.armRequests.length, 1);
    assert.equal(crashed.api.armApplyCount, 1);
    assert.equal(crashed.api.commitRequests.length, 2);
    assert.equal(crashed.api.commitApplyCount, 1);
    assert.deepEqual(crashed.api.commitResponseReplays.sort(), [false, true]);
    assert.equal(crashed.api.cancelRequests.length, 0);
    assert.equal(crashed.api.cancelApplyCount, 0);
    assert.equal((await crashed.protocol.listAwaitRequests()).length, 1);
    assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
    await assertReconciliationReceiptsSecretFree(crashed);

    const remoteCounts = {
      arm: crashed.api.armRequests.length,
      commit: crashed.api.commitRequests.length,
      cancel: crashed.api.cancelRequests.length,
    };
    const duplicate = await runFreshReconciler(crashed);
    assert.equal(duplicate.kind, 'recovery_authorized');
    assert.deepEqual({
      arm: crashed.api.armRequests.length,
      commit: crashed.api.commitRequests.length,
      cancel: crashed.api.cancelRequests.length,
    }, remoteCounts);
  } finally {
    await Promise.all(children.map(terminateIfRunning));
    await crashed.api.stop();
  }
});

test('ordered arm-race children preserve exact binding progress and repair missing applied', {
  timeout: 20_000,
}, async () => {
  const crashed = await crashScenario('A0');
  let winner;
  let lagger;
  try {
    crashed.api.armRaceGate = true;
    winner = startReconcilerChild(crashed, 'before:applied');
    await waitUntil(() => crashed.api.armRequests.length === 1);
    lagger = startReconcilerChild(crashed, '');
    await waitUntil(() => crashed.api.armRequests.length === 2);
    await waitForStage(winner, 'reconciler_before_applied');
    assert.equal(crashed.api.state, 'cancelled');
    assert.equal(crashed.api.armApplyCount, 1);
    assert.equal(crashed.api.cancelApplyCount, 1);
    assert.equal(crashed.api.cancelRequests.length, 1);
    assert.equal(crashed.api.commitRequests.length, 0);
    assert.equal((await findJsonFiles(
      crashed.protocol.awaitRequestTerminalDirectory,
    )).length, 1);
    assert.equal((await findJsonFiles(
      crashed.protocol.heldCallReconciliationAppliedDirectory,
    )).length, 0);
    assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);

    await sigkill(winner);
    winner = null;
    assert.equal(crashed.api.releaseArmRaceReplay(), 1);
    const repaired = await waitForStage(lagger, 'reconcile_complete');
    assert.equal(repaired.kind, 'released');
    await waitForCleanExit(lagger);
    lagger = null;

    const records = await reconciliationRecords(crashed);
    assert.equal(records.intent.stage, 'arm');
    assert.ok(records.armBinding);
    assert.ok(records.transcriptBoundary);
    assert.ok(records.waiterReady);
    assert.equal(records.terminal.disposition, 'remote_cancelled');
    assert.equal(records.applied.stage, 'arm');
    assert.equal(records.applied.outcome, 'remote_cancelled');
    assert.deepEqual(records.applied.apiResponses.map(({ method, replay }) => ({
      method,
      replay,
    })), [{ method: 'cancel', replay: true }]);
    assert.equal((await findJsonFiles(
      crashed.protocol.armReconciliationFreezeDirectory,
    )).length, 0);
    assert.equal(crashed.api.armRequests.length, 2);
    assert.equal(crashed.api.armApplyCount, 1);
    assert.deepEqual(crashed.api.armResponseReplays, [false, true]);
    assert.equal(crashed.api.cancelRequests.length, 2);
    assert.equal(crashed.api.cancelApplyCount, 1);
    assert.deepEqual(crashed.api.cancelResponseReplays, [false, true]);
    assert.equal(
      canonicalJson(crashed.api.cancelRequests[0]),
      canonicalJson(crashed.api.cancelRequests[1]),
    );
    assert.equal(crashed.api.commitRequests.length, 0);
    assert.equal(crashed.api.commitApplyCount, 0);
    assert.deepEqual(await crashed.protocol.listAwaitRequests(), []);
    assert.deepEqual(await evaluateOrdinaryPrompt(crashed), {
      allowed: true,
      reason: 'thread_not_owned',
    });
    await assertReconciliationReceiptsSecretFree(crashed);

    const remoteCounts = {
      arm: crashed.api.armRequests.length,
      cancel: crashed.api.cancelRequests.length,
      commit: crashed.api.commitRequests.length,
    };
    assert.equal((await runFreshReconciler(crashed)).kind, 'released');
    assert.deepEqual({
      arm: crashed.api.armRequests.length,
      cancel: crashed.api.cancelRequests.length,
      commit: crashed.api.commitRequests.length,
    }, remoteCounts);
  } finally {
    await terminateIfRunning(winner);
    await terminateIfRunning(lagger);
    await crashed.api.stop();
  }
});

test('tool-error and crash-reconciliation children elect one cancellation owner', {
  timeout: 30_000,
}, async (t) => {
  for (const intentFirst of [false, true]) {
    await t.test(intentFirst ? 'crash intent first' : 'tool error first', async () => {
      const crashed = await crashScenario('A0');
      let reconcilerChild;
      let lifecycleChild;
      try {
        if (intentFirst) {
          await crashed.protocol.publishHeldCallReconciliationIntent(
            crashed.request,
            crashed.attempt,
            crashed.receipt,
            {
              stage: 'arm',
              armBinding: null,
              waiterReady: null,
              commitAttempt: null,
              remoteRequestDigest: crashed.attempt.armRequestDigest,
            },
            () => new Date('2026-08-07T12:00:13.000Z'),
          );
        }
        const toolError = (await crashed.protocol.publishToolError(crashed.request, {
          failureCode: 'arm_outcome_ambiguous',
          errorDigest: 'd'.repeat(64),
        }, () => new Date('2026-08-07T12:00:14.000Z'))).toolError;
        await crashed.protocol.publishToolErrorObservation(
          crashed.request,
          toolError,
          { responseDigest: 'f'.repeat(64) },
          () => new Date('2026-08-07T12:00:15.000Z'),
        );

        reconcilerChild = startReconcilerChild(crashed, '');
        lifecycleChild = startCrashChild(
          'TOOL_ERROR_LIFECYCLE',
          crashed.dataDir,
          crashed.api,
          {
            HARK_CRASH_ROLE: 'tool_error_lifecycle',
            HARK_RECONCILE_REQUEST_JSON: canonicalJson(crashed.request),
          },
        );
        const [reconciled, lifecycle] = await Promise.all([
          waitForStage(reconcilerChild, 'reconcile_complete'),
          waitForStage(lifecycleChild, 'tool_error_lifecycle_complete'),
        ]);
        await Promise.all([
          waitForCleanExit(reconcilerChild),
          waitForCleanExit(lifecycleChild),
        ]);
        reconcilerChild = null;
        lifecycleChild = null;

        if (intentFirst) {
          assert.equal(reconciled.kind, 'released');
          assert.equal(lifecycle.kind, 'owned');
          assert.equal(lifecycle.reason, 'held_call_crash_reconciliation_authoritative');
          const records = await reconciliationRecords(crashed);
          assert.equal(records.intent.stage, 'arm');
          assert.equal(records.applied.outcome, 'remote_cancelled');
        } else {
          assert.equal(reconciled.kind, 'owned');
          assert.equal(reconciled.reason, 'tool_error_lifecycle_authoritative');
          assert.equal(lifecycle.kind, 'released');
          assert.equal(lifecycle.reason, 'authoritatively_cancelled');
          assert.equal((await findJsonFiles(
            crashed.protocol.heldCallReconciliationIntentDirectory,
          )).length, 0);
          assert.equal((await findJsonFiles(
            crashed.protocol.heldCallReconciliationAppliedDirectory,
          )).length, 0);
        }
        assert.equal(crashed.api.armRequests.length, 1);
        assert.equal(crashed.api.armApplyCount, 1);
        assert.equal(crashed.api.cancelRequests.length, 1);
        assert.equal(crashed.api.cancelApplyCount, 1);
        assert.equal(crashed.api.commitRequests.length, 0);
        assert.equal(crashed.api.commitApplyCount, 0);
        assert.equal((await crashed.protocol.readAwaitRequestTerminal(
          crashed.request,
        )).disposition, 'remote_cancelled');
        assert.deepEqual(await crashed.protocol.listAwaitRequests(), []);
        assert.deepEqual(await evaluateOrdinaryPrompt(crashed), {
          allowed: true,
          reason: 'thread_not_owned',
        });
      } finally {
        await terminateIfRunning(reconcilerChild);
        await terminateIfRunning(lifecycleChild);
        await crashed.api.stop();
      }
    });
  }
});

test('bare tool-error writer SIGKILL cannot strand positive owner-abort recovery', {
  timeout: 15_000,
}, async () => {
  const crashed = await crashScenario('A0');
  let writer;
  try {
    writer = startCrashChild('TOOL_ERROR_WRITER', crashed.dataDir, crashed.api, {
      HARK_CRASH_ROLE: 'tool_error_writer',
      HARK_RECONCILE_REQUEST_JSON: canonicalJson(crashed.request),
    });
    await waitForStage(writer, 'bare_tool_error_durable');
    await sigkill(writer);
    writer = null;
    const toolError = await crashed.protocol.readToolError(crashed.request);
    assert.ok(toolError);
    assert.equal(
      await crashed.protocol.readToolErrorObservation(crashed.request, toolError),
      null,
    );
    assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);

    const repaired = await runFreshReconciler(crashed);
    assert.equal(repaired.kind, 'released');
    assert.equal(repaired.reason, 'authoritatively_cancelled_after_origin_abort');
    const records = await reconciliationRecords(crashed);
    assert.equal(records.intent.stage, 'arm');
    assert.equal(records.applied.outcome, 'remote_cancelled');
    assert.equal(crashed.api.armApplyCount, 1);
    assert.equal(crashed.api.cancelApplyCount, 1);
    assert.equal(crashed.api.cancelRequests.length, 1);
    assert.equal(crashed.api.commitRequests.length, 0);
    assert.deepEqual(await crashed.protocol.listAwaitRequests(), []);
    assert.deepEqual(await evaluateOrdinaryPrompt(crashed), {
      allowed: true,
      reason: 'thread_not_owned',
    });
  } finally {
    await terminateIfRunning(writer);
    await crashed.api.stop();
  }
});

test('positive abort receipt itself is an O_EXCL SIGKILL boundary', {
  timeout: 30_000,
}, async (t) => {
  for (const phase of ['before', 'after']) {
    await t.test(phase, async () => {
      const crashed = await crashScenario('A0', { publishAbort: false });
      try {
        const prepared = await preparePositiveAbortProof(
          crashed.protocol,
          crashed.request,
          crashed.exit,
          { persist: false },
        );
        crashed.attempt = prepared.attempt;
        crashed.receipt = prepared.receipt;
        await sigkillReconcilerAt(crashed, `${phase}:abort_receipt`, prepared.receipt);
        assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false, phase);
        const persisted = await crashed.protocol.readHeldCallOriginAbortReceipt(
          crashed.request,
          crashed.attempt,
        );
        assert.equal(Boolean(persisted), phase === 'after');
        if (phase === 'before') {
          const silent = await runFreshReconciler(crashed, null);
          assert.equal(silent.kind, 'inactive');
          assert.equal(silent.reason, 'origin_abort_receipt_required');
          assert.deepEqual({
            arm: crashed.api.armRequests.length,
            cancel: crashed.api.cancelRequests.length,
            commit: crashed.api.commitRequests.length,
          }, { arm: 0, cancel: 0, commit: 0 });
        }
        const completed = await runFreshReconciler(
          crashed,
          phase === 'before' ? prepared.receipt : null,
        );
        assert.equal(completed.kind, 'released');
        assert.equal(crashed.api.armApplyCount, 1);
        assert.equal(crashed.api.cancelApplyCount, 1);
        assert.equal(crashed.api.commitApplyCount, 0);
      } finally {
        await crashed.api.stop();
      }
    });
  }
});

test('reconciler survives parent-owned arm, commit, and cancel response loss', {
  timeout: 45_000,
}, async (t) => {
  const cases = [
    {
      name: 'arm replay response withheld after apply',
      scenario: 'A0',
      method: 'arm',
      requests: 'armRequests',
      expectedBefore: 0,
      expectedKind: 'released',
      expectedReplay: { method: 'arm', replay: true },
    },
    {
      name: 'commit replay response withheld after apply',
      scenario: 'C0',
      method: 'commit',
      requests: 'commitRequests',
      expectedBefore: 0,
      expectedKind: 'recovery_authorized',
      expectedReplay: { method: 'commit', replay: true },
    },
    {
      name: 'cancel response withheld after apply',
      scenario: 'A3_READY',
      method: 'cancel',
      requests: 'cancelRequests',
      expectedBefore: 0,
      expectedKind: 'released',
      expectedReplay: { method: 'cancel', replay: true },
    },
  ];
  for (const value of cases) {
    await t.test(value.name, async () => {
      const crashed = await crashScenario(value.scenario);
      const holdField = `hold${value.method[0].toUpperCase()}${value.method.slice(1)}`;
      crashed.api[holdField] = true;
      const running = startReconcilerChild(crashed, '');
      try {
        assert.equal(crashed.api[value.requests].length, value.expectedBefore);
        await waitUntil(() => crashed.api[value.requests].length === value.expectedBefore + 1);
        assert.equal(crashed.api[`${value.method}ApplyCount`], 1);
        await sigkill(running);
        assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
        crashed.api.release(value.method);
        const completed = await runFreshReconciler(crashed);
        assert.equal(completed.kind, value.expectedKind);
        const records = await reconciliationRecords(crashed);
        assert.deepEqual(crashed.api[`${value.method}ResponseReplays`], [false, true]);
        if (value.method !== 'arm') {
          assert.ok(records.applied.apiResponses.some((response) => (
            response.method === value.expectedReplay.method
            && response.replay === value.expectedReplay.replay
          )));
        }
        assert.equal(crashed.api[`${value.method}ApplyCount`], 1);
        assert.equal(crashed.api[value.requests].length, value.expectedBefore + 2);
        if (value.method === 'commit') {
          assert.equal(crashed.api.cancelRequests.length, 0);
          assert.ok(records.suspensionCommitted);
        }
      } finally {
        await terminateIfRunning(running);
        crashed.api.release(value.method);
        await crashed.api.stop();
      }
    });
  }
});

test('W0-W2: actual SIGKILL dispatches exactly one crash-recovery turn', {
  timeout: 30_000,
}, async (t) => {
  for (const [scenario, disposition] of [
    ['W0', 'recover_waiter'],
    ['W1', 'recover_waiter'],
    ['W2', 'recover_held_tool'],
  ]) {
    await t.test(scenario, async () => {
      const crashed = await crashScenario(scenario);
      try {
        assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
        assert.equal((await runFreshReconciler(crashed)).kind, 'recovery_authorized');
        const beforeDelivery = await crashed.protocol.readWakeDelivery(crashed.request);
        if (scenario === 'W2') {
          assert.ok(beforeDelivery);
          assert.ok(await crashed.protocol.readToolResultObservationIntent(
            beforeDelivery,
            undefined,
            undefined,
            undefined,
            undefined,
          ));
        } else {
          assert.equal(beforeDelivery, null);
        }
        if (beforeDelivery) {
          assert.equal(await crashed.protocol.readToolResultReturned(beforeDelivery), null);
        }

        const recovery = await dispatchOneCrashRecoveryTurn(crashed, disposition);
        assert.equal(recovery.appServer.callsFor('turn/start').length, 1);
        assert.equal(crashed.api.cancelApplyCount, 0);
        const receiptKinds = crashed.api.runtimeReceiptRequests.map((receipt) => receipt.kind);
        assert.deepEqual(receiptKinds.filter((kind) => (
          ['wake_received', 'task_woken'].includes(kind)
        )), ['wake_received', 'task_woken']);
        assert.equal(receiptKinds.includes('tool_result_observed'), false);
        assert.equal((await crashed.protocol.listAwaitRequests()).length, 1);
      } finally {
        await crashed.api.stop();
      }
    });
  }
});

test('targeted claim apply with withheld response survives SIGKILL and exact replay once', {
  timeout: 30_000,
}, async () => {
  const value = await prepareTargetedRecoveryScenario();
  let first;
  let restarted;
  try {
    value.api.holdTargetClaim = true;
    first = startTargetedSupervisorChild(value);
    await waitUntil(() => value.api.targetClaimRequests.length === 1);
    assert.equal(value.api.targetClaimApplyCount, 1);
    assert.equal((await new HarkJournal(value.dataDir).read()).wakes[TARGET_WAKE_ID], undefined);
    assert.equal(first.stages.some(({ stage }) => stage === 'targeted_turn_start'), false);
    await sigkill(first);
    first = null;

    value.api.release('targetClaim');
    restarted = startTargetedSupervisorChild(value);
    const completed = await waitForStage(restarted, 'targeted_dispatch_complete');
    assert.deepEqual({
      wakeId: completed.wakeId,
      leaseGeneration: completed.leaseGeneration,
      recoveryProofDigest: completed.recoveryProofDigest,
      state: completed.state,
    }, {
      wakeId: TARGET_WAKE_ID,
      leaseGeneration: 2,
      recoveryProofDigest: value.api.targetRemoteEffect.recoveryProofDigest,
      state: 'running',
    });
    await waitForCleanExit(restarted);
    assert.equal(restarted.stages.filter(({ stage }) => stage === 'targeted_turn_start').length, 1);
    restarted = null;

    assert.deepEqual(value.api.targetClaimResponseReplays, [false, true]);
    assert.equal(value.api.targetClaimRequests.length, 2);
    assert.equal(
      canonicalJson(value.api.targetClaimRequests[0]),
      canonicalJson(value.api.targetClaimRequests[1]),
    );
    const altered = structuredClone(value.api.targetClaimRequest);
    altered.proof.rolloutAbortProofDigest = 'f'.repeat(64);
    const beforeAltered = structuredClone(value.api.targetRemoteEffect);
    await assert.rejects(
      serviceFor(value.api).claimCrashRecovery(TARGET_AWAIT_ID, altered),
      (error) => error?.status === 409 && error?.code === 'altered_crash_recovery_claim',
    );
    assert.deepEqual(value.api.targetRemoteEffect, beforeAltered);
    assert.equal(value.api.targetClaimApplyCount, 1);
    assert.equal(value.api.targetClaimRequests.length, 3);
    assert.equal(value.api.targetClaimRequests.filter((candidate) => (
      canonicalJson(candidate) === canonicalJson(value.api.targetClaimRequest)
    )).length, 2);
    await assertTargetedRecoveryAppliedAndDispatchedOnce(value, {
      exactClaimRequestCount: 3,
    });
  } finally {
    await terminateIfRunning(first);
    await terminateIfRunning(restarted);
    value.api.release('targetClaim');
    await value.api.stop();
  }
});

test('targeted claim response before local journal is a real SIGKILL replay boundary', {
  timeout: 30_000,
}, async () => {
  const value = await prepareTargetedRecoveryScenario();
  let first;
  let restarted;
  try {
    first = startTargetedSupervisorChild(value, { failpoint: 'after_claim_response' });
    const received = await waitForStage(first, 'targeted_claim_response_received');
    assert.equal(received.replay, false);
    assert.equal(received.recoveryProofDigest, value.api.targetRemoteEffect.recoveryProofDigest);
    assert.equal(value.api.targetClaimApplyCount, 1);
    assert.equal((await new HarkJournal(value.dataDir).read()).wakes[TARGET_WAKE_ID], undefined);
    assert.equal(first.stages.some(({ stage }) => stage === 'targeted_turn_start'), false);
    await sigkill(first);
    first = null;

    restarted = startTargetedSupervisorChild(value);
    await waitForStage(restarted, 'targeted_dispatch_complete');
    await waitForCleanExit(restarted);
    assert.equal(restarted.stages.filter(({ stage }) => stage === 'targeted_turn_start').length, 1);
    restarted = null;
    assert.deepEqual(value.api.targetClaimResponseReplays, [false, true]);
    assert.equal(value.api.targetClaimRequests.length, 2);
    assert.equal(
      canonicalJson(value.api.targetClaimRequests[0]),
      canonicalJson(value.api.targetClaimRequests[1]),
    );
    await assertTargetedRecoveryAppliedAndDispatchedOnce(value, {
      exactClaimRequestCount: 2,
    });
  } finally {
    await terminateIfRunning(first);
    await terminateIfRunning(restarted);
    await value.api.stop();
  }
});

test('two fresh targeted supervisors replay one proof-bound claim without steal or duplicate', {
  timeout: 30_000,
}, async () => {
  const value = await prepareTargetedRecoveryScenario();
  const children = [];
  try {
    value.api.serializeTargetClaimReplay = true;
    children.push(
      startTargetedSupervisorChild(value),
      startTargetedSupervisorChild(value),
    );
    await waitUntil(() => value.api.targetClaimRequests.length === 2);
    const completed = await Promise.all(children.map((child) => (
      waitForStage(child, 'targeted_dispatch_complete')
    )));
    await Promise.all(children.map(waitForCleanExit));
    for (const entry of completed) {
      assert.equal(entry.wakeId, TARGET_WAKE_ID);
      assert.equal(entry.leaseGeneration, 2);
      assert.equal(['submitted', 'running'].includes(entry.state), true);
    }
    assert.equal(completed.some(({ state }) => state === 'running'), true);
    assert.equal(children.flatMap(({ stages }) => stages).filter(
      ({ stage }) => stage === 'targeted_turn_start',
    ).length, 1);
    assert.equal(children.flatMap(({ stages }) => stages).some(
      ({ stage }) => stage === 'targeted_supervisor_error',
    ), false);
    assert.deepEqual(value.api.targetClaimResponseReplays.sort(), [false, true]);
    assert.equal(
      canonicalJson(value.api.targetClaimRequests[0]),
      canonicalJson(value.api.targetClaimRequests[1]),
    );
    await assertTargetedRecoveryAppliedAndDispatchedOnce(value, {
      exactClaimRequestCount: 2,
    });
  } finally {
    await Promise.all(children.map(terminateIfRunning));
    await value.api.stop();
  }
});

test('O0-O1: remote observation acceptance is discovered without repost and abort hands off once', {
  timeout: 25_000,
}, async (t) => {
  await t.test('O0', async () => {
    const crashed = await crashScenario('O0', { publishAbort: false });
    try {
      assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
      assert.equal((await runFreshReconciler(crashed, null)).kind, 'inactive');
      const before = await heldResultRecords(crashed);
      assert.ok(before.returned);
      assert.ok(before.intent);
      assert.equal(crashed.api.runtimeReceiptAttempts.filter(
        (receipt) => receipt.kind === 'tool_result_observed',
      ).length, 1);
      assert.deepEqual(await certifierFor(crashed).reconcile(), {
        posted: 0,
        skipped: 0,
        pending: 1,
        failed: 0,
        errors: [],
      });
      assert.equal(crashed.api.runtimeReceiptAttempts.filter(
        (receipt) => receipt.kind === 'tool_result_observed',
      ).length, 1);
      const claim = await new HarkPrivateClaimStore(crashed.dataDir).resolve(
        before.intent.claimReference,
        before.intent.binding,
      );
      assert.equal(claim.state, 'consumed');
      assert.equal(crashed.api.runtimeReceiptRequests.filter(
        (receipt) => receipt.kind === 'tool_result_observed',
      ).length, 1);
      assert.equal(crashed.api.runtimeReceiptRequests.some((receipt) => [
        'tool_result_not_persisted',
        'tool_result_continuation_aborted',
      ].includes(receipt.kind)), false);
      assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
    } finally {
      await crashed.api.stop();
    }
  });

  await t.test('O1', async () => {
    const crashed = await crashScenario('O1');
    try {
      assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
      assert.equal((await runFreshReconciler(crashed)).kind, 'recovery_authorized');
      assert.deepEqual(await certifierFor(crashed).reconcile(), {
        posted: 0,
        skipped: 0,
        pending: 1,
        failed: 0,
        errors: [],
      });
      const receiptKinds = crashed.api.runtimeReceiptRequests.map(({ kind }) => kind);
      assert.deepEqual(receiptKinds.filter((kind) => [
        'tool_result_observed',
        'tool_result_not_persisted',
      ].includes(kind)), [
        'tool_result_observed',
        'tool_result_not_persisted',
      ]);
      assert.equal(crashed.api.certification(TARGET_AWAIT_ID).activeToolResultObservationCount, 0);
      await dispatchOneCrashRecoveryTurn(crashed, 'recover_held_tool');
      assert.equal(crashed.api.cancelApplyCount, 0);
      assert.equal(crashed.api.runtimeReceiptRequests.filter(
        (receipt) => receipt.kind === 'tool_result_not_persisted',
      ).length, 1);
    } finally {
      await crashed.api.stop();
    }
  });
});

test('T0-T1: persisted output adopts once or aborts continuation into one recovery turn', {
  timeout: 25_000,
}, async (t) => {
  await t.test('T0', async () => {
    const crashed = await crashScenario('T0', { publishAbort: false });
    try {
      assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
      assert.equal((await runFreshReconciler(crashed, null)).kind, 'inactive');
      const recovery = new HarkHeldCrashRecovery({
        protocol: new HarkToolWaitProtocol(crashed.dataDir),
        serviceClient: serviceFor(crashed.api),
        runtimeId: 'hard-crash-runtime',
      });
      const wakeResult = recoveryWakeResult(crashed.api, 'recover_held_tool');
      const adopted = await recovery.recoverHeldTool(wakeResult);
      assert.equal(adopted.action, 'adopted');
      assert.equal(adopted.observation.toolResultObservation.observationMode, 'recovery_adoption');
      assert.equal(crashed.api.runtimeReceiptRequests.length, 1);
      assert.equal(crashed.api.runtimeReceiptRequests[0].kind, 'tool_result_observed');
      assert.equal(
        crashed.api.runtimeReceiptRequests[0].toolResultObservation.observationMode,
        'recovery_adoption',
      );
      const duplicate = await new HarkHeldCrashRecovery({
        protocol: new HarkToolWaitProtocol(crashed.dataDir),
        serviceClient: serviceFor(crashed.api),
        runtimeId: 'hard-crash-runtime',
      }).recoverHeldTool(wakeResult);
      assert.equal(duplicate.action, 'adopted');
      assert.equal(crashed.api.runtimeReceiptRequests.length, 1);
      assert.equal(crashed.api.runtimeReceiptAttempts.length, 2);
      assert.equal(crashed.api.cancelApplyCount, 0);
    } finally {
      await crashed.api.stop();
    }
  });

  await t.test('T1', async () => {
    const crashed = await crashScenario('T1');
    try {
      assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
      assert.equal((await runFreshReconciler(crashed)).kind, 'recovery_authorized');
      assert.deepEqual(await certifierFor(crashed).reconcile(), {
        posted: 0,
        skipped: 0,
        pending: 1,
        failed: 0,
        errors: [],
      });
      assert.equal(crashed.api.runtimeReceiptRequests.filter(
        (receipt) => receipt.kind === 'tool_result_continuation_aborted',
      ).length, 1);
      assert.equal(crashed.api.certification(TARGET_AWAIT_ID).activeToolResultObservationCount, 0);
      await dispatchOneCrashRecoveryTurn(crashed, 'recover_held_tool');
      assert.equal(crashed.api.runtimeReceiptRequests.filter(
        (receipt) => receipt.kind === 'tool_result_continuation_aborted',
      ).length, 1);
      assert.equal(crashed.api.cancelApplyCount, 0);
    } finally {
      await crashed.api.stop();
    }
  });
});

test('F0-F1: completion response and local marker gaps replay or archive exactly once', {
  timeout: 25_000,
}, async (t) => {
  await t.test('F0', async () => {
    const crashed = await crashScenario('F0', { publishAbort: false });
    try {
      assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
      assert.equal((await runFreshReconciler(crashed, null)).kind, 'inactive');
      const before = await heldResultRecords(crashed);
      assert.equal(before.completion, null);
      assert.equal(crashed.api.runtimeReceiptRequests.filter(
        (receipt) => receipt.kind === 'task_completed',
      ).length, 1);
      assert.equal(crashed.api.runtimeReceiptAttempts.filter(
        (receipt) => receipt.kind === 'task_completed',
      ).length, 1);
      assert.deepEqual(await certifierFor(crashed).reconcile(), {
        posted: 1,
        skipped: 0,
        pending: 0,
        failed: 0,
        errors: [],
      });
      const after = await heldResultRecords(crashed);
      assert.ok(after.completion);
      assert.equal(crashed.api.runtimeReceiptRequests.filter(
        (receipt) => receipt.kind === 'task_completed',
      ).length, 1);
      assert.equal(crashed.api.runtimeReceiptAttempts.filter(
        (receipt) => receipt.kind === 'task_completed',
      ).length, 2);
      assert.equal((await crashed.protocol.readAwaitRequestTerminal(
        crashed.request,
      )).disposition, 'completion_posted');
      assert.deepEqual(await crashed.protocol.listAwaitRequests(), []);
    } finally {
      await crashed.api.stop();
    }
  });

  await t.test('F1', async () => {
    const crashed = await crashScenario('F1', { publishAbort: false });
    try {
      assert.equal((await findJsonFiles(
        crashed.protocol.completionPostedDirectory,
      )).length, 1);
      assert.equal((await findJsonFiles(
        crashed.protocol.awaitRequestTerminalDirectory,
      )).length, 0);
      assert.equal((await findJsonFiles(
        crashed.protocol.awaitRequestDirectory,
      )).length, 1);
      assert.equal(crashed.api.runtimeReceiptAttempts.filter(
        (receipt) => receipt.kind === 'task_completed',
      ).length, 1);
      assert.equal((await evaluateOrdinaryPrompt(crashed)).allowed, false);
      assert.equal((await runFreshReconciler(crashed, null)).kind, 'inactive');
      assert.deepEqual(await certifierFor(crashed).reconcile(), {
        posted: 0,
        skipped: 1,
        pending: 0,
        failed: 0,
        errors: [],
      });
      assert.equal(crashed.api.runtimeReceiptAttempts.filter(
        (receipt) => receipt.kind === 'task_completed',
      ).length, 1);
      assert.equal((await crashed.protocol.readAwaitRequestTerminal(
        crashed.request,
      )).disposition, 'completion_posted');
      assert.deepEqual(await crashed.protocol.listAwaitRequests(), []);
      assert.deepEqual(await evaluateOrdinaryPrompt(crashed), {
        allowed: true,
        reason: 'thread_not_owned',
      });
    } finally {
      await crashed.api.stop();
    }
  });
});

test('live held call denies two fresh reconcilers all replay, cancel, and claim authority', {
  timeout: 15_000,
}, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hark-hard-crash-live-'));
  const api = await new LoopbackAwaitApi().start();
  api.holdWake = true;
  const running = startCrashChild('LIVE', dataDir, api);
  const reconcilerChildren = [];
  try {
    await waitForStage(running, 'suspension_committed_durable');
    await waitUntil(() => api.wakeRequests.length === 1);
    const protocol = new HarkToolWaitProtocol(dataDir);
    const [request] = await protocol.listAwaitRequests();
    assert.equal((await evaluateOrdinaryPrompt({ dataDir, protocol, request })).allowed, false);
    const before = {
      arm: api.armRequests.length,
      commit: api.commitRequests.length,
      cancel: api.cancelRequests.length,
      wake: api.wakeRequests.length,
    };
    const live = { dataDir, api, request, receipt: null };
    reconcilerChildren.push(
      startReconcilerChild(live, '', null),
      startReconcilerChild(live, '', null),
    );
    const dispositions = await Promise.all(reconcilerChildren.map((child) => (
      waitForStage(child, 'reconcile_complete')
    )));
    await Promise.all(reconcilerChildren.map(waitForCleanExit));
    dispositions.forEach((disposition) => {
      assert.equal(disposition.kind, 'inactive');
      assert.equal(disposition.reason, 'origin_abort_receipt_required');
    });
    assert.deepEqual({
      arm: api.armRequests.length,
      commit: api.commitRequests.length,
      cancel: api.cancelRequests.length,
      wake: api.wakeRequests.length,
    }, before);
    assert.equal(await protocol.readHeldCallOriginAbortReceipt(
      request,
      await protocol.readArmAttempt(request),
    ), null);
    assert.equal(await protocol.readHeldCallReconciliationIntent(
      request,
      await protocol.readArmAttempt(request),
      undefined,
    ), null);
  } finally {
    await Promise.all(reconcilerChildren.map(terminateIfRunning));
    await terminateIfRunning(running);
    await api.stop();
  }
});

test('D0: parent API accepts identical replay, rejects altered replay, and applies once', {
  timeout: 20_000,
}, async () => {
  const crashed = await crashScenario('F0', { publishAbort: false });
  try {
    assert.deepEqual(await certifierFor(crashed).reconcile(), {
      posted: 1,
      skipped: 0,
      pending: 0,
      failed: 0,
      errors: [],
    });
    const service = serviceFor(crashed.api);

    const exactArm = await service.armAwait(crashed.api.armRequest);
    assert.equal(exactArm.replay, true);
    await assert.rejects(service.armAwait({
      ...crashed.api.armRequest,
      preparationNonce: `hkp_${'z'.repeat(32)}`,
    }), (error) => error?.status === 409 && error?.code === 'altered_arm_replay');

    const exactCommit = await service.commitAwait(
      TARGET_AWAIT_ID,
      crashed.api.commitRequest,
    );
    assert.equal(exactCommit.replay, true);
    await assert.rejects(service.commitAwait(TARGET_AWAIT_ID, {
      ...crashed.api.commitRequest,
      commitNonce: `hkc_${'z'.repeat(32)}`,
    }), (error) => error?.status === 409 && error?.code === 'altered_commit_replay');

    const exactWake = await service.waitForAwait(
      TARGET_AWAIT_ID,
      crashed.api.wakeRequest,
      { waitSeconds: 0 },
    );
    assert.equal(exactWake.replay, true);
    await assert.rejects(service.waitForAwait(TARGET_AWAIT_ID, {
      ...crashed.api.wakeRequest,
      leaseGeneration: 2,
    }, { waitSeconds: 0 }), (error) => (
      error?.status === 409 && error?.code === 'altered_wake_replay'
    ));

    const observation = crashed.api.runtimeReceiptRequests.find(
      (receipt) => receipt.kind === 'tool_result_observed',
    );
    assert.ok(observation);
    assert.equal((await service.recordRuntimeReceipt(TARGET_AWAIT_ID, observation)).replay, true);
    await assert.rejects(service.recordRuntimeReceipt(TARGET_AWAIT_ID, {
      ...observation,
      observedAt: '2026-08-07T12:00:59.000Z',
    }), (error) => (
      error?.status === 409 && error?.code === 'runtime_receipt_replay_conflict'
    ));

    assert.deepEqual({
      arm: crashed.api.armApplyCount,
      commit: crashed.api.commitApplyCount,
      wake: crashed.api.wakeApplyCount,
      cancel: crashed.api.cancelApplyCount,
      observation: crashed.api.runtimeReceiptRequests.filter(
        (receipt) => receipt.kind === 'tool_result_observed',
      ).length,
      completion: crashed.api.runtimeReceiptRequests.filter(
        (receipt) => receipt.kind === 'task_completed',
      ).length,
      wakeDelivery: (await findJsonFiles(
        crashed.protocol.wakeDeliveryDirectory,
      )).length,
      toolResult: (await findJsonFiles(
        crashed.protocol.toolResultReturnedDirectory,
      )).length,
      completionMarker: (await findJsonFiles(
        crashed.protocol.completionPostedDirectory,
      )).length,
    }, {
      arm: 1,
      commit: 1,
      wake: 1,
      cancel: 0,
      observation: 1,
      completion: 1,
      wakeDelivery: 1,
      toolResult: 1,
      completionMarker: 1,
    });
    assert.equal(crashed.api.commitApplyCount, 1);
    assert.equal(crashed.api.cancelApplyCount, 0);
    assert.deepEqual(await crashed.protocol.listAwaitRequests(), []);
  } finally {
    await crashed.api.stop();
  }
});
