import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createGaugeWorker, rows, STREAM } from './helpers.js';
import { loadRecords, loadFromDisk } from '../lib/loader.js';
import { createDiskLog } from '../lib/diskLog.js';
import { createCollector } from '../lib/collector.js';
import { createSettingsSource } from '../lib/settings.js';
import { createSessionToken } from '@engine9/core/auth/delegate';

const T0 = Date.parse('2026-10-21T12:00:00Z');
const NOW = new Date('2026-10-21T14:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
let counter = 0;

function hit(o = {}) {
  counter += 1;
  const ts = o.ts || at(0);
  return {
    v: 1,
    kind: 'hit',
    hit_id: `hit-${String(counter).padStart(10, '0')}`,
    received_at: ts,
    stream: STREAM.id,
    input_type: 'web_stream',
    entry_type_id: 102,
    entry_type: 'PAGE_VIEW',
    platform: 'web',
    device_id: 'device-0000001',
    device_source: 'cookie',
    person_id: 0,
    consent: true,
    host: 'test.example.com',
    path: '/',
    device_class: 'desktop',
    country: 'US',
    ...o,
    ts
  };
}

const view = (min, p = '/', o = {}) => hit({ ts: at(min), path: p, ...o });
const timeline = (worker) =>
  rows(worker, 'select entry_type_id, person_id, input_id, ts, source_code_id, id from timeline order by ts, entry_type_id');

async function person(worker, pluginId, email) {
  const { personIds } = await worker.processPeople({
    pluginId,
    remoteInputId: 'gauge-test-people',
    inputType: 'api',
    batch: [{ email, given_name: 'Test' }]
  });
  return personIds[0];
}

test('anonymous traffic: sessions split on inactivity, rollups fill, nothing on the timeline', async () => {
  const { worker } = await createGaugeWorker();
  try {
    const stats = await loadRecords(worker, [view(0, '/'), view(2, '/pricing'), view(10, '/pricing'), view(55, '/')], { now: NOW });
    assert.equal(stats.hits, 4);
    assert.equal(stats.sessions_started, 2);

    const sessions = await rows(worker, 'select * from gauge_session order by start_ts');
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].entries, 3);
    assert.equal(sessions[0].views, 3);
    assert.equal(sessions[0].landing_view, '/');
    assert.equal(sessions[0].exit_view, '/pricing');
    assert.equal(sessions[0].duration_s, 600);
    assert.equal(sessions[0].date, '2026-10-21');
    assert.equal(Number(sessions[0].bounced), 0);
    assert.equal(sessions[1].entries, 1);
    assert.equal(Number(sessions[1].bounced), 1);
    assert.equal(Number(sessions[0].is_new_device), 1);
    assert.equal(Number(sessions[1].is_new_device), 0);

    const devices = await rows(worker, 'select * from gauge_device');
    assert.equal(devices.length, 1);
    assert.equal(Number(devices[0].person_id), 0);

    const dd = await rows(worker, 'select * from gauge_device_day');
    assert.equal(dd.length, 1);
    assert.equal(dd[0].sessions, 2);
    assert.equal(dd[0].views, 4);

    const vd = await rows(worker, 'select * from gauge_view_day order by view_name');
    assert.deepEqual(vd.map((r) => [r.view_name, r.views, r.sessions_started]), [
      ['/', 2, 2],
      ['/pricing', 2, 0]
    ]);

    assert.deepEqual(await timeline(worker), [], 'identified mode: anonymous hits stay off the timeline');
    assert.equal((await rows(worker, 'select count(*) as n from gauge_entry'))[0].n, 0, 'rollups mode stores no entries');
  } finally {
    await worker.destroyAll();
  }
});

