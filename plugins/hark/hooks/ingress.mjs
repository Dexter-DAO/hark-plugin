#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CODEX_HARK_AWAIT_HOOK_TOOL_NAME,
  validatePrepareArguments,
} from '../lib/await-preparation.mjs';
import { canonicalJson, sha256Canonical } from '../lib/canonical.mjs';
import { HarkCredentialsStore } from '../lib/credentials.mjs';
import {
  assertPrivateClaimReference,
  createPrivateClaimBinding,
  HarkPrivateClaimStore,
} from '../lib/private-claim-store.mjs';
import {
  classifyToolResultObservationCertification,
} from '../lib/held-wait-certifier.mjs';
import { HarkApiError, HarkServiceClient } from '../lib/service-client.mjs';
import { HarkToolErrorLifecycle } from '../lib/tool-error-lifecycle.mjs';
import {
  assertAdmissionLocatorInput,
  assertArmAttemptInstallationFence,
  assertToolResultObservationAck,
  assertToolWaitResult,
  createAdmissionLocatorInput,
  HarkToolWaitProtocol,
  materializeToolResultObservationReceipt,
} from '../lib/tool-wait-protocol.mjs';
import { assertCodexToolWaitBoundary } from '../lib/transcript-proof.mjs';

const MAX_HOOK_INPUT_BYTES = 256 * 1024;
const CLAIM_META_KEY = 'cash.dexter.hark/claim';
const PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
]);
const PRE_TOOL_USE_KEYS = new Set([
  'session_id',
  'turn_id',
  'agent_id',
  'agent_type',
  'transcript_path',
  'cwd',
  'hook_event_name',
  'model',
  'permission_mode',
  'tool_name',
  'tool_input',
  'tool_use_id',
]);
const POST_TOOL_USE_KEYS = new Set([...PRE_TOOL_USE_KEYS, 'tool_response']);
const COMMON_REQUIRED_KEYS = new Set([
  'session_id',
  'turn_id',
  'transcript_path',
  'cwd',
  'hook_event_name',
  'model',
  'permission_mode',
  'tool_name',
  'tool_input',
  'tool_use_id',
]);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_object_required`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label}_object_invalid`);
  }
  return value;
}

function assertExactKeys(value, keys, label) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}_field_unsupported:${key}`);
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}_field_required:${key}`);
  }
}

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label}_field_unsupported:${key}`);
  }
}

function assertRequiredKeys(value, required, label) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label}_field_required:${key}`);
  }
}

function assertBoundedString(value, label, max = 512) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.includes('\0')
    || value.length > max
  ) throw new Error(`${label}_invalid`);
  return value;
}

function assertAbsolutePath(value, label) {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\0')
    || value.length > 4096
    || !path.isAbsolute(value)
  ) throw new Error(`${label}_invalid`);
  return value;
}

function assertRootHookInput(input, eventName, allowed, required = COMMON_REQUIRED_KEYS) {
  assertPlainObject(input, 'hook_input');
  assertAllowedKeys(input, allowed, 'hook_input');
  assertRequiredKeys(input, required, 'hook_input');
  if (input.hook_event_name !== eventName) throw new Error('hook_event_name_invalid');
  if (Object.hasOwn(input, 'agent_id') || Object.hasOwn(input, 'agent_type')) {
    throw new Error('subagent_context_rejected');
  }
  assertBoundedString(input.session_id, 'session_id');
  assertBoundedString(input.turn_id, 'turn_id');
  assertAbsolutePath(input.transcript_path, 'transcript_path');
  assertAbsolutePath(input.cwd, 'cwd');
  assertBoundedString(input.model, 'model', 256);
  if (!PERMISSION_MODES.has(input.permission_mode)) throw new Error('permission_mode_invalid');
  assertBoundedString(input.tool_name, 'tool_name', 512);
  assertBoundedString(input.tool_use_id, 'tool_use_id');
  return input;
}

function preToolUseOutput(updatedInput) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
  };
}

