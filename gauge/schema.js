/*
  Gauge tables. Names are fixed (`gauge_` stem, no hex prefix): they join the
  engine9 standard. Every table that involves a person uses a column named
  `person_id`, so core's erasePeople removes it with no list to update.

  person_id 0 means "not (yet) known". It is never a person.

  Which of these fill depends on settings (db_mode, timeline_mode); the tables
  always exist so reports and upgrades never have to guess.
*/
export const tables = [
  {
    // Detail for one hit, keyed by the timeline entry id (same id as timeline.id).
    // Written only when db_mode = entries; the disk log is the full record.
    name: 'gauge_entry',
    columns: {
      id: 'id_uuid',
      ts: 'datetime',
      received_at: 'datetime',
      input_id: 'uuid',
      entry_type_id: 'int',
      person_id: 'person_id',
      device_id: 'id_string',
      gauge_session_id: 'foreign_uuid',
      platform: 'string',
      name: 'string', // custom entry name (CUSTOM_ENTRY) or recommended-event label
      host: 'string',
      path: 'string',
      query: 'text', // scrubbed: only allowlisted parameters
      title: 'string',
      referrer_host: 'string',
      referrer_path: 'string',
      screen: 'string', // screen name for SCREEN_VIEW
      utm_source: 'string',
      utm_medium: 'string',
      utm_campaign: 'string',
      utm_term: 'string',
      utm_content: 'string',
      app_version: 'string',
      os: 'string',
      os_version: 'string',
      browser: 'string',
      device_model: 'string',
      device_class: 'string', // desktop | mobile | tablet | bot | other
      country: 'string',
      region: 'string',
      source_code: 'string',
      value: 'double',
      props: 'json',
      created_at: 'created_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: 'ts' },
      { columns: 'person_id' },
      { columns: ['input_id', 'ts'] },
      { columns: 'gauge_session_id' }
    ]
  },
  {
    // One browser or app install within one stream.
    name: 'gauge_device',
    columns: {
      id: 'id',
      input_id: 'uuid',
      device_id: 'id_string',
      person_id: 'person_id',
      // sha256 of the lowercased email (core's email_hash_v1) awaiting a person lookup.
      // Plaintext email never reaches gauge.
      email_hash_v1: 'hash',
      platform: 'string',
      first_seen: 'datetime',
      last_seen: 'datetime',
      first_referrer_host: 'string',
      first_utm_source: 'string',
      first_utm_medium: 'string',
      first_utm_campaign: 'string',
      identified_at: 'datetime',
      created_at: 'created_at',
      modified_at: 'modified_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['input_id', 'device_id'], unique: true },
      { columns: 'person_id' },
      { columns: 'email_hash_v1' }
    ]
  },
  {
    // A run of activity from one device, ended by inactivity (session_timeout_minutes).
    // Not the Core Session (the auth token): that is a different thing.
    name: 'gauge_session',
    columns: {
      id: 'id_uuid',
      input_id: 'uuid',
      device_id: 'id_string',
      person_id: 'person_id',
      platform: 'string',
      start_ts: 'datetime',
      end_ts: 'datetime',
      date: 'date',
      entries: 'int',
      views: 'int',
      landing_view: 'string', // first page path or screen name
      exit_view: 'string', // last page path or screen name
      referrer_host: 'string',
      utm_source: 'string',
      utm_medium: 'string',
      utm_campaign: 'string',
      country: 'string',
      device_class: 'string',
      is_new_device: 'boolean',
      bounced: 'boolean',
      duration_s: 'int',
      created_at: 'created_at',
      modified_at: 'modified_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['input_id', 'date'] },
      { columns: ['input_id', 'device_id', 'start_ts'] },
      { columns: 'person_id' }
    ]
  },
  {
    // Source of unique-device counts: COUNT(DISTINCT device_id) over any date range.
    name: 'gauge_device_day',
    columns: {
      id: 'id',
      date: 'date',
      input_id: 'uuid',
      device_id: 'id_string',
      person_id: 'person_id',
      sessions: 'int',
      views: 'int',
      entries: 'int',
      created_at: 'created_at',
      modified_at: 'modified_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['date', 'input_id', 'device_id'], unique: true },
      { columns: 'person_id' }
    ]
  },
  {
    // Views per page path (web) or screen name (app) per day.
    name: 'gauge_view_day',
    columns: {
      id: 'id',
      date: 'date',
      input_id: 'uuid',
      view_name: 'id_string', // page path or screen name (max 128)
      views: 'int',
      sessions_started: 'int', // sessions that landed here
      created_at: 'created_at',
      modified_at: 'modified_at'
    },
    indexes: [
      { columns: 'id', primary: true },
      { columns: ['date', 'input_id', 'view_name'], unique: true }
    ]
  }
];

export default { tables };
