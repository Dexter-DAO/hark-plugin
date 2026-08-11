import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  CodexDaemonTransport,
  CodexDaemonTransportError,
  createCodexDaemonTransportFactory,
} from '../lib/codex-daemon-transport.mjs';
import { AppServerClient } from '../lib/app-server-client.mjs';

const SOCKET_PATH = '/tmp/codex-home/app-server-control/app-server-control.sock';
const MANAGED_PATH = '/tmp/codex-home/packages/standalone/current/codex';
const VERSION = '0.147.0';
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PINNED_SHA256 = 'cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40';

function fileStat({ dev = 7n, ino = 11n, size = 101n, mtimeNs = 13n, ctimeNs = 17n } = {}) {
  return {
    dev, ino, size, mtimeNs, ctimeNs,
    isFile: () => true,
    isSymbolicLink: () => false,
    isSocket: () => false,
  };
}

function socketStat() {
  return {
    isFile: () => false,
    isSymbolicLink: () => false,
    isSocket: () => true,
  };
}

function fakeExecutableHandle({ fd = 47, statImpl = async () => fileStat() } = {}) {
  return {
    fd,
    closed: false,
    stat: statImpl,
    async close() { this.closed = true; },
  };
}

function daemonVersion(overrides = {}) {
  return {
    status: 'running',
    backend: 'pid',
    managedCodexPath: MANAGED_PATH,
    managedCodexVersion: VERSION,
    socketPath: SOCKET_PATH,
    cliVersion: VERSION,
    appServerVersion: VERSION,
    ...overrides,
  };
}

function commandResult(output = daemonVersion()) {
  return {
    code: 0,
    signal: null,
    stdout: `${JSON.stringify(output)}\n`,
    stderr: '',
  };
}

function websocketAccept(key) {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function encodeServerFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length <= 125) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

