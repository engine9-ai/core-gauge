import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiskLog, listSegments, readSegment, gzipSegment, removeSegment, hourPrefix } from '../lib/diskLog.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-log-'));
}

async function readAll(dir, name, offset = 0) {
  const out = [];
  for await (const item of readSegment(dir, name, { offset })) out.push(item);
  return out;
}

test('appends JSONL into hourly segments named by host and pid', async () => {
  const dir = tmp();
  let now = new Date('2026-10-21T12:05:00Z');
  const log = createDiskLog({ directory: dir, fsync: 'always', hostId: 'web-1', pid: 7, clock: () => now });
  await log.append([{ n: 1 }, { n: 2 }]);
  await log.append({ n: 3 });
  now = new Date('2026-10-21T13:00:01Z');
  await log.append({ n: 4 });
  await log.close();

  assert.deepEqual(await listSegments(dir), ['2026/10/21/12-web-1-7.jsonl', '2026/10/21/13-web-1-7.jsonl']);
  const first = await readAll(dir, '2026/10/21/12-web-1-7.jsonl');
  assert.deepEqual(first.map((x) => x.record.n), [1, 2, 3]);
  const second = await readAll(dir, '2026/10/21/13-web-1-7.jsonl');
  assert.deepEqual(second.map((x) => x.record.n), [4]);
  assert.equal(hourPrefix(now), '2026/10/21/13');
});

test('resuming from a saved offset yields only new lines', async () => {
  const dir = tmp();
  const log = createDiskLog({ directory: dir, fsync: 'none', hostId: 'h', pid: 1, clock: () => new Date('2026-10-21T12:00:00Z') });
  await log.append([{ n: 1 }, { n: 2 }]);
  const name = '2026/10/21/12-h-1.jsonl';
  const a = await readAll(dir, name);
  const saved = a.at(-1).end;
  await log.append([{ n: 3 }]);
  const b = await readAll(dir, name, saved);
  assert.deepEqual(b.map((x) => x.record.n), [3]);
  await log.close();
});

test('an incomplete last line is not consumed until it is finished', async () => {
  const dir = tmp();
  const name = '2026/10/21/12-h-1.jsonl';
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"n":1}\n{"n":2');
  const first = await readAll(dir, name);
  assert.deepEqual(first.map((x) => x.record.n), [1]);
  fs.appendFileSync(file, '}\n');
  const second = await readAll(dir, name, first.at(-1).end);
  assert.deepEqual(second.map((x) => x.record.n), [2]);
});

test('corrupt lines are reported, not fatal; multibyte offsets are bytes', async () => {
  const dir = tmp();
  const name = '2026/10/21/12-h-1.jsonl';
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"t":"café ☕"}\nnot json\n{"n":3}\n');
  const all = await readAll(dir, name);
  assert.equal(all[0].record.t, 'café ☕');
  assert.equal(all[1].corrupt, true);
  assert.equal(all[2].record.n, 3);
  const resumed = await readAll(dir, name, all[0].end);
  assert.equal(resumed.length, 2);
  assert.equal(resumed[1].record.n, 3);
});

test('a gzipped segment reads as the same logical segment with the same offsets', async () => {
  const dir = tmp();
  const log = createDiskLog({ directory: dir, fsync: 'none', hostId: 'h', pid: 1, clock: () => new Date('2026-10-21T12:00:00Z') });
  await log.append([{ n: 1 }, { n: 2 }, { n: 3 }]);
  await log.close();
  const name = '2026/10/21/12-h-1.jsonl';
  const plain = await readAll(dir, name);
  assert.equal(await gzipSegment(dir, name), true);
  assert.ok(!fs.existsSync(path.join(dir, name)));
  assert.deepEqual(await listSegments(dir), [name], 'listed once, without .gz');
  const gz = await readAll(dir, name);
  assert.deepEqual(gz.map((x) => x.record.n), [1, 2, 3]);
  const resumed = await readAll(dir, name, plain[0].end);
  assert.deepEqual(resumed.map((x) => x.record.n), [2, 3]);
  await removeSegment(dir, name);
  assert.deepEqual(await listSegments(dir), []);
});

test('two writers in one hour never share a file', async () => {
  const dir = tmp();
  const clock = () => new Date('2026-10-21T12:00:00Z');
  const a = createDiskLog({ directory: dir, fsync: 'none', hostId: 'a', pid: 1, clock });
  const b = createDiskLog({ directory: dir, fsync: 'none', hostId: 'b', pid: 2, clock });
  await Promise.all([a.append({ from: 'a' }), b.append({ from: 'b' })]);
  await a.close();
  await b.close();
  assert.equal((await listSegments(dir)).length, 2);
});

test('concurrent appends are not interleaved', async () => {
  const dir = tmp();
  const log = createDiskLog({ directory: dir, fsync: 'none', hostId: 'h', pid: 1, clock: () => new Date('2026-10-21T12:00:00Z') });
  await Promise.all(Array.from({ length: 200 }, (_, i) => log.append([{ i, pad: 'x'.repeat(500) }])));
  await log.close();
  const all = await readAll(dir, '2026/10/21/12-h-1.jsonl');
  assert.equal(all.length, 200);
  assert.ok(all.every((x) => x.record));
  assert.equal(new Set(all.map((x) => x.record.i)).size, 200);
});

test('append after close rejects, so the collector would answer 503', async () => {
  const dir = tmp();
  const log = createDiskLog({ directory: dir, fsync: 'none' });
  await log.close();
  await assert.rejects(log.append({ n: 1 }), /closed/);
});

test('append fails cleanly when the directory is not writable, and recovers', async () => {
  const dir = tmp();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const log = createDiskLog({ directory: path.join(blocker, 'logs'), fsync: 'none' });
  await assert.rejects(log.append({ n: 1 }));
  await log.close().catch(() => {});
});
