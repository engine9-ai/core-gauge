import { test } from 'node:test';
import assert from 'node:assert/strict';
import './setup-plugins.js';
import PersonWorker from '@engine9/core/PersonWorker';
import { createGaugeWorker, rows } from './helpers.js';
import { createGaugeHandlers, objectKey } from '../lib/cloudflare.js';
import { recordsOnOrAfter } from '../lib/loader.js';
import { run } from '../lib/cli.js';

const REPO = new URL('..', import.meta.url).pathname;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ADMIN = { authorization: 'Bearer admin-key' };

const keyStore = {
  async verify(req) {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    return token === 'admin-key' ? { valid: true, key: { scopes: ['admin'] } } : { valid: false, reason: 'invalid key' };
  }
};

/** The parts of an R2 bucket binding gauge uses: put, get and a sorted, paged list. */
function fakeBucket({ clock = () => new Date() } = {}) {
  const objects = new Map();
  return {
    objects,
    async put(key, body) {
      objects.set(key, { body: String(body), uploaded: clock() });
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { text: async () => o.body } : null;
    },
    async list({ prefix = '', startAfter = '', limit = 1000, cursor } = {}) {
      const after = cursor || startAfter;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = keys.slice(0, limit);
      const truncated = keys.length > page.length;
      return {
        objects: page.map((key) => ({ key, uploaded: objects.get(key).uploaded, size: objects.get(key).body.length })),
        truncated,
        cursor: truncated ? page.at(-1) : undefined
      };
    }
  };
}

function fakeQueue() {
  const q = {
    sent: [],
    async sendBatch(messages) {
      q.sent.push(...messages.map((m) => m.body));
    }
  };
  return q;
}

/** A Queue delivery: every message has a stable id and the time it was sent. */
function deliveryOf(bodies, sentAt) {
  const b = {
    messages: bodies.map((body, i) => ({ id: `msg${String(i).padStart(4, '0')}`, timestamp: sentAt, body })),
    acked: false,
    retried: false
  };
  b.ackAll = () => (b.acked = true);
  b.retryAll = () => (b.retried = true);
  return b;
}

function collect(hits) {
  return new Request('https://www.example.com/g/collect', {
    method: 'POST',
    headers: { 'user-agent': UA, origin: 'https://test.example.com', 'content-type': 'text/plain' },
    body: JSON.stringify({ s: 'G-test', platform: 'web', sent_at: Date.now(), ctx: { host: 'test.example.com' }, hits })
  });
}

const adminPost = (route, body) =>
  new Request(`https://www.example.com/g${route}`, { method: 'POST', headers: ADMIN, body: body === undefined ? undefined : JSON.stringify(body) });

test('POST /admin/install installs timeline first on a site that has only the person schemas', async () => {
  // What `e9core setup` leaves on D1: person, segment and the rest, no timeline.
  const worker = new PersonWorker({ accountId: 'site', auth: { database_connection: 'sqlite://:memory:' } });
  await worker.installDefaultPlugins();
  try {
    assert.ok(!(await worker.tables()).tables.includes('timeline'));
    const handlers = createGaugeHandlers({ makeWorker: () => worker, makeKeyStore: () => keyStore });
    const env = { DB: {}, GAUGE_QUEUE: fakeQueue(), GAUGE_BASE_PATH: '/g' };

    const res = await handlers.fetch(adminPost('/admin/install'), env, {});
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.dependencies.includes('@engine9/schemas/timeline'), JSON.stringify(body.dependencies));
    assert.ok((await worker.tables()).tables.includes('timeline'));
    assert.ok((await worker.tables()).tables.includes('gauge_session'));

    const again = await (await handlers.fetch(adminPost('/admin/install'), env, {})).json();
    assert.deepEqual(again.dependencies, [], 'nothing left to install the second time');
    assert.equal(again.plugin_id, body.plugin_id);
  } finally {
    await worker.destroyAll();
  }
});

