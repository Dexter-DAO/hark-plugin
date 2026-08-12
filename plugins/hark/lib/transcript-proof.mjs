import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { sha256Canonical } from './canonical.mjs';
import { PINNED_CODEX_RUNTIME } from './pinned-codex-runtime.mjs';

export const CODEX_ROLLOUT_BOUNDARY_VERSION = 'hark.codex-rollout-boundary.v1';
export const CODEX_ROLLOUT_HISTORY_SOURCE = 'codex.rollout-jsonl.v1';
export const CODEX_TOOL_WAIT_BOUNDARY_VERSION = 'hark.codex-tool-wait-boundary.v1';
export const CODEX_TOOL_WAIT_PROOF_VERSION = 'hark.codex-tool-wait-proof.v1';
export const CODEX_TOOL_WAIT_INSPECTION_VERSION = 'hark.codex-tool-wait-inspection.v1';

const WAIT_HISTORY_PROOF_VERSION = 'hark.codex-wait-history-proof.v1';
const WAIT_HISTORY_SCAN_VERSION = 'hark.codex-wait-history-scan.v1';
const WAIT_PREFLIGHT_VERSION = 'hark.codex-wait-preflight.v1';
const WAIT_PREFLIGHT_SCAN_VERSION = 'hark.codex-wait-preflight-scan.v1';
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
// After Codex 0.147's persisted task_complete and before Hark's wake
// turn_context, the
// rollout must remain inert. Codex may append token accounting telemetry after
// a terminal event; every other record is model-visible state, control state,
// or an unknown future record and is therefore disqualifying by default.
const HARMLESS_POST_TERMINAL_EVENT_TYPES = new Set(['token_count']);
const HARMLESS_WAIT_EVENT_TYPES = new Set(['token_count']);
const PINNED_INTERACTIVE_CODEX_VERSION = PINNED_CODEX_RUNTIME.version;

function mutatesPostTerminalHistory(value) {
  return !(
    value.type === 'event_msg'
    && (
      HARMLESS_POST_TERMINAL_EVENT_TYPES.has(value.payload?.type)
      // Rollback is disqualifying, but is carried in its own counted field.
      || value.payload?.type === 'thread_rolled_back'
    )
  );
}

function requiredString(value, label, maxLength = 4096) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > maxLength
  ) throw new Error(`${label}_invalid`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_object_required`);
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}_field_unsupported:${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}_field_required:${key}`);
  }
  return value;
}

function safeByteLength(value, label) {
  const size = typeof value === 'bigint' ? value : BigInt(value);
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label}_invalid`);
  }
  return Number(size);
}

function statIdentity(metadata) {
  if (!metadata.isFile()) throw new Error('codex_rollout_not_regular_file');
  return {
    dev: metadata.dev.toString(),
    ino: metadata.ino.toString(),
    byteLength: safeByteLength(metadata.size, 'codex_rollout_byte_length'),
  };
}

function sameIdentity(metadata, boundary) {
  return metadata.dev.toString() === boundary.dev
    && metadata.ino.toString() === boundary.ino;
}

function containedBy(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== ''
    && !path.isAbsolute(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`);
}

