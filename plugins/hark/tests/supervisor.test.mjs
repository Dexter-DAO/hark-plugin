import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  armApiResponse,
  commitApiResponse,
} from './api-response-fixtures.mjs';
import { sha256Canonical } from '../lib/canonical.mjs';
import { HarkHookInbox } from '../lib/hook-inbox.mjs';
import { HarkJournal } from '../lib/journal.mjs';
import { HarkApiError } from '../lib/service-client.mjs';
import {
  buildWakePrompt,
  HarkCodexSupervisor,
  markerForWake,
} from '../lib/supervisor.mjs';

const DEFAULT_INSTALLATION = Object.freeze({
  id: 'installation-1',
  protocol: 'codex',
  runtimeId: 'runtime-1',
});

function credentialsStoreFor(installation = DEFAULT_INSTALLATION) {
  return {
    async read() {
      return {
        apiBaseUrl: 'https://api.example.test',
        accessToken: 'test-secret',
        installation: structuredClone(installation),
      };
    },
  };
}

class FakeAppServer extends EventEmitter {
  constructor() {
    super();
    this.thread = {
      id: 'thread-1',
      sessionId: 'thread-1',
      parentThreadId: null,
      canAcceptDirectInput: null,
      status: { type: 'idle' },
      path: '/tmp/codex-home/sessions/thread-1.jsonl',
      turns: [],
    };
    this.calls = [];
  }

  async start() { this.calls.push(['start']); }
  async close() { this.calls.push(['close']); }
  async readConfig() {
    this.calls.push(['config/read']);
    return { config: { features: { current_time_reminder: { clock_source: 'system' } } } };
  }
  async listLoadedThreads() { return { data: ['thread-1'], nextCursor: null }; }
  async resumeThread(threadId) {
    this.calls.push(['resume', threadId]);
    return { thread: this.thread };
  }
  async readThread(threadId) {
    this.calls.push(['read', threadId]);
    return { thread: this.thread };
  }
  async startTurn(threadId, input, options) {
    this.calls.push(['turn/start', threadId, input, options]);
    const turn = {
      id: 'turn-wake-1', status: 'inProgress', startedAt: null,
      items: [],
      error: null,
    };
    this.thread.turns.push({
      ...turn,
      startedAt: 1_786_086_100,
      items: [{
        id: 'wake-message',
        type: 'userMessage',
        clientId: options.clientUserMessageId,
        content: [{ type: 'text', text: input }],
      }],
    });
    const admission = (await this.hookInbox.listWakeAdmissions()).find((candidate) => (
      candidate.sessionId === threadId
      && candidate.promptDigest === sha256Canonical(input)
    ));
    if (!admission) throw new Error('test_wake_admission_missing');
    await this.hookInbox.acknowledgeWakeAdmission(admission, {
      turnId: turn.id,
      transcriptPath: admission.transcriptPath,
    });
    return { turn };
  }
}

class FakeService {
  constructor() {
    this.calls = [];
    this.armed = null;
  }

  async armAwait(body) {
    this.calls.push(['arm', body]);
    this.armed = body;
    return armApiResponse(body);
  }

  async getInstallationStatus() {
    return {
      v: 'hark.installation-status.v2',
      installation: structuredClone(DEFAULT_INSTALLATION),
    };
  }

  async commitAwait(awaitId, body) {
    this.calls.push(['commit', awaitId, body]);
    return commitApiResponse({
      armRequest: this.armed,
      commitRequest: body,
      awaitId,
      sourceReceiptId: 'suspension-1',
    });
  }

  async cancelAwait(awaitId, body) { this.calls.push(['cancel', awaitId, body]); }
  async nextWake({ signal }) {
    this.calls.push(['nextWake']);
    if (signal.aborted) return null;
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
  }
  async recordRuntimeReceipt(awaitId, body) {
    this.calls.push(['receipt', awaitId, body]);
    const dispatchResolution = body?.result?.dispatchResolution?.kind;
    return {
      v: 'hark.runtime-receipt-result.v2', awaitId, kind: body.kind, replay: false,
      ...(body.kind === 'dispatch_failed' ? {
        wakeState: dispatchResolution === 'wait_history_ineligible' ? 'failed' : 'queued',
      } : {}),
    };
  }
}

class FactoryAppServer extends EventEmitter {
  constructor(harness, id) {
    super();
    this.harness = harness;
    this.id = id;
    this.calls = [];
    this.closed = false;
  }

  #record(...call) {
    this.calls.push(call);
    this.harness.calls.push([this.id, ...call]);
  }

  async start() {
    this.#record('start');
    return { codexHome: '/tmp/codex-home' };
  }

  async close() {
    this.#record('close');
    this.closed = true;
  }

  async readConfig() {
    this.#record('config/read');
    return this.harness.configResult;
  }

  async readThread(threadId, options) {
    this.#record('thread/read', threadId, options);
    return { thread: structuredClone(this.harness.thread) };
  }

  async resumeThread(threadId) {
    this.#record('thread/resume', threadId);
    this.harness.thread.status = { type: 'idle' };
    return { thread: structuredClone(this.harness.thread) };
  }

  async startTurn(threadId, input, options) {
    this.#record('turn/start', threadId, input, options);
    const responseTurnId = this.harness.startResponseTurnId;
    const persistedTurnId = this.harness.persistedTurnId ?? responseTurnId;
    if (this.harness.startMode === 'crash_before_admission') {
      throw new Error('simulated_process_crash_before_host_admission');
    }
    const persistedTurn = {
      id: persistedTurnId,
      status: 'inProgress',
      startedAt: 1_786_086_100,
      items: [{
        id: `message-${persistedTurnId}`,
        type: 'userMessage',
        clientId: options.clientUserMessageId,
        content: [{ type: 'text', text: input }],
      }],
      error: null,
    };
    if (this.harness.startMode !== 'admit_then_crash_without_persist') {
      this.harness.thread.turns.push(persistedTurn);
    }
    if (this.harness.autoAdmitWake) {
      const fence = await this.harness.hookInbox.readWakeDispatchFence(
        options.clientUserMessageId.replace(/^hark:wake:/, ''),
      );
      const intent = fence && await this.harness.hookInbox.readWakeDispatchIntent(fence);
      const admission = (await this.harness.hookInbox.listWakeAdmissions()).find((candidate) => (
        candidate.id === intent?.admissionId
        && candidate.sessionId === threadId
        && candidate.promptDigest === sha256Canonical(input)
      ));
      if (!admission) throw new Error('test_wake_admission_missing');
      await this.harness.hookInbox.acknowledgeWakeAdmission(admission, {
        turnId: responseTurnId,
        transcriptPath: admission.transcriptPath,
      });
    }
    if (['admit_then_crash_without_persist', 'persist_and_admit_then_crash'].includes(
      this.harness.startMode,
    )) throw new Error('simulated_process_crash_after_host_admission');
    return {
      turn: {
        id: responseTurnId,
        status: 'inProgress',
        startedAt: null,
        items: [],
        error: null,
      },
    };
  }

  async unsubscribeThread(threadId) {
    this.#record('thread/unsubscribe', threadId);
  }
}

class AppServerHarness {
  constructor({
    status = 'idle',
    canAcceptDirectInput = null,
    parentThreadId = null,
    clockSource = 'system',
    startResponseTurnId = 'turn-wake-1',
    persistedTurnId = undefined,
    autoAdmitWake = true,
    startMode = 'success',
  } = {}) {
    this.thread = {
      id: 'thread-1',
      sessionId: 'thread-1',
      parentThreadId,
      canAcceptDirectInput,
      status: { type: status },
      path: '/tmp/codex-home/sessions/thread-1.jsonl',
      turns: [],
    };
    this.configResult = {
      config: { features: { current_time_reminder: { clock_source: clockSource } } },
    };
    this.startResponseTurnId = startResponseTurnId;
    this.persistedTurnId = persistedTurnId;
    this.autoAdmitWake = autoAdmitWake;
    this.startMode = startMode;
    this.hookInbox = null;
    this.instances = [];
    this.calls = [];
  }

  createClient = () => {
    const client = new FactoryAppServer(this, `client-${this.instances.length + 1}`);
    this.instances.push(client);
    return client;
  };

  callsFor(method) {
    return this.calls.filter((call) => call[1] === method);
  }
}

function prepared() {
  const source = { kind: 'job.completed', adapter: 'webhook.v1', subject: 'job-42' };
  const condition = { status: { equals: 'completed' } };
  return {
    v: 'hark.await-prepared.v1',
    preparationNonce: 'hkp_nonce-1',
    qualificationDigest: sha256Canonical({ source, condition }),
    wakePolicy: 'resume',
    request: 'Continue job 42.',
    name: 'Job 42',
    source,
    condition,
  };
}

function preparedItemCompletedEvent(draft = prepared()) {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    completedAtMs: 1_786_086_000_000,
    transcriptBoundary: {
      sessionId: 'thread-1',
      originTaskId: 'turn-1',
      transcriptPath: '/tmp/codex-home/sessions/thread-1.jsonl',
    },
    item: {
      id: 'item-1',
      type: 'mcpToolCall',
      server: 'hark',
      tool: 'hark_await',
      status: 'completed',
      arguments: {
        request: draft.request,
        name: draft.name,
        source: draft.source,
        condition: draft.condition,
      },
      result: { structuredContent: draft, content: [] },
    },
  };
}

function cleanTranscriptProof(overrides = {}) {
  return {
    async preflight(boundary, { scannedAt }) {
      return {
        v: 'hark.codex-wait-preflight.v1',
        historySource: 'codex.rollout-jsonl.v1',
        conversationId: boundary.sessionId ?? boundary.conversationId,
        originTaskId: boundary.originTaskId,
        originTerminal: {
          type: 'task_complete', observedAt: '2026-08-07T12:00:01.000Z',
        },
        interveningTaskIds: [],
        rollbackMarkerCount: 0,
        historyMutationCount: 0,
        scannedAt,
        historyDigest: 'b'.repeat(64),
      };
    },
    async prove(boundary, { wakeTaskId, scannedAt }) {
      return {
        v: 'hark.codex-wait-history-proof.v1',
        historySource: 'codex.rollout-jsonl.v1',
        conversationId: boundary.sessionId,
        originTaskId: boundary.originTaskId,
        wakeTaskId,
        originTerminal: {
          type: 'task_complete', observedAt: '2026-08-07T12:00:01.000Z',
        },
        interveningTaskIds: [],
        rollbackMarkerCount: 0,
        historyMutationCount: 0,
        scannedAt,
        historyDigest: 'a'.repeat(64),
        wakeResponseDigest: 'd'.repeat(64),
      };
    },
    ...overrides,
  };
}

