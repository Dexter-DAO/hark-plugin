#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AppServerClient,
  CODEX_APP_SERVER_COMPATIBILITY,
} from '../lib/app-server-client.mjs';
import {
  CodexDaemonTransport,
  createCodexDaemonTransportFactory,
} from '../lib/codex-daemon-transport.mjs';
import { HarkCredentialsStore } from '../lib/credentials.mjs';
import { HarkHeldCrashRecovery } from '../lib/held-crash-recovery.mjs';
import { HarkHookInbox } from '../lib/hook-inbox.mjs';
import { HarkHeldWaitCertifier } from '../lib/held-wait-certifier.mjs';
import { defaultHarkDataDir, HarkJournal } from '../lib/journal.mjs';
import { HarkApiError, HarkServiceClient } from '../lib/service-client.mjs';
import {
  installPinnedCodexRuntime,
  managedCodexPath,
  verifyPinnedCodexRuntime,
} from '../lib/pinned-codex-runtime.mjs';
import { HarkCodexSupervisor } from '../lib/supervisor.mjs';
import { openSupervisorLogs, SupervisorProcessLock } from '../lib/supervisor-process.mjs';
import { HarkToolWaitProtocol } from '../lib/tool-wait-protocol.mjs';
import {
  captureCodexRolloutBoundary,
  preflightCodexWaitHistory,
  proveCodexWaitHistory,
} from '../lib/transcript-proof.mjs';

const HELP = `Hark for Codex

Usage:
  hark-codex connect [--api-url URL] [--name NAME] [--no-open]
  hark-codex setup [--api-url URL] [--name NAME] [--no-open] [--codex PATH]
  hark-codex onboard [--json]
  hark-codex ensure [--codex PATH] [--json]
  hark-codex run [--codex PATH]
  hark-codex doctor [--codex PATH] [--json]

Commands:
  connect  Run foreground approval; --no-open prints the headless URL and code.
  setup    Bootstrap the pinned Codex daemon, connect Hark, and start the supervisor.
  onboard  Complete first-run setup in the background, or keep Hark running.
  ensure   Start one background supervisor if this runtime is ready.
  run      Attach the Hark supervisor to the pinned Codex App Server daemon.
  doctor   Verify credentials, Codex sandbox execution, and App Server gates.

Environment:
  HARK_API_URL    Hark API base URL (default: https://api.dexter.cash)
  HARK_ALLOW_INSECURE_LOOPBACK=1  Permit HTTP only for localhost development
  HARK_CODEX_BIN  Exact Codex 0.147.0 executable
  HARK_DATA_DIR   Shared private Hark data directory (default: ~/.hark)
`;

const CODEX_PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function certifiedHookContract(pluginRoot) {
  return Object.freeze({
    SessionStart: Object.freeze({
      command: `node "${pluginRoot}/hark/cli/hark-codex.mjs" onboard --json`,
      timeout: 10,
      matcher: null,
    }),
    PreToolUse: Object.freeze({
      command: `node "${pluginRoot}/hark/hooks/ingress.mjs"`,
      timeout: 10,
      matcher: 'mcp__hark__hark_await',
    }),
    PostToolUse: Object.freeze({
      command: `node "${pluginRoot}/hark/hooks/ingress.mjs"`,
      timeout: 40,
      matcher: 'mcp__hark__hark_await',
    }),
    UserPromptSubmit: Object.freeze({
      command: `node "${pluginRoot}/hark/hooks/prompt-guard.mjs"`,
      timeout: 5,
      matcher: null,
    }),
  });
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? 'help';
  const options = {};
  while (args.length) {
    const arg = args.shift();
    if (arg === '--no-open') options.open = false;
    else if (arg === '--json') options.json = true;
    else if (['--api-url', '--name', '--codex'].includes(arg)) {
      const value = args.shift();
      if (!value) throw new Error(`missing_value:${arg}`);
      options[arg.slice(2).replaceAll('-', '_')] = value;
    } else throw new Error(`unknown_argument:${arg}`);
  }
  return { command, options };
}

