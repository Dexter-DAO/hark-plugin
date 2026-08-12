import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  bootstrapDaemonCommand,
  connectCommand,
  createSupervisorRuntime,
  doctorCommand,
  ensureCommand,
  formatDoctorOutput,
  formatDeviceVerification,
  isCodexBubblewrapHostPolicyFailure,
  onboardCommand,
  parseArgs,
  runProcess,
  verifyCodexSandbox,
  wait,
} from '../cli/hark-codex.mjs';
import { HarkCredentialsStore } from '../lib/credentials.mjs';
import { HarkJournal } from '../lib/journal.mjs';
import { HarkApiError } from '../lib/service-client.mjs';

test('parses only the documented command surface', () => {
  assert.deepEqual(parseArgs(['connect', '--api-url', 'https://api.example', '--no-open']), {
    command: 'connect', options: { api_url: 'https://api.example', open: false },
  });
  assert.throws(() => parseArgs(['run', '--enable-remote-control']), /unknown_argument/);
});

test('formats the foreground headless approval with both exact public fields', () => {
  const output = formatDeviceVerification({
    verificationUriComplete: 'https://hark.sh/install?code=ABCD-EFGH',
    userCode: 'ABCD-EFGH',
    deviceCode: 'device-secret',
  });
  assert.equal(output, [
    'verificationUriComplete: https://hark.sh/install?code=ABCD-EFGH',
    'userCode: ABCD-EFGH',
    '',
  ].join('\n'));
  assert.equal(output.includes('device-secret'), false);
});

