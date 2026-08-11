import assert from 'node:assert/strict';
import { chmod, mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HarkCredentialsStore } from '../lib/credentials.mjs';

const credential = {
  apiBaseUrl: 'https://api.dexter.cash',
  accessToken: 'hki_secret',
  installation: { id: 'installation-1', protocol: 'codex', runtimeId: 'runtime-1' },
};

test('stores credentials privately and reads them after restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-credentials-'));
  const store = new HarkCredentialsStore(directory);
  await store.save(credential);
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  assert.equal((await new HarkCredentialsStore(directory).read()).accessToken, 'hki_secret');
});

test('rejects an existing credential file with unsafe permissions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-credentials-'));
  const store = new HarkCredentialsStore(directory);
  await store.save(credential);
  await chmod(store.filePath, 0o644);
  await assert.rejects(store.read(), /hark_credentials_permissions_unsafe/);
});

test('rejects a non-Codex installation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hark-credentials-'));
  await assert.rejects(
    new HarkCredentialsStore(directory).save({
      ...credential, installation: { ...credential.installation, protocol: 'hermes' },
    }),
    /installation_protocol_invalid/,
  );
});
