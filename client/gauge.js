/*
  Gauge browser and app client. No dependencies, one ES module.

    import { createGauge } from '@engine9/core-gauge/client';
    const gauge = createGauge({ endpoint: 'https://g.example.com', stream: 'G-www' });
    gauge.track('video_upload', { size_mb: 40 });     // custom entry
    gauge.screen('Home');                             // apps
    await gauge.identify();                           // after sign-in (see below)

  Page views (including single-page-app navigation), outbound clicks, file
  downloads and form starts are automatic and each can be turned off. Hash-
  routed sites (`#/path`) pass `hashRoutes: true` so hash changes count.

  Sending. Hits queue in memory and in localStorage. They go out in batches by
  fetch (keepalive) and, when the page is hiding, by sendBeacon. A failed batch
  stays queued and is retried with the same hit ids, so nothing is counted
  twice. Cookies ride along (credentials: include), so the collector can read
  the device cookie and a Core Session; the collector must be same-site with
  the page, or the app must send the session in `session()`.

  Who is this? The client never says who a person is. After sign-in, `identify()`
  asks the collector to link this device to the person its verified Core Session
  names. Server code can also call the collector's /identify with a key.

  Consent. `consent(false)` stops cookies and person links (the collector counts
  by a daily cookieless id); `consent(true)` allows them. Sec-GPC is honoured by
  the collector either way.
*/

const STORAGE_KEY = 'e9g_queue';
const DEVICE_KEY = 'e9g_did';
const MAX_QUEUE = 500;

/** UUIDv7: time-ordered, so ids sort by when the hit happened. */
export function uuidv7(now = Date.now(), random = defaultRandom) {
  const b = random(16);
  const ts = BigInt(now);
  b[0] = Number((ts >> 40n) & 0xffn);
  b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn);
  b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);
  b[5] = Number(ts & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function defaultRandom(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return a;
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k)
  };
}

function safeStorage(provided) {
  if (provided) return provided;
  try {
    const s = globalThis.localStorage;
    const probe = '__e9g__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return memoryStorage();
  }
}

/**
 * @param {object} options
 * @param {string} options.endpoint        collector base URL, e.g. https://g.example.com
 * @param {string} options.stream          stream id, e.g. G-www
 * @param {'web'|'ios'|'android'|'desktop'} [options.platform]
 * @param {boolean} [options.autoPageViews=true]
 * @param {boolean} [options.hashRoutes=false]  also watch `#/` and `#!/` (hash-routed sites)
 * @param {boolean} [options.outboundClicks=true]
 * @param {boolean} [options.downloads=true]
 * @param {boolean} [options.formStarts=true]
 * @param {string[]} [options.downloadExtensions]
 * @param {boolean} [options.consent]       false starts without cookies or person links
 * @param {number} [options.flushMs=2000]
 * @param {number} [options.maxBatch=20]
 * @param {object} [options.context]        extra ctx fields (app_version, os, device_model, ...)
 * @param {string} [options.session]        Core Session token, for apps (sent as X-Engine9-Session)
 * @param {Function} [options.fetch]
 * @param {object} [options.storage]
 * @param {object} [options.window]
 * @param {object} [options.document]
 * @param {object} [options.navigator]
 */