function heldCrashArtifacts() {
  const inputDigest = '9'.repeat(64);
  const transcriptBoundary = {
    v: 'hark.codex-tool-wait-boundary.v1',
    historySource: 'codex.rollout-jsonl.v1',
    transcriptPath: '/tmp/codex-home/sessions/thread-1.jsonl',
    conversationId: 'thread-1',
    originTaskId: 'turn-1',
    toolUseId: 'item-1',
    toolName: 'mcp__hark__hark_await',
    toolCallDigest: '8'.repeat(64),
    inputDigest,
    cliVersion: '0.147.0',
    dev: '1',
    ino: '2',
    byteLength: 100,
    prefixSha256: '7'.repeat(64),
  };
  const request = {
    sessionId: 'thread-1',
    turnId: 'turn-1',
    toolUseId: 'item-1',
    originalInputDigest: inputDigest,
  };
  const armAttempt = {
    v: 'hark.tool-wait.arm-attempt.v2',
    installationId: DEFAULT_INSTALLATION.id,
    armRequest: {
      origin: {
        protocol: DEFAULT_INSTALLATION.protocol,
        runtimeId: DEFAULT_INSTALLATION.runtimeId,
      },
    },
    transcriptBoundary,
  };
  const context = {
    request,
    armBinding: {
      preparationNonce: `hkp_${'p'.repeat(32)}`,
      armedAt: '2026-08-07T12:00:00.000Z',
    },
    dispatchBoundary: {
      v: 'hark.codex-rollout-boundary.v1',
      historySource: 'codex.rollout-jsonl.v1',
      transcriptPath: transcriptBoundary.transcriptPath,
      sessionId: 'thread-1',
      originTaskId: 'turn-1',
      dev: '1',
      ino: '2',
      byteLength: 100,
      prefixSha256: 'a'.repeat(64),
    },
  };
  return { request, armAttempt, context };
}

function crashCertifier(armAttempt, disposition = {
  kind: 'recovery_authorized',
  reason: 'suspension_recovered',
}) {
  let proofProvider = null;
  const calls = [];
  return {
    calls,
    protocol: { async readArmAttempt() { return armAttempt; } },
    setOriginAbortProofProvider(provider) { proofProvider = provider; },
    async provide(request, options = {}) {
      return proofProvider(request, armAttempt, options);
    },
    async reconcileHeldCallCrash(request, options) {
      calls.push({ request, options });
      return structuredClone(disposition);
    },
    async poll(signal) {
      if (signal?.aborted) return;
      await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
    },
  };
}

const TARGET_INSTALLATION = '11111111-1111-4111-8111-111111111111';
const TARGET_AWAIT = '22222222-2222-4222-8222-222222222222';
const TARGET_WAKE = '33333333-3333-4333-8333-333333333333';
const TARGET_LEASE = '44444444-4444-4444-8444-444444444444';

function targetedCrashArtifacts({ receipt = true } = {}) {
  const draft = {
    ...prepared(),
    preparationNonce: `hkp_${'p'.repeat(32)}`,
  };
  const origin = {
    protocol: 'codex',
    runtimeId: 'runtime-1',
    taskId: 'turn-1',
    conversationId: 'thread-1',
  };
  const checkpoint = {
    version: 'hark.codex-checkpoint.v1',
    digest: 'a'.repeat(64),
  };
  const binding = {
    continuationMode: 'held_tool',
    toolName: 'mcp__hark__hark_await',
    toolUseId: 'item-1',
    inputDigest: '9'.repeat(64),
  };
  const armRequest = {
    v: 'hark.await.v2',
    preparationNonce: draft.preparationNonce,
    origin,
    checkpoint,
    binding,
    prepared: draft,
    predicate: {
      kind: 'exact_signal',
      type: draft.source.kind,
      subject: draft.source.subject,
      qualificationDigest: draft.qualificationDigest,
    },
    wakePolicy: 'resume',
  };
  const request = {
    eventId: `hte_${'r'.repeat(64)}`,
    sessionId: origin.conversationId,
    turnId: origin.taskId,
    toolUseId: binding.toolUseId,
    toolName: binding.toolName,
    originalInputDigest: binding.inputDigest,
    originalInput: {
      request: draft.request,
      name: draft.name,
      source: draft.source,
      condition: draft.condition,
    },
    transcriptPath: '/tmp/codex-home/sessions/thread-1.jsonl',
  };
  const armAttempt = {
    v: 'hark.tool-wait.arm-attempt.v2',
    eventId: request.eventId,
    installationId: TARGET_INSTALLATION,
    armRequest,
    transcriptBoundary: {
      conversationId: origin.conversationId,
      originTaskId: origin.taskId,
      toolUseId: binding.toolUseId,
      inputDigest: binding.inputDigest,
    },
  };
  const armBinding = {
    awaitId: TARGET_AWAIT,
    preparationNonce: draft.preparationNonce,
    checkpointDigest: checkpoint.digest,
    armedAt: '2026-08-07T12:00:00.000Z',
  };
  const waiterReady = { awaitId: TARGET_AWAIT, toolUseId: binding.toolUseId };
  const commitAttempt = {
    awaitId: TARGET_AWAIT,
    commitRequest: {
      v: 'hark.suspension-commit.v2',
      commitNonce: `hkc_${'c'.repeat(32)}`,
      checkpointDigest: checkpoint.digest,
    },
  };
  const suspensionCommitted = {
    awaitId: TARGET_AWAIT,
    checkpointDigest: checkpoint.digest,
    committedAt: '2026-08-07T12:00:01.000Z',
  };
  const originAbortReceipt = receipt ? {
    v: 'hark.held-call-origin-abort.v1',
    eventId: request.eventId,
    appServerTerminalEvidenceDigest: 'b'.repeat(64),
    rolloutAbortProofDigest: 'c'.repeat(64),
    rolloutAbortProof: {
      originTerminal: {
        type: 'turn_aborted',
        observedAt: '2026-08-07T12:00:01.000Z',
      },
    },
  } : null;
  const wake = {
    v: 'hark.wake.v2',
    wakeId: TARGET_WAKE,
    idempotencyKey: TARGET_WAKE,
    awaitId: TARGET_AWAIT,
    origin,
    checkpoint,
    prepared: draft,
    signal: {
      id: 'signal-1',
      sourceSignalId: 'source-1',
      type: draft.source.kind,
      subject: draft.source.subject,
      qualificationDigest: draft.qualificationDigest,
      observedAt: '2026-08-07T12:00:02.000Z',
      summary: 'Job completed.',
      data: {},
      evidence: [],
    },
    createdAt: '2026-08-07T12:00:02.000Z',
  };
  const detail = {
    v: 'hark.await-detail.v2',
    await: {
      ...armRequest,
      id: TARGET_AWAIT,
      state: 'wake_pending',
    },
    wake: {
      id: TARGET_WAKE,
      awaitId: TARGET_AWAIT,
      state: 'queued',
      deliveryMode: null,
      wakeDeliveryDigest: 'd'.repeat(64),
      heldDeliveryDigest: null,
    },
  };
  const context = {
    request,
    armBinding,
    dispatchBoundary: {
      v: 'hark.codex-rollout-boundary.v1',
      historySource: 'codex.rollout-jsonl.v1',
      transcriptPath: request.transcriptPath,
      sessionId: origin.conversationId,
      originTaskId: origin.taskId,
      dev: '1',
      ino: '2',
      byteLength: 100,
      prefixSha256: 'e'.repeat(64),
    },
  };
  return {
    trace: [],
    request,
    armAttempt,
    armBinding,
    waiterReady,
    commitAttempt,
    suspensionCommitted,
    originAbortReceipt,
    wake,
    detail,
    context,
  };
}

class TargetedCrashService extends FakeService {
  constructor(artifacts, {
    disposition = 'recover_waiter',
    responseMutator = null,
    withholdFirstResponse = false,
  } = {}) {
    super();
    this.artifacts = artifacts;
    this.disposition = disposition;
    this.responseMutator = responseMutator;
    this.withholdFirstResponse = withholdFirstResponse;
    this.targetRequests = [];
    this.targetApplyCount = 0;
    this.canonicalTargetRequest = null;
    this.canonicalTargetResult = null;
  }

  async getInstallationStatus() {
    this.artifacts.trace.push('api:installation');
    this.calls.push(['installationStatus']);
    return {
      v: 'hark.installation-status.v2',
      installation: { id: TARGET_INSTALLATION, protocol: 'codex', runtimeId: 'runtime-1' },
    };
  }

  async getAwait(awaitId) {
    this.artifacts.trace.push('api:detail');
    this.calls.push(['getAwait', awaitId]);
    return structuredClone(this.artifacts.detail);
  }

