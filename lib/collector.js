/*
  The gauge collector: a separate, small HTTP entry point that records hits.

  It is deliberately not mounted inside core's createApi. Core requires an API
  key on every route and works against the database; the collector must keep
  answering when the database is down and be cheap enough to put in front of
  every page view.

  What a request does, in order, and nothing more:
    1. check the stream and origin, rate limit
    2. decide consent, the device id, and (only from a verified Core Session
       or a server key) the person
    3. scrub each hit into a log record (lib/protocol.js)
    4. append to the log and answer

  It NEVER touches the database while handling a request. Settings come from a
  cached source (lib/settings.js createSettingsSource) that keeps the last good
  value. The only database use is the optional server-key check for /send and
  /identify, cached for a minute.

  If the append fails the answer is 503 and the client retries; hit ids make
  the retry harmless. Anything else (bad hits, bots, sampling) is dropped with
  a 200 so well-behaved clients do not retry.

  Routes (relative to basePath):
    POST /collect    browser/app hits (cookie + Core Session aware)
    GET  /collect.gif  one hit as a pixel, for <noscript> and email
    POST /send       server-side hits, needs a key with scope gauge:send
    POST /identify   server-side device-to-person link, scope gauge:send
    GET  /ok         health
*/
import { randomUUID } from 'node:crypto';
import { verifySessionToken, readCookie } from '@engine9/core/auth/delegate';
import { uuidv7 } from '@engine9/core/utilities';
import {
  parseBody,
  buildRecord,
  buildIdentifyRecord,
  isValidDeviceId,
  LIMITS,
  PROTOCOL_VERSION
} from './protocol.js';
import {
  parseUserAgent,
  geoFromHeaders,
  clientIp,
  truncateIp,
  cookielessDeviceId,
  stableFraction,
  header
} from './privacy.js';
import { resolveEntryType } from './entryTypes.js';

