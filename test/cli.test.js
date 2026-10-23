import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './setup-plugins.js';
import { run, parseProps } from '../lib/cli.js';
import { createDiskLog } from '../lib/diskLog.js';
import PersonWorker from '@engine9/core/PersonWorker';
import { createGaugeHandlers } from '../lib/cloudflare.js';

const REPO = new URL('..', import.meta.url).pathname;
let dir;
let env;
let logDir;

function cli(...argv) {
  const out = [];
  const err = [];
  return run(argv, { cwd: REPO, env, out: (s) => out.push(s), err: (s) => err.push(s) }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-cli-'));
  logDir = path.join(dir, 'logs');
  env = { ENGINE9_DATABASE_CONNECTION: `sqlite://${path.join(dir, 'e.db')}` };
  const r = await cli('install', '--with-standard');
  assert.equal(r.code, 0, r.err);
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('tail names unrouted and identify records instead of printing undefined', async () => {
  const tailDir = path.join(dir, 'tail-logs');
  const log = createDiskLog({ directory: tailDir, fsync: 'none' });
  const at = new Date().toISOString();
  await log.append([
    { v: 1, kind: 'unrouted', hit_id: 'u1', received_at: at, stream: 'G-typo', raw: '{}' },
    { v: 1, kind: 'identify', hit_id: 'i1', received_at: at, stream: 'G-www', device_id: 'device-bbbbbbbb', person_id: 7 }
  ]);
  await log.close();
  const r = await cli('tail', '--log-dir', tailDir);
  assert.doesNotMatch(r.out, /undefined/);
  assert.match(r.out, /G-typo {2}unrouted: no stream has this id/);
  assert.match(r.out, /identify {2}device=device-b person=7/);
});

test('install is repeatable and says what to do next', async () => {
  const r = await cli('install');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /installed @engine9\/core-gauge\/gauge/);
  assert.match(r.out, /stream add/);
});

test('stream add, list and remove', async () => {
  let r = await cli('stream', 'add', '--id', 'G-www', '--name', 'www.example.com', '--hosts', 'www.example.com,example.com');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /createGauge\(\{ endpoint, stream: 'G-www' \}\)/);
  r = await cli('stream', 'add', '--id', 'G-www');
  assert.equal(r.code, 2);
  assert.match(r.err, /already exists/);
  r = await cli('stream', 'add', '--id', 'bad id');
  assert.equal(r.code, 2);
  r = await cli('stream', 'add', '--name', 'app', '--type', 'app_stream');
  assert.equal(r.code, 0);
  r = await cli('stream', 'list');
  assert.match(r.out, /G-www {2}web_stream {2}www\.example\.com {2}hosts=www\.example\.com,example\.com/);
  assert.match(r.out, /app_stream/);
  r = await cli('stream', 'remove', '--id', 'G-www');
  assert.equal(r.code, 0);
  assert.doesNotMatch((await cli('stream', 'list')).out, /G-www/);
  r = await cli('stream', 'remove', '--id', 'nope');
  assert.equal(r.code, 2);
});

test('stream --hash-routes is stored per stream and can be turned on and off', async () => {
  let r = await cli('stream', 'add', '--id', 'G-spa', '--hosts', 'spa.example.com', '--hash-routes', 'on');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hashRoutes: true/, 'the page needs the client option as well');
  r = await cli('stream', 'add', '--id', 'G-plain');
  assert.equal(r.code, 0, r.err);
  r = await cli('stream', 'list');
  assert.match(r.out, /G-spa .*hash_routes/);
  assert.doesNotMatch(r.out, /G-plain .*hash_routes/);

  r = await cli('stream', 'update', '--id', 'G-plain', '--hash-routes', 'on');
  assert.equal(r.code, 0, r.err);
  r = await cli('stream', 'update', '--id', 'G-spa', '--hash-routes', 'off');
  assert.equal(r.code, 0, r.err);
  r = await cli('stream', 'list');
  assert.match(r.out, /G-plain .*hash_routes/);
  assert.doesNotMatch(r.out, /G-spa .*hash_routes/);

  assert.equal((await cli('stream', 'update', '--id', 'G-spa')).code, 2, 'update needs something to change');
  assert.equal((await cli('stream', 'update', '--id', 'nope', '--hash-routes', 'on')).code, 2);
  await cli('stream', 'remove', '--id', 'G-spa');
  await cli('stream', 'remove', '--id', 'G-plain');
});

