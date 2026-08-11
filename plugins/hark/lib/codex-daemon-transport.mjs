import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat as nodeLstat,
  open as nodeOpen,
  readFile as nodeReadFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { TextDecoder } from 'node:util';

import { CODEX_APP_SERVER_COMPATIBILITY } from './app-server-client.mjs';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

async function defaultHashHandle(fileHandle) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (true) {
    const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function requireRegularFile(stat, code, label, details = undefined) {
  if (!stat?.isFile?.() || stat.isSymbolicLink?.()) {
    fail(code, `${label} must be a regular file`, details);
  }
  if (
    !['bigint', 'number'].includes(typeof stat.dev)
    || !['bigint', 'number'].includes(typeof stat.ino)
  ) {
    fail(code, `${label} did not expose a stable filesystem identity`, details);
  }
  return stat;
}

function statIdentity(stat) {
  return `${String(stat.dev)}:${String(stat.ino)}`;
}

function statSnapshot(stat) {
  return Object.freeze({
    identity: statIdentity(stat),
    size: String(stat.size),
    mtime: String(stat.mtimeNs ?? stat.mtimeMs ?? ''),
    ctime: String(stat.ctimeNs ?? stat.ctimeMs ?? ''),
  });
}

function snapshotsEqual(left, right) {
  return left.identity === right.identity
    && left.size === right.size
    && left.mtime === right.mtime
    && left.ctime === right.ctime;
}

export const CODEX_DAEMON_COMPATIBILITY = Object.freeze({
  codexVersion: CODEX_APP_SERVER_COMPATIBILITY.codexVersion,
  backend: 'pid',
  socketDirectory: 'app-server-control',
  socketFilename: 'app-server-control.sock',
  settingsDirectory: 'app-server-daemon',
  settingsFilename: 'settings.json',
  transport: 'websocket-over-app-server-proxy',
});

export class CodexDaemonTransportError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'CodexDaemonTransportError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = undefined) {
  throw new CodexDaemonTransportError(code, message, details);
}

function requirePlainObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be a JSON object`, value);
  }
  return value;
}

function requireNonEmptyString(value, code, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(code, `${label} must be a non-empty string`, value);
  }
  return value;
}

function parseSingleJsonObject(stdout) {
  const source = String(stdout).trim();
  if (source.length === 0) {
    fail('DAEMON_VERSION_INVALID', 'Codex daemon version returned no JSON');
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    fail('DAEMON_VERSION_INVALID', 'Codex daemon version returned invalid JSON', {
      cause: error instanceof Error ? error.message : String(error),
      stdout: source,
    });
  }
  return requirePlainObject(
    parsed,
    'DAEMON_VERSION_INVALID',
    'Codex daemon version response',
  );
}

function validateVersionField(output, field, expectedVersion) {
  if (output[field] !== expectedVersion) {
    fail('DAEMON_VERSION_MISMATCH', `Codex daemon ${field} failed the version gate`, {
      field,
      expected: expectedVersion,
      actual: output[field] ?? null,
    });
  }
}

function settingsPathForSocket(socketPath) {
  const socketDirectory = dirname(socketPath);
  const codexHome = dirname(socketDirectory);
  const expectedSocketPath = join(
    codexHome,
    CODEX_DAEMON_COMPATIBILITY.socketDirectory,
    CODEX_DAEMON_COMPATIBILITY.socketFilename,
  );
  if (socketPath !== expectedSocketPath) {
    fail('DAEMON_SOCKET_INVALID', 'Codex daemon reported an unexpected control socket layout', {
      socketPath,
      expectedSocketPath,
    });
  }
  return join(
    codexHome,
    CODEX_DAEMON_COMPATIBILITY.settingsDirectory,
    CODEX_DAEMON_COMPATIBILITY.settingsFilename,
  );
}

async function defaultRunCommand({
  command,
  args,
  cwd,
  env,
  executableFd,
  spawnImpl,
  timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe', executableFd],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill?.('SIGTERM');
      reject(new CodexDaemonTransportError(
        'DAEMON_VERSION_TIMEOUT',
        'Timed out reading Codex daemon version',
        { timeoutMs },
      ));
    }, timeoutMs);
    timer.unref?.();

    const append = (current, chunk, streamName) => {
      const next = `${current}${String(chunk)}`;
      if (Buffer.byteLength(next) > MAX_COMMAND_OUTPUT_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill?.('SIGTERM');
          reject(new CodexDaemonTransportError(
            'DAEMON_VERSION_INVALID',
            `Codex daemon version ${streamName} exceeded the size limit`,
          ));
        }
        return current;
      }
      return next;
    };

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk, 'stdout');
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk, 'stderr');
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function normalizeCommandResult(result) {
  const normalized = requirePlainObject(
    result,
    'DAEMON_VERSION_COMMAND_FAILED',
    'Codex daemon version command result',
  );
  if (normalized.code !== 0) {
    fail('DAEMON_VERSION_COMMAND_FAILED', 'Codex daemon version command failed', {
      code: normalized.code ?? null,
      signal: normalized.signal ?? null,
      stderr: String(normalized.stderr ?? ''),
    });
  }
  return String(normalized.stdout ?? '');
}

function websocketAccept(key) {
  return createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
}

function parseUpgradeResponse(headerBytes, expectedAccept) {
  const source = headerBytes.toString('latin1');
  const lines = source.split('\r\n');
  if (!/^HTTP\/1\.1 101(?:\s|$)/.test(lines.shift() ?? '')) {
    fail('PROXY_UPGRADE_FAILED', 'Codex control socket rejected the WebSocket upgrade', {
      statusLine: source.split('\r\n', 1)[0] ?? '',
    });
  }
  const headers = new Map();
  for (const line of lines) {
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator <= 0) {
      fail('PROXY_UPGRADE_FAILED', 'Codex control socket returned a malformed HTTP header');
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)},${value}` : value);
  }
  if (headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    fail('PROXY_UPGRADE_FAILED', 'Codex control socket omitted Upgrade: websocket');
  }
  const connectionTokens = (headers.get('connection') ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase());
  if (!connectionTokens.includes('upgrade')) {
    fail('PROXY_UPGRADE_FAILED', 'Codex control socket omitted Connection: Upgrade');
  }
  if (headers.get('sec-websocket-accept') !== expectedAccept) {
    fail('PROXY_UPGRADE_FAILED', 'Codex control socket returned the wrong WebSocket accept key');
  }
}

