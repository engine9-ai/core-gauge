/*
  Cloudflare deployment of the gauge collector and loader.

    collector  fetch()      the same collector as Node, answering from cached
                            settings. A request never waits on D1.
    durable    Queue / R2   the "disk log": a hit is acknowledged only after it
                            reached a Queue (sendBatch) or an R2 object.
    loader     queue()      consumes the Queue, copies records to R2 (optional
                            archive, one JSONL object per delivery), then loads
                            D1 with the same loadRecords the Node loader uses.
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
  `e9gauge install|stream|custom|set|settings --url https://… --key e9key_…` use them.

  Delivery is at least once, like the Node loader: Queue retries re-send a batch,
  timeline and gauge_entry rows are keyed by hit id so they are written again
  harmlessly, and rollup counters can double-count after a failure between the
  database write and the acknowledgement. `e9gauge replay` rebuilds them.
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
import { loadRecords } from './loader.js';

const QUEUE_BATCH = 100; // Queues allow 100 messages per sendBatch

/** A log whose append() succeeds only when Queues accepted every record. */
export function queueLog(queue) {
  return {
    async append(records) {
      for (let i = 0; i < records.length; i += QUEUE_BATCH) {
        const chunk = records.slice(i, i + QUEUE_BATCH);
        await queue.sendBatch(chunk.map((body) => ({ body, contentType: 'json' })));
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

  async function admin(request, st, rel) {
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
        const plugin = await st.worker.install({ path: GAUGE_PLUGIN_PATH, unique: true });
        st.refreshedAt = 0;
        return json(200, { ok: true, plugin_id: plugin.id });
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
    } catch (e) {
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
      if (rel.startsWith('/admin/')) return admin(request, st, rel);
      await freshSettings(st, ctx);
      return st.collector.handleFetch(request);
    },

    /** Queue consumer: archive to R2, load D1, acknowledge. */
    async queue(batch, env) {
      const st = stateFor(env);
      const records = batch.messages.map((m) => m.body).filter(Boolean);
      try {
        if (env.GAUGE_BUCKET && records.length) await r2Log(env.GAUGE_BUCKET).append(records);
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
export default { createGaugeHandlers, queueLog, r2Log, objectKey };
