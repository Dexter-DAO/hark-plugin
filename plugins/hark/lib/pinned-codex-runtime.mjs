import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream as nodeCreateReadStream,
  createWriteStream as nodeCreateWriteStream,
} from 'node:fs';
import {
  chmod as nodeChmodPromise,
  link as nodeLinkPromise,
  lstat as nodeLstatPromise,
  mkdir as nodeMkdirPromise,
  mkdtemp as nodeMkdtempPromise,
  readdir as nodeReaddirPromise,
  rm as nodeRmPromise,
} from 'node:fs/promises';
import { homedir as nodeHomedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline as nodePipeline } from 'node:stream/promises';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const EXTRACTION_TIMEOUT_MS = 60_000;

export const PINNED_CODEX_RUNTIME = Object.freeze({
  version: '0.147.0',
  platform: 'linux',
  arch: 'x64',
  archiveFilename: 'codex-x86_64-unknown-linux-musl.tar.gz',
  executableFilename: 'codex-x86_64-unknown-linux-musl',
  assetUrl: 'https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-x86_64-unknown-linux-musl.tar.gz',
  archiveSha256: '0246e2e773834e07f0fb5249ed6ebad12e4591e608f8c7bb97dd6a9690544c36',
  executableSha256: 'cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40',
  managedRelativePath: join('packages', 'standalone', 'current', 'codex'),
});

export class PinnedCodexRuntimeError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = 'PinnedCodexRuntimeError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = undefined, options = undefined) {
  throw new PinnedCodexRuntimeError(code, message, details, options);
}

function requireAbsoluteDirectory(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    fail('CODEX_HOME_INVALID', `${label} must be an absolute path`, { value });
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('SHA256_INVALID', `${label} must be a lowercase SHA-256 digest`, { value });
  }
  return value;
}

function isNotFound(error) {
  return error && typeof error === 'object' && error.code === 'ENOENT';
}

function isAlreadyExists(error) {
  return error && typeof error === 'object' && error.code === 'EEXIST';
}

function asNodeReadable(body) {
  if (body && typeof body.getReader === 'function') {
    return Readable.fromWeb(body);
  }
  if (body && typeof body.pipe === 'function') {
    return body;
  }
  fail('DOWNLOAD_FAILED', 'Codex release response did not contain a readable body');
}

function createByteLimit(maxBytes) {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += Buffer.byteLength(chunk);
      if (received > maxBytes) {
        callback(new PinnedCodexRuntimeError(
          'DOWNLOAD_TOO_LARGE',
          'Codex release archive exceeded the download size limit',
          { maxBytes, received },
        ));
        return;
      }
      callback(null, chunk);
    },
  });
}

export function managedCodexPath(codexHome) {
  return join(
    requireAbsoluteDirectory(codexHome, 'CODEX_HOME'),
    PINNED_CODEX_RUNTIME.managedRelativePath,
  );
}

export async function sha256File(
  filePath,
  { createReadStreamImpl = nodeCreateReadStream } = {},
) {
  const hash = createHash('sha256');
  const input = createReadStreamImpl(filePath);
  for await (const chunk of input) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function verifyFileSha256(
  filePath,
  expectedSha256,
  {
    hashFileImpl = undefined,
    createReadStreamImpl = undefined,
    mismatchCode = 'SHA256_MISMATCH',
    label = 'File',
  } = {},
) {
  const expected = requireSha256(expectedSha256, `${label} expected digest`);
  const actual = await (hashFileImpl ?? sha256File)(
    filePath,
    createReadStreamImpl ? { createReadStreamImpl } : undefined,
  );
  requireSha256(actual, `${label} computed digest`);
  if (actual !== expected) {
    fail(mismatchCode, `${label} failed SHA-256 verification`, {
      path: filePath,
      expected,
      actual,
    });
  }
  return actual;
}

export async function streamDownloadToFile(
  url,
  destinationPath,
  {
    fetchImpl = globalThis.fetch,
    createWriteStreamImpl = nodeCreateWriteStream,
    pipelineImpl = nodePipeline,
    maxBytes = MAX_DOWNLOAD_BYTES,
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    fail('DOWNLOAD_UNAVAILABLE', 'No Fetch implementation is available for the Codex release');
  }
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'hark-pinned-codex-runtime/1' },
    });
  } catch (error) {
    fail(
      'DOWNLOAD_FAILED',
      'Could not download the pinned Codex release archive',
      { url },
      { cause: error },
    );
  }
  if (!response || response.ok !== true) {
    fail('DOWNLOAD_FAILED', 'Pinned Codex release download returned a non-success response', {
      url,
      status: response?.status ?? null,
    });
  }
  const output = createWriteStreamImpl(destinationPath, {
    flags: 'wx',
    mode: 0o600,
  });
  try {
    await pipelineImpl(
      asNodeReadable(response.body),
      createByteLimit(maxBytes),
      output,
    );
  } catch (error) {
    if (error instanceof PinnedCodexRuntimeError) throw error;
    fail(
      'DOWNLOAD_FAILED',
      'Could not persist the pinned Codex release archive',
      { url, destinationPath },
      { cause: error },
    );
  }
}

