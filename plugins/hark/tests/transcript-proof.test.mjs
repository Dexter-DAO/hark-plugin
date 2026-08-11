import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sha256Canonical } from '../lib/canonical.mjs';
import {
  captureCodexToolWaitBoundary,
  captureCodexRolloutBoundary,
  CODEX_ROLLOUT_BOUNDARY_VERSION,
  CODEX_ROLLOUT_HISTORY_SOURCE,
  CODEX_TOOL_WAIT_BOUNDARY_VERSION,
  CODEX_TOOL_WAIT_INSPECTION_VERSION,
  CODEX_TOOL_WAIT_PROOF_VERSION,
  inspectCodexToolWait,
  preflightCodexWaitHistory,
  proveCodexToolWait,
  proveCodexWaitHistory,
} from '../lib/transcript-proof.mjs';

const SESSION = '019fdb40-d729-7012-bd07-305032f8ede1';
const ORIGIN = '019fdb40-d874-7122-9af5-2f9409508e53';
const WAKE = '019fdb40-e000-7000-8000-000000000001';
const SCANNED_AT = '2026-08-07T12:00:03.000Z';
const TOOL_USE_ID = 'call_hark_wait_1';
const TOOL_INPUT = {
  request: 'Continue after job 42.',
  name: 'Job 42',
  source: { kind: 'job.completed', adapter: 'webhook.v1', subject: 'job-42' },
  condition: { status: { equals: 'completed' } },
};
const TOOL_RESULT = {
  v: 'hark.await-result.v1',
  awaitId: 'await-1',
  wakeId: 'wake-1',
  signal: { status: 'completed' },
  deliveryDigest: '1'.repeat(64),
};

function line(type, payload, ordinal = undefined) {
  return `${JSON.stringify({
    timestamp: '2026-08-07T12:00:00.000Z',
    ...(ordinal === undefined ? {} : { ordinal }),
    type,
    payload,
  })}\n`;
}

function prefix(sessionId = SESSION, turnId = ORIGIN) {
  return [
    line('session_meta', { id: sessionId, cli_version: '0.147.0' }),
    line('turn_context', { turn_id: turnId }, 41),
    line('response_item', { type: 'function_call_output', id: 'origin-output' }),
  ].join('');
}

function toolWaitPrefix(sessionId = SESSION, turnId = ORIGIN) {
  return [
    line('session_meta', { id: sessionId, cli_version: '0.147.0' }),
    line('turn_context', { turn_id: turnId }, 41),
    line('response_item', {
      type: 'function_call',
      call_id: TOOL_USE_ID,
      namespace: 'hark',
      name: 'hark_await',
      arguments: JSON.stringify(TOOL_INPUT),
    }),
  ].join('');
}

function toolOutput(result = TOOL_RESULT) {
  return line('response_item', {
    type: 'function_call_output',
    call_id: TOOL_USE_ID,
    output: `Wall time: 86400.0000 seconds\nOutput:\n${JSON.stringify(result)}`,
  });
}

function turnComplete(turnId, message = 'Completed.', timeToFirstTokenMs = 12) {
  return line('event_msg', {
    type: 'task_complete',
    turn_id: turnId,
    last_agent_message: message,
    started_at: 1_786_100_000,
    completed_at: 1_786_100_001,
    duration_ms: 1_000,
    time_to_first_token_ms: timeToFirstTokenMs,
  });
}

function turnAborted(turnId, reason = 'interrupted') {
  return line('event_msg', {
    type: 'turn_aborted',
    turn_id: turnId,
    reason,
    started_at: 1_786_100_000,
    completed_at: 1_786_100_001,
    duration_ms: 1_000,
  });
}