function encodeClientFrame(opcode, payload, randomBytesImpl) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = Buffer.from(randomBytesImpl(4));
  if (mask.length !== 4) {
    fail('PROXY_FRAME_INVALID', 'WebSocket mask generator must return four bytes');
  }

  let header;
  if (body.length <= 125) {
    header = Buffer.allocUnsafe(2);
    header[1] = 0x80 | body.length;
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;

  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function writeFrame(stream, frame, callback = undefined) {
  if (!stream || stream.destroyed || stream.writableEnded) {
    const error = new CodexDaemonTransportError(
      'PROXY_CLOSED',
      'Codex app-server proxy stdin is closed',
    );
    if (callback) callback(error);
    else throw error;
    return;
  }
  stream.write(frame, callback);
}

function createJsonlInput({ proxyStdin, randomBytesImpl, maxPayloadBytes, isClosed }) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  const consume = (text) => {
    pending += text;
    const frames = [];
    while (true) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (line.length === 0) continue;
      const payload = Buffer.from(line, 'utf8');
      if (payload.length > maxPayloadBytes) {
        fail('PROXY_FRAME_TOO_LARGE', 'Codex App Server JSON message exceeds the transport limit', {
          bytes: payload.length,
          maxPayloadBytes,
        });
      }
      frames.push(encodeClientFrame(0x1, payload, randomBytesImpl));
    }
    return frames;
  };

  return new Writable({
    write(chunk, _encoding, callback) {
      if (isClosed()) {
        callback(new CodexDaemonTransportError('PROXY_CLOSED', 'Codex daemon transport is closed'));
        return;
      }
      let frames;
      try {
        frames = consume(decoder.write(Buffer.from(chunk)));
      } catch (error) {
        callback(error);
        return;
      }
      if (frames.length === 0) {
        callback();
        return;
      }
      writeFrame(proxyStdin, Buffer.concat(frames), callback);
    },
    final(callback) {
      try {
        const frames = consume(decoder.end());
        if (pending.trim().length !== 0) {
          fail('PROXY_JSONL_INCOMPLETE', 'Codex daemon transport closed with an incomplete JSONL message');
        }
        if (frames.length === 0) callback();
        else writeFrame(proxyStdin, Buffer.concat(frames), callback);
      } catch (error) {
        callback(error);
      }
    },
  });
}

