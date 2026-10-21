/*
  e9gauge: set up, run and check a gauge deployment.

    e9gauge install   --db sqlite://./engine9.db [--with-standard]
    e9gauge install   --url https://www.example.com/g --key e9key_…      (a deployed Cloudflare Worker)
    e9gauge stream    add|list|remove  [--id G-www] [--name www.example.com] [--type web_stream] [--hosts a.com,b.com]
    e9gauge custom    add|list|remove  --name video_upload [--label …] [--pin] [--entry-type SEARCH] [--props size_mb:number,format:string]
    e9gauge settings  [--json]
    e9gauge set       <setting> <value>
    e9gauge serve     [--db …] [--port 8788] [--host 127.0.0.1] [--log-dir ./gauge-logs] [--interval 30] [--config gauge.config.json] [--trust-proxy]
    e9gauge load      --db … [--max-records 50000]
    e9gauge replay    --db … --from YYYY-MM-DD
    e9gauge tail      [--log-dir …] [-n 20] [--follow]
    e9gauge doctor    [--db …] [--log-dir …]
    e9gauge erase-logs --person-id 12 | --email someone@example.com | --email-hash <sha256>  [--db …] [--include-open]

  The database is --db or ENGINE9_DATABASE_CONNECTION (also read from ./.env),
  the same as `e9core`. SESSION_SECRET and GAUGE_SALT come from the environment.

  install, stream, custom, settings and set also work against a deployed Worker
  with --url (the collector's base URL) and --key (an admin key, or
  E9_ADMIN_API_KEY): D1 cannot be opened from here, so the Worker does it.
*/
import { parseArgs } from 'node:util';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import {
  GAUGE_PLUGIN_PATH,
  findGaugePlugin,
  readRawSettings,
  readSettings,
  writeSetting,
  parseSettings,
  isValidCustomName,
  normalizeStreams,
  normalizeCustomEntries,
  validateSettingValue
} from './settings.js';
import { settings as SETTING_DEFS } from '../gauge/settings.js';
import { loadFromDisk, resetFrom } from './loader.js';
import { listSegments, readSegment, segmentHour } from './diskLog.js';
import { eraseFromLog } from './erase.js';
import { emailHashV1 } from './privacy.js';
import { resolveEntryType } from './entryTypes.js';
import { loadDotEnv, openWorker, startGauge } from './node.js';

const OPTIONS = {
  db: { type: 'string' },
  url: { type: 'string' },
  key: { type: 'string' },
  id: { type: 'string' },
  name: { type: 'string' },
  type: { type: 'string' },
  hosts: { type: 'string' },
  label: { type: 'string' },
  pin: { type: 'boolean' },
  'entry-type': { type: 'string' },
  props: { type: 'string' },
  port: { type: 'string' },
  host: { type: 'string' },
  'log-dir': { type: 'string' },
  interval: { type: 'string' },
  config: { type: 'string' },
  'trust-proxy': { type: 'boolean' },
  'max-records': { type: 'string' },
  from: { type: 'string' },
  n: { type: 'string', short: 'n' },
  follow: { type: 'boolean', short: 'f' },
  json: { type: 'boolean' },
  'with-standard': { type: 'boolean' },
  'person-id': { type: 'string' },
  email: { type: 'string' },
  'email-hash': { type: 'string' },
  'include-open': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }
};

class UsageError extends Error {}

const HELP = `e9gauge: measurement for engine9 core

  install        add the gauge plugin to a database (--with-standard installs the person and timeline schemas first)
                 or, with --url and --key, to the database of a deployed Worker
  stream         add | list | remove data streams (one per site or app)
  custom         add | list | remove declared custom entries
  settings       show every setting and its value
  set            set <setting> <value>
  serve          run the collector (and the loader, with a database)
  load           load the disk log into the database once
  replay         forget what was derived from a date and load the log again (--from YYYY-MM-DD)
  tail           print the newest hits from the disk log
  doctor         check configuration, the log directory and the load backlog
  erase-logs     remove a person from the disk log (run erasePeople for the database)

--db or ENGINE9_DATABASE_CONNECTION chooses the database. See docs/deploy.md.`;

function db(values, env) {
  return values.db || env.ENGINE9_DATABASE_CONNECTION || '';
}

