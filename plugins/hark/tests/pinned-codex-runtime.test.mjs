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
  managedCodexBwrapPath,
  managedCodexCodeModeHostPath,
  managedCodexPath,
  sha256File,
  siblingCodexBwrapPath,
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
const MANAGED_BWRAP_SUFFIX = join(
  'packages',
  'standalone',
  'current',
  'codex-resources',
  'bwrap',
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

function expectedRuntimeSha256(filePath, {
  codexPath,
  codeModeHostPath,
  bwrapPath,
}) {
  if (filePath === codexPath) return PINNED_CODEX_RUNTIME.executableSha256;
  if (filePath === codeModeHostPath) {
    return PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256;
  }
  if (filePath === bwrapPath) return PINNED_CODEX_RUNTIME.bwrapExecutableSha256;
  throw new Error(`unexpected_runtime_path:${filePath}`);
}

async function writeExecutable(filePath, content) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  await chmod(filePath, 0o700);
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
    bwrapArchiveFilename: 'bwrap-x86_64-unknown-linux-musl.tar.gz',
    bwrapExecutableFilename: 'bwrap-x86_64-unknown-linux-musl',
    bwrapAssetUrl: 'https://github.com/openai/codex/releases/download/rust-v0.147.0/bwrap-x86_64-unknown-linux-musl.tar.gz',
    bwrapArchiveSha256: 'e73dc46e2ec7176499cb14e26c7b80b9d8e24a39cd51fe8fa0d45ddd8f6fb87c',
    bwrapExecutableSha256: '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c',
    managedBwrapRelativePath: MANAGED_BWRAP_SUFFIX,
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
  assert.equal(
    managedCodexBwrapPath('/tmp/codex-home'),
    join('/tmp/codex-home', MANAGED_BWRAP_SUFFIX),
  );
  assert.equal(
    siblingCodexBwrapPath('/tmp/codex-home/current/codex'),
    '/tmp/codex-home/current/codex-resources/bwrap',
  );
  assert.throws(
    () => siblingCodexBwrapPath('/tmp/codex-home/current/bin/codex'),
    isErrorCode('CODEX_PACKAGE_LAYOUT_UNSUPPORTED'),
  );
  assert.throws(
    () => siblingCodexBwrapPath('/tmp/codex-home/current/bin/./codex'),
    isErrorCode('CODEX_EXECUTABLE_PATH_NOT_NORMALIZED'),
  );
  assert.throws(
    () => siblingCodexBwrapPath('relative'),
    isErrorCode('CODEX_EXECUTABLE_PATH_INVALID'),
  );
});

