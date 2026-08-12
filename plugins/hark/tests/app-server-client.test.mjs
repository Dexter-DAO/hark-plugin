import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  AppServerClient,
  AppServerProtocolError,
  CODEX_APP_SERVER_COMPATIBILITY,
} from '../lib/app-server-client.mjs';

class FakeTransport {
  constructor() {
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.process = new EventEmitter();
    this.messages = [];
    this.waiters = [];
    this.buffer = '';
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line === '') continue;
        const message = JSON.parse(line);
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.messages.push(message);
      }
    });
  }

  nextMessage() {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
  }

  abruptlyClose() {
    this.stdout.end();
  }
}

function createClient(transport, overrides = {}) {
  return new AppServerClient({
    transportFactory: async () => transport,
    versionProbe: async () => 'codex-cli 0.147.0',
    requestTimeoutMs: 1_000,
    ...overrides,
  });
}

async function completeHandshake(client, transport) {
  const starting = client.start();
  const initialize = await transport.nextMessage();
  assert.deepEqual(initialize, {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'hark-codex-supervisor',
        title: 'Hark Codex Supervisor',
        version: '0.1.6',
      },
      capabilities: { experimentalApi: true },
    },
  });
  transport.send({
    id: initialize.id,
    result: {
      userAgent: 'codex_cli_rs/0.147.0',
      codexHome: '/tmp/codex-home',
      platformFamily: 'unix',
      platformOs: 'linux',
    },
  });
  await starting;
  assert.deepEqual(await transport.nextMessage(), {
    method: 'initialized',
    params: {},
  });
}

test('performs the pinned initialize handshake and emits exact thread request shapes', async () => {
  const transport = new FakeTransport();
  const client = createClient(transport);
  await completeHandshake(client, transport);

  const listing = client.listLoadedThreads({ cursor: null, limit: 50 });
  const listRequest = await transport.nextMessage();
  assert.deepEqual(listRequest, {
    method: 'thread/loaded/list',
    id: 2,
    params: { cursor: null, limit: 50 },
  });
  transport.send({ id: listRequest.id, result: { data: ['thread-1'], nextCursor: null } });
  assert.deepEqual(await listing, { data: ['thread-1'], nextCursor: null });

  const resuming = client.resumeThread('thread-1');
  const resumeRequest = await transport.nextMessage();
  assert.deepEqual(resumeRequest, {
    method: 'thread/resume',
    id: 3,
    params: { threadId: 'thread-1' },
  });
  transport.send({ id: resumeRequest.id, result: { thread: { id: 'thread-1' } } });
  assert.equal((await resuming).thread.id, 'thread-1');

  const reading = client.readThread('thread-1');
  const readRequest = await transport.nextMessage();
  assert.deepEqual(readRequest, {
    method: 'thread/read',
    id: 4,
    params: { threadId: 'thread-1', includeTurns: true },
  });
  transport.send({ id: readRequest.id, result: { thread: { id: 'thread-1', turns: [] } } });
  assert.equal((await reading).thread.id, 'thread-1');

  const startingTurn = client.startTurn('thread-1', 'wake up', {
    clientUserMessageId: 'hark:wake-1',
  });
  const turnRequest = await transport.nextMessage();
  assert.deepEqual(turnRequest, {
    method: 'turn/start',
    id: 5,
    params: {
      threadId: 'thread-1',
      clientUserMessageId: 'hark:wake-1',
      input: [{ type: 'text', text: 'wake up' }],
    },
  });
  transport.send({
    id: turnRequest.id,
    result: { turn: { id: 'turn-wake-1', status: 'inProgress', items: [], error: null } },
  });
  assert.equal((await startingTurn).turn.id, 'turn-wake-1');

  await client.close();
});