test('unique devices over a date range come from gauge_device_day', async () => {
  const { worker } = await createGaugeWorker();
  try {
    await loadRecords(
      worker,
      [
        view(0, '/', { device_id: 'device-aaaaaaaa' }),
        view(1, '/', { device_id: 'device-bbbbbbbb' }),
        view(2, '/x', { device_id: 'device-aaaaaaaa' }),
        view(60 * 24 + 5, '/', { device_id: 'device-aaaaaaaa' })
      ],
      { now: NOW }
    );
    const [{ n }] = await rows(worker, "select count(distinct device_id) as n from gauge_device_day where date >= '2026-10-21' and date <= '2026-10-22'");
    assert.equal(n, 2);
    const [{ day1 }] = await rows(worker, "select count(distinct device_id) as day1 from gauge_device_day where date = '2026-10-22'");
    assert.equal(day1, 1);
  } finally {
    await worker.destroyAll();
  }
});

test('loading the same records twice leaves timeline and entries unchanged', async () => {
  const { worker } = await createGaugeWorker({ settings: { timeline_mode: 'all', db_mode: 'entries' } });
  try {
    const records = [view(0, '/'), view(1, '/about')];
    await loadRecords(worker, records, { now: NOW });
    const first = await timeline(worker);
    const entries1 = await rows(worker, 'select id from gauge_entry order by id');
    await loadRecords(worker, records, { now: NOW });
    assert.deepEqual(await timeline(worker), first, 'same ids, same rows');
    assert.deepEqual(await rows(worker, 'select id from gauge_entry order by id'), entries1);
    // SESSION_START and FIRST_VISIT only: PAGE_VIEW is not a timeline default
    assert.deepEqual(first.map((r) => r.entry_type_id), [100, 101]);
    assert.ok(first.every((r) => Number(r.person_id) === 0));
  } finally {
    await worker.destroyAll();
  }
});

test('a signed-in visit lands on the timeline with the person, and the device is linked', async () => {
  const { worker, plugin } = await createGaugeWorker();
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    const stats = await loadRecords(worker, [view(0, '/', { person_id: pid }), view(1, '/account', { person_id: pid })], { now: NOW });
    assert.equal(stats.devices_linked, 1);
    const tl = await timeline(worker);
    assert.deepEqual(tl.map((r) => r.entry_type_id).sort(), [100, 101, 108]);
    assert.ok(tl.every((r) => Number(r.person_id) === pid));
    const [dev] = await rows(worker, 'select * from gauge_device');
    assert.equal(Number(dev.person_id), pid);
    assert.ok(dev.identified_at);
    const [s] = await rows(worker, 'select * from gauge_session');
    assert.equal(Number(s.person_id), pid);
  } finally {
    await worker.destroyAll();
  }
});

test('browsing before a login in the same batch belongs to the person; a logout ends it', async () => {
  const { worker, plugin } = await createGaugeWorker({ settings: { timeline_mode: 'all' } });
  try {
    const sam = await person(worker, plugin.id, 'sam@example.com');
    const alex = await person(worker, plugin.id, 'alex@example.com');
    await loadRecords(
      worker,
      [
        view(0, '/a'), // anonymous, then Sam signs in
        view(1, '/b'),
        hit({ ts: at(2), entry_type_id: 106, entry_type: 'LOGIN', person_id: sam }),
        view(3, '/c', { person_id: sam }),
        hit({ ts: at(4), entry_type_id: 107, entry_type: 'LOGOUT', person_id: sam }),
        view(5, '/d'), // anonymous after logout, then Alex signs in on the same device
        hit({ ts: at(6), entry_type_id: 106, entry_type: 'LOGIN', person_id: alex })
      ],
      { now: NOW }
    );
    const tl = await timeline(worker);
    const login = tl.filter((r) => r.entry_type_id === 106);
    assert.deepEqual(login.map((r) => Number(r.person_id)), [sam, alex]);
    const sessions = await rows(worker, 'select * from gauge_session order by start_ts');
    assert.equal(sessions.length, 1, 'one run of activity');
    const [dev] = await rows(worker, 'select * from gauge_device');
    assert.equal(Number(dev.person_id), alex, 'the shared device now belongs to the latest person');
  } finally {
    await worker.destroyAll();
  }
});

