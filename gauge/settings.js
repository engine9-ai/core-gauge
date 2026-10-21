/*
  Gauge plugin settings, stored per installed plugin in core's `setting` table
  and edited through the same surfaces as every plugin (MCP `plugin` settings,
  console forms, `e9core`). Booleans are the strings "true" / "false".

  Secrets do not belong here: SESSION_SECRET and GAUGE_SALT are environment
  variables.
*/
export const settings = [
  // --- Collection -----------------------------------------------------------
  {
    name: 'collect_enabled',
    type: 'boolean',
    default: true,
    section: 'Collection',
    description: 'Master switch. When false the collector answers 204 and records nothing.'
  },
  {
    name: 'streams',
    type: 'json',
    default: '[]',
    section: 'Collection',
    description:
      'Data streams, one per site or app: [{"id":"G-www","name":"www.example.com","type":"web_stream","hosts":["www.example.com"]}]. type is web_stream, app_stream or server_stream. The id is public (like a GA4 Measurement ID) and is what the page or app sends. Each stream becomes one engine9 input.'
  },
  {
    name: 'allowed_hosts',
    type: 'string',
    default: '',
    section: 'Collection',
    description:
      'Comma-separated browser origins hosts allowed to send (www.example.com, *.example.com). Empty accepts any origin for a valid stream id. Streams may add their own hosts.'
  },
  // --- Where data goes -------------------------------------------------------
  {
    name: 'db_mode',
    type: 'string',
    values: ['rollups', 'entries'],
    default: 'rollups',
    section: 'Storage',
    description:
      'rollups keeps devices, gauge sessions and daily counts in the database. entries also writes every hit to gauge_entry (large on D1). The disk log always has every hit.'
  },
  {
    name: 'timeline_mode',
    type: 'string',
    values: ['none', 'identified', 'all'],
    default: 'identified',
    section: 'Storage',
    description:
      'Which hits become timeline entries. none: never. identified: only hits from a known person (earlier anonymous hits are written when the device is identified). all: anonymous hits too, with person_id 0.'
  },
  {
    name: 'timeline_entry_types',
    type: 'string',
    default: 'SESSION_START,FIRST_VISIT,LOGIN,LOGOUT,IDENTIFY,CUSTOM_ENTRY',
    section: 'Storage',
    description:
      'Comma-separated entry types written to the timeline when timeline_mode allows. PAGE_VIEW is deliberately not a default: it is the highest-volume entry.'
  },
  {
    name: 'log_directory',
    type: 'string',
    default: './gauge-logs',
    section: 'Log',
    description: 'Node collector: directory for the JSONL log (YYYY/MM/DD/HH-<host>-<pid>.jsonl).'
  },
  {
    name: 'fsync',
    type: 'string',
    values: ['interval', 'always', 'none'],
    default: 'interval',
    section: 'Log',
    description: 'How hard the collector works to put a hit on disk before it answers.'
  },
  {
    name: 'log_retention_days',
    type: 'int',
    default: 30,
    min: 1,
    section: 'Log',
    description: 'Days a closed log segment is kept after the loader has read it.'
  },
  // --- Sessions and devices --------------------------------------------------
  {
    name: 'session_timeout_minutes',
    type: 'int',
    default: 30,
    min: 1,
    section: 'Sessions',
    description:
      'Inactivity that ends a gauge session. A new campaign (utm_source/medium/campaign) also starts one. A gauge session is not the Core Session.'
  },
  {
    name: 'device_cookie_name',
    type: 'string',
    default: 'e9_did',
    section: 'Sessions',
    description: 'First-party cookie that holds the device id (web streams).'
  },
  {
    name: 'cookie_domain',
    type: 'string',
    default: '',
    section: 'Sessions',
    description: 'Cookie Domain attribute, e.g. example.com to share across subdomains. Empty is host-only.'
  },
  {
    name: 'cookie_days',
    type: 'int',
    default: 395,
    min: 1,
    section: 'Sessions',
    description: 'Device cookie lifetime in days.'
  },
  // --- Privacy ---------------------------------------------------------------
  {
    name: 'consent_mode',
    type: 'string',
    values: ['granted', 'required'],
    default: 'granted',
    section: 'Privacy',
    description:
      'granted: set the device cookie by default. required: cookieless daily counting (no cookie, no person link) until the client reports consent.'
  },
  {
    name: 'respect_gpc',
    type: 'boolean',
    default: true,
    section: 'Privacy',
    description: 'Treat Sec-GPC: 1 and DNT: 1 as no consent (cookieless counting).'
  },
  {
    name: 'ip_mode',
    type: 'string',
    values: ['drop', 'truncate'],
    default: 'drop',
    section: 'Privacy',
    description:
      'drop: the IP address is never logged. truncate: the log keeps /24 (IPv4) or /48 (IPv6). The IP is only ever used in memory, for rate limits and cookieless ids.'
  },
  {
    name: 'query_param_allowlist',
    type: 'string',
    default: '',
    section: 'Privacy',
    description:
      'Comma-separated query parameters kept on a URL. utm_* and source code parameters are always kept; anything that looks like an email is always removed.'
  },
  {
    name: 'bot_filter',
    type: 'boolean',
    default: true,
    section: 'Privacy',
    description: 'Drop hits from known bots and crawlers at the collector. They are not logged; /ok reports how many were dropped.'
  },
  {
    name: 'sample_rate',
    type: 'number',
    default: 1,
    min: 0,
    max: 1,
    section: 'Privacy',
    description: 'Fraction of devices recorded, chosen by a stable hash of the device id. 1 records everything.'
  },
  // --- Identity and attribution ---------------------------------------------
  {
    name: 'source_code_params',
    type: 'string',
    default: 'source_code,sc',
    section: 'Identity',
    description: 'Query parameters that carry an engine9 source code. A match sets source_code_id on timeline entries.'
  },
  {
    name: 'backfill_days',
    type: 'int',
    default: 30,
    min: 0,
    section: 'Identity',
    description:
      'When a device is identified, its anonymous hits from the last N days are attributed to the person. Needs db_mode entries or log files still on disk.'
  },
  // --- Custom entries --------------------------------------------------------
  {
    name: 'custom_entries',
    type: 'json',
    default: '[]',
    section: 'Custom entries',
    description:
      'Declared custom entries: [{"name":"video_upload","label":"Uploaded a video","key":true,"props":{"size_mb":"number"}},{"name":"newsletter","entry_type":"SIGNUP"}]. key:true sends it to the timeline. entry_type maps it onto a standard type instead of CUSTOM_ENTRY.'
  },
  {
    name: 'allow_undeclared_custom',
    type: 'boolean',
    default: true,
    section: 'Custom entries',
    description: 'When false, a custom entry whose name is not declared is rejected.'
  },
  {
    name: 'download_extensions',
    type: 'string',
    default: 'pdf,zip,csv,xlsx,docx,mp4,mp3',
    section: 'Custom entries',
    description: 'File extensions the browser client reports as FILE_DOWNLOAD.'
  },
  // --- Internal --------------------------------------------------------------
  {
    name: 'load_checkpoint',
    type: 'string',
    default: '',
    hidden: true,
    description: 'Loader position in the log (file and byte offset). Written by gauge, not edited.'
  }
];

export default { settings };