function turnAbortedMarker(turnId = ORIGIN) {
  return line('response_item', {
    type: 'message',
    id: 'turn-aborted-marker',
    role: 'developer',
    content: [{
      type: 'input_text',
      text: '<turn_aborted>\nThe previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>',
    }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-transcript-proof-'));
  const codexHome = path.join(directory, 'codex-home');
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '07');
  await mkdir(sessions, { recursive: true });
  const transcriptPath = path.join(sessions, `rollout-${SESSION}.jsonl`);
  await writeFile(transcriptPath, prefix(), { mode: 0o600 });
  return { directory, codexHome, transcriptPath };
}

async function toolWaitFixture() {
  const value = await fixture();
  await writeFile(value.transcriptPath, toolWaitPrefix(), { mode: 0o600 });
  return value;
}

async function capture(value) {
  return captureCodexRolloutBoundary({
    transcriptPath: value.transcriptPath,
    threadPath: value.transcriptPath,
    codexHome: value.codexHome,
    sessionId: SESSION,
    originTaskId: ORIGIN,
  });
}

async function captureToolWait(value) {
  return captureCodexToolWaitBoundary({
    transcriptPath: value.transcriptPath,
    threadPath: value.transcriptPath,
    codexHome: value.codexHome,
    sessionId: SESSION,
    originTaskId: ORIGIN,
    toolUseId: TOOL_USE_ID,
    toolName: 'mcp__hark__hark_await',
    toolInput: TOOL_INPUT,
  });
}

async function inspectToolWaitSuffix(parts, toolResult = TOOL_RESULT) {
  const value = await toolWaitFixture();
  const boundary = await captureToolWait(value);
  await writeFile(value.transcriptPath, [toolWaitPrefix(), ...parts].join(''));
  return {
    value,
    boundary,
    inspection: await inspectCodexToolWait(boundary, { toolResult }),
  };
}

test('certifies one long-held Hark tool result and resumed response in the same turn', async () => {
  const value = await toolWaitFixture();
  const boundary = await captureToolWait(value);
  assert.equal(boundary.v, CODEX_TOOL_WAIT_BOUNDARY_VERSION);
  assert.equal(boundary.originTaskId, ORIGIN);
  assert.equal(boundary.toolUseId, TOOL_USE_ID);
  await writeFile(value.transcriptPath, [
    toolWaitPrefix(),
    line('event_msg', { type: 'token_count', info: { total_tokens: 42 } }),
    toolOutput(),
    line('response_item', {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Job 42 finished.' }],
    }),
    turnComplete(ORIGIN, 'Job 42 finished.'),
  ].join(''));

  const proof = await proveCodexToolWait(boundary, {
    toolResult: TOOL_RESULT,
    wakeDeliveryDigest: TOOL_RESULT.deliveryDigest,
    scannedAt: SCANNED_AT,
  });
  assert.equal(proof.v, CODEX_TOOL_WAIT_PROOF_VERSION);
  assert.equal(proof.originTaskId, ORIGIN);
  assert.equal(proof.wakeTaskId, ORIGIN);
  assert.equal(proof.toolUseId, TOOL_USE_ID);
  assert.equal(proof.toolName, 'mcp__hark__hark_await');
  assert.equal(proof.inputDigest, boundary.inputDigest);
  assert.equal(proof.waitingInferenceRecordCount, 0);
  assert.equal(proof.historyMutationCount, 0);
  assert.deepEqual(proof.interveningTaskIds, []);
  assert.match(proof.toolResultDigest, /^[a-f0-9]{64}$/);
  assert.match(proof.rolloutToolOutputDigest, /^[a-f0-9]{64}$/);
  assert.match(proof.assistantResponseDigest, /^[a-f0-9]{64}$/);
  assert.match(proof.historyDigest, /^[a-f0-9]{64}$/);

  const replay = await proveCodexToolWait(boundary, {
    toolResult: TOOL_RESULT,
    wakeDeliveryDigest: TOOL_RESULT.deliveryDigest,
  });
  const replayAgain = await proveCodexToolWait(boundary, {
    toolResult: TOOL_RESULT,
    wakeDeliveryDigest: TOOL_RESULT.deliveryDigest,
  });
  assert.deepEqual(replayAgain, replay);
  assert.equal(replay.scannedAt, '2026-08-07T12:00:00.000Z');
});

test('tool-wait proof fails closed on inference, state mutation, or another turn before return', async () => {
  for (const contaminant of [
    line('response_item', { type: 'reasoning', summary: [] }),
    line('world_state', { full: false, state: { cwd: '/changed' } }),
    line('turn_context', { turn_id: WAKE }),
  ]) {
    const value = await toolWaitFixture();
    const boundary = await captureToolWait(value);
    await writeFile(value.transcriptPath, [
      toolWaitPrefix(),
      contaminant,
      toolOutput(),
      line('response_item', {
        type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }],
      }),
      turnComplete(ORIGIN, 'Done.'),
    ].join(''));
    await assert.rejects(
      proveCodexToolWait(boundary, {
        toolResult: TOOL_RESULT,
        wakeDeliveryDigest: TOOL_RESULT.deliveryDigest,
      }),
      /codex_tool_wait_boundary_contaminated/,
    );
  }
});