function createServerFrameParser({
  output,
  proxyStdin,
  randomBytesImpl,
  maxPayloadBytes,
  onClose,
}) {
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let buffered = Buffer.alloc(0);
  let fragmentedOpcode = null;
  let fragments = [];
  let fragmentedBytes = 0;

  const emitText = (payload) => {
    let text;
    try {
      text = utf8.decode(payload);
    } catch (error) {
      fail('PROXY_FRAME_INVALID', 'Codex control socket sent invalid UTF-8', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    output.write(`${text}\n`);
  };

  const handleDataFrame = (fin, opcode, payload) => {
    if (opcode === 0x0) {
      if (fragmentedOpcode === null) {
        fail('PROXY_FRAME_INVALID', 'Codex control socket sent an unexpected continuation frame');
      }
      fragments.push(payload);
      fragmentedBytes += payload.length;
      if (fragmentedBytes > maxPayloadBytes) {
        fail('PROXY_FRAME_TOO_LARGE', 'Codex control socket fragmented message exceeds the limit');
      }
      if (fin) {
        const complete = Buffer.concat(fragments, fragmentedBytes);
        const completedOpcode = fragmentedOpcode;
        fragmentedOpcode = null;
        fragments = [];
        fragmentedBytes = 0;
        if (completedOpcode !== 0x1) {
          fail('PROXY_FRAME_INVALID', 'Codex control socket sent an unsupported binary message');
        }
        emitText(complete);
      }
      return;
    }

    if (opcode !== 0x1) {
      fail('PROXY_FRAME_INVALID', 'Codex control socket sent an unsupported data opcode', { opcode });
    }
    if (fragmentedOpcode !== null) {
      fail('PROXY_FRAME_INVALID', 'Codex control socket interleaved fragmented data messages');
    }
    if (payload.length > maxPayloadBytes) {
      fail('PROXY_FRAME_TOO_LARGE', 'Codex control socket message exceeds the transport limit');
    }
    if (fin) emitText(payload);
    else {
      fragmentedOpcode = opcode;
      fragments = [payload];
      fragmentedBytes = payload.length;
    }
  };

  const handleFrame = (fin, opcode, payload) => {
    if (opcode < 0x8) {
      handleDataFrame(fin, opcode, payload);
      return;
    }
    if (!fin || payload.length > 125) {
      fail('PROXY_FRAME_INVALID', 'Codex control socket sent an invalid control frame');
    }
    if (opcode === 0x8) {
      if (payload.length === 1) {
        fail('PROXY_FRAME_INVALID', 'Codex control socket sent an invalid close frame');
      }
      try {
        writeFrame(proxyStdin, encodeClientFrame(0x8, payload, randomBytesImpl));
      } catch {
        // The peer is already closing; ending the local transport is sufficient.
      }
      onClose();
      return;
    }
    if (opcode === 0x9) {
      writeFrame(proxyStdin, encodeClientFrame(0xA, payload, randomBytesImpl));
      return;
    }
    if (opcode !== 0xA) {
      fail('PROXY_FRAME_INVALID', 'Codex control socket sent an unknown control opcode', { opcode });
    }
  };

  return (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    while (buffered.length >= 2) {
      const first = buffered[0];
      const second = buffered[1];
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if (rsv !== 0 || masked) {
        fail('PROXY_FRAME_INVALID', 'Codex control socket sent an invalid server frame header');
      }

      let payloadLength = second & 0x7f;
      let headerLength = 2;
      if (payloadLength === 126) {
        if (buffered.length < 4) return;
        payloadLength = buffered.readUInt16BE(2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (buffered.length < 10) return;
        const extended = buffered.readBigUInt64BE(2);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
          fail('PROXY_FRAME_TOO_LARGE', 'Codex control socket frame length is not safely representable');
        }
        payloadLength = Number(extended);
        headerLength = 10;
      }
      if (payloadLength > maxPayloadBytes) {
        fail('PROXY_FRAME_TOO_LARGE', 'Codex control socket frame exceeds the transport limit', {
          bytes: payloadLength,
          maxPayloadBytes,
        });
      }
      if (buffered.length < headerLength + payloadLength) return;
      const payload = buffered.subarray(headerLength, headerLength + payloadLength);
      buffered = buffered.subarray(headerLength + payloadLength);
      handleFrame(fin, opcode, payload);
    }
  };
}

async function upgradeProxy({
  child,
  randomBytesImpl,
  handshakeTimeoutMs,
  maxPayloadBytes,
}) {
  if (!child?.stdin || !child?.stdout) {
    fail('PROXY_SPAWN_FAILED', 'Codex app-server proxy must expose stdin and stdout');
  }

  const keyBytes = Buffer.from(randomBytesImpl(16));
  if (keyBytes.length !== 16) {
    fail('PROXY_UPGRADE_FAILED', 'WebSocket key generator must return sixteen bytes');
  }
  const key = keyBytes.toString('base64');
  const expectedAccept = websocketAccept(key);
  const request = Buffer.from(
    'GET / HTTP/1.1\r\n'
      + 'Host: localhost\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Key: ${key}\r\n`
      + 'Sec-WebSocket-Version: 13\r\n'
      + '\r\n',
    'latin1',
  );

  const output = new PassThrough();
  let handshakeBuffer = Buffer.alloc(0);
  let upgraded = false;
  let closed = false;
  let settled = false;
  let parseFrames;

  const closePeer = () => {
    if (closed) return;
    closed = true;
    output.end();
    child.stdin?.end();
  };
  const failConnection = (error) => {
    const normalized = error instanceof CodexDaemonTransportError
      ? error
      : new CodexDaemonTransportError(
        'PROXY_FAILED',
        'Codex app-server proxy failed',
        { cause: error instanceof Error ? error.message : String(error) },
      );
    if (!settled) return normalized;
    closePeer();
    if (child.exitCode == null && child.signalCode == null) child.kill?.('SIGTERM');
    return normalized;
  };

  const transport = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new CodexDaemonTransportError(
        'PROXY_UPGRADE_TIMEOUT',
        'Timed out upgrading the Codex daemon control socket',
        { handshakeTimeoutMs },
      );
      closePeer();
      child.kill?.('SIGTERM');
      reject(error);
    }, handshakeTimeoutMs);
    timer.unref?.();

    const rejectBeforeUpgrade = (error) => {
      if (settled) {
        failConnection(error);
        return;
      }
      settled = true;
      clearTimeout(timer);
      closePeer();
      child.kill?.('SIGTERM');
      reject(error instanceof CodexDaemonTransportError
        ? error
        : new CodexDaemonTransportError(
          'PROXY_UPGRADE_FAILED',
          'Codex app-server proxy closed before WebSocket upgrade',
          { cause: error instanceof Error ? error.message : String(error) },
        ));
    };

    parseFrames = createServerFrameParser({
      output,
      proxyStdin: child.stdin,
      randomBytesImpl,
      maxPayloadBytes,
      onClose: closePeer,
    });

    child.stdout.on('data', (chunk) => {
      try {
        if (upgraded) {
          parseFrames(chunk);
          return;
        }
        handshakeBuffer = Buffer.concat([handshakeBuffer, Buffer.from(chunk)]);
        if (handshakeBuffer.length > 16 * 1024) {
          fail('PROXY_UPGRADE_FAILED', 'Codex control socket HTTP upgrade headers are too large');
        }
        const boundary = handshakeBuffer.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        const headers = handshakeBuffer.subarray(0, boundary + 4);
        const remaining = handshakeBuffer.subarray(boundary + 4);
        parseUpgradeResponse(headers, expectedAccept);
        upgraded = true;
        settled = true;
        clearTimeout(timer);
        handshakeBuffer = Buffer.alloc(0);

        const stdin = createJsonlInput({
          proxyStdin: child.stdin,
          randomBytesImpl,
          maxPayloadBytes,
          isClosed: () => closed,
        });
        const result = {
          stdin,
          stdout: output,
          stderr: child.stderr,
          process: child,
          close() {
            if (closed) return;
            closed = true;
            try {
              writeFrame(child.stdin, encodeClientFrame(0x8, Buffer.alloc(0), randomBytesImpl));
            } catch {
              // The proxy is already gone.
            }
            stdin.end();
            output.end();
            child.stdin?.end();
            if (child.exitCode == null && child.signalCode == null) child.kill?.('SIGTERM');
          },
        };
        if (remaining.length > 0) parseFrames(remaining);
        resolve(result);
      } catch (error) {
        rejectBeforeUpgrade(error);
      }
    });
    child.stdout.once('error', rejectBeforeUpgrade);
    child.stdout.once('end', () => {
      if (!upgraded) {
        rejectBeforeUpgrade(new CodexDaemonTransportError(
          'PROXY_UPGRADE_FAILED',
          'Codex app-server proxy ended before WebSocket upgrade',
        ));
      } else {
        closePeer();
      }
    });
    child.stdin.once('error', rejectBeforeUpgrade);
    child.once?.('error', rejectBeforeUpgrade);
    child.once?.('close', (code, signal) => {
      if (!upgraded) {
        rejectBeforeUpgrade(new CodexDaemonTransportError(
          'PROXY_UPGRADE_FAILED',
          'Codex app-server proxy exited before WebSocket upgrade',
          { code, signal },
        ));
      } else {
        closePeer();
      }
    });

    child.stdin.write(request, (error) => {
      if (error) rejectBeforeUpgrade(error);
    });
  });

  return transport;
}

