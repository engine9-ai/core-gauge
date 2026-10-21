/*
  Gauge entry types.

  `entry_type_id` is a global standard shared by every plugin: one integer, one
  name, forever. Gauge owns the reserved block 100-129. The same names are
  published in @engine9/input-tools (timelineTypes.js) so other tools can read
  them; gauge keeps its own copy so it can write the integers directly and does
  not need a newer input-tools to run. test/entryTypes.test.js checks that the
  two agree whenever input-tools has the block.

  DO. NOT. CHANGE. an id once it ships. Add new ones; never renumber.

  Names carry no platform prefix. Platform (web, ios, android, desktop, server)
  is a column on gauge_entry, the way one GA4 `page_view` covers every stream.
  A LOGIN means the same thing from a site, an app, or a CRM portal.

  Custom entries are NOT new integers. They are CUSTOM_ENTRY plus a name
  (docs/custom-entries.md).
*/
export const GAUGE_ENTRY_TYPE_BLOCK = Object.freeze({ min: 100, max: 129 });

const types = {
  // A new gauge session began. The default "visited" entry.
  SESSION_START: 100,
  // First time this device was ever seen (first_visit / first_open).
  FIRST_VISIT: 101,
  PAGE_VIEW: 102,
  SCREEN_VIEW: 103,
  // Scroll depth / engaged time. Kept in rollups only unless asked for.
  ENGAGEMENT: 104,
  APP_UPDATE: 105,
  LOGIN: 106,
  LOGOUT: 107,
  // A device was linked to a person.
  IDENTIFY: 108,
  SEARCH: 109,
  OUTBOUND_CLICK: 110,
  FILE_DOWNLOAD: 111,
  // Form submits stay FORM_SUBMIT (60), which already exists.
  FORM_START: 112,
  VIDEO_START: 113,
  VIDEO_COMPLETE: 114,
  SHARE: 115,
  // A named custom entry. The name lives in gauge_entry.name.
  CUSTOM_ENTRY: 129
};

export const GAUGE_ENTRY_TYPES = { ...types };
Object.entries(types).forEach(([name, id]) => {
  GAUGE_ENTRY_TYPES[id] = name;
});

/** Existing engine9 types gauge reuses instead of duplicating. */
export const REUSED_ENTRY_TYPES = Object.freeze({
  SIGNUP: 3,
  SIGNUP_INITIAL: 4,
  SIGNUP_SUBSEQUENT: 5,
  TRANSACTION: 10,
  TRANSACTION_ONE_TIME: 11,
  FORM_SUBMIT: 60
});

const reusedById = Object.fromEntries(Object.entries(REUSED_ENTRY_TYPES).map(([k, v]) => [v, k]));

/** Types a hit may carry. Gauge's own block plus the reused standard ones. */
export function isAcceptedEntryType(nameOrId) {
  return resolveEntryType(nameOrId) !== null;
}

/**
 * Resolve a name or id to { id, name } or null.
 * Accepts gauge's block and the reused standard types only: a collector must
 * not let a browser write EMAIL_OPEN or TRANSACTION_REFUND.
 */
export function resolveEntryType(nameOrId) {
  if (nameOrId === undefined || nameOrId === null || nameOrId === '') return null;
  if (typeof nameOrId === 'number' || /^\d+$/.test(String(nameOrId))) {
    const id = Number(nameOrId);
    if (types[GAUGE_ENTRY_TYPES[id]] === id) return { id, name: GAUGE_ENTRY_TYPES[id] };
    if (reusedById[id]) return { id, name: reusedById[id] };
    return null;
  }
  const name = String(nameOrId).trim().toUpperCase();
  if (types[name] !== undefined) return { id: types[name], name };
  if (REUSED_ENTRY_TYPES[name] !== undefined) return { id: REUSED_ENTRY_TYPES[name], name };
  return null;
}

/** Entry types that count as a view for page/screen rollups. */
export const VIEW_ENTRY_TYPE_IDS = Object.freeze([types.PAGE_VIEW, types.SCREEN_VIEW]);

/** Default entry types written to the timeline when timeline_mode allows. */
export const DEFAULT_TIMELINE_ENTRY_TYPES = Object.freeze([
  'SESSION_START',
  'FIRST_VISIT',
  'LOGIN',
  'LOGOUT',
  'IDENTIFY',
  'CUSTOM_ENTRY'
]);

export const PLATFORMS = Object.freeze(['web', 'ios', 'android', 'desktop', 'server']);

export default { GAUGE_ENTRY_TYPES, GAUGE_ENTRY_TYPE_BLOCK, REUSED_ENTRY_TYPES, resolveEntryType };
