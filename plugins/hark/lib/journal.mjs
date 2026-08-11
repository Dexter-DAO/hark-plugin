import fs from 'node:fs';
import { open, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const JOURNAL_VERSION = 'hark.codex-journal.v1';

function clone(value) {
  return structuredClone(value);
}

function emptyJournal() {
  return {
    v: JOURNAL_VERSION,
    revision: 0,
    runtimeId: null,
    historyFloorMs: null,
    preparations: {},
    turnCompletions: {},
    awaits: {},
    wakes: {},
    violations: {},
    updatedAt: null,
  };
}

function assertJournal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== JOURNAL_VERSION) {
    throw new Error('hark_journal_invalid');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new Error('hark_journal_revision_invalid');
  }
  for (const key of ['preparations', 'turnCompletions', 'awaits', 'wakes', 'violations']) {
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) {
      throw new Error(`hark_journal_${key}_invalid`);
    }
  }
  return value;
}

export function defaultHarkDataDir() {
  const configured = process.env.HARK_DATA_DIR?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('hark_data_dir_must_be_absolute');
    return path.normalize(configured);
  }
  return path.join(os.homedir(), '.hark');
}

export class AtomicJsonStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.directory = path.dirname(this.filePath);
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(this.directory, 0o700);
  }

  async read(fallback) {
    await this.ensureDirectory();
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error?.code === 'ENOENT') return clone(fallback);
      throw error;
    }
  }

  async write(value) {
    await this.ensureDirectory();
    const tempPath = path.join(
      this.directory,
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, this.filePath);
    await fs.promises.chmod(this.filePath, 0o600);
    const directoryHandle = await open(this.directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}

export class HarkJournal {
  constructor(dataDir = defaultHarkDataDir()) {
    this.dataDir = path.resolve(dataDir);
    this.store = new AtomicJsonStore(path.join(this.dataDir, 'codex-journal.json'));
    this.queue = Promise.resolve();
  }

  async read() {
    return assertJournal(await this.store.read(emptyJournal()));
  }

  update(mutator) {
    const operation = this.queue.then(async () => {
      const current = clone(await this.read());
      const replacement = await mutator(current);
      const next = assertJournal(replacement ?? current);
      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();
      await this.store.write(next);
      return clone(next);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async ensureRuntimeId(createId) {
    const current = await this.read();
    if (typeof current.runtimeId === 'string' && current.runtimeId) return current.runtimeId;
    const runtimeId = createId();
    await this.update((journal) => {
      if (!journal.runtimeId) journal.runtimeId = runtimeId;
      return journal;
    });
    return (await this.read()).runtimeId;
  }

  async ensureHistoryFloor(nowMs) {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('history_floor_invalid');
    const current = await this.read();
    if (Number.isSafeInteger(current.historyFloorMs)) return current.historyFloorMs;
    await this.update((journal) => {
      if (!Number.isSafeInteger(journal.historyFloorMs)) journal.historyFloorMs = nowMs;
      return journal;
    });
    return (await this.read()).historyFloorMs;
  }

  recordPreparation(prepared, binding) {
    return this.update((journal) => {
      const nonce = prepared?.preparationNonce;
      if (typeof nonce !== 'string' || !nonce) throw new Error('preparation_nonce_required');
      const existing = journal.preparations[nonce];
      const next = { prepared, binding, state: 'observed', observedAt: new Date().toISOString() };
      if (existing && JSON.stringify(existing.prepared) !== JSON.stringify(prepared)) {
        throw new Error('preparation_replay_conflict');
      }
      if (existing && JSON.stringify(existing.binding) !== JSON.stringify(binding)) {
        throw new Error('preparation_binding_conflict');
      }
      journal.preparations[nonce] = existing ?? next;
      return journal;
    });
  }

  transitionPreparation(preparationNonce, expectedStates, patch) {
    return this.update((journal) => {
      const existing = journal.preparations[preparationNonce];
      if (!existing) throw new Error('preparation_not_found');
      if (!expectedStates.includes(existing.state)) {
        throw new Error(`preparation_state_conflict:${existing.state}`);
      }
      journal.preparations[preparationNonce] = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      return journal;
    });
  }

  recordTurnCompletion(event) {
    return this.update((journal) => {
      const threadId = event?.threadId;
      const turnId = event?.turn?.id;
      if (typeof threadId !== 'string' || !threadId) throw new Error('thread_id_required');
      if (typeof turnId !== 'string' || !turnId) throw new Error('turn_id_required');
      const sanitized = {
        threadId,
        turn: {
          id: turnId,
          status: event.turn.status,
          ...(Number.isFinite(event.turn.startedAt) ? { startedAt: event.turn.startedAt } : {}),
          ...(Number.isFinite(event.turn.completedAt) ? { completedAt: event.turn.completedAt } : {}),
        },
      };
      const existing = journal.turnCompletions[turnId];
      if (
        existing
        && (
          existing.event.threadId !== threadId
          || existing.event.turn.id !== turnId
          || existing.event.turn.status !== sanitized.turn.status
        )
      ) {
        throw new Error('turn_completion_replay_conflict');
      }
      journal.turnCompletions[turnId] = existing ?? {
        event: sanitized,
        observedAt: new Date().toISOString(),
      };
      return journal;
    });
  }

  removeTurnCompletion(turnId) {
    return this.update((journal) => {
      delete journal.turnCompletions[turnId];
      return journal;
    });
  }

  recordAwait(awaitRecord) {
    return this.update((journal) => {
      if (!awaitRecord?.id) throw new Error('await_id_required');
      const existing = journal.awaits[awaitRecord.id];
      if (existing?.checkpointDigest && existing.checkpointDigest !== awaitRecord.checkpointDigest) {
        throw new Error('await_checkpoint_conflict');
      }
      journal.awaits[awaitRecord.id] = { ...existing, ...awaitRecord };
      return journal;
    });
  }

  transitionAwait(awaitId, expectedStates, patch) {
    return this.update((journal) => {
      const existing = journal.awaits[awaitId];
      if (!existing) throw new Error('await_not_found');
      if (!expectedStates.includes(existing.state)) {
        throw new Error(`await_state_conflict:${existing.state}`);
      }
      journal.awaits[awaitId] = {
        ...existing,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      return journal;
    });
  }

  transitionWake(wakeId, expectedStates, patch) {
    return this.update((journal) => {
      const existing = journal.wakes[wakeId];
      const state = existing?.state ?? 'new';
      if (!expectedStates.includes(state)) throw new Error(`wake_state_conflict:${state}`);
      journal.wakes[wakeId] = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      return journal;
    });
  }

  recordViolation(awaitId, receipt) {
    return this.update((journal) => {
      if (typeof awaitId !== 'string' || !awaitId) throw new Error('await_id_required');
      const key = receipt?.sourceReceiptId;
      if (typeof key !== 'string' || !key) throw new Error('source_receipt_id_required');
      const existing = journal.violations[key];
      if (existing && JSON.stringify(existing.receipt) !== JSON.stringify(receipt)) {
        throw new Error('violation_receipt_conflict');
      }
      journal.violations[key] = existing ?? {
        awaitId,
        receipt,
        state: 'pending',
        recordedAt: new Date().toISOString(),
      };
      return journal;
    });
  }

  markViolationPosted(sourceReceiptId) {
    return this.update((journal) => {
      const existing = journal.violations[sourceReceiptId];
      if (!existing) throw new Error('violation_receipt_not_found');
      journal.violations[sourceReceiptId] = {
        ...existing,
        state: 'posted',
        postedAt: new Date().toISOString(),
      };
      return journal;
    });
  }
}

export async function removeHarkJournalForTest(dataDir) {
  const filePath = path.join(path.resolve(dataDir), 'codex-journal.json');
  try {
    await stat(filePath);
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