test('rejects ambiguous bin layouts instead of certifying a different bubblewrap helper', async () => {
  await withTempDirectory(async (directory) => {
    const packageRoot = join(directory, 'package');
    const codexPath = join(packageRoot, 'bin', 'codex');
    const hostPath = join(packageRoot, 'bin', 'codex-code-mode-host');
    const executableShadow = join(packageRoot, 'bin', 'codex-resources', 'bwrap');
    const packageHelper = join(packageRoot, 'codex-resources', 'bwrap');
    await mkdir(packageRoot, { recursive: true });
    await Promise.all([
      writeExecutable(codexPath, 'codex'),
      writeExecutable(hostPath, 'host'),
      writeExecutable(executableShadow, 'unverified executable-directory shadow'),
      writeExecutable(packageHelper, 'unverified package helper'),
      writeFile(join(packageRoot, 'codex-package.json'), '{}'),
    ]);

    const verified = [];
    const verification = {
      verifyFileImpl: async (filePath, expected) => {
        verified.push(filePath);
        return expected;
      },
    };
    await assert.rejects(
      verifyPinnedCodexRuntime(`${packageRoot}/bin/./codex`, verification),
      isErrorCode('CODEX_EXECUTABLE_PATH_NOT_NORMALIZED'),
    );
    assert.deepEqual(verified, []);
    await assert.rejects(
      verifyPinnedCodexRuntime(codexPath, verification),
      isErrorCode('CODEX_PACKAGE_LAYOUT_UNSUPPORTED'),
    );
    assert.deepEqual(verified, [hostPath]);
  });
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

test('downloads, verifies, extracts, chmods, and no-clobber links the pinned runtime triple', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    const bwrapPath = managedCodexBwrapPath(codexHome);
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
      bwrapPath,
      bwrapSha256: PINNED_CODEX_RUNTIME.bwrapExecutableSha256,
    });
    assert.equal(await readFile(targetPath, 'utf8'), 'synthetic verified executable');
    assert.equal(await readFile(codeModeHostPath, 'utf8'), 'synthetic verified executable');
    assert.equal(await readFile(bwrapPath, 'utf8'), 'synthetic verified executable');
    assert.equal((await stat(targetPath)).mode & 0o777, 0o700);
    assert.equal((await stat(codeModeHostPath)).mode & 0o777, 0o700);
    assert.equal((await stat(bwrapPath)).mode & 0o777, 0o700);
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
      'download',
      'verify',
      'extract',
      'verify',
      'verify',
      'verify',
      'verify',
    ]);
    assert.deepEqual(events.filter(({ type }) => type === 'download').map(({ url }) => url), [
      PINNED_CODEX_RUNTIME.codeModeHostAssetUrl,
      PINNED_CODEX_RUNTIME.bwrapAssetUrl,
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
        expected: PINNED_CODEX_RUNTIME.bwrapArchiveSha256,
        mismatchCode: 'BWRAP_ARCHIVE_SHA256_MISMATCH',
      },
      {
        expected: PINNED_CODEX_RUNTIME.bwrapExecutableSha256,
        mismatchCode: 'BWRAP_EXECUTABLE_SHA256_MISMATCH',
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
        expected: PINNED_CODEX_RUNTIME.bwrapExecutableSha256,
        mismatchCode: 'BWRAP_TARGET_MISMATCH',
      },
      {
        expected: PINNED_CODEX_RUNTIME.executableSha256,
        mismatchCode: 'TARGET_MISMATCH',
      },
    ]);

    const extractions = events.filter(({ type }) => type === 'extract');
    assert.deepEqual(extractions.map(({ command }) => command), ['tar', 'tar', 'tar']);
    assert.deepEqual(extractions.map(({ args }) => args.slice(-3)), [
      ['--anchored', '--', PINNED_CODEX_RUNTIME.codeModeHostExecutableFilename],
      ['--anchored', '--', PINNED_CODEX_RUNTIME.bwrapExecutableFilename],
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

test('returns an exact preexisting runtime triple without downloading', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    const bwrapPath = managedCodexBwrapPath(codexHome);
    await writeExecutable(targetPath, 'already pinned');
    await writeExecutable(codeModeHostPath, 'already pinned host');
    await writeExecutable(bwrapPath, 'already pinned bwrap');
    let downloads = 0;
    const result = await installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async () => { downloads += 1; },
      hashFileImpl: async (filePath) => expectedRuntimeSha256(filePath, {
        codexPath: targetPath,
        codeModeHostPath,
        bwrapPath,
      }),
    });
    assert.equal(result.status, 'already_installed');
    assert.equal(result.path, targetPath);
    assert.equal(result.codeModeHostPath, codeModeHostPath);
    assert.equal(result.codeModeHostSha256, PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256);
    assert.equal(result.bwrapPath, bwrapPath);
    assert.equal(result.bwrapSha256, PINNED_CODEX_RUNTIME.bwrapExecutableSha256);
    assert.equal(downloads, 0);
  });
});