function validateTextContent(content) {
  if (!Array.isArray(content) || content.length !== 1) {
    throw new Error('tool_response_content_invalid');
  }
  const [item] = content;
  assertPlainObject(item, 'tool_response_content');
  assertExactKeys(item, ['type', 'text'], 'tool_response_content');
  if (item.type !== 'text') throw new Error('tool_response_content_type_invalid');
  assertBoundedString(item.text, 'tool_response_content_text', 16_000);
}

function validateHeldClaimReference(meta, binding) {
  assertPlainObject(meta, 'tool_response_meta');
  assertExactKeys(meta, [CLAIM_META_KEY], 'tool_response_meta');
  return assertPrivateClaimReference(meta[CLAIM_META_KEY], binding);
}

function validateTranscriptBoundary(boundaryValue, admission, delivery) {
  const boundary = assertCodexToolWaitBoundary(boundaryValue);
  for (const [field, expected] of [
    ['transcriptPath', admission.transcriptPath],
    ['conversationId', admission.sessionId],
    ['originTaskId', admission.turnId],
    ['toolUseId', delivery.toolUseId],
    ['toolName', admission.toolName],
    ['inputDigest', admission.originalInputDigest],
  ]) {
    if (boundary[field] !== expected) throw new Error(`transcript_boundary_${field}_mismatch`);
  }
  return boundary;
}

function validateErrorMcpResponse(response) {
  assertPlainObject(response, 'tool_response');
  assertExactKeys(response, ['content', 'isError'], 'tool_response');
  if (response.isError !== true) throw new Error('tool_response_is_error_invalid');
  validateTextContent(response.content);
}

async function ensureToolError(request, response, protocol, clock) {
  const existing = await protocol.readToolError(request);
  if (existing) return existing;
  const armAttempt = await protocol.readArmAttempt(request);
  let failureCode = 'pre_arm_failed';
  if (armAttempt) {
    const armBinding = await protocol.readArmBinding(request);
    failureCode = 'arm_outcome_ambiguous';
    if (armBinding) {
      const waiterReady = await protocol.readWaiterReady(request, armBinding);
      failureCode = 'armed_precommit_failed';
      if (waiterReady) {
        const commitAttempt = await protocol.readCommitAttempt(
          request,
          armBinding,
          waiterReady,
        );
        if (commitAttempt) {
          const committed = await protocol.readSuspensionCommitted(
            request,
            armBinding,
            waiterReady,
          );
          failureCode = committed ? 'postcommit_failed' : 'commit_outcome_ambiguous';
        }
      }
    }
  }
  return (await protocol.publishToolError(request, {
    failureCode,
    errorDigest: sha256Canonical({
      v: 'hark.post-tool-error.v1',
      response,
    }),
  }, clock)).toolError;
}

async function serviceForToolError(options) {
  const credentialsStore = options.credentialsStore
    ?? new HarkCredentialsStore(options.dataDir);
  const credentials = options.credentials ?? await credentialsStore.read();
  if (!credentials) throw new Error('hark_not_connected');
  const service = options.serviceClient ?? new HarkServiceClient({
    baseUrl: credentials.apiBaseUrl,
    accessToken: credentials.accessToken,
  });
  return { service, credentials, credentialsStore };
}

function validateSuccessfulMcpResponse(response, admission, delivery) {
  assertPlainObject(response, 'tool_response');
  assertAllowedKeys(
    response,
    new Set(['content', 'structuredContent', 'isError', '_meta']),
    'tool_response',
  );
  assertRequiredKeys(response, new Set(['content']), 'tool_response');
  if (Object.hasOwn(response, 'isError') && response.isError !== false) {
    throw new Error('tool_response_is_error_invalid');
  }
  assertRequiredKeys(response, new Set(['structuredContent', '_meta']), 'tool_response');
  validateTextContent(response.content);
  const result = assertToolWaitResult(response.structuredContent, delivery);
  const binding = createPrivateClaimBinding({
    eventId: delivery.eventId,
    deliveryId: delivery.deliveryId,
    awaitId: delivery.awaitId,
    wakeId: delivery.wakeId,
    toolUseId: delivery.toolUseId,
    checkpointDigest: delivery.checkpointDigest,
    wakeDeliveryDigest: delivery.wakeDeliveryDigest,
    toolResultDigest: sha256Canonical(result),
  });
  const claimReference = validateHeldClaimReference(response._meta, binding);
  return { result, binding, claimReference };
}

