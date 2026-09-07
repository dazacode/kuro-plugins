# kuro-plugins

The plugin platform for [kuro](https://github.com/dazacode/kuro): the SDK, the
tooling, and the plugins themselves.

A plugin teaches kuro about a content source it did not know about. It answers
three questions — *what shows do you have?*, *what episodes?*, *how do I play
one?* — and kuro renders the answers with the same screens it uses for
everything else. The plugin supplies **data**; the host supplies **experience**.

**kuro ships no sources and depends on no plugin.** Delete this entire
repository and the client still builds. That is what makes the client's rule 9
structural rather than a promise.

```bash
bun install
bun run kuro test example        # offline, ~100ms
bun run kuro validate reanime
bun run kuro package reanime
```

`bun` only — never `npm`, `npx`, `yarn` or `pnpm`.

---

## Layout

```
packages/kuro-plugin-sdk/     what a plugin imports. Types, ops, test harness.
packages/kuro-plugin-tools/   the `kuro` CLI. Reusable by anyone.
plugins/example/              the reference. Fully offline. Read this first.
plugins/reanime/              a real port, and the proof the design works.
schema/                       the published manifest schema
fixtures/                     the cross-language pipeline vectors
```

The SDK and the tools are separate packages on purpose: the tools are a
developer dependency and never reach a device, while the SDK is bundled into
every plugin. Mixing them would put a ZIP writer and a signing key loader
inside a sandbox that has neither a filesystem nor a use for them.

---

## The one idea

The extension format this replaces resolves an episode to
`Video(url, quality, headers)`. That is not enough, and the proof is that real
extensions ship **HTTP servers**: when a CDN serves bytes a player cannot open —
segments disguised as images, XOR-masked payloads, manifests that need
rewriting — an extension whose only output is a URL has no choice but to become
a localhost server and hand the player a `127.0.0.1` address.

That answer cannot exist in a browser, it means a plugin holds a listening
socket (so it is not sandboxed), and it gets reimplemented slightly differently
by every extension that needs it.

Here, `resolve()` returns a **pipeline**:

```ts
pipeline: {
  headers: { Referer: `${CDN}/`, Origin: CDN },
  manifest: [ absolutise(), repairBandwidth() ],
  segment: [
    dropMagicPrefix([{ magic: encode('RIFF'), drop: 12 }]),
    xorRepeating(mask, { at: 0, equals: 0x47 }),
    assertMpegTs('This mirror changed its key.')
  ]
}
```

Ops are **data**, computed once during `resolve()`. The host executes them
natively — Dart on Android, iOS, macOS, Windows and Linux; a `shaka-player`
response filter in the browser.

### Why data and not a callback

A `transformSegment(bytes)` callback would be more flexible and is the obvious
design. It is also the one that only works on the machine you develop on.

One bundle runs on **three JS engines**: QuickJS on Android, Windows and Linux;
JavaScriptCore on iOS and macOS; the browser's own on web. On the embedded two
the documented bottleneck is passing large buffers across the FFI boundary, and
an episode is several hundred segments of 2–10 MB each. That is imperceptible on
a laptop and ruinous on a phone — and completely invisible while you are
building it.

So JavaScript runs on the **metadata path**, once per episode, where it is
cheap and where the real work is. It never touches the **byte path**.

An escape hatch is specified — `permissions: ["segment-transform-js"]` — and is
deliberately unimplemented. The validator refuses a plugin that declares it.

---

## The DX loop

Nothing in the loop involves the app. No Flutter, no device, no simulator.

```bash
kuro new mysource               # scaffold
kuro test mysource --record     # hit the real source once, write cassettes
kuro test mysource              # replay, offline, forever
kuro validate mysource
kuro package mysource --key .keys/signing-key.pem
```

### Cassettes are the point

A plugin's tests record real traffic once and replay it forever. The tapes are
committed.

This is the answer to the worst property of every scraper ecosystem: **a source
changing produces no signal**. A selector stops matching, a payload gains a
field, and the plugin keeps returning plausible-looking nothing. Nobody finds
out until a user reports a black screen weeks later with no detail.

With cassettes, the same change is a failing test with a diff:

```bash
kuro test reanime --record
git diff plugins/reanime/cassettes    # <- exactly what the source changed
```

Recording redacts `Set-Cookie`, `Authorization` and friends before anything is
written, because a tape that leaked a session token is a tape nobody could
safely commit — and a workflow whose artefacts cannot be committed is the
workflow we already have.

---

## Distribution

A `.kuroplugin` is a deterministic ZIP: `plugin.json` byte-identical to source,
`integrity.json` (SHA-256 per file plus a canonical digest), `signature.json`
(detached Ed25519, present even when unsigned), `payload/`, `licenses/`.

Packaging the same checkout twice produces identical bytes.

**No encryption, deliberately.** Code that runs on a user's device cannot be
secret from that user: to execute a plugin the host must decrypt it, so the host
holds the key, so the key is on the machine of the person you were hiding it
from. Every "encrypted plugin" scheme is obfuscation with extra steps, and
obfuscation mistaken for security is worse than none because it changes what
people are willing to put inside.

What the format buys instead is **integrity** (the bytes you run are the bytes
that were packaged) and **identity** (it came from the holder of a known key).
Neither is confidentiality and neither pretends to be. The third leg is the
manifest's declared permissions, which a user can read and the host enforces
regardless of who signed what.

---

## Where things are specified

| Question | File |
| --- | --- |
| Why any of this | `kuro/docs/ADR-0002-plugin-system.md` |
| What a plugin is, normatively | `kuro/contract/plugin-api/ABI.md` |
| Manifest fields | `schema/kuro-plugin.schema.json` |
| Byte-op semantics | `fixtures/stream_pipeline.json` |
| How to port an existing extension | `docs/porting.md` |

`schema/` and `fixtures/` are copies of kuro's `contract/`. They have to be —
the two repositories are independent by design — and
`packages/kuro-plugin-tools/src/schema-sync.spec.ts` is the alarm that notices
when a copy goes stale.