class FakeProxy extends EventEmitter {
  constructor({ badAccept = false, respond = true } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.handshake = '';
    this.buffer = Buffer.alloc(0);
    this.upgraded = false;
    this.badAccept = badAccept;
    this.respond = respond;
    this.stdin.on('data', (chunk) => this.#receive(chunk));
  }

  #receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    if (!this.upgraded) {
      const boundary = this.buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      this.handshake = this.buffer.subarray(0, boundary + 4).toString('latin1');
      this.buffer = this.buffer.subarray(boundary + 4);
      this.upgraded = true;
      if (this.respond) {
        const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(this.handshake)?.[1]?.trim();
        assert.ok(key);
        const accept = this.badAccept ? 'wrong' : websocketAccept(key);
        this.stdout.write(
          'HTTP/1.1 101 Switching Protocols\r\n'
            + 'Upgrade: websocket\r\n'
            + 'Connection: Upgrade\r\n'
            + `Sec-WebSocket-Accept: ${accept}\r\n`
            + '\r\n',
          'latin1',
        );
      }
    }
    this.#parseFrames();
  }

  #parseFrames() {
    while (this.upgraded && this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const frameLength = offset + (masked ? 4 : 0) + length;
      if (this.buffer.length < frameLength) return;
      assert.equal(masked, true, 'client WebSocket frames must be masked');
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const encoded = this.buffer.subarray(offset, offset + length);
      const payload = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) {
        payload[index] = encoded[index] ^ mask[index % 4];
      }
      this.buffer = this.buffer.subarray(frameLength);
      this.emit('clientFrame', { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    }
  }

  sendText(value) {
    this.stdout.write(encodeServerFrame(0x1, value));
  }

  kill(signal) {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

function baseOptions(overrides = {}) {
  return {
    command: MANAGED_PATH,
    runCommandImpl: async () => commandResult(),
    readFileImpl: async () => '{"remoteControlEnabled":true}',
    openImpl: async () => fakeExecutableHandle(),
    hashHandleImpl: async () => PINNED_SHA256,
    lstatImpl: async (filePath) => (filePath === SOCKET_PATH ? socketStat() : fileStat()),
    randomBytesImpl: (length) => Buffer.alloc(length, 0x2a),
    ...overrides,
  };
}

function isErrorCode(code) {
  return (error) => error instanceof CodexDaemonTransportError && error.code === code;
}

test('gates the managed daemon, upgrades proxy WebSocket, and bridges JSONL text frames', async () => {
  const commands = [];
  const spawns = [];
  const proxy = new FakeProxy();
  const factory = createCodexDaemonTransportFactory(baseOptions({
    runCommandImpl: async (request) => {
      commands.push(request);
      return commandResult();
    },
    spawnImpl: (command, args, options) => {
      spawns.push({ command, args, options });
      return proxy;
    },
  }));

  const transport = await factory({
    commandArgs: ['--config', 'profile=hark'],
    cwd: '/tmp',
    env: { PATH: '/usr/bin' },
  });

  assert.deepEqual(commands.map(({ command, args }) => ({ command, args })), [{
    command: '/proc/self/fd/3',
    args: ['--config', 'profile=hark', 'app-server', 'daemon', 'version'],
  }]);
  assert.deepEqual(spawns.map(({ command, args }) => ({ command, args })), [{
    command: '/proc/self/fd/3',
    args: [
      '--config',
      'profile=hark',
      'app-server',
      'proxy',
      '--sock',
      SOCKET_PATH,
    ],
  }]);
  assert.equal(commands[0].configuredCommand, MANAGED_PATH);
  assert.equal(commands[0].executableFd, 47);
  assert.equal(spawns[0].options.stdio[3], 47);
  assert.match(proxy.handshake, /^GET \/ HTTP\/1\.1\r\n/);
  assert.match(proxy.handshake, /Upgrade: websocket\r\n/i);

  const clientFrame = once(proxy, 'clientFrame');
  transport.stdin.write('{"method":"initialize","id":1,"params":{}}\n');
  const [frame] = await clientFrame;
  assert.equal(frame.fin, true);
  assert.equal(frame.opcode, 0x1);
  assert.equal(frame.payload.toString('utf8'), '{"method":"initialize","id":1,"params":{}}');

  const serverData = once(transport.stdout, 'data');
  proxy.sendText('{"id":1,"result":{"ok":true}}');
  assert.equal((await serverData)[0].toString('utf8'), '{"id":1,"result":{"ok":true}}\n');

  const invokedWords = [...commands, ...spawns]
    .flatMap(({ args }) => args)
    .map((word) => String(word));
  for (const forbidden of [
    'start',
    'restart',
    'stop',
    'bootstrap',
    'enable-remote-control',
    'disable-remote-control',
  ]) {
    assert.equal(invokedWords.includes(forbidden), false, `must not invoke ${forbidden}`);
  }
  transport.close();
});

test('serves as the injectable AppServerClient transport end to end', async () => {
  const proxy = new FakeProxy();
  proxy.on('clientFrame', ({ opcode, payload }) => {
    if (opcode !== 0x1) return;
    const message = JSON.parse(payload.toString('utf8'));
    if (message.method === 'initialize') {
      proxy.sendText(JSON.stringify({
        id: message.id,
        result: {
          userAgent: 'codex_cli_rs/0.147.0',
          codexHome: '/tmp/codex-home',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      }));
    } else if (message.method === 'thread/loaded/list') {
      proxy.sendText(JSON.stringify({
        id: message.id,
        result: { data: ['thread-1'], nextCursor: null },
      }));
    }
  });

  const client = new AppServerClient({
    versionProbe: async () => 'codex-cli 0.147.0',
    transportFactory: createCodexDaemonTransportFactory(baseOptions({
      spawnImpl: () => proxy,
    })),
    requestTimeoutMs: 1_000,
  });
  await client.start();
  assert.deepEqual(await client.listLoadedThreads(), {
    data: ['thread-1'],
    nextCursor: null,
  });
  await client.close();
});

test('fails closed before proxy spawn for missing, unmanaged, or wrong-version daemons', async (t) => {
  const cases = [
    ['not running', daemonVersion({ status: 'notRunning' }), 'DAEMON_NOT_RUNNING'],
    ['not managed', daemonVersion({ backend: null }), 'DAEMON_NOT_MANAGED'],
    ['wrong CLI', daemonVersion({ cliVersion: '0.146.1' }), 'DAEMON_VERSION_MISMATCH'],
    ['missing managed version', daemonVersion({ managedCodexVersion: null }), 'DAEMON_VERSION_MISMATCH'],
    ['wrong app server', daemonVersion({ appServerVersion: '0.146.1' }), 'DAEMON_VERSION_MISMATCH'],
  ];

  for (const [name, output, code] of cases) {
    await t.test(name, async () => {
      let spawnCalls = 0;
      const factory = createCodexDaemonTransportFactory(baseOptions({
        runCommandImpl: async () => commandResult(output),
        spawnImpl: () => {
          spawnCalls += 1;
          return new FakeProxy();
        },
      }));
      await assert.rejects(factory(), isErrorCode(code));
      assert.equal(spawnCalls, 0);
    });
  }

  let spawnCalls = 0;
  const missing = createCodexDaemonTransportFactory(baseOptions({
    runCommandImpl: async () => {
      throw new Error('ENOENT');
    },
    spawnImpl: () => {
      spawnCalls += 1;
      return new FakeProxy();
    },
  }));
  await assert.rejects(missing(), isErrorCode('DAEMON_VERSION_COMMAND_FAILED'));
  assert.equal(spawnCalls, 0);
});

test('fails closed when the managed Codex executable does not match the pinned artifact', async () => {
  let spawnCalls = 0;
  const factory = createCodexDaemonTransportFactory(baseOptions({
    hashHandleImpl: async () => '0'.repeat(64),
    spawnImpl: () => {
      spawnCalls += 1;
      return new FakeProxy();
    },
  }));
  await assert.rejects(factory(), isErrorCode('DAEMON_EXECUTABLE_MISMATCH'));
  assert.equal(spawnCalls, 0);
});

test('requires one exact normalized absolute configured executable and daemon path', async (t) => {
  await t.test('relative configured command', async () => {
    const adapter = new CodexDaemonTransport(baseOptions({ command: 'codex' }));
    await assert.rejects(adapter.inspect(), isErrorCode('DAEMON_COMMAND_INVALID'));
  });

  await t.test('daemon reports another pinned path', async () => {
    const adapter = new CodexDaemonTransport(baseOptions({
      runCommandImpl: async () => commandResult(daemonVersion({
        managedCodexPath: '/tmp/other/codex',
      })),
    }));
    await assert.rejects(adapter.inspect(), isErrorCode('DAEMON_EXECUTABLE_PATH_MISMATCH'));
  });

  await t.test('configured path is not a regular file', async () => {
    const adapter = new CodexDaemonTransport(baseOptions({
      openImpl: async () => fakeExecutableHandle({
        statImpl: async () => ({
          dev: 7n, ino: 11n, size: 0n, mtimeNs: 13n, ctimeNs: 17n,
          isFile: () => false,
          isSymbolicLink: () => false,
        }),
      }),
    }));
    await assert.rejects(adapter.inspect(), isErrorCode('DAEMON_EXECUTABLE_UNSAFE'));
  });
});

test('rejects executable replacement races at inspect, open, and spawn boundaries', async (t) => {
  const replacement = fileStat({ ino: 99n });

  await t.test('path swaps while daemon version is inspected', async () => {
    let executablePathChecks = 0;
    let proxySpawns = 0;
    const adapter = new CodexDaemonTransport(baseOptions({
      lstatImpl: async (filePath) => {
        if (filePath === SOCKET_PATH) return socketStat();
        executablePathChecks += 1;
        return executablePathChecks === 1 ? fileStat() : replacement;
      },
      spawnImpl: () => {
        proxySpawns += 1;
        return new FakeProxy();
      },
    }));
    await assert.rejects(adapter.open(), isErrorCode('DAEMON_EXECUTABLE_CHANGED'));
    assert.equal(proxySpawns, 0);
  });

  await t.test('same-hash replacement appears between inspect and open', async () => {
    let opens = 0;
    let currentStat = fileStat();
    let proxySpawns = 0;
    const adapter = new CodexDaemonTransport(baseOptions({
      openImpl: async () => {
        opens += 1;
        currentStat = opens === 1 ? fileStat() : replacement;
        return fakeExecutableHandle({ statImpl: async () => currentStat });
      },
      lstatImpl: async (filePath) => (filePath === SOCKET_PATH ? socketStat() : currentStat),
      spawnImpl: () => {
        proxySpawns += 1;
        return new FakeProxy();
      },
    }));
    await assert.rejects(adapter.open(), isErrorCode('DAEMON_EXECUTABLE_CHANGED'));
    assert.equal(proxySpawns, 0);
  });

  await t.test('path swaps synchronously as the descriptor-backed proxy spawns', async () => {
    let swapped = false;
    const proxy = new FakeProxy();
    const adapter = new CodexDaemonTransport(baseOptions({
      lstatImpl: async (filePath) => {
        if (filePath === SOCKET_PATH) return socketStat();
        return swapped ? replacement : fileStat();
      },
      spawnImpl: (command, _args, options) => {
        assert.equal(command, '/proc/self/fd/3');
        assert.equal(options.stdio[3], 47);
        swapped = true;
        return proxy;
      },
    }));
    await assert.rejects(adapter.open(), isErrorCode('DAEMON_EXECUTABLE_CHANGED'));
    assert.equal(proxy.signalCode, 'SIGTERM');
  });

  await t.test('opened executable bytes change synchronously as the proxy spawns', async () => {
    let spawned = false;
    const proxy = new FakeProxy();
    const adapter = new CodexDaemonTransport(baseOptions({
      hashHandleImpl: async () => (spawned ? '0'.repeat(64) : PINNED_SHA256),
      spawnImpl: () => {
        spawned = true;
        return proxy;
      },
    }));
    await assert.rejects(adapter.open(), isErrorCode('DAEMON_EXECUTABLE_MISMATCH'));
    assert.equal(proxy.signalCode, 'SIGTERM');
  });
});

test('fails closed on disabled, missing, or malformed remote-control settings', async (t) => {
  const cases = [
    ['disabled', async () => '{"remoteControlEnabled":false}'],
    ['missing field', async () => '{}'],
    ['malformed', async () => '{'],
    ['missing file', async () => { throw new Error('ENOENT'); }],
  ];

  for (const [name, readFileImpl] of cases) {
    await t.test(name, async () => {
      let spawnCalls = 0;
      const factory = createCodexDaemonTransportFactory(baseOptions({
        readFileImpl,
        spawnImpl: () => {
          spawnCalls += 1;
          return new FakeProxy();
        },
      }));
      await assert.rejects(factory(), isErrorCode('REMOTE_CONTROL_DISABLED'));
      assert.equal(spawnCalls, 0);
    });
  }
});

test('fails closed on a missing, non-socket, mismatched, or unexpected control socket', async (t) => {
  await t.test('missing socket', async () => {
    const adapter = new CodexDaemonTransport(baseOptions({
      lstatImpl: async (filePath) => {
        if (filePath === SOCKET_PATH) throw new Error('ENOENT');
        return fileStat();
      },
    }));
    await assert.rejects(adapter.inspect(), isErrorCode('DAEMON_SOCKET_INVALID'));
  });

  await t.test('not a Unix socket', async () => {
    const adapter = new CodexDaemonTransport(baseOptions({
      lstatImpl: async (filePath) => (filePath === SOCKET_PATH
        ? { isSocket: () => false }
        : fileStat()),
    }));
    await assert.rejects(adapter.inspect(), isErrorCode('DAEMON_SOCKET_INVALID'));
  });

  await t.test('expected socket mismatch', async () => {
    const adapter = new CodexDaemonTransport(baseOptions({
      expectedSocketPath: '/tmp/other.sock',
    }));
    await assert.rejects(adapter.inspect(), isErrorCode('DAEMON_SOCKET_MISMATCH'));
  });

  await t.test('unexpected daemon socket layout', async () => {
    const adapter = new CodexDaemonTransport(baseOptions({
      runCommandImpl: async () => commandResult(daemonVersion({ socketPath: '/tmp/other.sock' })),
    }));
    await assert.rejects(adapter.inspect(), isErrorCode('DAEMON_SOCKET_INVALID'));
  });
});

test('rejects a proxy that does not prove the WebSocket accept key', async () => {
  const proxy = new FakeProxy({ badAccept: true });
  const factory = createCodexDaemonTransportFactory(baseOptions({
    spawnImpl: () => proxy,
  }));
  await assert.rejects(factory(), isErrorCode('PROXY_UPGRADE_FAILED'));
  assert.equal(proxy.signalCode, 'SIGTERM');
});
