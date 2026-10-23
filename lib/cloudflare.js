/*
  Cloudflare deployment of the gauge collector and loader.

    collector  fetch()      the same collector as Node, answering from cached
                            settings. A request never waits on D1.
    durable    Queue / R2   the "disk log": a hit is acknowledged only after it
                            reached a Queue (sendBatch) or an R2 object.
                            One Queue message per request (`{ v: 1, records }`),
                            not per hit: Queues charge 3 operations per 64 KB
                            message, and Workers Free is 10,000 operations/day.
    loader     queue()      consumes the Queue, copies records to R2 (optional
                            archive, one JSONL object per Queue message, keyed
                            by message id so a retry overwrites), then loads D1
                            with the same loadRecords the Node loader uses.
    cron       scheduled()  retries devices waiting on an email lookup and
                            refreshes nothing else; cheap.

  This file imports no Cloudflare or engine9 runtime itself. The site's Worker
  passes `makeWorker(env)` (a core PersonWorker on env.DB), so this module runs
  under Node tests with fakes. cloudflare/worker.js is the example Worker.

  Bindings (a Queue or an R2 bucket is required):
    DB              D1: the engine9 database, with gauge installed
    GAUGE_QUEUE     Queue producer, and consumer for this Worker. With it, the
                    collector sends to the Queue; the consumer archives to R2
                    (if GAUGE_BUCKET is bound) and loads D1.
    GAUGE_BUCKET    R2 bucket. Without a queue the collector writes one JSONL
                    object per request batch and nothing loads D1: a
                    collector-only setup whose objects you load elsewhere.
    SESSION_SECRET  verifies the Core Session cookie (same as core)
    GAUGE_SALT      cookieless id salt
    GAUGE_SETTINGS  JSON of settings used until (or without) D1
    GAUGE_BASE_PATH path the Worker is routed at, e.g. /g (so /g/collect works)
    GAUGE_REFRESH_MS settings cache lifetime, default 60000

  Admin (a Node process cannot open D1, so setup runs inside the Worker, like
  core's POST /api/admin/upgrade). They need a key with scope "admin" and are
  off when the Worker has no key store (makeKeyStore):
    POST /admin/install    install the gauge plugin into the database (idempotent)
    GET  /admin/settings   { plugin_id, settings }
    POST /admin/settings   { name, value } (validated like `e9gauge set`)
    POST /admin/reloadStats { from, cursor?, until?, dry_run?, max_objects? }
                           rebuild sessions and rollups from the R2 archive, one
                           step per call (needs GAUGE_BUCKET)
  `e9gauge install|stream|custom|set|settings|reloadStats --url https://… --key e9key_…` use them.

  Delivery is at least once, like the Node loader: Queue retries re-send a batch,
  timeline and gauge_entry rows are keyed by hit id so they are written again
  harmlessly, and rollup counters can double-count after a failure between the
  database write and the acknowledgement. `e9gauge reloadStats` rebuilds them
  from the R2 archive; a Queue-only deployment has nothing to rebuild from.
*/
import { createCollector, serverKeyVerifier } from './collector.js';
import {
  createSettingsSource,
  findGaugePlugin,
  readSettings,
  readRawSettings,
  writeSetting,
  validateSettingValue,
  parseSettings,
  GAUGE_PLUGIN_PATH
} from './settings.js';
import { loadRecords, recordsOnOrAfter, resetFrom } from './loader.js';
import { installGauge } from './install.js';

const QUEUE_BATCH = 100; // Queues allow 100 messages per sendBatch
// Stay under the 64 KB operation chunk (and the 128 KB hard limit). One
// message is one write+read+delete. Do not send one message per hit.
const QUEUE_MESSAGE_BYTES = 60000;

function encodedSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * Pack records into `{ v: 1, records }` messages that stay under `maxBytes`.
 * A single oversized record goes alone. Empty input yields no messages.
 */
export function packRecords(records, maxBytes = QUEUE_MESSAGE_BYTES) {
  const messages = [];
  let current = [];
  for (const record of records) {
    const next = current.concat(record);
    if (current.length && encodedSize({ v: 1, records: next }) > maxBytes) {
      messages.push({ v: 1, records: current });
      current = [record];
    } else {
      current = next;
    }
  }
  if (current.length) messages.push({ v: 1, records: current });
  return messages;
}

/** One Queue message is `{ v: 1, records }` or a single record from before packing. */
export function recordsFromMessage(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.records)) return body.records.filter(Boolean);
  return [body];
}

/**
 * A log whose append() succeeds only when Queues accepted every record.
 * One message per request (or per 60 KB), not per hit: see packRecords.
 */
