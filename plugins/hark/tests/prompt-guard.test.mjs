import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256Canonical } from '../lib/canonical.mjs';
import { HarkHookInbox } from '../lib/hook-inbox.mjs';
import { HarkJournal } from '../lib/journal.mjs';
import { HarkToolWaitProtocol } from '../lib/tool-wait-protocol.mjs';
import { evaluatePromptGuard } from '../hooks/prompt-guard.mjs';

function input(prompt = 'Do something else.', overrides = {}) {
  return {
    session_id: 'thread-1',
    turn_id: 'turn-next',
    transcript_path: '/tmp/thread-1.jsonl',
    cwd: '/tmp',
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5.6',
    permission_mode: 'never',
    prompt,
    ...overrides,
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-prompt-guard-'));
  const transcriptPath = path.join(directory, 'thread-1.jsonl');
  await writeFile(transcriptPath, '{}\n', { mode: 0o600 });
  const journal = new HarkJournal(directory);
  const inbox = new HarkHookInbox(directory);
  const protocol = new HarkToolWaitProtocol(directory);
  return { journal, inbox, protocol, transcriptPath: await realpath(transcriptPath) };
}

async function storeAwait(journal, state = 'suspended') {
  await journal.recordAwait({
    id: 'await-1',
    state,
    origin: { protocol: 'codex', runtimeId: 'runtime-1', conversationId: 'thread-1', taskId: 'turn-1' },
  });
}

async function publishHeldRequest(protocol, transcriptPath) {
  return (await protocol.publishAwaitRequest({
    sessionId: 'thread-1',
    turnId: 'turn-1',
    toolUseId: 'tool-1',
    toolName: 'mcp__hark__hark_await',
    transcriptPath,
    originalInput: {
      request: 'Wait for the deployment receipt.',
      name: 'deployment-ready',
      source: {
        kind: 'webhook',
        adapter: 'deployment-service',
        subject: 'release-42',
      },
      condition: { status: 'healthy' },
    },
  })).request;
}

async function publishDispatch(journal, inbox, input) {
  const { fence } = await inbox.publishWakeDispatchFence({
    wakeId: input.wakeId,
    awaitId: input.awaitId,
    sessionId: input.sessionId,
    transcriptPath: input.transcriptPath,
    marker: `hark:wake:${input.wakeId}`,
    promptDigest: input.promptDigest,
  });
  const { admission } = await inbox.publishWakeAdmission(input);
  await inbox.publishWakeDispatchIntent(fence, admission);
  await journal.update((state) => {
    state.wakes[input.wakeId] = {
      ...state.wakes[input.wakeId],
      wakeAdmission: admission,
      wakeAdmissionPublishedAt: admission.createdAt,
    };
    return state;
  });
  return { admission, fence };
}

test('allows ordinary prompts when Hark does not own the thread', async () => {
  const { journal } = await fixture();
  assert.deepEqual(await evaluatePromptGuard(input(), { journal }), {
    allowed: true,
    reason: 'thread_not_owned',
  });
});

test('blocks every ordinary prompt from arm through wake completion', async () => {
  for (const state of ['armed', 'suspended', 'wake_pending', 'wake_received', 'running']) {
    const { journal, inbox, transcriptPath } = await fixture();
    await storeAwait(journal, state);
    const result = await evaluatePromptGuard(input('Do something else.', {
      transcript_path: transcriptPath,
    }), { journal, inbox });
    assert.equal(result.allowed, false, state);
    assert.match(result.reason, /asleep in Hark/);
  }
});

test('blocks ordinary prompts for the canonical held MCP request without journal state', async () => {
  const { journal, inbox, protocol, transcriptPath } = await fixture();
  const request = await publishHeldRequest(protocol, transcriptPath);

  const blocked = await evaluatePromptGuard(input('Do something else.', {
    transcript_path: transcriptPath,
  }), { journal, inbox, protocol });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /asleep in Hark/);

  const terminal = await protocol.publishAwaitRequestTerminal(request, {
    awaitId: 'await-1',
    wakeId: 'wake-1',
    disposition: 'crash_recovery_completed',
    terminalDigest: 'a'.repeat(64),
  });
  await protocol.archiveAwaitRequest(request, terminal.awaitRequestTerminal);

  assert.deepEqual(await evaluatePromptGuard(input('Now continue.', {
    transcript_path: transcriptPath,
  }), { journal, inbox, protocol }), {
    allowed: true,
    reason: 'thread_not_owned',
  });
});

test('an unresolved observed preparation owns only its exact session', async () => {
  const { journal, inbox, protocol, transcriptPath } = await fixture();
  await journal.recordPreparation({
    v: 'hark.await-prepared.v1',
    preparationNonce: 'hkp_legacy-observed-preparation-0001',
  }, {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'tool-1',
    // Deliberately legacy: no installation binding exists yet.
    origin: {
      protocol: 'codex',
      runtimeId: 'runtime-1',
      conversationId: 'thread-1',
      taskId: 'turn-1',
    },
  });

  const blocked = await evaluatePromptGuard(input('Do something else.', {
    transcript_path: transcriptPath,
  }), { journal, inbox, protocol });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /asleep in Hark/);

  assert.deepEqual(await evaluatePromptGuard(input('Unrelated session.', {
    session_id: 'thread-2',
    transcript_path: transcriptPath,
  }), { journal, inbox, protocol }), {
    allowed: true,
    reason: 'thread_not_owned',
  });
});

