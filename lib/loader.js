/*
  The gauge loader: turns log records into database rows.

  The collector writes a log and never touches the database. The loader reads
  that log (or a batch from a queue) and, depending on settings:

    always          gauge_device, gauge_session, gauge_device_day, gauge_view_day
    db_mode=entries gauge_entry, one row per hit
    timeline_mode   timeline rows (the engine9 person activity timeline)

  Identity. A hit carries person_id only when the collector verified a Core
  Session or a server key vouched for it. When a device first becomes known:
    - its earlier anonymous sessions and daily rows in the last backfill_days
      get the person,
    - with timeline_mode=identified, the timeline rows held back for it are
      written (session starts and first visits come from gauge_session; other
      held-back entries need db_mode=entries, or a replay of the log),
    - an IDENTIFY entry records the link.
  Emails from /identify are SHA-256 hashes; they are looked up in core's
  email_hash_v1 store. An unknown email stays pending and is retried on every
  run. Gauge never creates people.

  Delivery is at least once. Timeline and gauge_entry rows are idempotent (same
  id, same row). The counters in gauge_session and the daily rollups add, so a
  crash between the database write and the checkpoint can count a small batch
  twice; `e9gauge replay --from <date>` rebuilds a range exactly.
*/
import fs from 'node:fs';
import path from 'node:path';
import {
  getTimelineEntryUUID,
  uuidIsValid
} from '@engine9/core/utilities';
import { createDefaultIdentifierStore } from '@engine9/core/id';
import { sessionize, carryPersonBack, viewOf, toDate, utcDate } from './sessionize.js';
import { findGaugePlugin, readSettings, writeSetting, GAUGE_PLUGIN_PATH } from './settings.js';
import { listSegments, readSegment, gzipSegment, removeSegment, hourPrefix, segmentHour } from './diskLog.js';
import { isValidCustomName } from './settings.js';

const CHUNK = 5000;
const IN_LIST = 200;

const T = { SESSION_START: 100, FIRST_VISIT: 101, LOGOUT: 107, IDENTIFY: 108, CUSTOM_ENTRY: 129 };