test('an /admin/install error is plain JSON: @ and > reach the client as those bytes', async () => {
  const message = 'requires @engine9/schemas/timeline >=1.9.0 & <2';
  const broken = {
    async list() {
      return [];
    },
    async compilePlugin() {
      return { metadata: {} };
    },
    async install() {
      throw new Error(message);
    }
  };
  const handlers = createGaugeHandlers({ makeWorker: () => broken, makeKeyStore: () => keyStore });
  const original = console.error;
  console.error = () => {};
  let res;
  try {
    res = await handlers.fetch(adminPost('/admin/install'), { DB: {}, GAUGE_QUEUE: fakeQueue(), GAUGE_BASE_PATH: '/g' }, {});
  } finally {
    console.error = original;
  }
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('content-type'), 'application/json');
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.ok(bytes.every((b) => b < 0x80), 'ASCII only: no fullwidth ＠ and no HTML entities');
  assert.equal(new TextDecoder().decode(bytes), JSON.stringify({ error: message }));
});

test('reloadStats rebuilds rollups from the R2 archive, step by step, without counting twice', async () => {
  const { worker } = await createGaugeWorker();
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const bucket = fakeBucket();
    const queue = fakeQueue();
    const env = { DB: {}, GAUGE_QUEUE: queue, GAUGE_BUCKET: bucket, GAUGE_BASE_PATH: '/g' };
    const handlers = createGaugeHandlers({ makeWorker: () => worker, makeKeyStore: () => keyStore });

    for (let i = 1; i <= 3; i += 1) {
      const ts = Date.now();
      const res = await handlers.fetch(collect([{ id: `hit-000000${i}`, t: 'PAGE_VIEW', ts, url: `https://test.example.com/p${i}` }]), env, {});
      assert.equal(res.status, 200);
    }
    assert.equal(queue.sent.length, 3, 'one Queue message per request');

    const delivery = deliveryOf(queue.sent, now);
    await handlers.queue(delivery, env);
    assert.ok(delivery.acked);
    assert.equal(bucket.objects.size, 3, 'one archive object per Queue message');
    assert.ok([...bucket.objects.keys()].every((k) => k.startsWith(objectKey(now, '').replace(/\.jsonl$/, ''))));
    const exact = await rows(worker, 'select view_name, views from gauge_view_day order by view_name');
    assert.deepEqual(exact.map((r) => r.views), [1, 1, 1]);
    const sessions = await rows(worker, 'select id, views from gauge_session order by id');

    // A Queue retry (a crash between the D1 write and the ack) delivers the same
    // messages again. The archive keys are the message ids, so R2 still holds
    // each message once; the rollups count the views twice.
    await handlers.queue(deliveryOf(queue.sent, now), env);
    assert.equal(bucket.objects.size, 3, 'a retried delivery overwrites, it does not add objects');
    assert.equal((await rows(worker, 'select sum(views) as n from gauge_view_day'))[0].n, 6, 'the double count reloadStats repairs');

    const dry = await (await handlers.fetch(adminPost('/admin/reloadStats', { from: day, dry_run: true }), env, {})).json();
    assert.equal(dry.objects, 3);
    assert.equal(dry.done, true);
    assert.equal((await rows(worker, 'select sum(views) as n from gauge_view_day'))[0].n, 6, 'a dry run changes nothing');

    const out = [];
    const net = async (url, init) => {
      const res = await handlers.fetch(new Request(url, init), env, {});
      return { status: res.status, text: () => res.text() };
    };
    const code = await run(['reloadStats', '--from', day, '--url', 'https://www.example.com/g', '--key', 'admin-key', '--batch', '1'], {
      cwd: REPO,
      env: {},
      fetch: net,
      out: (s) => out.push(s),
      err: (s) => out.push(s)
    });
    assert.equal(code, 0, out.join('\n'));
    assert.match(out.join('\n'), /forgot sessions and rollups from/);
    assert.match(out.join('\n'), /reloaded 3 records from 3 archive objects/);

    assert.deepEqual(await rows(worker, 'select view_name, views from gauge_view_day order by view_name'), exact);
    assert.deepEqual(await rows(worker, 'select id, views from gauge_session order by id'), sessions, 'the same deterministic sessions');
  } finally {
    await worker.destroyAll();
  }
});

