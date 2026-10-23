import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGauge, uuidv7 } from '../client/gauge.js';
import { createGaugeServer } from '../client/server.js';
import { createCollector } from '../lib/collector.js';
import { createSettingsSource } from '../lib/settings.js';

const STREAM = { id: 'G-test', name: 'test', type: 'web_stream', hosts: ['www.example.com'] };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function storage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

/** A fetch that talks straight to a real collector, as a browser would. */
function collectorFetch(collector, { failFirst = 0 } = {}) {
  const state = { calls: [], failures: failFirst };
  const fetch = async (url, init) => {
    state.calls.push({ url, init });
    if (state.failures > 0) {
      state.failures -= 1;
      throw new TypeError('network down');
    }
    const out = await collector.handle({
      method: init.method,
      path: new URL(url).pathname,
      headers: { 'user-agent': UA, origin: 'https://www.example.com', ...init.headers },
      body: init.body,
      secure: true
    });
    return {
      status: out.status,
      async json() {
        return typeof out.body === 'string' ? JSON.parse(out.body) : out.body;
      }
    };
  };
  return { fetch, state };
}

function setup({ failFirst = 0, settings = {} } = {}) {
  const log = { records: [], async append(r) { log.records.push(...r); } };
  const source = createSettingsSource({ settings: { streams: [STREAM], ...settings } });
  const collector = createCollector({ settings: source, log, sessionSecret: 's', salt: 'x', rateLimitPerMinute: 1000 });
  const net = collectorFetch(collector, { failFirst });
  const store = storage();
  const win = { location: { href: 'https://www.example.com/pricing', host: 'www.example.com' } };
  const gauge = createGauge({
    endpoint: 'https://g.example.com/',
    stream: 'G-test',
    fetch: net.fetch,
    storage: store,
    window: win,
    document: { title: 'Pricing' },
    navigator: {},
    flushMs: 0
  });
  return { gauge, log, net, store };
}

test('uuidv7 is a version 7 uuid and sorts by time', () => {
  const a = uuidv7(1_000_000);
  const b = uuidv7(2_000_000);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b);
});

test('a page view and a custom entry go through the real collector', async () => {
  const { gauge, log } = setup({ settings: { allow_undeclared_custom: true } });
  gauge.page();
  gauge.track('video_upload', { size_mb: 40 }, 40);
  assert.equal(gauge.queued(), 2);
  const r = await gauge.flush();
  assert.equal(r.sent, 2);
  assert.equal(gauge.queued(), 0);
  const [view, custom] = log.records;
  assert.equal(view.entry_type, 'PAGE_VIEW');
  assert.equal(view.path, '/pricing');
  assert.equal(custom.entry_type, 'CUSTOM_ENTRY');
  assert.equal(custom.name, 'video_upload');
  assert.equal(custom.value, 40);
  assert.deepEqual(custom.props, { size_mb: 40 });
});

test('a network failure keeps the queue, and the retry reuses hit ids so nothing is counted twice', async () => {
  const { gauge, log, net, store } = setup({ failFirst: 1 });
  gauge.page();
  const first = await gauge.flush();
  assert.equal(first.error, 'network');
  assert.equal(gauge.queued(), 1);
  assert.equal(JSON.parse(store.getItem('e9g_queue_G-test')).length, 1, 'queue persisted for the next page load');
  const id = JSON.parse(net.state.calls[0].init.body).hits[0].id;
  await gauge.flush();
  assert.equal(gauge.queued(), 0);
  assert.equal(log.records.length, 1);
  assert.equal(log.records[0].hit_id, id);
});

test('a queue left in storage by a previous page load is sent by the next one', async () => {
  const a = setup({ failFirst: 1 });
  a.gauge.page();
  await a.gauge.flush();
  const b = setup();
  for (const [k, v] of a.store.m) b.store.setItem(k, v);
  const resumed = createGauge({
    endpoint: 'https://g.example.com',
    stream: 'G-test',
    fetch: b.net.fetch,
    storage: b.store,
    window: { location: { href: 'https://www.example.com/', host: 'www.example.com' } },
    document: { title: '' },
    navigator: {},
    flushMs: 0
  });
  assert.equal(resumed.queued(), 1);
  await resumed.flush();
  assert.equal(b.log.records.length, 1);
});

test('a rejected batch is dropped; retrying a 400 would never succeed', async () => {
  const { gauge, log } = setup();
  gauge.event('PAGE_VIEW', {});
  gauge.event('NOT_A_TYPE', {});
  await gauge.flush();
  assert.equal(gauge.queued(), 0);
  assert.equal(log.records.length, 1, 'the good hit landed, the unknown type was rejected');
});

