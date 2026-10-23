/*
  Regenerate the sample report images in docs/images.

    npm run sample-images

  The numbers are real output, not drawings of invented numbers:

    1. simulate 30 days of traffic for one site (a fixed seed, so reruns draw
       the same pictures),
    2. load it with Gauge's own loader into in-memory SQLite,
    3. run every component of each shipped report definition as SQL over the
       report's data source (each metric is a plain aggregate, see the README),
    4. draw the results as SVG.

  The reports are read from gauge/reports, so a new metric shows up here as
  soon as the report has it. Which components each picture draws is chosen
  below. This script does not import any report compiler.

  Prints the headline numbers so the captions in README.md can be checked.
*/
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGaugeWorker, rows } from '../test/helpers.js';
import { loadRecords } from '../lib/loader.js';
import { reports } from '../gauge/index.js';

const OUT = fileURLToPath(new URL('../docs/images/', import.meta.url));
const SITE = 'www.example.org';
const STREAM = { id: 'G-sample', name: SITE, type: 'web_stream', hosts: [SITE] };
const START = Date.UTC(2026, 8, 21); // Sep 21
const DAYS = 30;
const FROM = '2026-09-21';
const TO = '2026-10-21'; // exclusive
const RANGE = 'Sep 21 – Oct 20, 2026';
const NEWSLETTER_DAY = 18; // Oct 9

// --- simulation ---------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20261021);
const pick = (weighted) => {
  const total = weighted.reduce((n, [, w]) => n + w, 0);
  let r = rand() * total;
  for (const [value, w] of weighted) {
    r -= w;
    if (r <= 0) return value;
  }
  return weighted[weighted.length - 1][0];
};

const BROWSERS = [['Chrome', 46], ['Safari', 34], ['Edge', 9], ['Firefox', 8], ['Opera', 2], ['Samsung Internet', 1]];
const DEVICES = [['desktop', 58], ['mobile', 36], ['tablet', 6]];
const COUNTRIES = [['US', 70], ['CA', 10], ['GB', 7.5], ['DE', 6.5], ['AU', 5], ['FR', 1]];
const OUTBOUND = [['shop.example.net', 45], ['instagram.com', 20], ['github.com', 15], ['partner.example', 12], ['video.example.com', 8]];
const PAGES = [
  ['/', 30], ['/features', 18], ['/pricing', 16], ['/blog/measure-what-matters', 9], ['/docs/getting-started', 6],
  ['/docs/uploading-video', 5], ['/signup', 5], ['/blog/october-update', 3]
];
const KNOWN_PAGES = [['/account', 40], ['/account/videos', 40], ['/', 10], ['/features', 10]];

function landingFor(source, known) {
  if (known) return '/account';
  if (source.utm_campaign === 'october-update') return '/blog/october-update';
  if (source.utm_campaign === 'fall-launch') return pick([['/features', 50], ['/pricing', 30], ['/signup', 20]]);
  if (source.referrer_host === 'www.google.com') return pick([['/', 40], ['/blog/measure-what-matters', 30], ['/docs/getting-started', 20], ['/features', 10]]);
  return pick([['/', 78], ['/pricing', 8], ['/features', 8], ['/signup', 6]]);
}

function sourceFor(day) {
  const newsletterShare = day === NEWSLETTER_DAY ? 0.62 : day === NEWSLETTER_DAY + 1 ? 0.18 : day === NEWSLETTER_DAY + 2 ? 0.06 : 0;
  const paidShare = day >= 21 ? 0.18 : 0;
  const r = rand();
  if (r < newsletterShare) return { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'october-update' };
  if (r < newsletterShare + paidShare) return { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'fall-launch' };
  return pick([
    [{}, 52],
    [{ referrer_host: 'www.google.com' }, 33],
    [{ referrer_host: 'blog.partner.example' }, 6],
    [{ referrer_host: 'www.reddit.com' }, 5],
    [{ referrer_host: 'news.example.com' }, 4]
  ]);
}

