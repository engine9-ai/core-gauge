import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCollector, serverKeyVerifier } from '../lib/collector.js';
import { createSettingsSource } from '../lib/settings.js';
import { createSessionToken } from '@engine9/core/auth/delegate';

const STREAM = { id: 'G-test', name: 'test', type: 'web_stream', hosts: ['www.example.com'] };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SECRET = 'test-session-secret';

function memoryLog({ fail = false } = {}) {
  const log = {
    records: [],
    fail,
    async append(records) {
      if (log.fail) throw new Error('disk full');
      log.records.push(...records);
    }
  };
  return log;
}

function setup({ settings = {}, log = memoryLog(), verifyServerKey } = {}) {
  const source = createSettingsSource({ settings: { streams: [STREAM], ...settings } });
  const collector = createCollector({
    settings: source,
    log,
    sessionSecret: SECRET,
    salt: 'salt',
    verifyServerKey,
    rateLimitPerMinute: 1000,
    clock: () => new Date('2026-10-21T12:00:00Z')
  });
  return { collector, log };
}

function post(collector, body, headers = {}) {
  return collector.handle({
    method: 'POST',
    path: '/collect',
    headers: { 'user-agent': UA, origin: 'https://www.example.com', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    secure: true
  });
}

const page = (extra = {}) => ({
  s: 'G-test',
  platform: 'web',
  sent_at: Date.parse('2026-10-21T12:00:00Z'),
  ctx: { host: 'www.example.com' },
  hits: [
    {
      id: 'hit-0000001',
      t: 'PAGE_VIEW',
      ts: Date.parse('2026-10-21T11:59:59Z'),
      url: 'https://www.example.com/pricing/alex@example.com?utm_source=news&utm_medium=email&email=alex@example.com&plan=pro&x=1',
      referrer: 'https://news.example.org/story?id=7#frag',
      title: 'Pricing'
    }
  ],
  ...extra
});

test('collect: records a scrubbed hit, sets the device cookie, answers 200', async () => {
  const { collector, log } = setup({ settings: { query_param_allowlist: 'plan' } });
  const res = await post(collector, page());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.accepted, 1);
  assert.match(res.setCookie[0], /^e9_did=[A-Za-z0-9-]+; Max-Age=\d+; Path=\/; SameSite=Lax; HttpOnly; Secure$/);
  assert.equal(res.headers['access-control-allow-origin'], 'https://www.example.com');
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
  const r = log.records[0];
  assert.equal(r.kind, 'hit');
  assert.equal(r.entry_type, 'PAGE_VIEW');
  assert.equal(r.entry_type_id, 102);
  assert.equal(r.path, '/pricing/:email', 'email-looking path segment is replaced');
  assert.equal(r.query, 'plan=pro', 'only allowlisted parameters survive; email values never do');
  assert.equal(r.utm_source, 'news');
  assert.equal(r.utm_medium, 'email');
  assert.equal(r.referrer_host, 'news.example.org');
  assert.equal(r.referrer_path, '/story', 'no referrer query or fragment');
  assert.equal(r.browser, 'Chrome');
  assert.equal(r.os, 'macOS');
  assert.equal(r.device_class, 'desktop');
  assert.equal(r.person_id, 0);
  assert.equal(r.ip, undefined, 'the IP is not logged by default');
  assert.equal(r.ts, '2026-10-21T11:59:59.000Z');
  assert.ok(!JSON.stringify(r).includes('alex@example.com'), 'no email anywhere in the record');
});

test('collect: the device cookie is reused and no new cookie is set', async () => {
  const { collector, log } = setup();
  const first = await post(collector, page());
  const device = JSON.parse(first.body).device_id;
  const second = await post(collector, page({ hits: [{ id: 'hit-0000002', t: 'PAGE_VIEW', url: '/a' }] }), {
    cookie: `e9_did=${device}`
  });
  assert.equal(second.setCookie.length, 0);
  assert.equal(log.records[1].device_id, device);
});

test('collect: a retry with the same hit id is logged once', async () => {
  const { collector, log } = setup();
  await post(collector, page());
  await post(collector, page());
  assert.equal(log.records.length, 1);
});

test('collect: 503 when the log cannot be written, so the client retries', async () => {
  const log = memoryLog({ fail: true });
  const { collector } = setup({ log });
  const res = await post(collector, page());
  assert.equal(res.status, 503);
  assert.equal(res.headers['retry-after'], '5');
  log.fail = false;
  const retry = await post(collector, page());
  assert.equal(retry.status, 200, 'the same hit id is accepted after a failed attempt');
  assert.equal(log.records.length, 1);
});