test('tool-wait capture and proof bind the exact call, result, and once-only output', async () => {
  const value = await toolWaitFixture();
  const boundary = await captureToolWait(value);
  await writeFile(value.transcriptPath, [
    toolWaitPrefix(),
    toolOutput(),
    toolOutput(),
    line('response_item', {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }],
    }),
    turnComplete(ORIGIN, 'Done.'),
  ].join(''));
  await assert.rejects(
    proveCodexToolWait(boundary, {
      toolResult: TOOL_RESULT,
      wakeDeliveryDigest: TOOL_RESULT.deliveryDigest,
    }),
    /codex_tool_output_duplicate/,
  );

  const mismatch = await toolWaitFixture();
  const mismatchBoundary = await captureToolWait(mismatch);
  await writeFile(mismatch.transcriptPath, [
    toolWaitPrefix(),
    toolOutput({ ...TOOL_RESULT, wakeId: 'wrong-wake' }),
    line('response_item', {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }],
    }),
    turnComplete(ORIGIN, 'Done.'),
  ].join(''));
  await assert.rejects(
    proveCodexToolWait(mismatchBoundary, {
      toolResult: TOOL_RESULT,
      wakeDeliveryDigest: TOOL_RESULT.deliveryDigest,
    }),
    /codex_tool_result_mismatch/,
  );
});

test('tool-wait inspection reports an inert held call as waiting', async () => {
  const { boundary, inspection } = await inspectToolWaitSuffix([
    line('event_msg', { type: 'token_count', info: { total_tokens: 42 } }),
  ]);
  assert.deepEqual(inspection, {
    v: CODEX_TOOL_WAIT_INSPECTION_VERSION,
    historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
    conversationId: SESSION,
    originTaskId: ORIGIN,
    toolUseId: TOOL_USE_ID,
    toolName: 'mcp__hark__hark_await',
    inputDigest: boundary.inputDigest,
    toolResultDigest: sha256Canonical(TOOL_RESULT),
    rolloutToolOutputDigest: null,
    state: 'waiting',
    originTerminal: null,
    incompleteTail: false,
    inspectedAtByteLength: inspection.inspectedAtByteLength,
    historyDigest: inspection.historyDigest,
  });
  assert.match(inspection.historyDigest, /^[a-f0-9]{64}$/);
});

test('tool-wait inspection treats every incomplete physical tail as ambiguous and binds its bytes', async () => {
  const partialA = '{"timestamp":"2026-08-07T12:00:00.000Z","type":"response_A';
  const partialB = '{"timestamp":"2026-08-07T12:00:00.000Z","type":"response_B';
  assert.equal(Buffer.byteLength(partialA), Buffer.byteLength(partialB));
  const first = await inspectToolWaitSuffix([partialA]);
  const second = await inspectToolWaitSuffix([partialB]);
  for (const { inspection } of [first, second]) {
    assert.equal(inspection.state, 'ambiguous_incomplete_tail');
    assert.equal(inspection.incompleteTail, true);
    assert.equal(inspection.rolloutToolOutputDigest, null);
  }
  assert.notEqual(first.inspection.historyDigest, second.inspection.historyDigest);

  const afterResult = await inspectToolWaitSuffix([
    toolOutput(),
    '{"timestamp":"2026-08-07T12:00:01.000Z","type":"event_msg"',
  ]);
  assert.equal(afterResult.inspection.state, 'ambiguous_incomplete_tail');
  assert.match(afterResult.inspection.rolloutToolOutputDigest, /^[a-f0-9]{64}$/);
});