test('malformed observed identity fails closed without manufacturing wake admission', async () => {
  const { journal, inbox, protocol, transcriptPath } = await fixture();
  await journal.update((state) => {
    state.preparations['hkp_malformed-observed-preparation'] = {
      state: 'observed',
      binding: {
        threadId: 'thread-1',
        origin: { conversationId: 'different-thread' },
      },
    };
    state.wakes['wake-fake'] = {
      state: 'dispatching',
      promptDigest: sha256Canonical('fake wake'),
      wake: {
        wakeId: 'wake-fake',
        awaitId: 'await-missing',
        origin: { conversationId: 'thread-1' },
      },
      claim: { leaseGeneration: 1 },
    };
    return state;
  });

  const result = await evaluatePromptGuard(input('fake wake', {
    transcript_path: transcriptPath,
  }), { journal, inbox, protocol });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /asleep in Hark/);
});

test('allows only the exact pending Hark wake prompt during dispatch', async () => {
  const { journal, inbox, transcriptPath } = await fixture();
  await storeAwait(journal, 'wake_received');
  const wakePrompt = 'Hark authenticated wake envelope';
  await journal.update((state) => {
    state.wakes['wake-1'] = {
      state: 'dispatching',
      promptDigest: sha256Canonical(wakePrompt),
      wake: {
        wakeId: 'wake-1',
        awaitId: 'await-1',
        origin: { conversationId: 'thread-1' },
      },
      claim: { leaseGeneration: 1 },
    };
    return state;
  });
  const { admission } = await publishDispatch(journal, inbox, {
    wakeId: 'wake-1',
    awaitId: 'await-1',
    sessionId: 'thread-1',
    transcriptPath,
    promptDigest: sha256Canonical(wakePrompt),
    leaseGeneration: 1,
  });
  const readWakeAdmission = inbox.readWakeAdmission.bind(inbox);
  let indexedAdmissionReads = 0;
  inbox.readWakeAdmission = async (...args) => {
    indexedAdmissionReads += 1;
    return readWakeAdmission(...args);
  };
  inbox.listWakeAdmissions = async () => {
    throw new Error('prompt_guard_must_not_scan_admission_history');
  };

  const admitted = await evaluatePromptGuard(input(wakePrompt, {
    transcript_path: transcriptPath,
  }), { journal, inbox });
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.reason, 'authenticated_hark_wake');
  assert.equal(admitted.wakeId, 'wake-1');
  assert.equal(admitted.admissionId, admission.id);
  assert.equal(admitted.acknowledgementCreated, true);
  assert.equal(indexedAdmissionReads, 1);
  assert.equal((await evaluatePromptGuard(input(`${wakePrompt} `, {
    transcript_path: transcriptPath,
  }), { journal, inbox })).allowed, false);
  const replay = await evaluatePromptGuard(input(wakePrompt, {
    transcript_path: transcriptPath,
  }), { journal, inbox });
  assert.equal(replay.allowed, true);
  assert.equal(replay.acknowledgementCreated, false);
  await assert.rejects(
    evaluatePromptGuard(input(wakePrompt, {
      transcript_path: transcriptPath,
      turn_id: 'turn-competing',
    }), { journal, inbox }),
    /hook_wake_admission_ack_conflict/,
  );
  await journal.transitionWake('wake-1', ['dispatching'], { state: 'submitted' });
  assert.equal((await evaluatePromptGuard(input(wakePrompt, {
    transcript_path: transcriptPath,
  }), { journal, inbox })).allowed, true);
  await journal.transitionWake('wake-1', ['submitted'], { state: 'running' });
  assert.equal((await evaluatePromptGuard(input(wakePrompt, {
    transcript_path: transcriptPath,
  }), { journal, inbox })).allowed, false);
});

test('rejects transcript substitution and subagent wake prompts', async () => {
  const { journal, inbox, transcriptPath } = await fixture();
  await storeAwait(journal, 'wake_received');
  const wakePrompt = 'Hark authenticated wake envelope';
  await journal.update((state) => {
    state.wakes['wake-1'] = {
      state: 'dispatching',
      promptDigest: sha256Canonical(wakePrompt),
      wake: {
        wakeId: 'wake-1', awaitId: 'await-1', origin: { conversationId: 'thread-1' },
      },
      claim: { leaseGeneration: 1 },
    };
    return state;
  });
  await publishDispatch(journal, inbox, {
    wakeId: 'wake-1', awaitId: 'await-1', sessionId: 'thread-1', transcriptPath,
    promptDigest: sha256Canonical(wakePrompt), leaseGeneration: 1,
  });
  const otherTranscript = path.join(path.dirname(transcriptPath), 'other.jsonl');
  await writeFile(otherTranscript, '{}\n', { mode: 0o600 });
  assert.equal((await evaluatePromptGuard(input(wakePrompt, {
    transcript_path: otherTranscript,
  }), { journal, inbox })).allowed, false);
  await assert.rejects(
    evaluatePromptGuard(input(wakePrompt, {
      transcript_path: transcriptPath,
      agent_id: 'child-1',
      agent_type: 'worker',
    }), { journal, inbox }),
    /subagent_context_rejected/,
  );
});

test('releases the thread after terminal Await state', async () => {
  for (const state of ['completed', 'failed', 'cancelled']) {
    const { journal, inbox } = await fixture();
    await storeAwait(journal, state);
    assert.equal((await evaluatePromptGuard(input(), { journal, inbox })).allowed, true, state);
  }
});
