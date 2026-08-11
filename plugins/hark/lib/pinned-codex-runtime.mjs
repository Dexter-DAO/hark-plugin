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
  codeModeHostArchiveFilename: 'codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz',
  codeModeHostExecutableFilename: 'codex-code-mode-host-x86_64-unknown-linux-musl',
  codeModeHostAssetUrl: 'https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz',
  codeModeHostArchiveSha256: '0146adfaac8363ec9fcdb5895f7624db5b2e8617a283887938b7fb97a1dd4356',
  codeModeHostExecutableSha256: '00ecf5d040865b97884c488883abd342581c2a432debe7a54e4646bceee3d2d6',
  managedCodeModeHostRelativePath: join(
    'packages',
    'standalone',
    'current',
    'codex-code-mode-host',
  ),
});

const CODEX_ARTIFACT = Object.freeze({
  label: 'Codex executable',
  archiveFilename: PINNED_CODEX_RUNTIME.archiveFilename,
  executableFilename: PINNED_CODEX_RUNTIME.executableFilename,
  assetUrl: PINNED_CODEX_RUNTIME.assetUrl,
  archiveSha256: PINNED_CODEX_RUNTIME.archiveSha256,
  executableSha256: PINNED_CODEX_RUNTIME.executableSha256,
  archiveMismatchCode: 'ARCHIVE_SHA256_MISMATCH',
  executableMismatchCode: 'EXECUTABLE_SHA256_MISMATCH',
  targetMismatchCode: 'TARGET_MISMATCH',
  targetUnsafeCode: 'TARGET_UNSAFE',
  targetNotExecutableCode: 'TARGET_NOT_EXECUTABLE',
  targetChangedCode: 'TARGET_CHANGED_DURING_VERIFICATION',
  targetMissingCode: 'TARGET_MISSING',
});