test('successful CLI delays remove their abort listener', async () => {
  const controller = new AbortController();
  await wait(1, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('process runner returns bounded structured failures and enforces its timeout', async () => {
  await assert.rejects(runProcess(process.execPath, [
    '-e',
    'process.stdout.write("out"); process.stderr.write("err"); process.exit(7);',
  ]), (error) => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.exitCode, 7);
    assert.equal(error.signal, null);
    assert.equal(error.stdout, 'out');
    assert.equal(error.stderr, 'err');
    return true;
  });

  await assert.rejects(runProcess(process.execPath, [
    '-e',
    'setTimeout(() => undefined, 1_000);',
  ], { timeoutMs: 20 }), (error) => {
    assert.equal(error.code, 'COMMAND_TIMED_OUT');
    assert.equal(error.exitCode, null);
    assert.equal(error.signal, 'SIGKILL');
    return true;
  });
});

test('setup verifies the pinned binary before non-updating daemon lifecycle mutations', async () => {
  const calls = [];
  const verified = [];
  const status = await bootstrapDaemonCommand({ codex: '/opt/codex-0.147.0' }, {
    verifyPinnedCodexRuntime: async (command) => {
      verified.push(command);
      return {
        path: command,
        codeModeHostPath: '/opt/codex-code-mode-host',
        codeModeHostSha256: 'host-sha256',
        bwrapPath: '/opt/codex-resources/bwrap',
        bwrapSha256: 'bwrap-sha256',
      };
    },
    runProcess: async (command, args) => {
      calls.push([command, args]);
      return args[0] === '--version'
        ? { stdout: 'codex-cli 0.147.0\n', stderr: '' }
        : { stdout: '', stderr: '' };
    },
    daemonTransport: { inspect: async () => ({ appServerVersion: '0.147.0' }) },
  });
  assert.deepEqual(verified, ['/opt/codex-0.147.0']);
  assert.deepEqual(calls, [
    ['/opt/codex-0.147.0', ['--version']],
    ['/opt/codex-0.147.0', [
      'sandbox', '--disable', 'use_legacy_landlock', '-P', ':read-only', '--', '/bin/true',
    ]],
    ['/opt/codex-0.147.0', [
      'sandbox', '--disable', 'use_legacy_landlock', '-P', ':workspace', '--', '/bin/true',
    ]],
    ['/opt/codex-0.147.0', ['app-server', 'daemon', 'enable-remote-control']],
    ['/opt/codex-0.147.0', ['app-server', 'daemon', 'start']],
  ]);
  assert.equal(status.appServerVersion, '0.147.0');
  assert.equal(status.harkCodexPath, '/opt/codex-0.147.0');
  assert.equal(status.codeModeHostPath, '/opt/codex-code-mode-host');
  assert.equal(status.codeModeHostSha256, 'host-sha256');
  assert.equal(status.bwrapPath, '/opt/codex-resources/bwrap');
  assert.equal(status.bwrapSha256, 'bwrap-sha256');
  assert.deepEqual(status.sandbox, {
    status: 'ready', backend: 'bubblewrap',
    permissionProfiles: [':read-only', ':workspace'],
  });
});

test('sandbox verification forces modern bubblewrap for both certified permission profiles', async () => {
  const calls = [];
  const result = await verifyCodexSandbox('/opt/codex-0.147.0', {
    runProcess: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(result, {
    status: 'ready', backend: 'bubblewrap',
    permissionProfiles: [':read-only', ':workspace'],
  });
  assert.deepEqual(calls.map(({ args }) => args), [
    ['sandbox', '--disable', 'use_legacy_landlock', '-P', ':read-only', '--', '/bin/true'],
    ['sandbox', '--disable', 'use_legacy_landlock', '-P', ':workspace', '--', '/bin/true'],
  ]);
  assert.equal(calls.every(({ options }) => options.timeoutMs === 5_000), true);
});

test('sandbox verification classifies only the exact bubblewrap user-namespace failures', async (t) => {
  const markers = [
    'loopback: Failed RTM_NEWADDR: Operation not permitted',
    'loopback: Failed RTM_NEWLINK: Operation not permitted',
    'setting up uid map: Permission denied',
    'No permissions to create a new namespace',
  ];
  for (const marker of markers) {
    await t.test(marker, async () => {
      const cause = Object.assign(new Error('command_failed'), {
        code: 'COMMAND_FAILED', stderr: `bwrap: ${marker}\n`, exitCode: 1,
      });
      assert.equal(isCodexBubblewrapHostPolicyFailure(cause), true);
      await assert.rejects(verifyCodexSandbox('/opt/codex-0.147.0', {
        runProcess: async () => { throw cause; },
      }), (error) => {
        assert.equal(error.code, 'CODEX_SANDBOX_USERNS_UNAVAILABLE');
        assert.equal(error.message.includes(marker), false);
        assert.match(error.message, /learn\.chatgpt\.com\/docs\/sandboxing/);
        return true;
      });
    });
  }
  const nearMiss = Object.assign(new Error('command_failed'), {
    stderr: 'bwrap: unrelated operation failed: Operation not permitted\n',
  });
  assert.equal(isCodexBubblewrapHostPolicyFailure(nearMiss), false);
  await assert.rejects(verifyCodexSandbox('/opt/codex-0.147.0', {
    runProcess: async () => { throw nearMiss; },
  }), (error) => error?.code === 'CODEX_SANDBOX_UNAVAILABLE');
});

test('setup performs no daemon mutation when functional sandbox verification fails', async () => {
  const calls = [];
  await assert.rejects(bootstrapDaemonCommand({ codex: '/opt/codex-0.147.0' }, {
    verifyPinnedCodexRuntime: async () => ({
      path: '/opt/codex-0.147.0',
      codeModeHostPath: '/opt/codex-code-mode-host',
      codeModeHostSha256: 'host-sha256',
      bwrapPath: '/opt/codex-resources/bwrap',
      bwrapSha256: 'bwrap-sha256',
    }),
    runProcess: async (command, args) => {
      calls.push([command, args]);
      if (args[0] === '--version') return { stdout: 'codex-cli 0.147.0\n', stderr: '' };
      const error = Object.assign(new Error('command_failed'), {
        code: 'COMMAND_FAILED',
        stderr: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n',
      });
      throw error;
    },
    daemonTransport: {
      async inspect() {
        calls.push(['daemon.inspect']);
        return {};
      },
    },
  }), (error) => error?.code === 'CODEX_SANDBOX_USERNS_UNAVAILABLE');
  assert.deepEqual(calls, [
    ['/opt/codex-0.147.0', ['--version']],
    ['/opt/codex-0.147.0', [
      'sandbox', '--disable', 'use_legacy_landlock', '-P', ':read-only', '--', '/bin/true',
    ]],
  ]);
});

test('setup performs no Codex or daemon command when the sibling host fails verification', async () => {
  const calls = [];
  await assert.rejects(bootstrapDaemonCommand({ codex: '/opt/codex-0.147.0' }, {
    verifyPinnedCodexRuntime: async () => {
      const error = new Error('Pinned Codex code-mode host is missing');
      error.code = 'CODE_MODE_HOST_MISSING';
      throw error;
    },
    runProcess: async (...args) => {
      calls.push(args);
      return { stdout: '', stderr: '' };
    },
    daemonTransport: {
      async inspect() {
        calls.push(['daemon.inspect']);
        return {};
      },
    },
  }), (error) => error?.code === 'CODE_MODE_HOST_MISSING');
  assert.deepEqual(calls, []);
});

test('setup refuses a version mismatch before daemon mutation', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapDaemonCommand({ codex: '/opt/hark-codex/codex' }, {
      verifyPinnedCodexRuntime: async (command) => ({
        path: command,
        codeModeHostPath: '/opt/hark-codex/codex-code-mode-host',
        codeModeHostSha256: 'host-sha256',
        bwrapPath: '/opt/hark-codex/codex-resources/bwrap',
        bwrapSha256: 'bwrap-sha256',
      }),
      runProcess: async (command, args) => {
        calls.push([command, args]);
        return { stdout: 'codex-cli 0.146.1\n', stderr: '' };
      },
    }),
    /codex_version_gate_failed:0\.146\.1:0\.147\.0/,
  );
  assert.deepEqual(calls, [['/opt/hark-codex/codex', ['--version']]]);
});

test('setup installs and reuses the managed pinned runtime without launching an updater', async () => {
  const calls = [];
  const status = await bootstrapDaemonCommand({}, {
    codexHome: '/tmp/hark-codex-home',
    installPinnedCodexRuntime: async ({ codexHome }) => {
      assert.equal(codexHome, '/tmp/hark-codex-home');
      return {
        path: '/tmp/hark-codex-home/packages/standalone/current/codex',
        codeModeHostPath: '/tmp/hark-codex-home/packages/standalone/current/codex-code-mode-host',
      };
    },
    verifyPinnedCodexRuntime: async (command) => ({
      path: command,
      codeModeHostPath: '/tmp/hark-codex-home/packages/standalone/current/codex-code-mode-host',
      codeModeHostSha256: 'host-sha256',
      bwrapPath: '/tmp/hark-codex-home/packages/standalone/current/codex-resources/bwrap',
      bwrapSha256: 'bwrap-sha256',
    }),
    runProcess: async (command, args) => {
      calls.push([command, args]);
      return args[0] === '--version'
        ? { stdout: 'codex-cli 0.147.0\n', stderr: '' }
        : { stdout: '', stderr: '' };
    },
    daemonTransport: {
      async inspect() {
        return {
          appServerVersion: '0.147.0',
          managedCodexPath: '/tmp/hark-codex-home/packages/standalone/current/codex',
        };
      },
    },
  });
  assert.equal(status.harkCodexPath, '/tmp/hark-codex-home/packages/standalone/current/codex');
  assert.equal(
    status.bwrapPath,
    '/tmp/hark-codex-home/packages/standalone/current/codex-resources/bwrap',
  );
  assert.equal(status.bwrapSha256, 'bwrap-sha256');
  assert.equal(calls.flatMap(([, args]) => args).includes('bootstrap'), false);
});

test('connects through one bounded device approval without exposing the token', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-cli-'));
  const journal = new HarkJournal(directory);
  const credentialsStore = new HarkCredentialsStore(directory);
  let exchanges = 0;
  const serviceClient = {
    baseUrl: 'https://api.example.test',
    async createDeviceCode(input) {
      assert.equal(input.runtimeId.startsWith('hkr_'), true);
      return {
        v: 'hark.installation-device-code-result.v2',
        deviceCode: 'device-secret', userCode: 'ABCD-EFGH',
        verificationUri: 'https://hark.sh/install',
        verificationUriComplete: 'https://hark.sh/install?code=ABCD-EFGH',
        expiresIn: 600, interval: 1,
      };
    },
    async exchangeDeviceCode() {
      exchanges += 1;
      if (exchanges === 1) throw new HarkApiError(428, 'authorization_pending');
      const runtimeId = (await journal.read()).runtimeId;
      return {
        v: 'hark.installation-token.v2', accessToken: 'hki_secret',
        installation: { id: 'installation-1', protocol: 'codex', runtimeId },
      };
    },
  };
  let verification;
  const result = await connectCommand({ open: false }, {
    journal,
    credentialsStore,
    serviceClient,
    wait: async () => undefined,
    onVerification: (value) => { verification = value; },
  });
  assert.equal(result.alreadyConnected, false);
  assert.equal(verification.userCode, 'ABCD-EFGH');
  assert.equal(JSON.stringify(verification).includes('device-secret'), false);
  assert.equal((await credentialsStore.read()).accessToken, 'hki_secret');

  const again = await connectCommand({ open: false }, { journal, credentialsStore, serviceClient });
  assert.equal(again.alreadyConnected, true);
  assert.equal(exchanges, 2);
});

