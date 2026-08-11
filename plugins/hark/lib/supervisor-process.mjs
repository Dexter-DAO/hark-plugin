import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { defaultHarkDataDir } from './journal.mjs';

const LOCK_HOST = '127.0.0.1';
const LOCK_PORT_BASE = 41_000;
const LOCK_PORT_SPAN = 20_000;
const LOCK_PROTOCOL = 'hark.codex-supervisor-process.v2';
const READY_PROTOCOL = 'hark.codex-supervisor-ready.v1';
const INSPECT_TIMEOUT_MS = 500;

function portForDataDir(dataDir) {
  const digest = createHash('sha256').update(dataDir).digest();
  return LOCK_PORT_BASE + (digest.readUInt32BE(0) % LOCK_PORT_SPAN);
}

function validMetadata(value, expectedPort) {
  return value
    && value.v === LOCK_PROTOCOL
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && value.port === expectedPort
    && typeof value.token === 'string'
    && /^[a-f0-9]{64}$/.test(value.token)
    && typeof value.startedAt === 'string'
    && Number.isFinite(Date.parse(value.startedAt));
}

async function writePrivateJson(filePath, value) {
  const directory = path.dirname(filePath);
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * A kernel-owned localhost listener is the actual singleton lock. The pid file
 * is informational only, so a crash cannot leave a stale lock behind.
 */
export class SupervisorProcessLock {
  constructor(dataDir = defaultHarkDataDir(), options = {}) {
    this.dataDir = path.resolve(dataDir);
    this.filePath = path.join(this.dataDir, 'hark-codex.pid');
    this.readyPath = path.join(this.dataDir, 'hark-codex.ready.json');
    this.host = options.host ?? LOCK_HOST;
    this.port = options.port ?? portForDataDir(this.dataDir);
    this.writeReadyJson = options.writeReadyJson ?? writePrivateJson;
    this.server = null;
    this.metadata = null;
  }

  async inspect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      let source = '';
      let settled = false;
      const finish = (error, value = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(null, {
        pid: null,
        alive: true,
        invalid: true,
        port: this.port,
      }), INSPECT_TIMEOUT_MS);
      timer.unref?.();
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write('inspect\n'));
      socket.on('data', (chunk) => {
        source += chunk;
        if (Buffer.byteLength(source) > 4096) {
          finish(null, { pid: null, alive: true, invalid: true, port: this.port });
          return;
        }
        const newline = source.indexOf('\n');
        if (newline < 0) return;
        try {
          const value = JSON.parse(source.slice(0, newline));
          finish(null, validMetadata(value, this.port)
            ? { ...value, alive: true }
            : { pid: null, alive: true, invalid: true, port: this.port });
        } catch {
          finish(null, { pid: null, alive: true, invalid: true, port: this.port });
        }
      });
      socket.once('error', (error) => {
        if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error?.code)) {
          finish(null, null);
        } else finish(error);
      });
      socket.once('end', () => {
        if (!settled) finish(null, { pid: null, alive: true, invalid: true, port: this.port });
      });
    });
  }

  async acquire() {
    if (this.server) return;
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const metadata = Object.freeze({
      v: LOCK_PROTOCOL,
      pid: process.pid,
      port: this.port,
      token: randomBytes(32).toString('hex'),
      startedAt: new Date().toISOString(),
    });
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let source = '';
      socket.on('data', (chunk) => {
        source += chunk;
        if (!source.includes('\n') && source.length <= 64) return;
        if (source === 'inspect\n') socket.end(`${JSON.stringify(metadata)}\n`);
        else socket.destroy();
      });
    });
    server.on('error', () => undefined);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error?.code === 'EADDRINUSE'
            ? new Error('hark_supervisor_already_running')
            : error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: this.host, port: this.port, exclusive: true });
      });
      await writePrivateJson(this.filePath, metadata);
      this.server = server;
      this.metadata = metadata;
    } catch (error) {
      await closeServer(server).catch(() => undefined);
      throw error;
    }
  }

  async markReady(details = {}) {
    if (!this.server || !this.metadata) throw new Error('hark_supervisor_lock_required');
    const server = this.server;
    const metadata = this.metadata;
    const ready = {
      ...details,
      v: READY_PROTOCOL,
      pid: metadata.pid,
      token: metadata.token,
      readyAt: new Date().toISOString(),
    };
    await this.writeReadyJson(this.readyPath, ready);
    if (this.server !== server || this.metadata !== metadata) {
      try {
        const current = JSON.parse(await readFile(this.readyPath, 'utf8'));
        if (current?.token === metadata.token) await unlink(this.readyPath);
      } catch (error) {
        if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      throw new Error('hark_supervisor_lock_lost_before_ready');
    }
    return ready;
  }

  async inspectReady() {
    const live = await this.inspect();
    if (!live || live.invalid) return null;
    try {
      const ready = JSON.parse(await readFile(this.readyPath, 'utf8'));
      if (
        ready?.v !== READY_PROTOCOL
        || ready.pid !== live.pid
        || ready.token !== live.token
        || typeof ready.readyAt !== 'string'
        || !Number.isFinite(Date.parse(ready.readyAt))
      ) return null;
      return { ...ready, alive: true };
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async release() {
    if (!this.server) return;
    const metadata = this.metadata;
    const server = this.server;
    this.server = null;
    this.metadata = null;
    await closeServer(server);
    try {
      const ready = JSON.parse(await readFile(this.readyPath, 'utf8'));
      if (ready?.token === metadata?.token) await unlink(this.readyPath);
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    try {
      const current = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (current?.token === metadata?.token) await unlink(this.filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
}

export function openSupervisorLogs(dataDir = defaultHarkDataDir()) {
  const directory = path.resolve(dataDir);
  const stdoutPath = path.join(directory, 'hark-codex.log');
  const stderrPath = path.join(directory, 'hark-codex-error.log');
  const stdout = openSync(stdoutPath, 'a', 0o600);
  const stderr = openSync(stderrPath, 'a', 0o600);
  return {
    stdout,
    stderr,
    stdoutPath,
    stderrPath,
    close() {
      closeSync(stdout);
      closeSync(stderr);
    },
  };
}
