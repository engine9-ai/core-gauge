# Custom entries

Standard entries (`PAGE_VIEW`, `LOGIN`, ...) cover most measurement. For
anything specific to your product (a video upload, a plan change, a map layer
toggled) you send a custom entry. A custom entry is never a new integer in the
global `entry_type_id` enum. It is `CUSTOM_ENTRY` (129) plus a name, so a
site can add one with no release of core or schemas.

There are three tiers. Move up when an entry matters more.

## Tier 1: ad hoc

Send a name. Nothing to configure.

```js
gauge.track('video_upload', { size_mb: 40, format: 'mp4' }, 40);
```

Server side: `g.send([{ name: 'video_upload', person_id: 12, props: { size_mb: 40 }, value: 40 }])`.

- The name is lowercase snake_case, up to 64 characters (`^[a-z][a-z0-9_]{0,63}$`). Anything else is rejected.
- Accepted while `allow_undeclared_custom` is `true` (the default). Set it to `false` once your names are declared and a stray name should be refused.
- `props` keeps primitives only: up to 20 keys, key names up to 40 characters, strings up to 256 characters, 2 KB in total. A string that looks like an email address is dropped, and so is a non-finite number.
- `value` is one number, for something you want to sum (megabytes, seconds, a rating).
- Each name becomes its own engine9 `input`, `remote_input_id = custom:<name>`, so "who did this" is a join on one input and a name never collides with another stream.
- It reaches the timeline for known people when `CUSTOM_ENTRY` is in `timeline_entry_types` (it is by default) and `timeline_mode` allows. The properties and the name live in `gauge_entry`, which is filled only with `db_mode=entries`; in the default `rollups` mode they stay in the log, and the timeline row is identified by its input.

Ask who did it:

```
segment clause   didCustomEntry   { "name": "video_upload" }
report           @engine9/core-gauge/gauge:reports:custom_entries
```

## Tier 2: declared

Declare the name once and the collector enforces its shape.

```
e9gauge custom add --name video_upload --label "Video uploaded" --pin --props size_mb:number,format:string
```

That writes the `custom_entries` setting:

```json
[{ "name": "video_upload", "label": "Video uploaded", "key": true, "props": { "size_mb": "number", "format": "string" } }]
```

| Field | Meaning |
| --- | --- |
| `name` | as above |
| `label` | the human name on the input |
| `key` | `true` pins it to the timeline for a known person even if you narrow `timeline_entry_types` and drop `CUSTOM_ENTRY`. Use it for the few entries the business cares about |
| `props` | `{ property: "number" \| "string" \| "boolean" }`. A declared entry keeps only these properties, and only when the type matches |
| `entry_type` | map it onto a standard type (`SEARCH`, `SHARE`, ...) so it counts as that type everywhere. It must be a name gauge accepts |

An entry with an unknown `entry_type` is dropped from the setting, not accepted
loosely: a mistake should show up, not hide.

## Tier 3: a standard type

When a custom entry is something every site has (a site search, a share, a
video completion), it should be a standard type with a stable id. Propose it:

1. Open a pull request adding the name to `@engine9/input-tools` `timelineTypes.js` and to `lib/entryTypes.js` here, with the next free id in 100 to 128. Ids never change once shipped, and `test/entryTypes.test.js` fails if the two lists disagree.
2. Add it to `DEFAULT_TIMELINE_ENTRY_TYPES` only if it is rare and valuable. High-volume types stay out of the timeline by default.
3. Existing data keeps working: old rows stay `CUSTOM_ENTRY`, and a declared `entry_type` mapping lets new rows use the standard type with no change to the page.

Names carry no platform prefix. `platform` (`web`, `ios`, `android`, `desktop`,
`server`) is a column, so one `LOGIN` means the same from a site, an app, or a
portal.