function chunks(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

const marks = (n) => Array.from({ length: n }, () => '?').join(',');
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const dateOnly = (d) => utcDate(d);
/** A datetime parameter in the form core stores (ISO, no zone, no milliseconds). */
const qd = (d) => toDate(d).toISOString().slice(0, -5);

async function selectIn(worker, { select, table, where = '', values = [], column, list, tail = '' }) {
  const out = [];
  for (const part of chunks(list, IN_LIST)) {
    const { data } = await worker.query({
      sql: `select ${select} from ${table} where ${where ? `${where} and ` : ''}${column} in (${marks(part.length)}) ${tail}`,
      values: [...values, ...part]
    });
    out.push(...data);
  }
  return out;
}

/** Counters returned by every load. */
function newStats() {
  return {
    records: 0,
    hits: 0,
    identifies: 0,
    skipped: { unknown_stream: 0, kind: 0, invalid: 0, duplicate: 0 },
    sessions_started: 0,
    sessions_touched: 0,
    devices_new: 0,
    devices_linked: 0,
    stitched_sessions: 0,
    entries: 0,
    timeline: 0
  };
}

/**
 * Load a batch of log records.
 *
 * @param {object} worker  a core PersonWorker (any SQL dialect)
 * @param {object[]} records  parsed log records (kind hit | identify | unrouted)
 * @param {{ settings?: object, plugin?: { id: string }, now?: Date }} [options]
 */
export async function loadRecords(worker, records, options = {}) {
  const plugin = options.plugin || (await findGaugePlugin(worker));
  if (!plugin) throw new Error(`${GAUGE_PLUGIN_PATH} is not installed`);
  const settings = options.settings || (await readSettings(worker));
  const now = options.now || new Date();
  const ctx = new LoadContext({ worker, plugin, settings, now });
  const stats = newStats();
  stats.records = records.length;

  const hits = [];
  const anchors = [];
  const emailLinks = new Map();
  const seen = new Set();
  for (const r of records) {
    if (!r || typeof r !== 'object') {
      stats.skipped.invalid += 1;
      continue;
    }
    if (r.kind !== 'hit' && r.kind !== 'identify') {
      stats.skipped.kind += 1;
      continue;
    }
    const stream = settings.streams.find((s) => s.id === r.stream);
    if (!stream || !r.device_id) {
      stats.skipped.unknown_stream += 1;
      continue;
    }
    if (r.kind === 'hit') {
      if (!r.hit_id || seen.has(r.hit_id)) {
        stats.skipped.duplicate += 1;
        continue;
      }
      seen.add(r.hit_id);
      if (!r.ts || Number.isNaN(toDate(r.ts).getTime())) {
        stats.skipped.invalid += 1;
        continue;
      }
      hits.push({ ...r });
      stats.hits += 1;
      if (r.email_hash_v1 && !r.person_id) emailLinks.set(`${r.stream}|${r.device_id}`, r.email_hash_v1);
    } else {
      stats.identifies += 1;
      const key = `${r.stream}|${r.device_id}`;
      if (r.person_id) {
        anchors.push({
          ...r,
          ts: r.received_at,
          entry_type_id: T.IDENTIFY,
          person_id: Number(r.person_id),
          _anchor: true
        });
      } else if (r.email_hash_v1) emailLinks.set(key, r.email_hash_v1);
    }
  }

  const byTime = (a, b) => toDate(a.ts) - toDate(b.ts) || String(a.received_at).localeCompare(String(b.received_at));
  // Carry a login back over the same device's earlier anonymous hits.
  const timeline = [...hits, ...anchors].sort(byTime);
  carryPersonBack(timeline);
  const ordered = timeline.filter((h) => !h._anchor);

  for (const part of chunks(ordered, CHUNK)) await ctx.processHits(part, stats);
  await ctx.applyAnchors(anchors, stats);
  await ctx.applyEmailLinks(emailLinks, stats);
  await ctx.resolvePendingEmails(stats);
  return stats;
}

class LoadContext {
  constructor({ worker, plugin, settings, now }) {
    this.worker = worker;
    this.plugin = plugin;
    this.settings = settings;
    this.now = now;
    this.inputs = new Map();
    this.storePromise = null;
  }

  // --- inputs ----------------------------------------------------------------

  async streamInput(stream) {
    return this.input(`stream:${stream.id}`, stream.name, stream.type);
  }

  async customInput(name) {
    const declared = this.settings.customEntries.find((c) => c.name === name);
    return this.input(`custom:${name}`, declared?.label || name, 'gauge_custom');
  }

  async input(remoteInputId, remoteInputName, inputType) {
    if (this.inputs.has(remoteInputId)) return this.inputs.get(remoteInputId);
    const id = await this.worker.getInputId({
      pluginId: this.plugin.id,
      remoteInputId,
      remoteInputName,
      inputType
    });
    this.inputs.set(remoteInputId, id);
    return id;
  }

  timelineId(remote, ts) {
    if (uuidIsValid(remote)) return getTimelineEntryUUID({ remote_entry_uuid: remote });
    return getTimelineEntryUUID({ remote_entry_id: remote, plugin_id: this.plugin.id, ts: toDate(ts) });
  }

  // --- eligibility -----------------------------------------------------------

  timelineEligible({ typeId, key, personId }) {
    const mode = this.settings.timelineMode;
    if (mode === 'none') return false;
    if (!(this.settings.timelineEntryTypeIds.has(typeId) || key)) return false;
    return mode === 'all' || personId > 0;
  }

  // --- the main pass ---------------------------------------------------------

  async processHits(hits, stats) {
    const { worker, settings } = this;
    if (hits.length === 0) return;

    const streams = new Map(settings.streams.map((s) => [s.id, s]));
    const inputIdByStream = new Map();
    for (const s of streams.values()) inputIdByStream.set(s.id, await this.streamInput(s));

    // Existing devices and latest sessions for the devices in this chunk.
    const devicesByInput = new Map();
    for (const h of hits) {
      const input = inputIdByStream.get(h.stream);
      if (!devicesByInput.has(input)) devicesByInput.set(input, new Set());
      devicesByInput.get(input).add(h.device_id);
    }
    const minTs = new Date(Math.min(...hits.map((h) => toDate(h.ts).getTime())) - settings.sessionTimeoutMinutes * 60000);
    const deviceRows = new Map();
    const latestSessions = new Map();
    for (const [input, ids] of devicesByInput) {
      const rows = await selectIn(worker, {
        select: '*',
        table: 'gauge_device',
        where: 'input_id=?',
        values: [input],
        column: 'device_id',
        list: [...ids]
      });
      for (const r of rows) deviceRows.set(`${input}|${r.device_id}`, r);
      const sessions = await selectIn(worker, {
        select: '*',
        table: 'gauge_session',
        where: 'input_id=? and end_ts>=?',
        values: [input, qd(minTs)],
        column: 'device_id',
        list: [...ids],
        tail: 'order by start_ts desc'
      });
      for (const s of sessions) {
        const k = `${input}|${s.device_id}`;
        if (!latestSessions.has(k)) latestSessions.set(k, s); // newest first
      }
    }

    // sessionize keys by `${stream}|${device}`; map stored rows into that space.
    const existing = new Map();
    const knownDevices = new Set();
    for (const h of hits) {
      const input = inputIdByStream.get(h.stream);
      const sk = `${h.stream}|${h.device_id}`;
      const dk = `${input}|${h.device_id}`;
      if (deviceRows.has(dk)) knownDevices.add(sk);
      if (latestSessions.has(dk) && !existing.has(sk)) {
        const s = latestSessions.get(dk);
        existing.set(sk, {
          ...s,
          stream: h.stream,
          person_id: num(s.person_id),
          entries: num(s.entries),
          views: num(s.views),
          is_new_device: bool(s.is_new_device)
        });
      }
    }
    const { sessions, assignments, started } = sessionize({
      hits,
      existing,
      knownDevices,
      timeoutMs: settings.sessionTimeoutMinutes * 60000
    });
    for (const h of hits) h.gauge_session_id = assignments.get(h.hit_id);
    const sessionById = new Map(sessions.map((s) => [s.id, s]));
    stats.sessions_touched += sessions.length;
    stats.sessions_started += started.size;

    // Sessions.
    await worker.upsertArray({
      table: 'gauge_session',
      array: sessions.map((s) => ({
        id: s.id,
        input_id: inputIdByStream.get(s.stream),
        device_id: s.device_id,
        person_id: s.person_id || 0,
        platform: s.platform,
        start_ts: s.start_ts,
        end_ts: s.end_ts,
        date: s.date,
        entries: s.entries,
        views: s.views,
        landing_view: s.landing_view,
        exit_view: s.exit_view,
        referrer_host: s.referrer_host,
        utm_source: s.utm_source,
        utm_medium: s.utm_medium,
        utm_campaign: s.utm_campaign,
        country: s.country,
        device_class: s.device_class,
        is_new_device: Boolean(s.is_new_device),
        bounced: Boolean(s.bounced),
        duration_s: s.duration_s
      }))
    });

    // Devices.
    const links = [];
    const newDevices = new Map();
    const lastHitByDevice = new Map();
    const personByDevice = new Map();
    for (const h of hits) {
      lastHitByDevice.set(`${h.stream}|${h.device_id}`, h); // ascending: last wins
      if (h.person_id) personByDevice.set(`${h.stream}|${h.device_id}`, h.person_id);
    }
    const firstHitByDevice = new Map();
    for (const h of hits) {
      const k = `${h.stream}|${h.device_id}`;
      if (!firstHitByDevice.has(k)) firstHitByDevice.set(k, h);
    }
    const deviceUpserts = [];
    for (const [sk, last] of lastHitByDevice) {
      const first = firstHitByDevice.get(sk);
      const input = inputIdByStream.get(last.stream);
      const old = deviceRows.get(`${input}|${last.device_id}`);
      const firstSeen = old ? toDate(old.first_seen) : toDate(first.ts);
      const row = {
        input_id: input,
        device_id: last.device_id,
        person_id: old ? num(old.person_id) : 0,
        email_hash_v1: old?.email_hash_v1 || '',
        platform: old?.platform || last.platform || 'web',
        first_seen: toDate(first.ts) < firstSeen ? toDate(first.ts) : firstSeen,
        last_seen: old && toDate(old.last_seen) > toDate(last.ts) ? toDate(old.last_seen) : toDate(last.ts),
        first_referrer_host: old ? old.first_referrer_host : internal(first) ? null : first.referrer_host || null,
        first_utm_source: old ? old.first_utm_source : first.utm_source || null,
        first_utm_medium: old ? old.first_utm_medium : first.utm_medium || null,
        first_utm_campaign: old ? old.first_utm_campaign : first.utm_campaign || null,
        identified_at: old?.identified_at ? toDate(old.identified_at) : null
      };
      if (!old) {
        newDevices.set(sk, row);
        stats.devices_new += 1;
      }
      deviceUpserts.push(row);
      const person = personByDevice.get(sk);
      if (person && person !== row.person_id) links.push({ stream: last.stream, key: sk, input, deviceId: last.device_id, personId: person, ts: toDate(last.ts) });
    }
    await worker.upsertArray({ table: 'gauge_device', array: deviceUpserts });

    await this.bumpRollups({ hits, started, sessionById, inputIdByStream });

    // Entries and timeline.
    const entryRows = [];
    const timelineRows = [];
    const sourceCodeRows = [];
    for (const h of hits) {
      const input = inputIdByStream.get(h.stream);
      const id = this.timelineId(h.hit_id, h.ts);
      h._entryId = id;
      if (settings.dbMode === 'entries') {
        entryRows.push(entryRow(h, id, input));
      }
      if (this.timelineEligible({ typeId: h.entry_type_id, key: h.key, personId: h.person_id || 0 })) {
        const tlInput = h.name && isValidCustomName(h.name) ? await this.customInput(h.name) : input;
        const row = {
          id,
          ts: toDate(h.ts),
          input_id: tlInput,
          entry_type_id: h.entry_type_id,
          person_id: h.person_id || 0,
          source_code_id: 0,
          source_code: h.source_code || ''
        };
        timelineRows.push(row);
        if (h.source_code) sourceCodeRows.push(row);
      }
    }
    // Derived entries: SESSION_START (and FIRST_VISIT for a new device).
    for (const { session } of started.values()) {
      const input = inputIdByStream.get(session.stream);
      for (const row of this.sessionTimelineRows(session, input, sessionById)) timelineRows.push(row);
    }
    // A session that began anonymous in an earlier run and whose person is known now:
    // its start entries were held back (identified mode) or written without a person (all mode).
    const storedPerson = new Map([...existing.values()].map((r) => [r.id, num(r.person_id)]));
    for (const s of sessions) {
      if (started.has(s.id) || storedPerson.get(s.id) !== 0 || !(s.person_id > 0)) continue;
      const input = inputIdByStream.get(s.stream);
      const session = { id: s.id, stream: s.stream, device_id: s.device_id, start_ts: s.start_ts, is_new_device: s.is_new_device };
      for (const row of this.sessionTimelineRows(session, input, sessionById)) timelineRows.push(row);
    }
    if (entryRows.length) await worker.upsertArray({ table: 'gauge_entry', array: entryRows });
    stats.entries += entryRows.length;
    await this.writeTimeline(timelineRows, sourceCodeRows, stats);

    // Link devices whose person just became known (stitch earlier anonymous data).
    for (const link of links) await this.linkDevice(link, stats);
  }

  sessionTimelineRows(session, input, sessionById) {
    const finalSession = sessionById.get(session.id) || session;
    const personId = finalSession.person_id || 0;
    const rows = [];
    const add = (typeId, remote) => {
      if (!this.timelineEligible({ typeId, key: false, personId })) return;
      rows.push({
        id: this.timelineId(remote, session.start_ts),
        ts: session.start_ts,
        input_id: input,
        entry_type_id: typeId,
        person_id: personId,
        source_code_id: 0,
        source_code: ''
      });
    };
    add(T.SESSION_START, `session:${session.id}`);
    if (session.is_new_device) add(T.FIRST_VISIT, `first:${session.stream}:${session.device_id}`);
    return rows;
  }

  async writeTimeline(rows, sourceCodeRows, stats) {
    if (rows.length === 0) return;
    if (sourceCodeRows.length) {
      await this.worker.appendSourceCodeId({ batch: sourceCodeRows });
    }
    const array = rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      input_id: r.input_id,
      entry_type_id: r.entry_type_id,
      person_id: r.person_id,
      source_code_id: r.source_code_id || 0
    }));
    for (const part of chunks(array, 1000)) await this.worker.upsertArray({ table: 'timeline', array: part });
    stats.timeline += array.length;
  }

  // --- rollups ---------------------------------------------------------------

  async bumpRollups({ hits, started, sessionById, inputIdByStream }) {
    const { worker } = this;
    const startedHitIds = new Set([...started.values()].map((s) => s.hit.hit_id));

    // gauge_device_day
    const dd = new Map();
    for (const h of hits) {
      const input = inputIdByStream.get(h.stream);
      const date = dateOnly(toDate(h.ts));
      const k = `${date}|${input}|${h.device_id}`;
      const row = dd.get(k) || { date, input_id: input, device_id: h.device_id, person_id: 0, sessions: 0, views: 0, entries: 0 };
      row.entries += 1;
      if (viewOf(h)) row.views += 1;
      if (startedHitIds.has(h.hit_id)) row.sessions += 1;
      if (h.person_id) row.person_id = h.person_id;
      dd.set(k, row);
    }
    await this.addToRollup({
      table: 'gauge_device_day',
      rows: dd,
      lookup: async (inputId, rows) => {
        const dates = [...new Set(rows.map((r) => r.date))].sort();
        return selectIn(worker, {
          select: '*',
          table: 'gauge_device_day',
          where: 'input_id=? and date>=? and date<=?',
          values: [inputId, dates[0], dates[dates.length - 1]],
          column: 'device_id',
          list: [...new Set(rows.map((r) => r.device_id))]
        });
      },
      keyOf: (r) => `${String(r.date).slice(0, 10)}|${r.input_id}|${r.device_id}`,
      add: (existing, add) => ({
        ...add,
        person_id: add.person_id || num(existing?.person_id),
        sessions: add.sessions + num(existing?.sessions),
        views: add.views + num(existing?.views),
        entries: add.entries + num(existing?.entries)
      })
    });

    // gauge_view_day
    const vd = new Map();
    for (const h of hits) {
      const view = viewOf(h);
      if (!view) continue;
      const input = inputIdByStream.get(h.stream);
      const date = dateOnly(toDate(h.ts));
      const k = `${date}|${input}|${view}`;
      const row = vd.get(k) || { date, input_id: input, view_name: view, views: 0, sessions_started: 0 };
      row.views += 1;
      vd.set(k, row);
    }
    for (const { session } of started.values()) {
      const final = sessionById.get(session.id) || session;
      if (!final.landing_view) continue;
      const input = inputIdByStream.get(final.stream);
      const k = `${final.date}|${input}|${final.landing_view}`;
      const row = vd.get(k) || { date: final.date, input_id: input, view_name: final.landing_view, views: 0, sessions_started: 0 };
      row.sessions_started += 1;
      vd.set(k, row);
    }
    await this.addToRollup({
      table: 'gauge_view_day',
      rows: vd,
      lookup: async (inputId, rows) => {
        const dates = [...new Set(rows.map((r) => r.date))].sort();
        return selectIn(worker, {
          select: '*',
          table: 'gauge_view_day',
          where: 'input_id=? and date>=? and date<=?',
          values: [inputId, dates[0], dates[dates.length - 1]],
          column: 'view_name',
          list: [...new Set(rows.map((r) => r.view_name))]
        });
      },
      keyOf: (r) => `${String(r.date).slice(0, 10)}|${r.input_id}|${r.view_name}`,
      add: (existing, add) => ({
        ...add,
        views: add.views + num(existing?.views),
        sessions_started: add.sessions_started + num(existing?.sessions_started)
      })
    });
  }

  async addToRollup({ table, rows, lookup, keyOf, add }) {
    if (rows.size === 0) return;
    const byInput = new Map();
    for (const r of rows.values()) {
      if (!byInput.has(r.input_id)) byInput.set(r.input_id, []);
      byInput.get(r.input_id).push(r);
    }
    const out = [];
    for (const [inputId, list] of byInput) {
      const found = new Map((await lookup(inputId, list)).map((r) => [keyOf(r), r]));
      for (const r of list) out.push(add(found.get(keyOf(r)), r));
    }
    for (const part of chunks(out, 1000)) await this.worker.upsertArray({ table, array: part });
  }

  // --- identity --------------------------------------------------------------

  async identifierStore() {
    if (!this.storePromise) this.storePromise = createDefaultIdentifierStore(this.worker);
    return this.storePromise;
  }

  /** Device-to-person links from /identify with a person_id. */
  async applyAnchors(anchors, stats) {
    if (anchors.length === 0) return;
    const latest = new Map();
    for (const a of anchors) latest.set(`${a.stream}|${a.device_id}`, a); // ascending: last wins
    for (const a of latest.values()) {
      const stream = this.settings.streams.find((s) => s.id === a.stream);
      const input = await this.streamInput(stream);
      await this.ensureDevice({ input, stream: a.stream, deviceId: a.device_id, platform: 'web', ts: toDate(a.received_at) });
      await this.linkDevice(
        { stream: a.stream, key: `${a.stream}|${a.device_id}`, input, deviceId: a.device_id, personId: a.person_id, ts: toDate(a.received_at) },
        stats
      );
    }
  }

  /** Remember an email hash on a device; resolve it now if the person exists. */
  async applyEmailLinks(links, stats) {
    if (links.size === 0) return;
    for (const [key, hash] of links) {
      const [streamId, ...rest] = key.split('|');
      const deviceId = rest.join('|');
      const stream = this.settings.streams.find((s) => s.id === streamId);
      if (!stream) continue;
      const input = await this.streamInput(stream);
      await this.ensureDevice({ input, stream: streamId, deviceId, platform: stream.type === 'web_stream' ? 'web' : 'ios', ts: this.now });
      await this.worker.query({
        sql: "update gauge_device set email_hash_v1=? where input_id=? and device_id=? and person_id=0",
        values: [hash, input, deviceId]
      });
    }
  }

  /** Look up every device still waiting on an email hash. */
  async resolvePendingEmails(stats) {
    const { data: pending } = await this.worker.query({
      sql: "select d.input_id, d.device_id, d.email_hash_v1, i.remote_input_id from gauge_device d join input i on i.id=d.input_id where d.person_id=0 and d.email_hash_v1<>'' limit 1000"
    });
    if (pending.length === 0) return;
    const store = await this.identifierStore();
    const found = await store.findByIdentifiers(
      [...new Set(pending.map((p) => p.email_hash_v1))].map((v) => ({ id_type: 'email_hash_v1', id_value: v }))
    );
    const personByHash = new Map(found.map((f) => [f.id_value, Number(f.person_id)]));
    for (const p of pending) {
      const personId = personByHash.get(p.email_hash_v1);
      if (!personId) continue;
      const streamId = String(p.remote_input_id).replace(/^stream:/, '');
      await this.linkDevice(
        { stream: streamId, key: `${streamId}|${p.device_id}`, input: p.input_id, deviceId: p.device_id, personId, ts: this.now },
        stats
      );
    }
  }

  async ensureDevice({ input, stream, deviceId, platform, ts }) {
    const { data } = await this.worker.query({
      sql: 'select id from gauge_device where input_id=? and device_id=?',
      values: [input, deviceId]
    });
    if (data.length) return;
    await this.worker.upsertArray({
      table: 'gauge_device',
      array: [
        {
          input_id: input,
          device_id: deviceId,
          person_id: 0,
          email_hash_v1: '',
          platform,
          first_seen: ts,
          last_seen: ts,
          first_referrer_host: null,
          first_utm_source: null,
          first_utm_medium: null,
          first_utm_campaign: null,
          identified_at: null
        }
      ]
    });
  }

  /**
   * Make a device belong to a person. First identification stitches the
   * device's earlier anonymous rows; a change of person (a shared device)
   * applies from now on only.
   */
  async linkDevice({ stream, input, deviceId, personId, ts }, stats) {
    const { worker, settings } = this;
    const { data } = await worker.query({
      sql: 'select person_id from gauge_device where input_id=? and device_id=?',
      values: [input, deviceId]
    });
    const previous = data.length ? num(data[0].person_id) : 0;
    if (previous === personId) return false;
    await worker.query({
      sql: "update gauge_device set person_id=?, identified_at=?, email_hash_v1='' where input_id=? and device_id=?",
      values: [personId, qd(ts), input, deviceId]
    });
    stats.devices_linked += 1;
    if (previous === 0 && settings.backfillDays > 0) await this.stitch({ stream, input, deviceId, personId }, stats);

    // The link itself is a timeline entry.
    const identifyRow = {
      id: this.timelineId(`identify:${stream}:${deviceId}:${personId}`, ts),
      ts,
      input_id: input,
      entry_type_id: T.IDENTIFY,
      person_id: personId,
      source_code_id: 0,
      source_code: ''
    };
    if (this.timelineEligible({ typeId: T.IDENTIFY, key: false, personId })) {
      await this.writeTimeline([identifyRow], [], stats);
    }
    return true;
  }

  async stitch({ stream, input, deviceId, personId }, stats) {
    const { worker, settings } = this;
    const since = new Date(this.now.getTime() - settings.backfillDays * 86400000);
    const { data: sessions } = await worker.query({
      sql: 'select * from gauge_session where input_id=? and device_id=? and person_id=0 and start_ts>=?',
      values: [input, deviceId, qd(since)]
    });
    if (sessions.length) {
      await worker.query({
        sql: 'update gauge_session set person_id=? where input_id=? and device_id=? and person_id=0 and start_ts>=?',
        values: [personId, input, deviceId, qd(since)]
      });
      stats.stitched_sessions += sessions.length;
    }
    await worker.query({
      sql: 'update gauge_device_day set person_id=? where input_id=? and device_id=? and person_id=0 and date>=?',
      values: [personId, input, deviceId, dateOnly(since)]
    });

    const rows = [];
    // Session-derived timeline rows can be rebuilt from the stored sessions.
    for (const s of sessions) {
      const session = {
        id: s.id,
        stream,
        device_id: deviceId,
        start_ts: toDate(s.start_ts),
        is_new_device: bool(s.is_new_device)
      };
      for (const r of this.sessionTimelineRows(session, input, new Map([[session.id, { ...session, person_id: personId }]]))) rows.push(r);
    }
    // Hits are only recoverable when they were stored.
    if (settings.dbMode === 'entries') {
      const { data: entries } = await worker.query({
        sql: 'select * from gauge_entry where input_id=? and device_id=? and person_id=0 and ts>=?',
        values: [input, deviceId, qd(since)]
      });
      if (entries.length) {
        await worker.query({
          sql: 'update gauge_entry set person_id=? where input_id=? and device_id=? and person_id=0 and ts>=?',
          values: [personId, input, deviceId, qd(since)]
        });
      }
      const withCodes = [];
      for (const e of entries) {
        if (!this.timelineEligible({ typeId: e.entry_type_id, key: this.isKeyEntry(e), personId })) continue;
        const tlInput = e.name && isValidCustomName(e.name) ? await this.customInput(e.name) : input;
        const row = {
          id: e.id,
          ts: toDate(e.ts),
          input_id: tlInput,
          entry_type_id: num(e.entry_type_id),
          person_id: personId,
          source_code_id: 0,
          source_code: e.source_code || ''
        };
        rows.push(row);
        if (row.source_code) withCodes.push(row);
      }
      await this.writeTimeline(rows, withCodes, stats);
      return;
    }
    await this.writeTimeline(rows, [], stats);
  }

  isKeyEntry(entry) {
    if (num(entry.entry_type_id) !== T.CUSTOM_ENTRY && !entry.name) return false;
    return Boolean(this.settings.customEntries.find((c) => c.name === entry.name)?.key);
  }
}

