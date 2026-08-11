import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  PINNED_CODEX_RUNTIME,
  PinnedCodexRuntimeError,
  installPinnedCodexRuntime,
  managedCodexPath,
  sha256File,
  streamDownloadToFile,
  verifyFileSha256,
} from '../lib/pinned-codex-runtime.mjs';

const MANAGED_SUFFIX = join('packages', 'standalone', 'current', 'codex');

function isErrorCode(code) {
  return (error) => error instanceof PinnedCodexRuntimeError && error.code === code;
}

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'hark-pinned-codex-test-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function successfulVerification(calls = []) {
  return async (path, expected, options) => {
    calls.push({ path, expected, options });
    return expected;
  };
}

function extractionStub(events = []) {
  return async (command, args, options) => {
    events.push({ type: 'extract', command, args, options });
    const directoryIndex = args.indexOf('--directory');
    assert.notEqual(directoryIndex, -1);
    const extractionDirectory = args[directoryIndex + 1];
    await writeFile(
      join(extractionDirectory, PINNED_CODEX_RUNTIME.executableFilename),
      'synthetic verified executable',
    );
    return { code: 0, signal: null, stdout: '', stderr: '' };
  };
}

test('pins the official Linux x64 release and exact managed daemon path', () => {
  assert.deepEqual(PINNED_CODEX_RUNTIME, {
    version: '0.147.0',
    platform: 'linux',
    arch: 'x64',
    archiveFilename: 'codex-x86_64-unknown-linux-musl.tar.gz',
    executableFilename: 'codex-x86_64-unknown-linux-musl',
    assetUrl: 'https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-x86_64-unknown-linux-musl.tar.gz',
    archiveSha256: '0246e2e773834e07f0fb5249ed6ebad12e4591e608f8c7bb97dd6a9690544c36',
    executableSha256: 'cb0a15567e9a60a5820d54b0f6ae86d504dc3805c1eab21a47f70e3eb7b73a40',
    managedRelativePath: MANAGED_SUFFIX,
  });
  assert.equal(
    managedCodexPath('/tmp/codex-home'),
    join('/tmp/codex-home', MANAGED_SUFFIX),
  );
  assert.throws(() => managedCodexPath('relative'), isErrorCode('CODEX_HOME_INVALID'));
});

test('hashes files as a stream and verifies exact SHA-256 values', async () => {
  await withTempDirectory(async (directory) => {
    const filePath = join(directory, 'fixture.bin');
    const content = Buffer.from('streamed hash fixture');
    await writeFile(filePath, content);
    const expected = createHash('sha256').update(content).digest('hex');
    let streamCreations = 0;
    assert.equal(await sha256File(filePath, {
      createReadStreamImpl: (path) => {
        streamCreations += 1;
        return createReadStream(path, { highWaterMark: 3 });
      },
    }), expected);
    assert.equal(streamCreations, 1);
    assert.equal(await verifyFileSha256(filePath, expected), expected);
    await assert.rejects(
      verifyFileSha256(filePath, '0'.repeat(64), {
        mismatchCode: 'FIXTURE_MISMATCH',
        label: 'Fixture',
      }),
      isErrorCode('FIXTURE_MISMATCH'),
    );
  });
});

test('streams a download into a private no-clobber archive without network access', async () => {
  await withTempDirectory(async (directory) => {
    const destination = join(directory, 'archive.tar.gz');
    const fetchCalls = [];
    await streamDownloadToFile('https://example.invalid/archive', destination, {
      fetchImpl: async (...args) => {
        fetchCalls.push(args);
        return {
          ok: true,
          status: 200,
          body: Readable.from([Buffer.from('one'), Buffer.from('two')]),
        };
      },
      maxBytes: 6,
    });
    assert.equal(await readFile(destination, 'utf8'), 'onetwo');
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0][1].redirect, 'follow');
    await assert.rejects(
      streamDownloadToFile('https://example.invalid/archive', destination, {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          body: Readable.from(['replacement']),
        }),
      }),
      isErrorCode('DOWNLOAD_FAILED'),
    );
    assert.equal(await readFile(destination, 'utf8'), 'onetwo');
  });
});