test('reads the exact hook and MCP inventories used by Hark doctor', async () => {
  const transport = new FakeTransport();
  const client = createClient(transport);
  await completeHandshake(client, transport);

  const hooksPending = client.listHooks({ cwds: ['/workspace'] });
  const hooksRequest = await transport.nextMessage();
  assert.deepEqual(hooksRequest, {
    method: 'hooks/list', id: 2, params: { cwds: ['/workspace'] },
  });
  transport.send({
    id: hooksRequest.id,
    result: { data: [{ cwd: '/workspace', hooks: [], warnings: [], errors: [] }] },
  });
  assert.equal((await hooksPending).data[0].cwd, '/workspace');

  const mcpPending = client.listMcpServerStatus();
  const mcpRequest = await transport.nextMessage();
  assert.deepEqual(mcpRequest, {
    method: 'mcpServerStatus/list',
    id: 3,
    params: { cursor: null, limit: null, detail: 'toolsAndAuthOnly', threadId: null },
  });
  transport.send({
    id: mcpRequest.id,
    result: { data: [{ name: 'hark', tools: { hark_await: {} } }], nextCursor: null },
  });
  assert.deepEqual(Object.keys((await mcpPending).data[0].tools), ['hark_await']);
  await client.close();
});

test('writes one config value through the exact pinned App Server request', async () => {
  const transport = new FakeTransport();
  const client = createClient(transport);
  await completeHandshake(client, transport);

  const writing = client.writeConfigValue({
    keyPath: 'features.code_mode.direct_only_tool_namespaces',
    value: ['mcp__existing', 'mcp__hark'],
    mergeStrategy: 'replace',
    filePath: '/tmp/codex-home/config.toml',
    expectedVersion: 'sha256:before',
  });
  const request = await transport.nextMessage();
  assert.deepEqual(request, {
    method: 'config/value/write',
    id: 2,
    params: {
      keyPath: 'features.code_mode.direct_only_tool_namespaces',
      value: ['mcp__existing', 'mcp__hark'],
      mergeStrategy: 'replace',
      filePath: '/tmp/codex-home/config.toml',
      expectedVersion: 'sha256:before',
    },
  });
  transport.send({
    id: request.id,
    result: {
      status: 'ok',
      version: 'sha256:after',
      filePath: '/tmp/codex-home/config.toml',
      overriddenMetadata: null,
    },
  });
  assert.deepEqual(await writing, {
    status: 'ok',
    version: 'sha256:after',
    filePath: '/tmp/codex-home/config.toml',
    overriddenMetadata: null,
  });
  await client.close();
});

test('rejects malformed or silently overridden config write responses', async () => {
  for (const result of [
    {
      status: 'unexpected',
      version: 'sha256:after',
      filePath: '/tmp/codex-home/config.toml',
      overriddenMetadata: null,
    },
    {
      status: 'ok',
      version: '',
      filePath: '/tmp/codex-home/config.toml',
      overriddenMetadata: null,
    },
    {
      status: 'ok',
      version: 'sha256:after',
      filePath: '/tmp/other/config.toml',
      overriddenMetadata: null,
    },
    {
      status: 'ok',
      version: 'sha256:after',
      filePath: '/tmp/codex-home/config.toml',
    },
    {
      status: 'okOverridden',
      version: 'sha256:after',
      filePath: '/tmp/codex-home/config.toml',
      overriddenMetadata: {
        message: 'managed setting wins',
        overridingLayer: {
          name: { type: 'system', file: '/etc/codex/config.toml' },
          version: 'sha256:managed',
        },
        effectiveValue: ['mcp__managed'],
      },
    },
  ]) {
    const transport = new FakeTransport();
    const client = createClient(transport);
    await completeHandshake(client, transport);
    const writing = client.writeConfigValue({
      keyPath: 'features.code_mode.direct_only_tool_namespaces',
      value: ['mcp__hark'],
      mergeStrategy: 'replace',
      expectedVersion: 'sha256:before',
    });
    const request = await transport.nextMessage();
    transport.send({ id: request.id, result });
    await assert.rejects(writing, AppServerProtocolError);
    await client.close();
  }
});

