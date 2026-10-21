import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGaugeWorker, rows } from './helpers.js';
import { startGauge } from '../lib/node.js';
import { listSegments, readSegment } from '../lib/diskLog.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const quiet = () => {};

async function post(gauge, body, headers = {}) {
  return fetch(`${gauge.url}/collect`, {
    method: 'POST',
    headers: { 'user-agent': UA, origin: 'https://test.example.com', 'content-type': 'text/plain', ...headers },
    body: JSON.stringify(body)
  });
}

const page = (id, p = '/') => ({
  s: 'G-test',
  platform: 'web',
  sent_at: Date.now(),
  ctx: { host: 'test.example.com' },
  hits: [{ id, t: 'PAGE_VIEW', ts: Date.now(), url: `https://test.example.com${p}` }]
});

async function logged(dir) {
  const out = [];
  for (const seg of await listSegments(dir)) for await (const item of readSegment(dir, seg)) if (item.record) out.push(item.record);
  return out;
}

test('collector-only: a hit is on disk before the answer, with a device cookie', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-node-'));
  const gauge = await startGauge({
    port: 0,
    logDirectory: dir,
    settings: { streams: [{ id: 'G-test', type: 'web_stream', hosts: ['test.example.com'] }] },
    env: {},
    logger: quiet
  });
  try {
    const res = await post(gauge, page('hit-0000001', '/pricing'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie') || '', /e9_did=/);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://test.example.com');
    const records = await logged(dir);
    assert.equal(records.length, 1, 'the log has it by the time the answer arrives');
    assert.equal(records[0].path, '/pricing');

    const ok = await fetch(`${gauge.url}/ok`);
    assert.equal(ok.status, 200);

    const big = await fetch(`${gauge.url}/collect`, { method: 'POST', body: 'x'.repeat(200 * 1024) });
    assert.equal(big.status, 413);
    await assert.rejects(() => gauge.load(), /collector-only/);
  } finally {
    await gauge.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with a database: collect, then load on demand; stop is clean', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-node-'));
  const { worker } = await createGaugeWorker();
  const gauge = await startGauge({ worker, port: 0, logDirectory: dir, loadIntervalSeconds: 0, env: {}, logger: quiet });
  try {
    const first = await post(gauge, page('hit-0000001', '/'));
    const cookie = (first.headers.get('set-cookie') || '').split(';')[0]; // the same browser comes back
    await post(gauge, page('hit-0000002', '/about'), { cookie });
    const result = await gauge.load();
    assert.equal(result.records, 2);
    assert.equal((await rows(worker, 'select count(*) as n from gauge_session'))[0].n, 1);
    assert.ok(gauge.lastLoad().at);
    const again = await gauge.load();
    assert.equal(again.records, 0, 'nothing is read twice');
  } finally {
    await gauge.stop();
    await worker.destroyAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a log directory that cannot be written answers 503, not 200', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-node-'));
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  const gauge = await startGauge({
    port: 0,
    logDirectory: path.join(blocker, 'logs'), // a path under a regular file
    settings: { streams: [{ id: 'G-test', type: 'web_stream', hosts: ['test.example.com'] }] },
    env: {},
    logger: quiet
  });
  try {
    const res = await post(gauge, page('hit-0000001'));
    assert.equal(res.status, 503);
  } finally {
    await gauge.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