function internal(hit) {
  return hit.referrer_host && hit.host && hit.referrer_host === hit.host;
}

function entryRow(h, id, input) {
  return {
    id,
    ts: toDate(h.ts),
    received_at: toDate(h.received_at || h.ts),
    input_id: input,
    entry_type_id: h.entry_type_id,
    person_id: h.person_id || 0,
    device_id: h.device_id,
    gauge_session_id: h.gauge_session_id || null,
    platform: h.platform || null,
    name: h.name || null,
    host: h.host || null,
    path: h.path || null,
    query: h.query || null,
    title: h.title || null,
    referrer_host: h.referrer_host || null,
    referrer_path: h.referrer_path || null,
    screen: h.screen || null,
    utm_source: h.utm_source || null,
    utm_medium: h.utm_medium || null,
    utm_campaign: h.utm_campaign || null,
    utm_term: h.utm_term || null,
    utm_content: h.utm_content || null,
    app_version: h.app_version || null,
    os: h.os || null,
    os_version: h.os_version || null,
    browser: h.browser || null,
    device_model: h.device_model || null,
    device_class: h.device_class || null,
    country: h.country || null,
    region: h.region || null,
    source_code: h.source_code || null,
    value: h.value ?? null,
    props: h.props ? JSON.stringify(h.props) : null
  };
}