let hitCounter = 0;
function simulate() {
  const records = [];
  const visitors = [];
  let nextPerson = 1;
  const stamp = (dayIndex, minute) => new Date(START + dayIndex * 86400000 + minute * 60000).toISOString();

  const hit = (v, dayIndex, minute, extra) => {
    hitCounter += 1;
    const ts = stamp(dayIndex, minute);
    return {
      v: 1,
      kind: 'hit',
      hit_id: `sample-${String(hitCounter).padStart(8, '0')}`,
      received_at: ts,
      ts,
      stream: STREAM.id,
      input_type: 'web_stream',
      platform: 'web',
      device_id: v.id,
      device_source: 'cookie',
      person_id: v.person_id,
      consent: true,
      host: SITE,
      browser: v.browser,
      device_class: v.device_class,
      country: v.country,
      entry_type_id: 102,
      entry_type: 'PAGE_VIEW',
      ...extra
    };
  };

  const visit = (v, dayIndex, first) => {
    const sessions = rand() < 0.1 ? 2 : 1;
    for (let s = 0; s < sessions; s += 1) {
      const start = Math.floor(rand() * (s === 0 ? 600 : 500)) + (s === 0 ? 0 : 800); // 2nd session hours later
      const source = first || rand() < 0.3 ? v.source : {};
      const known = v.person_id > 0;
      const bounce = !known && rand() < 0.4;
      const pages = bounce ? 1 : 2 + Math.floor(-Math.log(1 - rand()) * 1.6);
      let minute = start;
      for (let p = 0; p < pages; p += 1) {
        const path = p === 0 ? landingFor(source, known) : pick(known ? KNOWN_PAGES : PAGES);
        records.push(hit(v, dayIndex, minute, { path, ...(p === 0 ? source : {}) }));
        minute += 1 + Math.floor(rand() * 3);
        if (p === 0 && known && s === 0 && rand() < 0.8) {
          records.push(hit(v, dayIndex, minute, { entry_type_id: 106, entry_type: 'LOGIN', path: '/login' }));
        }
      }
      if (known && rand() < 0.5) {
        records.push(hit(v, dayIndex, minute, { entry_type_id: 107, entry_type: 'LOGOUT', path: '/account' }));
      }
      if (known && rand() < 0.28) {
        records.push(hit(v, dayIndex, minute + 1, { entry_type_id: 129, entry_type: 'CUSTOM_ENTRY', name: 'video_upload', path: '/account/videos', value: 5 + Math.floor(rand() * 90) }));
      }
      if (!bounce && rand() < 0.14) {
        records.push(hit(v, dayIndex, minute + 1, { entry_type_id: 110, entry_type: 'OUTBOUND_CLICK', host: pick(OUTBOUND), path: '/' }));
      }
    }
  };

  for (let day = 0; day < DAYS; day += 1) {
    const weekday = new Date(START + day * 86400000).getUTCDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.78 : 1;
    const arrivals = Math.round((52 + day * 1.6 + rand() * 24) * weekend + (day === NEWSLETTER_DAY ? 340 : day === NEWSLETTER_DAY + 1 ? 90 : 0));
    for (let i = 0; i < arrivals; i += 1) {
      const source = sourceFor(day);
      const v = {
        id: `dev-${String(visitors.length + 1).padStart(6, '0')}`,
        browser: pick(BROWSERS),
        device_class: pick(DEVICES),
        country: pick(COUNTRIES),
        source,
        person_id: rand() < (source.utm_campaign ? 0.075 : 0.07) ? nextPerson++ : 0
      };
      visitors.push(v);
      visit(v, day, true);
    }
    // Earlier visitors who come back today.
    for (const v of visitors) {
      if (v.first_day === undefined) v.first_day = day;
    }
    for (const v of visitors) {
      if (v.first_day >= day) continue;
      if (rand() < (v.person_id ? 0.16 : 0.055)) visit(v, day, false);
    }
  }
  records.sort((a, b) => a.ts.localeCompare(b.ts));
  return records;
}

// --- running a report's components -----------------------------------------------

function whereFor(report, component) {
  const ds = report.data_sources.default;
  const col = ds.date_column;
  const where = [`${col} >= '${FROM}'`, `${col} < '${TO}'`];
  for (const c of [...(ds.conditions || []), ...(component.conditions || [])]) where.push(`(${c.eql})`);
  return where.join(' and ');
}