test('verifies the exact sibling runtime triple and fails closed on missing companions', async () => {
  await withTempDirectory(async (directory) => {
    const codexPath = join(directory, 'codex');
    const codeModeHostPath = join(directory, 'codex-code-mode-host');
    const bwrapPath = join(directory, 'codex-resources', 'bwrap');
    await writeFile(codexPath, 'codex');
    await chmod(codexPath, 0o700);
    await assert.rejects(
      verifyPinnedCodexRuntime(codexPath),
      isErrorCode('CODE_MODE_HOST_MISSING'),
    );
    await writeFile(codeModeHostPath, 'host');
    await chmod(codeModeHostPath, 0o700);
    await assert.rejects(
      verifyPinnedCodexRuntime(codexPath, {
        hashFileImpl: async () => PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256,
      }),
      isErrorCode('BWRAP_MISSING'),
    );
    await writeExecutable(bwrapPath, 'bwrap');
    const result = await verifyPinnedCodexRuntime(codexPath, {
      hashFileImpl: async (filePath) => expectedRuntimeSha256(filePath, {
        codexPath,
        codeModeHostPath,
        bwrapPath,
      }),
    });
    assert.deepEqual(result, {
      status: 'already_installed',
      path: codexPath,
      version: '0.147.0',
      sha256: PINNED_CODEX_RUNTIME.executableSha256,
      codeModeHostPath,
      codeModeHostSha256: PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256,
      bwrapPath,
      bwrapSha256: PINNED_CODEX_RUNTIME.bwrapExecutableSha256,
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

test('rejects a mismatched or symlinked bubblewrap helper before hashing Codex', async (t) => {
  await t.test('mismatched regular bubblewrap', async () => {
    await withTempDirectory(async (directory) => {
      const codexPath = join(directory, 'codex');
      const codeModeHostPath = join(directory, 'codex-code-mode-host');
      const bwrapPath = join(directory, 'codex-resources', 'bwrap');
      await writeExecutable(codexPath, 'codex');
      await writeExecutable(codeModeHostPath, 'host');
      await writeExecutable(bwrapPath, 'bwrap');
      let codexHashes = 0;
      await assert.rejects(verifyPinnedCodexRuntime(codexPath, {
        hashFileImpl: async (filePath) => {
          if (filePath === codeModeHostPath) {
            return PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256;
          }
          if (filePath === codexPath) codexHashes += 1;
          return '0'.repeat(64);
        },
      }), isErrorCode('BWRAP_TARGET_MISMATCH'));
      assert.equal(codexHashes, 0);
    });
  });

  await t.test('symlinked bubblewrap', async () => {
    await withTempDirectory(async (directory) => {
      const codexPath = join(directory, 'codex');
      const codeModeHostPath = join(directory, 'codex-code-mode-host');
      const bwrapPath = join(directory, 'codex-resources', 'bwrap');
      const elsewhere = join(directory, 'elsewhere');
      await writeExecutable(codexPath, 'codex');
      await writeExecutable(codeModeHostPath, 'host');
      await writeFile(elsewhere, 'bwrap');
      await mkdir(dirname(bwrapPath), { recursive: true });
      await symlink(elsewhere, bwrapPath);
      await assert.rejects(verifyPinnedCodexRuntime(codexPath, {
        hashFileImpl: async () => PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256,
      }), isErrorCode('BWRAP_TARGET_UNSAFE'));
    });
  });
});

test('rejects bubblewrap changing during verification', async () => {
  await withTempDirectory(async (directory) => {
    const codexPath = join(directory, 'codex');
    const codeModeHostPath = join(directory, 'codex-code-mode-host');
    const bwrapPath = join(directory, 'codex-resources', 'bwrap');
    await writeExecutable(codexPath, 'codex');
    await writeExecutable(codeModeHostPath, 'host');
    await writeExecutable(bwrapPath, 'bwrap');
    await assert.rejects(verifyPinnedCodexRuntime(codexPath, {
      hashFileImpl: async (filePath) => {
        if (filePath === codeModeHostPath) {
          return PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256;
        }
        if (filePath === bwrapPath) {
          await chmod(bwrapPath, 0o600);
          return PINNED_CODEX_RUNTIME.bwrapExecutableSha256;
        }
        return PINNED_CODEX_RUNTIME.executableSha256;
      },
    }), isErrorCode('BWRAP_CHANGED_DURING_VERIFICATION'));
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
      const bwrapPath = join(directory, 'codex-resources', 'bwrap');
      await writeFile(codexPath, 'codex', { mode: 0o600 });
      await writeFile(codeModeHostPath, 'host', { mode: 0o700 });
      await writeExecutable(bwrapPath, 'bwrap');
      await assert.rejects(verifyPinnedCodexRuntime(codexPath, {
        hashFileImpl: async (filePath) => expectedRuntimeSha256(filePath, {
          codexPath,
          codeModeHostPath,
          bwrapPath,
        }),
      }), isErrorCode('TARGET_NOT_EXECUTABLE'));
    });
  });

  await t.test('bubblewrap is not executable', async () => {
    await withTempDirectory(async (directory) => {
      const codexPath = join(directory, 'codex');
      const codeModeHostPath = join(directory, 'codex-code-mode-host');
      const bwrapPath = join(directory, 'codex-resources', 'bwrap');
      await writeFile(codexPath, 'codex', { mode: 0o700 });
      await writeFile(codeModeHostPath, 'host', { mode: 0o700 });
      await mkdir(dirname(bwrapPath), { recursive: true });
      await writeFile(bwrapPath, 'bwrap', { mode: 0o600 });
      await assert.rejects(verifyPinnedCodexRuntime(codexPath, {
        hashFileImpl: async (filePath) => expectedRuntimeSha256(filePath, {
          codexPath,
          codeModeHostPath,
          bwrapPath,
        }),
      }), isErrorCode('BWRAP_NOT_EXECUTABLE'));
    });
  });
});

test('repairs a v0.1.3 Codex and host tuple by installing only bubblewrap', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    const bwrapPath = managedCodexBwrapPath(codexHome);
    await writeExecutable(targetPath, 'already pinned');
    await writeExecutable(codeModeHostPath, 'already pinned host');
    const codexIdentity = await lstat(targetPath);
    const hostIdentity = await lstat(codeModeHostPath);
    const downloads = [];
    const result = await installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (url, archivePath) => {
        downloads.push(url);
        await writeFile(archivePath, 'synthetic archive');
      },
      runProcessImpl: extractionStub(),
      verifyFileImpl: successfulVerification(),
    });
    assert.equal(result.status, 'installed');
    assert.deepEqual(downloads, [PINNED_CODEX_RUNTIME.bwrapAssetUrl]);
    assert.equal(await readFile(targetPath, 'utf8'), 'already pinned');
    assert.equal(await readFile(codeModeHostPath, 'utf8'), 'already pinned host');
    assert.equal(await readFile(bwrapPath, 'utf8'), 'synthetic verified executable');
    assert.deepEqual(
      [(await lstat(targetPath)).dev, (await lstat(targetPath)).ino, (await lstat(targetPath)).size],
      [codexIdentity.dev, codexIdentity.ino, codexIdentity.size],
    );
    assert.deepEqual(
      [
        (await lstat(codeModeHostPath)).dev,
        (await lstat(codeModeHostPath)).ino,
        (await lstat(codeModeHostPath)).size,
      ],
      [hostIdentity.dev, hostIdentity.ino, hostIdentity.size],
    );
    assert.equal(result.path, targetPath);
    assert.equal(result.codeModeHostPath, codeModeHostPath);
    assert.equal(result.bwrapPath, bwrapPath);
    assert.equal(result.bwrapSha256, PINNED_CODEX_RUNTIME.bwrapExecutableSha256);
    const bwrapIdentity = await lstat(bwrapPath);
    const repeated = await installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (url) => { downloads.push(url); },
      verifyFileImpl: successfulVerification(),
    });
    assert.equal(repeated.status, 'already_installed');
    assert.deepEqual(downloads, [PINNED_CODEX_RUNTIME.bwrapAssetUrl]);
    assert.equal((await lstat(targetPath)).ino, codexIdentity.ino);
    assert.equal((await lstat(codeModeHostPath)).ino, hostIdentity.ino);
    assert.equal((await lstat(bwrapPath)).ino, bwrapIdentity.ino);
  });
});

