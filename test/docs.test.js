import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { settingsMarkdown } from '../lib/settingsDocs.js';

test('docs/settings.md matches gauge/settings.js (regenerate it, see lib/settingsDocs.js)', () => {
  const committed = readFileSync(new URL('../docs/settings.md', import.meta.url), 'utf8');
  assert.equal(committed, settingsMarkdown());
});
