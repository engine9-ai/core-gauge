/*
  The gauge protocol (v1): what a browser, an app SDK, or a server sends, and
  the log record the collector writes for each hit.

  Anyone can write a client for another platform from this description.

  Request  POST /collect   (Content-Type may be text/plain so browsers skip the
                            CORS preflight; the body is still JSON)
    {
      "v": 1,
      "s": "G-www",                 stream id (also accepted as ?s=)
      "sent_at": 1730000000000,     client clock, ms: used to correct hit times
      "platform": "web",            web | ios | android | desktop | server
      "device_id": "…",             apps; web falls back to it without a cookie
      "consent": true,              false = cookieless, no person link
      "ctx": { "host", "title", "referrer", "app_version", "os", "os_version",
               "device_model", "screen" },
      "hits": [ { "id": "<uuidv7>", "t": "PAGE_VIEW", "ts": 1730000000000,
                  "url": "https://…", "name": "video_upload", "value": 40,
                  "props": { "size_mb": 40 } } ]
    }

  A hit's `id` makes retries harmless: the same id is the same timeline entry.
  `t` is an entry type name or id (lib/entryTypes.js); a hit with a `name` and
  no `t` is a CUSTOM_ENTRY.

  Nothing here ever trusts the client for who a person is. person_id comes from
  a verified Core Session or a server-side key, never from the body of a
  browser request.
*/
import { resolveEntryType, GAUGE_ENTRY_TYPES, PLATFORMS } from './entryTypes.js';
import { scrubUrl, scrubReferrer, clip, looksLikeEmail, deterministicUuid, emailHashV1 } from './privacy.js';
import { isValidCustomName } from './settings.js';

export const PROTOCOL_VERSION = 1;
export const LIMITS = Object.freeze({
  maxBodyBytes: 32 * 1024,
  maxHits: 50,
  maxPropsKeys: 20,
  maxPropKeyLength: 40,
  maxPropValueLength: 256,
  maxPropsBytes: 2048,
  maxHitIdLength: 64,
  maxFutureMs: 60 * 1000,
  maxAgeMs: 7 * 24 * 3600 * 1000 // an app can be offline for days
});

// Standard types a browser must not mint (money). Only a server key may send them.
const SERVER_ONLY_TYPES = new Set([10, 11, 12, 13, 14, 15]);

// SESSION_START and FIRST_VISIT come from the loader's sessionizing, which is the
// authority on sessions; a client that sent them would be counted twice.
const DERIVED_TYPES = new Set([100, 101]);

const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const HIT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

export function isValidDeviceId(id) {
  return typeof id === 'string' && DEVICE_ID.test(id);
}

/** Parse a request body. Returns { payload } or { error }. */
export function parseBody(text) {
  if (typeof text !== 'string' || text.length === 0) return { error: 'empty body' };
  if (new TextEncoder().encode(text).length > LIMITS.maxBodyBytes) return { error: 'body too large', status: 413 };
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'body must be an object' };
  if (!Array.isArray(payload.hits)) return { error: 'hits must be an array' };
  if (payload.hits.length === 0) return { error: 'no hits' };
  if (payload.hits.length > LIMITS.maxHits) {
    return { error: `too many hits (max ${LIMITS.maxHits})`, status: 413 };
  }
  return { payload };
}

