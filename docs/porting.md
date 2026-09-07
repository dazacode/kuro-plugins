# Porting an existing extension

A recipe for turning an Aniyomi/Tachiyomi-style Kotlin extension into a kuro
plugin. `plugins/reanime` is a worked example of every step; read it alongside
this.

The claim this document is making: **most of a Kotlin extension is not logic.**
It is an HTTP client, an interceptor stack, an Android preferences screen, DTO
boilerplate, and — for any source with an obfuscated CDN — a web server. All of
that is host work here, so the port is mostly deletion.

---

## 0. The map

| Kotlin                                      | kuro                                          | Notes                                        |
| ------------------------------------------- | --------------------------------------------- | -------------------------------------------- |
| `popularAnimeRequest` + `popularAnimeParse` | `browse('popular', page, ctx)`                | request and parse collapse into one function |
| `latestUpdatesRequest` + `…Parse`           | `browse('latest', …)`                         | cursor travels on `CatalogPage.cursor`       |
| `searchAnimeRequest` + `…Parse`             | `searchCatalog(query, page, ctx)`             |                                              |
| `animeDetailsParse`                         | _(nothing)_                                   | the metadata layer owns this — see §1        |
| `episodeListRequest` + `…Parse`             | `listEpisodes(id, ctx)`                       | ascending; the host does not sort            |
| `videoListRequest` + `…Parse`               | `resolve(id, episode, ctx)`                   | returns a list, best first                   |
| `SAnime`                                    | `SourceCatalogEntry`                          | **no canonical id**                          |
| `SEpisode`                                  | `SourceEpisode`                               |                                              |
| `Video(url, quality, headers)`              | `PlaybackSource` + `pipeline`                 | the important difference                     |
| `Track(url, lang)`                          | `SubtitleTrack`                               | needs a `format`                             |
| `setupPreferenceScreen`                     | `manifest.settings`                           | JSON, not code                               |
| `OkHttpClient`, interceptors, `rateLimit`   | `ctx.http`                                    | not yours to configure                       |
| `SharedPreferences`                         | `ctx.settings` (read) / `ctx.storage` (write) |                                              |
| a `NanoHTTPD` proxy server                  | `pipeline`                                    | **§4**                                       |
| `Jsoup` / CSS selectors                     | `matchOne` + regex                            | no DOM in any engine                         |
| `LruCache` on a field                       | `ctx.storage`                                 | module state does not survive the sandbox    |

---

## 1. Delete the metadata code first

A Kotlin extension's `animeDetailsParse` fills in synopsis, banner, score,
studios and so on. **Do not port it.**

kuro splits _what a show is_ (metadata: AniList, MAL, Kitsu) from _what this
source can play_. A source has no canonical ids and must not invent any,
because the user's library keys on those and a source being wrong would damage
it. `SourceCatalogEntry` therefore carries only what improves a **match score**:
titles, year, episode count, format.

Everything else you would have ported is already on screen from the metadata
layer, and it stays there when the source dies.

Deleting this is usually 20–30% of the file.

---

## 2. Settings become JSON

Every `addListPreference`, `SwitchPreferenceCompat` and
`MultiSelectListPreference` becomes one entry in `manifest.settings`:

```json
{
	"id": "quality",
	"type": "select",
	"label": "Preferred quality",
	"help": "The player still adapts; this decides which mirror is offered first.",
	"default": "1080",
	"options": [{ "value": "1080", "label": "1080p" }]
}
```

Read them with `ctx.settings.string('quality')`, `.boolean(…)`, `.list(…)`.

The host draws them, on all six platforms, in its own design tokens. A plugin
never has a layout bug because a plugin never has a layout. `kuro validate`
checks that a `select`'s default is actually one of its options — a default
outside the list renders as a blank control the user cannot restore.

---

## 3. Requests

Drop the `OkHttpClient`, the interceptors and the rate limiter. `ctx.http` is
the only way out, it refuses any host `manifest.network.hosts` does not declare,
and it applies the host's own timeouts and backoff.

```ts
const body = await ctx.http.json<SearchResponse>(url, { headers: apiHeaders(referer) });
```

Two things to carry over verbatim:

- **The headers.** `Referer`, `Origin` and the `Sec-Fetch-*` trio are usually
  load-bearing; an API that rejects requests not shaped like its own page
  returns a 403 that reads exactly like an IP ban.
- **The host list.** Every host you reach goes in `network.hosts`, wildcards
  as `*.cdn.example.com`. The test harness enforces it, so a missing one fails
  on your machine rather than after install.