test('first identification stitches earlier anonymous sessions and writes the held-back timeline rows', async () => {
  const { worker, plugin } = await createGaugeWorker();
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    await loadRecords(worker, [view(0, '/'), view(1, '/pricing')], { now: NOW });
    assert.deepEqual(await timeline(worker), [], 'held back while anonymous');

    // Two hours later the same device signs in.
    const stats = await loadRecords(worker, [view(180, '/account', { person_id: pid })], { now: new Date(T0 + 4 * 3600000) });
    assert.equal(stats.devices_linked, 1);
    assert.equal(stats.stitched_sessions, 1);

    const sessions = await rows(worker, 'select * from gauge_session order by start_ts');
    assert.equal(sessions.length, 2);
    assert.ok(sessions.every((s) => Number(s.person_id) === pid), 'the earlier session was attributed');
    const dd = await rows(worker, 'select * from gauge_device_day');
    assert.ok(dd.every((r) => Number(r.person_id) === pid));
    const tl = await timeline(worker);
    assert.equal(tl.filter((r) => r.entry_type_id === 100).length, 2, 'both session starts are on the timeline');
    assert.equal(tl.filter((r) => r.entry_type_id === 101).length, 1);
    assert.ok(tl.every((r) => Number(r.person_id) === pid));
  } finally {
    await worker.destroyAll();
  }
});

test('backfill_days 0 leaves earlier anonymous data alone', async () => {
  const { worker, plugin } = await createGaugeWorker({ settings: { backfill_days: 0 } });
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    await loadRecords(worker, [view(0, '/')], { now: NOW });
    await loadRecords(worker, [view(180, '/account', { person_id: pid })], { now: new Date(T0 + 4 * 3600000) });
    const sessions = await rows(worker, 'select person_id from gauge_session order by start_ts');
    assert.deepEqual(sessions.map((s) => Number(s.person_id)), [0, pid]);
  } finally {
    await worker.destroyAll();
  }
});

test('a session continues across loader runs', async () => {
  const { worker } = await createGaugeWorker();
  try {
    await loadRecords(worker, [view(0, '/'), view(1, '/a')], { now: NOW });
    await loadRecords(worker, [view(5, '/b')], { now: NOW });
    const sessions = await rows(worker, 'select * from gauge_session');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].entries, 3);
    assert.equal(sessions[0].exit_view, '/b');
    assert.equal(sessions[0].duration_s, 300);
  } finally {
    await worker.destroyAll();
  }
});

test('a new campaign starts a new session', async () => {
  const { worker } = await createGaugeWorker();
  try {
    await loadRecords(
      worker,
      [
        view(0, '/', { utm_source: 'news', utm_medium: 'email', utm_campaign: 'oct' }),
        view(1, '/a'), // no campaign: same session
        view(2, '/b', { utm_source: 'social', utm_medium: 'post', utm_campaign: 'oct' })
      ],
      { now: NOW }
    );
    const sessions = await rows(worker, 'select * from gauge_session order by start_ts');
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].utm_source, 'news');
    assert.equal(sessions[1].utm_source, 'social');
  } finally {
    await worker.destroyAll();
  }
});