test('repairs an exact Codex and bubblewrap partial tuple by installing only the host', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    const bwrapPath = managedCodexBwrapPath(codexHome);
    await writeExecutable(targetPath, 'already pinned');
    await writeExecutable(bwrapPath, 'already pinned bwrap');
    const codexInode = (await stat(targetPath)).ino;
    const bwrapInode = (await stat(bwrapPath)).ino;
    const downloads = [];
    const result = await installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (url, archivePath) => {
        downloads.push(url);
        await writeFile(archivePath, 'synthetic archive');
      },
      runProcessImpl: extractionStub(),
      verifyFileImpl: successfulVerification(),
    });
    assert.equal(result.status, 'installed');
    assert.deepEqual(downloads, [PINNED_CODEX_RUNTIME.codeModeHostAssetUrl]);
    assert.equal(await readFile(targetPath, 'utf8'), 'already pinned');
    assert.equal(await readFile(codeModeHostPath, 'utf8'), 'synthetic verified executable');
    assert.equal(await readFile(bwrapPath, 'utf8'), 'already pinned bwrap');
    assert.equal((await stat(targetPath)).ino, codexInode);
    assert.equal((await stat(bwrapPath)).ino, bwrapInode);
  });
});

test('repairs an exact host and bubblewrap partial tuple by installing only Codex', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    const bwrapPath = managedCodexBwrapPath(codexHome);
    await mkdir(dirname(codeModeHostPath), { recursive: true });
    await writeFile(codeModeHostPath, 'already pinned host');
    await chmod(codeModeHostPath, 0o700);
    await writeExecutable(bwrapPath, 'already pinned bwrap');
    const hostInode = (await stat(codeModeHostPath)).ino;
    const bwrapInode = (await stat(bwrapPath)).ino;
    const downloads = [];
    const result = await installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (url, archivePath) => {
        downloads.push(url);
        await writeFile(archivePath, 'synthetic archive');
      },
      runProcessImpl: extractionStub(),
      verifyFileImpl: successfulVerification(),
    });
    assert.equal(result.status, 'installed');
    assert.deepEqual(downloads, [PINNED_CODEX_RUNTIME.assetUrl]);
    assert.equal(await readFile(targetPath, 'utf8'), 'synthetic verified executable');
    assert.equal(await readFile(codeModeHostPath, 'utf8'), 'already pinned host');
    assert.equal(await readFile(bwrapPath, 'utf8'), 'already pinned bwrap');
    assert.equal((await stat(codeModeHostPath)).ino, hostInode);
    assert.equal((await stat(bwrapPath)).ino, bwrapInode);
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

