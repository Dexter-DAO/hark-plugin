#!/usr/bin/env node

import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { canonicalJson, sha256Canonical } from '../lib/canonical.mjs';
import { HarkHookInbox } from '../lib/hook-inbox.mjs';
import { HarkJournal } from '../lib/journal.mjs';
import { HarkToolWaitProtocol } from '../lib/tool-wait-protocol.mjs';
import { readHookInput } from './ingress.mjs';

const OWNED_AWAIT_STATES = new Set([
  'armed',
  'suspended',
  'wake_pending',
  'wake_received',
  'running',
]);
const WAKE_PROMPT_ADMISSION_STATES = new Set([
  'dispatching',
  'submitted',
  'dispatch_uncertain',
]);

function observedPreparationOwnsSession(record, sessionId) {
  if (!record || typeof record !== 'object' || record.state !== 'observed') return false;
  const binding = record.binding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  const threadId = typeof binding.threadId === 'string' ? binding.threadId : null;
  const conversationId = typeof binding.origin?.conversationId === 'string'
    ? binding.origin.conversationId
    : null;
  // A partially written or internally inconsistent legacy binding must not
  // release the one session it does identify. It grants no wake authority;
  // it only keeps that dormant boundary closed until reconciliation.
  return threadId === sessionId || conversationId === sessionId;
}

function requiredString(value, label, maxLength) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
  ) throw new Error(`${label}_invalid`);
  return value;
}

function assertPromptInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hook_input_object_required');
  }
  if (value.hook_event_name !== 'UserPromptSubmit') {
    throw new Error('hook_event_name_invalid');
  }
  requiredString(value.session_id, 'session_id', 512);
  requiredString(value.turn_id, 'turn_id', 512);
  requiredString(value.prompt, 'prompt', 128 * 1024);
  if (Object.hasOwn(value, 'agent_id') || Object.hasOwn(value, 'agent_type')) {
    throw new Error('subagent_context_rejected');
  }
  if (
    typeof value.transcript_path !== 'string'
    || !value.transcript_path
    || value.transcript_path.length > 4096
    || !path.isAbsolute(value.transcript_path)
  ) throw new Error('transcript_path_invalid');
  return value;
}

/**
 * Once a root thread has published its held MCP request (or the supervisor has
 * armed a recovery Await), Hark exclusively owns its dormant boundary. Codex
 * runs this hook for user input from every connected client, which prevents
 * turn/start from steering an ordinary prompt into the sleep or racing the
 * authenticated wake. The supervisor's exact wake prompt is the sole
 * exception, and only while that Wake is in its dispatching boundary.
 */
export async function evaluatePromptGuard(input, options = {}) {
  const value = assertPromptInput(input);
  const journal = options.journal ?? new HarkJournal();
  const inbox = options.inbox ?? new HarkHookInbox(journal.dataDir);
  const protocol = options.protocol ?? new HarkToolWaitProtocol(journal.dataDir);
  const [state, heldRequests] = await Promise.all([
    journal.read(),
    protocol.listAwaitRequests(),
  ]);
  const ownsHeldCall = heldRequests.some((request) => (
    request.sessionId === value.session_id
  ));
  const ownsObservedPreparation = Object.values(state.preparations).some((record) => (
    observedPreparationOwnsSession(record, value.session_id)
  ));
  const ownedAwaits = Object.values(state.awaits).filter((record) => (
    record.origin?.conversationId === value.session_id
    && OWNED_AWAIT_STATES.has(record.state)
  ));
  if (!ownsHeldCall && !ownsObservedPreparation && ownedAwaits.length === 0) {
    return { allowed: true, reason: 'thread_not_owned' };
  }

  const transcriptPath = await realpath(value.transcript_path);
  const promptDigest = sha256Canonical(value.prompt);
  const ownedAwaitIds = new Set(ownedAwaits.map((record) => record.id));
  const admissions = [];
  for (const wakeRecord of Object.values(state.wakes)) {
    const persistedAdmission = wakeRecord?.wakeAdmission;
    if (!persistedAdmission?.id) continue;
    const admission = await inbox.readWakeAdmission(persistedAdmission.id);
    if (!admission) throw new Error('hook_wake_admission_missing');
    if (canonicalJson(admission) !== canonicalJson(persistedAdmission)) {
      throw new Error('hook_wake_admission_binding_mismatch');
    }
    if (!(
      admission.sessionId === value.session_id
      && admission.transcriptPath === transcriptPath
      && admission.promptDigest === promptDigest
      && ownedAwaitIds.has(admission.awaitId)
      && wakeRecord?.wake?.wakeId === admission.wakeId
      && wakeRecord.wake?.awaitId === admission.awaitId
      && wakeRecord.wake?.origin?.conversationId === admission.sessionId
      && wakeRecord.promptDigest === admission.promptDigest
      && admission.leaseGeneration <= wakeRecord.claim?.leaseGeneration
      && WAKE_PROMPT_ADMISSION_STATES.has(wakeRecord.state)
    )) continue;
    const fence = await inbox.readWakeDispatchFence(admission.wakeId);
    if (!fence) continue;
    const intent = await inbox.readWakeDispatchIntent(fence);
    if (
      intent?.admissionId === admission.id
      && intent.marker === fence.marker
      && intent.promptDigest === admission.promptDigest
    ) admissions.push(admission);
  }
  if (admissions.length > 1) throw new Error('hook_wake_admission_ambiguous');
  if (admissions.length === 1) {
    const admission = admissions[0];
    const result = await inbox.acknowledgeWakeAdmission(admission, {
      turnId: value.turn_id,
      transcriptPath,
    }, options.clock);
    return {
      allowed: true,
      reason: 'authenticated_hark_wake',
      wakeId: admission.wakeId,
      admissionId: admission.id,
      acknowledgementCreated: result.created,
    };
  }
  return {
    allowed: false,
    reason: 'This Codex thread is asleep in Hark. Cancel its Await or let Hark wake it.',
  };
}

async function main() {
  try {
    const result = await evaluatePromptGuard(await readHookInput());
    if (!result.allowed) {
      process.stderr.write(`${result.reason}\n`);
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`Hark prompt guard rejected: ${error?.message ?? String(error)}\n`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) void main();

export { OWNED_AWAIT_STATES, WAKE_PROMPT_ADMISSION_STATES };
