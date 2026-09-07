/**
 * Manifest validation: the schema, plus the rules a JSON Schema cannot state.
 *
 * The split matters. `schema/kuro-plugin.schema.json` is the *published*
 * contract — a third party can validate against it with any JSON Schema tool,
 * in any language, without this package. What lives here is everything that
 * needs to look at two fields at once, or at the filesystem, which a schema by
 * construction cannot: does the declared entrypoint exist, does the directory
 * name match it, does a plugin claiming `resolve` actually export one, does a
 * plugin that needs a WebView claim a platform that has none.
 *
 * Every rule carries an `id` and a `because`. The id is what a maintainer
 * greps for; the `because` is what stops the rule being deleted the first time
 * it is inconvenient, because a rule whose reason is not written down loses
 * every argument it is ever in.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

export type Severity = 'error' | 'warning';

export interface Diagnostic {
	readonly id: string;
	readonly severity: Severity;
	readonly message: string;
	readonly because?: string;
}

export interface Manifest {
	readonly schemaVersion?: number;
	readonly id?: string;
	readonly name?: string;
	readonly description?: string;
	readonly version?: string;
	readonly license?: string;
	readonly kuroPluginApi?: number;
	readonly minimumKuroVersion?: string;
	readonly platforms?: readonly string[];
	readonly capabilities?: readonly string[];
	readonly permissions?: readonly string[];
	readonly entrypoint?: string;
	readonly icon?: string;
	readonly network?: { readonly hosts?: readonly string[] };
	readonly settings?: readonly {
		readonly id?: string;
		readonly type?: string;
		readonly default?: unknown;
		readonly options?: readonly { readonly value?: string }[];
	}[];
	readonly [key: string]: unknown;
}

/** The API level this tooling implements. */
export const KURO_PLUGIN_API = 1;

const PLATFORMS = ['android', 'ios', 'macos', 'windows', 'linux', 'web'];
const CAPABILITIES = ['search', 'episodes', 'resolve', 'browse'];
const PERMISSIONS = ['network', 'storage', 'webview', 'segment-transform-js'];

