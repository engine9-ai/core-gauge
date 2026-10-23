import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Built from pieces so this file does not contain the word it forbids.
const WORD = new RegExp(['acqui', 'sition'].join(''), 'i');
const SKIP = new Set(['node_modules', '.git', 'gauge-logs']);
const TEXT = /\.(js|json|md|svg|toml|example|txt)$/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else yield full;
  }
}

test('gauge uses plain vocabulary: the domain-specific marketing term is not in the package', () => {
  const found = [];
  for (const file of files(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (WORD.test(rel)) found.push(rel);
    if (rel === 'package-lock.json' || !TEXT.test(file)) continue;
    if (WORD.test(readFileSync(file, 'utf8'))) found.push(rel);
  }
  assert.deepEqual(found, [], 'name the report "referrals" (where visits came from); see AGENTS.md');
});
