// Clicks on links to other sites, by destination host.
export default {
  name: 'Outbound clicks',
  description: 'Clicks on links that leave the site, per destination host.',
  tags: ['Gauge'],
  data_sources: {
    default: { table: 'gauge_outbound_day', date_column: 'date' }
  },
  filters: {
    title: 'Filters',
    type: 'object',
    properties: {
      input_id: { type: 'string', title: 'Stream (input id)', filter: { column: 'input_id', operator: '=' } },
      link_host: { type: 'string', title: 'Destination host contains', filter: { column: 'link_host', operator: 'LIKE' } }
    }
  },
  sections: [
    {
      title: 'Destinations',
      components: [
        {
          id: 'top_hosts',
          component: 'Table',
          orderBy: { eql: 'sum(clicks)', orderByDirection: 'DESC' },
          limit: 25,
          dimensions: [{ name: 'Destination', eql: 'link_host' }],
          metrics: [{ name: 'Clicks', eql: 'sum(clicks)' }]
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
          metrics: [{ name: 'Clicks', eql: 'sum(clicks)', type: 'bar' }]
        }
      ]
    }
  ]
};