async function observationRuntime(options) {
  const credentialsStore = options.credentialsStore
    ?? new HarkCredentialsStore(options.dataDir);
  const credentials = options.credentials ?? await credentialsStore.read();
  if (!credentials) throw new Error('hark_not_connected');
  assertPlainObject(credentials, 'hark_credentials');
  assertPlainObject(credentials.installation, 'hark_installation');
  if (credentials.installation.protocol !== 'codex') {
    throw new Error('installation_protocol_invalid');
  }
  assertBoundedString(credentials.installation.runtimeId, 'runtime_id', 200);
  const service = options.serviceClient ?? new HarkServiceClient({
    baseUrl: credentials.apiBaseUrl,
    accessToken: credentials.accessToken,
  });
  if (typeof service?.recordRuntimeReceipt !== 'function') {
    throw new Error('hark_service_client_invalid');
  }
  if (typeof service?.certifyAwait !== 'function') {
    throw new Error('hark_service_client_invalid');
  }
  return {
    credentials,
    credentialsStore,
    runtimeId: credentials.installation.runtimeId,
    service,
  };
}

async function assertCurrentAttemptInstallation(request, protocol, runtime, options = {}) {
  const armAttempt = await protocol.readArmAttempt(request);
  if (!armAttempt) throw new Error('tool_wait_arm_attempt_missing');
  const credentials = options.credentials
    ?? await runtime.credentialsStore.read();
  if (!credentials) throw new Error('hark_not_connected');
  const status = await runtime.service.getInstallationStatus({ signal: options.signal });
  assertArmAttemptInstallationFence(
    request,
    armAttempt,
    credentials.installation,
    status.installation,
  );
  return { armAttempt, credentials, installation: status.installation };
}

async function recordImmediateToolResultObservation(intent, privateClaim, service, options) {
  const receipt = materializeToolResultObservationReceipt(intent, privateClaim);
  const response = await service.recordRuntimeReceipt(intent.awaitId, receipt, {
    signal: options.signal,
  });
  assertToolResultObservationAck(response, intent);
  return { receipt, response };
}

function observationCanDefer(error, signal) {
  if (signal?.aborted) return false;
  const status = error instanceof HarkApiError ? error.status : error?.status;
  const code = error?.code ?? error?.message;
  return ['wake_lease_stale'].includes(code)
    || [408, 425, 429].includes(status)
    || status >= 500
    || ['AbortError', 'TimeoutError'].includes(error?.name)
    || new Set([
      'EAI_AGAIN', 'EAGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
      'EINTR', 'ENETDOWN', 'ENETUNREACH', 'ETIMEDOUT',
    ]).has(code);
}

async function exactObservationAlreadyRecorded(
  service,
  intent,
  delivery,
  result,
  persistedBoundary,
  runtimeId,
  options,
) {
  const certification = await service.certifyAwait(intent.awaitId, {
    signal: options.signal,
  });
  const disposition = classifyToolResultObservationCertification(certification, {
    delivery,
    persistedBoundary,
    result,
    runtimeId,
  });
  return disposition.kind === 'observed';
}

async function handlePreToolUse(input, options) {
  const { protocol, clock, randomBytes } = options;
  assertRootHookInput(input, 'PreToolUse', PRE_TOOL_USE_KEYS);
  if (input.tool_name !== CODEX_HARK_AWAIT_HOOK_TOOL_NAME) {
    return { accepted: false, reason: 'tool_not_hark_await' };
  }
  const normalizedPublicInput = validatePrepareArguments(input.tool_input);
  const published = await protocol.publishAdmission({
    sessionId: input.session_id,
    turnId: input.turn_id,
    toolUseId: input.tool_use_id,
    toolName: input.tool_name,
    transcriptPath: input.transcript_path,
    originalInput: normalizedPublicInput,
  }, clock, randomBytes);
  const output = preToolUseOutput(published.rewrittenInput);
  return {
    accepted: true,
    kind: published.admission.kind,
    eventId: published.admission.eventId,
    created: published.created,
    codexOutput: output,
  };
}