function cleanProps(props, declared) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return null;
  const out = {};
  let n = 0;
  const declaredKeys = declared && Object.keys(declared).length ? declared : null;
  for (const [k, v] of Object.entries(props)) {
    if (n >= LIMITS.maxPropsKeys) break;
    if (!k || k.length > LIMITS.maxPropKeyLength || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (declaredKeys) {
      const type = declaredKeys[k];
      if (!type) continue; // declared entries keep declared properties only
      if (type === 'number' && !(typeof v === 'number' && Number.isFinite(v))) continue;
      if (type === 'string' && typeof v !== 'string') continue;
      if (type === 'boolean' && typeof v !== 'boolean') continue;
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      out[k] = v;
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else if (typeof v === 'string') {
      if (looksLikeEmail(v)) continue; // an email in a property is a leak, not data
      out[k] = v.slice(0, LIMITS.maxPropValueLength);
    } else continue;
    n += 1;
  }
  if (n === 0) return null;
  if (JSON.stringify(out).length > LIMITS.maxPropsBytes) return null;
  return out;
}

/** Correct a client timestamp using the client/server clock difference. */
export function correctTimestamp({ ts, sentAt, receivedAt }) {
  const received = receivedAt.getTime();
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return { date: receivedAt, clamped: false, reason: null };
  const skew = Number.isFinite(Number(sentAt)) && Number(sentAt) > 0 ? received - Number(sentAt) : 0;
  let corrected = t + skew;
  if (corrected > received + LIMITS.maxFutureMs) return { date: receivedAt, clamped: true, reason: 'future' };
  if (corrected < received - LIMITS.maxAgeMs) return { date: receivedAt, clamped: true, reason: 'too_old' };
  if (corrected > received) corrected = received;
  return { date: new Date(corrected), clamped: false, reason: null };
}

/**
 * Turn one hit into a log record, or a rejection.
 *
 * @param {object} args
 * @param {object} args.hit        raw hit from the body
 * @param {object} args.payload    the whole body (platform, ctx, sent_at)
 * @param {object} args.settings   typed settings (lib/settings.js)
 * @param {object} args.stream     the stream (normalizeStreams)
 * @param {object} args.context    { receivedAt, device:{id,source}, personId, personSource,
 *                                    geo, ua:{browser,os,os_version,device_class,bot},
 *                                    ip, consent, trusted, newId() }
 * @returns {{ record } | { rejected: string }}
 */
export function buildRecord({ hit, payload, settings, stream, context }) {
  if (!hit || typeof hit !== 'object') return { rejected: 'hit must be an object' };
  const ctx = payload.ctx && typeof payload.ctx === 'object' ? payload.ctx : {};

  let type = null;
  let customName = null;
  let declared = null;
  const wantsName = hit.name !== undefined && hit.name !== null && hit.name !== '';
  if (hit.t === undefined || hit.t === null || hit.t === '') {
    if (!wantsName) return { rejected: 'hit needs t or name' };
    type = resolveEntryType('CUSTOM_ENTRY');
  } else {
    type = resolveEntryType(hit.t);
    if (!type) return { rejected: `unknown entry type: ${String(hit.t).slice(0, 40)}` };
  }
  if (DERIVED_TYPES.has(type.id)) return { rejected: `${type.name} is derived by the loader, not sent` };
  if (!context.trusted && SERVER_ONLY_TYPES.has(type.id)) return { rejected: `${type.name} requires a server key` };

  let key = false;
  if (type.name === 'CUSTOM_ENTRY') {
    customName = String(hit.name ?? '').trim();
    if (!isValidCustomName(customName)) {
      return { rejected: 'custom entry name must be lowercase snake_case, up to 64 characters' };
    }
    declared = settings.customEntries.find((c) => c.name === customName) || null;
    if (!declared && !settings.allowUndeclaredCustom) return { rejected: `undeclared custom entry: ${customName}` };
    if (declared) {
      key = declared.key;
      if (declared.entryType) type = declared.entryType; // mapped onto a standard type
    }
  } else if (wantsName) {
    customName = clip(String(hit.name), 64);
  }

  const receivedAt = context.receivedAt;
  const when = correctTimestamp({ ts: hit.ts, sentAt: payload.sent_at, receivedAt });

  const platform = PLATFORMS.includes(payload.platform) ? payload.platform : stream.type === 'app_stream' ? 'ios' : 'web';
  const urlInfo = scrubUrl(hit.url || ctx.url || '', {
    allowlist: settings.queryParamAllowlist,
    sourceCodeParams: settings.sourceCodeParams,
    base: ctx.host ? `https://${String(ctx.host).slice(0, 253)}` : undefined,
    hashRoutes: stream.hashRoutes === true
  });
  const ref = scrubReferrer(hit.referrer ?? ctx.referrer, { hashRoutes: stream.hashRoutes === true });
  const hitId = hit.id !== undefined && HIT_ID.test(String(hit.id)) ? String(hit.id) : context.newId();

  const record = {
    v: PROTOCOL_VERSION,
    kind: 'hit',
    hit_id: hitId,
    received_at: receivedAt.toISOString(),
    ts: when.date.toISOString(),
    ts_clamped: when.clamped ? when.reason : undefined,
    stream: stream.id,
    input_type: stream.type,
    entry_type_id: type.id,
    entry_type: type.name,
    name: customName,
    key: key || undefined,
    platform,
    device_id: context.device.id,
    device_source: context.device.source,
    person_id: context.personId || 0,
    person_source: context.personId ? context.personSource : undefined,
    consent: context.consent,
    host: urlInfo.host || (ctx.host ? clip(String(ctx.host).toLowerCase(), 253) : null),
    path: urlInfo.path,
    query: urlInfo.query,
    title: clip(hit.title ?? ctx.title),
    referrer_host: ref.host,
    referrer_path: ref.path,
    screen: clip(hit.screen ?? ctx.screen_name ?? null),
    utm_source: urlInfo.utm_source,
    utm_medium: urlInfo.utm_medium,
    utm_campaign: urlInfo.utm_campaign,
    utm_term: urlInfo.utm_term,
    utm_content: urlInfo.utm_content,
    source_code: urlInfo.source_code,
    app_version: clip(ctx.app_version, 64),
    os: clip(ctx.os, 64) || context.ua.os,
    os_version: clip(ctx.os_version, 64) || context.ua.os_version,
    browser: clip(ctx.browser, 64) || context.ua.browser,
    device_model: clip(ctx.device_model, 64),
    device_class: context.ua.device_class,
    country: context.geo.country,
    region: context.geo.region,
    value: hit.value !== undefined && Number.isFinite(Number(hit.value)) ? Number(hit.value) : null,
    props: cleanProps(hit.props, declared?.props),
    bot: context.ua.bot || undefined,
    ip: context.ip || undefined
  };

  // A server key may attach an email; only its hash is kept.
  if (context.trusted && hit.email) {
    const hash = emailHashV1(hit.email);
    if (hash) record.email_hash_v1 = hash;
  }
  if (context.trusted && hit.person_id !== undefined) {
    const n = Number(hit.person_id);
    if (Number.isInteger(n) && n > 0) {
      record.person_id = n;
      record.person_source = 'server';
    }
  }
  for (const k of Object.keys(record)) if (record[k] === undefined || record[k] === null) delete record[k];
  return { record };
}

/** A device-to-person link written by the server-side /identify call. */
export function buildIdentifyRecord({ body, stream, receivedAt, hitId }) {
  const deviceId = body.device_id;
  if (!isValidDeviceId(deviceId)) return { rejected: 'device_id is required' };
  const record = {
    v: PROTOCOL_VERSION,
    kind: 'identify',
    hit_id: hitId,
    received_at: receivedAt.toISOString(),
    stream: stream.id,
    device_id: deviceId
  };
  const personId = Number(body.person_id);
  if (Number.isInteger(personId) && personId > 0) record.person_id = personId;
  const hash = body.email ? emailHashV1(body.email) : body.email_hash_v1 && /^[a-f0-9]{64}$/.test(body.email_hash_v1) ? body.email_hash_v1 : null;
  if (hash) record.email_hash_v1 = hash;
  if (!record.person_id && !record.email_hash_v1) return { rejected: 'person_id or email is required' };
  return { record };
}

/** Stable session id so reloadStats rebuilds the same rows. */
export function sessionIdFor({ stream, deviceId, firstHitId }) {
  return deterministicUuid(`gauge-session|${stream}|${deviceId}|${firstHitId}`);
}

export { GAUGE_ENTRY_TYPES };
export default { PROTOCOL_VERSION, LIMITS, parseBody, buildRecord, buildIdentifyRecord, correctTimestamp, sessionIdFor };