  async claimCrashRecovery(awaitId, body, { signal } = {}) {
    this.artifacts.trace.push('api:claim');
    this.calls.push(['claimCrashRecovery', awaitId, structuredClone(body)]);
    this.targetRequests.push(structuredClone(body));
    if (this.canonicalTargetRequest === null) {
      this.canonicalTargetRequest = structuredClone(body);
      this.targetApplyCount += 1;
      this.canonicalTargetResult = {
        v: 'hark.crash-recovery-claim-result.v1',
        wake: structuredClone(this.artifacts.wake),
        claim: {
          continuationMode: 'crash_recovery',
          leaseToken: TARGET_LEASE,
          leaseGeneration: 2,
          leaseExpiresAt: '2026-08-07T12:00:32.000Z',
          disposition: this.disposition,
          wakeDeliveryDigest: body.wake.wakeDeliveryDigest,
          recoveryProofDigest: sha256Canonical(body),
        },
      };
    } else {
      assert.deepEqual(body, this.canonicalTargetRequest);
    }
    if (this.withholdFirstResponse && this.targetRequests.length === 1) {
      await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          const error = new Error('targeted_claim_response_withheld');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        signal?.addEventListener('abort', () => {
          const error = new Error('targeted_claim_response_withheld');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    const result = {
      ...structuredClone(this.canonicalTargetResult),
      replay: this.targetRequests.length > 1,
    };
    this.responseMutator?.(result);
    return result;
  }
}

class DispatchIntentGate extends HarkHookInbox {
  constructor(dataDir) {
    super(dataDir);
    this.intentCalls = 0;
    this.intentEntered = new Promise((resolve) => { this.resolveIntentEntered = resolve; });
    this.intentReleased = new Promise((resolve) => { this.resolveIntentReleased = resolve; });
  }

  async publishWakeDispatchIntent(...args) {
    this.intentCalls += 1;
    this.resolveIntentEntered();
    await this.intentReleased;
    return super.publishWakeDispatchIntent(...args);
  }

  releaseIntent() {
    this.resolveIntentReleased();
  }
}

class DispatchObservationJournal extends HarkJournal {
  constructor(dataDir) {
    super(dataDir);
    this.dispatchingReads = 0;
  }

  async read() {
    const journal = await super.read();
    if (journal.wakes[TARGET_WAKE]?.state === 'dispatching') this.dispatchingReads += 1;
    return journal;
  }
}

function targetedCrashCertifier(artifacts, { disposition = 'recovery_authorized' } = {}) {
  const calls = [];
  const protocol = {
    async listAwaitRequests() {
      artifacts.trace.push('local:list');
      return [artifacts.request];
    },
    async readArmAttempt() {
      artifacts.trace.push('local:arm-attempt');
      return artifacts.armAttempt;
    },
    async readHeldCallOriginAbortReceipt() {
      artifacts.trace.push('local:abort-receipt');
      return artifacts.originAbortReceipt;
    },
    async readArmBinding() {
      artifacts.trace.push('local:arm-binding');
      return artifacts.armBinding;
    },
    async readWaiterReady() {
      artifacts.trace.push('local:waiter-ready');
      return artifacts.waiterReady;
    },
    async readCommitAttempt() {
      artifacts.trace.push('local:commit-attempt');
      return artifacts.commitAttempt;
    },
    async readSuspensionCommitted() {
      artifacts.trace.push('local:suspension-committed');
      return artifacts.suspensionCommitted;
    },
  };
  return {
    calls,
    protocol,
    setOriginAbortProofProvider() {},
    async reconcileHeldCallCrash(request, options) {
      artifacts.trace.push('local:reconcile');
      calls.push({ request, options });
      if (disposition !== 'recovery_authorized') return { kind: disposition };
      return {
        kind: 'recovery_authorized',
        originAbortReceipt: artifacts.originAbortReceipt,
        suspensionCommitted: artifacts.suspensionCommitted,
      };
    },
    async poll(signal) {
      if (signal?.aborted) return;
      await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));
    },
  };
}

async function eventually(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError ?? new Error('eventually_timeout');
}

async function targetedCrashEnvironment({
  artifacts = targetedCrashArtifacts(),
  service = undefined,
  certifier = undefined,
  heldRecovery = undefined,
  journal = undefined,
  hookInbox = undefined,
  appServers = undefined,
  credentialsStore = undefined,
  installation = undefined,
  start = true,
} = {}) {
  const directory = journal ? journal.dataDir : await mkdtemp(
    path.join(os.tmpdir(), 'hark-targeted-crash-'),
  );
  const actualJournal = journal ?? new HarkJournal(directory);
  const actualHookInbox = hookInbox ?? new HarkHookInbox(directory);
  const actualAppServers = appServers ?? new AppServerHarness();
  actualAppServers.hookInbox = actualHookInbox;
  if (!actualAppServers.thread.turns.some((turn) => turn.id === artifacts.request.turnId)) {
    actualAppServers.thread.turns.push({
      id: artifacts.request.turnId,
      status: 'interrupted',
      startedAt: 1_786_086_000,
      completedAt: 1_786_086_001,
      items: [],
      error: { message: 'simulated_owner_process_death' },
    });
  }
  const actualService = service ?? new TargetedCrashService(artifacts);
  const actualCertifier = certifier ?? targetedCrashCertifier(artifacts);
  const actualHeldRecovery = heldRecovery ?? {
    async recoverHeldTool() { throw new Error('unexpected_recover_held_tool'); },
    async recoverWaiter() { return { action: 'probe_origin', context: artifacts.context }; },
  };
  const actualInstallation = installation ?? {
    id: TARGET_INSTALLATION,
    protocol: 'codex',
    runtimeId: 'runtime-1',
  };
  const supervisor = new HarkCodexSupervisor({
    appServerClientFactory: actualAppServers.createClient,
    serviceClient: actualService,
    credentialsStore: credentialsStore ?? credentialsStoreFor(actualInstallation),
    journal: actualJournal,
    runtimeId: 'runtime-1',
    installation: actualInstallation,
    now: () => new Date('2026-08-07T12:00:02.000Z'),
    transcriptProof: abortedTranscriptProof(),
    hookInbox: actualHookInbox,
    heldRecovery: actualHeldRecovery,
    heldWaitCertifier: actualCertifier,
    heldCrashRecoveryPollIntervalMs: 25,
  });
  if (start) await supervisor.start({ poll: true });
  return {
    artifacts,
    service: actualService,
    certifier: actualCertifier,
    heldRecovery: actualHeldRecovery,
    supervisor,
    journal: actualJournal,
    hookInbox: actualHookInbox,
    appServers: actualAppServers,
  };
}

function abortedTranscriptProof() {
  const baseline = cleanTranscriptProof();
  const originTerminal = {
    type: 'turn_aborted', observedAt: '2026-08-07T12:00:01.000Z',
  };
  return cleanTranscriptProof({
    async preflight(boundary, options) {
      return { ...await baseline.preflight(boundary, options), originTerminal };
    },
    async prove(boundary, options) {
      return { ...await baseline.prove(boundary, options), originTerminal };
    },
  });
}

async function factoryEnvironment({
  appServers = new AppServerHarness(),
  service = new FakeService(),
  journal = undefined,
  transcriptProof = cleanTranscriptProof(),
  heldRecovery = undefined,
  heldWaitCertifier = undefined,
  credentialsStore = undefined,
  installation = DEFAULT_INSTALLATION,
  start = true,
  wakeAdmissionAckTimeoutMs = undefined,
} = {}) {
  const directory = journal ? null : await mkdtemp(path.join(os.tmpdir(), 'hark-supervisor-factory-'));
  const actualJournal = journal ?? new HarkJournal(directory);
  const hookInbox = new HarkHookInbox(actualJournal.dataDir);
  appServers.hookInbox = hookInbox;
  const supervisor = new HarkCodexSupervisor({
    appServerClientFactory: appServers.createClient,
    serviceClient: service,
    credentialsStore: credentialsStore ?? credentialsStoreFor(installation),
    journal: actualJournal,
    runtimeId: 'runtime-1',
    installation,
    now: () => new Date('2026-08-07T12:00:02.000Z'),
    transcriptProof,
    hookInbox,
    heldRecovery,
    heldWaitCertifier,
    wakeAdmissionAckTimeoutMs,
  });
  if (start) await supervisor.start({ poll: false });
  return {
    appServers,
    service,
    journal: actualJournal,
    supervisor,
    transcriptProof,
    hookInbox,
    heldWaitCertifier,
  };
}

async function suspendOrigin({ appServers, service, supervisor }) {
  const draft = prepared();
  await supervisor.observeItemCompleted({
    threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1_786_086_000_000,
    transcriptBoundary: {
      sessionId: 'thread-1', originTaskId: 'turn-1',
      transcriptPath: '/tmp/codex-home/sessions/thread-1.jsonl',
    },
    item: {
      id: 'item-1', type: 'mcpToolCall', server: 'hark', tool: 'hark_await',
      status: 'completed',
      arguments: {
        request: draft.request, name: draft.name, source: draft.source, condition: draft.condition,
      },
      result: { structuredContent: draft, content: [] },
    },
  });
  await supervisor.observeTurnCompleted({
    threadId: 'thread-1',
    turn: {
      id: 'turn-1', status: 'completed', startedAt: 1_786_085_999,
      completedAt: 1_786_086_001, items: [], error: null,
    },
  });
  if (!appServers.thread.turns.some((turn) => turn.id === 'turn-1')) {
    appServers.thread.turns.push({
      id: 'turn-1', status: 'completed', startedAt: 1_786_085_999,
      completedAt: 1_786_086_001, items: [], error: null,
    });
  }
  return { draft, armed: service.armed };
}

function wakeResult(armed, overrides = {}) {
  return {
    v: 'hark.wake-next-result.v2',
    wake: {
      v: 'hark.wake.v2', wakeId: 'wake-1', idempotencyKey: 'idem-1', awaitId: 'await-1',
      origin: armed.origin, checkpoint: armed.checkpoint, prepared: armed.prepared,
      signal: {
        id: 'signal-1', sourceSignalId: 'source-1', type: armed.prepared.source.kind,
        subject: armed.prepared.source.subject,
        qualificationDigest: armed.prepared.qualificationDigest,
        observedAt: '2026-08-07T12:00:02.000Z', summary: 'Job completed.', data: {}, evidence: [],
      },
      createdAt: '2026-08-07T12:00:02.000Z',
      ...overrides.wake,
    },
    claim: {
      leaseToken: 'lease-1', leaseGeneration: 1,
      leaseExpiresAt: '2026-08-07T12:01:02.000Z', disposition: 'dispatch',
      ...overrides.claim,
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-supervisor-'));
  const appServer = new FakeAppServer();
  const service = new FakeService();
  const journal = new HarkJournal(directory);
  const hookInbox = new HarkHookInbox(directory);
  appServer.hookInbox = hookInbox;
  const transcriptProof = {
    async preflight(boundary, { scannedAt }) {
      return {
        v: 'hark.codex-wait-preflight.v1',
        historySource: 'codex.rollout-jsonl.v1',
        conversationId: boundary.sessionId,
        originTaskId: boundary.originTaskId,
        originTerminal: {
          type: 'task_complete', observedAt: '2026-08-07T12:00:01.000Z',
        },
        interveningTaskIds: [],
        rollbackMarkerCount: 0,
        historyMutationCount: 0,
        scannedAt,
        historyDigest: 'b'.repeat(64),
      };
    },
    async prove(boundary, { wakeTaskId, scannedAt }) {
      return {
        v: 'hark.codex-wait-history-proof.v1',
        historySource: 'codex.rollout-jsonl.v1',
        conversationId: boundary.sessionId,
        originTaskId: boundary.originTaskId,
        wakeTaskId,
        originTerminal: {
          type: 'task_complete', observedAt: '2026-08-07T12:00:01.000Z',
        },
        interveningTaskIds: [],
        rollbackMarkerCount: 0,
        historyMutationCount: 0,
        scannedAt,
        historyDigest: 'a'.repeat(64),
        wakeResponseDigest: 'd'.repeat(64),
      };
    },
  };
  const supervisor = new HarkCodexSupervisor({
    appServerClient: appServer,
    serviceClient: service,
    credentialsStore: credentialsStoreFor(),
    journal,
    runtimeId: 'runtime-1',
    installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
    now: () => new Date('2026-08-07T12:00:02.000Z'),
    transcriptProof,
    hookInbox,
  });
  await supervisor.start({ poll: false });
  return { appServer, service, journal, supervisor, hookInbox };
}

test('arms from trusted item identity and commits only after successful turn completion', async () => {
  const { service, journal, supervisor } = await fixture();
  const draft = prepared();
  await supervisor.observeItemCompleted({
    threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1_786_086_000_000,
    transcriptBoundary: {
      sessionId: 'thread-1', originTaskId: 'turn-1',
      transcriptPath: '/tmp/codex-home/sessions/thread-1.jsonl',
    },
    item: {
      id: 'item-1', type: 'mcpToolCall', server: 'hark', tool: 'hark_await',
      status: 'completed',
      arguments: {
        request: draft.request, name: draft.name, source: draft.source, condition: draft.condition,
      },
      result: { structuredContent: draft, content: [] },
    },
  });
  assert.deepEqual(service.calls.map((call) => call[0]), ['arm']);
  const arm = service.calls[0][1];
  assert.deepEqual(arm.origin, {
    protocol: 'codex', runtimeId: 'runtime-1', taskId: 'turn-1', conversationId: 'thread-1',
  });
  assert.equal(arm.prepared.request, 'Continue job 42.');
  assert.equal(arm.prepared.v, 'hark.await-prepared.v1');

  await supervisor.observeTurnCompleted({
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'completed', completedAt: 1_786_086_001, items: [], error: null },
  });
  assert.deepEqual(service.calls.map((call) => call[0]), ['arm', 'commit']);
  const stored = await journal.read();
  assert.deepEqual(
    stored.preparations[draft.preparationNonce].binding.installation,
    DEFAULT_INSTALLATION,
  );
  assert.deepEqual(stored.awaits['await-1'].installation, DEFAULT_INSTALLATION);
  assert.equal(stored.awaits['await-1'].state, 'suspended');
  assert.equal(stored.awaits['await-1'].suspensionReceipt.kind, 'monitoring_task_suspended');
  await supervisor.stop();
});

test('observed preparation is installation-bound before arm and only its origin can replay', async () => {
  const installationA = structuredClone(DEFAULT_INSTALLATION);
  const installationB = { ...installationA, id: 'installation-2' };
  let activeInstallation = installationA;
  const statusCalls = [];
  let armRequests = 0;
  let armEffects = 0;
  let canonicalArm = null;
  const service = new FakeService();
  service.getInstallationStatus = async () => {
    statusCalls.push(activeInstallation.id);
    return {
      v: 'hark.installation-status.v2',
      installation: structuredClone(activeInstallation),
    };
  };
  service.armAwait = async (body) => {
    service.calls.push(['arm', structuredClone(body)]);
    armRequests += 1;
    if (!canonicalArm) {
      canonicalArm = structuredClone(body);
      armEffects += 1;
      throw new Error('arm_response_withheld');
    }
    assert.deepEqual(body, canonicalArm);
    service.armed = body;
    return armApiResponse(body, { replay: true });
  };
  const credentialsStore = {
    async read() {
      return {
        apiBaseUrl: 'https://api.example.test',
        accessToken: 'test-secret',
        installation: structuredClone(activeInstallation),
      };
    },
  };

  const first = await factoryEnvironment({
    service,
    credentialsStore,
    installation: installationA,
  });
  first.supervisor.on('supervisorError', () => undefined);
  await assert.rejects(
    first.supervisor.observeItemCompleted(preparedItemCompletedEvent()),
    /arm_response_withheld/,
  );
  let state = await first.journal.read();
  const nonce = prepared().preparationNonce;
  assert.equal(state.preparations[nonce].state, 'observed');
  assert.deepEqual(state.preparations[nonce].binding.installation, installationA);
  assert.equal(armRequests, 1);
  assert.equal(armEffects, 1);

  activeInstallation = installationB;
  const statusBeforeB = statusCalls.length;
  const armsBeforeB = armRequests;
  const second = await factoryEnvironment({
    appServers: new AppServerHarness(),
    service,
    journal: first.journal,
    credentialsStore,
    installation: installationB,
    start: false,
  });
  await assert.rejects(
    second.supervisor.start({ poll: false }),
    /installation_identity_fence_mismatch/,
  );
  assert.equal(statusCalls.length - statusBeforeB, 1);
  assert.equal(armRequests, armsBeforeB);
  assert.equal(second.appServers.calls.length, 0);
  state = await first.journal.read();
  assert.equal(state.preparations[nonce].state, 'observed');
  assert.equal(state.awaits['await-1'], undefined);

  activeInstallation = installationA;
  const third = await factoryEnvironment({
    appServers: new AppServerHarness(),
    service,
    journal: first.journal,
    credentialsStore,
    installation: installationA,
  });
  state = await third.journal.read();
  assert.equal(armRequests, 2);
  assert.equal(armEffects, 1);
  assert.equal(state.preparations[nonce].state, 'armed');
  assert.deepEqual(state.awaits['await-1'].installation, installationA);
  await third.supervisor.stop();
});

test('legacy observed preparation without installation identity makes no remote call', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-supervisor-legacy-'));
  const journal = new HarkJournal(directory);
  const draft = prepared();
  await journal.recordPreparation(draft, {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    toolName: 'mcp__hark__hark_await',
    inputDigest: '9'.repeat(64),
    origin: {
      protocol: 'codex', runtimeId: 'runtime-1', taskId: 'turn-1', conversationId: 'thread-1',
    },
    checkpoint: { version: 'hark.codex-checkpoint.v1', digest: 'a'.repeat(64) },
    transcriptBoundary: null,
  });
  let selfReads = 0;
  let armCalls = 0;
  const service = new FakeService();
  service.getInstallationStatus = async () => {
    selfReads += 1;
    return { v: 'hark.installation-status.v2', installation: DEFAULT_INSTALLATION };
  };
  service.armAwait = async () => { armCalls += 1; throw new Error('must_not_arm'); };
  const environment = await factoryEnvironment({ service, journal, start: false });
  await assert.rejects(
    environment.supervisor.start({ poll: false }),
    /expected_installation_object_required/,
  );
  assert.equal(selfReads, 0);
  assert.equal(armCalls, 0);
  assert.equal((await journal.read()).preparations[draft.preparationNonce].state, 'observed');
});

test('replacement installation cannot commit or cancel an Await armed by its origin', async (t) => {
  for (const terminalStatus of ['completed', 'failed']) {
    await t.test(terminalStatus, async () => {
      const installationA = structuredClone(DEFAULT_INSTALLATION);
      const installationB = { ...installationA, id: 'installation-2' };
      let activeInstallation = installationA;
      const credentialsStore = {
        async read() {
          return {
            apiBaseUrl: 'https://api.example.test',
            accessToken: 'test-secret',
            installation: structuredClone(activeInstallation),
          };
        },
      };
      const service = new FakeService();
      service.getInstallationStatus = async () => ({
        v: 'hark.installation-status.v2',
        installation: structuredClone(activeInstallation),
      });
      const first = await factoryEnvironment({
        service,
        credentialsStore,
        installation: installationA,
      });
      await first.supervisor.observeItemCompleted(preparedItemCompletedEvent());
      assert.equal((await first.journal.read()).awaits['await-1'].state, 'armed');

      activeInstallation = installationB;
      first.supervisor.on('supervisorError', () => undefined);
      await assert.rejects(first.supervisor.observeTurnCompleted({
        threadId: 'thread-1',
        turn: {
          id: 'turn-1', status: terminalStatus, completedAt: 1_786_086_001, items: [], error: null,
        },
      }), /installation_identity_fence_mismatch/);
      assert.equal(
        service.calls.filter(([kind]) => ['commit', 'cancel'].includes(kind)).length,
        0,
      );
      let state = await first.journal.read();
      assert.equal(state.turnCompletions['turn-1'], undefined);
      assert.equal(state.awaits['await-1'].state, 'armed');

      activeInstallation = installationA;
      const restored = await factoryEnvironment({
        appServers: new AppServerHarness(),
        service,
        journal: first.journal,
        credentialsStore,
        installation: installationA,
      });
      await restored.supervisor.observeTurnCompleted({
        threadId: 'thread-1',
        turn: {
          id: 'turn-1', status: terminalStatus, completedAt: 1_786_086_001, items: [], error: null,
        },
      });
      state = await restored.journal.read();
      assert.equal(
        service.calls.filter(([kind]) => kind === (terminalStatus === 'completed' ? 'commit' : 'cancel')).length,
        1,
      );
      assert.equal(
        state.awaits['await-1'].state,
        terminalStatus === 'completed' ? 'suspended' : 'cancelled',
      );
      await restored.supervisor.stop();
    });
  }
});

test('claims, journals, and wakes the exact same thread once, then records completion', async () => {
  const { appServer, service, journal, supervisor } = await fixture();
  const draft = prepared();
  await supervisor.observeItemCompleted({
    threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1_786_086_000_000,
    transcriptBoundary: {
      sessionId: 'thread-1', originTaskId: 'turn-1',
      transcriptPath: '/tmp/codex-home/sessions/thread-1.jsonl',
    },
    item: {
      id: 'item-1', type: 'mcpToolCall', server: 'hark', tool: 'hark_await',
      status: 'completed',
      arguments: {
        request: draft.request, name: draft.name, source: draft.source, condition: draft.condition,
      },
      result: { structuredContent: draft, content: [] },
    },
  });
  await supervisor.observeTurnCompleted({
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'completed', completedAt: 1_786_086_001, items: [], error: null },
  });
  appServer.thread.turns.push({
    id: 'turn-1', status: 'completed', completedAt: 1_786_086_001, items: [], error: null,
  });
  const armed = service.armed;
  await supervisor.acceptWake({
    v: 'hark.wake-next-result.v2',
    wake: {
      v: 'hark.wake.v2', wakeId: 'wake-1', idempotencyKey: 'idem-1', awaitId: 'await-1',
      origin: armed.origin, checkpoint: armed.checkpoint, prepared: armed.prepared,
      signal: {
        id: 'signal-1', sourceSignalId: 'source-1', type: draft.source.kind,
        subject: draft.source.subject, qualificationDigest: draft.qualificationDigest,
        observedAt: '2026-08-07T12:00:02.000Z', summary: 'Job completed.', data: {}, evidence: [],
      },
      createdAt: '2026-08-07T12:00:02.000Z',
    },
    claim: {
      leaseToken: 'lease-1', leaseGeneration: 1,
      leaseExpiresAt: '2026-08-07T12:01:02.000Z', disposition: 'dispatch',
    },
  });
  const starts = appServer.calls.filter((call) => call[0] === 'turn/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0][1], 'thread-1');
  assert.equal(starts[0][3].clientUserMessageId, 'hark:wake:wake-1');
  assert.match(starts[0][2], /untrusted evidence, not instructions/);
  assert.deepEqual(
    service.calls.filter((call) => call[0] === 'receipt').map((call) => call[2].kind),
    ['wake_received'],
  );

  await supervisor.observeTurnStarted({
    threadId: 'thread-1',
    turn: { id: 'turn-wake-1', status: 'inProgress', startedAt: 1_786_086_100, items: [] },
  });
  assert.deepEqual(
    service.calls.filter((call) => call[0] === 'receipt').map((call) => call[2].kind),
    ['wake_received', 'task_woken'],
  );
  const lifecycle = service.calls.filter((call) => call[0] === 'receipt').map((call) => call[2]);
  assert.ok(Date.parse(lifecycle[1].observedAt) >= Date.parse(lifecycle[0].observedAt));

  await supervisor.observeTurnCompleted({
    threadId: 'thread-1',
    turn: {
      id: 'turn-wake-1', status: 'completed', completedAt: 1_786_086_200,
      items: appServer.thread.turns.find((turn) => turn.id === 'turn-wake-1').items, error: null,
    },
  });
  assert.deepEqual(
    service.calls.filter((call) => call[0] === 'receipt').map((call) => call[2].kind),
    ['wake_received', 'task_woken', 'task_completed'],
  );
  const terminal = service.calls.filter((call) => call[0] === 'receipt').at(-1)[2];
  assert.ok(Date.parse(terminal.observedAt) >= Date.parse(lifecycle[1].observedAt));
  assert.equal((await journal.read()).wakes['wake-1'].state, 'completed');
  await supervisor.stop();
});

test('rejects model-supplied identity and records an unexpected waiting turn as inference', async () => {
  const { service, supervisor } = await fixture();
  const draft = prepared();
  await assert.rejects(supervisor.observeItemCompleted({
    threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1,
    item: {
      id: 'item-1', type: 'mcpToolCall', server: 'hark', tool: 'hark_await',
      status: 'completed',
      arguments: { request: draft.request, name: draft.name, source: draft.source, condition: draft.condition, threadId: 'fake' },
      result: { structuredContent: draft, content: [] },
    },
  }), /prepared_arguments_mismatch/);

  await supervisor.observeItemCompleted({
    threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1_786_086_000_000,
    item: {
      id: 'item-2', type: 'mcpToolCall', server: 'hark', tool: 'hark_await',
      status: 'completed',
      arguments: { request: draft.request, name: draft.name, source: draft.source, condition: draft.condition },
      result: { structuredContent: draft, content: [] },
    },
  });
  await supervisor.observeTurnCompleted({
    threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], error: null },
  });
  await supervisor.observeTurnStarted({
    threadId: 'thread-1', turn: { id: 'turn-unexpected', status: 'inProgress', startedAt: 1_786_086_050, items: [] },
  });
  assert.equal(service.calls.at(-1)[2].kind, 'model_call');
  await supervisor.stop();
});