async function worker(values, ctx, { required = true } = {}) {
  const conn = db(values, ctx.env);
  if (!conn) {
    if (required) throw new UsageError('no database: pass --db or set ENGINE9_DATABASE_CONNECTION');
    return null;
  }
  return openWorker({ db: conn, cwd: ctx.cwd });
}

async function withWorker(values, ctx, fn) {
  const w = await worker(values, ctx);
  try {
    return await fn(w);
  } finally {
    if (typeof w.destroyAll === 'function') await w.destroyAll();
  }
}

async function requirePlugin(w) {
  const plugin = await findGaugePlugin(w);
  if (!plugin) throw new UsageError(`${GAUGE_PLUGIN_PATH} is not installed in this database; run: e9gauge install`);
  return plugin;
}

/** A deployed Worker, reached over HTTP with an admin key (see lib/cloudflare.js). */
function remoteBackend({ url, key, fetch: doFetch }) {
  const base = String(url).replace(/\/+$/, '');
  async function call(method, route, body) {
    let res;
    try {
      res = await doFetch(`${base}${route}`, {
        method,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      throw new UsageError(`cannot reach ${base}: ${e.message}`);
    }
    const text = await res.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    if (res.status < 200 || res.status >= 300) throw new UsageError(`${method} ${route} answered ${res.status}: ${json.error || text.slice(0, 120)}`);
    return json;
  }
  return {
    remote: true,
    async install() {
      return { id: (await call('POST', '/admin/install')).plugin_id };
    },
    async settings() {
      return (await call('GET', '/admin/settings')).settings || {};
    },
    async setSetting(name, value) {
      await call('POST', '/admin/settings', { name, value });
    },
    async close() {}
  };
}

/** The database this process can open itself. */
function localBackend(w, values) {
  return {
    remote: false,
    async install() {
      if (values['with-standard']) await w.installDefaultPlugins({ path: '@engine9/schemas/stacks/standard' });
      return w.install({ path: GAUGE_PLUGIN_PATH, unique: true });
    },
    async settings() {
      await requirePlugin(w);
      return readRawSettings(w);
    },
    async setSetting(name, value) {
      await requirePlugin(w);
      await writeSetting(w, name, value);
    },
    async close() {
      if (typeof w.destroyAll === 'function') await w.destroyAll();
    }
  };
}

async function backend(values, ctx) {
  if (values.url) {
    const key = values.key || ctx.env.E9_ADMIN_API_KEY;
    if (!key) throw new UsageError('--url needs --key (an admin key) or E9_ADMIN_API_KEY');
    if (values['with-standard']) throw new UsageError('--with-standard works only with --db: a deployed site already has its schemas');
    return remoteBackend({ url: values.url, key, fetch: ctx.fetch });
  }
  return localBackend(await worker(values, ctx), values);
}

async function withBackend(values, ctx, fn) {
  const b = await backend(values, ctx);
  try {
    return await fn(b);
  } finally {
    await b.close();
  }
}

function parseJsonSetting(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function parseProps(text) {
  const out = {};
  for (const part of String(text || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, t] = part.split(':').map((s) => s.trim());
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k || '')) throw new UsageError(`bad property name: ${k}`);
    if (!['number', 'string', 'boolean'].includes(t)) throw new UsageError(`property ${k} needs a type: number, string or boolean`);
    out[k] = t;
  }
  return out;
}

function formatHit(r) {
  if (r.kind === 'unrouted') return `${r.received_at}  ${r.stream}  unrouted: no stream has this id (e9gauge stream list)`;
  if (r.kind === 'identify') return `${r.received_at}  ${r.stream}  identify  device=${String(r.device_id || '').slice(0, 8)}${r.person_id ? ` person=${r.person_id}` : r.email_hash_v1 ? ' by email' : ''}`;
  const what = r.entry_type === 'CUSTOM_ENTRY' ? `CUSTOM_ENTRY ${r.name}` : r.entry_type + (r.name ? ` ${r.name}` : '');
  const where = r.path ? ` ${r.host || ''}${r.path}` : r.screen ? ` ${r.screen}` : '';
  const who = r.person_id ? `person=${r.person_id}` : `device=${String(r.device_id || '').slice(0, 8)}`;
  return `${r.ts || r.received_at}  ${r.stream}  ${what}${where}  ${who}${r.bot ? '  bot' : ''}`;
}

async function readRecent(directory, limit) {
  const segments = (await listSegments(directory)).reverse().slice(0, 6);
  const recs = [];
  for (const seg of segments) {
    const part = [];
    for await (const item of readSegment(directory, seg)) if (item.record) part.push(item.record);
    recs.unshift(...part);
    if (recs.length >= limit * 2) break;
  }
  recs.sort((a, b) => String(a.received_at || '').localeCompare(String(b.received_at || '')));
  return recs.slice(-limit);
}

const commands = {
  async install(values, ctx) {
    return withBackend(values, ctx, async (b) => {
      const plugin = await b.install();
      ctx.out(`installed ${GAUGE_PLUGIN_PATH} (plugin ${plugin.id})`);
      ctx.out('next: e9gauge stream add --name www.example.com --hosts www.example.com');
    });
  },

  async stream(values, ctx, [action]) {
    return withBackend(values, ctx, async (b) => {
      const raw = await b.settings();
      const list = parseJsonSetting(raw.streams, []);
      if (action === 'list' || !action) {
        const streams = normalizeStreams(list);
        if (!streams.length) ctx.out('no streams; add one with: e9gauge stream add --name www.example.com --hosts www.example.com');
        for (const s of streams) ctx.out(`${s.id}  ${s.type}  ${s.name}${s.hosts.length ? `  hosts=${s.hosts.join(',')}` : ''}`);
        return;
      }
      if (action === 'add') {
        const type = values.type || 'web_stream';
        if (!['web_stream', 'app_stream', 'server_stream'].includes(type)) throw new UsageError('--type is web_stream, app_stream or server_stream');
        const id = values.id || `G-${randomBytes(5).toString('hex').toUpperCase()}`;
        if (list.some((s) => s.id === id)) throw new UsageError(`stream ${id} already exists`);
        const next = [...list, { id, name: values.name || id, type, hosts: values.hosts ? values.hosts.split(',').map((s) => s.trim()).filter(Boolean) : [] }];
        if (normalizeStreams(next).length !== next.length) throw new UsageError('the stream id may use letters, digits and _ . : - only');
        await b.setSetting('streams', JSON.stringify(next));
        ctx.out(`added stream ${id}. Put this id in the page or app: createGauge({ endpoint, stream: '${id}' })`);
        return;
      }
      if (action === 'remove') {
        if (!values.id) throw new UsageError('remove needs --id');
        const next = list.filter((s) => s.id !== values.id);
        if (next.length === list.length) throw new UsageError(`no stream ${values.id}`);
        await b.setSetting('streams', JSON.stringify(next));
        ctx.out(`removed stream ${values.id}. Hits already logged stay in the log and the database; new hits for it are refused.`);
        return;
      }
      throw new UsageError('stream add | list | remove');
    });
  },

  async custom(values, ctx, [action]) {
    return withBackend(values, ctx, async (b) => {
      const raw = await b.settings();
      const list = parseJsonSetting(raw.custom_entries, []);
      if (action === 'list' || !action) {
        const entries = normalizeCustomEntries(list);
        if (!entries.length) ctx.out('no declared custom entries (undeclared names are accepted only when allow_undeclared_custom is true)');
        for (const c of entries) {
          const props = Object.entries(c.props).map(([k, t]) => `${k}:${t}`).join(',');
          ctx.out(`${c.name}  ${c.key ? 'key  ' : ''}${c.entryType ? `type=${c.entryType.name}  ` : ''}${props ? `props=${props}` : ''}`.trimEnd());
        }
        return;
      }
      if (action === 'add') {
        if (!isValidCustomName(values.name)) throw new UsageError('--name must be lowercase snake_case, up to 64 characters');
        if (list.some((c) => c.name === values.name)) throw new UsageError(`${values.name} is already declared`);
        const entry = { name: values.name };
        if (values.label) entry.label = values.label;
        if (values.pin) entry.key = true;
        if (values['entry-type']) {
          const t = resolveEntryType(values['entry-type']);
          if (!t) throw new UsageError(`unknown entry type: ${values['entry-type']}`);
          entry.entry_type = t.name;
        }
        if (values.props) entry.props = parseProps(values.props);
        await b.setSetting('custom_entries', JSON.stringify([...list, entry]));
        ctx.out(`declared ${values.name}. Send it with gauge.track('${values.name}', {…})`);
        return;
      }
      if (action === 'remove') {
        if (!values.name) throw new UsageError('remove needs --name');
        const next = list.filter((c) => c.name !== values.name);
        if (next.length === list.length) throw new UsageError(`${values.name} is not declared`);
        await b.setSetting('custom_entries', JSON.stringify(next));
        ctx.out(`undeclared ${values.name}`);
        return;
      }
      throw new UsageError('custom add | list | remove');
    });
  },

  async settings(values, ctx) {
    return withBackend(values, ctx, async (b) => {
      const raw = await b.settings();
      // An empty setting is stored as null; that is the default "", not a change.
      const rows = SETTING_DEFS.filter((d) => !d.hidden).map((d) => {
        const fallback = String(d.default ?? '');
        const value = raw[d.name] === undefined || raw[d.name] === null ? fallback : String(raw[d.name]);
        return { name: d.name, value, default: value === fallback };
      });
      if (values.json) ctx.out(JSON.stringify(rows, null, 2));
      else for (const r of rows) ctx.out(`${r.name} = ${r.value}${r.default ? '' : '   (changed)'}`);
    });
  },

  async set(values, ctx, [name, ...rest]) {
    if (!name) throw new UsageError('set <setting> <value>');
    if (rest.length === 0) throw new UsageError('set <setting> <value>');
    const checked = validateSettingValue(name, rest.join(' '));
    if (!checked.ok) throw new UsageError(`${checked.error}; see e9gauge settings`);
    return withBackend(values, ctx, async (b) => {
      await b.setSetting(name, checked.value);
      ctx.out(`${name} = ${checked.value}`);
    });
  },

  async serve(values, ctx) {
    let fileSettings;
    if (values.config) fileSettings = JSON.parse(readFileSync(path.resolve(ctx.cwd, values.config), 'utf8'));
    const conn = db(values, ctx.env);
    if (!conn && !fileSettings) throw new UsageError('serve needs a database (--db) or a --config file with streams');
    const gauge = await startGauge({
      cwd: ctx.cwd,
      db: conn || undefined,
      settings: fileSettings,
      port: values.port === undefined ? 8788 : Number(values.port),
      host: values.host || '127.0.0.1',
      logDirectory: values['log-dir'],
      loadIntervalSeconds: values.interval === undefined ? 30 : Number(values.interval),
      trustProxy: Boolean(values['trust-proxy']),
      env: ctx.env,
      logger: ctx.err
    });
    ctx.out(`gauge collector listening on ${gauge.url}  log=${gauge.directory}  ${conn ? 'loader on' : 'collector only'}`);
    if (ctx.keepAlive === false) return gauge;
    await new Promise((resolve) => {
      for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, resolve);
    });
    await gauge.stop();
    return undefined;
  },

  async load(values, ctx) {
    return withWorker(values, ctx, async (w) => {
      await requirePlugin(w);
      const result = await loadFromDisk(w, {
        directory: values['log-dir'] ? path.resolve(ctx.cwd, values['log-dir']) : undefined,
        maxRecords: values['max-records'] ? Number(values['max-records']) : undefined
      });
      if (result.locked) {
        ctx.out('another loader is running; nothing done');
        return;
      }
      ctx.out(`loaded ${result.records} records from ${result.segments} segments (${result.corrupt} corrupt lines); pruned ${result.pruned.gzipped} gzipped, ${result.pruned.removed} removed`);
      ctx.out(JSON.stringify(result.stats));
    });
  },

  async replay(values, ctx) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.from || '')) throw new UsageError('replay needs --from YYYY-MM-DD');
    return withWorker(values, ctx, async (w) => {
      await requirePlugin(w);
      const result = await loadFromDisk(w, {
        directory: values['log-dir'] ? path.resolve(ctx.cwd, values['log-dir']) : undefined,
        maxRecords: Number.MAX_SAFE_INTEGER,
        from: values.from
      });
      if (result.locked) {
        ctx.out('another loader is running; nothing done');
        return;
      }
      ctx.out(`replayed ${result.records} records from ${values.from}`);
      ctx.out(JSON.stringify(result.stats));
    });
  },

  async tail(values, ctx) {
    const directory = path.resolve(ctx.cwd, values['log-dir'] || './gauge-logs');
    const limit = values.n ? Number(values.n) : 20;
    for (const r of await readRecent(directory, limit)) ctx.out(formatHit(r));
    if (!values.follow) return;
    const offsets = {};
    for (const seg of await listSegments(directory)) {
      let end = 0;
      for await (const item of readSegment(directory, seg)) end = item.end;
      offsets[seg] = end;
    }
    await new Promise((resolve) => {
      let stopped = false;
      process.once('SIGINT', () => {
        stopped = true;
        resolve();
      });
      const poll = async () => {
        for (const seg of await listSegments(directory)) {
          for await (const item of readSegment(directory, seg, { offset: offsets[seg] || 0 })) {
            offsets[seg] = item.end;
            if (item.record) ctx.out(formatHit(item.record));
          }
        }
        if (!stopped) setTimeout(poll, 500);
      };
      poll();
    });
  },

  async doctor(values, ctx) {
    const checks = [];
    const add = (level, message) => checks.push({ level, message });
    const conn = db(values, ctx.env);
    let settings = parseSettings({});
    let w = null;
    if (!conn) add('warn', 'no database given: checking the collector side only');
    else {
      try {
        w = await openWorker({ db: conn, cwd: ctx.cwd });
        const plugin = await findGaugePlugin(w);
        if (!plugin) add('fail', `${GAUGE_PLUGIN_PATH} is not installed; run: e9gauge install`);
        else {
          add('ok', `plugin installed (${plugin.id})`);
          settings = await readSettings(w);
          for (const table of ['person', 'timeline', 'gauge_entry', 'gauge_session']) {
            try {
              await w.query({ sql: `select 1 from ${table} limit 1` });
            } catch {
              add('fail', `table ${table} is missing; run e9gauge install --with-standard, or upgrade the schemas`);
            }
          }
        }
      } catch (e) {
        add('fail', `cannot open the database: ${e.message}`);
      }
    }

    if (settings.streams.length === 0) add('warn', 'no streams configured; every hit is refused (e9gauge stream add)');
    else add('ok', `${settings.streams.length} stream(s): ${settings.streams.map((s) => s.id).join(', ')}`);
    for (const s of settings.streams) {
      if (s.type === 'web_stream' && s.hosts.length === 0 && settings.allowedHosts.length === 0) {
        add('warn', `stream ${s.id} has no hosts and allowed_hosts is empty: any origin may send to it`);
      }
    }
    if (!settings.collectEnabled) add('warn', 'collect_enabled is false: the collector records nothing');
    if (!ctx.env.SESSION_SECRET) add('warn', 'SESSION_SECRET is not set: hits are never linked to a person from a Core Session');
    else add('ok', 'SESSION_SECRET is set');
    if (!ctx.env.GAUGE_SALT) add('warn', 'GAUGE_SALT is not set: cookieless visitor ids change on every restart');
    if (settings.consentMode === 'required') add('ok', 'consent_mode is required: no cookie or person link without consent');
    if (settings.timelineMode === 'all') add('warn', 'timeline_mode is all: every page view reaches the timeline; expect volume');

    const directory = path.resolve(ctx.cwd, values['log-dir'] || settings.logDirectory);
    try {
      await mkdir(directory, { recursive: true });
      const probe = path.join(directory, `.doctor-${process.pid}`);
      await writeFile(probe, 'ok');
      await unlink(probe);
      add('ok', `log directory writable: ${directory}`);
    } catch (e) {
      add('fail', `log directory is not writable (${directory}): ${e.message}`);
    }

    if (w) {
      try {
        const checkpoint = parseJsonSetting(settings.loadCheckpoint, { floor: '', offsets: {} });
        let bytes = 0;
        let oldest = null;
        for (const seg of await listSegments(directory)) {
          if ((segmentHour(seg) || '') < (checkpoint.floor || '')) continue;
          const offset = checkpoint.offsets?.[seg] || 0;
          let size = 0;
          try {
            size = (await stat(path.join(directory, seg))).size;
          } catch {
            continue; // gzipped: fully read
          }
          if (size > offset) {
            bytes += size - offset;
            oldest = oldest || segmentHour(seg);
          }
        }
        if (bytes === 0) add('ok', 'the loader is caught up');
        else {
          const hourAgo = new Date(Date.now() - 3600000).toISOString().slice(0, 13).replace(/-/g, '/').replace('T', '/');
          add(oldest && oldest < hourAgo ? 'warn' : 'ok', `${bytes} bytes of log not loaded yet (oldest segment ${oldest}); is the loader running?`);
        }
        const lock = path.join(directory, '.gauge-load.lock');
        if (existsSync(lock)) add('warn', `a load lock exists (${lock}); fine while a load runs, stale if none does`);
      } catch (e) {
        add('warn', `could not check the load backlog: ${e.message}`);
      }
      if (typeof w.destroyAll === 'function') await w.destroyAll();
    }

    for (const c of checks) ctx.out(`${c.level.padEnd(4)}  ${c.message}`);
    if (checks.some((c) => c.level === 'fail')) ctx.exitCode = 1;
  },

  async 'erase-logs'(values, ctx) {
    let personId;
    let emailHash;
    if (values['person-id']) personId = Number(values['person-id']);
    if (values['email-hash']) emailHash = values['email-hash'].toLowerCase();
    if (values.email) emailHash = emailHashV1(values.email);
    if (!personId && !emailHash) throw new UsageError('erase-logs needs --person-id, --email or --email-hash');
    const conn = db(values, ctx.env);
    let w = null;
    let settings = parseSettings({});
    if (conn) {
      w = await openWorker({ db: conn, cwd: ctx.cwd });
      if (await findGaugePlugin(w)) settings = await readSettings(w);
    }
    try {
      const directory = path.resolve(ctx.cwd, values['log-dir'] || settings.logDirectory);
      const checkpoint = parseJsonSetting(settings.loadCheckpoint, { floor: '', offsets: {} });
      const result = await eraseFromLog(directory, {
        personId,
        emailHash,
        offsets: checkpoint.offsets || {},
        includeOpen: Boolean(values['include-open'])
      });
      if (w && result.removed > 0 && checkpoint.floor !== undefined && (await findGaugePlugin(w))) {
        await writeSetting(w, 'load_checkpoint', JSON.stringify({ floor: checkpoint.floor, offsets: result.offsets }));
      }
      ctx.out(`removed ${result.removed} records from ${result.segments} segments`);
      if (result.skipped.length) {
        ctx.out(`skipped ${result.skipped.length} segment(s) in the current hour (a running collector holds them); stop it and rerun with --include-open, or rerun after the hour ends`);
      }
      ctx.out('the database is separate: erasePeople removes this person from every gauge table (they all carry person_id)');
    } finally {
      if (w && typeof w.destroyAll === 'function') await w.destroyAll();
    }
  },

  async help(values, ctx) {
    ctx.out(HELP);
  }
};

