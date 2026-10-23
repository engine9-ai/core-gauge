/*
  The gauge plugin: path `@engine9/core-gauge/gauge`.

  core discovers a plugin as a directory with index.js inside a package listed in
  package.json "engine9.pluginPackages". Because of that, this is the ONLY
  index.js (and there are no *.plugin.js files) in this package. The collector,
  loader and client are ordinary modules under lib/ and client/, reached through
  package.json "exports".

  A site turns gauge on by listing the package and installing the plugin:

    "engine9": { "pluginPackages": ["@engine9/schemas", "@engine9/core-gauge"] }

  core never imports gauge; gauge never has to be present to deploy core.
*/
import schema from './schema.js';
import { settings } from './settings.js';
import { segmentDefinitionClauses } from './segmentDefinitionClauses.js';
import { GAUGE_ENTRY_TYPES } from '../lib/entryTypes.js';
import traffic from './reports/traffic.js';
import sessions from './reports/sessions.js';
import acquisition from './reports/acquisition.js';
import pages from './reports/pages.js';
import activity from './reports/activity.js';
import custom_entries from './reports/custom_entries.js';
import outbound from './reports/outbound.js';

export const GAUGE_PLUGIN_PATH = '@engine9/core-gauge/gauge';

const metadata = {
  name: 'Gauge',
  unique: true,
  dependencies: {
    '@engine9/schemas/person': '>=1.9.0',
    '@engine9/schemas/timeline': '>=1.9.0'
  },
  entryTypes: Object.fromEntries(Object.entries(GAUGE_ENTRY_TYPES).filter(([k]) => Number.isNaN(Number(k))))
};

export const GAUGE_ENTRY_SUMMARY_VIEW = 'gauge_entry_summary';

function entryTypeCase(column) {
  const whens = Object.entries(metadata.entryTypes)
    .map(([name, id]) => `when ${id} then '${name}'`)
    .join(' ');
  return `case ${column} ${whens} else cast(${column} as char) end`;
}

/*
  Called by core's installRow after the tables and settings are deployed.
  Builds the summary view: timeline + input + gauge_entry, with a string
  entry_type, matching the other plugin *_summary views. Safe to re-run.
*/
export async function install({ sqlWorker }) {
  const sql = `select t.id, t.ts, t.person_id, t.entry_type_id, ${entryTypeCase('t.entry_type_id')} as entry_type,
    t.input_id, i.remote_input_id, i.remote_input_name, i.input_type, t.source_code_id,
    g.device_id, g.gauge_session_id, g.platform, g.name, g.host, g.path, g.screen,
    g.referrer_host, g.utm_source, g.utm_medium, g.utm_campaign, g.country, g.device_class, g.value
    from timeline t
    join input i on i.id = t.input_id
    left join gauge_entry g on g.id = t.id
    where t.entry_type_id between 100 and 129`;
  await sqlWorker.createView({ name: GAUGE_ENTRY_SUMMARY_VIEW, sql, replace: true });
  return { message: `${GAUGE_ENTRY_SUMMARY_VIEW} view created` };
}

// Report paths: @engine9/core-gauge/gauge:reports:traffic (and sessions, acquisition, pages, outbound, activity, custom_entries)
export const reports = { traffic, sessions, acquisition, pages, outbound, activity, custom_entries };

export { metadata, schema, settings, segmentDefinitionClauses };
export const transforms = {};
export default { metadata, schema, settings, segmentDefinitionClauses, reports, install };