test('loaded idle dispatch uses a fresh short connection, never resumes, and closes', async () => {
  const environment = await factoryEnvironment();
  const { appServers, journal, supervisor } = environment;
  const { armed } = await suspendOrigin(environment);

  await supervisor.acceptWake(wakeResult(armed));

  assert.equal(appServers.instances.length, 2);
  const [configClient, dispatchClient] = appServers.instances;
  assert.notEqual(configClient, dispatchClient);
  assert.deepEqual(configClient.calls.map((call) => call[0]), ['start', 'config/read', 'close']);
  assert.deepEqual(
    dispatchClient.calls.map((call) => call[0]),
    ['start', 'thread/read', 'turn/start', 'close'],
  );
  assert.equal(appServers.callsFor('thread/resume').length, 0);
  assert.equal(appServers.callsFor('thread/unsubscribe').length, 0);
  assert.equal(dispatchClient.closed, true);
  assert.equal((await journal.read()).wakes['wake-1'].state, 'submitted');
  await supervisor.stop();
});

test('notLoaded wake resumes and starts on one short connection, then restart recovers terminal evidence through fresh reads', async () => {
  const appServers = new AppServerHarness({ status: 'notLoaded' });
  const environment = await factoryEnvironment({ appServers });
  const { service, journal, supervisor, transcriptProof } = environment;
  const { armed } = await suspendOrigin(environment);

  await supervisor.acceptWake(wakeResult(armed));

  assert.equal(appServers.instances.length, 2);
  const dispatchClient = appServers.instances[1];
  assert.deepEqual(
    dispatchClient.calls.map((call) => call[0]),
    ['start', 'thread/read', 'thread/resume', 'turn/start', 'thread/unsubscribe', 'close'],
  );
  const resumedBy = appServers.callsFor('thread/resume')[0][0];
  const startedBy = appServers.callsFor('turn/start')[0][0];
  const unsubscribedBy = appServers.callsFor('thread/unsubscribe')[0][0];
  assert.equal(resumedBy, dispatchClient.id);
  assert.equal(startedBy, dispatchClient.id);
  assert.equal(unsubscribedBy, dispatchClient.id);
  assert.equal(dispatchClient.closed, true);

  const persistedWake = appServers.thread.turns.find((turn) => turn.id === 'turn-wake-1');
  persistedWake.status = 'completed';
  persistedWake.completedAt = 1_786_086_200;
  await supervisor.stop();

  const beforeRecovery = appServers.instances.length;
  const recovered = await factoryEnvironment({
    appServers,
    service,
    journal,
    transcriptProof,
  });
  const recoveryClients = appServers.instances.slice(beforeRecovery);
  assert.equal(recoveryClients.length, 3);
  assert.deepEqual(
    recoveryClients.map((client) => client.calls.map((call) => call[0])),
    [
      ['start', 'config/read', 'close'],
      ['start', 'thread/read', 'close'],
      ['start', 'thread/read', 'close'],
    ],
  );
  assert.ok(recoveryClients.every((client) => client !== dispatchClient));
  assert.equal((await journal.read()).wakes['wake-1'].state, 'completed');
  assert.deepEqual(
    service.calls.filter((call) => call[0] === 'receipt').map((call) => call[2].kind),
    ['wake_received', 'task_woken', 'task_completed'],
  );
  await recovered.supervisor.stop();
});

