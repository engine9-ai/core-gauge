import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { eraseFromLog } from '../lib/erase.js';
import { readSegment } from '../lib/diskLog.js';

const NOW = new Date('2026-10-21T12:30:00Z');
const line = (o) => `${JSON.stringify(o)}\n`;

function setup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-erase-'));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (name.endsWith('.gz')) fs.writeFileSync(file, zlib.gzipSync(text));
    else fs.writeFileSync(file, text);
  }
  return dir;
}

async function read(dir, logical, offset = 0) {
  const out = [];
  for await (const item of readSegment(dir, logical, { offset })) if (item.record) out.push(item.record);
  return out;
}

test('removes a person from closed segments, plain and gzipped, and leaves everyone else', async () => {
  const dir = setup({
    '2026/10/21/09-h-1.jsonl': line({ hit_id: 'a', person_id: 7 }) + line({ hit_id: 'b', person_id: 8 }) + line({ hit_id: 'c' }),
    '2026/10/20/09-h-1.jsonl.gz': line({ hit_id: 'd', person_id: 7 }) + line({ hit_id: 'e' }),
    '2026/10/21/10-h-1.jsonl': line({ kind: 'identify', hit_id: 'f', person_id: 7, device_id: 'dev00000001' })
  });
  const r = await eraseFromLog(dir, { personId: 7, now: NOW });
  assert.equal(r.removed, 3);
  assert.equal(r.segments, 3);
  assert.deepEqual((await read(dir, '2026/10/21/09-h-1.jsonl')).map((x) => x.hit_id), ['b', 'c']);
  assert.deepEqual((await read(dir, '2026/10/20/09-h-1.jsonl')).map((x) => x.hit_id), ['e']);
  assert.deepEqual(await read(dir, '2026/10/21/10-h-1.jsonl'), []);
});

test('the current hour is skipped unless includeOpen; a running collector holds it open', async () => {
  const dir = setup({ '2026/10/21/12-h-1.jsonl': line({ hit_id: 'a', person_id: 7 }) });
  const skipped = await eraseFromLog(dir, { personId: 7, now: NOW });
  assert.deepEqual(skipped.skipped, ['2026/10/21/12-h-1.jsonl']);
  assert.equal(skipped.removed, 0);
  assert.equal((await read(dir, '2026/10/21/12-h-1.jsonl')).length, 1);
  const forced = await eraseFromLog(dir, { personId: 7, now: NOW, includeOpen: true });
  assert.equal(forced.removed, 1);
});

test('checkpoint offsets move with the rewrite so the loader resumes at the same record', async () => {
  const logical = '2026/10/21/11-h-1.jsonl';
  const first = line({ hit_id: 'a', person_id: 7 });
  const second = line({ hit_id: 'b' });
  const third = line({ hit_id: 'c' });
  const dir = setup({ [logical]: first + second + third });
  const oldOffset = Buffer.byteLength(first + second); // loader had read a and b
  const r = await eraseFromLog(dir, { personId: 7, now: NOW, offsets: { [logical]: oldOffset } });
  assert.equal(r.offsets[logical], Buffer.byteLength(second));
  assert.deepEqual((await read(dir, logical, r.offsets[logical])).map((x) => x.hit_id), ['c']);
});

test('matches a server-sent email hash', async () => {
  const hash = 'a'.repeat(64);
  const dir = setup({ '2026/10/21/09-h-1.jsonl': line({ hit_id: 'a', email_hash_v1: hash }) + line({ hit_id: 'b', email_hash_v1: 'b'.repeat(64) }) });
  const r = await eraseFromLog(dir, { emailHash: hash, now: NOW });
  assert.equal(r.removed, 1);
});

test('keeps partial and corrupt lines, and refuses an empty request', async () => {
  const dir = setup({ '2026/10/21/09-h-1.jsonl': `not json\n${line({ hit_id: 'a', person_id: 7 })}${JSON.stringify({ hit_id: 'half' })}` });
  await eraseFromLog(dir, { personId: 7, now: NOW });
  const text = fs.readFileSync(path.join(dir, '2026/10/21/09-h-1.jsonl'), 'utf8');
  assert.equal(text, `not json\n${JSON.stringify({ hit_id: 'half' })}`);
  await assert.rejects(() => eraseFromLog(dir, {}), /personId or an emailHash/);
  await assert.rejects(() => eraseFromLog(dir, { personId: -1 }), /positive integer/);
});