test('stops a streamed download at the bounded archive size', async () => {
  await withTempDirectory(async (directory) => {
    const destination = join(directory, 'oversized.tar.gz');
    await assert.rejects(streamDownloadToFile(
      'https://example.invalid/oversized',
      destination,
      {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          body: Readable.from(['1234', '5678']),
        }),
        maxBytes: 7,
      },
    ), isErrorCode('DOWNLOAD_TOO_LARGE'));
  });
});

test('rejects unsupported platform and architecture before download or filesystem setup', async () => {
  let downloads = 0;
  let directories = 0;
  for (const [platform, arch] of [['darwin', 'x64'], ['linux', 'arm64']]) {
    await assert.rejects(installPinnedCodexRuntime({
      codexHome: '/tmp/never-created',
      platform,
      arch,
      downloadFileImpl: async () => { downloads += 1; },
      mkdirImpl: async () => { directories += 1; },
    }), isErrorCode('UNSUPPORTED_PLATFORM'));
  }
  assert.equal(downloads, 0);
  assert.equal(directories, 0);
});

test('downloads, verifies, extracts, chmods, and atomically links the pinned executable', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const events = [];
    const verificationCalls = [];
    let installTempDirectory;

    const result = await installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (url, archivePath) => {
        events.push({ type: 'download', url, archivePath });
        await writeFile(archivePath, 'synthetic archive');
      },
      runProcessImpl: extractionStub(events),
      verifyFileImpl: async (...args) => {
        events.push({ type: 'verify', path: args[0] });
        return successfulVerification(verificationCalls)(...args);
      },
      mkdtempImpl: async (prefix) => {
        installTempDirectory = await mkdtemp(prefix);
        return installTempDirectory;
      },
    });

    assert.deepEqual(result, {
      status: 'installed',
      path: targetPath,
      version: '0.147.0',
      sha256: PINNED_CODEX_RUNTIME.executableSha256,
    });
    assert.equal(await readFile(targetPath, 'utf8'), 'synthetic verified executable');
    assert.equal((await stat(targetPath)).mode & 0o777, 0o700);
    await assert.rejects(lstat(installTempDirectory), { code: 'ENOENT' });

    assert.deepEqual(events.map(({ type }) => type), [
      'download',
      'verify',
      'extract',
      'verify',
    ]);
    assert.equal(events[0].url, PINNED_CODEX_RUNTIME.assetUrl);
    assert.deepEqual(verificationCalls.map(({ expected, options }) => ({
      expected,
      mismatchCode: options.mismatchCode,
    })), [
      {
        expected: PINNED_CODEX_RUNTIME.archiveSha256,
        mismatchCode: 'ARCHIVE_SHA256_MISMATCH',
      },
      {
        expected: PINNED_CODEX_RUNTIME.executableSha256,
        mismatchCode: 'EXECUTABLE_SHA256_MISMATCH',
      },
    ]);

    const extraction = events.find(({ type }) => type === 'extract');
    assert.equal(extraction.command, 'tar');
    assert.deepEqual(extraction.args.slice(-3), [
      '--anchored',
      '--',
      PINNED_CODEX_RUNTIME.executableFilename,
    ]);
    assert.equal(extraction.options.cwd, installTempDirectory);
    assert.equal(
      (await readdir(join(codexHome, 'packages', 'standalone')))
        .some((name) => name.startsWith('.hark-codex-install-')),
      false,
    );
  });
});

test('returns an exact preexisting executable without downloading', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, 'already pinned');
    let downloads = 0;
    const result = await installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async () => { downloads += 1; },
      hashFileImpl: async () => PINNED_CODEX_RUNTIME.executableSha256,
    });
    assert.equal(result.status, 'already_installed');
    assert.equal(result.path, targetPath);
    assert.equal(downloads, 0);
  });
});

