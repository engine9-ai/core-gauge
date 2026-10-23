# Agent guide: `@engine9/core-gauge`

## License

`@engine9/core-gauge` is MIT licensed. See [LICENSE](LICENSE). Use, copy,
modify, and distribute this code as-is. No further permission is required.

`@engine9/core`, `@engine9/schemas`, `@engine9/id`, `demo-festival`, and
`demo-id` are also MIT. The private repositories `delegate` and `server` are not
open source. Do not copy code from those repositories into this one. Reports
here are checked against the server's report compiler by hand, never by
importing it.

## What this is

Measurement for engine9 core: web and app activity as timeline entries, tied to
`person_id` when the person is known. The word is **gauge** (GA4's measurement
half). It is not analytics: no modeling, no attribution. Read
[README.md](README.md) first.

- `@engine9/core` is a required sibling. **core never imports gauge**, and gauge
  must not be required to deploy core. Do not add a gauge import, a gauge table
  or a gauge entry type to core, schemas, or the setup wizard.
- It is a plugin package. Core discovers plugins as `index.js` directories and
  `*.plugin.js` files inside packages listed in `package.json`
  `engine9.pluginPackages`. `gauge/index.js` is therefore the **only**
  `index.js` in this package, and there are no `*.plugin.js` files. Everything
  else (`lib/`, `client/`, `bin/`) is reached through `package.json` `exports`.
  Do not add another `index.js` directory. `exports` must include `./gauge`
  and `./gauge/*`: `e9core build-plugins` imports
  `@engine9/core-gauge/gauge/index.js`, `schema.js` and `settings.js` when those
  paths are exported (core 1.13+ can fall back to `./gauge` alone).
- The plugin path is `@engine9/core-gauge/gauge`. Plugin paths match exactly: no
  alias spellings.

## Rules that are easy to break

**Entry type ids never change.** `entry_type_id` is a global enum shared by every
plugin. Gauge owns 100 to 129 in [lib/entryTypes.js](lib/entryTypes.js), mirrored
in `@engine9/input-tools` `timelineTypes.js`. Add a new type with the next free
id; never renumber or reuse. `test/entryTypes.test.js` pins every id and checks
the sibling `input-tools` checkout. Custom entries are `CUSTOM_ENTRY` (129) plus
a name, never a new integer. Names have no platform prefix; platform is a
column.

**Never trust the client for who a person is.** `person_id` comes only from a
verified Core Session or a server key. A browser body that carries `person_id`
or `email` is ignored (`lib/protocol.js`, `lib/collector.js`). Money types
(`TRANSACTION*`) are server-only. `SESSION_START` and `FIRST_VISIT` are derived
by the loader and rejected from clients.

**The collector never touches the database while handling a request.** It
answers from a cached settings source and appends to the log (disk, Queue, or
R2) before it answers. If the append fails it answers 503, so the client retries
with the same hit ids. Do not add a per-request query. The one exception is the
cached (60 s) server-key check for `/send` and `/identify`.

**The log is the record of truth, and loading is at least once.** Timeline and
`gauge_entry` rows are keyed by hit id and idempotent. Rollup counters can
double-count after a crash between the database write and the checkpoint;
`e9gauge reloadStats` is the fix (there is no `replay` command or alias), and
`resetFrom` must keep rebuilding exactly what the loader derives. A change to
what the loader derives needs a matching change to `resetFrom`. A reload loads
only hits stamped on or after its date (`recordsOnOrAfter`). On Cloudflare,
reloadStats reads the R2 archive (`POST /admin/reloadStats`, one step per
request); a Queue-only deployment cannot rebuild. The archive is one object per
Queue message, keyed by message id, so a retried delivery overwrites instead of
adding a copy. Keep it that way.

**Fragments are dropped unless the stream says otherwise.** A `#/` route is
kept only for a stream with `hash_routes: true`. The client's `hashRoutes`
option alone does not store fragments.

**One Queue message per request, not per hit.** Queues charge and limit by
message (three operations per 64 KB). Workers Free is 10,000 operations/day.
`queueLog` packs a request's records into `{ v: 1, records }` under 60 KB so
the cost is per collector request. Do not send one message per hit. Combining
hits across requests would need a Durable Object or R2-plus-cron and is a
separate product decision. The consumer must keep accepting a single-record
body so messages already in the Queue still load.

**Tables are fixed and carry `person_id`.** Table names start with `gauge_`,
with no hex prefix (see core's AGENTS.md on table naming). Every table that
involves a person uses a column named `person_id`, so core's `erasePeople`
covers it with no list to update. `test/plugin.test.js` proves it. A new table
that holds a person must do the same, and must be added to that test.

**New columns and tables are optional to the loader until install runs.** On
Cloudflare new code loads Queue batches before anyone runs
`e9gauge install --url`, and a failed write retries the batch, which
double-counts the other rollups. A column or table added after a release goes
through `schemaFeatures` in `lib/loader.js` and is skipped while missing.

**No database triggers.** See core's AGENTS.md. This package adds none.

**Reports divide nothing.** EQL turns `1.0` into the integer `1`, and SQLite and
D1 truncate integer division, so a ratio of a 0/1 column is `avg(column)`. The
reports test fails on `/`.

**Plain vocabulary.** Do not use the word that marketing tools use for where
visits came from, in code, reports, docs, images or file names. It is domain
specific and engine9 core does not use it. The report is **Referrals**
(`referrals`). `test/vocabulary.test.js` fails if the word returns.

**Two different "sessions".** Prose says "gauge session" for a run of activity
(`gauge_session`, ended by `session_timeout_minutes`) and "Core Session" for the
login token (`verifySessionToken`, `SESSION_SECRET`). Never write bare "session"
where both could be meant. Code keeps `gauge_session` and `session` (the Core
Session cookie) distinct.

**Privacy defaults stay on.** Query allowlist, email-looking values dropped, no
IP, bot filter, GPC honoured. A change that stores more by default is a
product decision, not a refactor.

## Settings and docs

Settings live in [gauge/settings.js](gauge/settings.js) and are stored by core's
plugin settings. Secrets (`SESSION_SECRET`, `GAUGE_SALT`) are environment
variables, never settings. `docs/settings.md` is generated; after editing
settings regenerate it:

```
node -e "import('./lib/settingsDocs.js').then(m => process.stdout.write(m.settingsMarkdown()))" > docs/settings.md
```

`test/docs.test.js` fails when it is stale. Public docs name no clients or
accounts; use placeholders.

## Scripting and servers

Node.js, not Python. Use an `e9gauge` command first. Do not start HTTP servers
unless asked. The tests are the exception: a few bind a loopback listener on an
ephemeral port (port 0) and close it, so nothing keeps running.

## Dependencies

`@engine9/core` and `@engine9/schemas` are `file:../core` and `file:../schemas`
devDependencies on sibling checkouts; their published ranges are
peerDependencies. Keep both. Do not rewrite any other dependency from a
published range to a local path unless asked.

## Tests

```
npm test
```

Plain `node --test`, one file at a time (`--test-concurrency=1`). Tests use
in-memory SQLite through core's `PersonWorker`, a temporary file database for
the CLI, and fakes for Queues and R2. Core logs a lot of schema output; filter
for `✖` and the final `ℹ` lines.

Do not git commit unless the user asks.
