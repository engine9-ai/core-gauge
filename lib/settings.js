/*
  Typed gauge settings.

  Core stores every plugin setting as a string in `setting`. This turns that
  map (or a plain config object) into a typed, defaulted, validated config the
  collector and loader share, and reads it from the database.

  The collector must keep working when the database is down, so
  createSettingsSource caches the last good value and falls back to defaults.
*/
import { settings as declared } from '../gauge/settings.js';
import { DEFAULT_TIMELINE_ENTRY_TYPES, resolveEntryType } from './entryTypes.js';

export const GAUGE_PLUGIN_PATH = '@engine9/core-gauge/gauge';

const DEFS = new Map(declared.map((d) => [d.name, d]));

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off', '']);

function parseBool(raw, fallback) {
  if (typeof raw === 'boolean') return raw;
  if (raw === undefined || raw === null) return fallback;
  const s = String(raw).trim().toLowerCase();
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  return fallback;
}

function parseNumber(raw, fallback, { min, max, int = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  let n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (int) n = Math.trunc(n);
  if (min !== undefined && n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
}

function parseList(raw, fallback = []) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (raw === undefined || raw === null) return fallback;
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJson(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

function parseChoice(name, raw) {
  const def = DEFS.get(name);
  const fallback = String(def.default);
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  return def.values.includes(s) ? s : fallback;
}

const STREAM_TYPES = ['web_stream', 'app_stream', 'server_stream'];

/** Validate and normalize the `streams` setting. Invalid entries are dropped. */
export function normalizeStreams(raw) {
  const list = parseJson(raw, []);
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const id = String(s.id ?? '').trim();
    if (!id || seen.has(id) || id.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(s.name || id),
      type: STREAM_TYPES.includes(s.type) ? s.type : 'web_stream',
      hosts: parseList(s.hosts),
      hashRoutes: s.hash_routes === true
    });
  }
  return out;
}

const CUSTOM_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** Validate a custom entry name: lowercase snake_case, up to 64 characters. */
export function isValidCustomName(name) {
  return typeof name === 'string' && CUSTOM_NAME.test(name);
}

/** Validate and normalize the `custom_entries` setting. Invalid entries are dropped. */
export function normalizeCustomEntries(raw) {
  const list = parseJson(raw, []);
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c || typeof c !== 'object' || !isValidCustomName(c.name) || seen.has(c.name)) continue;
    seen.add(c.name);
    let entryType = null;
    if (c.entry_type) {
      const t = resolveEntryType(c.entry_type);
      if (!t) continue; // an entry mapped to an unknown type is a mistake, not a custom entry
      entryType = t;
    }
    const props = c.props && typeof c.props === 'object' ? c.props : {};
    out.push({
      name: c.name,
      label: c.label ? String(c.label) : c.name,
      key: Boolean(c.key),
      entryType, // { id, name } or null
      props
    });
  }
  return out;
}

/**
 * Typed config from a raw settings map (strings from the DB, or a plain object).
 * Unknown names are ignored; missing ones take the declared default.
 */
export function parseSettings(raw = {}) {
  const get = (name) => (raw[name] !== undefined && raw[name] !== null ? raw[name] : undefined);
  const timelineTypes = parseList(get('timeline_entry_types'), [...DEFAULT_TIMELINE_ENTRY_TYPES])
    .map((t) => resolveEntryType(t))
    .filter(Boolean);
  return {
    collectEnabled: parseBool(get('collect_enabled'), true),
    streams: normalizeStreams(get('streams')),
    allowedHosts: parseList(get('allowed_hosts')),
    dbMode: parseChoice('db_mode', get('db_mode')),
    timelineMode: parseChoice('timeline_mode', get('timeline_mode')),
    timelineEntryTypeIds: new Set(timelineTypes.map((t) => t.id)),
    logDirectory: String(get('log_directory') || DEFS.get('log_directory').default),
    fsync: parseChoice('fsync', get('fsync')),
    logRetentionDays: parseNumber(get('log_retention_days'), 30, { min: 1, int: true }),
    sessionTimeoutMinutes: parseNumber(get('session_timeout_minutes'), 30, { min: 1, int: true }),
    deviceCookieName: String(get('device_cookie_name') || 'e9_did'),
    cookieDomain: String(get('cookie_domain') || ''),
    cookieDays: parseNumber(get('cookie_days'), 395, { min: 1, int: true }),
    consentMode: parseChoice('consent_mode', get('consent_mode')),
    respectGpc: parseBool(get('respect_gpc'), true),
    ipMode: parseChoice('ip_mode', get('ip_mode')),
    queryParamAllowlist: parseList(get('query_param_allowlist')).map((s) => s.toLowerCase()),
    botFilter: parseBool(get('bot_filter'), true),
    sampleRate: parseNumber(get('sample_rate'), 1, { min: 0, max: 1 }),
    sourceCodeParams: parseList(get('source_code_params'), ['source_code', 'sc']).map((s) => s.toLowerCase()),
    backfillDays: parseNumber(get('backfill_days'), 30, { min: 0, int: true }),
    customEntries: normalizeCustomEntries(get('custom_entries')),
    allowUndeclaredCustom: parseBool(get('allow_undeclared_custom'), true),
    downloadExtensions: parseList(get('download_extensions'), ['pdf', 'zip', 'csv', 'xlsx', 'docx', 'mp4', 'mp3']).map(
      (s) => s.toLowerCase().replace(/^\./, '')
    ),
    loadCheckpoint: String(get('load_checkpoint') || '')
  };
}