async function defaultRunProcess(command, args, {
  cwd,
  spawnImpl = nodeSpawn,
  timeoutMs = EXTRACTION_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        stdio: ['ignore', 'pipe', 'pipe'],
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
      reject(new PinnedCodexRuntimeError(
        'EXTRACTION_TIMEOUT',
        'Timed out extracting the pinned Codex release archive',
        { timeoutMs },
      ));
    }, timeoutMs);
    timer.unref?.();

    const append = (current, chunk) => {
      const next = `${current}${String(chunk)}`;
      if (Buffer.byteLength(next) > MAX_PROCESS_OUTPUT_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill?.('SIGTERM');
          reject(new PinnedCodexRuntimeError(
            'EXTRACTION_OUTPUT_TOO_LARGE',
            'Codex archive extraction output exceeded the size limit',
          ));
        }
        return current;
      }
      return next;
    };

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
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

async function inspectExistingTarget(targetPath, {
  lstatImpl,
  verifyFileImpl,
  hashFileImpl,
}) {
  let stat;
  try {
    stat = await lstatImpl(targetPath);
  } catch (error) {
    if (isNotFound(error)) return null;
    fail(
      'TARGET_INSPECTION_FAILED',
      'Could not inspect the managed Codex runtime path',
      { targetPath },
      { cause: error },
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink?.()) {
    fail('TARGET_UNSAFE', 'Managed Codex runtime path is not a regular file', {
      targetPath,
    });
  }
  try {
    await verifyFileImpl(targetPath, PINNED_CODEX_RUNTIME.executableSha256, {
      hashFileImpl,
      mismatchCode: 'TARGET_MISMATCH',
      label: 'Existing managed Codex executable',
    });
  } catch (error) {
    if (error instanceof PinnedCodexRuntimeError) throw error;
    fail(
      'TARGET_INSPECTION_FAILED',
      'Could not verify the managed Codex runtime path',
      { targetPath },
      { cause: error },
    );
  }
  return {
    status: 'already_installed',
    path: targetPath,
    version: PINNED_CODEX_RUNTIME.version,
    sha256: PINNED_CODEX_RUNTIME.executableSha256,
  };
}

function resolveCodexHome({ codexHome, env, homedirImpl }) {
  const configured = codexHome ?? env.CODEX_HOME ?? join(homedirImpl(), '.codex');
  return requireAbsoluteDirectory(configured, 'CODEX_HOME');
}

export async function installPinnedCodexRuntime({
  codexHome = undefined,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  homedirImpl = nodeHomedir,
  downloadFileImpl = streamDownloadToFile,
  runProcessImpl = defaultRunProcess,
  verifyFileImpl = verifyFileSha256,
  hashFileImpl = sha256File,
  mkdirImpl = nodeMkdirPromise,
  mkdtempImpl = nodeMkdtempPromise,
  chmodImpl = nodeChmodPromise,
  lstatImpl = nodeLstatPromise,
  readdirImpl = nodeReaddirPromise,
  linkImpl = nodeLinkPromise,
  rmImpl = nodeRmPromise,
} = {}) {
  if (platform !== PINNED_CODEX_RUNTIME.platform || arch !== PINNED_CODEX_RUNTIME.arch) {
    fail('UNSUPPORTED_PLATFORM', 'Pinned Codex runtime is only certified for Linux x64', {
      expectedPlatform: PINNED_CODEX_RUNTIME.platform,
      expectedArch: PINNED_CODEX_RUNTIME.arch,
      actualPlatform: platform,
      actualArch: arch,
    });
  }

  const resolvedCodexHome = resolveCodexHome({ codexHome, env, homedirImpl });
  const targetPath = managedCodexPath(resolvedCodexHome);
  const existing = await inspectExistingTarget(targetPath, {
    lstatImpl,
    verifyFileImpl,
    hashFileImpl,
  });
  if (existing) return existing;

  const standaloneDirectory = join(resolvedCodexHome, 'packages', 'standalone');
  const targetDirectory = dirname(targetPath);
  await mkdirImpl(standaloneDirectory, { recursive: true, mode: 0o700 });

  let tempDirectory;
  let outcome;
  let primaryError;
  try {
    tempDirectory = await mkdtempImpl(join(standaloneDirectory, '.hark-codex-install-'));
    await chmodImpl(tempDirectory, 0o700);
    const archivePath = join(tempDirectory, PINNED_CODEX_RUNTIME.archiveFilename);
    const extractionDirectory = join(tempDirectory, 'extracted');
    await mkdirImpl(extractionDirectory, { mode: 0o700 });

    await downloadFileImpl(PINNED_CODEX_RUNTIME.assetUrl, archivePath);
    await verifyFileImpl(archivePath, PINNED_CODEX_RUNTIME.archiveSha256, {
      hashFileImpl,
      mismatchCode: 'ARCHIVE_SHA256_MISMATCH',
      label: 'Codex release archive',
    });

    let extractionResult;
    try {
      extractionResult = await runProcessImpl('tar', [
        '-xzf',
        archivePath,
        '--directory',
        extractionDirectory,
        '--no-same-owner',
        '--no-same-permissions',
        '--anchored',
        '--',
        PINNED_CODEX_RUNTIME.executableFilename,
      ], { cwd: tempDirectory });
    } catch (error) {
      if (error instanceof PinnedCodexRuntimeError) throw error;
      fail(
        'EXTRACTION_FAILED',
        'Could not extract the pinned Codex release archive',
        undefined,
        { cause: error },
      );
    }
    if (!extractionResult || extractionResult.code !== 0) {
      fail('EXTRACTION_FAILED', 'Pinned Codex release archive extraction failed', {
        code: extractionResult?.code ?? null,
        signal: extractionResult?.signal ?? null,
        stderr: String(extractionResult?.stderr ?? ''),
      });
    }

    const extractedEntries = await readdirImpl(extractionDirectory);
    if (
      extractedEntries.length !== 1
      || extractedEntries[0] !== PINNED_CODEX_RUNTIME.executableFilename
    ) {
      fail('ARCHIVE_CONTENT_INVALID', 'Codex release archive did not extract exactly one expected file', {
        entries: [...extractedEntries].sort(),
      });
    }

    const extractedPath = join(
      extractionDirectory,
      PINNED_CODEX_RUNTIME.executableFilename,
    );
    const extractedStat = await lstatImpl(extractedPath);
    if (!extractedStat.isFile() || extractedStat.isSymbolicLink?.()) {
      fail('ARCHIVE_CONTENT_INVALID', 'Extracted Codex executable is not a regular file', {
        extractedPath,
      });
    }
    await verifyFileImpl(extractedPath, PINNED_CODEX_RUNTIME.executableSha256, {
      hashFileImpl,
      mismatchCode: 'EXECUTABLE_SHA256_MISMATCH',
      label: 'Extracted Codex executable',
    });
    await chmodImpl(extractedPath, 0o700);
    await mkdirImpl(targetDirectory, { recursive: true, mode: 0o700 });

    try {
      await linkImpl(extractedPath, targetPath);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        fail(
          'INSTALL_FAILED',
          'Could not atomically install the pinned Codex executable',
          { targetPath },
          { cause: error },
        );
      }
      const raced = await inspectExistingTarget(targetPath, {
        lstatImpl,
        verifyFileImpl,
        hashFileImpl,
      });
      if (!raced) {
        fail('INSTALL_RACE_LOST', 'Managed Codex runtime disappeared during installation', {
          targetPath,
        });
      }
      outcome = raced;
    }

    outcome ??= {
      status: 'installed',
      path: targetPath,
      version: PINNED_CODEX_RUNTIME.version,
      sha256: PINNED_CODEX_RUNTIME.executableSha256,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (tempDirectory) {
      try {
        await rmImpl(tempDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        if (!primaryError) {
          primaryError = new PinnedCodexRuntimeError(
            'TEMP_CLEANUP_FAILED',
            'Pinned Codex runtime installed, but its exact temporary directory could not be removed',
            { tempDirectory, targetPath },
            { cause: cleanupError },
          );
        }
      }
    }
  }
  if (primaryError) throw primaryError;
  return outcome;
}
