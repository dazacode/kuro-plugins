# Your first plugin

From nothing to a signed, installable `.kuroplugin`. If you already have an
extension to port, read [porting.md](porting.md) instead — it starts from what
you have rather than from an empty directory.

## 0. Before you start

You need a source you can read: an API that returns JSON, or pages whose markup
you can pick apart. Open it in a browser first and find three things.

1. a **search** request that takes a query and returns a list of shows
2. a way to get the **episodes** of one of those shows
3. a way to get a **playable file** for one of those episodes

If you cannot do those three by hand, no plugin can do them for you. Most of
the work of writing one is this, and it happens in a browser's network tab.

## 1. Scaffold

```bash
bun run kuro new mysource
```

```
plugins/mysource/
  plugin.json          what the plugin declares, and what a viewer is shown
  src/index.ts         the three methods
  test/mysource.spec.ts
  licenses/LICENSE
  README.md
```

The three methods start out throwing `NotFoundError('Not implemented.')`. That
is deliberate — an unimplemented method that threw nothing would look like a
source with no results.

## 2. Declare where you may go

Open `plugin.json` and set `network.hosts`:

```json
"network": {
	"hosts": ["api.mysource.test", "cdn.mysource.test"]
}
```

A request to any host not on that list throws before a packet leaves. Not a
warning — the request does not happen. This is what makes installing a plugin a
decision somebody can actually make, and the plugin cannot opt out of it.

Declare the CDN too if your streams are served from a different domain, and
declare anything you get **redirected** to — the host you land on is the host
being reached.

## 3. Search

```ts
import { defineSource, NotFoundError, type SourceCatalogEntry } from '@kuro/plugin-sdk';

const API = 'https://api.mysource.test/v1';

interface SearchResponse {
	readonly results: readonly { id: string; title: string; year?: number }[];
}

export default defineSource({
	id: 'app.kuro.plugins.mysource',

	async searchCatalog(query, page, ctx) {
		const found = await ctx.http.json<SearchResponse>(
			`${API}/search?q=${encodeURIComponent(query)}&page=${page}`
		);

		const entries: SourceCatalogEntry[] = found.results.map((one) => ({
			sourceMediaId: one.id,
			title: one.title,
			year: one.year
		}));

		return { entries, hasMore: entries.length > 0 };
	}

	// … the other two, still throwing
});
```

Two things worth getting right now rather than later.

**Declare the API's shapes as interfaces.** The example plugin does this and
explains why: when the source changes a field name, you get a type error next to
the parsing rather than `undefined` three functions away.

**`sourceMediaId` is whatever this source calls that show.** A slug, a number, a
path. It comes back to the other two methods unchanged and a viewer never sees
it. Do not invent a canonical id — the host already has one from its metadata
provider, and a source claiming to know which show this _is_ would be answering
a question nobody asked.

## 4. Record a cassette

Open `test/mysource.spec.ts`. The shape matters more than it looks:

```ts
// One harness per tape, created once at module scope. The instance your tests
// use is the one holding the recorded traffic.
const search = pluginTest(ROOT, 'search');

// A no-op unless --record.
afterAll(() => {
	search.save();
});

it('searches', async () => {
	const page = await plugin.searchCatalog('some show', 1, search.ctx);
	expect(page.entries.length).toBeGreaterThan(0);
});
```

**`save()` is what writes the tape**, and it has to be called on the harness the
tests actually used. Build a fresh `pluginTest(...)` inside `afterAll` and you
will save an empty one over a good one — and a tape with no entries fails
replay with the same message as no tape at all.

Then:

```bash
bun run kuro test mysource --record   # hits the real source, writes cassettes/
bun run kuro test mysource            # replays them, offline, ~100ms, forever
```

Add a harness per tape as you go — `episodes`, `resolve` — and save each in the
same `afterAll`.

Commit the tapes. They are the point — see
[Cassettes are the point](../README.md#cassettes-are-the-point). Recording
redacts `Set-Cookie`, `Authorization` and friends before anything is written, so
a tape is safe to commit.

## 5. Episodes

```ts
async listEpisodes(sourceMediaId, ctx) {
	const found = await ctx.http.json<{ episodes: { id: string; n: number }[] }>(
		`${API}/show/${sourceMediaId}/episodes`
	);

	return found.episodes.map((one) => ({
		number: one.n,
		sourceEpisodeId: one.id
	}));
}
```

`number` is what a viewer calls it. `sourceEpisodeId` is your handle and comes
back to `resolve`.

If the source has the show but genuinely lists no episodes, throw
`NotFoundError`. Do not return `[]` — that reads as a show with nothing in it,
which is a different claim and the one that hides breakage.

## 6. Resolve

```ts
import { matchOne } from '@kuro/plugin-sdk';

async resolve(sourceMediaId, episode, ctx) {
	const url = `${API}/watch/${episode.sourceEpisodeId}`;
	const page = await ctx.http.text(url);

	// Throws SourceChangedError naming what it wanted and where it looked,
	// rather than returning undefined and failing somewhere else later.
	const file = matchOne(/"file"\s*:\s*"([^"]+)"/, page, 'stream url', url);

	return [
		{
			url: file,
			container: file.includes('.m3u8') ? 'hls' : 'mp4',
			quality: '1080p'
		}
	];
}
```

Return **every** address you found, best first — the host tries them in order
and a viewer sees the first that opens, so a second-choice mirror is worth
returning rather than discarding.

If nothing plays, **throw `NotFoundError`**. An empty list is a state every
caller would otherwise have to special-case.

### If the stream needs headers

Very common: the file plays only when the request carries a `Referer`.

```ts
return [{ url: file, container: 'hls', headers: { Referer: `${SITE}/` } }];
```

### If the stream is not playable as served

Segments disguised as images, masked payloads, manifests that need rewriting —
you _describe_ the repair and the host performs it natively:

```ts
import { ops, manifest as manifestFix } from '@kuro/plugin-sdk';

pipeline: {
	headers: { Referer: `${CDN}/` },
	manifest: [manifestFix.absolutise()],
	segment: [ops.dropMagicPrefix([{ magic: ctx.text.encode('RIFF'), drop: 12 }])]
}
```

Read `resolve` in [the reference plugin](../plugins/example/src/index.ts) for a
worked one. This is the part of the design that does not exist anywhere else,
and [The one idea](../README.md#the-one-idea) is why.

## 7. Validate, package, install

```bash
bun run kuro validate mysource
bun run kuro keygen                       # once
bun run kuro package mysource --key .keys/signing-key.pem
bun run kuro verify plugins/mysource/*.kuroplugin --key .keys/signing-key.pub
```

To publish a set of plugins for others to install, see
[Plugin repositories](repository.md).

## What to do next

Write the tests the scaffold left you. The reference suite in
[`plugins/example/test`](../plugins/example/test/example.spec.ts) shows the four
kinds that earn their keep — and the one most people skip, executing the
declared pipeline against a recorded segment, is the one that actually proves
the episode plays.