test('tool-wait inspection recognizes the exact Codex abort marker before a result', async () => {
  const { inspection } = await inspectToolWaitSuffix([
    turnAbortedMarker(),
    line('event_msg', { type: 'token_count', info: { total_tokens: 42 } }),
    turnAborted(ORIGIN, 'interrupted'),
  ]);
  assert.equal(inspection.state, 'origin_aborted_before_result');
  assert.deepEqual(inspection.originTerminal, {
    type: 'turn_aborted',
    reason: 'interrupted',
    observedAt: '2026-08-07T12:00:00.000Z',
  });
  assert.equal(inspection.rolloutToolOutputDigest, null);
});

test('tool-wait inspection distinguishes a persisted result followed by an abort', async () => {
  const { inspection } = await inspectToolWaitSuffix([
    toolOutput(),
    turnAbortedMarker(),
    turnAborted(ORIGIN, 'interrupted'),
  ]);
  assert.equal(inspection.state, 'tool_result_then_aborted');
  assert.equal(inspection.originTerminal.type, 'turn_aborted');
  assert.equal(inspection.originTerminal.reason, 'interrupted');
  assert.match(inspection.rolloutToolOutputDigest, /^[a-f0-9]{64}$/);
});

test('tool-wait inspection identifies terminal same-turn success', async () => {
  const { inspection } = await inspectToolWaitSuffix([
    toolOutput(),
    line('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Job 42 finished.' }],
      internal_chat_message_metadata_passthrough: { turn_id: ORIGIN },
    }),
    turnComplete(ORIGIN, 'Job 42 finished.'),
  ]);
  assert.equal(inspection.state, 'tool_result_turn_terminal');
  assert.deepEqual(inspection.originTerminal, {
    type: 'task_complete',
    reason: 'completed',
    observedAt: '2026-08-07T12:00:00.000Z',
  });
});

test('tool-wait inspection separates a persisted result awaiting terminal from completion without result', async () => {
  const persisted = await inspectToolWaitSuffix([toolOutput()]);
  assert.equal(persisted.inspection.state, 'tool_result_persisted');
  assert.equal(persisted.inspection.originTerminal, null);
  assert.match(persisted.inspection.rolloutToolOutputDigest, /^[a-f0-9]{64}$/);

  const completed = await inspectToolWaitSuffix([
    turnComplete(ORIGIN, 'Unexpected early completion.'),
  ]);
  assert.equal(completed.inspection.state, 'origin_completed_without_result');
  assert.deepEqual(completed.inspection.originTerminal, {
    type: 'task_complete',
    reason: 'completed',
    observedAt: '2026-08-07T12:00:00.000Z',
  });
  assert.equal(completed.inspection.rolloutToolOutputDigest, null);
});

test('tool-wait inspection rejects wrong, duplicate, post-terminal, and other-turn outputs', async (t) => {
  await t.test('wrong result for the exact call', async () => {
    const value = await toolWaitFixture();
    const boundary = await captureToolWait(value);
    await writeFile(value.transcriptPath, [
      toolWaitPrefix(),
      toolOutput({ ...TOOL_RESULT, wakeId: 'wrong-wake' }),
    ].join(''));
    await assert.rejects(
      inspectCodexToolWait(boundary, { toolResult: TOOL_RESULT }),
      /codex_tool_result_mismatch/,
    );
  });

  await t.test('duplicate result for the exact call', async () => {
    const value = await toolWaitFixture();
    const boundary = await captureToolWait(value);
    await writeFile(value.transcriptPath, [toolWaitPrefix(), toolOutput(), toolOutput()].join(''));
    await assert.rejects(
      inspectCodexToolWait(boundary, { toolResult: TOOL_RESULT }),
      /codex_tool_output_duplicate/,
    );
  });

  await t.test('result persisted after the origin was already terminal', async () => {
    const value = await toolWaitFixture();
    const boundary = await captureToolWait(value);
    await writeFile(value.transcriptPath, [
      toolWaitPrefix(),
      turnAborted(ORIGIN),
      toolOutput(),
    ].join(''));
    await assert.rejects(
      inspectCodexToolWait(boundary, { toolResult: TOOL_RESULT }),
      /codex_tool_output_after_origin_terminal/,
    );
  });

  await t.test('another call output before the held result', async () => {
    const value = await toolWaitFixture();
    const boundary = await captureToolWait(value);
    await writeFile(value.transcriptPath, [
      toolWaitPrefix(),
      line('response_item', {
        type: 'function_call_output',
        call_id: 'other-call',
        output: '{}',
      }),
    ].join(''));
    await assert.rejects(
      inspectCodexToolWait(boundary, { toolResult: TOOL_RESULT }),
      /codex_tool_wait_pre_result_contaminated/,
    );
  });

  await t.test('the exact output in another turn', async () => {
    const value = await toolWaitFixture();
    const boundary = await captureToolWait(value);
    await writeFile(value.transcriptPath, [
      toolWaitPrefix(),
      line('turn_context', { turn_id: WAKE }),
      toolOutput(),
    ].join(''));
    await assert.rejects(
      inspectCodexToolWait(boundary, { toolResult: TOOL_RESULT }),
      /codex_tool_wait_other_turn_seen/,
    );
  });
});

