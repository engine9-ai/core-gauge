// Where sessions came from: referring site and utm parameters.
export default {
  name: 'Acquisition',
  description: 'Sessions and visitors by referring site, utm source, medium and campaign.',
  tags: ['Gauge'],
  data_sources: {
    default: { table: 'gauge_session', date_column: 'date' }
  },
  filters: {
    title: 'Filters',
    type: 'object',
    properties: {
      input_id: { type: 'string', title: 'Stream (input id)', filter: { column: 'input_id', operator: '=' } },
      utm_campaign: { type: 'string', title: 'Campaign', filter: { column: 'utm_campaign', operator: 'LIKE' } }
    }
  },
  sections: [
    {
      title: 'Referring sites',
      components: [
        {
          id: 'by_referrer',
          component: 'Table',
          orderBy: { eql: 'count(*)', orderByDirection: 'DESC' },
          dimensions: [{ name: 'Referrer', eql: 'referrer_host' }],
          metrics: [
            { name: 'Sessions', eql: 'count(*)' },
            { name: 'Visitors', eql: 'count(distinct device_id)' },
            { name: 'New visitors', eql: 'sum(is_new_device)' },
            { name: 'Bounce rate', eql: 'avg(bounced)', format: 'percent' }
          ]
        }
      ]
    },
    {
      title: 'Campaigns',
      components: [
        {
          id: 'by_campaign',
          component: 'Table',
          orderBy: { eql: 'count(*)', orderByDirection: 'DESC' },
          dimensions: [
            { name: 'Source', eql: 'utm_source' },
            { name: 'Medium', eql: 'utm_medium' },
            { name: 'Campaign', eql: 'utm_campaign' }
          ],
          metrics: [
            { name: 'Sessions', eql: 'count(*)' },
            { name: 'Visitors', eql: 'count(distinct device_id)' },
            { name: 'Known people', eql: 'count(distinct case when person_id>0 then person_id end)' },
            { name: 'Bounce rate', eql: 'avg(bounced)', format: 'percent' }
          ]
        }
      ]
    }
  ]
};