/** Platforms with no WebView, per AGENTS.md rule 10. */
const NO_WEBVIEW = ['macos', 'windows', 'linux'];

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const PLUGIN_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;
const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Validates a plugin directory. Returns every diagnostic, worst first. */
export function validatePlugin(directory: string): Diagnostic[] {
	const out: Diagnostic[] = [];
	const manifestPath = join(directory, 'plugin.json');

	if (!existsSync(manifestPath)) {
		return [
			{
				id: 'manifest_missing',
				severity: 'error',
				message: `No plugin.json in ${directory}.`
			}
		];
	}

	let manifest: Manifest;
	try {
		manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
	} catch (error) {
		return [
			{
				id: 'manifest_unparseable',
				severity: 'error',
				message: `plugin.json is not valid JSON: ${(error as Error).message}`
			}
		];
	}

	out.push(...validateManifest(manifest));
	out.push(...validateLayout(directory, manifest));

	return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** The manifest rules that need no filesystem. Exported so tests can use them. */
export function validateManifest(manifest: Manifest): Diagnostic[] {
	const out: Diagnostic[] = [];
	const error = (id: string, message: string, because?: string) =>
		out.push({ id, severity: 'error', message, ...(because === undefined ? {} : { because }) });
	const warn = (id: string, message: string, because?: string) =>
		out.push({ id, severity: 'warning', message, ...(because === undefined ? {} : { because }) });

	for (const field of [
		'schemaVersion',
		'id',
		'name',
		'description',
		'version',
		'author',
		'license',
		'kuroPluginApi',
		'minimumKuroVersion',
		'platforms',
		'capabilities',
		'permissions',
		'entrypoint'
	]) {
		if (manifest[field] === undefined) {
			error('required_field_missing', `plugin.json is missing "${field}".`);
		}
	}

	if (manifest.id !== undefined && !PLUGIN_ID.test(manifest.id)) {
		error(
			'id_malformed',
			`"${manifest.id}" is not a reverse-DNS id of at least three lowercase segments.`,
			'The id is written into every stored SourceBinding. Renaming it later orphans a user library silently.'
		);
	}

	for (const field of ['version', 'minimumKuroVersion'] as const) {
		const value = manifest[field];
		if (value !== undefined && !SEMVER.test(value)) {
			error('semver_malformed', `"${field}" ("${value}") is not strict SemVer 2.0.0.`);
		}
	}

	if (manifest.kuroPluginApi !== undefined && manifest.kuroPluginApi > KURO_PLUGIN_API) {
		error(
			'api_level_unsupported',
			`This plugin targets ABI level ${manifest.kuroPluginApi}; this tooling implements ${KURO_PLUGIN_API}.`
		);
	}

	for (const platform of manifest.platforms ?? []) {
		if (!PLATFORMS.includes(platform)) {
			error('platform_unknown', `"${platform}" is not a platform kuro ships.`);
		}
	}
	if ((manifest.platforms ?? []).length === 0) {
		error('platforms_empty', 'A plugin must claim at least one platform.');
	}

	for (const capability of manifest.capabilities ?? []) {
		if (!CAPABILITIES.includes(capability)) {
			error('capability_unknown', `"${capability}" is not a capability the host consumes.`);
		}
	}
	if (!(manifest.capabilities ?? []).includes('resolve')) {
		warn(
			'no_resolve_capability',
			'This plugin does not declare "resolve", so nothing it lists can be played.',
			'Legal — a catalogue-only source is a real thing — but almost always an oversight.'
		);
	}

	for (const permission of manifest.permissions ?? []) {
		if (!PERMISSIONS.includes(permission)) {
			error(
				'permission_unknown',
				`"${permission}" is not a permission this host grants.`,
				'An unknown permission is a load refusal, never a silent drop: a plugin that believes it has a capability it does not will make a request it thinks is authorised.'
			);
		}
	}

	if ((manifest.permissions ?? []).includes('segment-transform-js')) {
		error(
			'js_segment_transform_unimplemented',
			'"segment-transform-js" is specified at ABI level 1 and deliberately not implemented.',
			'It would put a JS engine in the path of every segment. On Android and Windows that is QuickJS behind a Dart FFI boundary, and an episode is hundreds of multi-megabyte segments — imperceptible on a laptop, unusable on a phone. Express the transform as ops instead.'
		);
	}

	const hosts = manifest.network?.hosts ?? [];
	if ((manifest.permissions ?? []).includes('network') && hosts.length === 0) {
		error(
			'network_hosts_missing',
			'This plugin requests the "network" permission but declares no hosts.',
			'ctx.http refuses every host not declared here, so the plugin cannot make a single request.'
		);
	}
	if (hosts.length > 0 && !(manifest.permissions ?? []).includes('network')) {
		error(
			'network_permission_missing',
			'network.hosts is declared but the "network" permission is not requested.'
		);
	}
	for (const host of hosts) {
		if (!HOST_PATTERN.test(host)) {
			error(
				'host_pattern_malformed',
				`"${host}" is not a hostname, optionally with a single leading "*." label.`,
				'A bare "*" is deliberately inexpressible: "this plugin may talk to anything" is not a thing a user can meaningfully consent to.'
			);
		}
	}

	if (
		(manifest.permissions ?? []).includes('webview') &&
		(manifest.platforms ?? []).some((platform) => NO_WEBVIEW.includes(platform))
	) {
		error(
			'webview_on_platform_without_one',
			`This plugin needs a WebView but claims ${manifest.platforms
				?.filter((p) => NO_WEBVIEW.includes(p))
				.join(', ')}, where PlatformCapabilities.hasWebView is false.`,
			'AGENTS.md rule 10. Claiming the platform anyway produces an install that succeeds and a flow that cannot run.'
		);
	}

	const seen = new Set<string>();
	for (const setting of manifest.settings ?? []) {
		if (setting.id === undefined) {
			error('setting_id_missing', 'A settings entry has no id.');
			continue;
		}
		if (seen.has(setting.id)) {
			error('setting_id_duplicated', `Two settings share the id "${setting.id}".`);
		}
		seen.add(setting.id);

		if (setting.type === 'select' || setting.type === 'multiselect') {
			const values = (setting.options ?? []).map((option) => option.value);
			if (values.length === 0) {
				error('setting_options_missing', `Setting "${setting.id}" is a ${setting.type} with no options.`);
			}
			// A default outside the options renders as a blank control the user
			// cannot restore once they change it.
			const defaults =
				setting.type === 'multiselect'
					? Array.isArray(setting.default)
						? (setting.default as string[])
						: []
					: setting.default === undefined
						? []
						: [setting.default as string];
			for (const value of defaults) {
				if (!values.includes(value)) {
					error(
						'setting_default_not_an_option',
						`Setting "${setting.id}" defaults to "${value}", which is not one of its options.`
					);
				}
			}
		}
	}

	return out;
}

/** Rules about files, which a schema cannot express. */
function validateLayout(directory: string, manifest: Manifest): Diagnostic[] {
	const out: Diagnostic[] = [];
	const error = (id: string, message: string, because?: string) =>
		out.push({ id, severity: 'error', message, ...(because === undefined ? {} : { because }) });

	if (manifest.entrypoint !== undefined && basename(directory) !== manifest.entrypoint) {
		error(
			'directory_name_mismatch',
			`Directory is "${basename(directory)}" but entrypoint is "${manifest.entrypoint}".`,
			'The archive filename is derived from the entrypoint, so a mismatch produces a bundle whose name does not match its directory and cannot be found by either.'
		);
	}

	for (const required of ['README.md', 'src/index.ts']) {
		if (!existsSync(join(directory, required))) {
			error('required_file_missing', `Missing ${required}.`);
		}
	}

	const licenses = join(directory, 'licenses');
	if (!existsSync(licenses) || readdirSync(licenses).length === 0) {
		error(
			'licenses_empty',
			'licenses/ is missing or empty.',
			'A bundle that redistributes code with no licence text is one nobody can legally mirror, which defeats the point of making plugins shareable.'
		);
	}

	const tests = join(directory, 'test');
	if (!existsSync(tests) || readdirSync(tests).length === 0) {
		error(
			'tests_missing',
			'test/ is missing or empty.',
			'A scraper with no recorded test has no way to notice the source changed, which is the failure this whole system exists to remove.'
		);
	}

	if (manifest.icon !== undefined && !existsSync(join(directory, manifest.icon))) {
		error('icon_file_missing', `Declared icon "${manifest.icon}" does not exist.`);
	}

	return out;
}