const CODE_MODE_HOST_ARTIFACT = Object.freeze({
  label: 'Codex code-mode host',
  archiveFilename: PINNED_CODEX_RUNTIME.codeModeHostArchiveFilename,
  executableFilename: PINNED_CODEX_RUNTIME.codeModeHostExecutableFilename,
  assetUrl: PINNED_CODEX_RUNTIME.codeModeHostAssetUrl,
  archiveSha256: PINNED_CODEX_RUNTIME.codeModeHostArchiveSha256,
  executableSha256: PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256,
  archiveMismatchCode: 'CODE_MODE_HOST_ARCHIVE_SHA256_MISMATCH',
  executableMismatchCode: 'CODE_MODE_HOST_EXECUTABLE_SHA256_MISMATCH',
  targetMismatchCode: 'CODE_MODE_HOST_TARGET_MISMATCH',
  targetUnsafeCode: 'CODE_MODE_HOST_TARGET_UNSAFE',
  targetNotExecutableCode: 'CODE_MODE_HOST_NOT_EXECUTABLE',
  targetChangedCode: 'CODE_MODE_HOST_CHANGED_DURING_VERIFICATION',
  targetMissingCode: 'CODE_MODE_HOST_MISSING',
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

export function managedCodexCodeModeHostPath(codexHome) {
  return join(
    requireAbsoluteDirectory(codexHome, 'CODEX_HOME'),
    PINNED_CODEX_RUNTIME.managedCodeModeHostRelativePath,
  );
}

export function siblingCodexCodeModeHostPath(codexPath) {
  if (typeof codexPath !== 'string' || codexPath.length === 0 || !isAbsolute(codexPath)) {
    fail('CODEX_EXECUTABLE_PATH_INVALID', 'Codex executable path must be absolute', { codexPath });
  }
  return join(dirname(codexPath), 'codex-code-mode-host');
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

async function inspectExistingTarget(targetPath, artifact, {
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
    fail(artifact.targetUnsafeCode, `Managed ${artifact.label} path is not a regular file`, {
      targetPath,
    });
  }
  if ((stat.mode & 0o111) === 0) {
    fail(artifact.targetNotExecutableCode, `Managed ${artifact.label} is not executable`, {
      targetPath,
      mode: stat.mode & 0o777,
    });
  }
  const identity = `${String(stat.dev)}:${String(stat.ino)}:${String(stat.size)}`;
  try {
    await verifyFileImpl(targetPath, artifact.executableSha256, {
      hashFileImpl,
      mismatchCode: artifact.targetMismatchCode,
      label: `Existing managed ${artifact.label}`,
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
  let verifiedStat;
  try {
    verifiedStat = await lstatImpl(targetPath);
  } catch (error) {
    fail(
      artifact.targetChangedCode,
      `Managed ${artifact.label} changed during verification`,
      { targetPath },
      { cause: error },
    );
  }
  const verifiedIdentity = `${String(verifiedStat.dev)}:${String(verifiedStat.ino)}:${String(verifiedStat.size)}`;
  if (
    !verifiedStat.isFile()
    || verifiedStat.isSymbolicLink?.()
    || (verifiedStat.mode & 0o111) === 0
    || verifiedIdentity !== identity
  ) {
    fail(artifact.targetChangedCode, `Managed ${artifact.label} changed during verification`, {
      targetPath,
    });
  }
  return {
    status: 'already_installed',
    path: targetPath,
    version: PINNED_CODEX_RUNTIME.version,
    sha256: artifact.executableSha256,
  };
}

function resolveCodexHome({ codexHome, env, homedirImpl }) {
  const configured = codexHome ?? env.CODEX_HOME ?? join(homedirImpl(), '.codex');
  return requireAbsoluteDirectory(configured, 'CODEX_HOME');
}

async function installMissingArtifact({
  artifact,
  targetPath,
  standaloneDirectory,
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
  const targetDirectory = dirname(targetPath);

  let tempDirectory;
  let outcome;
  let primaryError;
  try {
    tempDirectory = await mkdtempImpl(join(standaloneDirectory, '.hark-codex-install-'));
    await chmodImpl(tempDirectory, 0o700);
    const archivePath = join(tempDirectory, artifact.archiveFilename);
    const extractionDirectory = join(tempDirectory, 'extracted');
    await mkdirImpl(extractionDirectory, { mode: 0o700 });

    await downloadFileImpl(artifact.assetUrl, archivePath);
    await verifyFileImpl(archivePath, artifact.archiveSha256, {
      hashFileImpl,
      mismatchCode: artifact.archiveMismatchCode,
      label: `${artifact.label} release archive`,
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
        artifact.executableFilename,
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
      || extractedEntries[0] !== artifact.executableFilename
    ) {
      fail('ARCHIVE_CONTENT_INVALID', `${artifact.label} archive did not extract exactly one expected file`, {
        entries: [...extractedEntries].sort(),
      });
    }

    const extractedPath = join(
      extractionDirectory,
      artifact.executableFilename,
    );
    const extractedStat = await lstatImpl(extractedPath);
    if (!extractedStat.isFile() || extractedStat.isSymbolicLink?.()) {
      fail('ARCHIVE_CONTENT_INVALID', `Extracted ${artifact.label} is not a regular file`, {
        extractedPath,
      });
    }
    await verifyFileImpl(extractedPath, artifact.executableSha256, {
      hashFileImpl,
      mismatchCode: artifact.executableMismatchCode,
      label: `Extracted ${artifact.label}`,
    });
    await chmodImpl(extractedPath, 0o700);
    await mkdirImpl(targetDirectory, { recursive: true, mode: 0o700 });

    try {
      await linkImpl(extractedPath, targetPath);
    } catch (error) {
      if (!isAlreadyExists(error)) {
        fail(
          'INSTALL_FAILED',
          `Could not atomically install the pinned ${artifact.label}`,
          { targetPath },
          { cause: error },
        );
      }
      const raced = await inspectExistingTarget(targetPath, artifact, {
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
      sha256: artifact.executableSha256,
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
            `Pinned ${artifact.label} installed, but its exact temporary directory could not be removed`,
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

function combinedInstallOutcome(codex, codeModeHost) {
  return {
    status: codex.status === 'already_installed' && codeModeHost.status === 'already_installed'
      ? 'already_installed'
      : 'installed',
    path: codex.path,
    version: PINNED_CODEX_RUNTIME.version,
    sha256: codex.sha256,
    codeModeHostPath: codeModeHost.path,
    codeModeHostSha256: codeModeHost.sha256,
  };
}

export async function verifyPinnedCodexRuntime(codexPath, {
  verifyFileImpl = verifyFileSha256,
  hashFileImpl = sha256File,
  lstatImpl = nodeLstatPromise,
} = {}) {
  const codeModeHostPath = siblingCodexCodeModeHostPath(codexPath);
  const codeModeHost = await inspectExistingTarget(
    codeModeHostPath,
    CODE_MODE_HOST_ARTIFACT,
    { lstatImpl, verifyFileImpl, hashFileImpl },
  );
  if (!codeModeHost) {
    fail(CODE_MODE_HOST_ARTIFACT.targetMissingCode, 'Pinned Codex code-mode host is missing', {
      codeModeHostPath,
    });
  }
  const codex = await inspectExistingTarget(codexPath, CODEX_ARTIFACT, {
    lstatImpl,
    verifyFileImpl,
    hashFileImpl,
  });
  if (!codex) {
    fail(CODEX_ARTIFACT.targetMissingCode, 'Pinned Codex executable is missing', { codexPath });
  }
  return combinedInstallOutcome(codex, codeModeHost);
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
  const codexPath = managedCodexPath(resolvedCodexHome);
  const codeModeHostPath = managedCodexCodeModeHostPath(resolvedCodexHome);
  const inspectionDependencies = { lstatImpl, verifyFileImpl, hashFileImpl };
  const existingCodex = await inspectExistingTarget(
    codexPath,
    CODEX_ARTIFACT,
    inspectionDependencies,
  );
  const existingCodeModeHost = await inspectExistingTarget(
    codeModeHostPath,
    CODE_MODE_HOST_ARTIFACT,
    inspectionDependencies,
  );
  if (existingCodex && existingCodeModeHost) {
    return combinedInstallOutcome(existingCodex, existingCodeModeHost);
  }

  const standaloneDirectory = join(resolvedCodexHome, 'packages', 'standalone');
  await mkdirImpl(standaloneDirectory, { recursive: true, mode: 0o700 });
  const installDependencies = {
    standaloneDirectory,
    downloadFileImpl,
    runProcessImpl,
    verifyFileImpl,
    hashFileImpl,
    mkdirImpl,
    mkdtempImpl,
    chmodImpl,
    lstatImpl,
    readdirImpl,
    linkImpl,
    rmImpl,
  };

  // Install the tool host first. The Codex executable is the final readiness
  // latch on a fresh install; an interrupted run is safely repairable.
  const codeModeHost = existingCodeModeHost ?? await installMissingArtifact({
    ...installDependencies,
    artifact: CODE_MODE_HOST_ARTIFACT,
    targetPath: codeModeHostPath,
  });
  const codex = existingCodex ?? await installMissingArtifact({
    ...installDependencies,
    artifact: CODEX_ARTIFACT,
    targetPath: codexPath,
  });
  const verified = await verifyPinnedCodexRuntime(codexPath, inspectionDependencies);
  return {
    ...verified,
    status: codex.status === 'installed' || codeModeHost.status === 'installed'
      ? 'installed'
      : verified.status,
  };
}