test('constructs the supervisor only when credentials match the private runtime identity', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-cli-'));
  const journal = new HarkJournal(directory);
  const credentialsStore = new HarkCredentialsStore(directory);
  await journal.ensureRuntimeId(() => 'runtime-1');
  await credentialsStore.save({
    apiBaseUrl: 'https://api.example.test', accessToken: 'hki_secret',
    installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
  });
  const appServerClient = { on() {}, off() {} };
  const serviceClient = {};
  const runtime = await createSupervisorRuntime({}, {
    journal,
    credentialsStore,
    appServerClient,
    serviceClient,
    verifyPinnedCodexRuntime: async () => ({ codeModeHostSha256: 'host-sha256' }),
  });
  assert.equal(runtime.credentials.installation.runtimeId, 'runtime-1');
  assert.equal(runtime.supervisor.credentialsStore, credentialsStore);

  await journal.update((state) => { state.runtimeId = 'runtime-2'; return state; });
  await assert.rejects(
    createSupervisorRuntime({}, {
      journal,
      credentialsStore,
      appServerClient,
      serviceClient,
      verifyPinnedCodexRuntime: async () => ({ codeModeHostSha256: 'host-sha256' }),
    }),
    /installation_runtime_mismatch/,
  );
});

test('refuses supervisor construction when the pinned runtime tuple is incomplete', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-cli-'));
  const journal = new HarkJournal(directory);
  const credentialsStore = new HarkCredentialsStore(directory);
  await journal.ensureRuntimeId(() => 'runtime-1');
  await credentialsStore.save({
    apiBaseUrl: 'https://api.example.test', accessToken: 'hki_secret',
    installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
  });
  await assert.rejects(createSupervisorRuntime({}, {
    journal,
    credentialsStore,
    verifyPinnedCodexRuntime: async () => {
      const error = new Error('Pinned Codex code-mode host is missing');
      error.code = 'CODE_MODE_HOST_MISSING';
      throw error;
    },
  }), (error) => error?.code === 'CODE_MODE_HOST_MISSING');
});