/**
 * Read-only gate and WebSocket adapter for the managed Codex App Server daemon.
 *
 * Codex 0.147.0's `app-server proxy` relays bytes; it does not translate the
 * control socket's WebSocket protocol into JSONL. This adapter performs the
 * required upgrade/framing and presents the JSONL stream expected by
 * AppServerClient. It never starts, restarts, stops, enables, or disables a
 * daemon.
 */
export class CodexDaemonTransport {
  constructor(options = {}) {
    this.options = options;
    this.expectedVersion = options.expectedVersion
      ?? CODEX_DAEMON_COMPATIBILITY.codexVersion;
    this.runCommandImpl = options.runCommandImpl ?? defaultRunCommand;
    this.readFileImpl = options.readFileImpl ?? nodeReadFile;
    this.openImpl = options.openImpl ?? nodeOpen;
    this.hashHandleImpl = options.hashHandleImpl
      ?? (options.hashFileImpl
        ? (_fileHandle, filePath) => options.hashFileImpl(filePath)
        : defaultHashHandle);
    this.lstatImpl = options.lstatImpl ?? nodeLstat;
    this.randomBytesImpl = options.randomBytesImpl ?? nodeRandomBytes;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  }

  #context(context = {}) {
    return {
      command: this.options.command ?? context.command ?? 'codex',
      commandArgs: this.options.commandArgs ?? context.commandArgs ?? [],
      cwd: this.options.cwd ?? context.cwd,
      env: this.options.env ?? context.env ?? process.env,
      spawnImpl: this.options.spawnImpl ?? context.spawnImpl ?? nodeSpawn,
    };
  }

  #expectedArtifactSha256() {
    const artifactTarget = `${this.options.platform ?? process.platform}-${this.options.arch ?? process.arch}`;
    const expectedArtifactSha256 = this.options.expectedArtifactSha256
      ?? (artifactTarget === 'linux-x64'
        ? CODEX_APP_SERVER_COMPATIBILITY.linuxMuslBinarySha256
        : null);
    if (!expectedArtifactSha256) {
      fail('DAEMON_PLATFORM_UNCERTIFIED', 'This Codex artifact target is not certified by Hark', {
        artifactTarget,
      });
    }
    return { artifactTarget, expectedArtifactSha256 };
  }

  #validateConfiguredCommand(command) {
    if (typeof command !== 'string' || !isAbsolute(command) || normalize(command) !== command) {
      fail(
        'DAEMON_COMMAND_INVALID',
        'The configured Codex executable must be one exact normalized absolute path',
        { command },
      );
    }
    return command;
  }

  async #readExecutablePathStat(command, phase) {
    let pathStat;
    try {
      pathStat = await this.lstatImpl(command, { bigint: true });
    } catch (error) {
      fail('DAEMON_EXECUTABLE_UNREADABLE', 'Configured Codex executable path is unavailable', {
        command,
        phase,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return requireRegularFile(
      pathStat,
      'DAEMON_EXECUTABLE_UNSAFE',
      'Configured Codex executable path',
      { command, phase },
    );
  }

  async #verifyOpenExecutable(opened, phase) {
    let handleStat;
    let digest;
    try {
      handleStat = requireRegularFile(
        await opened.handle.stat({ bigint: true }),
        'DAEMON_EXECUTABLE_UNSAFE',
        'Opened Codex executable',
        { command: opened.command, phase },
      );
      digest = await this.hashHandleImpl(opened.handle, opened.command);
    } catch (error) {
      if (error instanceof CodexDaemonTransportError) throw error;
      fail('DAEMON_EXECUTABLE_UNREADABLE', 'Unable to verify the opened Codex executable', {
        command: opened.command,
        phase,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const currentSnapshot = statSnapshot(handleStat);
    if (!snapshotsEqual(currentSnapshot, opened.snapshot)) {
      fail('DAEMON_EXECUTABLE_CHANGED', 'Opened Codex executable changed across a trust boundary', {
        command: opened.command,
        phase,
        expected: opened.snapshot,
        actual: currentSnapshot,
      });
    }
    if (digest !== opened.expectedSha256) {
      fail('DAEMON_EXECUTABLE_MISMATCH', 'Configured Codex executable failed the pinned artifact gate', {
        command: opened.command,
        phase,
        expected: opened.expectedSha256,
        actual: digest,
      });
    }
    const pathStat = await this.#readExecutablePathStat(opened.command, phase);
    const pathSnapshot = statSnapshot(pathStat);
    if (!snapshotsEqual(pathSnapshot, opened.snapshot)) {
      fail('DAEMON_EXECUTABLE_CHANGED', 'Configured Codex path was replaced across a trust boundary', {
        command: opened.command,
        phase,
        expected: opened.snapshot,
        actual: pathSnapshot,
      });
    }
    return digest;
  }

  async #openPinnedExecutable(command, expectedSha256, phase, expectedIdentity = undefined) {
    this.#validateConfiguredCommand(command);
    let handle;
    try {
      handle = await this.openImpl(
        command,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      fail('DAEMON_EXECUTABLE_UNREADABLE', 'Unable to open the configured Codex executable', {
        command,
        phase,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const opened = {
      command,
      expectedSha256,
      handle,
      snapshot: null,
    };
    try {
      const handleStat = requireRegularFile(
        await handle.stat({ bigint: true }),
        'DAEMON_EXECUTABLE_UNSAFE',
        'Opened Codex executable',
        { command, phase },
      );
      opened.snapshot = statSnapshot(handleStat);
      if (expectedIdentity && opened.snapshot.identity !== expectedIdentity) {
        fail('DAEMON_EXECUTABLE_CHANGED', 'Configured Codex executable identity changed before spawn', {
          command,
          phase,
          expectedIdentity,
          actualIdentity: opened.snapshot.identity,
        });
      }
      await this.#verifyOpenExecutable(opened, phase);
      return opened;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async inspect(context = {}) {
    if (this.expectedVersion !== CODEX_DAEMON_COMPATIBILITY.codexVersion) {
      fail('DAEMON_VERSION_MISMATCH', 'Unsupported Codex daemon adapter version', {
        expected: CODEX_DAEMON_COMPATIBILITY.codexVersion,
        actual: this.expectedVersion,
      });
    }
    const resolved = this.#context(context);
    const { artifactTarget, expectedArtifactSha256 } = this.#expectedArtifactSha256();
    const executable = await this.#openPinnedExecutable(
      resolved.command,
      expectedArtifactSha256,
      'inspect:before-version',
    );
    let commandResult;
    try {
      commandResult = await this.runCommandImpl({
        command: '/proc/self/fd/3',
        configuredCommand: resolved.command,
        executableFd: executable.handle.fd,
        args: [
          ...resolved.commandArgs,
          'app-server',
          'daemon',
          'version',
        ],
        cwd: resolved.cwd,
        env: resolved.env,
        spawnImpl: resolved.spawnImpl,
        timeoutMs: this.commandTimeoutMs,
      });
      await this.#verifyOpenExecutable(executable, 'inspect:after-version');
    } catch (error) {
      if (error instanceof CodexDaemonTransportError) throw error;
      fail('DAEMON_VERSION_COMMAND_FAILED', 'Unable to inspect the Codex app-server daemon', {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await executable.handle.close().catch(() => undefined);
    }

    const output = parseSingleJsonObject(normalizeCommandResult(commandResult));
    if (output.status !== 'running') {
      fail('DAEMON_NOT_RUNNING', 'Codex app-server daemon is not running', {
        status: output.status ?? null,
      });
    }
    if (output.backend !== CODEX_DAEMON_COMPATIBILITY.backend) {
      fail('DAEMON_NOT_MANAGED', 'Running Codex App Server is not managed by the pid daemon', {
        backend: output.backend ?? null,
      });
    }
    validateVersionField(output, 'cliVersion', this.expectedVersion);
    validateVersionField(output, 'managedCodexVersion', this.expectedVersion);
    validateVersionField(output, 'appServerVersion', this.expectedVersion);

    const managedCodexPath = requireNonEmptyString(
      output.managedCodexPath,
      'DAEMON_VERSION_INVALID',
      'managedCodexPath',
    );
    const socketPath = requireNonEmptyString(
      output.socketPath,
      'DAEMON_SOCKET_INVALID',
      'socketPath',
    );
    if (!isAbsolute(managedCodexPath) || !isAbsolute(socketPath)) {
      fail('DAEMON_SOCKET_INVALID', 'Codex daemon paths must be absolute', {
        managedCodexPath,
        socketPath,
      });
    }
    if (managedCodexPath !== resolved.command) {
      fail('DAEMON_EXECUTABLE_PATH_MISMATCH', 'Codex daemon is not bound to the configured executable', {
        configuredCodexPath: resolved.command,
        managedCodexPath,
      });
    }
    if (this.options.expectedSocketPath && socketPath !== this.options.expectedSocketPath) {
      fail('DAEMON_SOCKET_MISMATCH', 'Codex daemon reported the wrong control socket', {
        expected: this.options.expectedSocketPath,
        actual: socketPath,
      });
    }

    let socketStat;
    try {
      socketStat = await this.lstatImpl(socketPath);
    } catch (error) {
      fail('DAEMON_SOCKET_INVALID', 'Codex daemon control socket is missing', {
        socketPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!socketStat?.isSocket?.()) {
      fail('DAEMON_SOCKET_INVALID', 'Codex daemon control socket path is not a Unix socket', {
        socketPath,
      });
    }

    const settingsPath = this.options.settingsPath ?? settingsPathForSocket(socketPath);
    let settingsSource;
    try {
      settingsSource = await this.readFileImpl(settingsPath, 'utf8');
    } catch (error) {
      fail('REMOTE_CONTROL_DISABLED', 'Codex daemon remote-control settings are unavailable', {
        settingsPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    let settings;
    try {
      settings = JSON.parse(String(settingsSource));
    } catch (error) {
      fail('REMOTE_CONTROL_DISABLED', 'Codex daemon remote-control settings are invalid', {
        settingsPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    requirePlainObject(settings, 'REMOTE_CONTROL_DISABLED', 'Codex daemon settings');
    if (settings.remoteControlEnabled !== true) {
      fail('REMOTE_CONTROL_DISABLED', 'Codex daemon was not launched with remote control enabled', {
        settingsPath,
        remoteControlEnabled: settings.remoteControlEnabled ?? false,
      });
    }

    return Object.freeze({
      status: output.status,
      backend: output.backend,
      cliVersion: output.cliVersion,
      managedCodexVersion: output.managedCodexVersion,
      appServerVersion: output.appServerVersion,
      configuredCodexPath: resolved.command,
      configuredCodexIdentity: executable.snapshot.identity,
      managedCodexPath,
      managedCodexSha256: expectedArtifactSha256,
      artifactTarget,
      socketPath,
      settingsPath,
      remoteControlEnabled: true,
    });
  }

  async open(context = {}) {
    const resolved = this.#context(context);
    const inspection = await this.inspect(resolved);
    const executable = await this.#openPinnedExecutable(
      resolved.command,
      inspection.managedCodexSha256,
      'open:before-spawn',
      inspection.configuredCodexIdentity,
    );
    let child;
    try {
      child = resolved.spawnImpl(
        '/proc/self/fd/3',
        [
          ...resolved.commandArgs,
          'app-server',
          'proxy',
          '--sock',
          inspection.socketPath,
        ],
        {
          cwd: resolved.cwd,
          env: resolved.env,
          stdio: ['pipe', 'pipe', 'pipe', executable.handle.fd],
        },
      );
      await this.#verifyOpenExecutable(executable, 'open:after-spawn');
    } catch (error) {
      if (child?.exitCode == null && child?.signalCode == null) child?.kill?.('SIGTERM');
      if (error instanceof CodexDaemonTransportError) throw error;
      fail('PROXY_SPAWN_FAILED', 'Unable to spawn Codex app-server proxy', {
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await executable.handle.close().catch(() => undefined);
    }
    return upgradeProxy({
      child,
      randomBytesImpl: this.randomBytesImpl,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      maxPayloadBytes: this.maxPayloadBytes,
    });
  }
}

export function createCodexDaemonTransportFactory(options = {}) {
  const daemonTransport = new CodexDaemonTransport(options);
  return (context) => daemonTransport.open(context);
}
