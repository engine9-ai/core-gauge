// Custom entries (login, video_upload, ...). Each name is its own input with
// remote_input_id "custom:<name>", so it groups the same way in rollups and
// entries modes. Who did it: use the didCustomEntry segment clause.
export default {
  name: 'Custom entries',
  description: 'Custom entries by name, with how many distinct known people did each.',
  tags: ['Gauge'],
  data_sources: {
    default: {
      table: 'gauge_entry_summary',
      date_column: 'ts',
      conditions: [{ eql: 'entry_type_id=129' }]
    }
  },
  filters: {
    title: 'Filters',
    type: 'object',
    properties: {
      remote_input_id: { type: 'string', title: 'Name (custom:<name>)', filter: { column: 'remote_input_id', operator: 'LIKE' } }
    }
  },
  sections: [
    {
      title: 'By name',
      components: [
        {
          id: 'by_name',
          component: 'Table',
          orderBy: { eql: 'count(*)', orderByDirection: 'DESC' },
          dimensions: [{ name: 'Custom entry', eql: 'remote_input_id' }],
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
          metrics: [{ name: 'Entries', eql: 'count(*)', type: 'bar' }]
        }
      ]
    }
  ]
};