function parsePhysicalLine(buffer) {
  const body = buffer.length > 0 && buffer[buffer.length - 1] === 0x0d
    ? buffer.subarray(0, -1)
    : buffer;
  if (body.length === 0) throw new Error('codex_rollout_empty_line');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch (error) {
    throw new Error('codex_rollout_line_not_utf8', { cause: error });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('codex_rollout_line_not_json', { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('codex_rollout_line_object_required');
  }
  return value;
}

async function scanJsonlRange(handle, { start, end, onLine, requireCompleteTail }) {
  let position = start;
  let pending = Buffer.alloc(0);
  let lineStart = start;
  let stopped = false;

  while (position < end && !stopped) {
    const requested = Math.min(READ_CHUNK_BYTES, end - position);
    const chunk = Buffer.allocUnsafe(requested);
    const { bytesRead } = await handle.read(chunk, 0, requested, position);
    if (bytesRead === 0) throw new Error('codex_rollout_unexpected_eof');
    position += bytesRead;
    const combined = pending.length === 0
      ? chunk.subarray(0, bytesRead)
      : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
    let cursor = 0;
    while (cursor < combined.length) {
      const newline = combined.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const physicalLine = combined.subarray(cursor, newline + 1);
      const value = parsePhysicalLine(physicalLine.subarray(0, -1));
      const lineEnd = lineStart + physicalLine.length;
      const keepGoing = await onLine(value, {
        startOffset: lineStart,
        endOffset: lineEnd,
        physicalLine,
      });
      lineStart = lineEnd;
      cursor = newline + 1;
      if (keepGoing === false) {
        stopped = true;
        break;
      }
    }
    pending = stopped ? Buffer.alloc(0) : Buffer.from(combined.subarray(cursor));
  }

  if (!stopped && requireCompleteTail && pending.length !== 0) {
    throw new Error('codex_rollout_incomplete_tail');
  }
  return { stopped, nextOffset: lineStart, trailingBytes: pending.length };
}

async function hashRange(handle, start, end) {
  const hasher = crypto.createHash('sha256');
  let position = start;
  while (position < end) {
    const requested = Math.min(READ_CHUNK_BYTES, end - position);
    const chunk = Buffer.allocUnsafe(requested);
    const { bytesRead } = await handle.read(chunk, 0, requested, position);
    if (bytesRead === 0) throw new Error('codex_rollout_unexpected_eof');
    hasher.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hasher.digest('hex');
}

function validateBoundary(value) {
  const boundary = exactKeys(value, [
    'v',
    'historySource',
    'transcriptPath',
    'sessionId',
    'originTaskId',
    'dev',
    'ino',
    'byteLength',
    'prefixSha256',
  ], 'codex_rollout_boundary');
  if (boundary.v !== CODEX_ROLLOUT_BOUNDARY_VERSION) {
    throw new Error('codex_rollout_boundary_version_invalid');
  }
  if (boundary.historySource !== CODEX_ROLLOUT_HISTORY_SOURCE) {
    throw new Error('codex_rollout_history_source_invalid');
  }
  requiredString(boundary.transcriptPath, 'transcript_path');
  if (!path.isAbsolute(boundary.transcriptPath)) throw new Error('transcript_path_not_absolute');
  requiredString(boundary.sessionId, 'session_id', 512);
  requiredString(boundary.originTaskId, 'origin_task_id', 512);
  if (!DECIMAL.test(boundary.dev)) throw new Error('codex_rollout_dev_invalid');
  if (!DECIMAL.test(boundary.ino)) throw new Error('codex_rollout_ino_invalid');
  if (!Number.isSafeInteger(boundary.byteLength) || boundary.byteLength <= 0) {
    throw new Error('codex_rollout_byte_length_invalid');
  }
  if (!SHA256.test(boundary.prefixSha256)) throw new Error('codex_rollout_prefix_sha256_invalid');
  return boundary;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('scanned_at_invalid');
  return date.toISOString();
}

function originTerminalEvent(value, originTaskId) {
  const type = value?.type === 'event_msg' ? value.payload?.type : null;
  if (!['task_complete', 'turn_aborted'].includes(type)) return null;
  const turnId = requiredString(
    value.payload?.turn_id,
    'codex_rollout_terminal_turn_id',
    512,
  );
  return {
    matchesOrigin: turnId === originTaskId,
    turnId,
    terminal: {
      type,
      observedAt: isoTimestamp(value.timestamp),
    },
  };
}

export function assertCodexToolWaitBoundary(value) {
  const boundary = exactKeys(value, [
    'v',
    'historySource',
    'transcriptPath',
    'conversationId',
    'originTaskId',
    'toolUseId',
    'toolName',
    'toolCallDigest',
    'inputDigest',
    'cliVersion',
    'dev',
    'ino',
    'byteLength',
    'prefixSha256',
  ], 'codex_tool_wait_boundary');
  if (boundary.v !== CODEX_TOOL_WAIT_BOUNDARY_VERSION) {
    throw new Error('codex_tool_wait_boundary_version_invalid');
  }
  if (boundary.historySource !== CODEX_ROLLOUT_HISTORY_SOURCE) {
    throw new Error('codex_rollout_history_source_invalid');
  }
  requiredString(boundary.transcriptPath, 'transcript_path');
  if (!path.isAbsolute(boundary.transcriptPath)) throw new Error('transcript_path_not_absolute');
  requiredString(boundary.conversationId, 'conversation_id', 512);
  requiredString(boundary.originTaskId, 'origin_task_id', 512);
  requiredString(boundary.toolUseId, 'tool_use_id', 512);
  requiredString(boundary.toolName, 'tool_name', 512);
  if (!SHA256.test(boundary.toolCallDigest)) throw new Error('tool_call_digest_invalid');
  if (!SHA256.test(boundary.inputDigest)) throw new Error('tool_input_digest_invalid');
  if (boundary.cliVersion !== PINNED_INTERACTIVE_CODEX_VERSION) {
    throw new Error(
      `codex_rollout_cli_version_mismatch:${String(boundary.cliVersion)}:`
      + PINNED_INTERACTIVE_CODEX_VERSION,
    );
  }
  if (!DECIMAL.test(boundary.dev)) throw new Error('codex_rollout_dev_invalid');
  if (!DECIMAL.test(boundary.ino)) throw new Error('codex_rollout_ino_invalid');
  if (!Number.isSafeInteger(boundary.byteLength) || boundary.byteLength <= 0) {
    throw new Error('codex_rollout_byte_length_invalid');
  }
  if (!SHA256.test(boundary.prefixSha256)) throw new Error('codex_rollout_prefix_sha256_invalid');
  return boundary;
}

function validateWaitHistoryPreflightBoundary(value) {
  if (value?.v !== CODEX_TOOL_WAIT_BOUNDARY_VERSION) return validateBoundary(value);

  // Held-call owner-abort preflight starts from the richer boundary captured at
  // tool dispatch. Validate that complete, pinned boundary before projecting
  // only the rollout identity fields consumed by the generic history scanner.
  // Final wake proof remains bound to the separately captured rollout boundary.
  const boundary = assertCodexToolWaitBoundary(value);
  return validateBoundary({
    v: CODEX_ROLLOUT_BOUNDARY_VERSION,
    historySource: boundary.historySource,
    transcriptPath: boundary.transcriptPath,
    sessionId: boundary.conversationId,
    originTaskId: boundary.originTaskId,
    dev: boundary.dev,
    ino: boundary.ino,
    byteLength: boundary.byteLength,
    prefixSha256: boundary.prefixSha256,
  });
}

function assertPinnedSessionMeta(value, sessionId) {
  if (value.payload?.id !== sessionId) throw new Error('codex_rollout_session_mismatch');
  const cliVersion = requiredString(
    value.payload?.cli_version,
    'codex_rollout_cli_version',
    64,
  );
  if (cliVersion !== PINNED_INTERACTIVE_CODEX_VERSION) {
    throw new Error(
      `codex_rollout_cli_version_mismatch:${cliVersion}:`
      + PINNED_INTERACTIVE_CODEX_VERSION,
    );
  }
  return cliVersion;
}

async function recheckPinnedToolWaitSession(handle, boundary) {
  let sessionMetaCount = 0;
  let cliVersion = null;
  await scanJsonlRange(handle, {
    start: 0,
    end: boundary.byteLength,
    requireCompleteTail: true,
    onLine(value) {
      if (value.type === 'session_meta') {
        sessionMetaCount += 1;
        cliVersion = assertPinnedSessionMeta(value, boundary.conversationId);
      }
    },
  });
  if (sessionMetaCount !== 1) throw new Error('codex_rollout_session_meta_invalid');
  if (cliVersion !== boundary.cliVersion) {
    throw new Error('codex_rollout_cli_version_binding_mismatch');
  }
}

function parseFunctionArguments(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error('codex_tool_call_arguments_invalid', { cause: error });
    }
  }
  return value;
}

function parseStructuredToolOutput(value) {
  if (typeof value !== 'string' || !value) throw new Error('codex_tool_output_invalid');
  const marker = 'Output:';
  const markerIndex = value.indexOf(marker);
  const source = markerIndex < 0 ? value : value.slice(markerIndex + marker.length);
  try {
    return JSON.parse(source.trim());
  } catch (error) {
    throw new Error('codex_tool_output_not_structured_json', { cause: error });
  }
}

function assistantMessageText(payload) {
  if (payload?.type === 'message' && payload.role === 'assistant') {
    if (typeof payload.content === 'string') return payload.content;
    if (Array.isArray(payload.content)) {
      return payload.content.map((item) => (
        typeof item === 'string' ? item : item?.text ?? item?.content ?? ''
      )).join('\n').trim();
    }
  }
  if (payload?.type === 'agent_message') {
    if (typeof payload.content === 'string') return payload.content;
    if (typeof payload.message === 'string') return payload.message;
  }
  return '';
}

const TURN_ABORTED_MARKER_TEXTS = new Set([
  '<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>',
  '<turn_aborted>\nThe previous turn was interrupted on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>',
]);

function isCodexTurnAbortedMarker(value, originTaskId) {
  const payload = value.type === 'response_item' ? value.payload : null;
  if (
    payload?.type !== 'message'
    || !['user', 'developer'].includes(payload.role)
    || !Array.isArray(payload.content)
    || payload.content.length !== 1
    || payload.content[0]?.type !== 'input_text'
    || !TURN_ABORTED_MARKER_TEXTS.has(payload.content[0].text)
  ) return false;
  return payload.internal_chat_message_metadata_passthrough?.turn_id === originTaskId;
}

function rolloutRecordTurnIds(value) {
  const ids = [];
  const push = (candidate, label) => {
    if (candidate === undefined || candidate === null) return;
    const turnId = requiredString(candidate, label, 512);
    if (!ids.includes(turnId)) ids.push(turnId);
  };
  if (value.type === 'turn_context') {
    push(value.payload?.turn_id, 'codex_rollout_turn_context_id');
  }
  if (value.type === 'event_msg') {
    push(value.payload?.turn_id, 'codex_rollout_event_turn_id');
  }
  if (value.type === 'response_item') {
    push(
      value.payload?.internal_chat_message_metadata_passthrough?.turn_id,
      'codex_rollout_response_turn_id',
    );
  }
  return ids;
}

/**
 * Capture the exact persisted Codex function-call boundary before Hark begins
 * waiting. The matching function_call_output must not exist yet.
 */
export async function captureCodexToolWaitBoundary({
  transcriptPath,
  threadPath,
  codexHome,
  sessionId,
  originTaskId,
  toolUseId,
  toolName,
  toolInput,
}) {
  requiredString(transcriptPath, 'transcript_path');
  requiredString(threadPath, 'thread_path');
  requiredString(codexHome, 'codex_home');
  requiredString(sessionId, 'session_id', 512);
  requiredString(originTaskId, 'origin_task_id', 512);
  requiredString(toolUseId, 'tool_use_id', 512);
  requiredString(toolName, 'tool_name', 512);
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    throw new Error('tool_input_object_required');
  }

  const [resolvedTranscript, resolvedThreadPath, resolvedCodexHome] = await Promise.all([
    realpath(transcriptPath),
    realpath(threadPath),
    realpath(codexHome),
  ]);
  if (resolvedTranscript !== resolvedThreadPath) {
    throw new Error('codex_rollout_thread_path_mismatch');
  }
  const homeMetadata = await stat(resolvedCodexHome, { bigint: true });
  if (!homeMetadata.isDirectory()) throw new Error('codex_home_not_directory');
  if (!containedBy(resolvedCodexHome, resolvedTranscript)) {
    throw new Error('codex_rollout_outside_codex_home');
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(resolvedTranscript, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    const identity = statIdentity(before);
    if (identity.byteLength === 0) throw new Error('codex_rollout_empty');
    const prefixHasher = crypto.createHash('sha256');
    const expectedInputDigest = sha256Canonical(toolInput);
    let sessionMetaCount = 0;
    let cliVersion = null;
    let lastTurnContextId = null;
    let matchingCall = null;
    let matchingCallCount = 0;
    let matchingOutputCount = 0;
    await scanJsonlRange(handle, {
      start: 0,
      end: identity.byteLength,
      requireCompleteTail: true,
      onLine(value, metadata) {
        prefixHasher.update(metadata.physicalLine);
        if (value.type === 'session_meta') {
          sessionMetaCount += 1;
          cliVersion = assertPinnedSessionMeta(value, sessionId);
        }
        if (value.type === 'turn_context') {
          lastTurnContextId = requiredString(
            value.payload?.turn_id,
            'codex_rollout_turn_context_id',
            512,
          );
        }
        if (
          value.type === 'response_item'
          && value.payload?.type === 'function_call'
          && value.payload?.call_id === toolUseId
        ) {
          matchingCallCount += 1;
          const argumentsValue = parseFunctionArguments(value.payload.arguments);
          if (sha256Canonical(argumentsValue) !== expectedInputDigest) {
            throw new Error('codex_tool_call_input_mismatch');
          }
          matchingCall = {
            callId: toolUseId,
            namespace: value.payload.namespace ?? null,
            name: value.payload.name ?? null,
            arguments: argumentsValue,
          };
        }
        if (
          value.type === 'response_item'
          && value.payload?.type === 'function_call_output'
          && value.payload?.call_id === toolUseId
        ) matchingOutputCount += 1;
      },
    });
    if (sessionMetaCount !== 1) throw new Error('codex_rollout_session_meta_invalid');
    if (lastTurnContextId !== originTaskId) {
      throw new Error('codex_rollout_origin_turn_context_mismatch');
    }
    if (matchingCallCount !== 1 || !matchingCall) throw new Error('codex_tool_call_missing');
    if (matchingOutputCount !== 0) throw new Error('codex_tool_output_already_present');
    const expectedFlatName = [matchingCall.namespace, matchingCall.name]
      .filter(Boolean)
      .join('__');
    const acceptedNames = new Set([
      `mcp__${expectedFlatName}`,
      expectedFlatName,
      matchingCall.name,
    ]);
    if (!acceptedNames.has(toolName) || matchingCall.name !== 'hark_await') {
      throw new Error('codex_tool_call_name_mismatch');
    }
    const toolCallDigest = sha256Canonical(matchingCall);
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(after, identity)) throw new Error('codex_rollout_identity_changed');
    if (after.size < before.size) throw new Error('codex_rollout_shrank_during_capture');
    return assertCodexToolWaitBoundary({
      v: CODEX_TOOL_WAIT_BOUNDARY_VERSION,
      historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
      transcriptPath: resolvedTranscript,
      conversationId: sessionId,
      originTaskId,
      toolUseId,
      toolName,
      toolCallDigest,
      inputDigest: expectedInputDigest,
      cliVersion,
      dev: identity.dev,
      ino: identity.ino,
      byteLength: identity.byteLength,
      prefixSha256: prefixHasher.digest('hex'),
    });
  } finally {
    await handle.close();
  }
}