test('db_mode entries stores every hit; custom entries get their own input; key entries reach the timeline', async () => {
  const { worker, plugin } = await createGaugeWorker({
    settings: {
      db_mode: 'entries',
      custom_entries: [{ name: 'video_upload', label: 'Uploaded a video', key: true, props: { size_mb: 'number' } }]
    }
  });
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    await loadRecords(
      worker,
      [
        view(0, '/studio', { person_id: pid, query: 'plan=pro', utm_source: 'news' }),
        hit({
          ts: at(1),
          entry_type_id: 129,
          entry_type: 'CUSTOM_ENTRY',
          name: 'video_upload',
          key: true,
          person_id: pid,
          value: 40,
          props: { size_mb: 40 },
          source_code: 'OCT_UPLOAD'
        }),
        hit({ ts: at(2), entry_type_id: 129, entry_type: 'CUSTOM_ENTRY', name: 'adhoc_thing', person_id: pid })
      ],
      { now: NOW }
    );
    const entries = await rows(worker, 'select * from gauge_entry order by ts');
    assert.equal(entries.length, 3);
    assert.equal(entries[0].path, '/studio');
    assert.equal(entries[0].query, 'plan=pro');
    assert.equal(entries[1].name, 'video_upload');
    assert.equal(entries[1].value, 40);
    assert.deepEqual(JSON.parse(entries[1].props), { size_mb: 40 });
    assert.ok(entries[0].gauge_session_id);

    const summary = await rows(
      worker,
      "select entry_type, name, remote_input_id, person_id from gauge_entry_summary where entry_type='CUSTOM_ENTRY' order by ts"
    );
    assert.deepEqual(summary.map((r) => r.name), ['video_upload', 'adhoc_thing'], 'ad hoc entries from a known person are on the timeline too');
    assert.equal(summary[1].remote_input_id, 'custom:adhoc_thing');
    assert.equal(summary[0].name, 'video_upload');
    assert.equal(summary[0].remote_input_id, 'custom:video_upload');
    assert.equal(Number(summary[0].person_id), pid);

    const [codes] = await rows(worker, 'select source_code_id from timeline where entry_type_id=129');
    assert.ok(Number(codes.source_code_id) > 0, 'source code resolved to the shared dictionary');
    const [{ code }] = await rows(worker, 'select source_code as code from source_code_dictionary where source_code_id=?', [codes.source_code_id]);
    assert.equal(code, 'OCT_UPLOAD');

    // Who uploaded videos: an ordinary timeline + input query, no gauge code needed.
    const who = await rows(
      worker,
      "select distinct t.person_id from timeline t join input i on i.id=t.input_id where t.entry_type_id=129 and i.remote_input_id='custom:video_upload'"
    );
    assert.deepEqual(who.map((r) => Number(r.person_id)), [pid]);
  } finally {
    await worker.destroyAll();
  }
});

test('entries mode: held-back key entries are written when the device is identified', async () => {
  const { worker, plugin } = await createGaugeWorker({
    settings: { db_mode: 'entries', custom_entries: [{ name: 'video_upload', key: true }] }
  });
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    await loadRecords(
      worker,
      [hit({ ts: at(0), entry_type_id: 129, entry_type: 'CUSTOM_ENTRY', name: 'video_upload', key: true })],
      { now: NOW }
    );
    assert.equal((await timeline(worker)).length, 0);
    await loadRecords(worker, [view(120, '/', { person_id: pid })], { now: new Date(T0 + 3 * 3600000) });
    const custom = (await timeline(worker)).filter((r) => r.entry_type_id === 129);
    assert.equal(custom.length, 1);
    assert.equal(Number(custom[0].person_id), pid);
    const [entry] = await rows(worker, "select person_id from gauge_entry where name='video_upload'");
    assert.equal(Number(entry.person_id), pid);
  } finally {
    await worker.destroyAll();
  }
});

test('timeline_mode none writes nothing to the timeline', async () => {
  const { worker, plugin } = await createGaugeWorker({ settings: { timeline_mode: 'none' } });
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    await loadRecords(worker, [view(0, '/', { person_id: pid })], { now: NOW });
    assert.deepEqual(await timeline(worker), []);
    assert.equal((await rows(worker, 'select count(*) as n from gauge_session'))[0].n, 1);
  } finally {
    await worker.destroyAll();
  }
});

test('timeline_entry_types can add PAGE_VIEW', async () => {
  const { worker, plugin } = await createGaugeWorker({ settings: { timeline_entry_types: 'PAGE_VIEW' } });
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    await loadRecords(worker, [view(0, '/', { person_id: pid }), view(1, '/x', { person_id: pid })], { now: NOW });
    const tl = await timeline(worker);
    assert.deepEqual(tl.map((r) => r.entry_type_id), [102, 102]);
  } finally {
    await worker.destroyAll();
  }
});