test('reloadStats skips objects archived after it started, and hits from before --from', async () => {
  const { worker } = await createGaugeWorker();
  try {
    let clock = new Date('2026-10-21T10:30:00Z');
    const bucket = fakeBucket({ clock: () => clock });
    const env = { DB: {}, GAUGE_QUEUE: fakeQueue(), GAUGE_BUCKET: bucket, GAUGE_BASE_PATH: '/g' };
    const handlers = createGaugeHandlers({ makeWorker: () => worker, makeKeyStore: () => keyStore, clock: () => clock.getTime() });
    const hit = (id, ts) => ({ kind: 'hit', hit_id: id, stream: 'G-test', device_id: 'dev00000001', entry_type: 'PAGE_VIEW', entry_type_id: 102, path: `/${id}`, ts, received_at: ts });

    // Arrived just after midnight, but the hit itself is from the day before.
    await bucket.put(objectKey(new Date('2026-10-21T00:10:00Z'), 'late'), JSON.stringify(hit('late', '2026-10-20T23:58:00.000Z')) + '\n');
    await bucket.put(objectKey(new Date('2026-10-21T09:00:00Z'), 'ontime'), JSON.stringify(hit('ontime', '2026-10-21T09:00:00.000Z')) + '\n');

    const first = await (await handlers.fetch(adminPost('/admin/reloadStats', { from: '2026-10-21' }), env, {})).json();
    assert.equal(first.reset, true);
    assert.equal(first.until, '2026-10-21T10:30:00.000Z');
    assert.equal(first.objects, 2);
    assert.equal(first.records, 1, 'the 23:58 hit belongs to a day reloadStats did not reset');
    assert.equal(first.done, true);

    // An object archived after the reload started is the Queue consumer's to load.
    clock = new Date('2026-10-21T10:45:00Z');
    await bucket.put(objectKey(new Date('2026-10-21T10:40:00Z'), 'after'), JSON.stringify(hit('after', '2026-10-21T10:40:00.000Z')) + '\n');
    const step = await (await handlers.fetch(adminPost('/admin/reloadStats', { from: '2026-10-21', cursor: objectKey(new Date('2026-10-21T09:00:00Z'), 'ontime'), until: first.until }), env, {})).json();
    assert.equal(step.reset, false, 'a later step does not reset again');
    assert.equal(step.objects, 0);
    assert.equal(step.done, true);

    const bad = await handlers.fetch(adminPost('/admin/reloadStats', { from: 'yesterday' }), env, {});
    assert.equal(bad.status, 400);
  } finally {
    await worker.destroyAll();
  }
});

test('reloadStats on a Queue-only Worker says there is no archive to read', async () => {
  const { worker } = await createGaugeWorker();
  try {
    const handlers = createGaugeHandlers({ makeWorker: () => worker, makeKeyStore: () => keyStore });
    const res = await handlers.fetch(adminPost('/admin/reloadStats', { from: '2026-10-21' }), { DB: {}, GAUGE_QUEUE: fakeQueue(), GAUGE_BASE_PATH: '/g' }, {});
    assert.equal(res.status, 501);
    assert.match((await res.json()).error, /GAUGE_BUCKET/);
  } finally {
    await worker.destroyAll();
  }
});

test('recordsOnOrAfter keeps identify records and drops hits from before the date', () => {
  const kept = recordsOnOrAfter(
    [
      { kind: 'hit', ts: '2026-10-20T23:59:59.000Z' },
      { kind: 'hit', ts: '2026-10-21T00:00:00.000Z' },
      { kind: 'identify', received_at: '2026-10-21T00:00:01.000Z' }
    ],
    '2026-10-21'
  );
  assert.deepEqual(kept.map((r) => r.kind), ['hit', 'identify']);
});