test('the device id the collector hands back is sent with the next batch', async () => {
  const { gauge, net, store } = setup();
  gauge.page();
  await gauge.flush();
  const did = store.getItem('e9g_did');
  assert.ok(did, 'device id stored');
  gauge.page();
  await gauge.flush();
  assert.equal(JSON.parse(net.state.calls[1].init.body).device_id, did);
});

test('consent(false) rides with the batch so the collector goes cookieless', async () => {
  const { gauge, log, net } = setup();
  gauge.consent(false);
  gauge.page();
  await gauge.flush();
  assert.equal(JSON.parse(net.state.calls[0].init.body).consent, false);
  assert.equal(log.records[0].consent, false);
});

test('a client cannot mint a transaction or claim a person', async () => {
  const { gauge, log } = setup();
  gauge.event('TRANSACTION', { value: 100 });
  gauge.event('PAGE_VIEW', { person_id: 7, email: 'a@b.com' });
  await gauge.flush();
  assert.equal(log.records.length, 1);
  assert.ok(!log.records[0].person_id, 'person_id from a browser body is ignored');
  assert.ok(!log.records[0].email_hash_v1);
});

test('the session header is sent when the app provides one', async () => {
  const { gauge, net } = setup();
  gauge.session('tok');
  gauge.page();
  await gauge.flush();
  assert.equal(net.state.calls[0].init.headers['x-engine9-session'], 'tok');
});

test('start() sends the initial page view and one per navigation, not repeats', async () => {
  const log = { records: [], async append(r) { log.records.push(...r); } };
  const collector = createCollector({
    settings: createSettingsSource({ settings: { streams: [STREAM] } }),
    log,
    sessionSecret: 's',
    salt: 'x',
    rateLimitPerMinute: 1000
  });
  const net = collectorFetch(collector);
  const listeners = {};
  const win = {
    location: {
      host: 'www.example.com',
      origin: 'https://www.example.com',
      pathname: '/',
      search: '',
      get href() {
        return `https://www.example.com${this.pathname}${this.search}`;
      }
    },
    history: { pushState() {}, replaceState() {} },
    addEventListener: (n, f) => (listeners[n] = f)
  };
  const doc = { title: 't', referrer: '', addEventListener() {}, visibilityState: 'visible' };
  const gauge = createGauge({ endpoint: 'https://g.example.com', stream: 'G-test', fetch: net.fetch, storage: storage(), window: win, document: doc, navigator: {}, flushMs: 0 });
  gauge.start();
  win.location.pathname = '/about';
  win.history.pushState({}, '', '/about');
  await Promise.resolve();
  await Promise.resolve();
  win.history.replaceState({}, '', '/about'); // same path: no new view
  await Promise.resolve();
  await Promise.resolve();
  await gauge.flush();
  assert.deepEqual(log.records.map((r) => r.path), ['/', '/about']);
});

test('hashRoutes watches #/ navigation and does not repeat the same hash', async () => {
  const log = { records: [], async append(r) { log.records.push(...r); } };
  const collector = createCollector({
    settings: createSettingsSource({ settings: { streams: [{ ...STREAM, hash_routes: true }] } }),
    log,
    sessionSecret: 's',
    salt: 'x',
    rateLimitPerMinute: 1000
  });
  const net = collectorFetch(collector);
  const listeners = {};
  const win = {
    location: {
      host: 'www.example.com',
      origin: 'https://www.example.com',
      pathname: '/',
      search: '',
      hash: '#/home',
      get href() {
        return `https://www.example.com${this.pathname}${this.search}${this.hash}`;
      }
    },
    history: { pushState() {}, replaceState() {} },
    addEventListener: (n, f) => (listeners[n] = f)
  };
  const doc = { title: 't', referrer: '', addEventListener() {}, visibilityState: 'visible' };
  const gauge = createGauge({
    endpoint: 'https://g.example.com',
    stream: 'G-test',
    hashRoutes: true,
    fetch: net.fetch,
    storage: storage(),
    window: win,
    document: doc,
    navigator: {},
    flushMs: 0
  });
  gauge.start();
  win.location.hash = '#/about';
  listeners.hashchange();
  win.location.hash = '#/about';
  listeners.hashchange();
  await gauge.flush();
  assert.deepEqual(
    log.records.map((r) => r.path),
    ['/#/home', '/#/about']
  );
});

test('the server client sends a trusted hit with a key', async () => {
  const calls = [];
  const gauge = createGaugeServer({
    endpoint: 'https://g.example.com',
    stream: 'G-test',
    key: 'e9key_x',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { status: 200, text: async () => JSON.stringify({ ok: true, accepted: 1 }) };
    }
  });
  const r = await gauge.send([{ t: 'LOGIN', person_id: 12 }]);
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, 'https://g.example.com/send');
  assert.equal(calls[0].init.headers.authorization, 'Bearer e9key_x');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.hits[0].person_id, 12);
  assert.ok(body.hits[0].id, 'every hit gets an id');
});
