import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const CODEX_APP_SERVER_COMPATIBILITY = Object.freeze({
  codexVersion: '0.147.0',
  schemaBundleSha256: 'ff10829cd75b67297019b39ab508ac699198574663579aa18336b7dc55ea178f',
  linuxMuslArchiveSha256: '0246e2e773834e07f0fb5249ed6ebad12e4591e608f8c7bb97dd6a9690544c36',
  linuxMuslBinarySha256: 'cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40',
  protocol: 'codex-app-server-v2',
});

export class AppServerProtocolError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = 'AppServerProtocolError';
    this.details = details;
  }
}

export class AppServerRpcError extends Error {
  constructor(method, error) {
    super(error?.message || `Codex App Server request failed: ${method}`);
    this.name = 'AppServerRpcError';
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
  }
}

function extractCodexVersion(output) {
  const match = String(output).match(/(?:codex-cli\s+)?(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppServerProtocolError(`${label} must be an object`, value);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppServerProtocolError(`${label} must be a non-empty string`, value);
  }
  return value;
}

function defaultVersionProbe({ command, commandArgs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, [...commandArgs, '--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new AppServerProtocolError(
          `Codex version probe exited with ${code}`,
          { stdout, stderr },
        ));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function defaultTransportFactory({ command, commandArgs, appServerArgs, spawnImpl, env, cwd }) {
  const child = spawnImpl(command, [...commandArgs, ...appServerArgs], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    process: child,
    close() {
      child.stdin?.end();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
  };
}

/**
 * Minimal, pinned JSONL client for Codex App Server v2.
 *
 * The transport may be a spawned `codex app-server` process, a daemon proxy,
 * or an injected test transport. It must expose writable `stdin`, readable
 * `stdout`, and may expose `stderr`, `process`, and `close()`.
 */
export class AppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.command = options.command ?? 'codex';
    this.commandArgs = options.commandArgs ?? [];
    this.appServerArgs = options.appServerArgs ?? ['app-server', '--listen', 'stdio://'];
    this.cwd = options.cwd;
    this.env = options.env ?? process.env;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.transportFactory = options.transportFactory ?? defaultTransportFactory;
    this.versionProbe = options.versionProbe ?? (() => defaultVersionProbe({
      command: this.command,
      commandArgs: this.commandArgs,
      spawnImpl: this.spawnImpl,
    }));
    this.expectedVersion = options.expectedVersion ?? CODEX_APP_SERVER_COMPATIBILITY.codexVersion;
    this.expectedSchemaDigest = options.expectedSchemaDigest
      ?? CODEX_APP_SERVER_COMPATIBILITY.schemaBundleSha256;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.clientInfo = options.clientInfo ?? {
      name: 'hark-codex-supervisor',
      title: 'Hark Codex Supervisor',
      version: '0.1.5',
    };

    this.transport = null;
    this.reader = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.started = false;
    this.closed = false;
    this.stderrTail = '';
    this.initializeResult = null;
  }

  async start() {
    if (this.started) return this.initializeResult;
    if (this.closed) throw new AppServerProtocolError('Codex App Server client is closed');
    if (this.expectedSchemaDigest !== CODEX_APP_SERVER_COMPATIBILITY.schemaBundleSha256) {
      throw new AppServerProtocolError('Unsupported Codex App Server schema digest', {
        expected: CODEX_APP_SERVER_COMPATIBILITY.schemaBundleSha256,
        received: this.expectedSchemaDigest,
      });
    }
    if (this.expectedVersion !== CODEX_APP_SERVER_COMPATIBILITY.codexVersion) {
      throw new AppServerProtocolError('Unsupported Codex version', {
        expected: CODEX_APP_SERVER_COMPATIBILITY.codexVersion,
        received: this.expectedVersion,
      });
    }

    const versionOutput = await this.versionProbe();
    const actualVersion = extractCodexVersion(versionOutput);
    if (actualVersion !== this.expectedVersion) {
      throw new AppServerProtocolError('Codex version gate failed', {
        expected: this.expectedVersion,
        actual: actualVersion,
        output: String(versionOutput),
      });
    }

    const transport = await this.transportFactory({
      command: this.command,
      commandArgs: this.commandArgs,
      appServerArgs: this.appServerArgs,
      cwd: this.cwd,
      env: this.env,
      spawnImpl: this.spawnImpl,
    });
    this.#bindTransport(transport);

    try {
      const result = await this.request('initialize', {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      });
      const initialized = requireObject(result, 'initialize result');
      requireString(initialized.userAgent, 'initialize result.userAgent');
      requireString(initialized.codexHome, 'initialize result.codexHome');
      requireString(initialized.platformFamily, 'initialize result.platformFamily');
      requireString(initialized.platformOs, 'initialize result.platformOs');
      this.initializeResult = initialized;
      this.notify('initialized', {});
      this.started = true;
      return initialized;
    } catch (error) {
      await this.close(error);
      throw error;
    }
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.transport || this.closed) {
      return Promise.reject(new AppServerProtocolError('Codex App Server transport is not open'));
    }
    requireString(method, 'request method');
    requireObject(params, 'request params');
    const id = this.nextRequestId++;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerProtocolError(`Codex App Server request timed out: ${method}`, { id }));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.#write(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (!this.transport || this.closed) {
      throw new AppServerProtocolError('Codex App Server transport is not open');
    }
    requireString(method, 'notification method');
    requireObject(params, 'notification params');
    this.#write({ method, params });
  }

  respondError(id, code, message, data = undefined) {
    if ((typeof id !== 'string' && typeof id !== 'number') || id === '') {
      throw new AppServerProtocolError('server request id must be a string or number', id);
    }
    if (!Number.isSafeInteger(code)) {
      throw new AppServerProtocolError('server response error code must be an integer', code);
    }
    requireString(message, 'server response error message');
    this.#write({
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    });
  }

  respondResult(id, result) {
    if ((typeof id !== 'string' && typeof id !== 'number') || id === '') {
      throw new AppServerProtocolError('server request id must be a string or number', id);
    }
    requireObject(result, 'server response result');
    this.#write({ id, result });
  }

  async listLoadedThreads({ cursor = null, limit = null } = {}) {
    const result = requireObject(
      await this.request('thread/loaded/list', { cursor, limit }),
      'thread/loaded/list result',
    );
    if (!Array.isArray(result.data)) {
      throw new AppServerProtocolError('thread/loaded/list result.data must be an array', result);
    }
    return result;
  }

  async readConfig({ cwd = null, includeLayers = false } = {}) {
    const result = requireObject(
      await this.request('config/read', { cwd, includeLayers }),
      'config/read result',
    );
    requireObject(result.config, 'config/read result.config');
    return result;
  }

  async listHooks({ cwds = [] } = {}) {
    if (!Array.isArray(cwds) || cwds.some((cwd) => typeof cwd !== 'string' || !cwd)) {
      throw new AppServerProtocolError('hooks/list cwds must be non-empty strings');
    }
    const result = requireObject(
      await this.request('hooks/list', { cwds }),
      'hooks/list result',
    );
    if (!Array.isArray(result.data)) {
      throw new AppServerProtocolError('hooks/list result.data must be an array', result);
    }
    return result;
  }

  async listMcpServerStatus({ detail = 'toolsAndAuthOnly' } = {}) {
    const result = requireObject(
      await this.request('mcpServerStatus/list', {
        cursor: null,
        limit: null,
        detail,
        threadId: null,
      }),
      'mcpServerStatus/list result',
    );
    if (!Array.isArray(result.data)) {
      throw new AppServerProtocolError('mcpServerStatus/list result.data must be an array', result);
    }
    return result;
  }

  async resumeThread(threadId, options = {}) {
    requireString(threadId, 'threadId');
    const result = requireObject(
      await this.request('thread/resume', { threadId, ...options }),
      'thread/resume result',
    );
    const resumedId = requireString(result.thread?.id, 'thread/resume result.thread.id');
    if (resumedId !== threadId) {
      throw new AppServerProtocolError('Codex resumed the wrong thread', {
        requested: threadId,
        resumed: resumedId,
      });
    }
    return result;
  }

  async readThread(threadId, { includeTurns = true } = {}) {
    requireString(threadId, 'threadId');
    const result = requireObject(
      await this.request('thread/read', { threadId, includeTurns }),
      'thread/read result',
    );
    const readId = requireString(result.thread?.id, 'thread/read result.thread.id');
    if (readId !== threadId) {
      throw new AppServerProtocolError('Codex read the wrong thread', {
        requested: threadId,
        read: readId,
      });
    }
    return result;
  }

  async unsubscribeThread(threadId) {
    requireString(threadId, 'threadId');
    return requireObject(
      await this.request('thread/unsubscribe', { threadId }),
      'thread/unsubscribe result',
    );
  }

  async interruptTurn(threadId, turnId) {
    requireString(threadId, 'threadId');
    requireString(turnId, 'turnId');
    return requireObject(
      await this.request('turn/interrupt', { threadId, turnId }),
      'turn/interrupt result',
    );
  }

  async startTurn(threadId, input, { clientUserMessageId, ...options } = {}) {
    requireString(threadId, 'threadId');
    requireString(clientUserMessageId, 'clientUserMessageId');
    const normalizedInput = typeof input === 'string'
      ? [{ type: 'text', text: input }]
      : input;
    if (!Array.isArray(normalizedInput) || normalizedInput.length === 0) {
      throw new AppServerProtocolError('turn/start input must be a non-empty array or string');
    }
    const result = requireObject(
      await this.request('turn/start', {
        threadId,
        clientUserMessageId,
        input: normalizedInput,
        ...options,
      }),
      'turn/start result',
    );
    requireString(result.turn?.id, 'turn/start result.turn.id');
    return result;
  }

  async close(reason = new AppServerProtocolError('Codex App Server client closed')) {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.reader?.close();
    this.reader = null;
    this.#failPending(reason instanceof Error ? reason : new AppServerProtocolError(String(reason)));
    const transport = this.transport;
    this.transport = null;
    if (!transport) return;
    try {
      if (typeof transport.close === 'function') await transport.close();
      else transport.stdin?.end();
    } catch {
      // The transport is already unusable; pending requests were failed above.
    }
  }

  #bindTransport(transport) {
    if (!transport?.stdin || !transport?.stdout) {
      throw new AppServerProtocolError('Transport must expose stdin and stdout streams');
    }
    this.transport = transport;
    transport.stdout.setEncoding?.('utf8');
    transport.stderr?.setEncoding?.('utf8');
    transport.stderr?.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-16_384);
      this.emit('stderr', String(chunk));
    });
    this.reader = createInterface({ input: transport.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.#handleLine(line));
    this.reader.on('close', () => this.#handleTransportClose());
    transport.process?.once?.('error', (error) => this.#handleTransportClose(error));
    transport.process?.once?.('close', (code, signal) => {
      this.#handleTransportClose(new AppServerProtocolError(
        'Codex App Server process closed',
        { code, signal, stderr: this.stderrTail },
      ));
    });
  }

  #write(message) {
    const line = `${JSON.stringify(message)}\n`;
    const writable = this.transport?.stdin;
    if (!writable || writable.destroyed || writable.writableEnded) {
      throw new AppServerProtocolError('Codex App Server stdin is closed');
    }
    writable.write(line);
  }

  #handleLine(line) {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      const protocolError = new AppServerProtocolError('Invalid JSONL from Codex App Server', {
        line,
        cause: error instanceof Error ? error.message : String(error),
      });
      this.#handleProtocolError(protocolError);
      return;
    }
    if (Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit('orphanResponse', message);
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new AppServerRpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      if (Object.hasOwn(message, 'id')) this.emit('serverRequest', message);
      else {
        if (!Number.isSafeInteger(message.emittedAtMs) || message.emittedAtMs < 0) {
          this.#handleProtocolError(new AppServerProtocolError(
            'Codex App Server notification emittedAtMs is missing or invalid',
            message,
          ));
          return;
        }
        const metadata = { emittedAtMs: message.emittedAtMs };
        this.emit('notification', message);
        this.emit(message.method, message.params, metadata);
      }
      return;
    }
    this.#handleProtocolError(new AppServerProtocolError(
      'Unrecognized Codex App Server message',
      message,
    ));
  }

  #handleProtocolError(error) {
    if (this.closed) return;
    this.emit('protocolError', error);
    // A malformed frame makes every subsequent response ambiguous. Fail all
    // in-flight work and tear down this short-lived connection immediately.
    void this.close(error);
  }

  #handleTransportClose(error = undefined) {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    const failure = error instanceof Error
      ? error
      : new AppServerProtocolError('Codex App Server transport closed', {
        stderr: this.stderrTail,
      });
    this.#failPending(failure);
    this.emit('close', failure);
  }

  #failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