export const SEND_SCOPE = 'gauge:send';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function parseSecrets(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function hostMatches(pattern, host) {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return false;
}

function originHost(origin) {
  if (!origin || origin === 'null') return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** Fixed-window rate limiter keyed by string; memory is bounded. */
function createRateLimiter({ perMinute, clock }) {
  const windows = new Map();
  return function allow(key) {
    if (!perMinute) return true;
    const minute = Math.floor(clock().getTime() / 60000);
    const cur = windows.get(key);
    if (!cur || cur.minute !== minute) {
      if (windows.size > 20000) windows.clear();
      windows.set(key, { minute, n: 1 });
      return true;
    }
    cur.n += 1;
    return cur.n <= perMinute;
  };
}

function missingStreamError(payload) {
  const named = ['stream', 'stream_id', 'streamId'].find((k) => payload && payload[k] !== undefined);
  return named
    ? `missing s (the stream id); the field is named s, not ${named}`
    : 'missing s (the stream id): send it in the body or as ?s=';
}

/** Remembers recent hit ids so a client retry does not log twice. */
function createRecentIds(max) {
  const seen = new Set();
  return {
    has: (id) => seen.has(id),
    add(id) {
      seen.add(id);
      if (seen.size > max) seen.delete(seen.values().next().value);
    }
  };
}

/**
 * Wrap a core key store as a verifier for server-side calls, with a short cache
 * so a busy server integration does not query the database per request.
 *
 *   serverKeyVerifier(new SqlApiKeyStore({ worker }))
 */
export function serverKeyVerifier(keyStore, { ttlMs = 60000, scope = SEND_SCOPE, clock = () => Date.now() } = {}) {
  const cache = new Map();
  return async function verify(headers) {
    const req = { headers: { authorization: header(headers, 'authorization'), 'x-api-key': header(headers, 'x-api-key') } };
    const token = req.headers.authorization || req.headers['x-api-key'] || '';
    if (!token) return { valid: false, reason: 'missing key' };
    const hit = cache.get(token);
    if (hit && hit.until > clock()) return hit.result;
    let result;
    try {
      const v = await keyStore.verify(req);
      const scopes = v?.key?.scopes || [];
      result = {
        valid: Boolean(v?.valid && (scopes.includes(scope) || scopes.includes('admin'))),
        reason: v?.valid ? 'missing scope' : v?.reason || 'invalid key'
      };
    } catch (e) {
      return { valid: false, reason: `key check failed: ${e.message}` };
    }
    if (cache.size > 500) cache.clear();
    cache.set(token, { until: clock() + ttlMs, result });
    return result;
  };
}

/**
 * @param {object} options
 * @param {{ get: () => object }} options.settings  settings source (createSettingsSource)
 * @param {{ append: (records: object[]) => Promise<unknown> }} options.log
 * @param {string} [options.sessionSecret]  SESSION_SECRET (comma list for rotation). Without it no hit is ever linked to a person from a session.
 * @param {string} [options.sessionCookieName]  default 'session', the Core Session cookie
 * @param {string} [options.salt]  GAUGE_SALT, for cookieless ids
 * @param {(headers) => Promise<{valid: boolean, reason?: string}>} [options.verifyServerKey]
 * @param {number} [options.rateLimitPerMinute]  per client IP, default 600 requests; 0 disables
 * @param {string} [options.basePath]
 * @param {(e: Error, info?: object) => void} [options.onError]
 */
export function createCollector({
  settings,
  log,
  sessionSecret,
  sessionCookieName = 'session',
  salt,
  verifyServerKey,
  rateLimitPerMinute = 600,
  basePath = '',
  clock = () => new Date(),
  onError = () => {}
} = {}) {
  if (!settings || typeof settings.get !== 'function') throw new Error('createCollector requires a settings source');
  if (!log || typeof log.append !== 'function') throw new Error('createCollector requires a log with append()');
  const secrets = parseSecrets(sessionSecret);
  const processSalt = salt || randomUUID(); // without GAUGE_SALT, cookieless ids do not survive a restart
  const allow = createRateLimiter({ perMinute: rateLimitPerMinute, clock });
  const recent = createRecentIds(100000);
  const stats = { requests: 0, hits: 0, accepted: 0, rejected: 0, bots: 0, sampled_out: 0, unrouted: 0, errors: 0 };

  function newId() {
    return uuidv7();
  }

  function respond(status, body, extra = {}) {
    return {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(extra.headers || {}) },
      body: body === null || body === undefined ? null : JSON.stringify(body),
      setCookie: extra.setCookie || []
    };
  }

  function cors(res, req, settingsNow, stream) {
    const origin = header(req.headers, 'origin');
    if (!origin) return res;
    const host = originHost(origin);
    const patterns = [...settingsNow.allowedHosts, ...(stream?.hosts || [])];
    const ok = !host ? false : patterns.length === 0 || patterns.some((p) => hostMatches(p, host));
    if (ok) {
      res.headers['access-control-allow-origin'] = origin;
      res.headers['access-control-allow-credentials'] = 'true';
      res.headers.vary = 'Origin';
    }
    return res;
  }

  function originAllowed(req, settingsNow, stream) {
    const origin = header(req.headers, 'origin');
    if (!origin) return true; // apps and servers send none
    const host = originHost(origin);
    if (!host) return false;
    const patterns = [...settingsNow.allowedHosts, ...(stream?.hosts || [])];
    if (patterns.length === 0) return true;
    return patterns.some((p) => hostMatches(p, host));
  }

  function preflight(req) {
    const s = settings.get();
    const origin = header(req.headers, 'origin');
    const res = respond(204, null, {
      headers: {
        'access-control-allow-methods': 'POST, GET, OPTIONS',
        'access-control-allow-headers': 'Content-Type, X-Engine9-Session',
        'access-control-max-age': '86400'
      }
    });
    // A preflight does not carry the stream; accept any configured origin.
    const host = originHost(origin);
    const patterns = [...s.allowedHosts, ...s.streams.flatMap((x) => x.hosts)];
    if (origin && host && (patterns.length === 0 || patterns.some((p) => hostMatches(p, host)))) {
      res.headers['access-control-allow-origin'] = origin;
      res.headers['access-control-allow-credentials'] = 'true';
      res.headers.vary = 'Origin';
    }
    return res;
  }

  function coreSessionPerson(req) {
    if (secrets.length === 0) return 0;
    const token = header(req.headers, 'x-engine9-session') || readCookie(header(req.headers, 'cookie'), sessionCookieName);
    if (!token) return 0;
    for (const secret of secrets) {
      let payload = null;
      try {
        payload = verifySessionToken(token, { secret });
      } catch {
        payload = null;
      }
      if (payload) {
        const id = Number(payload.personId);
        return Number.isInteger(id) && id > 0 ? id : 0;
      }
    }
    return 0;
  }

  function consentFor({ req, payload, settingsNow }) {
    const gpc = header(req.headers, 'sec-gpc') === '1' || header(req.headers, 'dnt') === '1';
    if (settingsNow.respectGpc && gpc) return false;
    if (payload.consent === false) return false;
    return settingsNow.consentMode === 'granted' || payload.consent === true;
  }

  function deviceFor({ req, payload, settingsNow, stream, consent, ua, ip }) {
    const isWeb = (payload.platform || (stream.type === 'app_stream' ? 'app' : 'web')) === 'web';
    if (!consent) {
      return {
        id: cookielessDeviceId({
          salt: processSalt,
          ip,
          userAgent: header(req.headers, 'user-agent') || '',
          host: payload.ctx?.host || header(req.headers, 'host') || '',
          day: clock().toISOString().slice(0, 10)
        }),
        source: 'cookieless',
        newCookie: null
      };
    }
    const cookieId = isWeb ? readCookie(header(req.headers, 'cookie'), settingsNow.deviceCookieName) : null;
    if (isValidDeviceId(cookieId)) return { id: cookieId, source: 'cookie', newCookie: null };
    if (isValidDeviceId(payload.device_id)) {
      return { id: payload.device_id, source: 'client', newCookie: isWeb ? payload.device_id : null };
    }
    const id = randomUUID();
    return { id, source: isWeb ? 'cookie' : 'client', newCookie: isWeb ? id : null, minted: true };
  }

  function cookieHeader({ value, settingsNow, secure }) {
    const parts = [
      `${settingsNow.deviceCookieName}=${value}`,
      `Max-Age=${settingsNow.cookieDays * 86400}`,
      'Path=/',
      'SameSite=Lax',
      'HttpOnly'
    ];
    if (secure) parts.push('Secure');
    if (settingsNow.cookieDomain) parts.push(`Domain=${settingsNow.cookieDomain}`);
    return parts.join('; ');
  }

  async function write(records) {
    await log.append(records);
  }

  async function handleHits({ req, payload, trusted, query }) {
    const settingsNow = settings.get();
    stats.requests += 1;
    if (!settingsNow.collectEnabled) return respond(204, null);

    const streamId = String(payload.s ?? query?.s ?? '').trim();
    if (!streamId) return cors(respond(400, { error: missingStreamError(payload) }), req, settingsNow, null);
    const stream = settingsNow.streams.find((x) => x.id === streamId);
    const receivedAt = clock();
    if (!stream) {
      // Never lose data to a stale settings cache: keep a bounded copy aside.
      stats.unrouted += 1;
      if (streamId && /^[A-Za-z0-9_.:-]{1,64}$/.test(streamId)) {
        try {
          await write([
            {
              v: PROTOCOL_VERSION,
              kind: 'unrouted',
              hit_id: newId(),
              received_at: receivedAt.toISOString(),
              stream: streamId,
              raw: JSON.stringify(payload).slice(0, 4096)
            }
          ]);
        } catch (e) {
          onError(e, { phase: 'unrouted' });
        }
      }
      return cors(respond(404, { error: 'unknown stream' }), req, settingsNow, null);
    }
    if (!trusted && !originAllowed(req, settingsNow, stream)) {
      return respond(403, { error: 'origin not allowed for this stream' });
    }
    const ip = clientIp(req.headers, req.remoteAddress);
    if (!allow(ip || 'unknown')) {
      return cors(respond(429, { error: 'rate limited' }, { headers: { 'retry-after': '60' } }), req, settingsNow, stream);
    }

    const uaString = header(req.headers, 'user-agent') || payload.ctx?.user_agent || '';
    const ua = parseUserAgent(uaString);
    if (!trusted && settingsNow.botFilter && ua.bot) {
      stats.bots += 1;
      return cors(respond(200, { ok: true, accepted: 0 }), req, settingsNow, stream);
    }

    const consent = trusted ? true : consentFor({ req, payload, settingsNow });
    const device = deviceFor({ req, payload, settingsNow, stream, consent, ua, ip });
    if (!trusted && stableFraction(device.id) >= settingsNow.sampleRate) {
      stats.sampled_out += 1;
      return cors(respond(200, { ok: true, accepted: 0, sampled: false }), req, settingsNow, stream);
    }
    const personId = trusted || !consent ? 0 : coreSessionPerson(req);
    const geo = geoFromHeaders(req.headers);
    const context = {
      receivedAt,
      device,
      personId,
      personSource: personId ? 'core_session' : undefined,
      geo,
      ua,
      ip: settingsNow.ipMode === 'truncate' ? truncateIp(ip) : null,
      consent,
      trusted,
      newId
    };

    const records = [];
    const rejected = [];
    const batchIds = new Set();
    for (const hit of payload.hits) {
      stats.hits += 1;
      const type = hit && hit.t !== undefined ? resolveEntryType(hit.t) : null;
      if (type?.name === 'IDENTIFY') {
        // The browser can ask to be linked, but only a verified Core Session says to whom.
        if (!personId) {
          rejected.push('IDENTIFY needs a signed-in Core Session');
          continue;
        }
        records.push({
          v: PROTOCOL_VERSION,
          kind: 'identify',
          hit_id: String(hit.id || newId()).slice(0, 64),
          received_at: receivedAt.toISOString(),
          stream: stream.id,
          device_id: device.id,
          person_id: personId
        });
        continue;
      }
      const out = buildRecord({ hit, payload, settings: settingsNow, stream, context });
      if (out.rejected) {
        rejected.push(out.rejected);
        continue;
      }
      // A retry we already logged. Ids are remembered only after a successful
      // append (below), so a failed write never makes the client's retry look like a duplicate.
      if (recent.has(out.record.hit_id) || batchIds.has(out.record.hit_id)) continue;
      batchIds.add(out.record.hit_id);
      records.push(out.record);
    }
    stats.rejected += rejected.length;

    if (records.length > 0) {
      try {
        await write(records);
        stats.accepted += records.length;
        for (const r of records) recent.add(r.hit_id);
      } catch (e) {
        stats.errors += 1;
        onError(e, { phase: 'append' });
        return cors(
          respond(503, { error: 'could not record, retry' }, { headers: { 'retry-after': '5' } }),
          req,
          settingsNow,
          stream
        );
      }
    }
    const setCookie = device.newCookie
      ? [cookieHeader({ value: device.newCookie, settingsNow, secure: Boolean(req.secure) })]
      : [];
    const body = { ok: true, accepted: records.length };
    if (rejected.length) body.rejected = rejected.slice(0, 10);
    if (device.source !== 'cookieless') body.device_id = device.id;
    const res = respond(rejected.length && records.length === 0 ? 400 : 200, body, { setCookie });
    return cors(res, req, settingsNow, stream);
  }

  async function requireServerKey(req) {
    if (!verifyServerKey) return { ok: false, res: respond(501, { error: 'server-side sends are not configured' }) };
    const v = await verifyServerKey(req.headers);
    if (!v.valid) return { ok: false, res: respond(401, { error: `unauthorized: ${v.reason || 'invalid key'}` }) };
    return { ok: true };
  }

  async function handleIdentify(req, payload) {
    const settingsNow = settings.get();
    stats.requests += 1;
    if (!settingsNow.collectEnabled) return respond(204, null);
    const streamId = String(payload.s ?? '').trim();
    if (!streamId) return respond(400, { error: missingStreamError(payload) });
    const stream = settingsNow.streams.find((x) => x.id === streamId);
    if (!stream) return respond(404, { error: 'unknown stream' });
    const out = buildIdentifyRecord({ body: payload, stream, receivedAt: clock(), hitId: newId() });
    if (out.rejected) return respond(400, { error: out.rejected });
    try {
      await write([out.record]);
    } catch (e) {
      stats.errors += 1;
      onError(e, { phase: 'append' });
      return respond(503, { error: 'could not record, retry' }, { headers: { 'retry-after': '5' } });
    }
    return respond(200, { ok: true });
  }

  function pathOf(req) {
    let p = String(req.path || '/').split('?')[0];
    if (basePath && p.startsWith(basePath)) p = p.slice(basePath.length) || '/';
    return `/${p.replace(/^\/+|\/+$/g, '')}`.replace(/\/$/, '') || '/';
  }

  /** Core dispatch on { method, path, query, headers, body (string), remoteAddress, secure }. */
  async function handle(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const path = pathOf(req);
    try {
      if (method === 'OPTIONS') return preflight(req);
      if (method === 'GET' && (path === '/ok' || path === '/')) {
        const s = settings.get();
        return respond(200, { ok: true, collecting: s.collectEnabled, streams: s.streams.length, stats });
      }
      if (method === 'POST' && path === '/collect') {
        const parsed = parseBody(req.body);
        if (parsed.error) return respond(parsed.status || 400, { error: parsed.error });
        return await handleHits({ req, payload: parsed.payload, trusted: false, query: req.query });
      }
      if (method === 'GET' && path === '/collect.gif') {
        const q = req.query || {};
        const payload = {
          s: q.s,
          platform: 'web',
          consent: q.consent === '0' ? false : undefined,
          ctx: { host: q.host },
          hits: [{ t: q.t || 'PAGE_VIEW', url: q.url, referrer: q.r, title: q.title, name: q.name }]
        };
        const r = await handleHits({ req, payload, trusted: false, query: q });
        return {
          status: 200,
          headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' },
          body: GIF,
          setCookie: r.setCookie || []
        };
      }
      if (method === 'POST' && (path === '/send' || path === '/identify')) {
        const auth = await requireServerKey(req);
        if (!auth.ok) return auth.res;
        const parsed = path === '/send' ? parseBody(req.body) : safeJson(req.body);
        if (parsed.error) return respond(parsed.status || 400, { error: parsed.error });
        if (path === '/identify') return await handleIdentify(req, parsed.payload);
        const payload = { ...parsed.payload, platform: parsed.payload.platform || 'server' };
        return await handleHits({ req, payload, trusted: true, query: req.query });
      }
      return respond(404, { error: `no route for ${method} ${path}` });
    } catch (e) {
      stats.errors += 1;
      onError(e, { phase: 'handle' });
      return respond(500, { error: 'internal error' });
    }
  }

  function safeJson(text) {
    try {
      const payload = JSON.parse(text || '');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'body must be an object' };
      return { payload };
    } catch {
      return { error: 'invalid JSON' };
    }
  }

  /** Fetch API adapter (Cloudflare Workers, Deno, Bun, Node 18+). */
  async function handleFetch(request) {
    const url = new URL(request.url);
    const headers = {};
    request.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      body = await request.text();
    }
    const secure = url.protocol === 'https:' || headers['x-forwarded-proto'] === 'https';
    const out = await handle({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body,
      secure
    });
    const res = new Response(out.body && out.body.length !== 0 ? out.body : null, { status: out.status });
    for (const [k, v] of Object.entries(out.headers)) res.headers.set(k, v);
    for (const c of out.setCookie || []) res.headers.append('set-cookie', c);
    return res;
  }

  /** Node http adapter: (req, res) => void. */
  function nodeHandler({ trustProxy = false } = {}) {
    return (req, res) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > LIMITS.maxBodyBytes + 1024) {
          tooLarge = true;
          return;
        }
        chunks.push(c);
      });
      req.on('error', () => {
        res.statusCode = 400;
        res.end();
      });
      req.on('end', async () => {
        const url = new URL(req.url, 'http://localhost');
        const out = tooLarge
          ? respond(413, { error: 'body too large' })
          : await handle({
              method: req.method,
              path: url.pathname,
              query: Object.fromEntries(url.searchParams.entries()),
              headers: req.headers,
              body: chunks.length ? Buffer.concat(chunks).toString('utf8') : '',
              remoteAddress: req.socket?.remoteAddress,
              secure: Boolean(req.socket?.encrypted) || (trustProxy && req.headers['x-forwarded-proto'] === 'https')
            });
        res.statusCode = out.status;
        for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
        if (out.setCookie?.length) res.setHeader('Set-Cookie', out.setCookie);
        res.end(out.body ?? undefined);
      });
    };
  }

  return { handle, handleFetch, nodeHandler, stats };
}

export default { createCollector, serverKeyVerifier, SEND_SCOPE };
