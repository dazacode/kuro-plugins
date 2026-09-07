# example

The reference plugin. Read `src/index.ts` before writing your own — it is
commented as a tutorial, not as production code.

It talks to `api.example.com`, which does not exist. Every response is a
committed cassette, so this plugin is deterministic forever, its tests run with
no network, and it can never go red because somebody else's website changed. A
reference that depended on a live service would be broken half the time and
would teach you nothing on those days.

```bash
bun run kuro test example       # ~100ms, offline
bun run kuro validate example
bun run kuro package example
```

## What it demonstrates

The fictional API is deliberately shaped like the awkward real ones: paginated
search that reports a total rather than a page count, a separate call for
playable mirrors, an embed page with its configuration wedged into a `<script>`
tag as not-quite-JSON, and a CDN that disguises its segments as images and
masks them.

| In `src/index.ts` | Why it is there |
| --- | --- |
| `page()` | `hasMore` from the **total**, not from `entries.length` |
| `listEpisodes` | reading a host-rendered setting (`hide_filler`) |
| `resolve` | mirrors fanned out with a concurrency cap, dead ones dropped |
| `resolveServer` | `matchOne` + `parseJson5` on an embedded config |
| `pipeline` | the four ops that replace a proxy server |

## The four rules

1. **You never send a request.** `ctx.http` does, and only to hosts your
   manifest declared. There is no other way out of the sandbox.
2. **You never draw UI.** `manifest.settings` is rendered by the host on all six
   platforms in its own design tokens. You read values.
3. **You never touch a segment.** When a stream is not playable as served you
   *describe* the fix with `ops`, and the host executes it natively.
4. **Missing data is an event, not a value.** `matchOne` throws
   `SourceChangedError` naming what it wanted and where. Returning an empty list
   instead is how a broken plugin looks exactly like a show with no episodes.

## The test worth copying

`test/example.spec.ts` ends by running the plugin's own declared ops over a
recorded segment and asserting the result is MPEG-TS — 188-byte packets, each
starting with `0x47`.

That is the difference between "my ops look right" and "my ops turn these bytes
into video". It is the test most people skip and the only one that proves the
episode plays.
