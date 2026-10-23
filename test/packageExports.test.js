import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportTarget } from '@engine9/core/plugins/build';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('package.json exports every specifier e9core build-plugins may import', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./gauge/*'], './gauge/*');
  for (const sub of ['./gauge', './gauge/index.js', './gauge/schema.js', './gauge/settings.js']) {
    const target = exportTarget(pkg.exports, sub);
    assert.ok(target, `${sub} must be in package.json exports`);
    assert.ok(existsSync(path.join(ROOT, target)), `${sub} -> ${target}`);
  }
});