test('tool-wait inspection rejects every pre-result inference or state mutation', async (t) => {
  const contaminants = [
    ['reasoning', line('response_item', { type: 'reasoning', summary: [] })],
    ['assistant message', line('response_item', {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Still waiting.' }],
    })],
    ['world state', line('world_state', { full: false, state: { cwd: '/changed' } })],
    ['settings', line('event_msg', {
      type: 'thread_settings_applied', thread_settings: { model: 'other' },
    })],
    ['unpaired abort marker', turnAbortedMarker()],
  ];
  for (const [name, contaminant] of contaminants) {
    await t.test(name, async () => {
      const value = await toolWaitFixture();
      const boundary = await captureToolWait(value);
      await writeFile(value.transcriptPath, [toolWaitPrefix(), contaminant].join(''));
      await assert.rejects(
        inspectCodexToolWait(boundary, { toolResult: TOOL_RESULT }),
        /codex_tool_wait_pre_result_contaminated/,
      );
    });
  }
});

test('captures one real, regular, Codex-home-contained origin prefix', async () => {
  const value = await fixture();
  const boundary = await capture(value);

  assert.equal(boundary.v, CODEX_ROLLOUT_BOUNDARY_VERSION);
  assert.equal(boundary.historySource, CODEX_ROLLOUT_HISTORY_SOURCE);
  assert.equal(boundary.transcriptPath, value.transcriptPath);
  assert.equal(boundary.sessionId, SESSION);
  assert.equal(boundary.originTaskId, ORIGIN);
  assert.match(boundary.dev, /^\d+$/);
  assert.match(boundary.ino, /^\d+$/);
  assert.equal(boundary.byteLength, Buffer.byteLength(prefix()));
  assert.match(boundary.prefixSha256, /^[a-f0-9]{64}$/);
});

test('proves physical origin-to-wake adjacency without optional ordinals', async () => {
  const value = await fixture();
  const boundary = await capture(value);
  await writeFile(value.transcriptPath, [
    prefix(),
    line('response_item', { type: 'agent_message', id: 'origin-complete' }),
    turnComplete(ORIGIN, 'Await armed.'),
    line('turn_context', { turn_id: WAKE }),
    line('event_msg', { type: 'user_message', client_id: 'hark:wake:wake-1' }),
    turnComplete(WAKE, 'Wake completed.'),
  ].join(''));

  const proof = await proveCodexWaitHistory(boundary, {
    wakeTaskId: WAKE,
    scannedAt: SCANNED_AT,
  });
  assert.deepEqual(proof, {
    v: 'hark.codex-wait-history-proof.v1',
    historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
    conversationId: SESSION,
    originTaskId: ORIGIN,
    wakeTaskId: WAKE,
    originTerminal: {
      type: 'task_complete', observedAt: '2026-08-07T12:00:00.000Z',
    },
    interveningTaskIds: [],
    rollbackMarkerCount: 0,
    historyMutationCount: 0,
    wakeResponseDigest: proof.wakeResponseDigest,
    scannedAt: SCANNED_AT,
    historyDigest: proof.historyDigest,
  });
  assert.match(proof.historyDigest, /^[a-f0-9]{64}$/);
  assert.match(proof.wakeResponseDigest, /^[a-f0-9]{64}$/);
});

