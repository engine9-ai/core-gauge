import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGaugeWorker, rows } from './helpers.js';
import { GAUGE_ENTRY_TYPES, resolveEntryType } from '../lib/entryTypes.js';
import { parseSettings, readSettings } from '../lib/settings.js';

test('install deploys gauge tables, settings and the summary view', async () => {
  const { worker, plugin } = await createGaugeWorker();
  try {
    const { tables } = await worker.tables();
    for (const t of ['gauge_entry', 'gauge_device', 'gauge_session', 'gauge_device_day', 'gauge_view_day', 'gauge_entry_summary']) {
      assert.ok(tables.includes(t), `missing ${t}; have ${tables.filter((x) => x.startsWith('gauge')).join()}`);
    }
    assert.equal(plugin.path, '@engine9/core-gauge/gauge');
    const settings = await worker.getSettings({ pluginId: plugin.id });
    assert.equal(settings.timeline_mode, 'identified');
    assert.equal(settings.db_mode, 'rollups');
    const typed = await readSettings(worker);
    assert.equal(typed.streams.length, 1);
    assert.equal(typed.timelineMode, 'identified');
    assert.ok(typed.timelineEntryTypeIds.has(100));
    assert.ok(!typed.timelineEntryTypeIds.has(102), 'PAGE_VIEW is not a timeline default');
    const view = await rows(worker, 'select * from gauge_entry_summary');
    assert.deepEqual(view, []);
  } finally {
    await worker.destroyAll();
  }
});

test('reinstall is safe and keeps edited settings', async () => {
  const { worker, plugin } = await createGaugeWorker({ settings: { db_mode: 'entries' } });
  try {
    await worker.install({ path: '@engine9/core-gauge/gauge', unique: true });
    const settings = await worker.getSettings({ pluginId: plugin.id });
    assert.equal(settings.db_mode, 'entries');
  } finally {
    await worker.destroyAll();
  }
});

test('gauge tables carry person_id so erasePeople covers them', async () => {
  const { worker } = await createGaugeWorker();
  try {
    for (const t of ['gauge_entry', 'gauge_device', 'gauge_session', 'gauge_device_day']) {
      const { columns } = await worker.describe({ table: t });
      assert.ok(columns.some((c) => c.name === 'person_id'), `${t} has person_id`);
    }
  } finally {
    await worker.destroyAll();
  }
});

test('entry types: block 100-129, no collisions with standard ids, reverse map', () => {
  assert.equal(GAUGE_ENTRY_TYPES.SESSION_START, 100);
  assert.equal(GAUGE_ENTRY_TYPES[100], 'SESSION_START');
  assert.equal(GAUGE_ENTRY_TYPES.CUSTOM_ENTRY, 129);
  assert.equal(resolveEntryType('page_view').id, 102);
  assert.equal(resolveEntryType(106).name, 'LOGIN');
  assert.equal(resolveEntryType('FORM_SUBMIT').id, 60, 'reused standard type');
  assert.equal(resolveEntryType('EMAIL_OPEN'), null, 'a browser must not write email entries');
  assert.equal(resolveEntryType(42), null);
  assert.equal(resolveEntryType('nope'), null);
});

test('parseSettings defaults and validation', () => {
  const d = parseSettings({});
  assert.equal(d.sessionTimeoutMinutes, 30);
  assert.equal(d.consentMode, 'granted');
  assert.equal(d.ipMode, 'drop');
  const s = parseSettings({
    db_mode: 'bogus',
    sample_rate: '5',
    session_timeout_minutes: '0',
    collect_enabled: 'false',
    streams: '[{"id":"G-1"},{"id":"bad id"},{"id":"G-1"}]',
    custom_entries: '[{"name":"video_upload","key":true},{"name":"Bad Name"},{"name":"x","entry_type":"NOPE"},{"name":"newsletter","entry_type":"SIGNUP"}]'
  });
  assert.equal(s.dbMode, 'rollups');
  assert.equal(s.sampleRate, 1);
  assert.equal(s.sessionTimeoutMinutes, 1);
  assert.equal(s.collectEnabled, false);
  assert.deepEqual(s.streams.map((x) => x.id), ['G-1']);
  assert.deepEqual(s.customEntries.map((c) => c.name), ['video_upload', 'newsletter']);
  assert.equal(s.customEntries[1].entryType.id, 3);
});
