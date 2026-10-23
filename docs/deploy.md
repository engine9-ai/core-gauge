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

Gauge needs the `person` and `timeline` schemas. `e9gauge install` installs
any of them the database lacks, then the plugin. A site set up with
`e9core setup` has the person schemas but not `timeline`; install adds it.
`--with-standard` (with `--db` only) installs the whole standard stack first,
for an empty database you want fully set up.

```
npm install @engine9/core @engine9/schemas @engine9/core-gauge
```

Gauge needs `@engine9/core` **1.13.1 or later** and `@engine9/schemas` **1.11.3 or later**.
`e9gauge install` and `e9gauge doctor` check the installed versions and stop
with the upgrade steps when one is older.

`package.json`:

```json
"engine9": { "pluginPackages": ["@engine9/schemas", "@engine9/core-gauge"] }
```

```
npx e9gauge install --db sqlite://./engine9.db          # installs person and timeline too, if missing
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

### Reload stats

The log is the record of truth. `reloadStats` forgets what the loader derived
(sessions, daily rollups, devices first seen) from a date forward, then loads
the log again from that date:

```
npx e9gauge reloadStats --db … --from 2026-10-01
```

Timeline and `gauge_entry` rows are keyed by hit id, so they are simply written
again. Hits logged after the date but stamped before it (a late retry) are
skipped, since their day was not reset. Run it after a loader bug fix, a changed
`session_timeout_minutes`, or a crash that left rollups counted twice.

## Cloudflare

The collector can be its own Worker beside the site, or live inside the site's
Worker under a path. Both share the site's D1 database.
`cloudflare/worker.js` and `cloudflare/wrangler.toml.example` are the starting
point for a sibling Worker; copy both. To mount it in the site Worker, see
[Inside the site's Worker](#inside-the-sites-worker).

```
npx wrangler queues create gauge-hits
npx wrangler r2 bucket create gauge-log         # optional archive of every record (needed for reloadStats)
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

