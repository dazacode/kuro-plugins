# When it goes wrong

## `No cassette at .../search.json. Record one with --record, then commit it.`

Either you have not recorded, or your recording wrote nothing.

The second is the common one. `save()` writes the tape, and it has to be called
on the harness your tests actually used:

```ts
const search = pluginTest(ROOT, 'search'); // module scope
afterAll(() => {
	search.save();
}); // saves the one that recorded
```

Building a fresh `pluginTest(...)` inside `afterAll` saves an empty tape over a
good one, and a tape with zero entries fails replay with this same message.

Check what you actually recorded:

```bash
cat plugins/mysource/cassettes/search.json | head -20
```

## `... reached <host>, which its manifest does not declare`

Add it to `network.hosts`. If it names a host you have never heard of, you were
redirected there — the host you land on is the one being reached.

## `SourceChangedError: wanted <thing> at <url>`

Your extraction stopped matching. That is the error doing its job: the source
changed shape and you found out from a test rather than from a user.

```bash
bun run kuro test mysource --record
git diff plugins/mysource/cassettes    # exactly what the source changed
```

## Tests pass, but the episode does not play

Almost always `container`, or a missing header.

- Check `container` against what the URL actually serves. `hls` for `.m3u8`,
  `dash` for `.mpd`, `mp4` for a progressive file. Wrong means "dead link".
- If the CDN needs a `Referer`, put it in `headers` on the `PlaybackSource`.
- If the bytes are disguised, `resolve` needs a `pipeline` — and you should
  assert it with `runSegmentOps` against a recorded segment, because ops that
  look right and ops that produce MPEG-TS are different claims.

## A setting that does nothing

Declared, saved, ignored — and nothing fails, because your plugin works on its
default.

Check the `id` in `ctx.settings.string('...')` against the manifest. Then prove
it by effect:

```ts
const dub = pluginTest(ROOT, 'resolve', { audio: 'dub' });
```

If the answer is identical either way, the value is not being read.

## `kuro validate` warns about permissions

You declared one you do not use, or use one you did not declare. `storage` is
the usual culprit. Permissions are shown to a viewer before they install, so an
unused one costs trust for nothing.

## It works in a script and not under `kuro test`

That is the point of the harness. A script has `fetch`, a filesystem, ambient
globals and no host allowlist. The sandbox has none of those, and the
difference is what would have broken on someone's phone.