test('custom entries are validated, declared, and listed', async () => {
  let r = await cli('custom', 'add', '--name', 'Video Upload');
  assert.equal(r.code, 2);
  r = await cli('custom', 'add', '--name', 'video_upload', '--pin', '--props', 'size_mb:number,format:string');
  assert.equal(r.code, 0, r.err);
  r = await cli('custom', 'add', '--name', 'video_upload');
  assert.equal(r.code, 2);
  r = await cli('custom', 'add', '--name', 'site_search', '--entry-type', 'SEARCH');
  assert.equal(r.code, 0, r.err);
  r = await cli('custom', 'add', '--name', 'x', '--entry-type', 'NOT_A_TYPE');
  assert.equal(r.code, 2);
  r = await cli('custom', 'list');
  assert.match(r.out, /video_upload {2}key {2}props=size_mb:number,format:string/);
  assert.match(r.out, /site_search {2}type=SEARCH/);
  assert.equal((await cli('custom', 'remove', '--name', 'site_search')).code, 0);
});

test('parseProps rejects an untyped property', () => {
  assert.deepEqual(parseProps('a:number, b:boolean'), { a: 'number', b: 'boolean' });
  assert.throws(() => parseProps('a'), /needs a type/);
});

test('set validates against the setting definition', async () => {
  let r = await cli('set', 'timeline_mode', 'everything');
  assert.equal(r.code, 2);
  assert.match(r.err, /must be one of/);
  r = await cli('set', 'collect_enabled', 'maybe');
  assert.equal(r.code, 2);
  r = await cli('set', 'load_checkpoint', 'x');
  assert.equal(r.code, 2, 'the hidden checkpoint is not editable');
  r = await cli('set', 'timeline_mode', 'all');
  assert.equal(r.code, 0, r.err);
  r = await cli('settings');
  assert.match(r.out, /timeline_mode = all {3}\(changed\)/);
  assert.doesNotMatch(r.out, /load_checkpoint/);
  assert.doesNotMatch(r.out, /allowed_hosts.*\(changed\)/, 'an empty setting stored as null is still the default');
  assert.equal((await cli('set', 'timeline_mode', 'identified')).code, 0);
});

test('doctor reports a problem it can fix, and exits non-zero only for failures', async () => {
  let r = await cli('doctor', '--log-dir', logDir);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /ok {4}plugin installed/);
  assert.match(r.out, /warn {2}SESSION_SECRET is not set/);
  assert.match(r.out, /ok {4}log directory writable/);
  assert.match(r.out, /ok {4}the loader is caught up/);

  const bad = await run(['doctor'], { cwd: REPO, env: { ENGINE9_DATABASE_CONNECTION: `sqlite://${path.join(dir, 'empty.db')}` }, out: () => {}, err: () => {} });
  assert.equal(bad, 1, 'plugin not installed is a failure');
});

test('load reads the disk log into the database, and erase-logs removes a person and keeps the checkpoint right', async () => {
  const stream = (await cli('stream', 'list')).out.match(/^(G-\w+)/m)[1];
  const log = createDiskLog({ directory: logDir, fsync: 'none', clock: () => new Date(Date.now() - 3 * 3600 * 1000) });
  const base = Date.now() - 3 * 3600 * 1000;
  const hit = (n, extra = {}) => ({
    v: 1,
    kind: 'hit',
    hit_id: `hit-${n}`,
    received_at: new Date(base + n * 1000).toISOString(),
    ts: new Date(base + n * 1000).toISOString(),
    stream,
    entry_type_id: 102,
    entry_type: 'PAGE_VIEW',
    platform: 'web',
    device_id: 'device-aaaaaaaa',
    path: `/p${n}`,
    host: 'www.example.com',
    ...extra
  });
  await log.append([hit(1), hit(2, { person_id: 99 }), hit(3)]);
  await log.close();

  let r = await cli('load', '--log-dir', logDir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /loaded 3 records from 1 segments/);

  r = await cli('tail', '--log-dir', logDir, '-n', '2');
  assert.equal(r.out.split('\n').length, 2);
  assert.match(r.out, /PAGE_VIEW \S*\/p3/);

  r = await cli('erase-logs', '--person-id', '99', '--log-dir', logDir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /removed 1 records from 1 segments/);
  assert.match(r.out, /erasePeople/);

  r = await cli('load', '--log-dir', logDir);
  assert.match(r.out, /loaded 0 records/, 'the checkpoint moved with the rewrite; nothing is re-read');

  r = await cli('reloadStats', '--from', new Date(base).toISOString().slice(0, 10), '--log-dir', logDir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /reloaded 2 records/, 'the erased hit is gone from the log, so reloadStats cannot bring it back');
});

test('usage errors exit 2 with a message', async () => {
  assert.equal((await cli('nonsense')).code, 2);
  assert.equal((await cli('replay')).code, 2, 'replay was renamed reloadStats, with no alias');
  assert.equal((await cli('reloadStats')).code, 2);
  assert.equal((await cli('stream', 'add', '--hash-routes', 'maybe')).code, 2);
  assert.equal((await cli('erase-logs')).code, 2);
  assert.equal((await cli('stream', 'list', '--bogus')).code, 2);
  const noDb = await run(['stream', 'list'], { cwd: REPO, env: {}, out: () => {}, err: () => {} });
  assert.equal(noDb, 2);
  assert.equal((await cli('help')).code, 0);
});