`install`, `stream`, `custom`, `settings`, `set` and `reloadStats` accept
`--url` (the collector's base URL, including `GAUGE_BASE_PATH`) and `--key`.
They call `POST /admin/install`, `GET` / `POST /admin/settings` and
`POST /admin/reloadStats` on the Worker. These need a key with the `admin`
scope and exist only when the Worker passes `makeKeyStore`, for example
`(worker) => new SqlApiKeyStore({ worker })` from `@engine9/core/auth` (the
example Worker does). A `gauge:send` key cannot administer. The Worker
validates every setting before it stores it. `POST /admin/install` installs
`timeline` (and anything else gauge depends on) when the site lacks it.

Settings can also be carried in the `GAUGE_SETTINGS` variable; the collector
uses them until D1 answers and when there is no `DB` binding.

How it behaves:

- The collector answers from cached settings and never waits on D1. The first request after a cold start waits up to 1.5 seconds for settings, later ones refresh in the background (`GAUGE_REFRESH_MS`, default 60000).
- A hit is acknowledged only after the Queue accepted it (or, with no Queue, after the R2 object was written). A Queue failure answers 503 and the client retries with the same hit ids.
- The consumer writes each Queue message to R2 (if bound) as `gauge/YYYY/MM/DD/HH/<message id>.jsonl`, loads D1 with the same loader the Node deployment uses, then acknowledges. If anything fails it retries the batch. A retry writes the same keys again, so the archive holds each message once.
- Routing under a path: set `GAUGE_BASE_PATH` to the path (`/g`).
- The cron (`*/10`) retries email lookups for devices waiting on a person.
- R2 without a Queue is a collector-only setup: nothing loads D1.
- Without an R2 archive, the Queue is the only copy of each hit, and only until it is delivered. A Queue-only deployment cannot run `reloadStats`; the Worker answers 501. Bind `GAUGE_BUCKET` if you want to be able to rebuild counts.

Queues deliver at least once and not in order. Timeline and `gauge_entry` rows
are idempotent. The consumer sorts each batch by time, but a hit that arrives
more than `session_timeout_minutes` after a later hit for the same device forms
its own session. Rollup counters can double-count if a batch fails between the
database write and the acknowledgement. `reloadStats` from the R2 archive
rebuilds them.

### Reload stats on Cloudflare

```
npx e9gauge reloadStats --from 2026-10-01 --url https://www.example.com/g --dry-run
npx e9gauge reloadStats --from 2026-10-01 --url https://www.example.com/g
```

The first step resets sessions and rollups from the date and fixes the end
point at that moment. Objects archived later are the Queue consumer's to
load, so they are not counted twice. Each step then reads whole hours of
archive objects (`--batch`, default 20 objects, at most 200) and loads them.
The command repeats `POST /admin/reloadStats` with the returned cursor until it
is done, because one Worker request has limited CPU time and subrequests.
`--dry-run` only lists the archive and reports how many objects and bytes a
reload would read.

Cost: one R2 read per archived message, and the same D1 writes the loader made
the first time (sessions, rollups, devices). On Workers Free, D1's 100,000 rows
written a day is the limit that matters; reload a month in several runs on
different days if the site is busy. A reload does not touch the Queue.

The archive grows by one object per collector request. To keep it bounded, add
an R2 lifecycle rule that deletes objects under `gauge/` after the number of
days you want to be able to reload, for example 90:

```
npx wrangler r2 bucket lifecycle add gauge-log expire-gauge gauge/ --expire-days 90
```

### Queue messages and the free plan

Gauge uses only features that exist on the Workers Free plan (Worker, Queue, D1,
optional R2, one cron). Nothing here requires Workers Paid. The free limits are
what a small site has to stay inside.

Queues charge and limit by **message**, not by hit. A delivered message costs
three operations (write, read, delete) per 64 KB. Workers Free includes 10,000
operations a day, which is about 3,300 messages. If the collector sent one
message per hit, that would be about 3,300 hits a day; past that `sendBatch`
throws and the collector answers 503.

So the collector packs one request's records into one Queue message,
`{ v: 1, records: […] }`, as long as the JSON stays under about 60 KB (one
operation, under the 64 KB chunk and the 128 KB hard limit). A request that
does not fit is split. The consumer still accepts a single record as the
message body, so messages already in the Queue at deploy time still load.

The gain is modest. The browser client already coalesces hits for two seconds
(`flushMs`, up to `maxBatch` 20). A typical visit sends one to three hits per
request, so a small site gets roughly 1.5× to 3× more hits out of the same
10,000 operations, on the order of 5,000 to 10,000 hits a day before the Queue
limit. Combining hits across requests would need a Durable Object or an R2-plus-
cron design; that is a separate decision.

On Free, also keep `db_mode=rollups` (the default). `db_mode=entries` writes
every hit into D1 and burns the 100,000 rows-written/day limit much faster.
D1 on Free is 500 MB per database and 100,000 rows written a day, shared with
the rest of the site.

### Inside the site's Worker

A site that is already one Worker should mount the collector on that Worker,
not deploy a second one. Same hostname, `/g` path, shared D1, first-party
cookies. `createGaugeHandlers` is the same glue the sibling Worker uses:

```js
import { createGaugeHandlers } from '@engine9/core-gauge/cloudflare';
import { SqlApiKeyStore } from '@engine9/core/auth';

const gauge = createGaugeHandlers({
  makeWorker: (env) => new PersonWorker({ accountId: env.E9_ACCOUNT_ID || 'cloudflare', d1: env.DB, plugins }),
  makeKeyStore: (worker) => new SqlApiKeyStore({ worker })
});

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (path === '/g' || path.startsWith('/g/')) return gauge.fetch(request, env, ctx);
    return api.handleFetch(request, { basePath: '/api', ctx });
  },
  queue: (batch, env, ctx) => gauge.queue(batch, env, ctx),
  scheduled: (event, env, ctx) => gauge.scheduled(event, env, ctx)
};
```

Set `GAUGE_BASE_PATH` to `/g`. Bind `GAUGE_QUEUE` (producer and consumer) and
optionally `GAUGE_BUCKET` on this Worker, and put the cron on it. Add
`@engine9/core-gauge` to `engine9.pluginPackages` so `e9core build-plugins`
compiles the plugin into the same bundle. The page posts to `/g/collect`.

## Operating notes

What each `e9gauge` command is for, task by task:
[the README](../README.md#the-e9gauge-command).

- **Volume.** `timeline_mode=identified` (default) writes timeline entries only for known people and only the types in `timeline_entry_types`. `PAGE_VIEW` is deliberately not in that list. `db_mode=rollups` (default) keeps only devices, sessions and daily counts in the database; `entries` also keeps every hit in `gauge_entry`, which is large on D1. The log always has every hit.
- **Streams.** A request without `s` (the stream id field) answers 400, naming the field if it was sent as `stream`. An unknown stream id answers 404 and writes a bounded `unrouted` record so you can see misconfigured pages. Removing a stream refuses new hits; what was logged stays.
- **Hash-routed sites.** For a site that routes with `#/path` or `#!/path`, turn on `hash_routes` for its stream (`e9gauge stream update --id G-www --hash-routes on`) and pass `hashRoutes: true` to `createGauge`. Without the stream setting, the collector drops every fragment, `#/` included.
- **Upgrades.** Install the new `@engine9/core-gauge`, redeploy, then run `e9gauge install` again (with `--db`, or `--url` on Cloudflare). Install diffs and deploys the schema, so additive tables and columns arrive, and it keeps the settings you changed. A release that removes or renames a column will say so in its notes. Entry type ids never change. Gauge 1.2 renames the report that shows where visits came from to `@engine9/core-gauge/gauge:reports:referrals`. Plugin paths match exactly and there is no alias, so a saved dashboard that holds the report's earlier path (the one ending in the old name) must be pointed at the new one; nothing in the database changes. Gauge 1.1 adds `gauge_session.browser` and the `gauge_outbound_day` table; until `install` runs, the loader skips them and keeps loading everything else. To fill them for past days, run `reloadStats --from` the first day you want.
- **Erasure.** `erasePeople` (core; `POST /api/admin/erase` on a deployed site) removes a person from every gauge table. `e9gauge erase-logs --person-id N` removes them from closed log segments and fixes the loader's checkpoint; the current hour is skipped unless you stop the collector and pass `--include-open`.
- **Limits.** 32 KB per request body, 50 hits per request, 600 requests per minute per client, hit timestamps corrected for client clock skew and clamped to the last seven days.