test('active thread defers wake without preflight, resume, or turn/start', async () => {
  const appServers = new AppServerHarness({ status: 'active' });
  let preflightCalls = 0;
  const transcriptProof = cleanTranscriptProof({
    async preflight() {
      preflightCalls += 1;
      throw new Error('preflight_must_not_run_for_active_thread');
    },
  });
  const environment = await factoryEnvironment({ appServers, transcriptProof });
  const { armed } = await suspendOrigin(environment);

  await environment.supervisor.acceptWake(wakeResult(armed));

  assert.equal(preflightCalls, 0);
  assert.equal(appServers.callsFor('thread/resume').length, 0);
  assert.equal(appServers.callsFor('turn/start').length, 0);
  assert.deepEqual(
    appServers.instances[1].calls.map((call) => call[0]),
    ['start', 'thread/read', 'close'],
  );
  const wake = (await environment.journal.read()).wakes['wake-1'];
  assert.equal(wake.state, 'dispatch_deferred');
  assert.equal(wake.deferredReason, 'codex_thread_active');
  await environment.supervisor.stop();
});

test('explicit direct-input denial and subagent identity reject before dispatch', async (t) => {
  const cases = [
    {
      name: 'explicit canAcceptDirectInput false',
      options: { canAcceptDirectInput: false },
      error: /codex_thread_direct_input_unsupported/,
    },
    {
      name: 'subagent parent thread',
      options: { parentThreadId: 'thread-parent' },
      error: /codex_subagent_thread_unsupported/,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const appServers = new AppServerHarness(scenario.options);
      const environment = await factoryEnvironment({ appServers });
      const { armed } = await suspendOrigin(environment);

      await assert.rejects(
        environment.supervisor.acceptWake(wakeResult(armed)),
        scenario.error,
      );

      assert.equal(appServers.callsFor('thread/resume').length, 0);
      assert.equal(appServers.callsFor('turn/start').length, 0);
      assert.equal(appServers.instances[1].closed, true);
    });
  }
});

test('intervening task or rollback preflight evidence fails dispatch with zero turn/start', async (t) => {
  const cases = [
    {
      name: 'intervening task',
      interveningTaskIds: ['turn-manual'],
      rollbackMarkerCount: 0,
    },
    {
      name: 'rollback marker',
      interveningTaskIds: [],
      rollbackMarkerCount: 1,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const appServers = new AppServerHarness();
      const transcriptProof = cleanTranscriptProof({
        async preflight(boundary, { scannedAt }) {
          return {
            v: 'hark.codex-wait-preflight.v1',
            historySource: 'codex.rollout-jsonl.v1',
            conversationId: boundary.sessionId,
            originTaskId: boundary.originTaskId,
            originTerminal: {
              type: 'task_complete', observedAt: '2026-08-07T12:00:01.000Z',
            },
            interveningTaskIds: scenario.interveningTaskIds,
            rollbackMarkerCount: scenario.rollbackMarkerCount,
            historyMutationCount: 0,
            scannedAt,
            historyDigest: 'c'.repeat(64),
          };
        },
      });
      const environment = await factoryEnvironment({ appServers, transcriptProof });
      const { armed } = await suspendOrigin(environment);
      if (scenario.interveningTaskIds.length > 0) {
        appServers.thread.turns.push({
          id: 'turn-manual', status: 'completed', startedAt: 1_786_086_010,
          completedAt: 1_786_086_011, items: [], error: null,
        });
      }

      await environment.supervisor.acceptWake(wakeResult(armed));

      assert.equal(appServers.callsFor('thread/resume').length, 0);
      assert.equal(appServers.callsFor('turn/start').length, 0);
      const receiptKinds = environment.service.calls
        .filter((call) => call[0] === 'receipt')
        .map((call) => call[2].kind);
      assert.equal(receiptKinds.at(-1), 'dispatch_failed');
      assert.equal(receiptKinds.includes('task_woken'), false);
      const failed = (await environment.journal.read()).wakes['wake-1'];
      assert.equal(failed.state, 'failed');
      assert.equal(
        failed.dispatchFailedReceipt.result.dispatchResolution.kind,
        'wait_history_ineligible',
      );
      assert.deepEqual(
        failed.dispatchFailedReceipt.result.dispatchResolution.interveningTaskIds,
        scenario.interveningTaskIds,
      );
      assert.equal(
        failed.dispatchFailedReceipt.result.dispatchResolution.rollbackMarkerCount,
        scenario.rollbackMarkerCount,
      );
      await environment.supervisor.stop();
    });
  }
});

test('transient incomplete preflight defers and performs no resume or turn/start', async () => {
  const appServers = new AppServerHarness();
  const transcriptProof = cleanTranscriptProof({
    async preflight() {
      throw new Error('codex_rollout_incomplete_tail');
    },
  });
  const environment = await factoryEnvironment({ appServers, transcriptProof });
  const { armed } = await suspendOrigin(environment);

  await environment.supervisor.acceptWake(wakeResult(armed));

  assert.equal(appServers.callsFor('thread/resume').length, 0);
  assert.equal(appServers.callsFor('turn/start').length, 0);
  const wake = (await environment.journal.read()).wakes['wake-1'];
  assert.equal(wake.state, 'dispatch_deferred');
  assert.equal(wake.deferredReason, 'codex_rollout_incomplete_tail');
  assert.deepEqual(
    environment.service.calls.filter((call) => call[0] === 'receipt').map((call) => call[2].kind),
    ['wake_received'],
  );
  await environment.supervisor.stop();
});

test('marker and prompt persisted under a different turn ID never produce task_woken', async () => {
  const appServers = new AppServerHarness({
    startResponseTurnId: 'turn-response',
    persistedTurnId: 'turn-history-other',
  });
  const environment = await factoryEnvironment({ appServers });
  const { armed } = await suspendOrigin(environment);
  await environment.supervisor.acceptWake(wakeResult(armed));

  await assert.rejects(environment.supervisor.observeTurnStarted({
    threadId: 'thread-1',
    turn: {
      id: 'turn-response', status: 'inProgress', startedAt: 1_786_086_100,
      items: [], error: null,
    },
  }), /wake_history_marker_mismatch/);

  assert.equal(appServers.callsFor('turn/start').length, 1);
  assert.equal(appServers.callsFor('thread/read').length, 2);
  assert.deepEqual(
    environment.service.calls.filter((call) => call[0] === 'receipt').map((call) => call[2].kind),
    ['wake_received'],
  );
  assert.equal((await environment.journal.read()).wakes['wake-1'].state, 'submitted');
});