function wait(ms, signal = undefined) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      operation();
    };
    const abort = () => {
      clearTimeout(timer);
      finish(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    };
    const timer = setTimeout(() => finish(resolve), ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

async function waitForSupervisorReady(lock, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await lock.inspectReady();
    if (ready) return ready;
    const process = await lock.inspect();
    if (!process) throw new Error('hark_supervisor_exited_before_ready');
    await wait(50);
  }
  throw new Error('hark_supervisor_ready_timeout');
}

function openUrl(url, spawnImpl = spawn) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawnImpl(command[0], command[1], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

function formatDeviceVerification(value) {
  const verificationUriComplete = typeof value?.verificationUriComplete === 'string'
    ? value.verificationUriComplete.trim()
    : '';
  const userCode = typeof value?.userCode === 'string' ? value.userCode.trim() : '';
  if (!verificationUriComplete) throw new Error('verification_uri_complete_required');
  if (!userCode) throw new Error('user_code_required');
  return [
    `verificationUriComplete: ${verificationUriComplete}`,
    `userCode: ${userCode}`,
    '',
  ].join('\n');
}

export async function connectCommand(options = {}, dependencies = {}) {
  const journal = dependencies.journal ?? new HarkJournal();
  const credentialsStore = dependencies.credentialsStore ?? new HarkCredentialsStore();
  const runtimeId = await journal.ensureRuntimeId(() => cryptoRandomRuntimeId());
  const existing = await credentialsStore.read();
  if (existing) {
    if (existing.installation.runtimeId !== runtimeId) {
      throw new Error('installation_runtime_mismatch');
    }
    return { alreadyConnected: true, installation: existing.installation };
  }
  const baseUrl = options.api_url ?? process.env.HARK_API_URL;
  const unauthenticated = dependencies.serviceClient ?? new HarkServiceClient({ baseUrl });
  const device = await unauthenticated.createDeviceCode({
    runtimeId,
    name: options.name ?? `${os.hostname()} Codex`,
  });
  dependencies.onVerification?.({
    userCode: device.userCode,
    verificationUri: device.verificationUri,
    verificationUriComplete: device.verificationUriComplete,
  });
  if (options.open !== false) {
    (dependencies.openUrl ?? openUrl)(device.verificationUriComplete);
  }
  const intervalMs = Math.max(1, Number(device.interval) || 3) * 1000;
  const expiresAt = Date.now() + Math.max(1, Number(device.expiresIn) || 600) * 1000;
  while (Date.now() < expiresAt) {
    try {
      const token = await unauthenticated.exchangeDeviceCode(device.deviceCode);
      if (token.installation.runtimeId !== runtimeId || token.installation.protocol !== 'codex') {
        throw new Error('installation_identity_mismatch');
      }
      await credentialsStore.save({
        apiBaseUrl: unauthenticated.baseUrl,
        accessToken: token.accessToken,
        installation: token.installation,
      });
      return { alreadyConnected: false, installation: token.installation };
    } catch (error) {
      if (error instanceof HarkApiError && error.code === 'authorization_pending') {
        await (dependencies.wait ?? wait)(intervalMs, options.signal);
        continue;
      }
      throw error;
    }
  }
  throw new Error('device_code_expired');
}

function cryptoRandomRuntimeId() {
  return `hkr_${globalThis.crypto.randomUUID()}`;
}

function codexHome(options = {}, dependencies = {}) {
  return dependencies.codexHome
    ?? options.codex_home
    ?? process.env.CODEX_HOME
    ?? path.join(os.homedir(), '.codex');
}

function configuredCodexCommand(options = {}, dependencies = {}) {
  return options.codex
    ?? process.env.HARK_CODEX_BIN
    ?? managedCodexPath(codexHome(options, dependencies));
}

const HARK_DIRECT_TOOL_NAMESPACE = 'mcp__hark';
const HARK_DIRECT_TOOL_NAMESPACE_KEY = 'features.code_mode.direct_only_tool_namespaces';

function directOnlyToolNamespaces(config, { requireHark = false } = {}) {
  const namespaces = config?.features?.code_mode?.direct_only_tool_namespaces;
  if (namespaces === undefined) {
    if (requireHark) {
      const error = new Error('codex_hark_direct_tool_namespace_missing');
      error.code = 'CODEX_HARK_DIRECT_TOOL_NAMESPACE_MISSING';
      throw error;
    }
    return [];
  }
  if (
    !Array.isArray(namespaces)
    || namespaces.some((value) => typeof value !== 'string' || !value || value !== value.trim())
    || new Set(namespaces).size !== namespaces.length
  ) {
    const error = new Error('codex_direct_tool_namespaces_invalid');
    error.code = 'CODEX_DIRECT_TOOL_NAMESPACES_INVALID';
    throw error;
  }
  if (requireHark && !namespaces.includes(HARK_DIRECT_TOOL_NAMESPACE)) {
    const error = new Error('codex_hark_direct_tool_namespace_missing');
    error.code = 'CODEX_HARK_DIRECT_TOOL_NAMESPACE_MISSING';
    throw error;
  }
  return namespaces;
}

function configClient(command, dependencies = {}) {
  const factory = dependencies.configAppServerClientFactory;
  if (typeof factory === 'function') return factory({ command });
  return new AppServerClient({
    command,
    cwd: dependencies.cwd,
    env: dependencies.env ?? process.env,
  });
}

async function readCodexConfig(command, dependencies = {}, { includeLayers = false } = {}) {
  const client = configClient(command, dependencies);
  try {
    const initialized = await client.start();
    const result = await client.readConfig({
      cwd: dependencies.cwd ?? process.cwd(),
      includeLayers,
    });
    return { initialized, result };
  } finally {
    try {
      await client.close?.();
    } catch {
      // The read result remains authoritative; shutdown is best-effort.
    }
  }
}

export async function verifyHarkDirectToolNamespace(command, dependencies = {}) {
  const { result } = await readCodexConfig(command, dependencies);
  const namespaces = directOnlyToolNamespaces(result.config, { requireHark: true });
  return { namespace: HARK_DIRECT_TOOL_NAMESPACE, namespaces };
}

export async function ensureHarkDirectToolNamespace(command, dependencies = {}) {
  const client = configClient(command, dependencies);
  let changed = false;
  let namespaces;
  try {
    const initialized = await client.start();
    const result = await client.readConfig({
      cwd: dependencies.cwd ?? process.cwd(),
      includeLayers: true,
    });
    namespaces = directOnlyToolNamespaces(result.config);
    if (!namespaces.includes(HARK_DIRECT_TOOL_NAMESPACE)) {
      if (!Array.isArray(result.layers)) throw new Error('codex_config_layers_unverifiable');
      const expectedConfigPath = path.join(initialized.codexHome, 'config.toml');
      const userLayers = result.layers.filter((layer) => (
        layer?.name?.type === 'user'
        && layer.name.profile == null
        && layer.name.file === expectedConfigPath
      ));
      if (userLayers.length !== 1 || typeof userLayers[0].version !== 'string') {
        throw new Error('codex_user_config_layer_unverifiable');
      }
      if (typeof client.writeConfigValue !== 'function') {
        throw new Error('codex_config_write_unavailable');
      }
      const userNamespaces = directOnlyToolNamespaces(userLayers[0].config);
      const merged = [...new Set([
        ...userNamespaces,
        ...namespaces,
        HARK_DIRECT_TOOL_NAMESPACE,
      ])];
      const response = await client.writeConfigValue({
        keyPath: HARK_DIRECT_TOOL_NAMESPACE_KEY,
        value: merged,
        mergeStrategy: 'replace',
        expectedVersion: userLayers[0].version,
        filePath: expectedConfigPath,
      });
      if (response.filePath !== expectedConfigPath || response.status !== 'ok') {
        throw new Error(`codex_config_write_not_effective:${response.status ?? 'unknown'}`);
      }
      namespaces = merged;
      changed = true;
    }
  } finally {
    try {
      await client.close?.();
    } catch {
      // The writer/readback gates above remain authoritative.
    }
  }
  if (changed) {
    const verified = await verifyHarkDirectToolNamespace(command, dependencies);
    if (
      verified.namespaces.length !== namespaces.length
      || verified.namespaces.some((value, index) => value !== namespaces[index])
    ) {
      throw new Error('codex_direct_tool_namespaces_readback_mismatch');
    }
  }
  return { changed, namespace: HARK_DIRECT_TOOL_NAMESPACE, namespaces };
}

const CODEX_SANDBOX_PERMISSION_PROFILES = Object.freeze([':read-only', ':workspace']);
const CODEX_SANDBOX_TIMEOUT_MS = 5_000;
const BWRAP_USER_NAMESPACE_FAILURES = Object.freeze([
  'loopback: Failed RTM_NEWADDR: Operation not permitted',
  'loopback: Failed RTM_NEWLINK: Operation not permitted',
  'setting up uid map: Permission denied',
  'No permissions to create a new namespace',
]);

function codexSandboxError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

export function isCodexBubblewrapHostPolicyFailure(error) {
  const text = typeof error?.stderr === 'string'
    ? error.stderr
    : error instanceof Error ? error.message : String(error ?? '');
  return BWRAP_USER_NAMESPACE_FAILURES.some((marker) => text.includes(marker));
}

export async function verifyCodexSandbox(command, dependencies = {}) {
  const execute = dependencies.runProcess ?? runProcess;
  for (const permissionProfile of CODEX_SANDBOX_PERMISSION_PROFILES) {
    try {
      await execute(command, [
        'sandbox',
        '--disable',
        'use_legacy_landlock',
        '-P',
        permissionProfile,
        '--',
        '/bin/true',
      ], { timeoutMs: dependencies.timeoutMs ?? CODEX_SANDBOX_TIMEOUT_MS });
    } catch (cause) {
      const hostPolicyBlocked = isCodexBubblewrapHostPolicyFailure(cause);
      throw codexSandboxError(
        hostPolicyBlocked
          ? 'CODEX_SANDBOX_USERNS_UNAVAILABLE'
          : 'CODEX_SANDBOX_UNAVAILABLE',
        hostPolicyBlocked
          ? 'Codex bubblewrap is blocked by the host user-namespace policy. '
            + 'Install Ubuntu bubblewrap, apparmor-profiles, and apparmor-utils, then load '
            + 'bwrap-userns-restrict as documented at '
            + 'https://learn.chatgpt.com/docs/sandboxing#prerequisites'
          : `Codex sandbox execution failed for ${permissionProfile}`,
        cause,
      );
    }
  }
  return {
    status: 'ready',
    backend: 'bubblewrap',
    permissionProfiles: [...CODEX_SANDBOX_PERMISSION_PROFILES],
  };
}

export async function createSupervisorRuntime(options = {}, dependencies = {}) {
  const dataDir = dependencies.dataDir ?? defaultHarkDataDir();
  const journal = dependencies.journal ?? new HarkJournal(dataDir);
  const credentialsStore = dependencies.credentialsStore ?? new HarkCredentialsStore(dataDir);
  const credentials = await credentialsStore.read();
  if (!credentials) throw new Error('hark_not_connected');
  const runtimeId = await journal.ensureRuntimeId(() => credentials.installation.runtimeId);
  if (runtimeId !== credentials.installation.runtimeId) throw new Error('installation_runtime_mismatch');
  const command = configuredCodexCommand(options, dependencies);
  await (dependencies.verifyPinnedCodexRuntime ?? verifyPinnedCodexRuntime)(command);
  await (dependencies.verifyHarkDirectToolNamespace ?? verifyHarkDirectToolNamespace)(
    command,
    dependencies,
  );
  const transportFactory = dependencies.transportFactory
    ?? createCodexDaemonTransportFactory({ command });
  const appServerClientFactory = dependencies.appServerClientFactory
    ?? (dependencies.appServerClient
      ? () => dependencies.appServerClient
      : () => new AppServerClient({ command, transportFactory }));
  const service = dependencies.serviceClient ?? new HarkServiceClient({
    baseUrl: credentials.apiBaseUrl,
    accessToken: credentials.accessToken,
  });
  const heldWaitProtocol = dependencies.heldWaitProtocol ?? new HarkToolWaitProtocol(dataDir);
  const heldWaitCertifier = dependencies.heldWaitCertifier ?? new HarkHeldWaitCertifier({
    protocol: heldWaitProtocol,
    serviceClient: service,
    credentialsStore,
    installation: credentials.installation,
    runtimeId,
    logger: dependencies.logger ?? console,
  });
  const heldRecovery = dependencies.heldRecovery ?? new HarkHeldCrashRecovery({
    protocol: heldWaitProtocol,
    serviceClient: service,
    runtimeId,
  });
  const supervisor = new HarkCodexSupervisor({
    appServerClientFactory,
    serviceClient: service,
    credentialsStore,
    journal,
    hookInbox: dependencies.hookInbox ?? new HarkHookInbox(dataDir),
    transcriptProof: dependencies.transcriptProof ?? {
      capture: captureCodexRolloutBoundary,
      preflight: preflightCodexWaitHistory,
      prove: proveCodexWaitHistory,
    },
    heldWaitCertifier,
    heldRecovery,
    runtimeId,
    installation: credentials.installation,
    logger: dependencies.logger ?? console,
  });
  return {
    supervisor,
    heldWaitCertifier,
    heldRecovery,
    appServerClientFactory,
    service,
    journal,
    credentials,
  };
}

export async function runCommand(options = {}, dependencies = {}) {
  const runtime = await createSupervisorRuntime(options, dependencies);
  await runtime.supervisor.start();
  return runtime;
}

async function runProcess(command, args, dependencies = {}) {
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const maxOutputBytes = dependencies.maxOutputBytes ?? 65_536;
    const append = (current, chunk) => `${current}${chunk}`.slice(-maxOutputBytes);
    const timeoutMs = Number(dependencies.timeoutMs);
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill?.('SIGKILL');
      }, timeoutMs)
      : null;
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const error = new Error(`command_failed:${code}:${stderr.trim()}`);
        error.code = timedOut ? 'COMMAND_TIMED_OUT' : 'COMMAND_FAILED';
        error.exitCode = code;
        error.signal = signal ?? null;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

export async function bootstrapDaemonCommand(options = {}, dependencies = {}) {
  const explicitCommand = options.codex ?? process.env.HARK_CODEX_BIN ?? null;
  let command;
  if (explicitCommand) {
    command = explicitCommand;
  } else {
    const installed = await (
      dependencies.installPinnedCodexRuntime ?? installPinnedCodexRuntime
    )({ codexHome: codexHome(options, dependencies) });
    command = installed.path;
  }
  const runtime = await (
    dependencies.verifyPinnedCodexRuntime ?? verifyPinnedCodexRuntime
  )(command);
  const execute = dependencies.runProcess ?? runProcess;
  const versionResult = await execute(command, ['--version']);
  const versionOutput = `${versionResult?.stdout ?? ''}\n${versionResult?.stderr ?? ''}`;
  const actualVersion = versionOutput.match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+)/)?.[1] ?? null;
  if (actualVersion !== CODEX_APP_SERVER_COMPATIBILITY.codexVersion) {
    throw new Error(
      `codex_version_gate_failed:${actualVersion ?? 'unknown'}:`
      + CODEX_APP_SERVER_COMPATIBILITY.codexVersion,
    );
  }
  const sandbox = await (dependencies.verifyCodexSandbox ?? verifyCodexSandbox)(command, {
    runProcess: execute,
  });
  const directToolNamespace = await (
    dependencies.ensureHarkDirectToolNamespace ?? ensureHarkDirectToolNamespace
  )(command, dependencies);
  // `bootstrap` launches Codex's detached auto-updater, which would silently
  // replace the certified runtime. Hark deliberately enables the setting and
  // starts the daemon through the two non-updating lifecycle commands.
  await execute(command, ['app-server', 'daemon', 'enable-remote-control']);
  await execute(command, ['app-server', 'daemon', 'start']);
  if (directToolNamespace.changed) {
    await execute(command, ['app-server', 'daemon', 'restart']);
  }
  const daemon = dependencies.daemonTransport ?? new CodexDaemonTransport({ command });
  const inspection = await daemon.inspect();
  if (inspection.managedCodexPath && inspection.managedCodexPath !== command) {
    throw new Error('codex_managed_path_mismatch');
  }
  return {
    ...inspection,
    harkCodexPath: command,
    codeModeHostPath: runtime.codeModeHostPath,
    codeModeHostSha256: runtime.codeModeHostSha256,
    bwrapPath: runtime.bwrapPath,
    bwrapSha256: runtime.bwrapSha256,
    sandbox,
    directToolNamespace,
  };
}