test('rejects unsafe preexisting bubblewrap targets before download or overwrite', async (t) => {
  await t.test('mismatched regular target', async () => {
    await withTempDirectory(async (directory) => {
      const codexHome = join(directory, 'codex-home');
      const targetPath = managedCodexPath(codexHome);
      const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
      const bwrapPath = managedCodexBwrapPath(codexHome);
      await writeExecutable(targetPath, 'already pinned');
      await writeExecutable(codeModeHostPath, 'already pinned host');
      await writeExecutable(bwrapPath, 'do not replace');
      let downloads = 0;
      await assert.rejects(installPinnedCodexRuntime({
        codexHome,
        downloadFileImpl: async () => { downloads += 1; },
        hashFileImpl: async (filePath) => {
          if (filePath === bwrapPath) return '0'.repeat(64);
          return expectedRuntimeSha256(filePath, {
            codexPath: targetPath,
            codeModeHostPath,
            bwrapPath,
          });
        },
      }), isErrorCode('BWRAP_TARGET_MISMATCH'));
      assert.equal(downloads, 0);
      assert.equal(await readFile(bwrapPath, 'utf8'), 'do not replace');
    });
  });

  await t.test('symlinked target', async () => {
    await withTempDirectory(async (directory) => {
      const codexHome = join(directory, 'codex-home');
      const targetPath = managedCodexPath(codexHome);
      const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
      const bwrapPath = managedCodexBwrapPath(codexHome);
      const elsewhere = join(directory, 'elsewhere');
      await writeExecutable(targetPath, 'already pinned');
      await writeExecutable(codeModeHostPath, 'already pinned host');
      await writeFile(elsewhere, 'outside');
      await mkdir(dirname(bwrapPath), { recursive: true });
      await symlink(elsewhere, bwrapPath);
      let downloads = 0;
      await assert.rejects(installPinnedCodexRuntime({
        codexHome,
        downloadFileImpl: async () => { downloads += 1; },
        hashFileImpl: async (filePath) => expectedRuntimeSha256(filePath, {
          codexPath: targetPath,
          codeModeHostPath,
          bwrapPath,
        }),
      }), isErrorCode('BWRAP_TARGET_UNSAFE'));
      assert.equal(downloads, 0);
      assert.equal(await readFile(elsewhere, 'utf8'), 'outside');
    });
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

test('fails closed on bubblewrap archive and executable digest mismatches', async (t) => {
  await t.test('archive mismatch', async () => {
    await withTempDirectory(async (directory) => {
      const codexHome = join(directory, 'codex-home');
      const targetPath = managedCodexPath(codexHome);
      const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
      const bwrapPath = managedCodexBwrapPath(codexHome);
      await writeExecutable(targetPath, 'already pinned');
      await writeExecutable(codeModeHostPath, 'already pinned host');
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
        hashFileImpl: async (filePath) => {
          if (filePath === targetPath) return PINNED_CODEX_RUNTIME.executableSha256;
          if (filePath === codeModeHostPath) {
            return PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256;
          }
          return '0'.repeat(64);
        },
        mkdtempImpl: async (prefix) => {
          installTempDirectory = await mkdtemp(prefix);
          return installTempDirectory;
        },
      }), isErrorCode('BWRAP_ARCHIVE_SHA256_MISMATCH'));
      assert.equal(extractions, 0);
      await assert.rejects(lstat(installTempDirectory), { code: 'ENOENT' });
      await assert.rejects(lstat(bwrapPath), { code: 'ENOENT' });
    });
  });

  await t.test('extracted executable mismatch', async () => {
    await withTempDirectory(async (directory) => {
      const codexHome = join(directory, 'codex-home');
      const targetPath = managedCodexPath(codexHome);
      const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
      const bwrapPath = managedCodexBwrapPath(codexHome);
      await writeExecutable(targetPath, 'already pinned');
      await writeExecutable(codeModeHostPath, 'already pinned host');
      let installTempDirectory;
      await assert.rejects(installPinnedCodexRuntime({
        codexHome,
        downloadFileImpl: async (_url, archivePath) => {
          await writeFile(archivePath, 'synthetic archive');
        },
        runProcessImpl: extractionStub(),
        hashFileImpl: async (filePath) => {
          if (filePath === targetPath) return PINNED_CODEX_RUNTIME.executableSha256;
          if (filePath === codeModeHostPath) {
            return PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256;
          }
          if (filePath.endsWith('.tar.gz')) {
            return PINNED_CODEX_RUNTIME.bwrapArchiveSha256;
          }
          return '0'.repeat(64);
        },
        mkdtempImpl: async (prefix) => {
          installTempDirectory = await mkdtemp(prefix);
          return installTempDirectory;
        },
      }), isErrorCode('BWRAP_EXECUTABLE_SHA256_MISMATCH'));
      await assert.rejects(lstat(installTempDirectory), { code: 'ENOENT' });
      await assert.rejects(lstat(bwrapPath), { code: 'ENOENT' });
    });
  });
});

test('rejects a symlinked bubblewrap resource directory before atomic install', async () => {
  await withTempDirectory(async (directory) => {
    const codexHome = join(directory, 'codex-home');
    const targetPath = managedCodexPath(codexHome);
    const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
    const bwrapPath = managedCodexBwrapPath(codexHome);
    const externalResourceDirectory = join(directory, 'external-resources');
    await writeExecutable(targetPath, 'already pinned');
    await writeExecutable(codeModeHostPath, 'already pinned host');
    await mkdir(externalResourceDirectory);
    await symlink(externalResourceDirectory, dirname(bwrapPath));
    let links = 0;
    await assert.rejects(installPinnedCodexRuntime({
      codexHome,
      downloadFileImpl: async (_url, archivePath) => {
        await writeFile(archivePath, 'synthetic archive');
      },
      runProcessImpl: extractionStub(),
      verifyFileImpl: successfulVerification(),
      linkImpl: async () => { links += 1; },
    }), isErrorCode('BWRAP_TARGET_UNSAFE'));
    assert.equal(links, 0);
    assert.equal((await lstat(dirname(bwrapPath))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(externalResourceDirectory), []);
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
    const bwrapPath = managedCodexBwrapPath(codexHome);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(codeModeHostPath, 'already pinned host');
    await chmod(codeModeHostPath, 0o700);
    await writeExecutable(bwrapPath, 'already pinned bwrap');
    const hashFileImpl = async (filePath) => {
      if (filePath === codeModeHostPath) {
        return PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256;
      }
      if (filePath === bwrapPath) return PINNED_CODEX_RUNTIME.bwrapExecutableSha256;
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

test('bubblewrap no-clobber races reject mismatch and converge on an exact winner', async (t) => {
  await t.test('mismatched winner is preserved and rejected', async () => {
    await withTempDirectory(async (directory) => {
      const codexHome = join(directory, 'codex-home');
      const targetPath = managedCodexPath(codexHome);
      const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
      const bwrapPath = managedCodexBwrapPath(codexHome);
      await writeExecutable(targetPath, 'already pinned');
      await writeExecutable(codeModeHostPath, 'already pinned host');
      const hashFileImpl = async (filePath) => {
        if (filePath === targetPath) return PINNED_CODEX_RUNTIME.executableSha256;
        if (filePath === codeModeHostPath) {
          return PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256;
        }
        if (filePath === bwrapPath) return sha256File(filePath);
        return filePath.endsWith('.tar.gz')
          ? PINNED_CODEX_RUNTIME.bwrapArchiveSha256
          : PINNED_CODEX_RUNTIME.bwrapExecutableSha256;
      };
      await assert.rejects(installPinnedCodexRuntime({
        codexHome,
        downloadFileImpl: async (_url, archivePath) => {
          await writeFile(archivePath, 'synthetic archive');
        },
        runProcessImpl: extractionStub(),
        hashFileImpl,
        linkImpl: async (_source, destination) => {
          await writeFile(destination, 'raced mismatched bwrap', {
            flag: 'wx',
            mode: 0o700,
          });
          const error = new Error('exists');
          error.code = 'EEXIST';
          throw error;
        },
      }), isErrorCode('BWRAP_TARGET_MISMATCH'));
      assert.equal(await readFile(bwrapPath, 'utf8'), 'raced mismatched bwrap');
      assert.equal(await readFile(targetPath, 'utf8'), 'already pinned');
      assert.equal(await readFile(codeModeHostPath, 'utf8'), 'already pinned host');
    });
  });

  await t.test('exact winner converges without a second logical install', async () => {
    await withTempDirectory(async (directory) => {
      const codexHome = join(directory, 'codex-home');
      const targetPath = managedCodexPath(codexHome);
      const codeModeHostPath = managedCodexCodeModeHostPath(codexHome);
      const bwrapPath = managedCodexBwrapPath(codexHome);
      await writeExecutable(targetPath, 'already pinned');
      await writeExecutable(codeModeHostPath, 'already pinned host');
      const downloads = [];
      let links = 0;
      const result = await installPinnedCodexRuntime({
        codexHome,
        downloadFileImpl: async (url, archivePath) => {
          downloads.push(url);
          await writeFile(archivePath, 'synthetic archive');
        },
        runProcessImpl: extractionStub(),
        hashFileImpl: async (filePath) => {
          if (filePath === targetPath) return PINNED_CODEX_RUNTIME.executableSha256;
          if (filePath === codeModeHostPath) {
            return PINNED_CODEX_RUNTIME.codeModeHostExecutableSha256;
          }
          if (filePath.endsWith('.tar.gz')) return PINNED_CODEX_RUNTIME.bwrapArchiveSha256;
          return PINNED_CODEX_RUNTIME.bwrapExecutableSha256;
        },
        linkImpl: async (_source, destination) => {
          links += 1;
          await writeFile(destination, 'raced exact bwrap', { flag: 'wx', mode: 0o700 });
          const error = new Error('exists');
          error.code = 'EEXIST';
          throw error;
        },
      });
      assert.equal(result.status, 'already_installed');
      assert.equal(result.bwrapPath, bwrapPath);
      assert.equal(result.bwrapSha256, PINNED_CODEX_RUNTIME.bwrapExecutableSha256);
      assert.deepEqual(downloads, [PINNED_CODEX_RUNTIME.bwrapAssetUrl]);
      assert.equal(links, 1);
      assert.equal(await readFile(bwrapPath, 'utf8'), 'raced exact bwrap');
    });
  });
});