function componentSql(report, c) {
  const table = report.data_sources.default.table;
  const where = whereFor(report, c);
  if (c.component === 'StatCard') return `select ${c.metric.eql} as m0 from ${table} where ${where}`;
  const dims = c.dimensions || (c.dimension ? [c.dimension] : []);
  const metrics = c.metrics || [];
  const select = [...dims.map((d, i) => `${d.eql} as d${i}`), ...metrics.map((m, i) => `${m.eql} as m${i}`)].join(', ');
  const group = dims.map((d) => d.eql).join(', ');
  let sql = `select ${select} from ${table} where ${where}`;
  if (group) sql += ` group by ${group}`;
  if (c.orderBy) sql += ` order by ${c.orderBy.eql} ${c.orderBy.orderByDirection || 'DESC'}`;
  else if (c.isDate) sql += ' order by d0';
  return sql;
}

async function runReport(worker, key) {
  const report = reports[key];
  const out = { report, key, sql: {}, data: {} };
  for (const section of report.sections) {
    for (const c of section.components) {
      const sql = componentSql(report, c);
      out.sql[c.id] = sql;
      const data = await rows(worker, sql);
      out.data[c.id] = c.component === 'StatCard' ? Number(Object.values(data[0] || {})[0] ?? 0) : data;
    }
  }
  return out;
}

// --- drawing -------------------------------------------------------------------

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const BAR = '#c7d2fe';
const TEAL = '#0d9488';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n0 = (n) => Math.round(Number(n)).toLocaleString('en-US');
const n2 = (n) => Number(n).toFixed(2);
const pct = (n) => `${(Number(n) * 100).toFixed(1)}%`;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

class Svg {
  constructor(title) {
    this.title = title;
    this.parts = [];
    this.y = 84;
  }

