import './setup-plugins.js';
import PersonWorker from '@engine9/core/PersonWorker';
import { GAUGE_PLUGIN_PATH } from '../lib/settings.js';

export const STREAM = { id: 'G-test', name: 'test.example.com', type: 'web_stream', hosts: ['test.example.com'] };

/** In-memory SQLite worker with the standard stack and gauge installed. */
export async function createGaugeWorker({ settings = {} } = {}) {
  const worker = new PersonWorker({ accountId: 'test', auth: { database_connection: 'sqlite://:memory:' } });
  await worker.installDefaultPlugins({ path: '@engine9/schemas/stacks/standard' });
  const plugin = await worker.install({ path: GAUGE_PLUGIN_PATH, unique: true });
  const all = { streams: JSON.stringify([STREAM]), ...settings };
  for (const [name, value] of Object.entries(all)) {
    await worker.setSetting({
      pluginId: plugin.id,
      name,
      value: typeof value === 'string' ? value : JSON.stringify(value)
    });
  }
  return { worker, plugin };
}

export async function rows(worker, sql, values = []) {
  const { data } = await worker.query({ sql, values });
  return data;
}
