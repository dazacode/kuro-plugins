# reanime

Ported from the Aniyomi Kotlin extension. This is the plugin that exists to
prove the design, so the numbers matter:

| | Kotlin extension | This plugin |
| --- | --- | --- |
| Source | 2,218 lines across 5 files | ~470 lines across 2 |
| Local HTTP server | **460 lines** (`FlixProxyServer.kt`, NanoHTTPD) | none |
| Settings UI | Android `PreferenceScreen`, ~90 lines | 9 manifest descriptors |
| Platforms | Android | all six |

The 460 lines are the point. The original starts an HTTP server *inside the
app*, binds `127.0.0.1`, streams every segment through an XOR-decoding
`ForwardingSource`, rewrites the manifest, and hands the player a
`http://127.0.0.1:…` URL — because the extension API ends at a URL and this
CDN does not serve anything a player can open.

## What the CDN actually does

1. Every HLS segment arrives with a fake `RIFF….WEBP` (12 bytes) or PNG
   signature (8 bytes) glued on the front.
2. The payload underneath is XOR-masked with a 16-byte repeating key, **scraped
   out of the site's own `hls.js` bundle** because it rotates.
3. Some segments arrive plain anyway, so the unmasking has to be conditional or
   it corrupts them.
4. The master manifest is only fetchable through a signing wrapper on a third
   host, and the manifest it returns contains URIs relative to the *real*
   address, not the wrapper's.
5. `BANDWIDTH` is emitted in Kbps. A player that believes it throttles its own
   buffer into permanent rebuffering on a fast connection.

## What this plugin does about it

`resolve()` does the handshake — embed page, key scrape, signing round trip,
stream decrypt — which is real work and is what JavaScript is for. Then it
returns the byte problem as **data**:

```ts
pipeline: {
  headers:       { Accept: '*/*', Origin: FLIX, Referer: `${FLIX}/` },
  headersByHost: { 'enc-dec.app': { Origin: …, Referer: … } },
  propagateQuery: ['token'],
  manifest: [ rebaseFromQuery('url'), absolutise(), repairBandwidth() ],
  segment:  [ dropMagicPrefix([RIFF→12, PNG→8]),
              xorRepeating(mask, { at: 0, equals: 0x47 }),
              assertMpegTs('…rotated its key. Try another server.') ]
}
```

The host executes that natively — Dart on Android, iOS, macOS, Windows and
Linux; a `shaka-player` response filter in the browser. Nothing in `src/` is
platform-specific and nothing in `src/` opens a socket.

`assertMpegTs` is the line worth keeping. A stale key still produces bytes;
they still buffer and still reach the demuxer, and the symptom is a black
screen with nothing in any log. One comparison per segment turns that into a
sentence the user can act on.

## The key, and its three fallbacks

The mask rotates, so it is read the way the site's own player reads it:

1. **Scrape** it from the `hls.js` bundle the embed page references, and persist.
2. **The last persisted value**, if the scrape fails — a rotation is rare, a
   transient fetch failure is not.
3. **A compiled-in value**, so a first run on a flaky network still plays.

When all three are stale, `assert-byte` says so by name.

## The cassettes are synthetic

**Important.** `cassettes/*.json` were hand-built to the shapes documented in
the upstream `Dto.kt`. They were **not** recorded from the live source. They
prove the parsing, the settings, the failure classification and the pipeline
are correct *against those shapes*; they cannot prove the shapes are current.

To get real ones, from a machine that can reach the source:

```bash
bun run kuro test reanime --record
git diff plugins/reanime/cassettes
```

That diff is exactly where the source differs from what the Kotlin extension
documented, and it is the whole reason cassettes exist.

## Third-party dependency

The stream handshake goes through an external signing service (`enc-dec.app`).
That is the source's design and this plugin cannot avoid it, but it is somebody
else's uptime in the middle of playback. It is declared in `network.hosts` so a
user sees it before installing, and it is the first thing to suspect when every
mirror fails at once.

## Known gaps

- **Direct MKV downloads are not ported.** The Kotlin extension offers each
  server's original Matroska file as an extra entry. `StreamContainer` models
  `mp4 | hls | dash`, and calling an MKV "mp4" would be a lie the player acts
  on. Needs a `progressive` container first.
- **The HTML fallback for a missing AniList id is not ported.** The Kotlin
  scrapes the show page when the API omits it; here that is a named
  `SourceChangedError`. Worth adding if it turns out to be common rather than a
  transient.
- **No live verification.** Nothing in this repository has been run against the
  real source. See the cassettes section.
