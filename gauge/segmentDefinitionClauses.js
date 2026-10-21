/*
  Segment definition clauses for gauge. Each clause is { title, description,
  form, optionsToEQL }, the same shape as @engine9/schemas/timeline's clauses.
  They read gauge's own rollup tables so they work with db_mode "rollups".
*/

/* Absolute UTC timestamp N days ago, computed when the clause is turned into EQL. */
function relativeStart(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) throw new Error('days must be a positive number');
  return new Date(Date.now() - Math.floor(d) * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

/** People with a gauge session on a stream in the last N days. */
export const visitedRecently = {
  title: 'Visited recently',
  description: 'People with at least one gauge session in the last N days.',
  form: {
    title: 'Visited recently',
    type: 'object',
    properties: {
      days: { title: 'Within the last N days', type: 'integer', minimum: 1, default: 30 },
      streamId: { title: 'Stream input id (optional)', type: 'string' }
    },
    required: ['days']
  },
  optionsToEQL(options = {}) {
    const { days, streamId } = options;
    const conditions = [
      { type: 'GREATER_THAN', values: [{ ref: { column: 'person_id' } }, { value: { value: 0 } }] },
      {
        type: 'GREATER_THAN_OR_EQUAL',
        values: [{ ref: { column: 'start_ts' } }, { value: { value: relativeStart(days) } }]
      }
    ];
    if (streamId) {
      conditions.push({ type: 'EQUALS', values: [{ ref: { column: 'input_id' } }, { value: { value: streamId } }] });
    }
    return {
      text: `Had a gauge session in the last ${days} days`,
      eql: { table: 'gauge_session', columns: ['person_id'], conditions }
    };
  }
};

/** People who did a named custom entry (via its input row's remote_input_id). */
export const didCustomEntry = {
  title: 'Did a custom entry',
  description: 'People with a timeline entry for a named custom gauge entry, e.g. video_upload.',
  form: {
    title: 'Did a custom entry',
    type: 'object',
    properties: {
      name: { title: 'Custom entry name', type: 'string' }
    },
    required: ['name']
  },
  optionsToEQL(options = {}) {
    const { name } = options;
    if (!name) throw new Error('name is required');
    return {
      text: `Did custom entry ${name}`,
      eql: {
        table: 'timeline',
        columns: ['person_id'],
        joins: [{ table: 'input', join_eql: 'timeline.input_id=input.id' }],
        conditions: [
          { type: 'EQUALS', values: [{ ref: { column: 'entry_type_id' } }, { value: { value: 129 } }] },
          { type: 'EQUALS', values: [{ ref: { column: 'remote_input_id' } }, { value: { value: `custom:${name}` } }] }
        ]
      }
    };
  }
};

export const segmentDefinitionClauses = { visitedRecently, didCustomEntry };
export default { segmentDefinitionClauses };
