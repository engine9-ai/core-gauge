/*
  Gauge sessions, from hits. Pure: no I/O, so it is easy to test and the loader
  stays small.

  A gauge session is a run of activity from one device. It ends after
  `timeoutMs` of inactivity, and a hit that arrives with a different campaign
  (utm_source / utm_medium / utm_campaign) starts a new one, the way GA4 does.
  This is NOT the Core Session (the auth token).

  Session ids are deterministic (stream + device + first hit id), so replaying
  the same log rebuilds the same rows.

  Hits older than the device's latest stored session by more than the timeout
  (a late app batch) form their own session instead of rewriting history.
*/
import { sessionIdFor } from './protocol.js';

const VIEW_TYPES = new Set([102, 103]); // PAGE_VIEW, SCREEN_VIEW

export function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const s = String(value);
  // SQLite returns "YYYY-MM-DD HH:MM:SS" (UTC, no zone)
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}

export function utcDate(d) {
  return d.toISOString().slice(0, 10);
}

/** The page path (PAGE_VIEW) or screen name (SCREEN_VIEW) of a hit, or null. */
export function viewOf(hit) {
  if (!VIEW_TYPES.has(hit.entry_type_id)) return null;
  const v = hit.entry_type_id === 103 ? hit.screen || hit.path : hit.path || hit.screen;
  return v ? String(v).slice(0, 128) : '(not set)';
}

function campaignOf(hit) {
  return [hit.utm_source || '', hit.utm_medium || '', hit.utm_campaign || ''];
}

function hasCampaign(hit) {
  return Boolean(hit.utm_source || hit.utm_medium || hit.utm_campaign);
}

function sameCampaign(session, hit) {
  const [s, m, c] = campaignOf(hit);
  return (session.utm_source || '') === s && (session.utm_medium || '') === m && (session.utm_campaign || '') === c;
}

/**
 * @param {object} args
 * @param {object[]} args.hits         records, sorted by ts then received_at
 * @param {Map<string, object>} args.existing   `${stream}|${device}` -> latest stored session row
 *                                      ({ id, start_ts, end_ts, entries, views, landing_view, exit_view, utm_*, ... })
 * @param {Set<string>} args.knownDevices  `${stream}|${device}` already in gauge_device
 * @param {number} args.timeoutMs
 * @returns {{ sessions: object[], assignments: Map<string, string>, started: Map<string, object> }}
 *   sessions: every session touched, as full row objects (Date fields) ready to store
 *   assignments: hit_id -> session id
 *   started: session id -> { hit, session } for sessions that began in this run (they get SESSION_START)
 */
export function sessionize({ hits, existing = new Map(), knownDevices = new Set(), timeoutMs }) {
  const open = new Map();
  for (const [key, row] of existing) {
    open.set(key, {
      ...row,
      start_ts: toDate(row.start_ts),
      end_ts: toDate(row.end_ts),
      _created: false
    });
  }
  const touched = new Map();
  const assignments = new Map();
  const started = new Map();
  const seenDevices = new Set();

  for (const hit of hits) {
    const key = `${hit.stream}|${hit.device_id}`;
    const ts = toDate(hit.ts);
    let cur = open.get(key);
    const expired = cur && (ts - cur.end_ts > timeoutMs || cur.start_ts - ts > timeoutMs);
    const campaignChanged = cur && hasCampaign(hit) && !sameCampaign(cur, hit);
    if (!cur || expired || campaignChanged) {
      const id = sessionIdFor({ stream: hit.stream, deviceId: hit.device_id, firstHitId: hit.hit_id });
      const internalReferrer = hit.referrer_host && hit.host && hit.referrer_host === hit.host;
      const firstOfDevice = !knownDevices.has(key) && !seenDevices.has(key);
      cur = {
        id,
        stream: hit.stream,
        device_id: hit.device_id,
        person_id: 0,
        platform: hit.platform || 'web',
        start_ts: ts,
        end_ts: ts,
        entries: 0,
        views: 0,
        landing_view: null,
        exit_view: null,
        referrer_host: internalReferrer ? null : hit.referrer_host || null,
        utm_source: hit.utm_source || null,
        utm_medium: hit.utm_medium || null,
        utm_campaign: hit.utm_campaign || null,
        country: hit.country || null,
        device_class: hit.device_class || null,
        is_new_device: firstOfDevice,
        _created: true
      };
      open.set(key, cur);
      started.set(id, { hit, session: cur });
    }
    seenDevices.add(key);
    cur.entries += 1;
    const view = viewOf(hit);
    if (view) {
      cur.views += 1;
      if (cur.landing_view == null) cur.landing_view = view;
      cur.exit_view = view;
    }
    if (ts > cur.end_ts) cur.end_ts = ts;
    if (ts < cur.start_ts) cur.start_ts = ts;
    if (hit.person_id) cur.person_id = hit.person_id;
    assignments.set(hit.hit_id, cur.id);
    touched.set(cur.id, cur);
  }

  const sessions = [...touched.values()].map((s) => {
    const duration = Math.max(0, Math.round((s.end_ts - s.start_ts) / 1000));
    return {
      ...s,
      date: utcDate(s.start_ts),
      duration_s: duration,
      bounced: s.entries <= 1 && s.views <= 1
    };
  });
  return { sessions, assignments, started };
}

/**
 * Give anonymous hits the person of the next later hit from the same device.
 *
 * A device that signs in was the same person a moment earlier, so the browsing
 * before the login belongs to them. A LOGOUT ends the carry-back: hits before
 * it were already attributed, and what follows belongs to whoever signs in next.
 * Mutates and returns `hits` (sorted by ts). Hits keep a person they already have.
 */
export function carryPersonBack(hits) {
  const next = new Map();
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const h = hits[i];
    const key = `${h.stream}|${h.device_id}`;
    if (h.person_id) {
      next.set(key, h.person_id);
    } else if (next.get(key)) {
      h.person_id = next.get(key);
      h.person_source = 'stitched';
    }
    if (h.entry_type_id === 107) next.delete(key); // LOGOUT
  }
  return hits;
}

export default { sessionize, carryPersonBack, viewOf, toDate, utcDate };