test('preflight proves a stable empty boundary before dispatch', async () => {
  const value = await fixture();
  const boundary = await capture(value);
  await writeFile(value.transcriptPath, [
    prefix(),
    line('response_item', { type: 'agent_message', id: 'origin-complete' }),
    turnComplete(ORIGIN, 'Await armed.'),
  ].join(''));

  const proof = await preflightCodexWaitHistory(boundary, { scannedAt: SCANNED_AT });
  assert.deepEqual(proof, {
    v: 'hark.codex-wait-preflight.v1',
    historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
    conversationId: SESSION,
    originTaskId: ORIGIN,
    originTerminal: {
      type: 'task_complete', observedAt: '2026-08-07T12:00:00.000Z',
    },
    interveningTaskIds: [],
    rollbackMarkerCount: 0,
    historyMutationCount: 0,
    scannedAt: SCANNED_AT,
    historyDigest: proof.historyDigest,
  });
  assert.match(proof.historyDigest, /^[a-f0-9]{64}$/);
});

test('preflight and final proof bind one exact turn_aborted origin terminal', async () => {
  const value = await fixture();
  const boundary = await capture(value);
  await writeFile(value.transcriptPath, [
    prefix(),
    turnAborted(ORIGIN),
  ].join(''));

  const preflight = await preflightCodexWaitHistory(boundary, { scannedAt: SCANNED_AT });
  assert.deepEqual(preflight.originTerminal, {
    type: 'turn_aborted', observedAt: '2026-08-07T12:00:00.000Z',
  });

  await writeFile(value.transcriptPath, [
    prefix(),
    turnAborted(ORIGIN),
    line('turn_context', { turn_id: WAKE }),
    line('event_msg', { type: 'user_message', client_id: 'hark:wake:wake-1' }),
    turnComplete(WAKE, 'Wake completed.'),
  ].join(''));
  const proof = await proveCodexWaitHistory(boundary, {
    wakeTaskId: WAKE,
    scannedAt: SCANNED_AT,
  });
  assert.deepEqual(proof.originTerminal, preflight.originTerminal);
  assert.equal(proof.interveningTaskIds.length, 0);
  assert.match(proof.historyDigest, /^[a-f0-9]{64}$/);
});

test('wait history rejects duplicate, conflicting, other-turn, or missing origin terminals', async (t) => {
  const preflightCases = [
    {
      name: 'duplicate abort',
      suffix: `${turnAborted(ORIGIN)}${turnAborted(ORIGIN)}`,
      error: /codex_rollout_origin_terminal_duplicate/,
    },
    {
      name: 'conflicting complete and abort',
      suffix: `${turnComplete(ORIGIN)}${turnAborted(ORIGIN)}`,
      error: /codex_rollout_origin_terminal_duplicate/,
    },
    {
      name: 'other turn terminal',
      suffix: turnAborted('019fdb40-e000-7000-8000-000000000099'),
      error: /codex_rollout_origin_terminal_other_turn/,
    },
  ];
  for (const scenario of preflightCases) {
    await t.test(scenario.name, async () => {
      const value = await fixture();
      const boundary = await capture(value);
      await writeFile(value.transcriptPath, `${prefix()}${scenario.suffix}`);
      await assert.rejects(preflightCodexWaitHistory(boundary), scenario.error);
    });
  }

  await t.test('wake before terminal', async () => {
    const value = await fixture();
    const boundary = await capture(value);
    await writeFile(value.transcriptPath, [
      prefix(),
      line('turn_context', { turn_id: WAKE }),
      turnComplete(WAKE, 'Wake completed.'),
    ].join(''));
    await assert.rejects(
      proveCodexWaitHistory(boundary, { wakeTaskId: WAKE }),
      /codex_rollout_wake_before_origin_terminal/,
    );
  });
});