test('fails closed on a preexisting mismatched file and never downloads or overwrites it', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, 'do not replace');
    let downloads = 0;
    await assert.rejects(installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async () => { downloads += 1; },
    }), isErrorCode('TARGET_MISMATCH'));
    assert.equal(downloads, 0);
    assert.equal(await readFile(targetPath, 'utf8'), 'do not replace');
  });
});

test('rejects a preexisting symlink before downloading', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const elsewhere = join(directory, 'elsewhere');
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(elsewhere, 'outside');
    await symlink(elsewhere, targetPath);
    let downloads = 0;
    await assert.rejects(installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async () => { downloads += 1; },
    }), isErrorCode('TARGET_UNSAFE'));
    assert.equal(downloads, 0);
    assert.equal(await readFile(elsewhere, 'utf8'), 'outside');
  });
});

test('verifies the archive before extraction and cleans the exact temp directory on mismatch', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    let extractions = 0;
    let installTempDirectory;
    await assert.rejects(installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (_url, archivePath) => {
        await writeFile(archivePath, 'wrong archive');
      },
      runProcessImpl: async () => {
        extractions += 1;
        return { code: 0 };
      },
      mkdtempImpl: async (prefix) => {
        installTempDirectory = await mkdtemp(prefix);
        return installTempDirectory;
      },
    }), isErrorCode('ARCHIVE_SHA256_MISMATCH'));
    assert.equal(extractions, 0);
    await assert.rejects(lstat(installTempDirectory), { code: 'ENOENT' });
    await assert.rejects(lstat(managedCodexPath(codexHome)), { code: 'ENOENT' });
  });
});

test('verifies the extracted executable before installing it', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    let hashCalls = 0;
    await assert.rejects(installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (_url, archivePath) => {
        await writeFile(archivePath, 'synthetic archive');
      },
      runProcessImpl: extractionStub(),
      hashFileImpl: async () => {
        hashCalls += 1;
        return hashCalls === 1
          ? PINNED_CODEX_RUNTIME.archiveSha256
          : '0'.repeat(64);
      },
    }), isErrorCode('EXECUTABLE_SHA256_MISMATCH'));
    await assert.rejects(lstat(managedCodexPath(codexHome)), { code: 'ENOENT' });
  });
});

test('rejects extra extracted content rather than broadening the archive boundary', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    await assert.rejects(installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (_url, archivePath) => {
        await writeFile(archivePath, 'synthetic archive');
      },
      verifyFileImpl: successfulVerification(),
      runProcessImpl: async (_command, args) => {
        const extractionDirectory = args[args.indexOf('--directory') + 1];
        await writeFile(
          join(extractionDirectory, PINNED_CODEX_RUNTIME.executableFilename),
          'binary',
        );
        await writeFile(join(extractionDirectory, 'unexpected'), 'rogue');
        return { code: 0, signal: null, stdout: '', stderr: '' };
      },
    }), isErrorCode('ARCHIVE_CONTENT_INVALID'));
    await assert.rejects(lstat(managedCodexPath(codexHome)), { code: 'ENOENT' });
  });
});

test('losing the atomic no-clobber race preserves and rejects a mismatched winner', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const hashFileImpl = async (path) => {
      if (path === targetPath) return sha256File(path);
      return path.endsWith('.tar.gz')
        ? PINNED_CODEX_RUNTIME.archiveSha256
        : PINNED_CODEX_RUNTIME.executableSha256;
    };
    await assert.rejects(installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (_url, archivePath) => {
        await writeFile(archivePath, 'synthetic archive');
      },
      runProcessImpl: extractionStub(),
      hashFileImpl,
      linkImpl: async (_source, destination) => {
        await writeFile(destination, 'raced mismatched executable', { flag: 'wx' });
        const error = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      },
    }), isErrorCode('TARGET_MISMATCH'));
    assert.equal(await readFile(targetPath, 'utf8'), 'raced mismatched executable');
  });
});