test('ensure is a no-op before connection and starts one detached supervisor when ready', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-cli-'));
  const credentialsStore = new HarkCredentialsStore(directory);
  assert.deepEqual(await ensureCommand({}, { dataDir: directory, credentialsStore }), {
    started: false, reason: 'not_connected',
  });
  await credentialsStore.save({
    apiBaseUrl: 'https://api.example.test', accessToken: 'hki_secret',
    installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
  });
  const calls = [];
  let logsClosed = false;
  const result = await ensureCommand({ codex: '/opt/codex-0.147.0' }, {
    dataDir: directory,
    credentialsStore,
    verifyPinnedCodexRuntime: async () => ({ codeModeHostSha256: 'host-sha256' }),
    processLock: { inspect: async () => null },
    daemonTransport: { inspect: async () => ({ appServerVersion: '0.147.0' }) },
    waitForSupervisorReady: async () => ({ pid: 1234 }),
    logs: { stdout: 7, stderr: 8, close: () => { logsClosed = true; } },
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { pid: 1234, unref() {} };
    },
  });
  assert.deepEqual(result, { started: true, pid: 1234, ready: true });
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args.slice(-3), ['run', '--codex', '/opt/codex-0.147.0']);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.HARK_DATA_DIR, directory);
  assert.equal(logsClosed, true);
});

test('ensure checks the full runtime tuple before accepting an existing supervisor', async () => {
  const credentialsStore = {
    async read() {
      return {
        apiBaseUrl: 'https://api.example.test', accessToken: 'hki_secret',
        installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
      };
    },
  };
  let lockInspections = 0;
  const result = await ensureCommand({ codex: '/opt/codex-0.147.0' }, {
    credentialsStore,
    verifyPinnedCodexRuntime: async () => {
      const error = new Error('Pinned Codex code-mode host is missing');
      error.code = 'CODE_MODE_HOST_MISSING';
      throw error;
    },
    processLock: {
      async inspect() {
        lockInspections += 1;
        return { alive: true, pid: 1234 };
      },
    },
  });
  assert.deepEqual(result, { started: false, reason: 'CODE_MODE_HOST_MISSING' });
  assert.equal(lockInspections, 0);
});

test('onboard dispatches the detached setup repair for an already-connected incomplete runtime', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-cli-'));
  const credentialsStore = new HarkCredentialsStore(directory);
  await credentialsStore.save({
    apiBaseUrl: 'https://api.example.test', accessToken: 'hki_secret',
    installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
  });
  const spawned = [];
  let logsClosed = false;
  const result = await onboardCommand({}, {
    dataDir: directory,
    credentialsStore,
    verifyPinnedCodexRuntime: async () => {
      const error = new Error('Pinned Codex code-mode host is missing');
      error.code = 'CODE_MODE_HOST_MISSING';
      throw error;
    },
    onboardingLock: { inspect: async () => null },
    logs: { stdout: 7, stderr: 8, close: () => { logsClosed = true; } },
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return { pid: 4321, unref() {} };
    },
  });
  assert.deepEqual(result, { setupStarted: true, pid: 4321 });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, process.execPath);
  assert.equal(spawned[0].args.at(-1), 'setup');
  assert.equal(spawned[0].options.detached, true);
  assert.equal(logsClosed, true);
});