test('preflight exposes intervening turns and rollback before model dispatch', async () => {
  const value = await fixture();
  const boundary = await capture(value);
  const intervening = '019fdb40-e000-7000-8000-000000000004';
  await writeFile(value.transcriptPath, [
    prefix(),
    line('turn_context', { turn_id: ORIGIN }),
    turnComplete(ORIGIN, 'Await armed.'),
    line('event_msg', { type: 'thread_rolled_back', num_turns: 1 }),
    line('turn_context', { turn_id: intervening }),
  ].join(''));

  const proof = await preflightCodexWaitHistory(boundary, { scannedAt: SCANNED_AT });
  assert.deepEqual(proof.interveningTaskIds, [intervening]);
  assert.equal(proof.rollbackMarkerCount, 1);
});

test('preflight refuses an unstable partial rollout tail', async () => {
  const value = await fixture();
  const boundary = await capture(value);
  await writeFile(value.transcriptPath, `${prefix()}{"type":"turn_context"`);
  await assert.rejects(
    preflightCodexWaitHistory(boundary),
    /codex_rollout_incomplete_tail/,
  );
});

test('preserves distinct intervening turns and append-only rollback markers as disqualifying facts', async () => {
  const value = await fixture();
  const boundary = await capture(value);
  const intervening = '019fdb40-e000-7000-8000-000000000002';
  await writeFile(value.transcriptPath, [
    prefix(),
    line('turn_context', { turn_id: ORIGIN }),
    turnComplete(ORIGIN, 'Await armed.'),
    line('turn_context', { turn_id: intervening }),
    line('turn_context', { turn_id: intervening }),
    line('event_msg', { type: 'thread_rolled_back', num_turns: 1 }),
    line('turn_context', { turn_id: WAKE }),
    turnComplete(WAKE, 'Wake completed.'),
  ].join(''));

  const proof = await proveCodexWaitHistory(boundary, {
    wakeTaskId: WAKE,
    scannedAt: SCANNED_AT,
  });
  assert.deepEqual(proof.interveningTaskIds, [intervening]);
  assert.equal(proof.rollbackMarkerCount, 1);
  assert.equal(proof.historyMutationCount, 0);
});

test('fails closed when the captured prefix is rewritten, shrunk, or replaced', async (t) => {
  await t.test('prefix rewrite', async () => {
    const value = await fixture();
    const boundary = await capture(value);
    const changed = prefix().replace('origin-output', 'tamper-output');
    assert.equal(Buffer.byteLength(changed), boundary.byteLength);
    await writeFile(value.transcriptPath, `${changed}${line('turn_context', { turn_id: WAKE })}`);
    await assert.rejects(
      proveCodexWaitHistory(boundary, { wakeTaskId: WAKE }),
      /codex_rollout_prefix_mismatch/,
    );
  });

  await t.test('shrink', async () => {
    const value = await fixture();
    const boundary = await capture(value);
    await writeFile(value.transcriptPath, line('session_meta', {
      id: SESSION,
      cli_version: '0.147.0',
    }));
    await assert.rejects(
      proveCodexWaitHistory(boundary, { wakeTaskId: WAKE }),
      /codex_rollout_shrank/,
    );
  });

  await t.test('inode replacement', async () => {
    const value = await fixture();
    const boundary = await capture(value);
    const replacement = `${value.transcriptPath}.replacement`;
    await writeFile(replacement, `${prefix()}${line('turn_context', { turn_id: WAKE })}`);
    await rename(replacement, value.transcriptPath);
    await assert.rejects(
      proveCodexWaitHistory(boundary, { wakeTaskId: WAKE }),
      /codex_rollout_identity_mismatch/,
    );
  });
});

