/*
  Server-side sends to a gauge collector, with an engine9 key that has the
  `gauge:send` scope (the GA4 Measurement Protocol idea). A server can send
  what a browser may not: TRANSACTION entries, and a person it already knows.

    import { createGaugeServer } from '@engine9/core-gauge/server';
    const gauge = createGaugeServer({ endpoint: 'https://g.example.com', stream: 'G-server', key: process.env.GAUGE_KEY });
    await gauge.send([{ t: 'LOGIN', person_id: 12 }]);
    await gauge.identify({ device_id, email });   // email is hashed by the collector; it is never logged
*/
import { randomUUID } from 'node:crypto';

export function createGaugeServer({ endpoint, stream, key, fetch: doFetch = globalThis.fetch } = {}) {
  if (!endpoint || !stream || !key) throw new Error('createGaugeServer requires endpoint, stream and key');
  const base = String(endpoint).replace(/\/+$/, '');
  async function post(path, body) {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    if (res.status >= 500 || res.status === 429) {
      const e = new Error(`gauge collector ${res.status}`);
      e.retryable = true;
      throw e;
    }
    return { status: res.status, ...(json || {}) };
  }
  return {
    /** hits: [{ t | name, ts?, person_id?, email?, value?, props?, id? }] */
    send(hits) {
      return post('/send', {
        v: 1,
        s: stream,
        platform: 'server',
        sent_at: Date.now(),
        hits: hits.map((h) => ({ id: randomUUID(), ts: Date.now(), ...h }))
      });
    },
    identify({ device_id, person_id, email }) {
      return post('/identify', { v: 1, s: stream, device_id, person_id, email });
    }
  };
}

export default { createGaugeServer };