test('missing prompt-hook admission acknowledgement fails closed after turn/start', async () => {
  const appServers = new AppServerHarness({ autoAdmitWake: false });
  const environment = await factoryEnvironment({
    appServers,
    wakeAdmissionAckTimeoutMs: 10,
  });
  const { armed } = await suspendOrigin(environment);
  await assert.rejects(
    environment.supervisor.acceptWake(wakeResult(armed)),
    /hook_wake_admission_ack_timeout/,
  );
  const wake = (await environment.journal.read()).wakes['wake-1'];
  assert.equal(wake.state, 'dispatching');
  assert.equal(wake.dispatchResponseObserved, true);
  assert.equal(wake.promptAdmissionAck, undefined);
  assert.equal(appServers.callsFor('turn/start').length, 1);
  assert.deepEqual(
    environment.service.calls.filter((call) => call[0] === 'receipt').map((call) => call[2].kind),
    ['wake_received'],
  );
});

test('recover_dispatch adopts the admitted prior turn under a newer fenced lease', async () => {
  const environment = await factoryEnvironment();
  const { armed } = await suspendOrigin(environment);
  await environment.supervisor.acceptWake(wakeResult(armed));
  const before = await environment.journal.read();
  assert.equal(before.wakes['wake-1'].wakeAdmission.leaseGeneration, 1);
  assert.equal(before.wakes['wake-1'].state, 'submitted');

  await environment.supervisor.acceptWake(wakeResult(armed, {
    claim: {
      leaseToken: 'lease-2',
      leaseGeneration: 2,
      disposition: 'recover_dispatch',
    },
  }));

  const after = await environment.journal.read();
  assert.equal(after.wakes['wake-1'].state, 'running');
  assert.equal(after.wakes['wake-1'].wakeAdmission.leaseGeneration, 1);
  assert.equal(after.wakes['wake-1'].taskWokenReceipt.leaseGeneration, 2);
  assert.equal(environment.appServers.callsFor('turn/start').length, 1);
  assert.deepEqual(
    environment.service.calls.filter((call) => call[0] === 'receipt').map((call) => (
      [call[2].kind, call[2].leaseGeneration]
    )),
    [['wake_received', 1], ['task_woken', 2]],
  );
});

test('public or generic wake admission cannot inject held-call recovery', async () => {
  const environment = await factoryEnvironment();
  const { armed } = await suspendOrigin(environment);
  await assert.rejects(
    environment.supervisor.acceptWake(wakeResult(armed, {
      claim: {
        continuationMode: 'crash_recovery',
        leaseToken: 'lease-2',
        leaseGeneration: 2,
        disposition: 'recover_held_tool',
        wakeDeliveryDigest: 'd'.repeat(64),
        recoveryProofDigest: 'e'.repeat(64),
      },
    })),
    /generic_held_recovery_forbidden/,
  );
  await assert.rejects(
    environment.supervisor.acceptWake(wakeResult(armed, {
      claim: { disposition: 'recover_waiter' },
    })),
    /generic_held_recovery_forbidden/,
  );
  assert.equal(environment.appServers.callsFor('turn/start').length, 0);
  assert.equal((await environment.journal.read()).wakes['wake-1'], undefined);
  await environment.supervisor.stop();
});

test('generic non-held waiter recovery remains dispatch-compatible', async () => {
  const environment = await factoryEnvironment();
  const { armed } = await suspendOrigin(environment);
  await environment.journal.update((journal) => {
    journal.awaits['await-1'].binding = {
      ...journal.awaits['await-1'].binding,
      continuationMode: 'dispatch',
    };
    return journal;
  });
  await environment.supervisor.acceptWake(wakeResult(armed, {
    claim: { disposition: 'recover_waiter' },
  }));
  assert.equal(environment.appServers.callsFor('turn/start').length, 1);
  assert.ok((await environment.journal.read()).wakes['wake-1']);
  await environment.supervisor.stop();
});

test('missing positive abort receipt makes both generic and targeted polls inert', async () => {
  const artifacts = targetedCrashArtifacts({ receipt: false });
  const environment = await targetedCrashEnvironment({ artifacts });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.deepEqual(environment.service.calls, []);
  assert.equal(environment.certifier.calls.length, 0);
  assert.equal(environment.appServers.callsFor('turn/start').length, 0);
  assert.equal((await environment.journal.read()).wakes[TARGET_WAKE], undefined);
  await environment.supervisor.stop();
});

test('replacement installation gets only self-read before targeted recovery stops', async () => {
  const artifacts = targetedCrashArtifacts();
  const installationB = {
    id: '55555555-5555-4555-8555-555555555555',
    protocol: 'codex',
    runtimeId: 'runtime-1',
  };
  const service = new TargetedCrashService(artifacts);
  service.getInstallationStatus = async () => {
    artifacts.trace.push('api:installation');
    service.calls.push(['installationStatus']);
    return {
      v: 'hark.installation-status.v2',
      installation: structuredClone(installationB),
    };
  };
  const environment = await targetedCrashEnvironment({
    artifacts,
    service,
    credentialsStore: credentialsStoreFor(installationB),
    installation: installationB,
    start: false,
  });
  const failure = once(environment.supervisor, 'supervisorError');
  await environment.supervisor.start({ poll: true }).catch(() => undefined);
  const [error] = await failure;
  assert.match(error.message, /installation_identity_fence_mismatch/);
  assert.deepEqual(service.calls.map(([kind]) => kind), ['installationStatus']);
  assert.equal(environment.certifier.calls.length, 0);
  assert.equal(environment.appServers.callsFor('turn/start').length, 0);
  assert.equal((await environment.journal.read()).wakes[TARGET_WAKE], undefined);
  await environment.supervisor.stop();
});

test('owner-abort authority requires matching App Server and physical rollout terminals', async (t) => {
  await t.test('both exact terminals produce one deterministic secret-free proof', async () => {
    const { request, armAttempt } = heldCrashArtifacts();
    const heldWaitCertifier = crashCertifier(armAttempt);
    const environment = await factoryEnvironment({
      heldWaitCertifier,
      transcriptProof: abortedTranscriptProof(),
    });
    await suspendOrigin(environment);
    const origin = environment.appServers.thread.turns.find((turn) => turn.id === 'turn-1');
    origin.status = 'interrupted';
    const proof = await heldWaitCertifier.provide(request);
    assert.deepEqual(proof.appServer, {
      v: 'hark.codex-app-server-origin-terminal.v1',
      conversationId: 'thread-1',
      originTaskId: 'turn-1',
      turnStatus: 'interrupted',
      observedAt: '2026-08-07T12:00:02.000Z',
    });
    assert.deepEqual(proof.rollout.originTerminal, {
      type: 'turn_aborted',
      observedAt: '2026-08-07T12:00:01.000Z',
    });
    assert.equal(proof.rollout.scannedAt, '2026-08-07T12:00:02.000Z');
    assert.equal(/lease|token|secret|pid/i.test(JSON.stringify(proof)), false);
    await environment.supervisor.stop();
  });

  await t.test('App Server interruption without rollout abort grants no authority', async () => {
    const { request, armAttempt } = heldCrashArtifacts();
    const heldWaitCertifier = crashCertifier(armAttempt);
    const environment = await factoryEnvironment({ heldWaitCertifier });
    await suspendOrigin(environment);
    const origin = environment.appServers.thread.turns.find((turn) => turn.id === 'turn-1');
    origin.status = 'interrupted';
    assert.equal(await heldWaitCertifier.provide(request), null);
    await environment.supervisor.stop();
  });

  await t.test('rollout abort without App Server terminal grants no authority', async () => {
    const { request, armAttempt } = heldCrashArtifacts();
    const heldWaitCertifier = crashCertifier(armAttempt);
    const environment = await factoryEnvironment({
      heldWaitCertifier,
      transcriptProof: abortedTranscriptProof(),
    });
    await suspendOrigin(environment);
    assert.equal(await heldWaitCertifier.provide(request), null);
    await environment.supervisor.stop();
  });
});

test('targeted recovery proves locally, binds detail, claims, and dispatches in that order', async () => {
  const environment = await targetedCrashEnvironment();
  await eventually(() => {
    assert.equal(environment.appServers.callsFor('turn/start').length, 1);
    assert.ok((environment.service.calls.find((call) => call[0] === 'claimCrashRecovery')));
  });
  const trace = environment.artifacts.trace;
  assert.ok(trace.indexOf('local:abort-receipt') < trace.indexOf('api:installation'));
  assert.ok(trace.indexOf('api:installation') < trace.indexOf('local:reconcile'));
  assert.ok(trace.indexOf('local:reconcile') < trace.indexOf('api:detail'));
  assert.ok(trace.indexOf('api:detail') < trace.indexOf('api:claim'));
  assert.equal(
    environment.service.calls.filter((call) => call[0] === 'nextWake').length,
    0,
  );
  const claimBody = environment.service.targetRequests[0];
  assert.deepEqual(claimBody, {
    v: 'hark.crash-recovery-claim.v1',
    awaitId: TARGET_AWAIT,
    installation: {
      id: TARGET_INSTALLATION,
      protocol: 'codex',
      runtimeId: 'runtime-1',
    },
    wake: {
      wakeId: TARGET_WAKE,
      wakeDeliveryDigest: environment.artifacts.detail.wake.wakeDeliveryDigest,
    },
    origin: environment.artifacts.armAttempt.armRequest.origin,
    binding: environment.artifacts.armAttempt.armRequest.binding,
    checkpointDigest: environment.artifacts.armAttempt.armRequest.checkpoint.digest,
    qualificationDigest: environment.artifacts.armAttempt.armRequest.prepared.qualificationDigest,
    proof: {
      v: 'hark.held-call-origin-abort-ref.v1',
      originAbortReceiptDigest: sha256Canonical(environment.artifacts.originAbortReceipt),
      appServerTerminalEvidenceDigest:
        environment.artifacts.originAbortReceipt.appServerTerminalEvidenceDigest,
      rolloutAbortProofDigest:
        environment.artifacts.originAbortReceipt.rolloutAbortProofDigest,
    },
  });
  const wake = (await environment.journal.read()).wakes[TARGET_WAKE];
  assert.ok(wake);
  assert.deepEqual(wake.recoveryOriginTerminal, {
    type: 'turn_aborted', observedAt: '2026-08-07T12:00:01.000Z',
  });
  await environment.supervisor.stop();
});

