import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGaugeWorker, rows } from './helpers.js';
import { createGaugeHandlers, queueLog, objectKey } from '../lib/cloudflare.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function fakeQueue({ fail = false } = {}) {
  const q = {
    sent: [],
    fail,
    async sendBatch(messages) {
      if (q.fail) throw new Error('queue unavailable');
      q.sent.push(...messages.map((m) => m.body));
    }
  };
  return q;
}

function collectRequest(hitId = 'hit-0000001', extra = {}) {
  return new Request('https://g.example.com/collect', {
    method: 'POST',
    headers: { 'user-agent': UA, origin: 'https://test.example.com', 'content-type': 'text/plain' },
    body: JSON.stringify({
      s: 'G-test',
      platform: 'web',
      sent_at: Date.now(),
      ctx: { host: 'test.example.com' },
      hits: [{ id: hitId, t: 'PAGE_VIEW', ts: Date.now(), url: 'https://test.example.com/pricing', ...extra }]
    })
  });
}

function batchOf(bodies) {
  const b = { messages: bodies.map((body) => ({ body })), acked: false, retried: false };
  b.ackAll = () => (b.acked = true);
  b.retryAll = () => (b.retried = true);
  return b;
}

test('the collector acknowledges only after the queue accepted the hit, and the consumer loads D1', async () => {
  const { worker } = await createGaugeWorker();
  try {
    const queue = fakeQueue();
    const env = { DB: {}, GAUGE_QUEUE: queue, SESSION_SECRET: 's' };
    const handlers = createGaugeHandlers({ makeWorker: () => worker });

    const res = await handlers.fetch(collectRequest(), env, {});
    assert.equal(res.status, 200);
    assert.equal(queue.sent.length, 1);
    assert.equal(queue.sent[0].entry_type, 'PAGE_VIEW');
    assert.equal((await rows(worker, 'select count(*) as n from gauge_session'))[0].n, 0, 'the request path never touches D1');

    const batch = batchOf(queue.sent);
    await handlers.queue(batch, env);
    assert.ok(batch.acked);
    assert.equal((await rows(worker, 'select count(*) as n from gauge_session'))[0].n, 1);

    // The same delivery again (a Queue retry) changes nothing the second time.
    const again = batchOf(queue.sent);
    await handlers.queue(again, env);
    assert.ok(again.acked);
    assert.equal((await rows(worker, 'select count(*) as n from gauge_session'))[0].n, 1);
  } finally {
    await worker.destroyAll();
  }
});

test('a queue failure answers 503 so the client retries with the same hit id', async () => {
  const { worker } = await createGaugeWorker();
  try {
    const queue = fakeQueue({ fail: true });
    const env = { DB: {}, GAUGE_QUEUE: queue };
    const handlers = createGaugeHandlers({ makeWorker: () => worker });
    const res = await handlers.fetch(collectRequest('hit-0000009'), env, {});
    assert.equal(res.status, 503);
    queue.fail = false;
    const retry = await handlers.fetch(collectRequest('hit-0000009'), env, {});
    assert.equal(retry.status, 200);
    assert.equal(queue.sent.length, 1);
  } finally {
    await worker.destroyAll();
  }
});

test('the consumer retries the whole batch when the database fails', async () => {
  const broken = {
    async query() {
      throw new Error('d1 down');
    }
  };
  const handlers = createGaugeHandlers({ makeWorker: () => broken });
  const env = { DB: {}, GAUGE_QUEUE: fakeQueue() };
  const batch = batchOf([{ kind: 'hit', hit_id: 'a', stream: 'G-test', device_id: 'dev00000001' }]);
  const originalError = console.error;
  console.error = () => {};
  try {
    await handlers.queue(batch, env);
  } finally {
    console.error = originalError;
  }
  assert.ok(batch.retried);
  assert.ok(!batch.acked);
});

test('without a database the collector still works from GAUGE_SETTINGS', async () => {
  const queue = fakeQueue();
  const env = {
    GAUGE_QUEUE: queue,
    GAUGE_SETTINGS: JSON.stringify({ streams: [{ id: 'G-test', type: 'web_stream', hosts: ['test.example.com'] }] })
  };
  const handlers = createGaugeHandlers({});
  const res = await handlers.fetch(collectRequest(), env, {});
  assert.equal(res.status, 200);
  assert.equal(queue.sent.length, 1);
});

test('an R2-only deployment writes one object per request batch', async () => {
  const puts = [];
  const bucket = {
    async put(key, body) {
      puts.push({ key, body });
    }
  };
  const env = {
    GAUGE_BUCKET: bucket,
    GAUGE_SETTINGS: JSON.stringify({ streams: [{ id: 'G-test', type: 'web_stream', hosts: ['test.example.com'] }] })
  };
  const res = await createGaugeHandlers({}).fetch(collectRequest(), env, {});
  assert.equal(res.status, 200);
  assert.equal(puts.length, 1);
  assert.match(puts[0].key, /^gauge\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/.+\.jsonl$/);
  assert.equal(JSON.parse(puts[0].body.trim()).entry_type, 'PAGE_VIEW');
});

test('queueLog splits large batches to the 100 message limit', async () => {
  const sizes = [];
  const log = queueLog({
    async sendBatch(m) {
      sizes.push(m.length);
    }
  });
  await log.append(Array.from({ length: 230 }, (_, i) => ({ i })));
  assert.deepEqual(sizes, [100, 100, 30]);
});

test('object keys follow the hourly layout in UTC', () => {
  assert.equal(objectKey(new Date('2026-10-21T09:05:00Z'), 'x'), 'gauge/2026/10/21/09/x.jsonl');
});

test('a deployment with no queue or bucket fails loudly', async () => {
  await assert.rejects(() => createGaugeHandlers({}).fetch(collectRequest(), {}, {}), /GAUGE_QUEUE or GAUGE_BUCKET/);
});

test('the cron retries email lookups without new records', async () => {
  const { worker } = await createGaugeWorker();
  try {
    const handlers = createGaugeHandlers({ makeWorker: () => worker });
    await handlers.scheduled({}, { DB: {}, GAUGE_QUEUE: fakeQueue() });
  } finally {
    await worker.destroyAll();
  }
});

test('GAUGE_BASE_PATH lets the Worker be routed under a path', async () => {
  const queue = fakeQueue();
  const env = {
    GAUGE_QUEUE: queue,
    GAUGE_BASE_PATH: '/g',
    GAUGE_SETTINGS: JSON.stringify({ streams: [{ id: 'G-test', type: 'web_stream', hosts: ['test.example.com'] }] })
  };
  const handlers = createGaugeHandlers({});
  const req = collectRequest();
  const routed = new Request('https://www.example.com/g/collect', { method: 'POST', headers: req.headers, body: await req.text() });
  assert.equal((await handlers.fetch(routed, env, {})).status, 200);
  assert.equal(queue.sent.length, 1);
});
