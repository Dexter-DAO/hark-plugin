import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
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
  managedCodexCodeModeHostPath,
  managedCodexPath,
  sha256File,
  siblingCodexCodeModeHostPath,
  streamDownloadToFile,
  verifyFileSha256,
  verifyPinnedCodexRuntime,
} from '../lib/pinned-codex-runtime.mjs';

const MANAGED_SUFFIX = join('packages', 'standalone', 'current', 'codex');
const MANAGED_HOST_SUFFIX = join(
  'packages',
  'standalone',
  'current',
  'codex-code-mode-host',
);

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
    const executableFilename = args.at(-1);
    await writeFile(join(extractionDirectory, executableFilename), 'synthetic verified executable');
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
    codeModeHostArchiveFilename: 'codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz',
    codeModeHostExecutableFilename: 'codex-code-mode-host-x86_64-unknown-linux-musl',
    codeModeHostAssetUrl: 'https://github.com/openai/codex/releases/download/rust-v0.147.0/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz',
    codeModeHostArchiveSha256: '0146adfaac8363ec9fcdb5895f7624db5b2e8617a283887938b7fb97a1dd4356',
    codeModeHostExecutableSha256: '00ecf5d040865b97884c488883abd342581c2a432debe7a54e4646bceee3d2d6',
    managedCodeModeHostRelativePath: MANAGED_HOST_SUFFIX,
  });
  assert.equal(
    managedCodexPath('/tmp/codex-home'),
    join('/tmp/codex-home', MANAGED_SUFFIX),
  );
  assert.throws(() => managedCodexPath('relative'), isErrorCode('CODEX_HOME_INVALID'));
  assert.equal(
    managedCodexCodeModeHostPath('/tmp/codex-home'),
    join('/tmp/codex-home', MANAGED_HOST_SUFFIX),
  );
  assert.equal(
    siblingCodexCodeModeHostPath('/tmp/codex-home/current/codex'),
    '/tmp/codex-home/current/codex-code-mode-host',
  );
  assert.throws(
    () => siblingCodexCodeModeHostPath('relative'),
    isErrorCode('CODEX_EXECUTABLE_PATH_INVALID'),
  );
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

test('downloads, verifies, extracts, chmods, and no-clobber links both pinned executables', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    const events = [];
    const verificationCalls = [];
    const installTempDirectories = [];

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
        const installTempDirectory = await mkdtemp(prefix);
        installTempDirectories.push(installTempDirectory);
        return installTempDirectory;
      },
    });

    assert.deepEqual(result, {
      status: 'installed',
      path: targetPath,
      version: '0.147.0',
      sha256: PINNED_CODEX_RUNTIME.executableSha256,
      codeModeHostPath,
      codeModeHostSha256: PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256,
    });
    assert.equal(await readFile(targetPath, 'utf8'), 'synthetic verified executable');
    assert.equal(await readFile(codeModeHostPath, 'utf8'), 'synthetic verified executable');
    assert.equal((await stat(targetPath)).mode & 0o777, 0o700);
    assert.equal((await stat(codeModeHostPath)).mode & 0o777, 0o700);
    for (const installTempDirectory of installTempDirectories) {
      await assert.rejects(lstat(installTempDirectory), { code: 'ENOENT' });
    }

    assert.deepEqual(events.map(({ type }) => type), [
      'download',
      'verify',
      'extract',
      'verify',
      'download',
      'verify',
      'extract',
      'verify',
      'verify',
      'verify',
    ]);
    assert.deepEqual(events.filter(({ type }) => type === 'download').map(({ url }) => url), [
      PINNED_CODEX_RUNTIME.codeModeHostAssetUrl,
      PINNED_CODEX_RUNTIME.assetUrl,
    ]);
    assert.deepEqual(verificationCalls.map(({ expected, options }) => ({
      expected,
      mismatchCode: options.mismatchCode,
    })), [
      {
        expected: PINNED_CODEX_RUNTIME.codeModeHostArchiveSha256,
        mismatchCode: 'CODE_MODE_HOST_ARCHIVE_SHA256_MISMATCH',
      },
      {
        expected: PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256,
        mismatchCode: 'CODE_MODE_HOST_EXECUTABLE_SHA256_MISMATCH',
      },
      {
        expected: PINNED_CODEX_RUNTIME.archiveSha256,
        mismatchCode: 'ARCHIVE_SHA256_MISMATCH',
      },
      {
        expected: PINNED_CODEX_RUNTIME.executableSha256,
        mismatchCode: 'EXECUTABLE_SHA256_MISMATCH',
      },
      {
        expected: PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256,
        mismatchCode: 'CODE_MODE_HOST_TARGET_MISMATCH',
      },
      {
        expected: PINNED_CODEX_RUNTIME.executableSha256,
        mismatchCode: 'TARGET_MISMATCH',
      },
    ]);

    const extractions = events.filter(({ type }) => type === 'extract');
    assert.deepEqual(extractions.map(({ command }) => command), ['tar', 'tar']);
    assert.deepEqual(extractions.map(({ args }) => args.slice(-3)), [
      ['--anchored', '--', PINNED_CODEX_RUNTIME.codeModeHostExecutableFilename],
      ['--anchored', '--', PINNED_CODEX_RUNTIME.executableFilename],
    ]);
    assert.deepEqual(
      extractions.map(({ options }) => options.cwd),
      installTempDirectories,
    );
    assert.equal(
      (await readdir(join(codexHome, 'packages', 'standalone')))
        .some((name) => name.startsWith('.hark-codex-install-')),
      false,
    );
  });
});