export async function ensureCommand(options = {}, dependencies = {}) {
  const dataDir = dependencies.dataDir ?? defaultHarkDataDir();
  const credentialsStore = dependencies.credentialsStore ?? new HarkCredentialsStore(dataDir);
  const credentials = await credentialsStore.read();
  if (!credentials) return { started: false, reason: 'not_connected' };
  const command = configuredCodexCommand(options, dependencies);
  try {
    await (dependencies.verifyPinnedCodexRuntime ?? verifyPinnedCodexRuntime)(command);
    await (dependencies.verifyHarkDirectToolNamespace ?? verifyHarkDirectToolNamespace)(
      command,
      dependencies,
    );
  } catch (error) {
    return { started: false, reason: error?.code ?? 'runtime_incomplete' };
  }
  const lock = dependencies.processLock ?? new SupervisorProcessLock(dataDir);
  const existing = await lock.inspect();
  if (existing?.alive) {
    let ready = typeof lock.inspectReady === 'function' ? await lock.inspectReady() : null;
    if (!ready && typeof lock.inspectReady === 'function') {
      try {
        ready = await (dependencies.waitForSupervisorReady ?? waitForSupervisorReady)(
          lock,
          dependencies.readyTimeoutMs ?? 7_000,
        );
      } catch {
        // Report the bounded starting state; the next SessionStart retries.
      }
    }
    return {
      started: false,
      reason: ready ? 'already_running' : 'starting',
      pid: existing.pid,
      ready: Boolean(ready),
    };
  }
  const daemon = dependencies.daemonTransport ?? new CodexDaemonTransport({ command });
  try {
    await daemon.inspect();
  } catch (error) {
    return { started: false, reason: error?.code ?? 'daemon_not_ready' };
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const logs = dependencies.logs ?? openSupervisorLogs(dataDir);
  const script = fileURLToPath(import.meta.url);
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  try {
    const child = spawnImpl(process.execPath, [script, 'run', '--codex', command], {
      detached: true,
      env: { ...process.env, HARK_DATA_DIR: dataDir },
      stdio: ['ignore', logs.stdout, logs.stderr],
    });
    child.unref?.();
    const ready = await (dependencies.waitForSupervisorReady ?? waitForSupervisorReady)(
      lock,
      dependencies.readyTimeoutMs ?? 7_000,
    );
    return { started: true, pid: child.pid ?? ready.pid ?? null, ready: true };
  } finally {
    logs.close();
  }
}

export async function onboardCommand(options = {}, dependencies = {}) {
  const dataDir = dependencies.dataDir ?? defaultHarkDataDir();
  const credentialsStore = dependencies.credentialsStore ?? new HarkCredentialsStore(dataDir);
  if (await credentialsStore.read()) {
    const ensured = await ensureCommand(options, { ...dependencies, dataDir, credentialsStore });
    if (ensured.started || ensured.reason === 'already_running' || ensured.reason === 'starting') {
      return { setupStarted: false, ...ensured };
    }
  }

  const onboardingDir = path.join(dataDir, 'onboarding');
  const onboardingLock = dependencies.onboardingLock ?? new SupervisorProcessLock(onboardingDir);
  const existing = await onboardingLock.inspect();
  if (existing?.alive) {
    return { setupStarted: false, reason: 'setup_in_progress', pid: existing.pid };
  }

  await mkdir(onboardingDir, { recursive: true, mode: 0o700 });
  const logs = dependencies.logs ?? openSupervisorLogs(onboardingDir);
  const script = fileURLToPath(import.meta.url);
  const args = [script, 'setup'];
  if (options.api_url) args.push('--api-url', options.api_url);
  if (options.name) args.push('--name', options.name);
  if (options.open === false) args.push('--no-open');
  if (options.codex) args.push('--codex', options.codex);
  const spawnImpl = dependencies.spawnImpl ?? spawn;
  try {
    const child = spawnImpl(process.execPath, args, {
      detached: true,
      env: { ...process.env, HARK_DATA_DIR: dataDir },
      stdio: ['ignore', logs.stdout, logs.stderr],
    });
    child.unref?.();
    return { setupStarted: true, pid: child.pid ?? null };
  } finally {
    logs.close();
  }
}

export async function doctorCommand(options = {}, dependencies = {}) {
  const requiredHookEvents = [
    { contractName: 'SessionStart', appServerName: 'sessionStart' },
    { contractName: 'PreToolUse', appServerName: 'preToolUse' },
    { contractName: 'PostToolUse', appServerName: 'postToolUse' },
    { contractName: 'UserPromptSubmit', appServerName: 'userPromptSubmit' },
  ];
  const exactToolMatcher = 'mcp__hark__hark_await';
  const pluginRoot = dependencies.pluginRoot ?? CODEX_PLUGIN_ROOT;
  const hookContract = certifiedHookContract(pluginRoot);
  const dataDir = dependencies.dataDir ?? defaultHarkDataDir();
  const checks = [];
  const check = async (id, operation, remediation) => {
    try {
      const detail = await operation();
      checks.push({ id, ok: true, ...(detail === undefined ? {} : { detail }) });
      return detail;
    } catch (error) {
      checks.push({
        id,
        ok: false,
        error: error?.code ?? error?.message ?? String(error),
        remediation,
      });
      return null;
    }
  };

  await check('platform', async () => {
    const platform = dependencies.platform ?? process.platform;
    const arch = dependencies.arch ?? process.arch;
    if (platform !== 'linux' || arch !== 'x64') throw new Error(`unsupported_platform:${platform}-${arch}`);
    return `${platform}-${arch}`;
  }, 'Use the certified Linux x64 Hark package.');
  await check('node', async () => {
    const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
    const major = Number(String(nodeVersion).split('.')[0]);
    if (!Number.isSafeInteger(major) || major < 20) throw new Error(`node_version_unsupported:${nodeVersion}`);
    return nodeVersion;
  }, 'Install Node.js 20 or newer.');

  const credentialsStore = dependencies.credentialsStore ?? new HarkCredentialsStore(dataDir);
  let credentials = null;
  await check('credential', async () => {
    const value = await credentialsStore.read();
    if (!value) throw new Error('hark_not_connected');
    credentials = value;
    return {
      installationId: value.installation.id,
      runtimeId: value.installation.runtimeId,
    };
  }, 'Approve the Hark installation in the browser.');
  const command = configuredCodexCommand(options, dependencies);
  const daemon = dependencies.daemonTransport ?? new CodexDaemonTransport({ command });
  let runtimeStatus = null;
  await check('codex_runtime', async () => {
    runtimeStatus = await (
      dependencies.verifyPinnedCodexRuntime ?? verifyPinnedCodexRuntime
    )(command);
    return runtimeStatus;
  },
    'Re-run Hark setup to restore the pinned Codex runtime.');

  let sandboxStatus = null;
  if (runtimeStatus) {
    sandboxStatus = await check('codex_sandbox', async () => (
      (dependencies.verifyCodexSandbox ?? verifyCodexSandbox)(command, {
        runProcess: dependencies.runProcess,
      })
    ), 'Install Ubuntu bubblewrap and load its scoped AppArmor profile, then re-run Hark setup.');
  } else {
    checks.push({
      id: 'codex_sandbox', ok: false, error: 'codex_runtime_unavailable',
      remediation: 'Restore the pinned Codex runtime first.',
    });
  }

  let daemonStatus = null;
  if (sandboxStatus) {
    daemonStatus = await check('codex_daemon', async () => daemon.inspect(),
      'Restart Hark setup and inspect the local Hark error log.');
  } else {
    checks.push({
      id: 'codex_daemon', ok: false, error: 'codex_sandbox_unavailable',
      remediation: 'Restore a working Codex sandbox first.',
    });
  }

  let appServer = null;
  let appServerReady = false;
  if (daemonStatus) {
    const transportFactory = dependencies.transportFactory
      ?? createCodexDaemonTransportFactory({ command });
    appServer = dependencies.appServerClient
      ?? new AppServerClient({ command, transportFactory });
    await check('app_server', async () => {
      await appServer.start();
      appServerReady = true;
      return CODEX_APP_SERVER_COMPATIBILITY.protocol;
    }, 'Restart Hark setup and inspect the local Hark error log.');
  } else {
    checks.push({
      id: 'app_server', ok: false, error: 'codex_runtime_unavailable',
      remediation: 'Restore the pinned Codex runtime first.',
    });
  }

  let clockSource = null;
  let directToolNamespace = null;
  if (appServerReady) {
    let effectiveConfigPromise = null;
    const readEffectiveConfig = () => {
      if (effectiveConfigPromise) return effectiveConfigPromise;
      effectiveConfigPromise = (async () => {
        if (typeof appServer.readConfig !== 'function') {
          throw new Error('codex_config_read_unavailable');
        }
        const result = await appServer.readConfig({
          cwd: dependencies.cwd ?? process.cwd(),
          includeLayers: false,
        });
        if (!result?.config || typeof result.config !== 'object' || Array.isArray(result.config)) {
          throw new Error('codex_effective_config_unverifiable');
        }
        return result.config;
      })();
      return effectiveConfigPromise;
    };

    await check('clock_source', async () => {
      const config = await readEffectiveConfig();
      const currentTimeConfig = config.features?.current_time_reminder;
      clockSource = currentTimeConfig && typeof currentTimeConfig === 'object'
        ? currentTimeConfig.clock_source ?? 'system'
        : 'system';
      if (clockSource !== 'system') throw new Error(`codex_clock_source_unsupported:${clockSource}`);
      return clockSource;
    }, 'Use the Codex system clock source for certified Hark wakes.');

    await check('direct_tool_namespace', async () => {
      const config = await readEffectiveConfig();
      const namespaces = directOnlyToolNamespaces(config, { requireHark: true });
      directToolNamespace = HARK_DIRECT_TOOL_NAMESPACE;
      return { namespace: directToolNamespace, namespaces };
    }, 'Re-run Hark setup so Codex exposes Hark as one direct held tool.');

    await check('hooks', async () => {
      if (typeof appServer.listHooks !== 'function') {
        throw new Error('codex_hooks_list_unavailable');
      }
      const result = await appServer.listHooks({ cwds: [dependencies.cwd ?? process.cwd()] });
      if (!Array.isArray(result?.data)) throw new Error('codex_hooks_response_unverifiable');
      const discoveryErrors = result.data.flatMap((entry) => (
        Array.isArray(entry?.errors) ? entry.errors : []
      ));
      if (discoveryErrors.length > 0) throw new Error('codex_hooks_discovery_failed');
      const entries = result.data.flatMap((entry) => entry.hooks ?? []);
      const hooks = entries.filter((entry) => entry.pluginId === 'hark@hark');
      for (const { contractName, appServerName } of requiredHookEvents) {
        const matching = hooks.filter((hook) => hook.eventName === appServerName);
        if (matching.length === 0) throw new Error(`hark_hook_missing:${contractName}`);
        if (matching.length !== 1) {
          throw new Error(`hark_hook_ambiguous:${contractName}:${matching.length}`);
        }
        const [hook] = matching;
        const expectedSourcePath = path.join(pluginRoot, 'hooks', 'hooks.json');
        if (hook.source !== 'plugin' || hook.sourcePath !== expectedSourcePath) {
          throw new Error(`hark_hook_source_invalid:${contractName}`);
        }
        if (hook.handlerType !== 'command') {
          throw new Error(`hark_hook_handler_invalid:${contractName}:${hook.handlerType ?? 'unknown'}`);
        }
        if (hook.enabled !== true) throw new Error(`hark_hook_not_enabled:${contractName}`);
        if (!['trusted', 'managed'].includes(hook.trustStatus)) {
          throw new Error(
            `hark_hook_not_trusted:${contractName}:${hook.trustStatus ?? 'unknown'}`,
          );
        }
        const expectedHook = hookContract[contractName];
        if (expectedHook.matcher === exactToolMatcher) {
          if (!Object.hasOwn(hook, 'matcher') || hook.matcher !== exactToolMatcher) {
            throw new Error(
              `hark_hook_matcher_invalid:${contractName}:`
              + (Object.hasOwn(hook, 'matcher') ? (hook.matcher ?? 'null') : 'missing'),
            );
          }
        } else if (hook.matcher != null) {
          throw new Error(`hark_hook_matcher_invalid:${contractName}:${hook.matcher}`);
        }
        if (hook.command !== expectedHook.command) {
          throw new Error(`hark_hook_command_invalid:${contractName}`);
        }
        if (hook.timeoutSec !== expectedHook.timeout) {
          throw new Error(
            `hark_hook_timeout_invalid:${contractName}:${String(hook.timeoutSec)}`,
          );
        }
      }
      if (hooks.length !== requiredHookEvents.length) {
        throw new Error(`hark_hook_surface_invalid:${hooks.length}`);
      }
      return requiredHookEvents.map(({ contractName }) => contractName).sort();
    }, 'Review, enable, and trust all four bundled Hark hooks in Codex.');

    await check('mcp', async () => {
      if (typeof appServer.listMcpServerStatus !== 'function') {
        throw new Error('codex_mcp_status_unavailable');
      }
      const result = await appServer.listMcpServerStatus();
      if (!Array.isArray(result?.data)) throw new Error('codex_mcp_status_unverifiable');
      const servers = result.data.filter((entry) => entry.name === 'hark');
      if (servers.length === 0) throw new Error('hark_mcp_missing');
      if (servers.length !== 1) throw new Error(`hark_mcp_ambiguous:${servers.length}`);
      const [server] = servers;
      const tools = Object.keys(server.tools ?? {}).sort();
      if (tools.length !== 1 || tools[0] !== 'hark_await') {
        throw new Error(`hark_mcp_tool_surface_invalid:${tools.join(',')}`);
      }
      const readFileImpl = dependencies.readFile ?? readFile;
      let manifest;
      try {
        manifest = JSON.parse(await readFileImpl(
          path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
          'utf8',
        ));
      } catch {
        throw new Error('hark_plugin_manifest_unreadable');
      }
      if (manifest?.name !== 'hark' || typeof manifest?.version !== 'string'
        || !manifest.version || manifest.mcpServers !== './.mcp.json') {
        throw new Error('hark_plugin_manifest_invalid');
      }
      if (server.serverInfo?.name !== 'hark'
        || server.serverInfo?.version !== manifest.version) {
        throw new Error(
          `hark_mcp_server_identity_invalid:${server.serverInfo?.name ?? 'unknown'}:`
          + `${server.serverInfo?.version ?? 'unknown'}`,
        );
      }
      return tools;
    }, 'Reload the installed Hark plugin in Codex.');

    await check('mcp_config', async () => {
      const config = await readEffectiveConfig();
      const expected = {
        command: 'node',
        args: ['./hark/mcp/server.mjs'],
        cwd: '.',
        enabled: true,
        required: true,
        supports_parallel_tool_calls: false,
        enabled_tools: ['hark_await'],
        default_tools_approval_mode: 'approve',
        tool_timeout_sec: 31_536_000,
      };
      const validateServer = (server, source) => {
        if (!server || typeof server !== 'object' || Array.isArray(server)) {
          throw new Error(`hark_mcp_config_unverifiable:${source}`);
        }
        const allowedFields = Object.keys(expected).sort();
        const actualFields = Object.keys(server).sort();
        if (JSON.stringify(actualFields) !== JSON.stringify(allowedFields)) {
          throw new Error(`hark_mcp_config_surface_invalid:${source}:${actualFields.join(',')}`);
        }
        for (const [field, expectedValue] of Object.entries(expected)) {
          const actualValue = server[field];
          if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
            throw new Error(
              `hark_mcp_config_drift:${field}:${JSON.stringify(actualValue) ?? 'undefined'}`,
            );
          }
        }
      };

      const readFileImpl = dependencies.readFile ?? readFile;
      const packagePath = path.join(pluginRoot, '.mcp.json');
      let packageConfig;
      try {
        packageConfig = JSON.parse(await readFileImpl(packagePath, 'utf8'));
      } catch {
        throw new Error('hark_mcp_package_unreadable');
      }
      if (!packageConfig || typeof packageConfig !== 'object' || Array.isArray(packageConfig)
        || JSON.stringify(Object.keys(packageConfig).sort()) !== JSON.stringify(['mcpServers'])) {
        throw new Error('hark_mcp_package_surface_invalid:root');
      }
      const packagedServers = packageConfig?.mcpServers;
      if (!packagedServers || typeof packagedServers !== 'object'
        || Array.isArray(packagedServers)) {
        throw new Error('hark_mcp_config_unverifiable:package');
      }
      const packagedNames = Object.keys(packagedServers).sort();
      if (JSON.stringify(packagedNames) !== JSON.stringify(['hark'])) {
        throw new Error(`hark_mcp_package_surface_invalid:${packagedNames.join(',')}`);
      }
      validateServer(packagedServers.hark, 'package_hark');

      // Codex 0.147 config/read reports user/project MCP configuration, not the
      // MCP settings injected by an installed plugin. Any same-name entry is an
      // ambiguous shadow: relative cwd and precedence differ by source layer.
      const configuredServers = config.mcp_servers;
      if (configuredServers !== undefined) {
        if (!configuredServers || typeof configuredServers !== 'object'
          || Array.isArray(configuredServers)) {
          throw new Error('hark_mcp_config_unverifiable:mcp_servers');
        }
        if (Object.hasOwn(configuredServers, 'hark')) {
          throw new Error('hark_mcp_config_shadowed:hark');
        }
      }
      return expected;
    }, 'Restore the exact held-call Hark MCP settings and reload Codex.');
  } else {
    for (const id of [
      'clock_source', 'direct_tool_namespace', 'hooks', 'mcp', 'mcp_config',
    ]) checks.push({
      id, ok: false, error: 'app_server_unavailable', remediation: 'Restore the App Server first.',
    });
  }
  if (appServer) await appServer.close().catch(() => undefined);

  await check('hark_api', async () => {
    if (!credentials) throw new Error('hark_not_connected');
    const service = dependencies.serviceClient ?? new HarkServiceClient({
      baseUrl: credentials.apiBaseUrl,
      accessToken: credentials.accessToken,
    });
    const result = await service.getInstallationStatus();
    if (
      result.installation.id !== credentials.installation.id
      || result.installation.runtimeId !== credentials.installation.runtimeId
    ) throw new Error('installation_identity_mismatch');
    return { installationId: result.installation.id };
  }, 'Reconnect Hark with the browser approval flow.');

  const processLock = dependencies.processLock ?? new SupervisorProcessLock(dataDir);
  const supervisorReady = await check('supervisor', async () => {
    const ready = await processLock.inspectReady();
    if (!ready) throw new Error('hark_supervisor_not_ready');
    if (credentials && ready.runtimeId !== credentials.installation.runtimeId) {
      throw new Error('hark_supervisor_runtime_mismatch');
    }
    return { pid: ready.pid, readyAt: ready.readyAt };
  }, 'Restart Codex once so Hark can start its local supervisor.');

  return {
    v: 'hark.codex-doctor.v2',
    ok: checks.every((entry) => entry.ok),
    connected: Boolean(credentials),
    installation: credentials ? {
      id: credentials.installation.id,
      protocol: credentials.installation.protocol,
      runtimeId: credentials.installation.runtimeId,
    } : null,
    daemon: daemonStatus,
    runtime: runtimeStatus,
    sandbox: sandboxStatus,
    clockSource,
    directToolNamespace,
    supervisor: supervisorReady,
    checks,
  };
}

