/*
  Install the gauge plugin, first installing the plugins it depends on.

  Core's install checks `metadata.dependencies` but does not install them. A
  site set up by `e9core setup` has the person schemas but not
  @engine9/schemas/timeline, and on Cloudflare nothing else can install it (a
  Node process cannot open D1). So both `e9gauge install --db` and the Worker's
  POST /admin/install go through here: every declared dependency that has no
  plugin row is installed, its own dependencies first, then gauge.
*/
import { GAUGE_PLUGIN_PATH } from './settings.js';
import { forgetSchemaFeatures } from './loader.js';

async function installedPaths(worker) {
  const rows = typeof worker.list === 'function' ? await worker.list() : [];
  return new Set(rows.map((row) => row.path));
}

async function dependenciesOf(worker, pluginPath) {
  const plugin = await worker.compilePlugin({ path: pluginPath });
  return Object.keys(plugin?.metadata?.dependencies || {});
}

/**
 * @param {object} worker  a core PersonWorker
 * @returns {Promise<{ plugin: object, dependencies: string[] }>}  dependencies: paths installed now, in order
 */
export async function installGauge(worker) {
  const installed = await installedPaths(worker);
  const added = [];
  const visiting = new Set();
  async function ensure(pluginPath) {
    if (installed.has(pluginPath) || visiting.has(pluginPath)) return;
    visiting.add(pluginPath);
    for (const dep of await dependenciesOf(worker, pluginPath)) await ensure(dep);
    await worker.install({ path: pluginPath, unique: true });
    installed.add(pluginPath);
    added.push(pluginPath);
  }
  for (const dep of await dependenciesOf(worker, GAUGE_PLUGIN_PATH)) await ensure(dep);
  const plugin = await worker.install({ path: GAUGE_PLUGIN_PATH, unique: true });
  forgetSchemaFeatures(worker);
  return { plugin, dependencies: added };
}

export default { installGauge };