test('capture rejects an outside path, wrong session, stale origin, and incomplete physical line', async (t) => {
  await t.test('outside Codex home, including through a symlink', async () => {
    const value = await fixture();
    const outside = path.join(value.directory, 'outside.jsonl');
    const linked = path.join(value.codexHome, 'sessions', 'linked.jsonl');
    await writeFile(outside, prefix());
    await symlink(outside, linked);
    await assert.rejects(
      captureCodexRolloutBoundary({
        transcriptPath: linked,
        threadPath: linked,
        codexHome: value.codexHome,
        sessionId: SESSION,
        originTaskId: ORIGIN,
      }),
      /codex_rollout_outside_codex_home/,
    );
  });

  await t.test('transcript does not match the App Server thread path', async () => {
    const value = await fixture();
    const copied = path.join(path.dirname(value.transcriptPath), 'copied-rollout.jsonl');
    await writeFile(copied, prefix());
    await assert.rejects(
      captureCodexRolloutBoundary({
        transcriptPath: copied,
        threadPath: value.transcriptPath,
        codexHome: value.codexHome,
        sessionId: SESSION,
        originTaskId: ORIGIN,
      }),
      /codex_rollout_thread_path_mismatch/,
    );
  });

  await t.test('wrong session', async () => {
    const value = await fixture();
    await assert.rejects(
      captureCodexRolloutBoundary({
        transcriptPath: value.transcriptPath,
        threadPath: value.transcriptPath,
        codexHome: value.codexHome,
        sessionId: 'wrong-session',
        originTaskId: ORIGIN,
      }),
      /codex_rollout_session_mismatch/,
    );
  });

  await t.test('origin is not the latest turn context', async () => {
    const value = await fixture();
    await writeFile(value.transcriptPath, `${prefix()}${line('turn_context', { turn_id: WAKE })}`);
    await assert.rejects(capture(value), /codex_rollout_origin_turn_context_mismatch/);
  });

  await t.test('incomplete JSONL tail', async () => {
    const value = await fixture();
    await writeFile(value.transcriptPath, `${prefix()}{"timestamp":`);
    await assert.rejects(capture(value), /codex_rollout_incomplete_tail/);
  });
});

test('proof requires the requested wake turn in the append-only suffix', async () => {
  const value = await fixture();
  const boundary = await capture(value);
  await writeFile(value.transcriptPath, [
    prefix(),
    turnComplete(ORIGIN, 'Await armed.'),
    line('turn_context', { turn_id: '019fdb40-e000-7000-8000-000000000003' }),
  ].join(''));
  await assert.rejects(
    proveCodexWaitHistory(boundary, { wakeTaskId: WAKE }),
    /codex_rollout_wake_turn_missing/,
  );
});

test('rejects a terminal wake that no hook allowed to reach model sampling', async () => {
  const value = await fixture();
  const boundary = await capture(value);
  await writeFile(value.transcriptPath, [
    prefix(),
    turnComplete(ORIGIN, 'Await armed.'),
    line('turn_context', { turn_id: WAKE }),
    line('event_msg', {
      type: 'task_complete', turn_id: WAKE, last_agent_message: null,
    }),
  ].join(''));
  await assert.rejects(
    proveCodexWaitHistory(boundary, { wakeTaskId: WAKE }),
    /codex_rollout_wake_response_missing/,
  );
});

test('preflight exposes injected context and settings changes after suspension', async () => {
  const value = await fixture();
  const boundary = await capture(value);
  await writeFile(value.transcriptPath, [
    prefix(),
    turnComplete(ORIGIN, 'Await armed.'),
    line('response_item', { type: 'message', role: 'user', content: 'injected' }),
    line('event_msg', { type: 'thread_settings_applied', thread_settings: { model: 'other' } }),
  ].join(''));
  const proof = await preflightCodexWaitHistory(boundary, { scannedAt: SCANNED_AT });
  assert.equal(proof.historyMutationCount, 2);
});

test('preflight permits terminal telemetry and rejects unknown future rollout state', async () => {
  const value = await fixture();
  const boundary = await capture(value);
  await writeFile(value.transcriptPath, [
    prefix(),
    turnComplete(ORIGIN, 'Await armed.'),
    line('event_msg', { type: 'token_count', info: { total_tokens: 42 } }),
    line('compacted', { message: 'replacement history' }),
    line('world_state', { full: false, state: { cwd: '/changed' } }),
    line('inter_agent_communication', { message: 'unexpected delivery' }),
  ].join(''));
  const proof = await preflightCodexWaitHistory(boundary, { scannedAt: SCANNED_AT });
  assert.equal(proof.historyMutationCount, 3);
});