test('email from /identify: a known person is linked, an unknown one stays pending until it exists', async () => {
  const { worker, plugin } = await createGaugeWorker();
  try {
    const hash = (e) => createHash('sha256').update(e).digest('hex');
    const known = await person(worker, plugin.id, 'sam@example.com');
    await loadRecords(
      worker,
      [
        view(0, '/', { device_id: 'device-known001' }),
        view(1, '/', { device_id: 'device-later001' }),
        { v: 1, kind: 'identify', hit_id: 'ident-0000001', received_at: at(2), stream: STREAM.id, device_id: 'device-known001', email_hash_v1: hash('sam@example.com') },
        { v: 1, kind: 'identify', hit_id: 'ident-0000002', received_at: at(2), stream: STREAM.id, device_id: 'device-later001', email_hash_v1: hash('new@example.com') }
      ],
      { now: NOW }
    );
    const devs = Object.fromEntries((await rows(worker, 'select * from gauge_device')).map((d) => [d.device_id, d]));
    assert.equal(Number(devs['device-known001'].person_id), known);
    assert.equal(Number(devs['device-later001'].person_id), 0);
    assert.equal(devs['device-later001'].email_hash_v1, hash('new@example.com'), 'hash kept, never plaintext');

    // The person appears later (they sign up). The next run, with no new records, links the device.
    const later = await person(worker, plugin.id, 'new@example.com');
    const stats = await loadRecords(worker, [], { now: NOW });
    assert.equal(stats.devices_linked, 1);
    const [dev] = await rows(worker, "select * from gauge_device where device_id='device-later001'");
    assert.equal(Number(dev.person_id), later);
    assert.equal(dev.email_hash_v1, '', 'the hash is cleared once resolved');
  } finally {
    await worker.destroyAll();
  }
});

test('identify with a person_id links the device, from a server key', async () => {
  const { worker, plugin } = await createGaugeWorker();
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    await loadRecords(
      worker,
      [
        view(0, '/', { device_id: 'device-srv0001' }),
        { v: 1, kind: 'identify', hit_id: 'ident-0000009', received_at: at(1), stream: STREAM.id, device_id: 'device-srv0001', person_id: pid }
      ],
      { now: NOW }
    );
    const [dev] = await rows(worker, 'select * from gauge_device');
    assert.equal(Number(dev.person_id), pid);
    assert.equal((await timeline(worker)).filter((r) => r.entry_type_id === 108).length, 1);
  } finally {
    await worker.destroyAll();
  }
});

test('unknown streams, duplicates and other kinds are skipped, not fatal', async () => {
  const { worker } = await createGaugeWorker();
  try {
    const h = view(0, '/');
    const stats = await loadRecords(
      worker,
      [h, { ...h }, view(1, '/', { stream: 'G-gone' }), { kind: 'unrouted', stream: 'G-new' }, null, view(2, '/', { ts: 'not a date' })],
      { now: NOW }
    );
    assert.equal(stats.hits, 1);
    assert.equal(stats.skipped.duplicate, 1);
    assert.equal(stats.skipped.unknown_stream, 1);
    assert.equal(stats.skipped.kind, 1);
    assert.equal(stats.skipped.invalid, 2);
  } finally {
    await worker.destroyAll();
  }
});

