/*
  docs/settings.md is generated from gauge/settings.js so it cannot drift:

    node -e "import('@engine9/core-gauge/settingsDocs').then(m => process.stdout.write(m.settingsMarkdown()))" > docs/settings.md

  test/docs.test.js fails when the committed file is out of date.
*/
import { settings } from '../gauge/settings.js';

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function settingsMarkdown() {
  const sections = [];
  for (const s of settings) {
    if (s.hidden) continue;
    const name = s.section || 'Other';
    let sec = sections.find((x) => x.name === name);
    if (!sec) sections.push((sec = { name, items: [] }));
    sec.items.push(s);
  }
  const lines = [
    '# Gauge settings',
    '',
    'Generated from `gauge/settings.js`. Edit them like any plugin setting: `e9gauge settings`, `e9gauge set <setting> <value>`, MCP `plugin` settings, or the console.',
    'Booleans are the strings `true` and `false`. Secrets (`SESSION_SECRET`, `GAUGE_SALT`) are environment variables, never settings.',
    ''
  ];
  for (const sec of sections) {
    lines.push(`## ${sec.name}`, '', '| Setting | Default | |', '| --- | --- | --- |');
    for (const s of sec.items) {
      const def = s.default === '' || s.default === undefined ? '(empty)' : `\`${cell(s.default)}\``;
      const values = s.values ? ` One of: ${s.values.map((v) => `\`${v}\``).join(', ')}.` : '';
      lines.push(`| \`${s.name}\` | ${def} | ${cell(s.description)}${values} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}`;
}

export default { settingsMarkdown };