test('collect: bots are dropped, not logged', async () => {
  const { collector, log } = setup();
  const res = await post(collector, page(), { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
  assert.equal(res.status, 200);
  assert.equal(log.records.length, 0);
  assert.equal(collector.stats.bots, 1);
});

test('collect: unknown stream is a 404 and a bounded copy is kept aside', async () => {
  const { collector, log } = setup();
  const res = await post(collector, page({ s: 'G-new' }));
  assert.equal(res.status, 404);
  assert.equal(log.records[0].kind, 'unrouted');
  assert.equal(log.records[0].stream, 'G-new');
  assert.ok(log.records[0].raw.length <= 4096);
});

test('collect: origin must match the stream hosts', async () => {
  const { collector, log } = setup();
  const res = await post(collector, page(), { origin: 'https://evil.example.net' });
  assert.equal(res.status, 403);
  assert.equal(log.records.length, 0);
});

test('collect: preflight answers for a configured origin only', async () => {
  const { collector } = setup();
  const ok = await collector.handle({ method: 'OPTIONS', path: '/collect', headers: { origin: 'https://www.example.com' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'https://www.example.com');
  const bad = await collector.handle({ method: 'OPTIONS', path: '/collect', headers: { origin: 'https://evil.example.net' } });
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
});

test('person: a verified Core Session sets person_id; a forged one does not', async () => {
  const { collector, log } = setup();
  const good = createSessionToken({ personId: 42 }, { secret: SECRET });
  await post(collector, page(), { cookie: `session=${good}` });
  assert.equal(log.records[0].person_id, 42);
  assert.equal(log.records[0].person_source, 'core_session');

  const forged = createSessionToken({ personId: 99 }, { secret: 'not-the-secret' });
  await post(collector, page({ hits: [{ id: 'hit-0000009', t: 'PAGE_VIEW', url: '/x' }] }), {
    cookie: `session=${forged}`
  });
  assert.equal(log.records[1].person_id, 0);

  // The body can say anything; it is never trusted for who a person is.
  await post(collector, page({ hits: [{ id: 'hit-0000010', t: 'PAGE_VIEW', url: '/x', person_id: 7, email: 'a@b.co' }] }));
  assert.equal(log.records[2].person_id, 0);
  assert.equal(log.records[2].email_hash_v1, undefined);
});

test('person: the X-Engine9-Session header works for apps', async () => {
  const { collector, log } = setup();
  const token = createSessionToken({ personId: 5 }, { secret: SECRET });
  await post(
    collector,
    { s: 'G-test', platform: 'ios', device_id: 'ios-device-00001', hits: [{ id: 'hit-0000020', t: 'SCREEN_VIEW', screen: 'Home' }] },
    { 'x-engine9-session': token, origin: undefined }
  );
  assert.equal(log.records[0].person_id, 5);
  assert.equal(log.records[0].device_id, 'ios-device-00001');
  assert.equal(log.records[0].platform, 'ios');
  assert.equal(log.records[0].screen, 'Home');
});

test('consent: required mode is cookieless and never links a person', async () => {
  const { collector, log } = setup({ settings: { consent_mode: 'required' } });
  const token = createSessionToken({ personId: 42 }, { secret: SECRET });
  const res = await post(collector, page(), { cookie: `session=${token}` });
  assert.equal(res.setCookie.length, 0, 'no cookie without consent');
  assert.equal(log.records[0].device_source, 'cookieless');
  assert.match(log.records[0].device_id, /^cl_[a-f0-9]{32}$/);
  assert.equal(log.records[0].person_id, 0);
  assert.equal(JSON.parse(res.body).device_id, undefined, 'a cookieless id is not handed back');

  // Same device, same day: same id. That is what makes daily unique counts possible.
  await post(collector, page({ hits: [{ id: 'hit-0000030', t: 'PAGE_VIEW', url: '/y' }] }));
  assert.equal(log.records[1].device_id, log.records[0].device_id);

  // The client reporting consent switches to a cookie.
  const granted = await post(collector, page({ consent: true, hits: [{ id: 'hit-0000031', t: 'PAGE_VIEW', url: '/y' }] }));
  assert.equal(granted.setCookie.length, 1);
});

test('consent: Sec-GPC and an explicit consent:false are honoured', async () => {
  const { collector, log } = setup();
  await post(collector, page(), { 'sec-gpc': '1' });
  assert.equal(log.records[0].device_source, 'cookieless');
  await post(collector, page({ consent: false, hits: [{ id: 'hit-0000040', t: 'PAGE_VIEW', url: '/z' }] }));
  assert.equal(log.records[1].device_source, 'cookieless');
});

test('hits: derived and server-only types are rejected from a browser', async () => {
  const { collector, log } = setup();
  const res = await post(
    collector,
    page({
      hits: [
        { id: 'hit-0000050', t: 'SESSION_START' },
        { id: 'hit-0000051', t: 'TRANSACTION', value: 100 },
        { id: 'hit-0000052', t: 'EMAIL_OPEN' },
        { id: 'hit-0000053', t: 'PAGE_VIEW', url: '/ok' }
      ]
    })
  );
  const body = JSON.parse(res.body);
  assert.equal(body.accepted, 1);
  assert.equal(body.rejected.length, 3);
  assert.equal(log.records.length, 1);
});

test('custom entries: ad hoc, declared, mapped, and undeclared-blocked', async () => {
  const { collector, log } = setup({
    settings: {
      custom_entries: [
        { name: 'video_upload', key: true, props: { size_mb: 'number', title: 'string' } },
        { name: 'newsletter', entry_type: 'SIGNUP' }
      ]
    }
  });
  const res = await post(
    collector,
    page({
      hits: [
        { id: 'hit-0000060', name: 'video_upload', props: { size_mb: 40, title: 'Demo', junk: 1, owner: 'a@b.co' } },
        { id: 'hit-0000061', name: 'newsletter' },
        { id: 'hit-0000062', name: 'free_form', props: { n: 3, ok: true, nested: { a: 1 } } },
        { id: 'hit-0000063', name: 'Bad Name' }
      ]
    })
  );
  assert.equal(JSON.parse(res.body).accepted, 3);
  const [video, news, free] = log.records;
  assert.equal(video.entry_type, 'CUSTOM_ENTRY');
  assert.equal(video.name, 'video_upload');
  assert.equal(video.key, true);
  assert.deepEqual(video.props, { size_mb: 40, title: 'Demo' }, 'declared entries keep declared properties only');
  assert.equal(news.entry_type, 'SIGNUP', 'mapped onto a standard type');
  assert.equal(news.entry_type_id, 3);
  assert.deepEqual(free.props, { n: 3, ok: true }, 'nested values are dropped');

  const strict = setup({ settings: { allow_undeclared_custom: false } });
  const out = await post(strict.collector, page({ hits: [{ id: 'hit-0000070', name: 'free_form' }] }));
  assert.equal(out.status, 400);
  assert.equal(strict.log.records.length, 0);
});

test('timestamps: client clock skew is corrected; future and ancient are clamped', async () => {
  const { collector, log } = setup();
  const now = Date.parse('2026-10-21T12:00:00Z');
  await post(
    collector,
    page({
      sent_at: now - 3600 * 1000, // the client clock is an hour behind
      hits: [
        { id: 'hit-0000080', t: 'PAGE_VIEW', url: '/a', ts: now - 3600 * 1000 - 10000 },
        { id: 'hit-0000081', t: 'PAGE_VIEW', url: '/b', ts: now + 86400000 },
        { id: 'hit-0000082', t: 'PAGE_VIEW', url: '/c', ts: now - 30 * 86400000 }
      ]
    })
  );
  assert.equal(log.records[0].ts, new Date(now - 10000).toISOString());
  assert.equal(log.records[1].ts_clamped, 'future');
  assert.equal(log.records[2].ts_clamped, 'too_old');
});

test('limits and validation', async () => {
  const { collector } = setup();
  assert.equal((await post(collector, 'not json')).status, 400);
  assert.equal((await post(collector, { s: 'G-test', hits: [] })).status, 400);
  const many = { s: 'G-test', hits: Array.from({ length: 51 }, (_, i) => ({ id: `hit-${i}x`, t: 'PAGE_VIEW' })) };
  assert.equal((await post(collector, many)).status, 413);
  assert.equal((await post(collector, 'x'.repeat(40000))).status, 413);
});

test('collect.gif records one hit and always returns a gif', async () => {
  const { collector, log } = setup();
  const res = await collector.handle({
    method: 'GET',
    path: '/collect.gif',
    query: { s: 'G-test', url: 'https://www.example.com/email-landing?utm_source=blast', host: 'www.example.com' },
    headers: { 'user-agent': UA }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/gif');
  assert.equal(log.records[0].path, '/email-landing');
  assert.equal(log.records[0].utm_source, 'blast');
});

test('disabled: collect_enabled false records nothing', async () => {
  const { collector, log } = setup({ settings: { collect_enabled: 'false' } });
  const res = await post(collector, page());
  assert.equal(res.status, 204);
  assert.equal(log.records.length, 0);
});

test('sampling: sample_rate 0 records nothing', async () => {
  const { collector, log } = setup({ settings: { sample_rate: 0 } });
  await post(collector, page());
  assert.equal(log.records.length, 0);
});

test('ip_mode truncate keeps /24 only', async () => {
  const { collector, log } = setup({ settings: { ip_mode: 'truncate' } });
  await post(collector, page(), { 'x-forwarded-for': '203.0.113.77' });
  assert.equal(log.records[0].ip, '203.0.113.0');
});

test('send and identify need a key with scope gauge:send', async () => {
  const keyStore = {
    async verify(req) {
      const token = req.headers.authorization;
      if (token === 'Bearer e9key_good') return { valid: true, key: { scopes: ['gauge:send'] } };
      if (token === 'Bearer e9key_other') return { valid: true, key: { scopes: ['people:write'] } };
      return { valid: false, reason: 'unknown key' };
    }
  };
  const { collector, log } = setup({ verifyServerKey: serverKeyVerifier(keyStore) });
  const send = (body, key) =>
    collector.handle({
      method: 'POST',
      path: '/send',
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: JSON.stringify(body)
    });

  assert.equal((await send(page())).status, 401);
  assert.equal((await send(page(), 'e9key_other')).status, 401);
  assert.equal((await send(page(), 'e9key_nope')).status, 401);

  const res = await send(
    {
      s: 'G-test',
      hits: [
        {
          id: 'srv-00000001',
          t: 'TRANSACTION',
          value: 25,
          email: 'Alex@Example.com',
          ts: Date.parse('2026-10-21T11:00:00Z')
        },
        { id: 'srv-00000002', t: 'LOGIN', person_id: 12 }
      ]
    },
    'e9key_good'
  );
  assert.equal(res.status, 200);
  const [tx, login] = log.records;
  assert.equal(tx.entry_type, 'TRANSACTION', 'a server key may send what a browser may not');
  assert.equal(tx.platform, 'server');
  assert.equal(
    tx.email_hash_v1,
    createHash('sha256').update('alex@example.com').digest('hex'),
    'email is hashed the way core hashes it (email_hash_v1: sha256 of the lowercased address)'
  );
  assert.ok(!JSON.stringify(tx).toLowerCase().includes('alex@example.com'));
  assert.equal(login.person_id, 12);
  assert.equal(login.person_source, 'server');

  const id = await collector.handle({
    method: 'POST',
    path: '/identify',
    headers: { authorization: 'Bearer e9key_good' },
    body: JSON.stringify({ s: 'G-test', device_id: 'device-abcdef12', email: 'alex@example.com' })
  });
  assert.equal(id.status, 200);
  const rec = log.records.at(-1);
  assert.equal(rec.kind, 'identify');
  assert.equal(rec.device_id, 'device-abcdef12');
  assert.match(rec.email_hash_v1, /^[a-f0-9]{64}$/);

  const bad = await collector.handle({
    method: 'POST',
    path: '/identify',
    headers: { authorization: 'Bearer e9key_good' },
    body: JSON.stringify({ s: 'G-test', device_id: 'device-abcdef12' })
  });
  assert.equal(bad.status, 400);
});

test('send is off without a key verifier', async () => {
  const { collector } = setup();
  const res = await collector.handle({ method: 'POST', path: '/send', headers: {}, body: JSON.stringify(page()) });
  assert.equal(res.status, 501);
});

test('browser IDENTIFY needs a Core Session and becomes an identify record', async () => {
  const { collector, log } = setup();
  const anon = await post(collector, page({ hits: [{ id: 'hit-0000090', t: 'IDENTIFY' }] }));
  assert.equal(anon.status, 400);
  const token = createSessionToken({ personId: 77 }, { secret: SECRET });
  await post(collector, page({ hits: [{ id: 'hit-0000091', t: 'IDENTIFY' }] }), { cookie: `session=${token}` });
  assert.equal(log.records[0].kind, 'identify');
  assert.equal(log.records[0].person_id, 77);
});

test('ok reports health and counters', async () => {
  const { collector } = setup();
  const res = await collector.handle({ method: 'GET', path: '/ok', headers: {} });
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.streams, 1);
});