// --- Loading from the disk log ---------------------------------------------------

function parseCheckpoint(text) {
  if (!text) return { floor: '', offsets: {} };
  try {
    const c = JSON.parse(text);
    return { floor: String(c.floor || ''), offsets: c.offsets && typeof c.offsets === 'object' ? c.offsets : {} };
  } catch {
    return { floor: '', offsets: {} };
  }
}

async function withLock(directory, fn) {
  const lock = path.join(directory, '.gauge-load.lock');
  fs.mkdirSync(directory, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < 10 * 60 * 1000) return { locked: true };
    fs.unlinkSync(lock); // a loader that died long ago
    fd = fs.openSync(lock, 'wx');
  }
  try {
    fs.writeSync(fd, String(process.pid));
    return await fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

/**
 * Read new records from the disk log, load them, then save the checkpoint.
 * The checkpoint moves only after the load succeeds, so a failure re-reads the
 * same records next time.
 *
 * @param {object} worker
 * @param {{ directory?: string, maxRecords?: number, now?: Date, prune?: boolean, from?: string }} [options]
 *   from: 'YYYY-MM-DD' ignores the checkpoint and starts at that day (replay)
 */
export async function loadFromDisk(worker, options = {}) {
  const plugin = options.plugin || (await findGaugePlugin(worker));
  if (!plugin) throw new Error(`${GAUGE_PLUGIN_PATH} is not installed`);
  const settings = options.settings || (await readSettings(worker));
  const directory = options.directory || settings.logDirectory;
  const now = options.now || new Date();
  const maxRecords = options.maxRecords || 50000;

  const result = await withLock(directory, async () => {
    let checkpoint = parseCheckpoint(settings.loadCheckpoint);
    if (options.from) {
      await resetFrom(worker, options.from);
      checkpoint = { floor: `${options.from.replace(/-/g, '/')}/00`, offsets: {} };
    }
    const segments = (await listSegments(directory)).filter((s) => (segmentHour(s) || '') >= checkpoint.floor);

    const records = [];
    const offsets = { ...checkpoint.offsets };
    let corrupt = 0;
    let stoppedAt = null;
    for (const seg of segments) {
      for await (const item of readSegment(directory, seg, { offset: offsets[seg] || 0 })) {
        offsets[seg] = item.end;
        if (item.record) records.push(item.record);
        else if (item.corrupt) corrupt += 1;
        if (records.length >= maxRecords) {
          stoppedAt = seg;
          break;
        }
      }
      if (stoppedAt) break;
    }

    // Even with nothing new, retry devices still waiting on an email lookup.
    const stats = await loadRecords(worker, records, { settings, plugin, now });

    // Everything before the previous hour is closed and fully read.
    let floor = hourPrefix(new Date(now.getTime() - 3600000));
    if (stoppedAt && (segmentHour(stoppedAt) || floor) < floor) floor = segmentHour(stoppedAt);
    const kept = {};
    for (const [seg, off] of Object.entries(offsets)) if ((segmentHour(seg) || '') >= floor) kept[seg] = off;
    const next = JSON.stringify({ floor, offsets: kept });
    if (next !== settings.loadCheckpoint) await writeSetting(worker, 'load_checkpoint', next);

    let pruned = { gzipped: 0, removed: 0 };
    if (options.prune !== false) pruned = await pruneLog(directory, { floor, retentionDays: settings.logRetentionDays, now });
    return { records: records.length, corrupt, stats, floor, pruned, segments: segments.length };
  });
  return result;
}

/**
 * Forget what the loader derived from a date forward, so replaying the log
 * from that date rebuilds it exactly: sessions and daily rollups from the
 * date, and devices first seen on or after it (their person links come back
 * from the log: Core Session hits and /identify records). Timeline and
 * gauge_entry rows are keyed by hit id and are simply written again.
 */
export async function resetFrom(worker, from) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('from must be YYYY-MM-DD');
  const start = `${from}T00:00:00`;
  await worker.query({ sql: 'delete from gauge_session where date>=?', values: [from] });
  await worker.query({ sql: 'delete from gauge_device_day where date>=?', values: [from] });
  await worker.query({ sql: 'delete from gauge_view_day where date>=?', values: [from] });
  await worker.query({ sql: 'delete from gauge_device where first_seen>=?', values: [start] });
}

/**
 * gzip segments the loader has finished with and delete ones past retention.
 * Only segments before `floor` are touched: those are closed and fully read.
 */
export async function pruneLog(directory, { floor, retentionDays, now = new Date() }) {
  const out = { gzipped: 0, removed: 0 };
  const cutoff = hourPrefix(new Date(now.getTime() - retentionDays * 86400000));
  for (const seg of await listSegments(directory)) {
    const hour = segmentHour(seg);
    if (!hour || hour >= floor) continue;
    if (hour < cutoff) {
      await removeSegment(directory, seg);
      out.removed += 1;
    } else if (await gzipSegment(directory, seg)) {
      out.gzipped += 1;
    }
  }
  return out;
}

export default { loadRecords, loadFromDisk, pruneLog, resetFrom };