const CERTIFIED_MCP_CONFIG = Object.freeze({
  command: 'node',
  args: ['./hark/mcp/server.mjs'],
  cwd: '.',
  enabled: true,
  required: true,
  supports_parallel_tool_calls: false,
  enabled_tools: ['hark_await'],
  default_tools_approval_mode: 'approve',
  tool_timeout_sec: 31_536_000,
});

const TEST_PLUGIN_ROOT = '/opt/hark-plugin';

const APP_SERVER_HOOK_EVENTS = Object.freeze({
  SessionStart: 'sessionStart',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
  UserPromptSubmit: 'userPromptSubmit',
});

const HOOK_CONTRACT = Object.freeze({
  SessionStart: {
    command: `node "${TEST_PLUGIN_ROOT}/hark/cli/hark-codex.mjs" onboard --json`, timeout: 10,
  },
  PreToolUse: {
    command: `node "${TEST_PLUGIN_ROOT}/hark/hooks/ingress.mjs"`, timeout: 10,
  },
  PostToolUse: {
    command: `node "${TEST_PLUGIN_ROOT}/hark/hooks/ingress.mjs"`, timeout: 40,
  },
  UserPromptSubmit: {
    command: `node "${TEST_PLUGIN_ROOT}/hark/hooks/prompt-guard.mjs"`, timeout: 5,
  },
});

function certifiedHooks() {
  return ['SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit'].map(
    (contractName) => ({
      pluginId: 'hark@hark',
      eventName: APP_SERVER_HOOK_EVENTS[contractName],
      handlerType: 'command',
      source: 'plugin',
      sourcePath: path.join(TEST_PLUGIN_ROOT, 'hooks', 'hooks.json'),
      enabled: true,
      trustStatus: 'trusted',
      command: HOOK_CONTRACT[contractName].command,
      timeoutSec: HOOK_CONTRACT[contractName].timeout,
      matcher: ['PreToolUse', 'PostToolUse'].includes(contractName)
        ? 'mcp__hark__hark_await'
        : null,
    }),
  );
}

function doctorFixture(overrides = {}) {
  const state = { closed: false, daemonInspections: 0 };
  const credentials = {
    apiBaseUrl: 'https://api.example.test',
    accessToken: 'hki_secret',
    installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
  };
  const daemon = {
    status: 'running',
    backend: 'pid',
    appServerVersion: '0.147.0',
    managedCodexSha256: 'cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40',
  };
  const runtime = {
    status: 'already_installed',
    path: '/opt/codex-0.147.0',
    version: '0.147.0',
    sha256: daemon.managedCodexSha256,
    codeModeHostPath: '/opt/codex-code-mode-host',
    codeModeHostSha256: '00ecf5d040865b97884c488883abd342581c2a432debe7a54e4646bceee3d2d6',
    bwrapPath: '/opt/codex-resources/bwrap',
    bwrapSha256: '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c',
  };
  const config = overrides.config ?? {
    features: {
      current_time_reminder: { clock_source: overrides.clockSource ?? 'system' },
    },
    mcp_servers: {},
  };
  const appServerClient = {
    async start() {},
    async listHooks() {
      return {
        data: [{
          hooks: overrides.hooks ?? certifiedHooks(),
          errors: overrides.hookErrors ?? [],
          warnings: [],
        }],
      };
    },
    async listMcpServerStatus() {
      return {
        data: [{
          name: 'hark',
          serverInfo: overrides.mcpServerInfo ?? { name: 'hark', version: '0.1.5' },
          tools: overrides.mcpTools ?? { hark_await: {} },
        }],
      };
    },
    async close() { state.closed = true; },
  };
  if (overrides.readConfig !== false) {
    appServerClient.readConfig = async () => ({ config });
  }
  return {
    state,
    daemon,
    runtime,
    dependencies: {
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '22.0.0',
      cwd: '/workspace/hark',
      pluginRoot: TEST_PLUGIN_ROOT,
      credentialsStore: { read: async () => credentials },
      verifyPinnedCodexRuntime: overrides.verifyPinnedCodexRuntime
        ?? (async () => runtime),
      verifyCodexSandbox: overrides.verifyCodexSandbox
        ?? (async () => ({
          status: 'ready', backend: 'bubblewrap',
          permissionProfiles: [':read-only', ':workspace'],
        })),
      daemonTransport: {
        inspect: async () => {
          state.daemonInspections += 1;
          return daemon;
        },
      },
      appServerClient,
      serviceClient: {
        async getInstallationStatus() {
          return {
            installation: {
              id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1',
            },
          };
        },
      },
      processLock: {
        async inspectReady() {
          return { pid: 1234, readyAt: '2026-08-07T12:00:00.000Z', runtimeId: 'runtime-1' };
        },
      },
      readFile: async (file, encoding) => {
        assert.equal(encoding, 'utf8');
        if (file === path.join(TEST_PLUGIN_ROOT, '.codex-plugin', 'plugin.json')) {
          return overrides.pluginManifestSource ?? JSON.stringify({
            name: 'hark', version: '0.1.5', mcpServers: './.mcp.json',
          });
        }
        if (file === path.join(TEST_PLUGIN_ROOT, '.mcp.json')) {
          return overrides.mcpPackageSource ?? JSON.stringify({
            mcpServers: { hark: CERTIFIED_MCP_CONFIG },
          });
        }
        throw new Error(`unexpected_read:${file}`);
      },
    },
  };
}