/**
 * Certify that Hark returned the exact wake through the same function call and
 * that Codex produced a response in that same turn. Before the matching tool
 * output, token accounting is the only tolerated append; any model-visible or
 * control-state append makes the wait ineligible.
 */
export async function proveCodexToolWait(boundaryValue, {
  toolResult,
  wakeDeliveryDigest,
  scannedAt = undefined,
} = {}) {
  const boundary = assertCodexToolWaitBoundary(boundaryValue);
  if (!toolResult || typeof toolResult !== 'object' || Array.isArray(toolResult)) {
    throw new Error('tool_result_object_required');
  }
  if (!SHA256.test(wakeDeliveryDigest ?? '')) throw new Error('wake_delivery_digest_invalid');
  const toolResultDigest = sha256Canonical(toolResult);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(boundary.transcriptPath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    const current = statIdentity(before);
    if (!sameIdentity(before, boundary)) throw new Error('codex_rollout_identity_mismatch');
    if (current.byteLength < boundary.byteLength) throw new Error('codex_rollout_shrank');
    await recheckPinnedToolWaitSession(handle, boundary);
    if (await hashRange(handle, 0, boundary.byteLength) !== boundary.prefixSha256) {
      throw new Error('codex_rollout_prefix_mismatch');
    }

    const suffixHasher = crypto.createHash('sha256');
    const interveningTaskIds = [];
    let rollbackMarkerCount = 0;
    let historyMutationCount = 0;
    let waitingInferenceRecordCount = 0;
    let toolOutputCount = 0;
    let rolloutToolOutputDigest = null;
    let assistantResponse = '';
    let assistantResponseDigest = null;
    let completionObservedAt = null;
    let resultBoundaryByteLength = null;
    let completionBoundaryByteLength = null;
    let returned = false;

    await scanJsonlRange(handle, {
      start: boundary.byteLength,
      end: current.byteLength,
      requireCompleteTail: false,
      onLine(value, metadata) {
        suffixHasher.update(metadata.physicalLine);
        const eventType = value.type === 'event_msg' ? value.payload?.type : null;
        if (eventType === 'thread_rolled_back') rollbackMarkerCount += 1;
        if (value.type === 'turn_context') {
          const taskId = requiredString(
            value.payload?.turn_id,
            'codex_rollout_turn_context_id',
            512,
          );
          if (taskId !== boundary.originTaskId && !interveningTaskIds.includes(taskId)) {
            interveningTaskIds.push(taskId);
          }
        }

        if (!returned) {
          const matchingOutput = value.type === 'response_item'
            && value.payload?.type === 'function_call_output'
            && value.payload?.call_id === boundary.toolUseId;
          if (matchingOutput) {
            toolOutputCount += 1;
            const parsed = parseStructuredToolOutput(value.payload.output);
            if (sha256Canonical(parsed) !== toolResultDigest) {
              throw new Error('codex_tool_result_mismatch');
            }
            rolloutToolOutputDigest = sha256Canonical(value.payload.output);
            resultBoundaryByteLength = metadata.endOffset;
            returned = true;
            return true;
          }
          if (eventType && HARMLESS_WAIT_EVENT_TYPES.has(eventType)) return true;
          historyMutationCount += 1;
          if (
            value.type === 'response_item'
            && ['reasoning', 'message', 'agent_message', 'function_call'].includes(value.payload?.type)
          ) waitingInferenceRecordCount += 1;
          return true;
        }

        if (
          value.type === 'response_item'
          && value.payload?.type === 'function_call_output'
          && value.payload?.call_id === boundary.toolUseId
        ) {
          toolOutputCount += 1;
          return true;
        }
        const message = value.type === 'response_item' ? assistantMessageText(value.payload) : '';
        if (message) assistantResponse = message;
        if (eventType === 'task_complete') {
          if (value.payload?.turn_id !== boundary.originTaskId) {
            throw new Error('codex_tool_wait_completion_task_mismatch');
          }
          const finalMessage = typeof value.payload?.last_agent_message === 'string'
            ? value.payload.last_agent_message.trim()
            : '';
          if (!finalMessage || !assistantResponse) {
            throw new Error('codex_tool_wait_response_missing');
          }
          assistantResponseDigest = sha256Canonical(finalMessage);
          completionObservedAt = isoTimestamp(value.timestamp);
          completionBoundaryByteLength = metadata.endOffset;
          return false;
        }
        return true;
      },
    });

    if (toolOutputCount !== 1 || resultBoundaryByteLength === null) {
      throw new Error(toolOutputCount > 1
        ? 'codex_tool_output_duplicate'
        : 'codex_tool_output_missing');
    }
    if (completionBoundaryByteLength === null || !assistantResponseDigest) {
      throw new Error('codex_tool_wait_turn_incomplete');
    }
    const proofScannedAt = scannedAt === undefined
      ? completionObservedAt
      : isoTimestamp(scannedAt);
    if (!proofScannedAt) throw new Error('codex_tool_wait_completion_timestamp_missing');
    if (
      interveningTaskIds.length > 0
      || rollbackMarkerCount !== 0
      || historyMutationCount !== 0
      || waitingInferenceRecordCount !== 0
    ) throw new Error('codex_tool_wait_boundary_contaminated');

    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(after, boundary)) throw new Error('codex_rollout_identity_changed');
    if (after.size < before.size) throw new Error('codex_rollout_shrank_during_proof');
    const suffixSha256 = suffixHasher.digest('hex');
    const historyDigest = sha256Canonical({
      v: 'hark.codex-tool-wait-scan.v1',
      historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
      conversationId: boundary.conversationId,
      originTaskId: boundary.originTaskId,
      wakeTaskId: boundary.originTaskId,
      toolUseId: boundary.toolUseId,
      toolName: boundary.toolName,
      toolCallDigest: boundary.toolCallDigest,
      inputDigest: boundary.inputDigest,
      toolResultDigest,
      wakeDeliveryDigest,
      rolloutToolOutputDigest,
      assistantResponseDigest,
      resultBoundaryByteLength,
      completionBoundaryByteLength,
      interveningTaskIds,
      rollbackMarkerCount,
      historyMutationCount,
      waitingInferenceRecordCount,
      suffixSha256,
    });
    return {
      v: CODEX_TOOL_WAIT_PROOF_VERSION,
      historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
      conversationId: boundary.conversationId,
      originTaskId: boundary.originTaskId,
      wakeTaskId: boundary.originTaskId,
      toolUseId: boundary.toolUseId,
      toolName: boundary.toolName,
      toolCallDigest: boundary.toolCallDigest,
      inputDigest: boundary.inputDigest,
      toolResultDigest,
      wakeDeliveryDigest,
      rolloutToolOutputDigest,
      assistantResponseDigest,
      interveningTaskIds,
      rollbackMarkerCount,
      historyMutationCount,
      waitingInferenceRecordCount,
      scannedAt: proofScannedAt,
      historyDigest,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Resolve the crash boundary without guessing. This inspection does not
 * certify completion; it tells recovery whether the exact output is absent,
 * already persisted, or followed by a terminal event in the origin turn.
 */
export async function inspectCodexToolWait(boundaryValue, { toolResult } = {}) {
  const boundary = assertCodexToolWaitBoundary(boundaryValue);
  if (!toolResult || typeof toolResult !== 'object' || Array.isArray(toolResult)) {
    throw new Error('tool_result_object_required');
  }
  const toolResultDigest = sha256Canonical(toolResult);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(boundary.transcriptPath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    const current = statIdentity(before);
    if (!sameIdentity(before, boundary)) throw new Error('codex_rollout_identity_mismatch');
    if (current.byteLength < boundary.byteLength) throw new Error('codex_rollout_shrank');
    if (await hashRange(handle, 0, boundary.byteLength) !== boundary.prefixSha256) {
      throw new Error('codex_rollout_prefix_mismatch');
    }

    const suffixHasher = crypto.createHash('sha256');
    let toolOutputCount = 0;
    let rolloutToolOutputDigest = null;
    let originTerminal = null;
    let otherTurnSeen = false;
    let preResultMutationCount = 0;
    let pendingAbortMarker = false;
    const flushPendingAbortMarker = () => {
      if (!pendingAbortMarker) return;
      pendingAbortMarker = false;
      preResultMutationCount += 1;
    };
    const scan = await scanJsonlRange(handle, {
      start: boundary.byteLength,
      end: current.byteLength,
      requireCompleteTail: false,
      onLine(value, metadata) {
        suffixHasher.update(metadata.physicalLine);
        const eventType = value.type === 'event_msg' ? value.payload?.type : null;
        for (const turnId of rolloutRecordTurnIds(value)) {
          if (turnId !== boundary.originTaskId) otherTurnSeen = true;
        }
        const matchingOutput = value.type === 'response_item'
          && value.payload?.type === 'function_call_output'
          && value.payload?.call_id === boundary.toolUseId;
        if (matchingOutput) {
          flushPendingAbortMarker();
          if (toolOutputCount === 0 && originTerminal) {
            throw new Error('codex_tool_output_after_origin_terminal');
          }
          toolOutputCount += 1;
          const parsed = parseStructuredToolOutput(value.payload.output);
          if (sha256Canonical(parsed) !== toolResultDigest) {
            throw new Error('codex_tool_result_mismatch');
          }
          rolloutToolOutputDigest = sha256Canonical(value.payload.output);
          return true;
        }
        if (toolOutputCount === 0) {
          if (eventType && HARMLESS_WAIT_EVENT_TYPES.has(eventType)) return true;
          if (originTerminal) {
            if (
              ['turn_aborted', 'task_complete'].includes(eventType)
              && value.payload?.turn_id === boundary.originTaskId
            ) throw new Error('codex_tool_wait_terminal_duplicate');
            return true;
          }
          if (
            eventType === 'turn_aborted'
            && value.payload?.turn_id === boundary.originTaskId
          ) {
            pendingAbortMarker = false;
            originTerminal = {
              type: 'turn_aborted',
              reason: typeof value.payload?.reason === 'string'
                ? value.payload.reason
                : 'unknown',
              observedAt: isoTimestamp(value.timestamp),
            };
            return true;
          }
          if (
            eventType === 'task_complete'
            && value.payload?.turn_id === boundary.originTaskId
          ) {
            flushPendingAbortMarker();
            originTerminal = {
              type: 'task_complete',
              reason: value.payload?.error ? 'error' : 'completed',
              observedAt: isoTimestamp(value.timestamp),
            };
            return true;
          }
          if (isCodexTurnAbortedMarker(value, boundary.originTaskId)) {
            flushPendingAbortMarker();
            pendingAbortMarker = true;
            return true;
          }
          flushPendingAbortMarker();
          preResultMutationCount += 1;
          return true;
        }
        if (
          ['turn_aborted', 'task_complete'].includes(eventType)
          && value.payload?.turn_id === boundary.originTaskId
        ) {
          if (originTerminal) throw new Error('codex_tool_wait_terminal_duplicate');
          originTerminal = {
            type: eventType,
            reason: eventType === 'turn_aborted'
              ? (typeof value.payload?.reason === 'string' ? value.payload.reason : 'unknown')
              : (value.payload?.error ? 'error' : 'completed'),
            observedAt: isoTimestamp(value.timestamp),
          };
        }
        return true;
      },
    });
    const incompleteTail = scan.trailingBytes !== 0;
    if (!incompleteTail) flushPendingAbortMarker();
    if (toolOutputCount > 1) throw new Error('codex_tool_output_duplicate');
    if (otherTurnSeen) throw new Error('codex_tool_wait_other_turn_seen');
    if (preResultMutationCount > 0) throw new Error('codex_tool_wait_pre_result_contaminated');

    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(after, boundary)) throw new Error('codex_rollout_identity_changed');
    if (after.size < before.size) throw new Error('codex_rollout_shrank_during_inspection');
    let state;
    if (incompleteTail) state = 'ambiguous_incomplete_tail';
    else if (toolOutputCount === 0 && originTerminal?.type === 'turn_aborted') {
      state = 'origin_aborted_before_result';
    } else if (toolOutputCount === 0 && originTerminal?.type === 'task_complete') {
      state = 'origin_completed_without_result';
    } else if (toolOutputCount === 0) state = 'waiting';
    else if (originTerminal?.type === 'turn_aborted') state = 'tool_result_then_aborted';
    else if (originTerminal?.type === 'task_complete') state = 'tool_result_turn_terminal';
    else state = 'tool_result_persisted';
    const suffixSha256 = suffixHasher.digest('hex');
    const trailingSha256 = incompleteTail
      ? await hashRange(handle, scan.nextOffset, current.byteLength)
      : null;
    return {
      v: CODEX_TOOL_WAIT_INSPECTION_VERSION,
      historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
      conversationId: boundary.conversationId,
      originTaskId: boundary.originTaskId,
      toolUseId: boundary.toolUseId,
      toolName: boundary.toolName,
      inputDigest: boundary.inputDigest,
      toolResultDigest,
      rolloutToolOutputDigest,
      state,
      originTerminal,
      incompleteTail,
      inspectedAtByteLength: current.byteLength,
      historyDigest: sha256Canonical({
        v: 'hark.codex-tool-wait-inspection-scan.v1',
        conversationId: boundary.conversationId,
        originTaskId: boundary.originTaskId,
        toolUseId: boundary.toolUseId,
        toolResultDigest,
        rolloutToolOutputDigest,
        state,
        originTerminal,
        incompleteTail,
        inspectedAtByteLength: current.byteLength,
        suffixSha256,
        trailingSha256,
      }),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Capture the immutable prefix that already binds a trusted PostToolUse hook to
 * one persisted Codex 0.147 rollout and origin turn.
 */
export async function captureCodexRolloutBoundary({
  transcriptPath,
  threadPath,
  codexHome,
  sessionId,
  originTaskId,
}) {
  requiredString(transcriptPath, 'transcript_path');
  requiredString(threadPath, 'thread_path');
  requiredString(codexHome, 'codex_home');
  requiredString(sessionId, 'session_id', 512);
  requiredString(originTaskId, 'origin_task_id', 512);

  const [resolvedTranscript, resolvedThreadPath, resolvedCodexHome] = await Promise.all([
    realpath(transcriptPath),
    realpath(threadPath),
    realpath(codexHome),
  ]);
  if (resolvedTranscript !== resolvedThreadPath) {
    throw new Error('codex_rollout_thread_path_mismatch');
  }
  const homeMetadata = await stat(resolvedCodexHome, { bigint: true });
  if (!homeMetadata.isDirectory()) throw new Error('codex_home_not_directory');
  if (!containedBy(resolvedCodexHome, resolvedTranscript)) {
    throw new Error('codex_rollout_outside_codex_home');
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(resolvedTranscript, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    const identity = statIdentity(before);
    if (identity.byteLength === 0) throw new Error('codex_rollout_empty');

    const prefixHasher = crypto.createHash('sha256');
    let sessionMetaCount = 0;
    let lastTurnContextId = null;
    await scanJsonlRange(handle, {
      start: 0,
      end: identity.byteLength,
      requireCompleteTail: true,
      onLine(value, metadata) {
        prefixHasher.update(metadata.physicalLine);
        if (value.type === 'session_meta') {
          sessionMetaCount += 1;
          if (value.payload?.id !== sessionId) throw new Error('codex_rollout_session_mismatch');
        }
        if (value.type === 'turn_context') {
          lastTurnContextId = requiredString(
            value.payload?.turn_id,
            'codex_rollout_turn_context_id',
            512,
          );
        }
      },
    });
    if (sessionMetaCount !== 1) throw new Error('codex_rollout_session_meta_invalid');
    if (lastTurnContextId !== originTaskId) {
      throw new Error('codex_rollout_origin_turn_context_mismatch');
    }

    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(after, identity)) throw new Error('codex_rollout_identity_changed');
    if (after.size < before.size) throw new Error('codex_rollout_shrank_during_capture');

    return validateBoundary({
      v: CODEX_ROLLOUT_BOUNDARY_VERSION,
      historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
      transcriptPath: resolvedTranscript,
      sessionId,
      originTaskId,
      dev: identity.dev,
      ino: identity.ino,
      byteLength: identity.byteLength,
      prefixSha256: prefixHasher.digest('hex'),
    });
  } finally {
    await handle.close();
  }
}

/**
 * Take a stable, append-only snapshot immediately before dispatch. A wake is
 * eligible only when Codex has persisted no distinct turn and no rollback
 * after the captured origin boundary. This is repeated after dispatch with the
 * actual wake turn ID; preflight prevents knowingly running the wrong task,
 * while the later proof certifies the boundary that actually ran.
 */
export async function preflightCodexWaitHistory(boundaryValue, {
  scannedAt = new Date(),
} = {}) {
  const boundary = validateWaitHistoryPreflightBoundary(boundaryValue);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(boundary.transcriptPath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    const current = statIdentity(before);
    if (!sameIdentity(before, boundary)) throw new Error('codex_rollout_identity_mismatch');
    if (current.byteLength < boundary.byteLength) throw new Error('codex_rollout_shrank');
    if (await hashRange(handle, 0, boundary.byteLength) !== boundary.prefixSha256) {
      throw new Error('codex_rollout_prefix_mismatch');
    }

    const suffixHasher = crypto.createHash('sha256');
    const interveningTaskIds = [];
    const seenTaskIds = new Set([boundary.originTaskId]);
    let rollbackMarkerCount = 0;
    let historyMutationCount = 0;
    let originTerminal = null;
    await scanJsonlRange(handle, {
      start: boundary.byteLength,
      end: current.byteLength,
      requireCompleteTail: true,
      onLine(value, metadata) {
        suffixHasher.update(metadata.physicalLine);
        if (value.type === 'event_msg' && value.payload?.type === 'thread_rolled_back') {
          if (!Number.isSafeInteger(value.payload?.num_turns) || value.payload.num_turns < 1) {
            throw new Error('codex_rollout_rollback_marker_invalid');
          }
          rollbackMarkerCount += 1;
        }
        const terminalEvent = originTerminalEvent(value, boundary.originTaskId);
        if (terminalEvent?.matchesOrigin) {
          if (originTerminal) throw new Error('codex_rollout_origin_terminal_duplicate');
          originTerminal = terminalEvent.terminal;
          return true;
        }
        if (terminalEvent && !terminalEvent.matchesOrigin) {
          throw new Error('codex_rollout_origin_terminal_other_turn');
        }
        if (
          originTerminal
          && value.type !== 'turn_context'
          && mutatesPostTerminalHistory(value)
        ) historyMutationCount += 1;
        if (value.type !== 'turn_context') return true;
        const taskId = requiredString(
          value.payload?.turn_id,
          'codex_rollout_turn_context_id',
          512,
        );
        if (!seenTaskIds.has(taskId)) {
          seenTaskIds.add(taskId);
          interveningTaskIds.push(taskId);
        }
        return true;
      },
    });
    if (!originTerminal) throw new Error('codex_rollout_origin_turn_incomplete');

    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(after, boundary)) throw new Error('codex_rollout_identity_changed');
    if (after.size !== before.size) throw new Error('codex_rollout_grew_during_preflight');

    const suffixSha256 = suffixHasher.digest('hex');
    const historyDigest = sha256Canonical({
      v: WAIT_PREFLIGHT_SCAN_VERSION,
      historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
      conversationId: boundary.sessionId,
      originTaskId: boundary.originTaskId,
      boundary: {
        dev: boundary.dev,
        ino: boundary.ino,
        byteLength: boundary.byteLength,
        prefixSha256: boundary.prefixSha256,
      },
      scanByteLength: current.byteLength,
      originTerminal,
      interveningTaskIds,
      rollbackMarkerCount,
      historyMutationCount,
      suffixSha256,
    });

    return {
      v: WAIT_PREFLIGHT_VERSION,
      historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
      conversationId: boundary.sessionId,
      originTaskId: boundary.originTaskId,
      originTerminal,
      interveningTaskIds,
      rollbackMarkerCount,
      historyMutationCount,
      scannedAt: isoTimestamp(scannedAt),
      historyDigest,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Prove physical rollout order after a captured origin boundary. Intervening
 * turns and rollback markers are returned, not hidden: the server certifies
 * only the exact-adjacency case where both are empty/zero.
 */
export async function proveCodexWaitHistory(boundaryValue, {
  wakeTaskId,
  scannedAt = new Date(),
} = {}) {
  const boundary = validateBoundary(boundaryValue);
  requiredString(wakeTaskId, 'wake_task_id', 512);
  if (wakeTaskId === boundary.originTaskId) throw new Error('wake_task_matches_origin');

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(boundary.transcriptPath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    const current = statIdentity(before);
    if (!sameIdentity(before, boundary)) throw new Error('codex_rollout_identity_mismatch');
    if (current.byteLength < boundary.byteLength) throw new Error('codex_rollout_shrank');
    if (await hashRange(handle, 0, boundary.byteLength) !== boundary.prefixSha256) {
      throw new Error('codex_rollout_prefix_mismatch');
    }

    const suffixHasher = crypto.createHash('sha256');
    const orderedTaskIds = [];
    const seenTaskIds = new Set([boundary.originTaskId]);
    let rollbackMarkerCount = 0;
    let historyMutationCount = 0;
    let originTerminal = null;
    let wakeTurnSeen = false;
    let wakeResponseDigest = null;
    let wakeBoundaryByteLength = null;

    await scanJsonlRange(handle, {
      start: boundary.byteLength,
      end: current.byteLength,
      requireCompleteTail: false,
      onLine(value, metadata) {
        suffixHasher.update(metadata.physicalLine);
        const eventType = value.type === 'event_msg' ? value.payload?.type : null;
        if (eventType === 'thread_rolled_back') {
          if (!Number.isSafeInteger(value.payload?.num_turns) || value.payload.num_turns < 1) {
            throw new Error('codex_rollout_rollback_marker_invalid');
          }
          rollbackMarkerCount += 1;
        }
        if (
          wakeTurnSeen
          && eventType === 'task_complete'
          && value.payload?.turn_id === wakeTaskId
        ) {
          const message = value.payload?.last_agent_message;
          const timeToFirstTokenMs = value.payload?.time_to_first_token_ms;
          if (typeof message !== 'string' || !message.trim()) {
            throw new Error('codex_rollout_wake_response_missing');
          }
          if (!Number.isFinite(timeToFirstTokenMs) || timeToFirstTokenMs < 0) {
            throw new Error('codex_rollout_wake_sampling_time_missing');
          }
          wakeResponseDigest = sha256Canonical(message);
          wakeBoundaryByteLength = metadata.endOffset;
          return false;
        }
        const terminalEvent = originTerminalEvent(value, boundary.originTaskId);
        if (terminalEvent?.matchesOrigin) {
          if (wakeTurnSeen) throw new Error('codex_rollout_origin_terminal_late');
          if (originTerminal) throw new Error('codex_rollout_origin_terminal_duplicate');
          originTerminal = terminalEvent.terminal;
          return true;
        }
        if (terminalEvent && !terminalEvent.matchesOrigin) {
          throw new Error('codex_rollout_origin_terminal_other_turn');
        }
        if (
          originTerminal
          && !wakeTurnSeen
          && value.type !== 'turn_context'
          && mutatesPostTerminalHistory(value)
        ) historyMutationCount += 1;
        if (value.type !== 'turn_context') return true;
        const taskId = requiredString(
          value.payload?.turn_id,
          'codex_rollout_turn_context_id',
          512,
        );
        if (!seenTaskIds.has(taskId)) {
          seenTaskIds.add(taskId);
          orderedTaskIds.push(taskId);
        }
        if (taskId === wakeTaskId) {
          if (!originTerminal) throw new Error('codex_rollout_wake_before_origin_terminal');
          wakeTurnSeen = true;
        }
        return true;
      },
    });

    if (!originTerminal) throw new Error('codex_rollout_origin_turn_incomplete');
    if (wakeBoundaryByteLength === null) throw new Error('codex_rollout_wake_turn_missing');
    if (!wakeResponseDigest) throw new Error('codex_rollout_wake_response_missing');
    if (orderedTaskIds.at(-1) !== wakeTaskId) {
      throw new Error('codex_rollout_wake_turn_order_invalid');
    }

    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(after, boundary)) throw new Error('codex_rollout_identity_changed');
    if (after.size < before.size) throw new Error('codex_rollout_shrank_during_proof');

    const interveningTaskIds = orderedTaskIds.slice(0, -1);
    const suffixSha256 = suffixHasher.digest('hex');
    const historyDigest = sha256Canonical({
      v: WAIT_HISTORY_SCAN_VERSION,
      historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
      conversationId: boundary.sessionId,
      originTaskId: boundary.originTaskId,
      wakeTaskId,
      boundary: {
        dev: boundary.dev,
        ino: boundary.ino,
        byteLength: boundary.byteLength,
        prefixSha256: boundary.prefixSha256,
      },
      wakeBoundaryByteLength,
      originTerminal,
      orderedTaskIds: [boundary.originTaskId, ...orderedTaskIds],
      rollbackMarkerCount,
      historyMutationCount,
      wakeResponseDigest,
      suffixSha256,
    });

    return {
      v: WAIT_HISTORY_PROOF_VERSION,
      historySource: CODEX_ROLLOUT_HISTORY_SOURCE,
      conversationId: boundary.sessionId,
      originTaskId: boundary.originTaskId,
      wakeTaskId,
      originTerminal,
      interveningTaskIds,
      rollbackMarkerCount,
      historyMutationCount,
      wakeResponseDigest,
      scannedAt: isoTimestamp(scannedAt),
      historyDigest,
    };
  } finally {
    await handle.close();
  }
}
