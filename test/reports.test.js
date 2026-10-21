import { test } from 'node:test';
import assert from 'node:assert/strict';
import gauge, { reports } from '../gauge/index.js';
import schema from '../gauge/schema.js';

const COMPONENTS = new Set(['StatCard', 'ComposedChart', 'Table']);
const VIEW = 'gauge_entry_summary';
const VIEW_COLUMNS = [
  'id', 'ts', 'person_id', 'entry_type_id', 'entry_type', 'input_id', 'remote_input_id', 'remote_input_name', 'input_type',
  'source_code_id', 'device_id', 'gauge_session_id', 'platform', 'name', 'host', 'path', 'screen', 'referrer_host',
  'utm_source', 'utm_medium', 'utm_campaign', 'country', 'device_class', 'value'
];

function columnsOf(table) {
  if (table === VIEW) return new Set(VIEW_COLUMNS);
  const t = schema.tables.find((x) => x.name === table);
  return t ? new Set(Object.keys(t.columns)) : null;
}

function identifiers(eql) {
  return [...String(eql).replace(/'[^']*'/g, '').matchAll(/\b[a-z_][a-z0-9_]*\b/gi)]
    .map((m) => m[0])
    .filter((w) => !['count', 'sum', 'avg', 'distinct', 'min', 'max', 'case', 'when', 'then', 'end', 'null', 'and', 'or', 'not', 'is', 'like', 'in'].includes(w.toLowerCase()));
}

test('every report is exported on the plugin, keyed, and well formed', () => {
  assert.deepEqual(Object.keys(reports).sort(), ['acquisition', 'activity', 'custom_entries', 'pages', 'sessions', 'traffic']);
  assert.equal(gauge.reports, reports, 'default.reports is what core compiles');
  for (const [key, report] of Object.entries(reports)) {
    assert.ok(report.name && report.description, `${key} needs a name and description`);
    assert.ok(Array.isArray(report.sections) && report.sections.length, `${key} needs sections`);
    const ids = new Set();
    for (const section of report.sections) {
      for (const c of section.components) {
        assert.ok(COMPONENTS.has(c.component), `${key}/${c.id}: ${c.component} is not StatCard, ComposedChart or Table`);
        assert.ok(c.id && !ids.has(c.id), `${key}: component ids must be present and unique (${c.id})`);
        ids.add(c.id);
      }
    }
  }
});

test('reports only name tables, date columns and columns that exist', () => {
  for (const [key, report] of Object.entries(reports)) {
    const ds = report.data_sources.default;
    const cols = columnsOf(ds.table);
    assert.ok(cols, `${key}: unknown table ${ds.table}`);
    assert.ok(cols.has(ds.date_column), `${key}: ${ds.table} has no date column ${ds.date_column}`);
    for (const [name, prop] of Object.entries(report.filters.properties)) {
      assert.ok(cols.has(prop.filter.column), `${key}: filter ${name} uses missing column ${prop.filter.column}`);
    }
    const eqls = [];
    for (const c of ds.conditions || []) eqls.push(c.eql);
    for (const section of report.sections) {
      for (const c of section.components) {
        for (const x of c.conditions || []) eqls.push(x.eql);
        for (const m of [c.metric, ...(c.metrics || []), c.dimension, ...(c.dimensions || [])].filter(Boolean)) eqls.push(m.eql);
      }
    }
    for (const eql of eqls) {
      for (const word of identifiers(eql)) {
        if (/^\d/.test(word)) continue;
        assert.ok(cols.has(word), `${key}: "${eql}" uses ${word}, which is not a column of ${ds.table}`);
      }
    }
  }
});

test('no metric divides: SQLite and D1 truncate integer division, so use avg() for a ratio of a 0/1 column', () => {
  for (const [key, report] of Object.entries(reports)) {
    for (const section of report.sections) {
      for (const c of section.components) {
        for (const m of [c.metric, ...(c.metrics || [])].filter(Boolean)) {
          assert.ok(!m.eql.includes('/'), `${key}/${c.id}: "${m.eql}" divides`);
        }
      }
    }
  }
});

test('tables sort by their main measure, so "top" means top', () => {
  for (const [key, report] of Object.entries(reports)) {
    for (const section of report.sections) {
      for (const c of section.components) {
        if (c.component !== 'Table') continue;
        assert.ok(c.orderBy?.eql && c.orderBy.orderByDirection === 'DESC', `${key}/${c.id} needs orderBy DESC`);
      }
    }
  }
});
