# The gauge protocol (v1)

What a browser, an app SDK or a server sends, and the record the collector
writes for each hit. Anyone can write a client for another platform from this
page. `client/gauge.js` is the reference client; `lib/protocol.js` is the
reference implementation.

## Requests

All bodies are JSON. `POST /collect` may use `Content-Type: text/plain`, so a
browser skips the CORS preflight; the body is still JSON.

| Route | Who | Auth |
| --- | --- | --- |
| `POST /collect` | browser or app | none. A device cookie, and a Core Session if one is sent |
| `GET /collect.gif` | `<noscript>` pixel, email | none. One hit from the query string: `s` (stream), `t` (type, default `PAGE_VIEW`), `url`, `r` (referrer), `title`, `name`, `host`, `consent=0` |
| `POST /send` | a server | a key with scope `gauge:send` |
| `POST /identify` | a server | a key with scope `gauge:send` |
| `GET /ok` | health | none. `{ ok, collecting, streams, stats }` |

```json
{
  "v": 1,
  "s": "G-www",
  "sent_at": 1730000000000,
  "platform": "web",
  "device_id": "optional, apps; web falls back to it when there is no cookie",
  "consent": true,
  "ctx": { "host": "www.example.com", "title": "Pricing", "referrer": "", "app_version": "", "os": "", "os_version": "", "device_model": "", "screen_name": "" },
  "hits": [
    {
      "id": "0192f6c0-7f3a-7d1a-9a43-5a4f2f6a1c11",
      "t": "PAGE_VIEW",
      "ts": 1730000000000,
      "url": "https://www.example.com/pricing?utm_source=news",
      "name": "video_upload",
      "value": 40,
      "props": { "size_mb": 40 }
    }
  ]
}
```

- `s` is the stream id (also accepted as `?s=`). An unknown stream answers 404.
- `hits[].id` makes retries harmless: the same id is the same entry. Use a UUIDv7. Ids are 1 to 64 characters of `A-Za-z0-9_.:-`; a hit without one gets one from the collector (and then cannot be retried safely).
- `t` is an entry type name or id. A hit with a `name` and no `t` is a `CUSTOM_ENTRY`.
- `ts` is the client clock in milliseconds. The collector corrects it by `received_at - sent_at`, never lets it be in the future, and replaces it with the receive time when it is more than seven days old.
- `consent: false` asks for cookieless counting. `Sec-GPC: 1` is honoured the same way when `respect_gpc` is true.
- `platform` is `web`, `ios`, `android`, `desktop` or `server`.

Limits: 32 KB per body (413), 50 hits per request (413), 600 requests per minute per client (429).

## Answers

| Status | Meaning | The client should |
| --- | --- | --- |
| `200` with `{ "ok": true, "accepted": n, "device_id": "…" }` | the hits are in the log (some may have been dropped: bots, sampling, rejected types) | remove the batch from its queue. Keep `device_id` for apps |
| `204` | the collector is switched off (`collect_enabled=false`) | drop the batch |
| `400`, `403`, `404`, `413` | the request is malformed, the origin is not allowed for the stream (`403`), or the stream is unknown | drop the batch; retrying cannot help |
| `429` (`Retry-After: 60`), `503` (`Retry-After: 5`) | rate limited, or the log could not be written | keep the batch and retry later with the same ids |
| `401`, `501` (`/send`, `/identify` only) | the key is missing, wrong or lacks `gauge:send`; or the collector has no key store | fix the configuration; do not retry blindly |

A `200` for a hit the collector chose not to record is deliberate: a
well-behaved client must not retry something that will never be accepted.

## Rules the collector enforces

- A browser never says who a person is. `person_id` in a browser body is ignored. A person comes from a verified Core Session (cookie `session` or header `X-Engine9-Session`), or from a server call with a key.
- `SESSION_START` and `FIRST_VISIT` are rejected from clients; the loader derives them.
- Money types (`TRANSACTION`, `TRANSACTION_ONE_TIME`, and the other `TRANSACTION_*`) need a server key.
- An `IDENTIFY` hit from a browser becomes a device-to-person link only when the request carries a valid Core Session.
- URLs are cut to the query allowlist, plus `utm_*` and the `source_code_params`; any value that looks like an email address is removed. `props` are filtered as described in [custom-entries.md](custom-entries.md).
- A server key may add `person_id` or `email` to a hit. The email is hashed (`email_hash_v1`, sha256 of the lowercased address) and the address is never logged.

## `POST /send`

Same body as `/collect`, with `Authorization: Bearer e9key_…` (or `X-Api-Key`).
`platform` is typically `server`. Hits may carry `person_id` and `email`.

## `POST /identify`

```json
{ "v": 1, "s": "G-www", "device_id": "…", "person_id": 12 }
```

`person_id` or `email` (or a precomputed `email_hash_v1`) is required. It writes
a device-to-person link; the loader attaches the device's earlier anonymous hits
to the person within `backfill_days`, stopping at a `LOGOUT`.

## The log record

One JSON line per hit, written before the answer. `kind` is `hit`, `identify`
or `unrouted` (a request for an unknown stream; a bounded number are
logged so a misconfigured page is visible).

```json
{"v":1,"kind":"hit","hit_id":"…","received_at":"2026-10-21T12:00:00.000Z","ts":"2026-10-21T11:59:59.000Z","stream":"G-www","input_type":"web_stream","entry_type_id":102,"entry_type":"PAGE_VIEW","platform":"web","device_id":"…","device_source":"cookie","person_id":12,"person_source":"core_session","consent":true,"host":"www.example.com","path":"/pricing","query":"plan=pro","referrer_host":"news.example.org","utm_source":"news","country":"US","device_class":"desktop"}
```

Fields that are empty are omitted. `person_source` is `core_session` or `server`.
`ip` appears only with `ip_mode=truncate`. The loader reads this format; a
second collector implementation that writes it is a valid collector.