function formatDoctorOutput(result) {
  return [
    `Hark Codex doctor: ${result.ok ? 'OK' : 'NOT READY'}`,
    `Codex: ${result.daemon?.appServerVersion ?? 'unavailable'}`,
    `Daemon: ${result.daemon?.backend ?? 'unavailable'}`,
    `Managed artifact: ${result.daemon?.managedCodexSha256 ?? 'unavailable'}`,
    `Code-mode host: ${result.runtime?.codeModeHostSha256 ?? 'unavailable'}`,
    `Bundled bubblewrap fallback: ${result.runtime?.bwrapPath ?? 'unavailable'}`,
    `Bundled bubblewrap SHA-256: ${result.runtime?.bwrapSha256 ?? 'unavailable'}`,
    `Sandbox execution: ${result.sandbox?.status ?? 'unavailable'}`
      + (result.sandbox?.backend ? ` (${result.sandbox.backend})` : ''),
    `Sandbox profiles: ${result.sandbox?.permissionProfiles?.join(', ') ?? 'unavailable'}`,
    `Clock source: ${result.clockSource ?? 'unavailable'}`,
    `Hark tool exposure: ${result.directToolNamespace ?? 'unavailable'}`,
    `Hark installation: ${result.connected ? 'connected' : 'not connected'}`,
    ...result.checks.filter((check) => !check.ok).map(
      (check) => `Fix ${check.id}: ${check.error}. ${check.remediation}`,
    ),
    '',
  ].join('\n');
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (['help', '--help', '-h'].includes(command)) {
    process.stdout.write(HELP);
    return;
  }
  if (command === 'connect') {
    const result = await connectCommand(options, {
      onVerification(value) {
        process.stdout.write(formatDeviceVerification(value));
      },
    });
    const ensured = await ensureCommand(options);
    process.stdout.write(result.alreadyConnected
      ? 'Hark is already connected to this Codex runtime.\n'
      : 'Hark is connected to this Codex runtime.\n');
    if (ensured.started || ensured.reason === 'already_running') {
      process.stdout.write('The Hark Codex supervisor is running.\n');
    } else {
      process.stdout.write(`Supervisor pending: ${ensured.reason}. Run hark-codex doctor.\n`);
    }
    return;
  }
  if (command === 'setup') {
    const onboardingLock = new SupervisorProcessLock(path.join(defaultHarkDataDir(), 'onboarding'));
    await onboardingLock.acquire();
    try {
      const daemon = await bootstrapDaemonCommand(options);
      const runtimeOptions = { ...options, codex: daemon.harkCodexPath };
      const result = await connectCommand(options, {
        onVerification(value) {
          process.stdout.write(formatDeviceVerification(value));
        },
      });
      const ensured = await ensureCommand(runtimeOptions);
      if (!ensured.ready) throw new Error(`supervisor_not_ready:${ensured.reason}`);
      process.stdout.write(result.alreadyConnected
        ? 'Hark was already connected; the supervisor is running.\n'
        : 'Hark is connected; the supervisor is running.\n');
    } finally {
      await onboardingLock.release();
    }
    return;
  }
  if (command === 'onboard') {
    const result = await onboardCommand(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'ensure') {
    const result = await ensureCommand(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'doctor') {
    const result = await doctorCommand(options);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : formatDoctorOutput(result));
    return;
  }
  if (command === 'run') {
    const processLock = new SupervisorProcessLock();
    await processLock.acquire();
    let runtime;
    try {
      runtime = await runCommand(options);
    } catch (error) {
      await processLock.release();
      throw error;
    }
    const { supervisor } = runtime;
    let shutdownPromise = null;
    const shutdown = (exitCode = null) => {
      if (exitCode !== null && (process.exitCode === undefined || exitCode !== 0)) {
        process.exitCode = exitCode;
      }
      if (!shutdownPromise) {
        shutdownPromise = (async () => {
          // Invalidate externally visible readiness before waiting for any
          // long-running supervisor loop to wind down.
          await processLock.release();
          await supervisor.stop();
        })();
      }
      return shutdownPromise;
    };
    let rejectFatal;
    const fatal = new Promise((_resolve, reject) => { rejectFatal = reject; });
    const onFatal = (error) => {
      const exact = error instanceof Error ? error : new Error(String(error));
      void shutdown(1).catch(() => undefined);
      rejectFatal(exact);
    };
    const onSignal = () => { void shutdown(0).catch(() => undefined); };
    supervisor.once('supervisorError', onFatal);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      supervisor.assertHealthy();
      await Promise.race([
        processLock.markReady({
          runtimeId: runtime.credentials.installation.runtimeId,
          installationId: runtime.credentials.installation.id,
          codexVersion: CODEX_APP_SERVER_COMPATIBILITY.codexVersion,
        }),
        fatal,
      ]);
      supervisor.assertHealthy();
      await Promise.race([
        new Promise((resolve) => supervisor.once('close', resolve)),
        fatal,
      ]);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      supervisor.off('supervisorError', onFatal);
      await shutdown();
    }
    return;
  }
  throw new Error(`unknown_command:${command}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`hark-codex: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}

export {
  formatDoctorOutput,
  formatDeviceVerification,
  HELP,
  main,
  openUrl,
  parseArgs,
  runProcess,
  wait,
  waitForSupervisorReady,
};
