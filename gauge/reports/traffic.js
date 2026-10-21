// Visitors, sessions and page views over time. Visitors are distinct devices
// (the GA4 "users" count); known people are devices linked to a person_id.
export default {
  name: 'Traffic',
  description: 'Unique visitors (devices), sessions and views. Known people are visitors linked to a person.',
  tags: ['Gauge'],
  data_sources: {
    default: { table: 'gauge_device_day', date_column: 'date' }
  },
  filters: {
    title: 'Filters',
    type: 'object',
    properties: {
      input_id: {
        type: 'string',
        title: 'Stream (input id)',
        filter: { column: 'input_id', operator: '=' }
      }
    }
  },
  sections: [
    {
      title: 'Key metrics',
      components: [
        { id: 'visitors', component: 'StatCard', name: 'Visitors', metric: { eql: 'count(distinct device_id)' } },
        { id: 'sessions', component: 'StatCard', name: 'Sessions', metric: { eql: 'sum(sessions)' } },
        { id: 'views', component: 'StatCard', name: 'Views', metric: { eql: 'sum(views)' } },
        {
          id: 'known_people',
          component: 'StatCard',
          name: 'Known people',
          conditions: [{ eql: 'person_id>0' }],
          metric: { eql: 'count(distinct person_id)' }
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
          dimension: { eql: 'date' },
          metrics: [
            { name: 'Visitors', eql: 'count(distinct device_id)', type: 'line' },
            { name: 'Sessions', eql: 'sum(sessions)', type: 'bar' },
            { name: 'Views', eql: 'sum(views)', type: 'bar' }
          ]
        }
      ]
    }
  ]
};
