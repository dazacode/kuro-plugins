# Documentation

Four paths through this repository. Pick the one that matches what you are
doing.

| you want to                           | start at                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| write a plugin from scratch           | **[Your first plugin](first-plugin.md)**                                                                       |
| port an extension you already have    | [Porting an existing extension](porting.md)                                                                    |
| look something up                     | [The manifest](manifest.md) · [The three methods](three-methods.md) · [When it goes wrong](troubleshooting.md) |
| publish plugins for others to install | [Plugin repositories](repository.md)                                                                           |

Before any of them, read [`plugins/example/src/index.ts`](../plugins/example/src/index.ts).
It is the reference plugin: a fictional API shaped like the awkward real ones,
fully offline, and commented as it goes. Most questions these pages answer are
answered there first, in context.

## You may not have to write one

[dazacode/plugin-bridge-js](https://github.com/dazacode/plugin-bridge-js)
translates extensions written for Aniyomi, Stremio, Sora, Hayase, Mangayomi and
Nuvio into this same ABI, statically. If you already have a working extension
for one of those, try that before porting by hand — a translated plugin and one
written here are the same artifact by the time the client sees them.

It is also where the ABI is specified and implemented: the sandbox, the host
port, the packager, the conformance run. Worth reading when you need to know
precisely what a host does with what you return.

## What a plugin is

One ES module with a default export answering three questions:

```ts
searchCatalog(query, page, ctx, cursor?)  → CatalogPage
listEpisodes(sourceMediaId, ctx)          → SourceEpisode[]
resolve(sourceMediaId, episode, ctx)      → PlaybackSource[]
```

The plugin supplies **data**. The host supplies **experience** — the screens,
the player, the settings UI, the byte pipeline. That division is the whole
design, and the README's [The one idea](../README.md#the-one-idea) says why the
alternative does not survive contact with a phone.

## The loop

```bash
kuro new mysource               # scaffold
kuro test mysource --record     # hit the real source once, write cassettes
kuro test mysource              # replay, offline, ~100ms, forever
kuro validate mysource
kuro package mysource --key .keys/signing-key.pem
```

You never open the app to develop a plugin. No Flutter, no simulator, no
device.

## Four things that are not negotiable

1. **You never send a request.** `ctx.http` does, and only to hosts your
   manifest declared. There is no other way out of the sandbox.
2. **You never draw UI.** You declare `settings` in the manifest and read
   values; the host renders them on all six platforms.
3. **You never touch a segment.** When a stream is not playable as served, you
   _describe_ the fix as data and the host executes it natively.
4. **Missing data is an event, not a value.** Throw a named error. Returning an
   empty list makes a broken plugin look exactly like a show with no episodes,
   which is the failure this project exists to eliminate.