test('doctor certifies the exact held-call hooks and effective MCP config', async () => {
  const fixture = doctorFixture();
  const result = await doctorCommand({}, fixture.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.clockSource, 'system');
  assert.equal(result.daemon.managedCodexSha256, fixture.daemon.managedCodexSha256);
  assert.deepEqual(result.runtime, fixture.runtime);
  assert.deepEqual(result.sandbox, {
    status: 'ready', backend: 'bubblewrap',
    permissionProfiles: [':read-only', ':workspace'],
  });
  assert.equal(result.checks.length, 13);
  assert.deepEqual(result.checks.find((check) => check.id === 'hooks').detail, [
    'PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit',
  ]);
  assert.deepEqual(
    result.checks.find((check) => check.id === 'mcp_config').detail,
    CERTIFIED_MCP_CONFIG,
  );
  assert.equal(JSON.stringify(result).includes('hki_secret'), false);
  assert.equal(fixture.state.closed, true);
});

test('plain doctor output distinguishes the bundled fallback from functional sandbox proof', () => {
  const fixture = doctorFixture();
  const output = formatDoctorOutput({
    ok: true,
    daemon: fixture.daemon,
    runtime: fixture.runtime,
    sandbox: {
      status: 'ready', backend: 'bubblewrap',
      permissionProfiles: [':read-only', ':workspace'],
    },
    clockSource: 'system',
    connected: true,
    checks: [],
  });
  assert.equal(output.includes(`Bundled bubblewrap fallback: ${fixture.runtime.bwrapPath}\n`), true);
  assert.equal(output.includes(
    `Bundled bubblewrap SHA-256: ${fixture.runtime.bwrapSha256}\n`,
  ), true);
  assert.equal(output.includes('Sandbox execution: ready (bubblewrap)\n'), true);
  assert.equal(output.includes('Sandbox profiles: :read-only, :workspace\n'), true);
  assert.equal(output.endsWith('\n'), true);
});

test('doctor fails before App Server work when the code-mode host is unavailable', async () => {
  const fixture = doctorFixture({
    verifyPinnedCodexRuntime: async () => {
      const error = new Error('Pinned Codex code-mode host is missing');
      error.code = 'CODE_MODE_HOST_MISSING';
      throw error;
    },
  });
  const result = await doctorCommand({}, fixture.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.runtime, null);
  assert.equal(
    result.checks.find((check) => check.id === 'codex_runtime').error,
    'CODE_MODE_HOST_MISSING',
  );
  assert.equal(
    result.checks.find((check) => check.id === 'app_server').error,
    'codex_runtime_unavailable',
  );
  assert.equal(fixture.state.closed, false);
});

test('doctor fails before App Server work when bubblewrap is unavailable', async () => {
  const fixture = doctorFixture({
    verifyPinnedCodexRuntime: async () => {
      const error = new Error('Pinned Codex bubblewrap helper is missing');
      error.code = 'BWRAP_MISSING';
      throw error;
    },
  });
  const result = await doctorCommand({}, fixture.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.runtime, null);
  assert.equal(
    result.checks.find((check) => check.id === 'codex_runtime').error,
    'BWRAP_MISSING',
  );
  assert.equal(
    result.checks.find((check) => check.id === 'app_server').error,
    'codex_runtime_unavailable',
  );
  assert.equal(fixture.state.closed, false);
});

test('doctor fails closed before daemon or App Server work when sandbox execution is blocked', async () => {
  const fixture = doctorFixture({
    verifyCodexSandbox: async () => {
      const error = new Error('Codex bubblewrap is blocked by the host user-namespace policy');
      error.code = 'CODEX_SANDBOX_USERNS_UNAVAILABLE';
      throw error;
    },
  });
  const result = await doctorCommand({}, fixture.dependencies);
  assert.equal(result.ok, false);
  assert.equal(result.sandbox, null);
  assert.equal(
    result.checks.find((check) => check.id === 'codex_sandbox').error,
    'CODEX_SANDBOX_USERNS_UNAVAILABLE',
  );
  assert.equal(
    result.checks.find((check) => check.id === 'codex_daemon').error,
    'codex_sandbox_unavailable',
  );
  assert.equal(
    result.checks.find((check) => check.id === 'app_server').error,
    'codex_runtime_unavailable',
  );
  assert.equal(fixture.state.daemonInspections, 0);
  assert.equal(fixture.state.closed, false);
});

