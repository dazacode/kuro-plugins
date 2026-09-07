/**
 * One call to wire a plugin's whole test setup.
 *
 * Without this, every plugin's spec file opens with fifteen lines of loading a
 * manifest, opening a tape, building a context and threading a mode flag — and
 * fifteen lines copied into every plugin is fifteen lines that drift, so the
 * plugins end up tested slightly differently and the differences are invisible.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SourceContext } from '../context';
import type { SourceDefinition } from '../define';
import { Cassette } from './cassette';
import { fakeContext } from './fake-context';

export interface PluginTestKit {
	readonly ctx: SourceContext;
	readonly manifest: Record<string, unknown>;
	readonly cassette: Cassette;
	readonly logs: string[];
	/** Call in an `afterAll`; a no-op unless recording. */
	save(): void;
}

/**
 * Loads `plugin.json` and the named tape from a plugin directory.
 *
 * @param root      the plugin directory, usually `import.meta.dirname`
 * @param tape      tape name, one per scenario — `search`, `episodes`, `resolve`
 * @param settings  overrides, as a user would have set them
 */
export function pluginTest(
	root: string,
	tape: string,
	settings?: Readonly<Record<string, string | boolean | readonly string[]>>
): PluginTestKit {
	const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')) as Record<
		string,
		unknown
	> & {
		network?: { hosts: string[] };
		settings?: { id: string; default?: unknown }[];
	};
	const cassette = Cassette.open(join(root, 'cassettes', `${tape}.json`));
	const logs: string[] = [];
	const ctx = fakeContext({
		manifest,
		cassette,
		logs,
		...(settings === undefined ? {} : { settings })
	});
	return {
		ctx,
		manifest,
		cassette,
		logs,
		save: () => cassette.save()
	};
}

/** Narrows a dynamically imported bundle to the SDK's shape. */
export function asSource(module: unknown): SourceDefinition {
	return (module as { default: SourceDefinition }).default;
}
