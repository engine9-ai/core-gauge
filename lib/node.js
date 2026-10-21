/*
  Node deployment: one process that collects, logs to disk, and (when it has a
  database) loads the log on an interval.

    const gauge = await startGauge({ db: 'sqlite://./engine9.db', port: 8788 });
    await gauge.stop();

  Without a database the process is collector-only: settings come from a
  config object or file, and a separate `e9gauge load` (on whatever machine can
  reach both the log and the database) loads it. The collector never needs the
  database to answer.
*/
import http from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createCollector, serverKeyVerifier } from './collector.js';
import { createDiskLog } from './diskLog.js';
import { createSettingsSource } from './settings.js';
import { loadFromDisk } from './loader.js';

/** Parse a .env file; existing environment variables win. */
export function loadDotEnv(cwd = process.cwd(), env = process.env) {
  const file = path.join(cwd, '.env');
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
    if (env[key] === undefined) env[key] = value;
  }
  return out;
}

/** sqlite://./x.db is relative to the working directory, as in e9core. */
export function resolveDatabase(cwd, db) {
  const value = String(db || '');
  if (!value.startsWith('sqlite://') || value.includes(':memory:')) return value;
  const file = value.slice('sqlite://'.length);
  return path.isAbsolute(file) ? value : `sqlite://${path.join(cwd, file)}`;
}

/** Open a core PersonWorker on a connection string, with this checkout's plugins registered. */
export async function openWorker({ db, cwd = process.cwd(), accountId = process.env.E9_ACCOUNT_ID || 'local' } = {}) {
  const { ensureNodePluginRegistry } = await import('@engine9/core/plugins/node');
  ensureNodePluginRegistry({ cwd });
  const { default: PersonWorker } = await import('@engine9/core/PersonWorker');
  return new PersonWorker({ accountId, auth: { database_connection: resolveDatabase(cwd, db) } });
}

/**
 * @param {object} options
 * @param {string} [options.db]            connection string; omit for collector-only
 * @param {object} [options.worker]        an open PersonWorker (instead of db)
 * @param {object} [options.settings]      raw settings, used when there is no database
 * @param {number} [options.port=8788]
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.logDirectory]  overrides the log_directory setting
 * @param {number} [options.loadIntervalSeconds=30]  0 turns the loader off
 * @param {boolean} [options.trustProxy]   believe X-Forwarded-Proto and X-Forwarded-For
 * @param {object} [options.env=process.env]  SESSION_SECRET, GAUGE_SALT
 * @param {(line: string) => void} [options.logger]
 */
export async function startGauge(options = {}) {
  const {
    cwd = process.cwd(),
    port = 8788,
    host = '127.0.0.1',
    loadIntervalSeconds = 30,
    trustProxy = false,
    env = process.env,
    logger = (line) => console.error(line)
  } = options;

  const ownsWorker = !options.worker && Boolean(options.db);
  const worker = options.worker || (options.db ? await openWorker({ db: options.db, cwd }) : null);
  const source = createSettingsSource({
    settings: options.settings,
    worker,
    refreshMs: 60000,
    onError: (e) => logger(`gauge settings refresh failed (keeping last good): ${e.message}`)
  });
  const settings = await source.start();
  const directory = path.resolve(cwd, options.logDirectory || settings.logDirectory);

  const log = createDiskLog({ directory, fsync: settings.fsync });
  let verifyServerKey;
  if (worker) {
    const { SqlApiKeyStore } = await import('@engine9/core/auth');
    verifyServerKey = serverKeyVerifier(new SqlApiKeyStore({ worker }));
  }
  const collector = createCollector({
    settings: source,
    log,
    sessionSecret: env.SESSION_SECRET,
    salt: env.GAUGE_SALT,
    verifyServerKey,
    onError: (e) => logger(`gauge collector: ${e?.message || e}`)
  });
  if (!env.SESSION_SECRET) logger('gauge: SESSION_SECRET is not set, so hits are never linked to a person from a Core Session');
  if (!env.GAUGE_SALT) logger('gauge: GAUGE_SALT is not set; cookieless visitor ids will change when this process restarts');

  const server = http.createServer(collector.nodeHandler({ trustProxy }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();

  let loading = null;
  let loadTimer = null;
  const lastLoad = { at: null, result: null, error: null };
  async function load(extra = {}) {
    if (!worker) throw new Error('no database: this process is collector-only');
    if (loading) return loading;
    loading = loadFromDisk(worker, { directory, settings: await source.refresh(), ...extra })
      .then((result) => {
        lastLoad.at = new Date();
        lastLoad.result = result;
        lastLoad.error = null;
        return result;
      })
      .catch((e) => {
        lastLoad.error = e;
        logger(`gauge load failed (will retry): ${e.message}`);
        throw e;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }
  if (worker && loadIntervalSeconds > 0) {
    loadTimer = setInterval(() => load().catch(() => {}), loadIntervalSeconds * 1000);
    loadTimer.unref?.();
  }

  return {
    port: address.port,
    host: address.address,
    url: `http://${address.address}:${address.port}`,
    directory,
    collector,
    worker,
    load,
    lastLoad: () => ({ ...lastLoad }),
    stats: () => collector.stats,
    async stop() {
      if (loadTimer) clearInterval(loadTimer);
      source.stop();
      await new Promise((resolve) => server.close(resolve));
      if (loading) await loading.catch(() => {});
      await log.close();
      if (ownsWorker && typeof worker.destroyAll === 'function') await worker.destroyAll();
    }
  };
}

export default { startGauge, openWorker, loadDotEnv, resolveDatabase };
