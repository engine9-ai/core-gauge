# Deploying gauge

Gauge is a sibling deployment. The collector is its own small HTTP service,
separate from your site and from core's API, so it keeps answering when the
database is down and costs little in front of every page view.

Both deployments do the same three jobs: collect, keep a durable log, load the
database. They differ in what the log is.

| | Node | Cloudflare |
| --- | --- | --- |
| Collector | `e9gauge serve` | Worker `fetch` (`@engine9/core-gauge/cloudflare`) |
| Durable log | hourly JSONL files on disk | a Queue, plus an optional R2 archive |
| Loader | interval inside `serve`, or `e9gauge load` | Worker `queue` consumer, plus a cron |
| Database | SQLite or MySQL | D1 |

## Before either: install into the database

Gauge needs the `person` and `timeline` schemas. On a database that already has
engine9, install the plugin; on a new one add `--with-standard`.

```
npm install @engine9/core @engine9/schemas @engine9/core-gauge
```

`package.json`:

```json
"engine9": { "pluginPackages": ["@engine9/schemas", "@engine9/core-gauge"] }
```

```
npx e9gauge install --db sqlite://./engine9.db          # add --with-standard on a new database
npx e9gauge stream add --id G-www --name www.example.com --hosts www.example.com
npx e9gauge doctor --db sqlite://./engine9.db
```

`--db`, or `ENGINE9_DATABASE_CONNECTION`, also read from `./.env`, is the same
connection `e9core` uses. On an engine9 server account install the plugin path
`@engine9/core-gauge/gauge` with the server's `plugin` install.

Two secrets are environment variables, never settings:

| Variable | Why |
| --- | --- |
| `SESSION_SECRET` | The value the site uses for Core Sessions. Without it no hit is linked to a person from a login. A comma list accepts rotating secrets |
| `GAUGE_SALT` | Any long random string. Cookieless visitor ids are derived from it; without it they change on every restart |

## Where the collector lives

Serve it on the site's own hostname under a path, such as `/g`. Then the device
cookie is first-party and the Core Session cookie reaches it. A collector on a
different hostname needs the Core Session cookie's `Domain` to cover it, and its
origin must be in the stream's `hosts` (the collector answers credentialed CORS
only for listed origins).

## Node

```
npx e9gauge serve --db sqlite://./engine9.db --port 8788 --trust-proxy
```

nginx, with the trailing slash so `/g/` is stripped:

```
location /g/ { proxy_pass http://127.0.0.1:8788/; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header X-Forwarded-For $remote_addr; }
```

`--trust-proxy` makes the collector believe `X-Forwarded-Proto` and
`X-Forwarded-For`; use it only behind a proxy you control.

- The log is `<log_directory>/YYYY/MM/DD/HH-<host>-<pid>.jsonl`, one writer per file, so several collectors can share a directory.
- A hit is appended before the answer (`fsync`: `interval` by default; a power loss can lose about a second of acknowledged hits, a process crash loses none; `always` waits for every append).
- `--interval 30` loads every 30 seconds. `--interval 0` turns the loader off.
- Without `--db`, give `--config gauge.config.json` (the same settings as JSON). The process is collector-only; run `e9gauge load --db …` wherever the log and the database both are.
- Closed segments are gzipped after they are loaded and deleted after `log_retention_days`.

Check on it:

```
npx e9gauge doctor --db …          # backlog, secrets, streams, log directory
npx e9gauge tail --follow          # live hits
curl http://127.0.0.1:8788/ok
```

### Replay

The log is the record of truth. To rebuild what the loader derived (sessions,
daily rollups, devices) from a date forward:

```
npx e9gauge replay --db … --from 2026-10-01
```

Timeline and `gauge_entry` rows are keyed by hit id, so they are simply written
again. Do this after a loader bug fix or a changed `session_timeout_minutes`.

## Cloudflare

Deploy gauge as its own Worker beside the site, sharing the site's D1 database.
`cloudflare/worker.js` and `cloudflare/wrangler.toml.example` are the starting
point; copy both.

