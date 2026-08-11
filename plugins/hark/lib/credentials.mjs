import { stat } from 'node:fs/promises';
import path from 'node:path';

import { AtomicJsonStore, defaultHarkDataDir } from './journal.mjs';

const CREDENTIALS_VERSION = 'hark.codex-credentials.v1';

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}_required`);
  return value;
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hark_credentials_invalid');
  }
  if (value.v !== CREDENTIALS_VERSION) throw new Error('hark_credentials_version_invalid');
  requiredString(value.apiBaseUrl, 'api_base_url');
  requiredString(value.accessToken, 'access_token');
  const installation = value.installation;
  if (!installation || typeof installation !== 'object' || Array.isArray(installation)) {
    throw new Error('installation_required');
  }
  requiredString(installation.id, 'installation_id');
  if (installation.protocol !== 'codex') throw new Error('installation_protocol_invalid');
  requiredString(installation.runtimeId, 'runtime_id');
  return value;
}

export class HarkCredentialsStore {
  constructor(dataDir = defaultHarkDataDir()) {
    this.filePath = path.join(path.resolve(dataDir), 'credentials.json');
    this.store = new AtomicJsonStore(this.filePath);
  }

  async read() {
    let value;
    try {
      value = await this.store.read(null);
    } catch (error) {
      throw new Error('hark_credentials_unreadable', { cause: error });
    }
    if (value === null) return null;
    const metadata = await stat(this.filePath);
    if ((metadata.mode & 0o077) !== 0) throw new Error('hark_credentials_permissions_unsafe');
    return validate(value);
  }

  async save({ apiBaseUrl, accessToken, installation }) {
    const value = validate({
      v: CREDENTIALS_VERSION,
      apiBaseUrl: requiredString(apiBaseUrl, 'api_base_url'),
      accessToken: requiredString(accessToken, 'access_token'),
      installation: {
        id: requiredString(installation?.id, 'installation_id'),
        protocol: installation?.protocol,
        runtimeId: requiredString(installation?.runtimeId, 'runtime_id'),
        ...(installation?.name ? { name: installation.name } : {}),
      },
      savedAt: new Date().toISOString(),
    });
    await this.store.write(value);
    return value;
  }
}

export { CREDENTIALS_VERSION };
