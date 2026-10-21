import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  GAUGE_ENTRY_TYPES,
  GAUGE_ENTRY_TYPE_BLOCK,
  REUSED_ENTRY_TYPES,
  resolveEntryType,
  DEFAULT_TIMELINE_ENTRY_TYPES
} from '../lib/entryTypes.js';

const names = Object.keys(GAUGE_ENTRY_TYPES).filter((k) => Number.isNaN(Number(k)));

test('every gauge id is unique and inside the reserved block', () => {
  const ids = names.map((n) => GAUGE_ENTRY_TYPES[n]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(id >= GAUGE_ENTRY_TYPE_BLOCK.min && id <= GAUGE_ENTRY_TYPE_BLOCK.max, `${id} is outside the block`);
});

test('ids never change once shipped', () => {
  // If this fails, you renumbered something. Add a new type instead.
  assert.deepEqual(
    Object.fromEntries(names.map((n) => [n, GAUGE_ENTRY_TYPES[n]])),
    {
      SESSION_START: 100,
      FIRST_VISIT: 101,
      PAGE_VIEW: 102,
      SCREEN_VIEW: 103,
      ENGAGEMENT: 104,
      APP_UPDATE: 105,
      LOGIN: 106,
      LOGOUT: 107,
      IDENTIFY: 108,
      SEARCH: 109,
      OUTBOUND_CLICK: 110,
      FILE_DOWNLOAD: 111,
      FORM_START: 112,
      VIDEO_START: 113,
      VIDEO_COMPLETE: 114,
      SHARE: 115,
      CUSTOM_ENTRY: 129
    }
  );
});

test('resolve accepts names and ids, case-insensitively, and nothing outside the allowed set', () => {
  assert.deepEqual(resolveEntryType('page_view'), { id: 102, name: 'PAGE_VIEW' });
  assert.deepEqual(resolveEntryType(106), { id: 106, name: 'LOGIN' });
  assert.deepEqual(resolveEntryType('106'), { id: 106, name: 'LOGIN' });
  assert.deepEqual(resolveEntryType('FORM_SUBMIT'), { id: 60, name: 'FORM_SUBMIT' });
  for (const refused of ['EMAIL_OPEN', 42, 'TRANSACTION_REFUND', 130, 99, '', null, undefined, 'drop table']) {
    assert.equal(resolveEntryType(refused), null, String(refused));
  }
});

test('the default timeline types are all real names', () => {
  for (const n of DEFAULT_TIMELINE_ENTRY_TYPES) assert.ok(resolveEntryType(n), n);
});

test('gauge agrees with @engine9/input-tools wherever input-tools has the block', async (t) => {
  // The sibling checkout is the source of truth while the block is unpublished.
  const sibling = new URL('../../input-tools/timelineTypes.js', import.meta.url);
  let table;
  if (existsSync(sibling)) table = (await import(sibling.href)).TIMELINE_ENTRY_TYPES;
  else {
    try {
      table = (await import('@engine9/input-tools')).TIMELINE_ENTRY_TYPES;
    } catch {
      table = null;
    }
  }
  if (!table || table.PAGE_VIEW === undefined) {
    t.skip('input-tools does not have the gauge block yet');
    return;
  }
  for (const n of names) assert.equal(table[n], GAUGE_ENTRY_TYPES[n], `${n}: input-tools has ${table[n]}`);
  for (const [n, id] of Object.entries(REUSED_ENTRY_TYPES)) assert.equal(table[n], id, `${n} (reused): input-tools has ${table[n]}`);
  // Nothing else in input-tools may sit inside gauge's block.
  for (const [k, v] of Object.entries(table)) {
    if (typeof v !== 'number') continue;
    if (v >= GAUGE_ENTRY_TYPE_BLOCK.min && v <= GAUGE_ENTRY_TYPE_BLOCK.max) {
      assert.equal(GAUGE_ENTRY_TYPES[k], v, `${k} (${v}) is in gauge's block but gauge does not own it`);
    }
  }
});