test('erasePeople removes a person from every gauge table', async () => {
  const { worker, plugin } = await createGaugeWorker({ settings: { db_mode: 'entries', timeline_mode: 'all' } });
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    const other = await person(worker, plugin.id, 'alex@example.com');
    await loadRecords(
      worker,
      [
        view(0, '/', { person_id: pid, device_id: 'device-sam00001' }),
        view(1, '/', { person_id: other, device_id: 'device-alex0001' })
      ],
      { now: NOW }
    );
    const dry = await worker.erasePeople({ personIds: [pid], dryRun: true });
    for (const t of ['gauge_entry', 'gauge_device', 'gauge_session', 'gauge_device_day', 'timeline']) {
      assert.ok(dry.tables[t] >= 1, `${t} is covered by erase: ${JSON.stringify(dry.tables)}`);
    }
    await worker.erasePeople({ personIds: [pid] });
    for (const t of ['gauge_entry', 'gauge_device', 'gauge_session', 'gauge_device_day', 'timeline']) {
      const [{ n }] = await rows(worker, `select count(*) as n from ${t} where person_id=?`, [pid]);
      assert.equal(n, 0, `${t} has none left for the erased person`);
    }
    const [{ n }] = await rows(worker, 'select count(*) as n from gauge_session where person_id=?', [other]);
    assert.equal(n, 1, 'other people are untouched');
  } finally {
    await worker.destroyAll();
  }
});