export function queueLog(queue, { maxBytes = QUEUE_MESSAGE_BYTES } = {}) {
  return {
    async append(records) {
      const messages = packRecords(records, maxBytes).map((body) => ({ body, contentType: 'json' }));
      for (let i = 0; i < messages.length; i += QUEUE_BATCH) {
        await queue.sendBatch(messages.slice(i, i + QUEUE_BATCH));
      }
    }
  };
}

/** A log that writes each request's records as one JSONL object. */
export function r2Log(bucket, { clock = () => new Date(), newId = () => crypto.randomUUID() } = {}) {
  return {
    async append(records) {
      await bucket.put(objectKey(clock(), newId()), records.map((r) => JSON.stringify(r)).join('\n') + '\n', {
        httpMetadata: { contentType: 'application/x-ndjson' }
      });
    }
  };
}

/** gauge/YYYY/MM/DD/HH/<id>.jsonl, the same hourly layout as the disk log. */
export function objectKey(date, id) {
  const p = (n) => String(n).padStart(2, '0');
  return `gauge/${date.getUTCFullYear()}/${p(date.getUTCMonth() + 1)}/${p(date.getUTCDate())}/${p(date.getUTCHours())}/${id}.jsonl`;
}

/**
 * Archive each Queue message as its own object, keyed by when it was sent and
 * its message id. A retried delivery writes the same keys again, so the
 * archive holds every message once and reloadStats reads it once.
 */
async function archiveMessages(bucket, messages, clock) {
  for (const m of messages) {
    const records = recordsFromMessage(m.body);
    if (!records.length) continue;
    const sent = m.timestamp ? new Date(m.timestamp) : new Date(clock());
    const id = m.id ? String(m.id).replace(/[^A-Za-z0-9_-]/g, '') : crypto.randomUUID();
    await bucket.put(objectKey(sent, id), records.map((r) => JSON.stringify(r)).join('\n') + '\n', {
      httpMetadata: { contentType: 'application/x-ndjson' }
    });
  }
}

const RELOAD_OBJECTS = 20;
const RELOAD_MAX_OBJECTS = 200;
const DRY_RUN_PAGES = 10;

const hourOfKey = (key) => key.split('/').slice(1, 5).join('/');
const hourOfDate = (date) => objectKey(date, '').split('/').slice(1, 5).join('/');

function parseJsonl(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn line; the rest of the object still loads
    }
  }
  return out;
}

/**
 * One step of reloadStats over the R2 archive. The first step (no cursor)
 * forgets what the loader derived from `from` (resetFrom) and fixes `until`,
 * so objects archived after the reset, which the Queue consumer loads as
 * usual, are not loaded twice. Each step loads whole hours, up to
 * `maxObjects` objects, and returns the cursor for the next step. A Worker
 * request has limited CPU and subrequests, so the caller loops.
 *
 * @param {object} worker
 * @param {object} bucket  the GAUGE_BUCKET binding
 * @param {{ from: string, cursor?: string, until?: string, dryRun?: boolean, maxObjects?: number, now?: Date }} options
 */
export async function reloadStatsFromBucket(worker, bucket, options) {
  const { from, cursor, dryRun = false } = options;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || ''))) throw new ReloadError('from must be YYYY-MM-DD');
  const until = options.until ? new Date(options.until) : options.now || new Date();
  if (Number.isNaN(until.getTime())) throw new ReloadError('until must be an ISO time');
  if (cursor && !String(cursor).startsWith('gauge/')) throw new ReloadError('cursor is the value the previous step returned');
  const maxObjects = Math.min(Math.max(Number(options.maxObjects) || RELOAD_OBJECTS, 1), RELOAD_MAX_OBJECTS);
  const startAfter = cursor || `gauge/${from.replace(/-/g, '/')}/`;
  const lastHour = hourOfDate(until);
  const out = { from, until: until.toISOString(), reset: false, objects: 0, records: 0, bytes: 0, cursor: null, done: false };

  if (dryRun) {
    let after = startAfter;
    for (let page = 0; page < DRY_RUN_PAGES; page += 1) {
      const listed = await bucket.list({ prefix: 'gauge/', startAfter: after, limit: 1000 });
      for (const o of listed.objects) {
        after = o.key;
        if (hourOfKey(o.key) > lastHour) {
          out.done = true;
          return out;
        }
        if (o.uploaded && new Date(o.uploaded) > until) continue;
        out.objects += 1;
        out.bytes += o.size || 0;
      }
      if (!listed.truncated) {
        out.done = true;
        return out;
      }
    }
    out.cursor = after;
    return out;
  }

  const plugin = await findGaugePlugin(worker);
  if (!plugin) throw new ReloadError(`${GAUGE_PLUGIN_PATH} is not installed; POST /admin/install`, 409);
  if (!cursor) {
    await resetFrom(worker, from);
    out.reset = true;
  }

  const listed = await bucket.list({ prefix: 'gauge/', startAfter, limit: 1000 });
  const take = [];
  let finished = !listed.truncated;
  for (const o of listed.objects) {
    if (hourOfKey(o.key) > lastHour) {
      finished = true;
      break;
    }
    // Stop at an hour boundary so one step loads an hour's hits together.
    if (take.length >= maxObjects && hourOfKey(o.key) !== hourOfKey(take[take.length - 1].key)) {
      finished = false;
      break;
    }
    if (take.length >= RELOAD_MAX_OBJECTS) {
      finished = false;
      break;
    }
    take.push(o);
  }

  const records = [];
  for (const o of take) {
    if (o.uploaded && new Date(o.uploaded) > until) continue;
    const body = await bucket.get(o.key);
    if (!body) continue;
    const text = await body.text();
    out.objects += 1;
    out.bytes += o.size || text.length;
    records.push(...parseJsonl(text));
  }
  const toLoad = recordsOnOrAfter(records, from);
  toLoad.sort((a, b) => String(a.ts || a.received_at || '').localeCompare(String(b.ts || b.received_at || '')));
  out.records = toLoad.length;
  if (toLoad.length) out.stats = await loadRecords(worker, toLoad, { settings: await readSettings(worker), plugin });
  if (take.length && !finished) out.cursor = take[take.length - 1].key;
  else if (!take.length && listed.truncated && !finished) out.cursor = listed.objects.at(-1)?.key || null;
  out.done = !out.cursor;
  return out;
}

class ReloadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function envSettings(env) {
  if (!env.GAUGE_SETTINGS) return {};
  try {
    return typeof env.GAUGE_SETTINGS === 'string' ? JSON.parse(env.GAUGE_SETTINGS) : env.GAUGE_SETTINGS;
  } catch {
    return {};
  }
}

/**
 * @param {object} options
 * @param {(env) => object} options.makeWorker  returns a core PersonWorker on env.DB
 * @param {(worker) => object} [options.makeKeyStore]  returns a core key store (default: none, /send disabled)
 * @param {() => number} [options.clock]
 */
export function createGaugeHandlers({ makeWorker, makeKeyStore, clock = () => Date.now() } = {}) {
  const states = new WeakMap();

  function stateFor(env) {
    let st = states.get(env);
    if (st) return st;
    const worker = env.DB && makeWorker ? makeWorker(env) : null;
    const refreshMs = Number(env.GAUGE_REFRESH_MS) || 60000;
    const fallback = envSettings(env);
    const source = createSettingsSource({ settings: fallback, worker, refreshMs: 0 });
    if (!env.GAUGE_QUEUE && !env.GAUGE_BUCKET) throw new Error('gauge needs a GAUGE_QUEUE or GAUGE_BUCKET binding');
    const log = env.GAUGE_QUEUE ? queueLog(env.GAUGE_QUEUE) : r2Log(env.GAUGE_BUCKET);
    const keyStore = worker && makeKeyStore ? makeKeyStore(worker) : null;
    const verifyAdmin = keyStore ? serverKeyVerifier(keyStore, { scope: 'admin' }) : null;
    const collector = createCollector({
      settings: source,
      log,
      sessionSecret: env.SESSION_SECRET,
      salt: env.GAUGE_SALT,
      basePath: env.GAUGE_BASE_PATH || '',
      verifyServerKey: keyStore ? serverKeyVerifier(keyStore) : undefined,
      onError: (e) => console.error('gauge collector', e?.message || e)
    });
    st = { worker, source, collector, verifyAdmin, refreshedAt: 0, refreshing: null, refreshMs, basePath: env.GAUGE_BASE_PATH || '' };
    states.set(env, st);
    return st;
  }

  /** Stale-while-revalidate: the first request waits briefly, later ones never do. */
  async function freshSettings(st, ctx) {
    if (!st.worker) return;
    const stale = clock() - st.refreshedAt > st.refreshMs;
    if (!stale) return;
    const refresh = () => {
      if (!st.refreshing) {
        st.refreshing = st.source
          .refresh()
          .then(() => {
            if (!st.source.lastError()) st.refreshedAt = clock();
          })
          .finally(() => {
            st.refreshing = null;
          });
      }
      return st.refreshing;
    };
    if (st.refreshedAt === 0) {
      let timer;
      const wait = new Promise((resolve) => {
        timer = setTimeout(resolve, 1500);
      });
      try {
        await Promise.race([refresh(), wait]);
      } finally {
        clearTimeout(timer);
      }
    } else if (ctx?.waitUntil) {
      ctx.waitUntil(refresh());
    }
  }

  const json = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

  async function admin(request, env, st, rel) {
    if (!st.worker) return json(501, { error: 'no DB binding: admin routes need the database' });
    if (!st.verifyAdmin) return json(501, { error: 'no key store: admin routes are off' });
    const headers = {};
    request.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const auth = await st.verifyAdmin(headers);
    if (!auth.valid) return json(auth.reason === 'missing key' ? 401 : 403, { error: auth.reason || 'forbidden' });
    try {
      if (rel === '/admin/install' && request.method === 'POST') {
        const { plugin, dependencies } = await installGauge(st.worker);
        st.refreshedAt = 0;
        return json(200, { ok: true, plugin_id: plugin.id, dependencies });
      }
      if (rel === '/admin/settings' && request.method === 'GET') {
        const plugin = await findGaugePlugin(st.worker);
        if (!plugin) return json(409, { error: `${GAUGE_PLUGIN_PATH} is not installed; POST /admin/install` });
        return json(200, { plugin_id: plugin.id, settings: await readRawSettings(st.worker) });
      }
      if (rel === '/admin/settings' && request.method === 'POST') {
        let body;
        try {
          body = JSON.parse(await request.text());
        } catch {
          return json(400, { error: 'invalid JSON' });
        }
        const checked = validateSettingValue(body?.name, body?.value);
        if (!checked.ok) return json(400, { error: checked.error });
        if (!(await findGaugePlugin(st.worker))) return json(409, { error: `${GAUGE_PLUGIN_PATH} is not installed; POST /admin/install` });
        await writeSetting(st.worker, body.name, checked.value);
        st.refreshedAt = 0;
        return json(200, { ok: true, name: body.name, value: checked.value });
      }
      if (rel === '/admin/reloadStats' && request.method === 'POST') {
        if (!env.GAUGE_BUCKET) {
          return json(501, { error: 'no GAUGE_BUCKET binding: reloadStats reads the R2 archive, and a Queue-only deployment keeps no copy of past hits' });
        }
        let body;
        try {
          body = JSON.parse((await request.text()) || '{}');
        } catch {
          return json(400, { error: 'invalid JSON' });
        }
        const result = await reloadStatsFromBucket(st.worker, env.GAUGE_BUCKET, {
          from: body?.from,
          cursor: body?.cursor || undefined,
          until: body?.until || undefined,
          dryRun: body?.dry_run === true,
          maxObjects: body?.max_objects,
          now: new Date(clock())
        });
        return json(200, { ok: true, ...result });
      }
    } catch (e) {
      if (e instanceof ReloadError) return json(e.status, { error: e.message });
      console.error('gauge admin', e?.message || e);
      return json(500, { error: e?.message || 'failed' });
    }
    return json(404, { error: 'not found' });
  }

  return {
    async fetch(request, env, ctx) {
      const st = stateFor(env);
      const path = new URL(request.url).pathname;
      const rel = st.basePath && path.startsWith(st.basePath) ? path.slice(st.basePath.length) || '/' : path;
      if (rel.startsWith('/admin/')) return admin(request, env, st, rel);
      await freshSettings(st, ctx);
      return st.collector.handleFetch(request);
    },

    /** Queue consumer: flatten packed (or legacy) messages, archive to R2, load D1, acknowledge. */
    async queue(batch, env) {
      const st = stateFor(env);
      const records = batch.messages.flatMap((m) => recordsFromMessage(m.body));
      try {
        if (env.GAUGE_BUCKET && records.length) await archiveMessages(env.GAUGE_BUCKET, batch.messages, clock);
        if (st.worker) {
          const plugin = await findGaugePlugin(st.worker);
          if (!plugin) throw new Error('@engine9/core-gauge/gauge is not installed in the database');
          const settings = await readSettings(st.worker);
          // The queue does not deliver in order; sort so sessionizing sees this batch in order.
          records.sort((a, b) => String(a.ts || a.received_at || '').localeCompare(String(b.ts || b.received_at || '')));
          await loadRecords(st.worker, records, { settings, plugin });
        }
        batch.ackAll();
      } catch (e) {
        console.error('gauge queue', e?.message || e);
        batch.retryAll();
      }
    },

    /** Cron: retry email lookups for devices that were waiting on a person. */
    async scheduled(event, env) {
      const st = stateFor(env);
      if (!st.worker) return;
      const plugin = await findGaugePlugin(st.worker);
      if (!plugin) return;
      await loadRecords(st.worker, [], { settings: await readSettings(st.worker), plugin });
    }
  };
}

export { parseSettings };
export default { createGaugeHandlers, queueLog, r2Log, objectKey, packRecords, recordsFromMessage, reloadStatsFromBucket };
