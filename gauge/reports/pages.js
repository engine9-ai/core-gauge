// Views per page path (web) or screen name (app), and where sessions landed.
export default {
  name: 'Pages and screens',
  description: 'Views and entrances per page path or screen name.',
  tags: ['Gauge'],
  data_sources: {
    default: { table: 'gauge_view_day', date_column: 'date' }
  },
  filters: {
    title: 'Filters',
    type: 'object',
    properties: {
      input_id: { type: 'string', title: 'Stream (input id)', filter: { column: 'input_id', operator: '=' } },
      view_name: { type: 'string', title: 'Path or screen contains', filter: { column: 'view_name', operator: 'LIKE' } }
    }
  },
  sections: [
    {
      title: 'Top pages and screens',
      components: [
        {
          id: 'top_views',
          component: 'Table',
          orderBy: { eql: 'sum(views)', orderByDirection: 'DESC' },
          limit: 25,
          dimensions: [{ name: 'Page or screen', eql: 'view_name' }],
          metrics: [
            { name: 'Views', eql: 'sum(views)' },
            { name: 'Entrances', eql: 'sum(sessions_started)' }
          ]
        }
      ]
    }
  ]
};