test('doctor refuses external current-time delivery before wake execution', async () => {
  const fixture = doctorFixture({ clockSource: 'external' });
  const result = await doctorCommand({}, fixture.dependencies);
  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find((check) => check.id === 'clock_source').error,
    'codex_clock_source_unsupported:external',
  );
});

test('doctor fails closed on held-call hook drift', async (t) => {
  const scenarios = [
    {
      name: 'missing PreToolUse',
      hooks: certifiedHooks().filter(
        (hook) => hook.eventName !== APP_SERVER_HOOK_EVENTS.PreToolUse,
      ),
      error: 'hark_hook_missing:PreToolUse',
    },
    {
      name: 'disabled PostToolUse',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === APP_SERVER_HOOK_EVENTS.PostToolUse
          ? { ...hook, enabled: false }
          : hook
      )),
      error: 'hark_hook_not_enabled:PostToolUse',
    },
    {
      name: 'untrusted SessionStart',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === APP_SERVER_HOOK_EVENTS.SessionStart
          ? { ...hook, trustStatus: 'untrusted' }
          : hook
      )),
      error: 'hark_hook_not_trusted:SessionStart:untrusted',
    },
    {
      name: 'broad PreToolUse matcher',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === APP_SERVER_HOOK_EVENTS.PreToolUse
          ? { ...hook, matcher: 'mcp__hark__.*' }
          : hook
      )),
      error: 'hark_hook_matcher_invalid:PreToolUse:mcp__hark__.*',
    },
    {
      name: 'missing PostToolUse matcher',
      hooks: certifiedHooks().map((hook) => {
        if (hook.eventName !== APP_SERVER_HOOK_EVENTS.PostToolUse) return hook;
        const { matcher: _matcher, ...withoutMatcher } = hook;
        return withoutMatcher;
      }),
      error: 'hark_hook_matcher_invalid:PostToolUse:missing',
    },
    {
      name: 'wrong SessionStart source',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === APP_SERVER_HOOK_EVENTS.SessionStart
          ? { ...hook, sourcePath: '/tmp/hooks.json' }
          : hook
      )),
      error: 'hark_hook_source_invalid:SessionStart',
    },
    {
      name: 'wrong SessionStart command',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === APP_SERVER_HOOK_EVENTS.SessionStart
          ? { ...hook, command: 'node other.mjs' }
          : hook
      )),
      error: 'hark_hook_command_invalid:SessionStart',
    },
    {
      name: 'wrong UserPromptSubmit timeout',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === APP_SERVER_HOOK_EVENTS.UserPromptSubmit
          ? { ...hook, timeoutSec: 6 }
          : hook
      )),
      error: 'hark_hook_timeout_invalid:UserPromptSubmit:6',
    },
    {
      name: 'duplicate PostToolUse',
      hooks: [...certifiedHooks(), certifiedHooks().find(
        (hook) => hook.eventName === APP_SERVER_HOOK_EVENTS.PostToolUse,
      )],
      error: 'hark_hook_ambiguous:PostToolUse:2',
    },
    {
      name: 'unexpected fifth Hark hook',
      hooks: [...certifiedHooks(), {
        pluginId: 'hark@hark', eventName: 'stop', handlerType: 'command', enabled: true,
        source: 'plugin', sourcePath: path.join(TEST_PLUGIN_ROOT, 'hooks', 'hooks.json'),
        trustStatus: 'trusted', command: 'true', timeoutSec: 1, matcher: null,
      }],
      error: 'hark_hook_surface_invalid:5',
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = doctorFixture({ hooks: scenario.hooks });
      const result = await doctorCommand({}, fixture.dependencies);
      assert.equal(result.ok, false);
      assert.equal(result.checks.find((check) => check.id === 'hooks').error, scenario.error);
    });
  }
});