test('returns a validated overridden config write only when explicitly allowed', async () => {
  const transport = new FakeTransport();
  const client = createClient(transport);
  await completeHandshake(client, transport);

  const writing = client.writeConfigValue({
    keyPath: 'features.code_mode.direct_only_tool_namespaces',
    value: ['mcp__hark'],
    mergeStrategy: 'replace',
    expectedVersion: 'sha256:before',
  }, { allowOverridden: true });
  const request = await transport.nextMessage();
  const result = {
    status: 'okOverridden',
    version: 'sha256:after',
    filePath: '/tmp/codex-home/config.toml',
    overriddenMetadata: {
      message: 'managed setting wins',
      overridingLayer: {
        name: { type: 'system', file: '/etc/codex/config.toml' },
        version: 'sha256:managed',
      },
      effectiveValue: ['mcp__managed'],
    },
  };
  transport.send({ id: request.id, result });
  assert.deepEqual(await writing, result);
  await client.close();
});

test('delivers item/completed and turn/completed notifications with trusted correlation fields', async () => {
  const transport = new FakeTransport();
  const client = createClient(transport);
  await completeHandshake(client, transport);

  const itemEvent = once(client, 'item/completed');
  const turnEvent = once(client, 'turn/completed');
  const item = {
    type: 'mcpToolCall',
    id: 'item-1',
    server: 'hark',
    tool: 'hark_await',
    status: 'completed',
    arguments: { request: 'wait' },
    result: { structuredContent: { preparationNonce: 'nonce-1' } },
  };
  transport.send({
    method: 'item/completed',
    emittedAtMs: 123,
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item,
      completedAtMs: 123,
    },
  });
  transport.send({
    method: 'turn/completed',
    emittedAtMs: 124,
    params: {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [item], error: null },
    },
  });

  assert.deepEqual((await itemEvent)[0], {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item,
    completedAtMs: 123,
  });
  assert.equal((await turnEvent)[0].turn.id, 'turn-1');
  await client.close();
});

test('fails closed on a version or schema mismatch before opening a transport', async () => {
  let transportCalls = 0;
  const transportFactory = async () => {
    transportCalls += 1;
    return new FakeTransport();
  };

  await assert.rejects(
    createClient(new FakeTransport(), {
      transportFactory,
      versionProbe: async () => 'codex-cli 0.146.1',
    }).start(),
    (error) => error instanceof AppServerProtocolError && /version gate failed/.test(error.message),
  );
  assert.equal(transportCalls, 0);

  await assert.rejects(
    createClient(new FakeTransport(), {
      transportFactory,
      expectedSchemaDigest: '0'.repeat(64),
    }).start(),
    (error) => error instanceof AppServerProtocolError && /schema digest/.test(error.message),
  );
  assert.equal(transportCalls, 0);
  assert.equal(CODEX_APP_SERVER_COMPATIBILITY.codexVersion, '0.147.0');
  assert.equal(
    CODEX_APP_SERVER_COMPATIBILITY.linuxMuslArchiveSha256,
    '0246e2e773834e07f0fb5249ed6ebad12e4591e608f8c7bb97dd6a9690544c36',
  );
  assert.equal(
    CODEX_APP_SERVER_COMPATIBILITY.linuxMuslBinarySha256,
    'cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40',
  );
});

test('rejects every pending request when the JSONL transport closes', async () => {
  const transport = new FakeTransport();
  const client = createClient(transport);
  await completeHandshake(client, transport);

  const pending = client.readThread('thread-pending');
  assert.equal((await transport.nextMessage()).method, 'thread/read');
  transport.abruptlyClose();

  await assert.rejects(
    pending,
    (error) => error instanceof AppServerProtocolError && /transport closed/.test(error.message),
  );
  assert.equal(client.pending.size, 0);
});

test('fails every pending request and closes on malformed protocol input', async () => {
  const transport = new FakeTransport();
  const client = createClient(transport);
  await completeHandshake(client, transport);

  const pending = client.readThread('thread-pending');
  assert.equal((await transport.nextMessage()).method, 'thread/read');
  const protocolError = once(client, 'protocolError');
  transport.send({ method: 'turn/started', params: {} });

  assert.match((await protocolError)[0].message, /emittedAtMs/);
  await assert.rejects(pending, /emittedAtMs/);
  assert.equal(client.closed, true);
  assert.equal(client.pending.size, 0);
});