```
npx wrangler queues create gauge-hits
npx wrangler r2 bucket create gauge-log         # optional archive of every record
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GAUGE_SALT
npx wrangler deploy
```

A Node process cannot open D1, so setup runs inside the Worker, the same way
core's `e9core upgrade --url` does. Add `@engine9/core-gauge` to
`engine9.pluginPackages` (so `e9core build-plugins` compiles it into the
bundle), deploy, then use the site's admin key (`E9_ADMIN_API_KEY`, which
`e9core setup` writes to `.env`):

```
export E9_ADMIN_API_KEY=e9key_…
npx e9gauge install --url https://www.example.com/g
npx e9gauge stream add --id G-www --name www.example.com --hosts www.example.com --url https://www.example.com/g
npx e9gauge custom add --name video_upload --url https://www.example.com/g
npx e9gauge settings --url https://www.example.com/g
```

`install`, `stream`, `custom`, `settings` and `set` accept `--url` (the
collector's base URL, including `GAUGE_BASE_PATH`) and `--key`. They call
`POST /admin/install` and `GET` / `POST /admin/settings` on the Worker, which need a
key with the `admin` scope and exist only when the Worker passes
`makeKeyStore` (the example does). A `gauge:send` key cannot administer. The
Worker validates every setting before it stores it.

Settings can also be carried in the `GAUGE_SETTINGS` variable; the collector
uses them until D1 answers and when there is no `DB` binding.

How it behaves:

- The collector answers from cached settings and never waits on D1. The first request after a cold start waits up to 1.5 seconds for settings, later ones refresh in the background (`GAUGE_REFRESH_MS`, default 60000).
- A hit is acknowledged only after the Queue accepted it (or, with no Queue, after the R2 object was written). A Queue failure answers 503 and the client retries with the same hit ids.
- The consumer writes the batch to R2 (if bound) and then loads D1 with the same loader the Node deployment uses, then acknowledges. If anything fails it retries the batch.
- Routing under a path: set `GAUGE_BASE_PATH` to the path (`/g`).
- The cron (`*/10`) retries email lookups for devices waiting on a person.
- R2 without a Queue is a collector-only setup: nothing loads D1.

Queues deliver at least once and not in order. Timeline and `gauge_entry` rows
are idempotent. The consumer sorts each batch by time, but a hit that arrives
more than `session_timeout_minutes` after a later hit for the same device forms
its own session. Rollup counters can double-count if a batch fails between the
database write and the acknowledgement. `e9gauge replay` from the R2 archive
rebuilds them.

## Operating notes

What each `e9gauge` command is for, task by task:
[the README](../README.md#the-e9gauge-command).

- **Volume.** `timeline_mode=identified` (default) writes timeline entries only for known people and only the types in `timeline_entry_types`. `PAGE_VIEW` is deliberately not in that list. `db_mode=rollups` (default) keeps only devices, sessions and daily counts in the database; `entries` also keeps every hit in `gauge_entry`, which is large on D1. The log always has every hit.
- **Streams.** An unknown stream id answers 404 and writes a bounded `unrouted` record so you can see misconfigured pages. Removing a stream refuses new hits; what was logged stays.
- **Upgrades.** Install the new `@engine9/core-gauge`, redeploy, then run `e9gauge install` again (with `--db`, or `--url` on Cloudflare). Install diffs and deploys the schema, so additive tables and columns arrive, and it keeps the settings you changed. A release that removes or renames a column will say so in its notes. Entry type ids never change.
- **Erasure.** `erasePeople` (core; `POST /api/admin/erase` on a deployed site) removes a person from every gauge table. `e9gauge erase-logs --person-id N` removes them from closed log segments and fixes the loader's checkpoint; the current hour is skipped unless you stop the collector and pass `--include-open`.
- **Limits.** 32 KB per request body, 50 hits per request, 600 requests per minute per client, hit timestamps corrected for client clock skew and clamped to the last seven days.
