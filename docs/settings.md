# Gauge settings

Generated from `gauge/settings.js`. Edit them like any plugin setting: `e9gauge settings`, `e9gauge set <setting> <value>`, MCP `plugin` settings, or the console.
Booleans are the strings `true` and `false`. Secrets (`SESSION_SECRET`, `GAUGE_SALT`) are environment variables, never settings.

## Collection

| Setting | Default | |
| --- | --- | --- |
| `collect_enabled` | `true` | Master switch. When false the collector answers 204 and records nothing. |
| `streams` | `[]` | Data streams, one per site or app: [{"id":"G-www","name":"www.example.com","type":"web_stream","hosts":["www.example.com"]}]. type is web_stream, app_stream or server_stream. The id is public (like a GA4 Measurement ID) and is what the page or app sends. Each stream becomes one engine9 input. |
| `allowed_hosts` | (empty) | Comma-separated browser origins hosts allowed to send (www.example.com, *.example.com). Empty accepts any origin for a valid stream id. Streams may add their own hosts. |

## Storage

| Setting | Default | |
| --- | --- | --- |
| `db_mode` | `rollups` | rollups keeps devices, gauge sessions and daily counts in the database. entries also writes every hit to gauge_entry (large on D1). The disk log always has every hit. One of: `rollups`, `entries`. |
| `timeline_mode` | `identified` | Which hits become timeline entries. none: never. identified: only hits from a known person (earlier anonymous hits are written when the device is identified). all: anonymous hits too, with person_id 0. One of: `none`, `identified`, `all`. |
| `timeline_entry_types` | `SESSION_START,FIRST_VISIT,LOGIN,LOGOUT,IDENTIFY,CUSTOM_ENTRY` | Comma-separated entry types written to the timeline when timeline_mode allows. PAGE_VIEW is deliberately not a default: it is the highest-volume entry. |

## Log

| Setting | Default | |
| --- | --- | --- |
| `log_directory` | `./gauge-logs` | Node collector: directory for the JSONL log (YYYY/MM/DD/HH-<host>-<pid>.jsonl). |
| `fsync` | `interval` | How hard the collector works to put a hit on disk before it answers. One of: `interval`, `always`, `none`. |
| `log_retention_days` | `30` | Days a closed log segment is kept after the loader has read it. |

## Sessions

| Setting | Default | |
| --- | --- | --- |
| `session_timeout_minutes` | `30` | Inactivity that ends a gauge session. A new campaign (utm_source/medium/campaign) also starts one. A gauge session is not the Core Session. |
| `device_cookie_name` | `e9_did` | First-party cookie that holds the device id (web streams). |
| `cookie_domain` | (empty) | Cookie Domain attribute, e.g. example.com to share across subdomains. Empty is host-only. |
| `cookie_days` | `395` | Device cookie lifetime in days. |

## Privacy

| Setting | Default | |
| --- | --- | --- |
| `consent_mode` | `granted` | granted: set the device cookie by default. required: cookieless daily counting (no cookie, no person link) until the client reports consent. One of: `granted`, `required`. |
| `respect_gpc` | `true` | Treat Sec-GPC: 1 and DNT: 1 as no consent (cookieless counting). |
| `ip_mode` | `drop` | drop: the IP address is never logged. truncate: the log keeps /24 (IPv4) or /48 (IPv6). The IP is only ever used in memory, for rate limits and cookieless ids. One of: `drop`, `truncate`. |
| `query_param_allowlist` | (empty) | Comma-separated query parameters kept on a URL. utm_* and source code parameters are always kept; anything that looks like an email is always removed. |
| `bot_filter` | `true` | Drop hits from known bots and crawlers at the collector. They are not logged; /ok reports how many were dropped. |
| `sample_rate` | `1` | Fraction of devices recorded, chosen by a stable hash of the device id. 1 records everything. |

## Identity

| Setting | Default | |
| --- | --- | --- |
| `source_code_params` | `source_code,sc` | Query parameters that carry an engine9 source code. A match sets source_code_id on timeline entries. |
| `backfill_days` | `30` | When a device is identified, its anonymous hits from the last N days are attributed to the person. Needs db_mode entries or log files still on disk. |

## Custom entries

| Setting | Default | |
| --- | --- | --- |
| `custom_entries` | `[]` | Declared custom entries: [{"name":"video_upload","label":"Uploaded a video","key":true,"props":{"size_mb":"number"}},{"name":"newsletter","entry_type":"SIGNUP"}]. key:true sends it to the timeline. entry_type maps it onto a standard type instead of CUSTOM_ENTRY. |
| `allow_undeclared_custom` | `true` | When false, a custom entry whose name is not declared is rejected. |
| `download_extensions` | `pdf,zip,csv,xlsx,docx,mp4,mp3` | File extensions the browser client reports as FILE_DOWNLOAD. |
