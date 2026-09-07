/**
 * Generates the `index.json` a kuro client fetches when a user adds this
 * repository.
 *
 * The index is a **claim**, not an authority: the host re-checks every field in
 * it against the archive's own `plugin.json` after downloading, and aborts on
 * disagreement. That is deliberate — an index that under-reports a plugin's
 * permissions would otherwise be enough to get consent for one thing and
 * install another.
 *
 * What it carries is exactly what the consent screen needs, so a user can
 * decide *before* anything is downloaded. `permissions` and `hosts` above all:
 * "this may talk to these six hosts and nothing else" is the sentence that
 * makes an informed answer possible, and asking after the download is asking
 * too late.
 *
 * `contract/plugin-api/REPOSITORY.md` in the kuro repository is the spec.
 */

import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Manifest } from './validate';

export interface IndexEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly author: string;
	readonly license: string;
	readonly kuroPluginApi: number;
	readonly minimumKuroVersion: string;
	readonly platforms: readonly string[];
	readonly capabilities: readonly string[];
	readonly permissions: readonly string[];
	readonly hosts: readonly string[];
	readonly language?: string;
	readonly download: string;
	readonly sha256: string;
	readonly size: number;
}

export interface RepositoryIndex {
	readonly schemaVersion: 1;
	readonly name: string;
	readonly updatedAt: string;
	readonly signingKey?: string;
	readonly plugins: readonly IndexEntry[];
}

export interface BuildIndexOptions {
	readonly pluginsDirectory: string;
	readonly distDirectory: string;
	/** Where the archives will be served from; `download` is built against it. */
	readonly baseUrl: string;
	readonly name: string;
	/** PEM public key, pinned by clients on first add. */
	readonly publicKeyPem?: string;
	/** Overrides the date stamp, so a build can be reproducible. */
	readonly updatedAt?: string;
}

/**
 * Builds the index from the archives already in `dist/`.
 *
 * From the **archives**, not from the source tree: the index describes what is
 * actually downloadable, and generating it from `plugins/` would happily
 * publish an entry for a version nobody packaged.
 */
export function buildIndex(options: BuildIndexOptions): RepositoryIndex {
	if (!existsSync(options.distDirectory)) {
		throw new Error(`No ${options.distDirectory}. Run \`kuro package\` first.`);
	}

	const archives = readdirSync(options.distDirectory)
		.filter((file) => file.endsWith('.kuroplugin'))
		.sort();

	if (archives.length === 0) {
		throw new Error(`No .kuroplugin archives in ${options.distDirectory}.`);
	}

	// Newest version per plugin id. A repository serving two versions of one
	// plugin has no way to say which is current, and a client picking
	// arbitrarily is a client that downgrades people at random.
	const latest = new Map<string, IndexEntry>();

	for (const archive of archives) {
		const archivePath = join(options.distDirectory, archive);
		const bytes = readFileSync(archivePath);
		const entrypoint = basename(archive).replace(/-\d.*$/, '');
		const manifestPath = join(options.pluginsDirectory, entrypoint, 'plugin.json');

		if (!existsSync(manifestPath)) {
			throw new Error(
				`${archive} has no source at ${manifestPath}. ` +
					'Delete the stale archive, or re-package the plugin.'
			);
		}
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

		const entry: IndexEntry = {
			id: manifest.id ?? '',
			name: manifest.name ?? '',
			description: manifest.description ?? '',
			version: manifest.version ?? '',
			author: (manifest.author as { name?: string } | undefined)?.name ?? 'unknown',
			license: manifest.license ?? '',
			kuroPluginApi: manifest.kuroPluginApi ?? 1,
			minimumKuroVersion: manifest.minimumKuroVersion ?? '0.0.0',
			platforms: manifest.platforms ?? [],
			capabilities: manifest.capabilities ?? [],
			permissions: manifest.permissions ?? [],
			hosts: manifest.network?.hosts ?? [],
			...(manifest.language === undefined ? {} : { language: manifest.language as string }),
			download: `${options.baseUrl.replace(/\/+$/, '')}/${archive}`,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			size: statSync(archivePath).size
		};

		const existing = latest.get(entry.id);
		if (existing === undefined || compareSemver(entry.version, existing.version) > 0) {
			latest.set(entry.id, entry);
		}
	}

	// SPKI, base64, no PEM armour: the host pins these bytes, and stripping the
	// header lines here means the two sides never disagree about whitespace.
	const signingKey =
		options.publicKeyPem === undefined
			? undefined
			: createPublicKey(options.publicKeyPem).export({ type: 'spki', format: 'der' }).toString('base64');

	return {
		schemaVersion: 1,
		name: options.name,
		updatedAt: options.updatedAt ?? new Date().toISOString().slice(0, 10),
		...(signingKey === undefined ? {} : { signingKey }),
		plugins: [...latest.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
	};
}

export function writeIndex(index: RepositoryIndex, path: string): void {
	writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
}

/** Numeric SemVer ordering; pre-release tags sort below their release. */
function compareSemver(a: string, b: string): number {
	const parse = (value: string) => {
		const [core = '', pre] = value.split('-', 2);
		const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
		return { parts, pre };
	};
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < 3; i += 1) {
		const difference = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
		if (difference !== 0) return difference;
	}
	if (left.pre === right.pre) return 0;
	if (left.pre === undefined) return 1;
	if (right.pre === undefined) return -1;
	return left.pre < right.pre ? -1 : 1;
}
