/*
  Privacy and normalization helpers for the collector.

  The collector turns a raw hit into a self-contained, scrubbed log record, so
  the log never holds what a person would not expect it to: no IP address (by
  default), no email-looking values in URLs, no query parameters outside an
  allowlist. Pure functions; no I/O. Runs on Node and on workerd.
*/
import { createHash } from 'node:crypto';

const EMAIL_LIKE = /[^\s/?&=#@]+@[^\s/?&=#@]+\.[^\s/?&=#@]+/;
const MAX = 255;

export function clip(value, max = MAX) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

/** True when a string contains something shaped like an email address. */
export function looksLikeEmail(value) {
  if (value === undefined || value === null) return false;
  let s = String(value);
  try {
    s = decodeURIComponent(s);
  } catch {
    // keep raw
  }
  return EMAIL_LIKE.test(s);
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

/** `#/route` or `#!/route`. Other fragments (OAuth tokens, in-page anchors) are not routes. */
export function routeHash(hash) {
  if (typeof hash !== 'string' || !hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.startsWith('!/')) return raw.slice(1);
  if (raw.startsWith('/')) return raw;
  return null;
}

function scrubPathname(pathname) {
  return (
    String(pathname || '')
      .split('/')
      .map((seg) => (looksLikeEmail(seg) ? ':email' : seg))
      .join('/') || '/'
  );
}

/**
 * Break a URL into the parts gauge keeps.
 *
 * - `path` has email-looking segments replaced with `:email`. With
 *   `hashRoutes` (the stream's hash_routes setting), a `#/` or `#!/` fragment
 *   is kept on `path` (hash-routed sites). Every other fragment is dropped.
 * - `query` keeps only allowlisted parameters (and source-code parameters),
 *   dropping any value that looks like an email. utm_* go to their own fields.
 *   A query string inside a kept `#/` route is treated the same way.
 * - `source_code` is the first source-code parameter found.
 *
 * @param {string} url absolute or relative
 * @param {{ allowlist?: string[], sourceCodeParams?: string[], base?: string, hashRoutes?: boolean }} options
 */
export function scrubUrl(url, { allowlist = [], sourceCodeParams = [], base = 'http://invalid.local', hashRoutes = false } = {}) {
  const out = {
    host: null,
    path: null,
    query: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_term: null,
    utm_content: null,
    source_code: null
  };
  if (!url) return out;
  let u;
  try {
    u = new URL(String(url), base);
  } catch {
    return out;
  }
  out.host = u.host === new URL(base).host ? null : u.host.toLowerCase();
  out.path = clip(scrubPathname(u.pathname));
  const hashRoute = hashRoutes ? routeHash(u.hash) : null;
  const paramLists = [u.searchParams];
  if (hashRoute) {
    const q = hashRoute.indexOf('?');
    const hashPath = q >= 0 ? hashRoute.slice(0, q) : hashRoute;
    const hashQuery = q >= 0 ? hashRoute.slice(q + 1) : '';
    out.path = clip(`${out.path}#${scrubPathname(hashPath)}`);
    if (hashQuery) paramLists.push(new URLSearchParams(hashQuery));
  }
  const keep = new Set([...allowlist, ...sourceCodeParams].map((s) => s.toLowerCase()));
  const kept = [];
  for (const params of paramLists) {
    for (const [key, value] of params.entries()) {
      const k = key.toLowerCase();
      if (UTM_KEYS.includes(k)) {
        if (!out[k] && !looksLikeEmail(value)) out[k] = clip(value);
        continue;
      }
      if (sourceCodeParams.includes(k) && !out.source_code && !looksLikeEmail(value)) {
        out.source_code = clip(value, 180);
      }
      if (!keep.has(k) || looksLikeEmail(value)) continue;
      kept.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  out.query = kept.length ? kept.join('&').slice(0, 2000) : null;
  return out;
}

/** Host and path of a referrer; never its query. With `hashRoutes`, a `#/` or `#!/` route is kept. */
export function scrubReferrer(referrer, { base, hashRoutes = false } = {}) {
  if (!referrer) return { host: null, path: null };
  try {
    const u = new URL(String(referrer), base || 'http://invalid.local');
    if (u.host === 'invalid.local') return { host: null, path: null };
    let path = clip(scrubPathname(u.pathname));
    const hashRoute = hashRoutes ? routeHash(u.hash) : null;
    if (hashRoute) {
      const hashPath = hashRoute.split('?')[0];
      path = clip(`${path}#${scrubPathname(hashPath)}`);
    }
    return { host: u.host.toLowerCase(), path };
  } catch {
    return { host: null, path: null };
  }
}

// --- User agent -------------------------------------------------------------

const BOT_PATTERN =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|lighthouse|pingdom|uptime|monitor|curl\/|wget\/|python-requests|go-http-client|axios\/|node-fetch|java\/|libwww|okhttp\/.*bot|preview|scanner|checker/i;

export function isBotUserAgent(ua) {
  if (!ua) return true; // a real browser or SDK always identifies itself
  return BOT_PATTERN.test(ua);
}

/** A small, dependency-free user agent summary. Good enough for reports, not forensics. */
export function parseUserAgent(ua) {
  const s = String(ua || '');
  const out = { browser: null, os: null, os_version: null, device_class: 'other', bot: isBotUserAgent(s) };
  if (!s) return out;
  if (/Edg(e|A|iOS)?\//.test(s)) out.browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) out.browser = 'Opera';
  else if (/SamsungBrowser\//.test(s)) out.browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS\//.test(s)) out.browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s)) out.browser = 'Chrome';
  else if (/Safari\//.test(s) && /Version\//.test(s)) out.browser = 'Safari';

  let m;
  if ((m = s.match(/Windows NT (\d+(?:\.\d+)?)/))) {
    out.os = 'Windows';
    out.os_version = m[1];
  } else if ((m = s.match(/(?:iPhone|CPU) OS (\d+(?:[_.]\d+)*)/)) || /iPhone|iPad|iPod/.test(s)) {
    out.os = /iPad/.test(s) ? 'iPadOS' : 'iOS';
    if (m) out.os_version = m[1].replace(/_/g, '.');
  } else if ((m = s.match(/Android (\d+(?:\.\d+)*)/))) {
    out.os = 'Android';
    out.os_version = m[1];
  } else if ((m = s.match(/Mac OS X (\d+(?:[_.]\d+)*)/))) {
    out.os = 'macOS';
    out.os_version = m[1].replace(/_/g, '.');
  } else if (/CrOS/.test(s)) out.os = 'ChromeOS';
  else if (/Linux/.test(s)) out.os = 'Linux';

  if (out.bot) out.device_class = 'bot';
  else if (/iPad|Tablet|Android(?!.*Mobile)/.test(s)) out.device_class = 'tablet';
  else if (/Mobi|iPhone|iPod|Android.*Mobile/.test(s)) out.device_class = 'mobile';
  else if (out.os) out.device_class = 'desktop';
  return out;
}

// --- Network ---------------------------------------------------------------

function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export { header };

/** The client IP as the platform reports it. Used in memory only. */
export function clientIp(headers, remoteAddress) {
  const cf = header(headers, 'cf-connecting-ip');
  if (cf) return String(cf).trim();
  const xff = header(headers, 'x-forwarded-for');
  if (xff) return String(xff).split(',')[0].trim();
  const real = header(headers, 'x-real-ip');
  if (real) return String(real).trim();
  return remoteAddress ? String(remoteAddress) : '';
}

/** /24 for IPv4, /48 for IPv6. */
export function truncateIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (!s) return null;
  if (s.includes(':')) return `${s.split(':').slice(0, 3).join(':')}::`;
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

/** Country and region from the CDN headers the platform provides. */
export function geoFromHeaders(headers) {
  const country =
    header(headers, 'cf-ipcountry') || header(headers, 'x-vercel-ip-country') || header(headers, 'x-country-code');
  const region =
    header(headers, 'cf-region-code') || header(headers, 'x-vercel-ip-country-region') || header(headers, 'x-region-code');
  const c = country && String(country).length === 2 && country !== 'XX' && country !== 'T1' ? String(country).toUpperCase() : null;
  return { country: c, region: region ? clip(region, 64) : null };
}

// --- Device ids -------------------------------------------------------------

function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Cookieless device id: stable for one UTC day, then it changes, and it can
 * not be reversed or linked to a person. `salt` is a secret (GAUGE_SALT).
 */
export function cookielessDeviceId({ salt, ip, userAgent, host, day }) {
  const d = day || new Date().toISOString().slice(0, 10);
  return `cl_${sha256hex(`${salt}|${d}|${ip}|${userAgent}|${host}`).slice(0, 32)}`;
}

/** A stable number in [0,1) from a device id; drives sample_rate. */
export function stableFraction(deviceId) {
  return parseInt(sha256hex(String(deviceId)).slice(0, 8), 16) / 0x100000000;
}

/** sha256 hex of an email, trimmed and lowercased: core's email_hash_v1. */
export function emailHashV1(email) {
  const e = String(email || '').trim().toLowerCase();
  if (e.length < 5 || !e.includes('@')) return null;
  return sha256hex(e);
}

/** Deterministic UUID-shaped id from a string (stable across runs and hosts). */
export function deterministicUuid(input) {
  const b = createHash('sha256').update(String(input)).digest();
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 layout
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export default {
  scrubUrl,
  scrubReferrer,
  routeHash,
  parseUserAgent,
  isBotUserAgent,
  clientIp,
  truncateIp,
  geoFromHeaders,
  cookielessDeviceId,
  stableFraction,
  emailHashV1,
  deterministicUuid,
  looksLikeEmail
};