// --- The same commands against a deployed Worker ------------------------------

test('install, stream, custom and set work against a Worker over HTTP, with an admin key', async () => {
  // A site database that has person and timeline but not gauge yet.
  const worker = new PersonWorker({ accountId: 'remote', auth: { database_connection: 'sqlite://:memory:' } });
  await worker.installDefaultPlugins({ path: '@engine9/schemas/stacks/standard' });
  try {
    const keyStore = {
      async verify(req) {
        const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (token === 'admin-key') return { valid: true, key: { scopes: ['admin'] } };
        if (token === 'send-key') return { valid: true, key: { scopes: ['gauge:send'] } };
        return { valid: false, reason: 'invalid key' };
      }
    };
    const handlers = createGaugeHandlers({ makeWorker: () => worker, makeKeyStore: () => keyStore });
    const env = { DB: {}, GAUGE_QUEUE: { async sendBatch() {} }, GAUGE_BASE_PATH: '/g' };
    const net = async (url, init) => {
      const res = await handlers.fetch(new Request(url, init), env, {});
      return { status: res.status, text: () => res.text() };
    };
    const remote = async (...argv) => {
      const out = [];
      const err = [];
      const code = await run(argv, { cwd: REPO, env: {}, fetch: net, out: (s) => out.push(s), err: (s) => err.push(s) });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    const base = ['--url', 'https://www.example.com/g', '--key', 'admin-key'];

    let r = await remote('stream', 'list', ...base);
    assert.equal(r.code, 2);
    assert.match(r.err, /409.*not installed/, 'before install the Worker says so');

    r = await remote('install', ...base);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /installed @engine9\/core-gauge\/gauge/);
    r = await remote('install', ...base);
    assert.equal(r.code, 0, 'install is idempotent');

    r = await remote('stream', 'add', '--id', 'G-www', '--hosts', 'www.example.com', ...base);
    assert.equal(r.code, 0, r.err);
    r = await remote('custom', 'add', '--name', 'video_upload', '--pin', ...base);
    assert.equal(r.code, 0, r.err);
    r = await remote('set', 'timeline_mode', 'all', ...base);
    assert.equal(r.code, 0, r.err);
    r = await remote('set', 'timeline_mode', 'everything', ...base);
    assert.equal(r.code, 2, 'validated before it is sent');

    r = await remote('stream', 'list', ...base);
    assert.match(r.out, /G-www {2}web_stream/);
    r = await remote('settings', ...base);
    assert.match(r.out, /timeline_mode = all {3}\(changed\)/);

    // The server side validates too, so a hand-written request cannot store garbage.
    const bad = await net('https://www.example.com/g/admin/settings', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-key' },
      body: JSON.stringify({ name: 'load_checkpoint', value: 'x' })
    });
    assert.equal(bad.status, 400);

    // Keys: none, wrong scope, wrong key.
    const noKey = await net('https://www.example.com/g/admin/settings', { method: 'GET' });
    assert.equal(noKey.status, 401);
    const sendOnly = await net('https://www.example.com/g/admin/settings', { method: 'GET', headers: { authorization: 'Bearer send-key' } });
    assert.equal(sendOnly.status, 403, 'a gauge:send key cannot administer');
    r = await remote('stream', 'list', '--url', 'https://www.example.com/g', '--key', 'nope');
    assert.equal(r.code, 2);
    assert.match(r.err, /403/);

    // Collector hits still work on the same Worker once installed.
    const hit = await net('https://www.example.com/g/collect', {
      method: 'POST',
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0.0.0', origin: 'https://www.example.com' },
      body: JSON.stringify({ s: 'G-www', hits: [{ id: 'hit-0000001', t: 'PAGE_VIEW', url: 'https://www.example.com/' }] })
    });
    assert.equal(hit.status, 200);
  } finally {
    await worker.destroyAll();
  }
});

test('the admin routes are off without a key store, and --url needs a key', async () => {
  const handlers = createGaugeHandlers({});
  const env = { GAUGE_QUEUE: { async sendBatch() {} } };
  const res = await handlers.fetch(new Request('https://x.example.com/admin/install', { method: 'POST' }), env, {});
  assert.equal(res.status, 501);
  const code = await run(['stream', 'list', '--url', 'https://x.example.com'], { cwd: REPO, env: {}, out: () => {}, err: () => {} });
  assert.equal(code, 2);
  const withStandard = await run(['install', '--url', 'https://x.example.com', '--key', 'k', '--with-standard'], { cwd: REPO, env: {}, out: () => {}, err: () => {} });
  assert.equal(withStandard, 2);
});