test('returns an exact preexisting runtime tuple without downloading', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, 'already pinned');
    await writeFile(codeModeHostPath, 'already pinned host');
    await chmod(targetPath, 0o700);
    await chmod(codeModeHostPath, 0o700);
    let downloads = 0;
    const result = await installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async () => { downloads += 1; },
      hashFileImpl: async (filePath) => (
        filePath === codeModeHostPath
          ? PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256
          : PINNED_CODEX_RUNTIME.executableSha256
      ),
    });
    assert.equal(result.status, 'already_installed');
    assert.equal(result.path, targetPath);
    assert.equal(result.codeModeHostPath, codeModeHostPath);
    assert.equal(downloads, 0);
  });
});

test('verifies the exact sibling runtime tuple and fails closed when the host is absent', async () => {
  await withTempDirectory(async (directory) => {
    const codexPath = join(directory, 'codex');
    const codeModeHostPath = join(directory, 'codex-code-mode-host');
    await writeFile(codexPath, 'codex');
    await chmod(codexPath, 0o700);
    await assert.rejects(
      verifyPinnedCodexRuntime(codexPath),
      isErrorCode('CODE_MODE_HOST_MISSING'),
    );
    await writeFile(codeModeHostPath, 'host');
    await chmod(codeModeHostPath, 0o700);
    const result = await verifyPinnedCodexRuntime(codexPath, {
      hashFileImpl: async (filePath) => (
        filePath === codeModeHostPath
          ? PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256
          : PINNED_CODEX_RUNTIME.executableSha256
      ),
    });
    assert.deepEqual(result, {
      status: 'already_installed',
      path: codexPath,
      version: '0.147.0',
      sha256: PINNED_CODEX_RUNTIME.executableSha256,
      codeModeHostPath,
      codeModeHostSha256: PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256,
    });
  });
});

test('rejects a mismatched or symlinked code-mode host before hashing Codex', async (t) => {
  await t.test('mismatched regular host', async () => {
    await withTempDirectory(async (directory) => {
      const codexPath = join(directory, 'codex');
      const codeModeHostPath = join(directory, 'codex-code-mode-host');
      await writeFile(codexPath, 'codex');
      await writeFile(codeModeHostPath, 'host');
      await chmod(codexPath, 0o700);
      await chmod(codeModeHostPath, 0o700);
      let codexHashes = 0;
      await assert.rejects(verifyPinnedCodexRuntime(codexPath, {
        hashFileImpl: async (filePath) => {
          if (filePath === codexPath) codexHashes += 1;
          return '0'.repeat(64);
        },
      }), isErrorCode('CODE_MODE_HOST_TARGET_MISMATCH'));
      assert.equal(codexHashes, 0);
    });
  });

  await t.test('symlinked host', async () => {
    await withTempDirectory(async (directory) => {
      const codexPath = join(directory, 'codex');
      const codeModeHostPath = join(directory, 'codex-code-mode-host');
      const elsewhere = join(directory, 'elsewhere');
      await writeFile(codexPath, 'codex');
      await chmod(codexPath, 0o700);
      await writeFile(elsewhere, 'host');
      await symlink(elsewhere, codeModeHostPath);
      await assert.rejects(
        verifyPinnedCodexRuntime(codexPath),
        isErrorCode('CODE_MODE_HOST_TARGET_UNSAFE'),
      );
    });
  });
});