export function createGauge(options = {}) {
  const {
    endpoint,
    stream,
    platform = 'web',
    autoPageViews = true,
    hashRoutes = false,
    outboundClicks = true,
    downloads = true,
    formStarts = true,
    downloadExtensions = ['pdf', 'zip', 'csv', 'xlsx', 'docx', 'mp4', 'mp3'],
    flushMs = 2000,
    maxBatch = 20,
    context = {}
  } = options;
  if (!endpoint) throw new Error('createGauge requires an endpoint');
  if (!stream) throw new Error('createGauge requires a stream');

  const win = options.window ?? globalThis.window;
  const doc = options.document ?? globalThis.document;
  const nav = options.navigator ?? globalThis.navigator;
  const doFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
  const storage = safeStorage(options.storage);
  const base = String(endpoint).replace(/\/+$/, '');
  const queueKey = `${STORAGE_KEY}_${stream}`;

  let consent = options.consent;
  let session = options.session || null;
  let timer = null;
  let flushing = null;
  let lastPath = null;
  let failures = 0;
  let started = false;

  let queue = [];
  try {
    queue = JSON.parse(storage.getItem(queueKey) || '[]');
    if (!Array.isArray(queue)) queue = [];
  } catch {
    queue = [];
  }

  function persist() {
    try {
      storage.setItem(queueKey, JSON.stringify(queue.slice(-MAX_QUEUE)));
    } catch {
      // storage full or blocked: the in-memory queue still works
    }
  }

  function ctx() {
    const c = { ...context };
    if (doc) {
      c.host = c.host || win?.location?.host;
      c.title = doc.title;
    }
    return c;
  }

  function body(hits) {
    const payload = {
      v: 1,
      s: stream,
      platform,
      sent_at: Date.now(),
      ctx: ctx(),
      hits
    };
    if (consent !== undefined) payload.consent = consent;
    const did = storage.getItem(DEVICE_KEY);
    if (did) payload.device_id = did;
    return JSON.stringify(payload);
  }

  function headers() {
    const h = { 'content-type': 'text/plain;charset=UTF-8' };
    if (session) h['x-engine9-session'] = session;
    return h;
  }

  function schedule() {
    if (timer || flushMs <= 0) return;
    const delay = Math.min(60000, flushMs * 2 ** Math.min(failures, 5));
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delay);
    timer.unref?.();
  }

  function add(hit) {
    queue.push(hit);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    persist();
    if (queue.length >= maxBatch) flush();
    else schedule();
    return hit.id;
  }

  function hit(type, fields = {}) {
    return add({ id: uuidv7(), t: type, ts: Date.now(), ...fields });
  }

  async function flush() {
    if (flushing) return flushing;
    if (queue.length === 0) return { sent: 0 };
    flushing = (async () => {
      let sent = 0;
      try {
        while (queue.length > 0) {
          const batch = queue.slice(0, maxBatch);
          let res;
          try {
            res = await doFetch(`${base}/collect`, {
              method: 'POST',
              headers: headers(),
              body: body(batch),
              credentials: 'include',
              keepalive: true
            });
          } catch {
            failures += 1;
            schedule();
            return { sent, error: 'network' };
          }
          if (res.status >= 500 || res.status === 429) {
            failures += 1;
            schedule();
            return { sent, error: `status ${res.status}` };
          }
          // Anything else is final: accepted, or rejected for good (400/403/404). Retrying would not help.
          failures = 0;
          queue.splice(0, batch.length);
          persist();
          sent += batch.length;
          try {
            const json = await res.json();
            if (json?.device_id) storage.setItem(DEVICE_KEY, json.device_id);
          } catch {
            // 204 or no body
          }
        }
        return { sent };
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  }

  /** Send what is queued as the page hides. Hit ids make a double send harmless. */
  function flushBeacon() {
    if (queue.length === 0) return false;
    if (!nav?.sendBeacon) {
      flush();
      return false;
    }
    const batch = queue.slice(0, 50);
    let ok = false;
    try {
      const Blob_ = globalThis.Blob;
      ok = nav.sendBeacon(`${base}/collect`, new Blob_([body(batch)], { type: 'text/plain;charset=UTF-8' }));
    } catch {
      ok = false;
    }
    if (ok) {
      queue.splice(0, batch.length);
      persist();
    }
    return ok;
  }

  // --- Public API -----------------------------------------------------------

  function page(fields = {}) {
    const url = fields.url || win?.location?.href;
    return hit('PAGE_VIEW', { url, referrer: fields.referrer ?? (lastPath === null ? doc?.referrer : lastPath), title: doc?.title, ...fields });
  }

  function screen(name, fields = {}) {
    return hit('SCREEN_VIEW', { screen: name, ...fields });
  }

  /** A custom entry: lowercase snake_case name, optional properties and numeric value. */
  function track(name, props, value) {
    const fields = { name };
    if (props && typeof props === 'object') fields.props = props;
    if (value !== undefined) fields.value = value;
    if (win?.location?.href) fields.url = win.location.href;
    return hit(undefined, fields);
  }

  /** Any standard entry type by name: gauge.event('SEARCH', { name: 'query' }). */
  function event(type, fields) {
    return hit(type, fields);
  }

  /** Ask the collector to link this device to the person its Core Session names. */
  async function identify() {
    hit('IDENTIFY');
    return flush();
  }

  function setConsent(value) {
    consent = Boolean(value);
    return consent;
  }

  function setSession(token) {
    session = token || null;
  }

  function start() {
    if (started) return;
    started = true;
    if (!doc || !win) return;
    if (autoPageViews) {
      const locationKey = () => {
        const loc = win.location;
        const hash = hashRoutes ? loc.hash || '' : '';
        const route = hash.startsWith('#/') || hash.startsWith('#!/') ? hash : '';
        return `${loc.pathname}${loc.search}${route}`;
      };
      const emit = () => {
        const path = locationKey();
        if (path === lastPath) return;
        const referrer = lastPath === null ? doc.referrer : `${win.location.origin}${lastPath}`;
        lastPath = path;
        page({ referrer });
      };
      for (const m of ['pushState', 'replaceState']) {
        const orig = win.history?.[m];
        if (typeof orig !== 'function') continue;
        win.history[m] = function patched(...args) {
          const r = orig.apply(this, args);
          Promise.resolve().then(emit);
          return r;
        };
      }
      win.addEventListener('popstate', emit);
      if (hashRoutes) win.addEventListener('hashchange', emit);
      emit();
    }
    if (outboundClicks || downloads) {
      doc.addEventListener(
        'click',
        (e) => {
          const a = e.target?.closest?.('a[href]');
          if (!a) return;
          let u;
          try {
            u = new URL(a.href, win.location.href);
          } catch {
            return;
          }
          if (!/^https?:$/.test(u.protocol)) return;
          const ext = (u.pathname.split('.').pop() || '').toLowerCase();
          if (downloads && downloadExtensions.includes(ext)) {
            hit('FILE_DOWNLOAD', { url: u.href, name: ext });
          } else if (outboundClicks && u.host !== win.location.host) {
            hit('OUTBOUND_CLICK', { url: u.href });
          }
        },
        true
      );
    }
    if (formStarts) {
      const seen = new WeakSet();
      doc.addEventListener(
        'focusin',
        (e) => {
          const form = e.target?.form;
          if (!form || seen.has(form)) return;
          seen.add(form);
          hit('FORM_START', { name: form.id || form.getAttribute?.('name') || 'form', url: win.location.href });
        },
        true
      );
    }
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') flushBeacon();
    });
    win.addEventListener('pagehide', flushBeacon);
    if (queue.length) schedule();
  }

  return {
    start,
    page,
    screen,
    track,
    event,
    identify,
    flush,
    flushBeacon,
    consent: setConsent,
    session: setSession,
    queued: () => queue.length
  };
}

export default { createGauge, uuidv7 };