/** Names a person may set (everything except the loader's own checkpoint). */
export function editableSettingNames() {
  return declared.filter((d) => !d.hidden).map((d) => d.name);
}

/**
 * Check a value before it is stored. The setting table holds strings, so this
 * returns the string to store.
 *
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validateSettingValue(name, value) {
  const def = DEFS.get(name);
  if (!def || def.hidden) return { ok: false, error: `unknown setting: ${name}` };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (def.values && !def.values.includes(text)) return { ok: false, error: `${name} must be one of: ${def.values.join(', ')}` };
  if (def.type === 'boolean' && !['true', 'false'].includes(text)) return { ok: false, error: `${name} must be true or false` };
  if (def.type === 'int' || def.type === 'number') {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) return { ok: false, error: `${name} must be a number` };
    if (def.type === 'int' && !Number.isInteger(n)) return { ok: false, error: `${name} must be a whole number` };
    if (def.min !== undefined && n < def.min) return { ok: false, error: `${name} must be at least ${def.min}` };
    if (def.max !== undefined && n > def.max) return { ok: false, error: `${name} must be at most ${def.max}` };
  }
  if (def.type === 'json') {
    try {
      JSON.parse(text);
    } catch {
      return { ok: false, error: `${name} must be valid JSON` };
    }
  }
  return { ok: true, value: text };
}

/** Defaults only. */
export function defaultSettings() {
  return parseSettings({});
}

/** Find the installed gauge plugin row; null when not installed. */
export async function findGaugePlugin(worker) {
  const { data } = await worker.query({
    sql: 'select id from plugin where path=? order by created_at limit 1',
    values: [GAUGE_PLUGIN_PATH]
  });
  return data?.[0] || null;
}

/** Raw settings map from the database (strings). Empty object when gauge is not installed. */
export async function readRawSettings(worker) {
  const plugin = await findGaugePlugin(worker);
  if (!plugin) return {};
  const { getPluginSettings } = await import('@engine9/core/pluginSettings');
  return getPluginSettings(worker, { pluginId: plugin.id });
}

/** Typed settings from the database. */
export async function readSettings(worker) {
  return parseSettings(await readRawSettings(worker));
}

/** Write one setting through core's plugin settings. */
export async function writeSetting(worker, name, value) {
  const plugin = await findGaugePlugin(worker);
  if (!plugin) throw new Error(`${GAUGE_PLUGIN_PATH} is not installed`);
  const { setPluginSetting } = await import('@engine9/core/pluginSettings');
  return setPluginSetting(worker, { pluginId: plugin.id, name, value });
}

/**
 * A settings getter for the collector.
 *
 *   createSettingsSource({ settings })                     static object (raw or typed-ready)
 *   createSettingsSource({ worker, refreshMs: 60000 })     database, cached, last-good on failure
 *
 * `get()` is synchronous and never throws: the collector's request path must
 * not wait for or fail on the database. Call `start()` once to prime and begin
 * refreshing; `stop()` ends the timer.
 */
export function createSettingsSource({ settings, worker, refreshMs = 60000, onError } = {}) {
  let current = parseSettings(settings || {});
  let timer = null;
  let lastError = null;
  async function refresh() {
    if (!worker) return current;
    try {
      current = await readSettings(worker);
      lastError = null;
    } catch (e) {
      lastError = e;
      if (onError) onError(e);
    }
    return current;
  }
  return {
    get: () => current,
    refresh,
    lastError: () => lastError,
    async start() {
      await refresh();
      if (worker && refreshMs > 0 && !timer) {
        timer = setInterval(refresh, refreshMs);
        timer.unref?.();
      }
      return current;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

export default { parseSettings, defaultSettings, readSettings, createSettingsSource };