async function handlePostToolUse(input, options) {
  const { protocol, clock } = options;
  assertRootHookInput(
    input,
    'PostToolUse',
    POST_TOOL_USE_KEYS,
    new Set([...COMMON_REQUIRED_KEYS, 'tool_response']),
  );
  if (input.tool_name !== CODEX_HARK_AWAIT_HOOK_TOOL_NAME) {
    return { accepted: false, reason: 'tool_not_hark_await' };
  }
  const rewrittenInput = assertAdmissionLocatorInput(input.tool_input);
  const admission = await protocol.readConsumedAdmission(
    rewrittenInput._hark.admissionLocator,
  );
  if (!admission) throw new Error('tool_wait_consumed_admission_missing');
  if (
    admission.sessionId !== input.session_id
    || admission.turnId !== input.turn_id
    || admission.toolUseId !== input.tool_use_id
    || admission.toolName !== input.tool_name
    || admission.transcriptPath !== input.transcript_path
  ) throw new Error('tool_wait_post_use_host_identity_mismatch');
  if (canonicalJson(rewrittenInput) !== canonicalJson(createAdmissionLocatorInput(admission))) {
    throw new Error('tool_wait_post_use_input_mismatch');
  }
  const request = await protocol.readAwaitRequest(admission.eventId);
  if (!request) throw new Error('tool_wait_await_request_missing');
  if (input.tool_response?.isError === true) {
    validateErrorMcpResponse(input.tool_response);
    const armAttempt = await protocol.readArmAttempt(request);
    const runtime = armAttempt ? await serviceForToolError(options) : null;
    if (runtime) {
      // The authenticated self read is the only remote operation permitted
      // before an attempt-bearing error path may advance any local lifecycle.
      await assertCurrentAttemptInstallation(request, protocol, {
        ...runtime,
        service: runtime.service,
      }, options);
    }
    const toolError = await ensureToolError(
      request,
      input.tool_response,
      protocol,
      clock,
    );
    if (runtime) {
      await assertCurrentAttemptInstallation(request, protocol, {
        ...runtime,
        service: runtime.service,
      }, options);
    }
    await protocol.publishToolErrorObservation(request, toolError, {
      responseDigest: sha256Canonical(input.tool_response),
    }, clock);
    const lifecycle = options.toolErrorLifecycle ?? new HarkToolErrorLifecycle({
      protocol,
      serviceClient: runtime?.service,
      credentials: options.credentials ?? runtime?.credentials,
      credentialsStore: runtime?.credentialsStore,
      readCredentials: runtime
        ? (options.credentials
          ? async () => options.credentials
          : () => runtime.credentialsStore.read())
        : undefined,
      clock,
    });
    await lifecycle.reconcile(request, { signal: options.signal, toolError });
    return { accepted: false, reason: 'tool_result_error' };
  }
  const delivery = await protocol.readWakeDelivery(admission.eventId);
  if (!delivery) throw new Error('tool_wait_wake_delivery_missing');
  const validated = validateSuccessfulMcpResponse(input.tool_response, admission, delivery);
  const persistedBoundary = await protocol.readTranscriptBoundary(admission.eventId);
  if (!persistedBoundary) throw new Error('tool_wait_transcript_boundary_missing');
  if (
    persistedBoundary.eventId !== delivery.eventId
    || persistedBoundary.awaitId !== delivery.awaitId
    || persistedBoundary.toolUseId !== admission.toolUseId
    || persistedBoundary.inputDigest !== admission.originalInputDigest
  ) throw new Error('tool_wait_transcript_boundary_binding_mismatch');
  const transcriptBoundary = validateTranscriptBoundary(
    persistedBoundary.boundary,
    admission,
    delivery,
  );
  const claimStore = options.claimStore ?? new HarkPrivateClaimStore(
    options.dataDir ?? protocol.dataDir,
  );
  const runtime = await observationRuntime(options);
  const fence = () => assertCurrentAttemptInstallation(
    request,
    protocol,
    runtime,
    options,
  );
  await fence();
  const intent = await protocol.readToolResultObservationIntent(
    delivery,
    validated.result,
    transcriptBoundary,
    runtime.runtimeId,
    validated.claimReference,
  );
  if (!intent) throw new Error('tool_result_observation_intent_missing');
  const privateClaim = await claimStore.resolve(
    validated.claimReference,
    validated.binding,
  );
  let created = false;
  let existing = await protocol.readToolResultReturned(delivery, validated.result);
  if (existing) {
    if (canonicalJson(existing.transcriptBoundary) !== canonicalJson(transcriptBoundary)) {
      throw new Error('tool_result_returned_transcript_boundary_mismatch');
    }
  } else if (privateClaim.state !== 'pending') {
    throw new Error('private_claim_consumed_without_tool_result');
  } else {
    await fence();
    const published = await protocol.publishToolResultReturned(
      delivery,
      validated.result,
      {
        wakeDeliveryDigest: delivery.wakeDeliveryDigest,
        transcriptBoundary,
      },
      clock,
    );
    existing = published.toolResultReturned;
    created = published.created;
  }

  if (privateClaim.state === 'consumed') {
    return {
      accepted: true,
      kind: existing.kind,
      eventId: existing.eventId,
      deliveryId: existing.deliveryId,
      created,
    };
  }

  let observationResolved = false;
  try {
    await fence();
    await recordImmediateToolResultObservation(
      intent,
      privateClaim,
      runtime.service,
      options,
    );
    observationResolved = true;
  } catch (error) {
    const code = error?.code ?? error?.message;
    if (error?.status === 409 && code !== 'wake_lease_stale') {
      try {
        await fence();
        observationResolved = await exactObservationAlreadyRecorded(
          runtime.service,
          intent,
          delivery,
          validated.result,
          persistedBoundary,
          runtime.runtimeId,
          options,
        );
      } catch (probeError) {
        if (!observationCanDefer(probeError, options.signal)) throw probeError;
        return {
          accepted: true,
          reason: 'tool_result_observation_deferred',
          kind: existing.kind,
          eventId: existing.eventId,
          deliveryId: existing.deliveryId,
          created,
        };
      }
      if (!observationResolved) throw error;
    } else if (observationCanDefer(error, options.signal)) {
      return {
        accepted: true,
        reason: 'tool_result_observation_deferred',
        kind: existing.kind,
        eventId: existing.eventId,
        deliveryId: existing.deliveryId,
        created,
      };
    } else {
      throw error;
    }
  }
  if (!observationResolved) throw new Error('tool_result_observation_unresolved');
  await fence();
  await claimStore.consume(validated.claimReference, validated.binding, { clock });
  return {
    accepted: true,
    kind: existing.kind,
    eventId: existing.eventId,
    deliveryId: existing.deliveryId,
    created,
  };
}

export async function handleCodexHook(input, options = {}) {
  const protocol = options.protocol ?? new HarkToolWaitProtocol(options.dataDir);
  const clock = options.clock ?? (() => new Date());
  if (input?.hook_event_name === 'PreToolUse') {
    return handlePreToolUse(input, { ...options, protocol, clock });
  }
  if (input?.hook_event_name === 'PostToolUse') {
    return handlePostToolUse(input, { ...options, protocol, clock });
  }
  return { accepted: false, reason: 'hook_event_unsupported' };
}

export async function readHookInput(stream = process.stdin, maxBytes = MAX_HOOK_INPUT_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error('hook_input_too_large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) throw new Error('hook_input_empty');
  return JSON.parse(raw);
}

async function main() {
  try {
    const result = await handleCodexHook(await readHookInput());
    if (result.accepted && result.codexOutput) {
      process.stdout.write(`${JSON.stringify(result.codexOutput)}\n`);
    }
  } catch (error) {
    process.stderr.write(`Hark hook ingress rejected: ${error?.message ?? String(error)}\n`);
    // Codex 0.147 treats hook command failures as non-authoritative. Hark's
    // MCP server independently fails closed unless it consumes this admission.
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) void main();
