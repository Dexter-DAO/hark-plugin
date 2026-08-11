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
  formatDeviceVerification,
  parseArgs,
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

test('setup verifies the pinned binary before non-updating daemon lifecycle mutations', async () => {
  const calls = [];
  const verified = [];
  const status = await bootstrapDaemonCommand({ codex: '/opt/codex-0.147.0' }, {
    verifyFileSha256: async (...args) => { verified.push(args); },
    runProcess: async (command, args) => {
      calls.push([command, args]);
      return args[0] === '--version'
        ? { stdout: 'codex-cli 0.147.0\n', stderr: '' }
        : { stdout: '', stderr: '' };
    },
    daemonTransport: { inspect: async () => ({ appServerVersion: '0.147.0' }) },
  });
  assert.equal(verified[0][0], '/opt/codex-0.147.0');
  assert.deepEqual(calls, [
    ['/opt/codex-0.147.0', ['--version']],
    ['/opt/codex-0.147.0', ['app-server', 'daemon', 'enable-remote-control']],
    ['/opt/codex-0.147.0', ['app-server', 'daemon', 'start']],
  ]);
  assert.equal(status.appServerVersion, '0.147.0');
  assert.equal(status.harkCodexPath, '/opt/codex-0.147.0');
});

test('setup refuses a version mismatch before daemon mutation', async () => {
  const calls = [];
  await assert.rejects(
    bootstrapDaemonCommand({ codex: '/usr/bin/codex' }, {
      verifyFileSha256: async () => undefined,
      runProcess: async (command, args) => {
        calls.push([command, args]);
        return { stdout: 'codex-cli 0.146.1\n', stderr: '' };
      },
    }),
    /codex_version_gate_failed:0\.146\.1:0\.147\.0/,
  );
  assert.deepEqual(calls, [['/usr/bin/codex', ['--version']]]);
});

test('setup installs and reuses the managed pinned runtime without launching an updater', async () => {
  const calls = [];
  const status = await bootstrapDaemonCommand({}, {
    codexHome: '/tmp/hark-codex-home',
    installPinnedCodexRuntime: async ({ codexHome }) => {
      assert.equal(codexHome, '/tmp/hark-codex-home');
      return { path: '/tmp/hark-codex-home/packages/standalone/current/codex' };
    },
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
    journal, credentialsStore, appServerClient, serviceClient,
  });
  assert.equal(runtime.credentials.installation.runtimeId, 'runtime-1');
  assert.equal(runtime.supervisor.credentialsStore, credentialsStore);

  await journal.update((state) => { state.runtimeId = 'runtime-2'; return state; });
  await assert.rejects(
    createSupervisorRuntime({}, { journal, credentialsStore, appServerClient, serviceClient }),
    /installation_runtime_mismatch/,
  );
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
    (eventName) => ({
      pluginId: 'hark@hark',
      eventName,
      enabled: true,
      trustStatus: 'trusted',
      command: HOOK_CONTRACT[eventName].command,
      timeout: HOOK_CONTRACT[eventName].timeout,
      matcher: ['PreToolUse', 'PostToolUse'].includes(eventName)
        ? 'mcp__hark__hark_await'
        : null,
    }),
  );
}

function doctorFixture(overrides = {}) {
  const state = { closed: false };
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
  const config = overrides.config ?? {
    features: {
      current_time_reminder: { clock_source: overrides.clockSource ?? 'system' },
    },
    mcp_servers: { hark: structuredClone(CERTIFIED_MCP_CONFIG) },
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
        data: [{ name: 'hark', tools: overrides.mcpTools ?? { hark_await: {} } }],
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
    dependencies: {
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '22.0.0',
      cwd: '/workspace/hark',
      pluginRoot: TEST_PLUGIN_ROOT,
      credentialsStore: { read: async () => credentials },
      daemonTransport: { inspect: async () => daemon },
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
    },
  };
}

test('doctor certifies the exact held-call hooks and effective MCP config', async () => {
  const fixture = doctorFixture();
  const result = await doctorCommand({}, fixture.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.clockSource, 'system');
  assert.equal(result.daemon.managedCodexSha256, fixture.daemon.managedCodexSha256);
  assert.equal(result.checks.length, 11);
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
      hooks: certifiedHooks().filter((hook) => hook.eventName !== 'PreToolUse'),
      error: 'hark_hook_missing:PreToolUse',
    },
    {
      name: 'disabled PostToolUse',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === 'PostToolUse' ? { ...hook, enabled: false } : hook
      )),
      error: 'hark_hook_not_enabled:PostToolUse',
    },
    {
      name: 'untrusted SessionStart',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === 'SessionStart' ? { ...hook, trustStatus: 'untrusted' } : hook
      )),
      error: 'hark_hook_not_trusted:SessionStart:untrusted',
    },
    {
      name: 'broad PreToolUse matcher',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === 'PreToolUse' ? { ...hook, matcher: 'mcp__hark__.*' } : hook
      )),
      error: 'hark_hook_matcher_invalid:PreToolUse:mcp__hark__.*',
    },
    {
      name: 'missing PostToolUse matcher',
      hooks: certifiedHooks().map((hook) => {
        if (hook.eventName !== 'PostToolUse') return hook;
        const { matcher: _matcher, ...withoutMatcher } = hook;
        return withoutMatcher;
      }),
      error: 'hark_hook_matcher_invalid:PostToolUse:missing',
    },
    {
      name: 'wrong SessionStart command',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === 'SessionStart' ? { ...hook, command: 'node other.mjs' } : hook
      )),
      error: 'hark_hook_command_invalid:SessionStart',
    },
    {
      name: 'wrong UserPromptSubmit timeout',
      hooks: certifiedHooks().map((hook) => (
        hook.eventName === 'UserPromptSubmit' ? { ...hook, timeout: 6 } : hook
      )),
      error: 'hark_hook_timeout_invalid:UserPromptSubmit:6',
    },
    {
      name: 'duplicate PostToolUse',
      hooks: [...certifiedHooks(), certifiedHooks().find(
        (hook) => hook.eventName === 'PostToolUse',
      )],
      error: 'hark_hook_ambiguous:PostToolUse:2',
    },
    {
      name: 'unexpected fifth Hark hook',
      hooks: [...certifiedHooks(), {
        pluginId: 'hark@hark', eventName: 'Stop', enabled: true, trustStatus: 'trusted',
        command: 'true', timeout: 1, matcher: null,
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

test('doctor fails closed on effective Hark MCP drift or unverifiable config', async (t) => {
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
      assert.match(
        result.checks.find((check) => check.id === 'mcp_config').error,
        new RegExp(`^hark_mcp_config_drift:${scenario.field}:`),
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

  await t.test('Hark server absent from effective config', async () => {
    const fixture = doctorFixture({
      config: {
        features: { current_time_reminder: { clock_source: 'system' } },
        mcp_servers: {},
      },
    });
    const result = await doctorCommand({}, fixture.dependencies);
    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((check) => check.id === 'mcp_config').error,
      'hark_mcp_config_unverifiable:hark',
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
});
