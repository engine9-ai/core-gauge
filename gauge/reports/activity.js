// What known people did. This reads the timeline (the gauge_entry_summary
// view), so it covers the entries that reached the timeline: with
// timeline_mode=identified, people the collector could tie to a person_id.
export default {
  name: 'Known-person activity',
  description: 'Gauge timeline entries by type, with how many distinct people did each.',
  tags: ['Gauge'],
  data_sources: {
    default: { table: 'gauge_entry_summary', date_column: 'ts' }
  },
  filters: {
    title: 'Filters',
    type: 'object',
    properties: {
      input_id: { type: 'string', title: 'Stream (input id)', filter: { column: 'input_id', operator: '=' } },
      entry_type: { type: 'string', title: 'Entry type', filter: { column: 'entry_type', operator: '=' } }
    }
  },
  sections: [
    {
      title: 'By entry type',
      components: [
        {
          id: 'by_type',
          component: 'Table',
          orderBy: { eql: 'count(*)', orderByDirection: 'DESC' },
          dimensions: [{ name: 'Entry type', eql: 'entry_type' }],
          metrics: [
            { name: 'Entries', eql: 'count(*)' },
            { name: 'People', eql: 'count(distinct person_id)' }
          ]
        }
      ]
    },
    {
      title: 'By day',
      components: [
        {
          id: 'by_day',
          component: 'ComposedChart',
          isDate: true,
          dimension: { eql: 'ts' },
          metrics: [
            { name: 'Entries', eql: 'count(*)', type: 'bar' },
            { name: 'People', eql: 'count(distinct person_id)', type: 'line' }
          ]
        }
      ]
    }
  ]
};