test('doctor fails closed on shadowed or unverifiable Hark MCP config', async (t) => {
  const withMcp = (patch) => ({
    features: { current_time_reminder: { clock_source: 'system' } },
    mcp_servers: { hark: { ...structuredClone(CERTIFIED_MCP_CONFIG), ...patch } },
  });
  const scenarios = [
    { name: 'required false', config: withMcp({ required: false }), field: 'required' },
    {
      name: 'parallel calls enabled',
      config: withMcp({ supports_parallel_tool_calls: true }),
      field: 'supports_parallel_tool_calls',
    },
    {
      name: 'MCP command drift',
      config: withMcp({ command: 'npx' }),
      field: 'command',
    },
    {
      name: 'MCP args drift',
      config: withMcp({ args: ['./other/server.mjs'] }),
      field: 'args',
    },
    {
      name: 'MCP cwd drift',
      config: withMcp({ cwd: '/tmp' }),
      field: 'cwd',
    },
    {
      name: 'MCP disabled',
      config: withMcp({ enabled: false }),
      field: 'enabled',
    },
    {
      name: 'tool allow-list expanded',
      config: withMcp({ enabled_tools: ['hark_await', 'other'] }),
      field: 'enabled_tools',
    },
    {
      name: 'approval prompts enabled',
      config: withMcp({ default_tools_approval_mode: 'prompt' }),
      field: 'default_tools_approval_mode',
    },
    {
      name: 'held call timeout shortened',
      config: withMcp({ tool_timeout_sec: 60 }),
      field: 'tool_timeout_sec',
    },
    {
      name: 'per-tool approval overrides default',
      config: withMcp({ tools: { hark_await: { approval_mode: 'prompt' } } }),
      field: 'hark_await_approval_mode',
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = doctorFixture({ config: scenario.config });
      const result = await doctorCommand({}, fixture.dependencies);
      assert.equal(result.ok, false);
      assert.equal(
        result.checks.find((check) => check.id === 'mcp_config').error,
        'hark_mcp_config_shadowed:hark',
      );
    });
  }

  await t.test('config/read unavailable', async () => {
    const fixture = doctorFixture({ readConfig: false });
    const result = await doctorCommand({}, fixture.dependencies);
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.id === 'mcp_config').error,
      'codex_config_read_unavailable',
    );
  });

  await t.test('plugin-injected Hark server may be absent from config/read', async () => {
    const fixture = doctorFixture({
      config: {
        features: { current_time_reminder: { clock_source: 'system' } },
        mcp_servers: {},
      },
    });
    const result = await doctorCommand({}, fixture.dependencies);
    assert.equal(result.checks.find((check) => check.id === 'mcp_config').ok, true);
  });

  await t.test('packaged Hark MCP server is required', async () => {
    const fixture = doctorFixture({
      mcpPackageSource: JSON.stringify({ mcpServers: {} }),
    });
    const result = await doctorCommand({}, fixture.dependencies);
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.id === 'mcp_config').error,
      'hark_mcp_package_surface_invalid:',
    );
  });

  await t.test('packaged Hark MCP surface rejects extra execution fields', async () => {
    const fixture = doctorFixture({
      mcpPackageSource: JSON.stringify({
        mcpServers: {
          hark: { ...CERTIFIED_MCP_CONFIG, env: { HARK_DATA_DIR: '/tmp/other' } },
        },
      }),
    });
    const result = await doctorCommand({}, fixture.dependencies);
    assert.equal(result.ok, false);
    assert.match(
      result.checks.find((check) => check.id === 'mcp_config').error,
      /^hark_mcp_config_surface_invalid:package_hark:/,
    );
  });

  await t.test('packaged Hark MCP settings reject field drift', async () => {
    const fixture = doctorFixture({
      mcpPackageSource: JSON.stringify({
        mcpServers: { hark: { ...CERTIFIED_MCP_CONFIG, required: false } },
      }),
    });
    const result = await doctorCommand({}, fixture.dependencies);
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.id === 'mcp_config').error,
      'hark_mcp_config_drift:required:false',
    );
  });

  await t.test('runtime exposes an extra MCP tool', async () => {
    const fixture = doctorFixture({ mcpTools: { hark_await: {}, extra: {} } });
    const result = await doctorCommand({}, fixture.dependencies);
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.id === 'mcp').error,
      'hark_mcp_tool_surface_invalid:extra,hark_await',
    );
  });

  await t.test('runtime MCP identity must match the installed plugin version', async () => {
    const fixture = doctorFixture({ mcpServerInfo: { name: 'hark', version: '0.1.0' } });
    const result = await doctorCommand({}, fixture.dependencies);
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.id === 'mcp').error,
      'hark_mcp_server_identity_invalid:hark:0.1.0',
    );
  });

  await t.test('manifest must bind Codex to the exact MCP file doctor validates', async () => {
    const fixture = doctorFixture({
      pluginManifestSource: JSON.stringify({
        name: 'hark', version: '0.1.5', mcpServers: './other.mcp.json',
      }),
    });
    const result = await doctorCommand({}, fixture.dependencies);
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.id === 'mcp').error,
      'hark_plugin_manifest_invalid',
    );
  });
});
