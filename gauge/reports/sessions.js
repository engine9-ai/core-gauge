// Engagement per session. A gauge session is a run of activity from one
// device ended by inactivity (session_timeout_minutes); it is not a Core Session.
export default {
  name: 'Sessions',
  description: 'Sessions, new visitors, bounce rate, views per session and time on site, by platform, device and country.',
  tags: ['Gauge'],
  data_sources: {
    default: { table: 'gauge_session', date_column: 'date' }
  },
  filters: {
    title: 'Filters',
    type: 'object',
    properties: {
      input_id: { type: 'string', title: 'Stream (input id)', filter: { column: 'input_id', operator: '=' } },
      platform: { type: 'string', title: 'Platform', enum: ['web', 'ios', 'android', 'desktop', 'server'], filter: { column: 'platform', operator: '=' } },
      country: { type: 'string', title: 'Country', filter: { column: 'country', operator: '=' } },
      device_class: { type: 'string', title: 'Device class', filter: { column: 'device_class', operator: '=' } }
    }
  },
  sections: [
    {
      title: 'Key metrics',
      components: [
        { id: 'sessions', component: 'StatCard', name: 'Sessions', metric: { eql: 'count(*)' } },
        { id: 'new_visitors', component: 'StatCard', name: 'New visitors', metric: { eql: 'sum(is_new_device)' } },
        { id: 'bounce_rate', component: 'StatCard', name: 'Bounce rate', metric: { eql: 'avg(bounced)', format: 'percent' } },
        { id: 'views_per_session', component: 'StatCard', name: 'Views per session', metric: { eql: 'avg(views)', format: 'number' } },
        { id: 'avg_duration', component: 'StatCard', name: 'Average seconds on site', metric: { eql: 'avg(duration_s)', format: 'number' } }
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
            { name: 'Sessions', eql: 'count(*)', type: 'bar' },
            { name: 'Bounce rate', eql: 'avg(bounced)', format: 'percent', yaxis: 'right', type: 'line' }
          ]
        }
      ]
    },
    {
      title: 'Who',
      components: [
        {
          id: 'by_device_class',
          component: 'Table',
          orderBy: { eql: 'count(*)', orderByDirection: 'DESC' },
          dimensions: [{ name: 'Device', eql: 'device_class' }],
          metrics: [
            { name: 'Sessions', eql: 'count(*)' },
            { name: 'Visitors', eql: 'count(distinct device_id)' },
            { name: 'Bounce rate', eql: 'avg(bounced)', format: 'percent' }
          ]
        },
        {
          id: 'by_browser',
          component: 'Table',
          orderBy: { eql: 'count(*)', orderByDirection: 'DESC' },
          dimensions: [{ name: 'Browser', eql: 'browser' }],
          metrics: [
            { name: 'Sessions', eql: 'count(*)' },
            { name: 'Visitors', eql: 'count(distinct device_id)' }
          ]
        },
        {
          id: 'by_country',
          component: 'Table',
          orderBy: { eql: 'count(*)', orderByDirection: 'DESC' },
          dimensions: [{ name: 'Country', eql: 'country' }],
          metrics: [
            { name: 'Sessions', eql: 'count(*)' },
            { name: 'Visitors', eql: 'count(distinct device_id)' }
          ]
        }
      ]
    }
  ]
};