A non-2xx is **returned, not thrown** — sources use 404 and 403 as ordinary
answers.

### No DOM

None of the three engines has one, and shipping a parser into a QuickJS sandbox
costs hundreds of kilobytes per plugin. Use `matchOne`, which throws
`SourceChangedError` naming what it wanted and where:

```ts
const raw = matchOne(/window\.__PLAYER__\s*=\s*(\{[\s\S]*?\});/, html, 'the player config', url);
const config = parseJson5<Config>(raw, 'player config', url);
```

`parseJson5` handles unquoted keys, trailing commas and `undefined`, which is
what framework serialisers embed in `<script>` tags.

**No regex lookbehind anywhere** — QuickJS builds do not reliably support it.

---

## 4. The extractor, and the part that is different

This is the step worth reading twice.

Find where the Kotlin ends up with a URL the player can open. If it is a plain
`https://` link, you are done — return a `PlaybackSource` with `headers` and no
`pipeline`.

If instead the extension does **any** of these:

- starts a `NanoHTTPD`/`m3u8server`/local proxy
- XORs, unmasks, or strips a prefix from segment bytes
- rewrites a manifest before handing it over
- wraps the manifest URL in another endpoint

…then those are `pipeline` declarations, not code. Translate them:

| Kotlin does                                       | Declare                                           |
| ------------------------------------------------- | ------------------------------------------------- |
| `detectHeader()` returning 8 or 12, then skipping | `ops.dropMagicPrefix([{ magic, drop }, …])`       |
| `bytes[i] xor mask[i and 15]`                     | `ops.xorRepeating(mask)`                          |
| `if (firstByte != 0x47) shouldXor = false`        | `ops.xorRepeating(mask, { at: 0, equals: 0x47 })` |
| `if (decrypted != 0x47) throw`                    | `ops.assertMpegTs('…')`                           |
| `parentHttpUrl.resolve(line)`                     | `manifest.absolutise()`                           |
| `if (peakBw < 100_000) peakBw * 1000`             | `manifest.repairBandwidth()`                      |
| `ensureToken(segmentUrl, parentUrl)`              | `propagateQuery: ['token']`                       |
| `wrapInDecApi(url, payload)` on the master only   | `manifest.rebaseFromQuery('url')`                 |
| per-host `Origin`/`Referer` switching             | `headersByHost`                                   |

**Anything dynamic — a scraped key, a minted token — is computed in `resolve()`
and travels as data.** That is the split: JavaScript on the metadata path, once
per episode; native code on the byte path, hundreds of times.

Always end a segment op list with an assertion. A stale key still produces
bytes; they buffer, they demux, and the symptom is a black screen with nothing
in any log. One comparison per segment turns that into a sentence.

If the transform genuinely cannot be expressed, say so in an issue rather than
reaching for `segment-transform-js` — the vocabulary is meant to grow, and
`aes-cbc`, `deinterleave` and `reverse-blocks` are each about a day.

---

## 5. Failures, loudly

The single highest-value change you can make while porting.

```ts
throw new SourceChangedError('the episode list payload', url); // shape moved
throw new NotFoundError('This show has no episodes yet.'); // genuinely empty
throw new NetworkError('502 from the API', 502); // retryable
```

Kotlin extensions overwhelmingly `return emptyList()` on a parse failure, which
is indistinguishable from a show with no episodes — and that is why breakages go
unnoticed for weeks. Distinguish the two and a bug report arrives with a URL in
it.

---

## 6. Cassettes

```bash
kuro test mysource --record     # once, against the real source
git add plugins/mysource/cassettes
```

From then on the suite is offline and deterministic. When the source changes,
re-record and read the diff.

Write at least one test that runs your **declared ops over a recorded segment**
and asserts the output is what a demuxer wants (`0x47` every 188 bytes for
MPEG-TS). Everything else only proves the ops look right; this proves the
episode plays.

---

## 7. Checklist

- [ ] `kuro validate` clean
- [ ] `network.hosts` covers every host, proven by the harness
- [ ] settings are manifest descriptors; no UI code
- [ ] `resolve` returns a list, best first, and throws rather than returning `[]`
- [ ] no socket, no proxy, no `setInterval`, no module-level mutable state
- [ ] every segment op list ends in an assertion
- [ ] a test decodes a real recorded segment
- [ ] failures are typed, and `SourceChangedError` names a URL
- [ ] `licenses/` is non-empty