test('rejects non-executable members of the pinned runtime tuple', async (t) => {
  await t.test('host is not executable', async () => {
    await withTempDirectory(async (directory) => {
      const codexPath = join(directory, 'codex');
      const codeModeHostPath = join(directory, 'codex-code-mode-host');
      await writeFile(codexPath, 'codex', { mode: 0o700 });
      await writeFile(codeModeHostPath, 'host', { mode: 0o600 });
      await assert.rejects(
        verifyPinnedCodexRuntime(codexPath),
        isErrorCode('CODE_MODE_HOST_NOT_EXECUTABLE'),
      );
    });
  });

  await t.test('Codex is not executable', async () => {
    await withTempDirectory(async (directory) => {
      const codexPath = join(directory, 'codex');
      const codeModeHostPath = join(directory, 'codex-code-mode-host');
      await writeFile(codexPath, 'codex', { mode: 0o600 });
      await writeFile(codeModeHostPath, 'host', { mode: 0o700 });
      await assert.rejects(verifyPinnedCodexRuntime(codexPath, {
        hashFileImpl: async (filePath) => (
          filePath === codeModeHostPath
            ? PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256
            : PINNED_CODEX_RUNTIME.executableSha256
        ),
      }), isErrorCode('TARGET_NOT_EXECUTABLE'));
    });
  });
});

test('repairs an exact preexisting Codex executable by installing only the missing host', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, 'already pinned');
    await chmod(targetPath, 0o700);
    const downloads = [];
    const result = await installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (url, archivePath) => {
        downloads.push(url);
        await writeFile(archivePath, 'synthetic archive');
      },
      runProcessImpl: extractionStub(),
      verifyFileImpl: successfulVerification(),
      hashFileImpl: async () => PINNED_CODEX_RUNTIME.executableSha256,
    });
    assert.equal(result.status, 'installed');
    assert.deepEqual(downloads, [PINNED_CODEX_RUNTIME.codeModeHostAssetUrl]);
    assert.equal(await readFile(targetPath, 'utf8'), 'already pinned');
    assert.equal(await readFile(codeModeHostPath, 'utf8'), 'synthetic verified executable');
  });
});

test('repairs an exact host-only partial tuple by installing only Codex', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    await mkdir(dirname(codeModeHostPath), { recursive: true });
    await writeFile(codeModeHostPath, 'already pinned host');
    await chmod(codeModeHostPath, 0o700);
    const hostInode = (await stat(codeModeHostPath)).ino;
    const downloads = [];
    const result = await installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (url, archivePath) => {
        downloads.push(url);
        await writeFile(archivePath, 'synthetic archive');
      },
      runProcessImpl: extractionStub(),
      verifyFileImpl: successfulVerification(),
      hashFileImpl: async () => PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256,
    });
    assert.equal(result.status, 'installed');
    assert.deepEqual(downloads, [PINNED_CODEX_RUNTIME.assetUrl]);
    assert.equal(await readFile(targetPath, 'utf8'), 'synthetic verified executable');
    assert.equal(await readFile(codeModeHostPath, 'utf8'), 'already pinned host');
    assert.equal((await stat(codeModeHostPath)).ino, hostInode);
  });
});

test('fails closed on a preexisting mismatched file and never downloads or overwrites it', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, 'do not replace');
    await chmod(targetPath, 0o700);
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
    }), isErrorCode('CODE_MODE_HOST_ARCHIVE_SHA256_MISMATCH'));
    assert.equal(extractions, 0);
    await assert.rejects(lstat(installTempDirectory), { code: 'ENOENT' });
    await assert.rejects(lstat(managedCodexPath(codexHome)), { code: 'ENOENT' });
    await assert.rejects(lstat(managedCodexCodeModeHostPath(codexHome)), { code: 'ENOENT' });
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
          ? PINNED_CODEX_RUNTIME.codeModeHostArchiveSha256
          : '0'.repeat(64);
      },
    }), isErrorCode('CODE_MODE_HOST_EXECUTABLE_SHA256_MISMATCH'));
    await assert.rejects(lstat(managedCodexPath(codexHome)), { code: 'ENOENT' });
    await assert.rejects(lstat(managedCodexCodeModeHostPath(codexHome)), { code: 'ENOENT' });
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
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(codeModeHostPath, 'already pinned host');
    await chmod(codeModeHostPath, 0o700);
    const hashFileImpl = async (filePath) => {
      if (filePath === codeModeHostPath) {
        return PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256;
      }
      if (filePath === targetPath) return sha256File(filePath);
      return filePath.endsWith('.tar.gz')
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
        await writeFile(destination, 'raced mismatched executable', {
          flag: 'wx',
          mode: 0o700,
        });
        const error = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      },
    }), isErrorCode('TARGET_MISMATCH'));
    assert.equal(await readFile(targetPath, 'utf8'), 'raced mismatched executable');
  });
});