test('periodic recovery cannot steal a live dispatch before its host-call intent', async () => {
  const artifacts = targetedCrashArtifacts();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-targeted-dispatch-gate-'));
  const journal = new DispatchObservationJournal(directory);
  const hookInbox = new DispatchIntentGate(directory);
  const environment = await targetedCrashEnvironment({
    artifacts,
    journal,
    hookInbox,
    start: false,
  });
  const failures = [];
  environment.supervisor.on('supervisorError', (error) => failures.push(error));
  await environment.supervisor.start({ poll: true });
  try {
    await hookInbox.intentEntered;
    const readsAtIntent = journal.dispatchingReads;
    await eventually(() => {
      assert.ok(journal.dispatchingReads > readsAtIntent);
    });
    const blocked = (await journal.read()).wakes[TARGET_WAKE];
    assert.equal(blocked.state, 'dispatching');
    assert.equal(blocked.dispatchIntent, undefined);
    assert.equal(await hookInbox.readWakeDispatchIntent(blocked.dispatchFence), null);
    assert.equal(hookInbox.intentCalls, 1);
    assert.deepEqual(failures, []);

    hookInbox.releaseIntent();
    await eventually(() => {
      assert.equal(environment.appServers.callsFor('turn/start').length, 1);
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(environment.service.targetApplyCount, 1);
    assert.equal(environment.appServers.callsFor('turn/start').length, 1);
    assert.deepEqual(failures, []);
    assert.ok((await journal.read()).wakes[TARGET_WAKE]);
  } finally {
    hookInbox.releaseIntent();
    await environment.supervisor.stop();
  }
});

test('a committed targeted claim with a withheld response replays identically after restart', async () => {
  const artifacts = targetedCrashArtifacts();
  const service = new TargetedCrashService(artifacts, { withholdFirstResponse: true });
  const first = await targetedCrashEnvironment({ artifacts, service });
  await eventually(() => assert.equal(service.targetRequests.length, 1));
  assert.equal(service.targetApplyCount, 1);
  assert.equal(first.appServers.callsFor('turn/start').length, 0);
  assert.equal((await first.journal.read()).wakes[TARGET_WAKE], undefined);
  await first.supervisor.stop();

  const second = await targetedCrashEnvironment({
    artifacts,
    service,
    journal: first.journal,
    hookInbox: first.hookInbox,
    appServers: first.appServers,
  });
  await eventually(() => assert.equal(first.appServers.callsFor('turn/start').length, 1));
  assert.equal(service.targetRequests.length, 2);
  assert.equal(service.targetApplyCount, 1);
  assert.deepEqual(service.targetRequests[1], service.targetRequests[0]);
  assert.equal(sha256Canonical(service.targetRequests[1]), sha256Canonical(service.targetRequests[0]));
  assert.equal(
    service.calls.filter((call) => call[0] === 'nextWake').length,
    0,
  );
  assert.ok((await second.journal.read()).wakes[TARGET_WAKE]);
  await second.supervisor.stop();
});

test('two supervisors racing one proof-bound claim produce one remote effect and one dispatch', async () => {
  const artifacts = targetedCrashArtifacts();
  const service = new TargetedCrashService(artifacts);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-targeted-dispatch-race-'));
  const journal = new DispatchObservationJournal(directory);
  const hookInbox = new DispatchIntentGate(directory);
  const first = await targetedCrashEnvironment({
    artifacts,
    service,
    journal,
    hookInbox,
    start: false,
  });
  const second = await targetedCrashEnvironment({
    artifacts,
    service,
    journal: first.journal,
    hookInbox: first.hookInbox,
    appServers: first.appServers,
    start: false,
  });
  const firstFailure = [];
  const secondFailure = [];
  first.supervisor.on('supervisorError', (error) => firstFailure.push(error));
  second.supervisor.on('supervisorError', (error) => secondFailure.push(error));
  await Promise.all([
    first.supervisor.start({ poll: true }),
    second.supervisor.start({ poll: true }),
  ]);
  try {
    await hookInbox.intentEntered;
    const readsAtIntent = journal.dispatchingReads;
    await eventually(() => {
      assert.ok(journal.dispatchingReads > readsAtIntent);
    });
    const blocked = (await journal.read()).wakes[TARGET_WAKE];
    assert.equal(blocked.state, 'dispatching');
    assert.equal(blocked.dispatchIntent, undefined);
    assert.equal(await hookInbox.readWakeDispatchIntent(blocked.dispatchFence), null);
    assert.equal(hookInbox.intentCalls, 1);
    assert.deepEqual(firstFailure, []);
    assert.deepEqual(secondFailure, []);

    hookInbox.releaseIntent();
    await eventually(() => assert.equal(first.appServers.callsFor('turn/start').length, 1));
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(service.targetApplyCount, 1);
    assert.ok(service.targetRequests.length >= 1);
    for (const request of service.targetRequests) {
      assert.deepEqual(request, service.targetRequests[0]);
    }
    assert.equal(
      service.calls.filter((call) => call[0] === 'nextWake').length,
      0,
    );
    assert.equal(first.appServers.callsFor('turn/start').length, 1);
    assert.deepEqual(firstFailure, []);
    assert.deepEqual(secondFailure, []);
    assert.ok((await first.journal.read()).wakes[TARGET_WAKE]);
  } finally {
    hookInbox.releaseIntent();
    await Promise.all([first.supervisor.stop(), second.supervisor.stop()]);
  }
});

test('targeted held-tool adoption uses the bound delivery digest and never dispatches', async () => {
  const artifacts = targetedCrashArtifacts();
  artifacts.detail.wake.state = 'leased';
  artifacts.detail.wake.deliveryMode = 'held_tool';
  artifacts.detail.wake.heldDeliveryDigest = artifacts.detail.wake.wakeDeliveryDigest;
  const service = new TargetedCrashService(artifacts, { disposition: 'recover_held_tool' });
  const calls = [];
  const heldRecovery = {
    async recoverHeldTool(input) {
      calls.push(input);
      assert.equal(input.claim.priorWakeDeliveryDigest, artifacts.detail.wake.wakeDeliveryDigest);
      return { action: 'adopted', context: artifacts.context };
    },
    async recoverWaiter() { throw new Error('unexpected_recover_waiter'); },
  };
  const environment = await targetedCrashEnvironment({ artifacts, service, heldRecovery });
  await eventually(() => assert.equal(calls.length, 1));
  assert.equal(environment.appServers.callsFor('turn/start').length, 0);
  assert.equal((await environment.journal.read()).wakes[TARGET_WAKE], undefined);
  await environment.supervisor.stop();
});

test('an ambiguous reconciliation performs no detail, claim, generic poll, or dispatch', async () => {
  const artifacts = targetedCrashArtifacts();
  const certifier = targetedCrashCertifier(artifacts, { disposition: 'owned' });
  const environment = await targetedCrashEnvironment({ artifacts, certifier });
  await eventually(() => assert.ok(certifier.calls.length > 0));
  assert.deepEqual(
    environment.service.calls.map((call) => call[0]),
    ['installationStatus'],
  );
  assert.equal(environment.appServers.callsFor('turn/start').length, 0);
  assert.equal((await environment.journal.read()).wakes[TARGET_WAKE], undefined);
  await environment.supervisor.stop();
});

test('altered Await detail fails before the targeted claim and journal mutation', async () => {
  const artifacts = targetedCrashArtifacts();
  artifacts.detail.await.binding = {
    ...artifacts.detail.await.binding,
    toolUseId: 'substituted-tool-use',
  };
  const environment = await targetedCrashEnvironment({ artifacts, start: false });
  const failure = once(environment.supervisor, 'supervisorError');
  await environment.supervisor.start({ poll: true }).catch(() => undefined);
  const [error] = await failure;
  assert.match(error.message, /held_crash_recovery_binding_mismatch/);
  assert.equal(
    environment.service.calls.filter((call) => call[0] === 'claimCrashRecovery').length,
    0,
  );
  assert.equal(environment.appServers.callsFor('turn/start').length, 0);
  assert.equal((await environment.journal.read()).wakes[TARGET_WAKE], undefined);
  await environment.supervisor.stop();
});

test('altered targeted proof response fails before journal or dispatch', async () => {
  const artifacts = targetedCrashArtifacts();
  const service = new TargetedCrashService(artifacts, {
    responseMutator(result) { result.claim.recoveryProofDigest = 'f'.repeat(64); },
  });
  const environment = await targetedCrashEnvironment({ artifacts, service, start: false });
  const failure = once(environment.supervisor, 'supervisorError');
  await environment.supervisor.start({ poll: true }).catch(() => undefined);
  const [error] = await failure;
  assert.match(error.message, /targeted_held_recovery_proof_mismatch/);
  assert.equal(environment.service.targetRequests.length, 1);
  assert.equal(environment.appServers.callsFor('turn/start').length, 0);
  assert.equal((await environment.journal.read()).wakes[TARGET_WAKE], undefined);
  await environment.supervisor.stop();
});

test('final wake proof must bind the same authoritative origin terminal as preflight', async () => {
  const baseline = cleanTranscriptProof();
  const transcriptProof = cleanTranscriptProof({
    async prove(boundary, options) {
      return {
        ...await baseline.prove(boundary, options),
        originTerminal: {
          type: 'turn_aborted', observedAt: '2026-08-07T12:00:01.000Z',
        },
      };
    },
  });
  const environment = await factoryEnvironment({ transcriptProof });
  const { armed } = await suspendOrigin(environment);
  await environment.supervisor.acceptWake(wakeResult(armed));
  const turn = environment.appServers.thread.turns.find((candidate) => (
    candidate.id === 'turn-wake-1'
  ));

  await assert.rejects(
    environment.supervisor.observeTurnStarted({ threadId: 'thread-1', turn }),
    /codex_rollout_origin_terminal_mismatch/,
  );
  assert.deepEqual(
    environment.service.calls.filter((call) => call[0] === 'receipt').map((call) => call[2].kind),
    ['wake_received'],
  );
});

test('one global intent prevents gen1 and gen3 from issuing duplicate turn/start calls', async () => {
  const appServers = new AppServerHarness({ startMode: 'crash_before_admission' });
  const environment = await factoryEnvironment({ appServers });
  const { armed } = await suspendOrigin(environment);
  const first = wakeResult(armed);
  await assert.rejects(
    environment.supervisor.acceptWake(first),
    /simulated_process_crash_before_host_admission/,
  );
  assert.equal(appServers.callsFor('turn/start').length, 1);
  const original = (await environment.journal.read()).wakes['wake-1'];
  assert.equal(original.dispatchIntent.leaseGeneration, 1);
  assert.equal(original.promptAdmissionAck, undefined);

  await environment.supervisor.acceptWake(first);
  assert.equal((await environment.journal.read()).wakes['wake-1'].state, 'dispatch_uncertain');
  assert.equal(appServers.callsFor('turn/start').length, 1);

  await environment.supervisor.acceptWake(wakeResult(armed, {
    claim: {
      leaseToken: 'lease-2',
      leaseGeneration: 2,
      disposition: 'recover_dispatch',
    },
  }));
  assert.equal((await environment.journal.read()).wakes['wake-1'].state, 'dispatch_uncertain');
  assert.equal(appServers.callsFor('turn/start').length, 1);

  await environment.supervisor.acceptWake(wakeResult(armed, {
    claim: {
      leaseToken: 'lease-3',
      leaseGeneration: 3,
      disposition: 'dispatch',
    },
  }));
  const wake = (await environment.journal.read()).wakes['wake-1'];
  assert.equal(wake.state, 'dispatch_uncertain');
  assert.equal(wake.dispatchIntent.leaseGeneration, 1);
  assert.equal(wake.dispatchTurnId, undefined);
  assert.equal(appServers.callsFor('turn/start').length, 1);
  assert.deepEqual(
    (await environment.hookInbox.listWakeAdmissions())
      .map((admission) => admission.leaseGeneration)
      .sort((left, right) => left - right),
    [1],
  );

  await assert.rejects(
    environment.supervisor.acceptWake(wakeResult(armed, {
      wake: { signal: { ...first.wake.signal, summary: 'Changed wake payload.' } },
      claim: { leaseToken: 'lease-4', leaseGeneration: 4, disposition: 'dispatch' },
    })),
    /wake_replay_mismatch/,
  );
});

test('an exact accepted Wake replay adopts the one fenced turn without another turn/start', async () => {
  const environment = await factoryEnvironment();
  const { armed } = await suspendOrigin(environment);
  const result = wakeResult(armed);
  await environment.supervisor.acceptWake(result);
  const before = (await environment.journal.read()).wakes['wake-1'];
  await environment.supervisor.acceptWake(structuredClone(result));
  const after = (await environment.journal.read()).wakes['wake-1'];
  assert.equal(environment.appServers.callsFor('turn/start').length, 1);
  assert.deepEqual(after.dispatchIntent, before.dispatchIntent);
  assert.equal(after.dispatchTurnId, 'turn-wake-1');
  assert.equal(after.state, 'running');
});

test('restart after an unadmitted host-call intent remains uncertain and never retries', async () => {
  const appServers = new AppServerHarness({ startMode: 'crash_before_admission' });
  const environment = await factoryEnvironment({ appServers });
  const { armed } = await suspendOrigin(environment);
  await assert.rejects(
    environment.supervisor.acceptWake(wakeResult(armed)),
    /simulated_process_crash_before_host_admission/,
  );
  await environment.supervisor.stop();
  appServers.startMode = 'success';
  const recovered = await factoryEnvironment({
    appServers,
    service: environment.service,
    journal: environment.journal,
    transcriptProof: environment.transcriptProof,
  });
  assert.equal(appServers.callsFor('turn/start').length, 1);
  assert.equal((await environment.journal.read()).wakes['wake-1'].state, 'dispatch_uncertain');
  await recovered.supervisor.stop();
});

test('restart after prompt admission without marker remains uncertain and never retries', async () => {
  const appServers = new AppServerHarness({ startMode: 'admit_then_crash_without_persist' });
  const environment = await factoryEnvironment({ appServers });
  const { armed } = await suspendOrigin(environment);
  await assert.rejects(
    environment.supervisor.acceptWake(wakeResult(armed)),
    /simulated_process_crash_after_host_admission/,
  );
  const admission = (await environment.hookInbox.listWakeAdmissions())[0];
  assert.equal(
    (await environment.hookInbox.readWakeAdmissionAcknowledgement(admission)).turnId,
    'turn-wake-1',
  );
  await environment.supervisor.stop();
  appServers.startMode = 'success';
  const recovered = await factoryEnvironment({
    appServers,
    service: environment.service,
    journal: environment.journal,
    transcriptProof: environment.transcriptProof,
  });
  assert.equal(appServers.callsFor('turn/start').length, 1);
  assert.equal((await environment.journal.read()).wakes['wake-1'].state, 'dispatch_uncertain');
  await recovered.supervisor.stop();
});

test('restart adopts an admitted persisted marker after the turn/start response is lost', async () => {
  const appServers = new AppServerHarness({ startMode: 'persist_and_admit_then_crash' });
  const environment = await factoryEnvironment({ appServers });
  const { armed } = await suspendOrigin(environment);
  await assert.rejects(
    environment.supervisor.acceptWake(wakeResult(armed)),
    /simulated_process_crash_after_host_admission/,
  );
  await environment.supervisor.stop();
  appServers.startMode = 'success';
  const recovered = await factoryEnvironment({
    appServers,
    service: environment.service,
    journal: environment.journal,
    transcriptProof: environment.transcriptProof,
  });
  const wake = (await environment.journal.read()).wakes['wake-1'];
  assert.equal(appServers.callsFor('turn/start').length, 1);
  assert.equal(wake.state, 'running');
  assert.equal(wake.dispatchTurnId, 'turn-wake-1');
  assert.equal(wake.taskWokenReceipt.kind, 'task_woken');
  await recovered.supervisor.stop();
});

test('a durable fence without a host-call intent proves a pre-admission crash safe to resume', async () => {
  const appServers = new AppServerHarness({ status: 'active' });
  const environment = await factoryEnvironment({ appServers });
  const { armed } = await suspendOrigin(environment);
  await environment.supervisor.acceptWake(wakeResult(armed));
  const record = (await environment.journal.read()).wakes['wake-1'];
  const { fence } = await environment.hookInbox.publishWakeDispatchFence({
    wakeId: record.wake.wakeId,
    awaitId: record.wake.awaitId,
    sessionId: record.wake.origin.conversationId,
    transcriptPath: '/tmp/codex-home/sessions/thread-1.jsonl',
    marker: markerForWake(record.wake.wakeId),
    promptDigest: sha256Canonical(buildWakePrompt(record.wake)),
  });
  await environment.journal.transitionWake('wake-1', ['dispatch_deferred'], {
    state: 'dispatching',
    dispatchFence: fence,
  });
  await environment.supervisor.stop();
  appServers.thread.status = { type: 'idle' };
  const recovered = await factoryEnvironment({
    appServers,
    service: environment.service,
    journal: environment.journal,
    transcriptProof: environment.transcriptProof,
  });
  assert.equal(appServers.callsFor('turn/start').length, 1);
  assert.equal((await environment.journal.read()).wakes['wake-1'].state, 'submitted');
  assert.equal((await environment.hookInbox.readWakeDispatchIntent(fence)).leaseGeneration, 1);
  await recovered.supervisor.stop();
});

test('unknown Codex thread status fails closed before preflight or dispatch', async () => {
  const appServers = new AppServerHarness({ status: 'futureStatus' });
  const environment = await factoryEnvironment({ appServers });
  const { armed } = await suspendOrigin(environment);
  await assert.rejects(
    environment.supervisor.acceptWake(wakeResult(armed)),
    /codex_thread_status_unsupported:futureStatus/,
  );
  assert.equal(appServers.callsFor('turn/start').length, 0);
});

test('runtime compatibility accepts system clock source and rejects external source before any thread access', async () => {
  const system = await factoryEnvironment({
    appServers: new AppServerHarness({ clockSource: 'system' }),
  });
  assert.deepEqual(
    system.appServers.instances[0].calls.map((call) => call[0]),
    ['start', 'config/read', 'close'],
  );
  await system.supervisor.stop();

  const external = await factoryEnvironment({
    appServers: new AppServerHarness({ clockSource: 'external' }),
    start: false,
  });
  await assert.rejects(
    external.supervisor.start({ poll: false }),
    /codex_clock_source_unsupported:external/,
  );
  assert.equal(external.appServers.callsFor('thread/read').length, 0);
  assert.deepEqual(
    external.appServers.instances[0].calls.map((call) => call[0]),
    ['start', 'config/read', 'close'],
  );
});

test('a held-wait certifier poll failure reaches the supervisor fatal path', async () => {
  const environment = await factoryEnvironment({
    start: false,
    heldWaitCertifier: {
      async poll() { throw new Error('certifier_spool_failed'); },
    },
  });
  const fatal = once(environment.supervisor, 'supervisorError');
  await assert.rejects(
    environment.supervisor.start({ poll: true }),
    /certifier_spool_failed/,
  );
  const [error] = await fatal;
  assert.match(error.message, /certifier_spool_failed/);
  assert.equal(environment.supervisor.running, false);
  assert.equal(environment.supervisor.fatalError, error);
  await environment.supervisor.stop();
});

test('stop emits close after drain and only then surfaces a drain failure', async () => {
  const environment = await factoryEnvironment();
  const calls = [];
  environment.supervisor.drain = async () => {
    calls.push('drain');
    throw new Error('simulated_shutdown_drain_failure');
  };
  environment.supervisor.once('close', () => calls.push('close'));
  await assert.rejects(
    environment.supervisor.stop(),
    /simulated_shutdown_drain_failure/,
  );
  assert.deepEqual(calls, ['drain', 'close']);
  assert.equal(environment.supervisor.running, false);
});

test('a certifier that exits during startup cannot produce a healthy supervisor', async () => {
  const environment = await factoryEnvironment({
    start: false,
    heldWaitCertifier: { async poll() {} },
  });
  await assert.rejects(
    environment.supervisor.start({ poll: true }),
    /held_wait_certifier_stopped_unexpectedly/,
  );
  assert.throws(
    () => environment.supervisor.assertHealthy(),
    /held_wait_certifier_stopped_unexpectedly/,
  );
});

test('wake polling retries transport failures but fails readiness on auth or protocol errors', async (t) => {
  await t.test('transient 503', async () => {
    const service = new FakeService();
    let polls = 0;
    service.nextWake = async ({ signal }) => {
      polls += 1;
      if (polls === 1) throw new HarkApiError(503, 'service_unavailable');
      if (signal.aborted) return null;
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(null), { once: true });
      });
    };
    const environment = await factoryEnvironment({ start: false, service });
    await environment.supervisor.start({ poll: true });
    assert.equal(environment.supervisor.running, true);
    assert.equal(environment.supervisor.fatalError, null);
    await environment.supervisor.stop();
  });

  for (const [name, error, pattern] of [
    ['401', new HarkApiError(401, 'installation_revoked'), /installation_revoked/],
    ['protocol corruption', new Error('wake_response_version_invalid'), /wake_response_version_invalid/],
  ]) {
    await t.test(name, async () => {
      const service = new FakeService();
      service.nextWake = async () => { throw error; };
      const environment = await factoryEnvironment({ start: false, service });
      await assert.rejects(environment.supervisor.start({ poll: true }), pattern);
      assert.equal(environment.supervisor.running, false);
      assert.equal(environment.supervisor.fatalError, error);
    });
  }
});

test('hook polling retries transient filesystem/API failures and fatals on corruption', async (t) => {
  await t.test('transient 503', async () => {
    const environment = await factoryEnvironment({ start: false });
    let reads = 0;
    environment.hookInbox.list = async () => {
      reads += 1;
      if (reads === 2) throw new HarkApiError(503, 'hook_service_unavailable');
      return [];
    };
    await environment.supervisor.start({ poll: true });
    assert.equal(environment.supervisor.running, true);
    assert.equal(environment.supervisor.fatalError, null);
    await environment.supervisor.stop();
  });

  await t.test('corruption', async () => {
    const environment = await factoryEnvironment({ start: false });
    let reads = 0;
    const corruption = new Error('hook_wake_admission_binding_mismatch');
    environment.hookInbox.list = async () => {
      reads += 1;
      if (reads === 1) return [];
      throw corruption;
    };
    await assert.rejects(
      environment.supervisor.start({ poll: true }),
      /hook_wake_admission_binding_mismatch/,
    );
    assert.equal(environment.supervisor.fatalError, corruption);
  });
});
