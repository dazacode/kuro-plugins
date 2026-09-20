# The three methods

```ts
searchCatalog(query, page, ctx, cursor?)  → CatalogPage
listEpisodes(sourceMediaId, ctx)          → SourceEpisode[]
resolve(sourceMediaId, episode, ctx)      → PlaybackSource[]
browse?(shelf, page, ctx, cursor?)        → CatalogPage
```

`browse` is optional; declare `browse` in `capabilities` if you export it.

Types come from `@kuro/plugin-sdk`, and
[`plugins/example/src/index.ts`](../plugins/example/src/index.ts) is the worked
version of everything below.

## Failure is an event, not a value

The single most important rule here, and the one the whole design turns on.

| situation                                       | what to do                               |
| ----------------------------------------------- | ---------------------------------------- |
| the source has nothing for this query           | return `{ entries: [], hasMore: false }` |
| the source has nothing for this show or episode | **throw** `NotFoundError`                |
| the markup or payload changed shape             | **throw** `SourceChangedError`           |
| the source rate-limited you                     | **throw** `RateLimitedError`             |
| the source refused you                          | **throw** `PermissionDeniedError`        |
| the request itself failed                       | `ctx.http` already throws `NetworkError` |

An empty list is a legitimate answer to a _search_. It is never a legitimate
answer to "where does this play". A plugin that returns `[]` when its selector
stopped matching looks exactly like a show with no episodes, and nobody finds
out for weeks.

The SDK's extraction helpers do this for you:

```ts
import { matchOne, optionalMatchOne } from '@kuro/plugin-sdk';

// Throws SourceChangedError naming what it wanted and where it looked.
const file = matchOne(/"file"\s*:\s*"([^"]+)"/, page, 'stream url', url);

// Absence is a legitimate answer here.
const poster = optionalMatchOne(/"poster"\s*:\s*"([^"]+)"/, page);
```

## `searchCatalog`

```ts
async searchCatalog(query, page, ctx, cursor) {
	const found = await ctx.http.json<SearchResponse>(
		`${API}/search?q=${encodeURIComponent(query)}&page=${page}`
	);
	return {
		entries: found.results.map((one) => ({ sourceMediaId: one.id, title: one.title })),
		hasMore: found.page < found.total
	};
}
```

`page` is 1-based. `cursor` is whatever your previous page returned, for a
cursor-paginated source, and is absent on the first page.

**`hasMore` is returned, not inferred.** A source that filters server-side
routinely returns a short page that is not the last one, and an infinite scroll
that stops early looks exactly like a source with less content than it has.

**`sourceMediaId` is yours.** Whatever this source calls that show. It comes
back to the other methods unchanged and a viewer never sees it. Do not mint a
canonical id — the host has one from its metadata provider, and a source
claiming to know which show this _is_ would be answering a question nobody
asked.

Fill `alternativeTitles` when the source gives them. Titles are a weak key and
the host has to score a match; every extra spelling is a chance for a viewer's
show to bind to your source rather than quietly fail to.

## `listEpisodes`

```ts
async listEpisodes(sourceMediaId, ctx) {
	const found = await ctx.http.json<EpisodesResponse>(`${API}/show/${sourceMediaId}/episodes`);
	return found.episodes.map((one) => ({
		number: one.n,
		sourceEpisodeId: one.id,
		title: one.title
	}));
}
```

Ascending, by `number`. `sourceEpisodeId` is your handle and comes back to
`resolve`.

If the show exists but has no episodes, throw `NotFoundError`.

## `resolve`

```ts
async resolve(sourceMediaId, episode, ctx) {
	const servers = await ctx.http.json<Servers>(`${API}/episode/${episode.sourceEpisodeId}/servers`);
	const sources = await mapConcurrent(servers.list, 3, (one) => extract(one, ctx));
	const playable = sources.filter((one) => one !== null);
	if (playable.length === 0) throw new NotFoundError('No mirror answered for this episode.');
	return playable;
}
```

It receives the whole `SourceEpisode` you returned from `listEpisodes`.

Return **every** way this source can currently play it, best first — the host
walks the list and a viewer sees the first that opens, so a second-choice
mirror is worth returning rather than discarding.

Never return `[]`. Throw `NotFoundError`.

`mapConcurrent` is in the SDK because fanning out across mirrors is the normal
shape here and an unbounded `Promise.all` over twelve servers is not polite.

### A `PlaybackSource`

```ts
{
	url: 'https://cdn.example.test/master.m3u8',
	container: 'hls',              // 'hls' | 'dash' | 'mp4'
	quality: '1080p',
	headers: { Referer: `${SITE}/` },
	subtitles: [{ url, language: 'en', format: 'vtt' }]
}
```

`container` wrong means playback fails in a way that looks exactly like a dead
link. Read it from the URL or the response; do not default it.

`headers` are for the _stream_, and the host carries them through for the
manifest and every segment. You do not proxy anything.

### When the bytes are not playable as served

You describe the repair; the host performs it natively. This is the part of the
design that exists nowhere else, and
[The one idea](../README.md#the-one-idea) is why.

```ts
import { ops, manifest as manifestFix } from '@kuro/plugin-sdk';

pipeline: {
	headers: { Referer: `${CDN}/`, Origin: CDN },
	manifest: [manifestFix.absolutise(), manifestFix.repairBandwidth()],
	segment: [
		ops.dropMagicPrefix([{ magic: ctx.text.encode('RIFF'), drop: 12 }]),
		ops.xorRepeating(mask, { at: 0, equals: 0x47 }),
		ops.assertMpegTs('This mirror changed its key.')
	]
}
```

Available: `dropMagicPrefix`, `dropBytes`, `xorRepeating`, `assertByte`,
`assertMpegTs` for segments; `absolutise`, `rebaseFromQuery`, `repairBandwidth`
for manifests.

**Test the pipeline against a recorded segment.** Ops that look right and ops
that turn those bytes into MPEG-TS are different claims, and the reference
suite asserts the second with `runSegmentOps`.

## `ctx`

```ts
ctx.http; // send, text, json — the only way out, and only to declared hosts
ctx.settings; // string(id), boolean(id), list(id)
ctx.storage; // get/set/delete, requires permissions: ["storage"]
ctx.log; // debug(message, data?), warn(message, data?)
ctx.text; // encode/decode — there is no TextEncoder global
ctx.bytes; // base64 and hex, engine-independent
ctx.locale; // BCP-47-ish; may lack a region
ctx.signal; // aborted when the viewer navigates away
```

There is no `fetch`, no DOM, no filesystem, no timers you can hold across
calls. If it is not on `ctx`, your plugin does not have it.