test('end to end: collector -> disk log -> loader, with a checkpoint that only moves forward', async () => {
  const { worker, plugin } = await createGaugeWorker({ settings: { timeline_mode: 'all' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-e2e-'));
  let clock = new Date('2026-10-21T12:00:00Z');
  const log = createDiskLog({ directory: dir, fsync: 'always', hostId: 'web', pid: 1, clock: () => clock });
  const collector = createCollector({
    settings: createSettingsSource({ settings: { streams: [STREAM] } }),
    log,
    sessionSecret: 'secret',
    salt: 's',
    clock: () => clock
  });
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  const send = (hits, headers = {}) =>
    collector.handle({
      method: 'POST',
      path: '/collect',
      headers: { 'user-agent': UA, origin: 'https://test.example.com', ...headers },
      body: JSON.stringify({ s: STREAM.id, platform: 'web', ctx: { host: 'test.example.com' }, hits })
    });
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    const first = await send([
      { id: 'e2e-00000001', t: 'PAGE_VIEW', url: 'https://test.example.com/?utm_source=news' },
      { id: 'e2e-00000002', t: 'PAGE_VIEW', url: 'https://test.example.com/pricing' }
    ]);
    const device = JSON.parse(first.body).device_id;
    await log.flush();

    const run1 = await loadFromDisk(worker, { directory: dir, now: clock });
    assert.equal(run1.records, 2);
    assert.equal(run1.stats.sessions_started, 1);
    const run1b = await loadFromDisk(worker, { directory: dir, now: clock });
    assert.equal(run1b.records, 0, 'nothing new on a second run');
    assert.equal((await rows(worker, 'select entries from gauge_session'))[0].entries, 2, 'not counted twice');

    clock = new Date('2026-10-21T12:10:00Z');
    const token = createSessionToken({ personId: pid }, { secret: 'secret' });
    await send([{ id: 'e2e-00000003', t: 'LOGIN' }], { cookie: `e9_did=${device}; session=${token}` });
    const run2 = await loadFromDisk(worker, { directory: dir, now: clock });
    assert.equal(run2.records, 1);
    const [session] = await rows(worker, 'select * from gauge_session');
    assert.equal(session.entries, 3, 'continued the same gauge session');
    assert.equal(Number(session.person_id), pid);
    const [dev] = await rows(worker, 'select * from gauge_device');
    assert.equal(Number(dev.person_id), pid);
    assert.ok((await timeline(worker)).every((r) => Number(r.person_id) === pid), 'anonymous start was stitched to the person');

    const cp = await worker.getSettings({ pluginId: plugin.id });
    assert.ok(JSON.parse(cp.load_checkpoint).floor, 'checkpoint saved');

    // Much later, closed segments are compressed and still read as the same log.
    const later = new Date('2026-10-21T16:00:00Z');
    const run3 = await loadFromDisk(worker, { directory: dir, now: later });
    assert.equal(run3.records, 0);
    assert.ok(run3.pruned.gzipped >= 1);
  } finally {
    await log.close();
    await worker.destroyAll();
  }
});

test('replay from a date rebuilds sessions and rollups exactly', async () => {
  const { worker } = await createGaugeWorker({ settings: { timeline_mode: 'all' } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-replay-'));
  const log = createDiskLog({ directory: dir, fsync: 'none', hostId: 'web', pid: 1, clock: () => new Date('2026-10-21T12:00:00Z') });
  try {
    await log.append([view(0, '/'), view(1, '/a'), view(2, '/b')]);
    await log.flush();
    await loadFromDisk(worker, { directory: dir, now: NOW, prune: false });
    const before = {
      sessions: await rows(worker, 'select id, entries, views, duration_s from gauge_session'),
      dd: await rows(worker, 'select date, sessions, views, entries from gauge_device_day'),
      vd: await rows(worker, 'select date, view_name, views, sessions_started from gauge_view_day order by view_name'),
      tl: await timeline(worker)
    };
    const replay = await loadFromDisk(worker, { directory: dir, now: NOW, prune: false, from: '2026-10-21' });
    assert.equal(replay.records, 3);
    assert.deepEqual(await rows(worker, 'select id, entries, views, duration_s from gauge_session'), before.sessions);
    assert.deepEqual(await rows(worker, 'select date, sessions, views, entries from gauge_device_day'), before.dd);
    assert.deepEqual(await rows(worker, 'select date, view_name, views, sessions_started from gauge_view_day order by view_name'), before.vd);
    assert.deepEqual(await timeline(worker), before.tl, 'FIRST_VISIT and SESSION_START come back too');
  } finally {
    await log.close();
    await worker.destroyAll();
  }
});

test('a second loader is refused while one holds the lock', async () => {
  const { worker } = await createGaugeWorker();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-lock-'));
  fs.writeFileSync(path.join(dir, '.gauge-load.lock'), '123');
  try {
    const res = await loadFromDisk(worker, { directory: dir, now: NOW });
    assert.equal(res.locked, true);
  } finally {
    await worker.destroyAll();
  }
});

test('key:true pins a declared entry to the timeline when CUSTOM_ENTRY is not in timeline_entry_types', async () => {
  const { worker, plugin } = await createGaugeWorker({
    settings: {
      timeline_entry_types: 'SESSION_START',
      custom_entries: [{ name: 'video_upload', key: true }]
    }
  });
  try {
    const pid = await person(worker, plugin.id, 'sam@example.com');
    await loadRecords(
      worker,
      [
        hit({ ts: at(0), entry_type_id: 129, entry_type: 'CUSTOM_ENTRY', name: 'video_upload', key: true, person_id: pid }),
        hit({ ts: at(1), entry_type_id: 129, entry_type: 'CUSTOM_ENTRY', name: 'adhoc_thing', person_id: pid })
      ],
      { now: NOW }
    );
    const custom = (await timeline(worker)).filter((r) => r.entry_type_id === 129);
    assert.equal(custom.length, 1, 'only the key entry');
  } finally {
    await worker.destroyAll();
  }
});

test('a login that joins a session started anonymously in an earlier run still writes its start entries', async () => {
  for (const mode of ['identified', 'all']) {
    const { worker, plugin } = await createGaugeWorker({ settings: { timeline_mode: mode } });
    try {
      const pid = await person(worker, plugin.id, 'sam@example.com');
      await loadRecords(worker, [view(0, '/')], { now: NOW });
      await loadRecords(worker, [view(5, '/account', { person_id: pid })], { now: NOW }); // same session
      assert.equal((await rows(worker, 'select count(*) as n from gauge_session'))[0].n, 1);
      const tl = await timeline(worker);
      assert.deepEqual(tl.map((r) => r.entry_type_id).sort(), [100, 101, 108], mode);
      assert.ok(tl.every((r) => Number(r.person_id) === pid), `${mode}: every start entry has the person`);
    } finally {
      await worker.destroyAll();
    }
  }
});