  text(x, y, s, { size = 12, fill = INK, weight = 400, anchor = 'start' } = {}) {
    this.parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}">${esc(s)}</text>`);
  }

  rect(x, y, w, h, { rx = 0, fill = 'none', stroke } = {}) {
    this.parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`);
  }

  line(x1, x2, y1, y2 = y1, stroke = LINE) {
    this.parts.push(`<line x1="${x1}" x2="${x2}" y1="${y1}" y2="${y2}" stroke="${stroke}"/>`);
  }

  cards(cards) {
    const perRow = cards.length <= 5 ? cards.length : Math.ceil(cards.length / 2);
    const w = (904 - 14 * (perRow - 1)) / perRow;
    cards.forEach((card, i) => {
      const x = 28 + (i % perRow) * (w + 14);
      const y = this.y + Math.floor(i / perRow) * 100;
      this.rect(x, y, w, 86, { rx: 10, fill: '#f9fafb', stroke: LINE });
      this.text(x + 16, y + 26, card.label, { size: 12, fill: MUTED });
      this.text(x + 16, y + 58, card.value, { size: 26, weight: 600 });
      if (card.sub) this.text(x + 16, y + 76, card.sub, { size: 11, fill: MUTED });
    });
    this.y += Math.ceil(cards.length / perRow) * 100 - 14;
  }

  /**
   * A table with a bar behind the main number.
   * spec: x0, x1 (the table's edges), labelX, barX, barW, valueX (right edge of the main number),
   * extra: [{ label, right }], rows: [{ label, muted, value, extra: [text] }], separators.
   */
  table(spec, y = this.y + 20) {
    const { x0, x1, title, head, rows: body, extra = [], barX, barW, valueX, separators = true } = spec;
    this.text(x0, y, title, { size: 14, weight: 600 });
    this.line(x0, x1, y + 14);
    const hy = y + 32;
    this.text(x0, hy, head[0], { size: 11, fill: MUTED, weight: 600 });
    this.text(barX, hy, head[1], { size: 11, fill: MUTED, weight: 600 });
    extra.forEach((e) => this.text(e.right, hy, e.label, { size: 11, fill: MUTED, weight: 600, anchor: 'end' }));
    this.line(x0, x1, y + 40);
    const max = Math.max(1, ...body.map((r) => num(r.raw)));
    body.forEach((r, i) => {
      const by = y + 60 + i * 30;
      this.text(x0, by, r.label, { fill: r.muted ? MUTED : INK });
      this.rect(barX, by - 11, (num(r.raw) / max) * barW, 12, { rx: 3, fill: BAR });
      this.text(valueX, by, r.value, { anchor: 'end' });
      extra.forEach((e, j) => this.text(e.right, by, r.extra[j], { anchor: 'end' }));
      if (separators) this.line(x0, x1, by + 10);
    });
    return y + 60 + body.length * 30 - 20;
  }

  /** Bars on the left axis, an optional line on the right axis, day labels every five days. */
  chart({ days, bars, line, barLabel, lineLabel, barFmt = n0, note }) {
    const top = this.y + 60;
    const h = 200;
    const left = niceMax(Math.max(...bars));
    const right = line ? niceMax(Math.max(...line)) : 0;
    const x0 = 64;
    const x1 = 896;
    const step = (x1 - x0) / days.length;
    for (let i = 0; i <= 4; i += 1) {
      const y = top + h - (i * h) / 4;
      this.line(x0, x1, y);
      this.text(56, y + 4, barFmt((left * i) / 4), { size: 10, fill: MUTED, anchor: 'end' });
      if (line) this.text(904, y + 4, barFmt((right * i) / 4), { size: 10, fill: TEAL });
    }
    const bw = step * 0.62;
    bars.forEach((v, i) => {
      const bh = (v / left) * h;
      this.rect(x0 + i * step + (step - bw) / 2, top + h - bh, bw, bh, { rx: 2, fill: BAR });
      if (i % 5 === 0) this.text(x0 + i * step + step / 2, top + h + 18, days[i], { size: 10, fill: MUTED, anchor: 'middle' });
    });
    if (line) {
      const pts = line.map((v, i) => `${(x0 + i * step + step / 2).toFixed(1)},${(top + h - (v / right) * h).toFixed(1)}`);
      this.parts.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="${TEAL}" stroke-width="2.5" stroke-linejoin="round"/>`);
    }
    this.rect(64, top - 26, 12, 12, { rx: 2, fill: BAR });
    this.text(82, top - 16, barLabel, { fill: MUTED });
    if (line) {
      this.rect(174, top - 21, 14, 3, { fill: TEAL });
      this.text(194, top - 16, lineLabel, { fill: MUTED });
    }
    this.y = top + h + 18;
    if (note) this.footnote(note, { center: true, gap: 30 });
  }

  footnote(s, { center = false, gap = 36 } = {}) {
    this.y += gap;
    this.text(center ? 480 : 28, this.y, s, { size: 13, fill: MUTED, anchor: center ? 'middle' : 'start' });
  }

  render() {
    const height = this.y + 22;
    const head = [
      `<rect width="960" height="${height}" rx="12" fill="#ffffff" stroke="${LINE}"/>`,
      `<text x="28" y="40" font-size="20" fill="${INK}" font-weight="600" text-anchor="start">${esc(this.title)}</text>`,
      `<text x="28" y="62" font-size="13" fill="${MUTED}" font-weight="400" text-anchor="start">${SITE} · ${RANGE}</text>`,
      `<text x="932" y="40" font-size="11" fill="${MUTED}" font-weight="400" text-anchor="end">sample data</text>`
    ];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="${height}" viewBox="0 0 960 ${height}" font-family="${FONT}">\n${[...head, ...this.parts].join('\n')}\n</svg>\n`;
  }
}

function niceMax(v) {
  if (v <= 0) return 4;
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return step * 4;
}

const dayLabel = (iso) => new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const get = (run, id) => run.data[id];

// --- the pictures ----------------------------------------------------------------

function trafficImage(run) {
  const svg = new Svg('Traffic');
  svg.cards([
    { label: 'Visitors', value: n0(get(run, 'visitors')), sub: 'distinct devices' },
    { label: 'Sessions', value: n0(get(run, 'sessions')) },
    { label: 'Page views', value: n0(get(run, 'views')) },
    { label: 'Visitors counted once a day', value: n0(get(run, 'visitor_days')), sub: 'a daily counter’s “visitors”' },
    { label: 'Views per visitor per day', value: n2(get(run, 'views_per_visitor_day')), sub: 'pages per visit' },
    { label: 'Days with visits', value: n0(get(run, 'days')) },
    { label: 'Known people', value: n0(get(run, 'known_people')), sub: 'visitors tied to a person_id' }
  ]);
  const byDay = get(run, 'by_day');
  svg.chart({
    days: byDay.map((r) => dayLabel(r.d0)),
    bars: byDay.map((r) => num(r.m2)),
    line: byDay.map((r) => num(r.m0)),
    barLabel: 'Page views',
    lineLabel: 'Visitors',
    note: 'The October newsletter went out on Oct 9.'
  });
  return svg.render();
}

function sessionsImage(run) {
  const svg = new Svg('Sessions');
  svg.cards([
    { label: 'Sessions', value: n0(get(run, 'sessions')) },
    { label: 'New visitors', value: n0(get(run, 'new_visitors')) },
    { label: 'Bounce rate', value: pct(get(run, 'bounce_rate')), sub: 'one view, then gone' },
    { label: 'Views per session', value: n2(get(run, 'views_per_session')) },
    { label: 'Time on site', value: `${n0(get(run, 'avg_duration'))} s`, sub: 'average per session' }
  ]);
  const compact = (id, title, first, head) => ({
    x0: first ? 28 : 502,
    x1: first ? 458 : 932,
    title,
    head,
    barX: first ? 138 : 612,
    barW: 150,
    valueX: first ? 330 : 804,
    separators: false
  });
  const device = get(run, 'by_device_class');
  const browser = get(run, 'by_browser');
  const country = get(run, 'by_country').slice(0, 6);
  const top = svg.y + 66;
  const end = svg.table({
    ...compact('device', 'By device', true, ['Device', 'Sessions']),
    extra: [{ label: 'Bounce rate', right: 450 }],
    rows: device.map((r) => ({ label: r.d0 || '(unknown)', raw: r.m0, value: n0(r.m0), extra: [pct(r.m2)] }))
  }, top);
  const browserEnd = svg.table({
    ...compact('browser', 'By browser', true, ['Browser', 'Sessions']),
    extra: [{ label: 'Visitors', right: 450 }],
    rows: browser.map((r) => ({ label: r.d0 || '(unknown)', raw: r.m0, value: n0(r.m0), extra: [n0(r.m1)] }))
  }, end + 24);
  const countryEnd = svg.table({
    ...compact('country', 'By country', false, ['Country', 'Sessions']),
    extra: [{ label: 'Visitors', right: 924 }],
    rows: country.map((r) => ({ label: r.d0 || '(unknown)', raw: r.m0, value: n0(r.m0), extra: [n0(r.m1)] }))
  }, top);
  svg.y = Math.max(browserEnd, countryEnd) + 10;
  return svg.render();
}

function referralsImage(run) {
  const svg = new Svg('Referrals');
  const full = { x0: 28, x1: 932, barX: 328, barW: 190, valueX: 580 };
  const ref = get(run, 'by_referrer');
  const referrers = ref.slice(0, 6);
  const end = svg.table({
    ...full,
    title: 'Referring sites',
    head: ['Referrer', 'Sessions'],
    extra: [{ label: 'Visitors', right: 690 }, { label: 'New', right: 800 }, { label: 'Bounce rate', right: 924 }],
    rows: referrers.map((r) => ({
      label: r.d0 || '(direct or campaign)',
      muted: !r.d0,
      raw: r.m0,
      value: n0(r.m0),
      extra: [n0(r.m1), n0(r.m2), pct(r.m3)]
    }))
  });
  svg.y = end + 10;
  const campaigns = get(run, 'by_campaign').slice(0, 5);
  const end2 = svg.table({
    ...full,
    title: 'Campaigns (utm_source / utm_medium / utm_campaign)',
    head: ['Source / medium / campaign', 'Sessions'],
    extra: [{ label: 'Visitors', right: 690 }, { label: 'Known people', right: 800 }, { label: 'Bounce rate', right: 924 }],
    rows: campaigns.map((r) => {
      const label = [r.d0, r.d1, r.d2].filter(Boolean).join(' / ');
      return { label: label || '(no utm tags)', muted: !label, raw: r.m0, value: n0(r.m0), extra: [n0(r.m1), n0(r.m2), pct(r.m3)] };
    })
  }, svg.y + 34);
  svg.y = end2 + 10;
  return svg.render();
}

function pagesImage(run) {
  const svg = new Svg('Pages and screens');
  const pages = get(run, 'top_views').slice(0, 10);
  const end = svg.table({
    x0: 28,
    x1: 932,
    barX: 358,
    barW: 330,
    valueX: 750,
    title: 'Top pages',
    head: ['Page', 'Views'],
    extra: [{ label: 'Entrances (landed here)', right: 924 }],
    rows: pages.map((r) => ({ label: r.d0, raw: r.m0, value: n0(r.m0), extra: [n0(r.m1)] }))
  });
  svg.y = end + 10;
  return svg.render();
}

function outboundImage(run) {
  const svg = new Svg('Outbound clicks');
  const hosts = get(run, 'top_hosts').slice(0, 6);
  const end = svg.table({
    x0: 28,
    x1: 932,
    barX: 358,
    barW: 330,
    valueX: 750,
    title: 'Destinations',
    head: ['Destination host', 'Clicks'],
    extra: [{ label: 'Share of clicks', right: 924 }],
    rows: (() => {
      const total = hosts.reduce((n, r) => n + num(r.m0), 0) || 1;
      return hosts.map((r) => ({ label: r.d0, raw: r.m0, value: n0(r.m0), extra: [pct(num(r.m0) / total)] }));
    })()
  });
  svg.y = end + 10;
  const byDay = get(run, 'by_day');
  svg.chart({ days: byDay.map((r) => dayLabel(r.d0)), bars: byDay.map((r) => num(r.m0)), barLabel: 'Clicks per day', barFmt: n0 });
  return svg.render();
}

function activityImage(run, custom) {
  const svg = new Svg('Known-person activity');
  const types = get(run, 'by_type');
  const end = svg.table({
    x0: 28,
    x1: 932,
    barX: 358,
    barW: 330,
    valueX: 750,
    title: 'Known-person activity, by entry type (timeline)',
    head: ['Entry type', 'Entries'],
    extra: [{ label: 'Distinct people', right: 924 }],
    rows: types.map((r) => ({ label: r.d0, raw: r.m0, value: n0(r.m0), extra: [n0(r.m1)] }))
  });
  svg.y = end + 10;
  svg.footnote(`video_upload: ${n0(custom.entries)} uploads by ${n0(custom.people)} people. The segment clause didCustomEntry { name: "video_upload" } lists them.`, { gap: 38 });
  return svg.render();
}

// --- main ------------------------------------------------------------------------

async function main() {
  const { worker } = await createGaugeWorker({
    settings: {
      streams: [STREAM],
      custom_entries: [{ name: 'video_upload', label: 'Uploaded a video', key: true, props: { size_mb: 'number' } }]
    }
  });
  try {
    const records = simulate();
    const byDay = new Map();
    for (const r of records) {
      const d = r.ts.slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(r);
    }
    for (const [d, list] of [...byDay].sort()) {
      await loadRecords(worker, list, { now: new Date(`${d}T23:59:59Z`) });
    }

    const runs = {};
    for (const key of ['traffic', 'sessions', 'referrals', 'pages', 'outbound', 'activity', 'custom_entries']) {
      runs[key] = await runReport(worker, key);
    }
    const custom = {
      entries: runs.custom_entries.data.by_name?.[0]?.m0 ?? 0,
      people: runs.custom_entries.data.by_name?.[0]?.m1 ?? 0
    };

    mkdirSync(OUT, { recursive: true });
    const images = {
      traffic: trafficImage(runs.traffic),
      sessions: sessionsImage(runs.sessions),
      referrals: referralsImage(runs.referrals),
      pages: pagesImage(runs.pages),
      outbound: outboundImage(runs.outbound),
      activity: activityImage(runs.activity, custom)
    };
    for (const [name, svg] of Object.entries(images)) writeFileSync(path.join(OUT, `${name}.svg`), svg);

    const t = runs.traffic.data;
    const s = runs.sessions.data;
    const summary = {
      records: records.length,
      traffic: { visitors: t.visitors, sessions: t.sessions, views: t.views, visitor_days: t.visitor_days, views_per_visitor_day: t.views_per_visitor_day, days: t.days, known_people: t.known_people },
      sessions: { bounce_rate: s.bounce_rate, views_per_session: s.views_per_session, avg_duration: s.avg_duration, browsers: s.by_browser.length },
      referrals: runs.referrals.data.by_campaign.slice(0, 5),
      pages_top: runs.pages.data.top_views.slice(0, 3),
      outbound: runs.outbound.data.top_hosts.slice(0, 3),
      activity: runs.activity.data.by_type,
      custom
    };
    console.log(`SAMPLE_SUMMARY ${JSON.stringify(summary, null, 1)}`);
  } finally {
    await worker.destroyAll();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
