# The manifest

`plugin.json` is what a viewer is shown before they install anything, and what
the host enforces while the plugin runs. It is not documentation.

The schema is published at [`schema/`](../schema/) — keep the `$schema` line and
your editor will autocomplete the rest and underline mistakes before you run
anything.

## What you fill in

```json
{
	"schemaVersion": 1,
	"id": "app.kuro.plugins.mysource",
	"name": "My Source",
	"description": "One paragraph on what this adds.",
	"version": "0.1.0",
	"author": { "name": "you" },
	"license": "Apache-2.0",
	"kuroPluginApi": 1,
	"minimumKuroVersion": "0.1.0",
	"platforms": ["android", "ios", "macos", "windows", "linux", "web"],
	"capabilities": ["search", "episodes", "resolve"],
	"permissions": ["network"],
	"entrypoint": "mysource",
	"language": "en",
	"network": { "hosts": ["api.mysource.test"] },
	"settings": []
}
```

| field           |                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | reverse-DNS, and it must equal the `id` your plugin exports. A mismatch refuses the plugin at load. Everything the host stores keys on it, so changing it later is a different plugin |
| `version`       | semver. The host compares it to decide whether an update exists                                                                                                                       |
| `capabilities`  | what your plugin implements. Add `browse` if you export `browse()`                                                                                                                    |
| `permissions`   | `network`, and `storage` if you use `ctx.storage`. Asking for one you do not use is a worse trade than it looks — it is shown to the viewer                                           |
| `platforms`     | leave all six unless something genuinely cannot work on one                                                                                                                           |
| `network.hosts` | see below                                                                                                                                                                             |
| `settings`      | what you want to ask a viewer — the host renders it                                                                                                                                   |

## `network.hosts`

```json
"network": { "hosts": ["api.mysource.test", "cdn.mysource.test"] }
```

A request to a host not on this list throws before a packet leaves. Not a
warning; the request does not happen, and the plugin cannot opt out because the
check is the host's.

Three things people get wrong:

- **Redirects count.** The host you land on is the host being reached.
- **CDNs count.** Streams served from another domain need it declared.
- **Subdomains are not implied.** Declare what you actually reach.

The reference plugin's suite asserts this with the same code the host uses, so
an undeclared host fails your tests rather than someone's install.

## `settings`

```json
"settings": [
	{
		"id": "audio",
		"type": "select",
		"label": "Preferred audio",
		"help": "Shown under the label. Optional.",
		"default": "sub",
		"options": [
			{ "value": "sub", "label": "Subtitled" },
			{ "value": "dub", "label": "Dubbed" }
		]
	},
	{ "id": "hide_filler", "type": "switch", "label": "Hide filler episodes", "default": false }
]
```

The field is `id`, and a boolean is `type: "switch"`.

Read them in a method:

```ts
const audio = ctx.settings.string('audio');
const hideFiller = ctx.settings.boolean('hide_filler');
```

You never draw the UI. The host renders these on all six platforms in its own
design tokens, which is why the declaration is data rather than a callback.

Values are resolved before your plugin starts and do not change under it.

### Prove a setting is actually read

A setting can be declared, delivered and ignored, and nothing fails — your
plugin keeps working on its default. The reference suite tests this by passing
values into the harness and asserting the _answer changes_:

```ts
const dub = pluginTest(ROOT, 'resolve', { audio: 'dub' });
```

If both runs produce identical output, the value is not being read, whatever
the manifest says.