/**
 * Run a command. Returns the exit code (or, for `serve` with keepAlive false, the running gauge).
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, env?: object, out?: Function, err?: Function, keepAlive?: boolean, fetch?: Function }} [context]
 */
export async function run(argv, context = {}) {
  const ctx = {
    cwd: context.cwd || process.cwd(),
    env: context.env || process.env,
    out: context.out || ((s) => console.log(s)),
    err: context.err || ((s) => console.error(s)),
    keepAlive: context.keepAlive,
    fetch: context.fetch || globalThis.fetch,
    exitCode: 0
  };
  try {
    loadDotEnv(ctx.cwd, ctx.env);
    const [command, ...rest] = argv;
    if (!command || command === 'help' || command === '--help' || command === '-h') {
      ctx.out(HELP);
      return 0;
    }
    const fn = commands[command];
    if (!fn) throw new UsageError(`unknown command: ${command}\n\n${HELP}`);
    const { values, positionals } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
    if (values.help) {
      ctx.out(HELP);
      return 0;
    }
    const result = await fn(values, ctx, positionals);
    if (command === 'serve' && ctx.keepAlive === false) return result;
    return ctx.exitCode;
  } catch (e) {
    if (e instanceof UsageError || e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      ctx.err(`e9gauge: ${e.message}`);
      return 2;
    }
    ctx.err(`e9gauge: ${e?.stack || e}`);
    return 1;
  }
}

export default { run, parseProps };
