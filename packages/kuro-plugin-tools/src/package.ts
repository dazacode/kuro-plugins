/**
 * Bundling, packaging and verification.
 *
 * A `.kuroplugin` is a **deterministic** ZIP carrying the built bundle, its
 * manifest byte-for-byte as written, a per-file hash manifest and a detached
 * signature. Packaging the same checkout twice produces identical bytes: entry
 * order is sorted, timestamps are fixed, and no field reads a clock. That is
 * what makes "the artefact I reviewed is the artefact you installed" a
 * checkable claim rather than a hope.
 *
 * **There is no encryption, and that is deliberate.** Code that runs on a
 * user's device cannot be secret from that user: to execute a plugin the host
 * must decrypt it, so the host must hold the key, so the key is on the machine
 * of the person you were hiding it from. Every "encrypted plugin" scheme
 * reduces to obfuscation with extra steps, and obfuscation mistaken for
 * security is worse than none, because it changes what people are willing to
 * put inside. The format buys the two properties that *are* achievable:
 *
 * - **Integrity** — SHA-256 per file plus a canonical digest. The bytes you run
 *   are the bytes that were packaged; corruption, a tampered mirror or a
 *   partial write are all detected before load.
 * - **Identity** — a detached Ed25519 signature over that digest. Not "this
 *   plugin is safe", but "this came from the holder of a known key".
 *
 * The third leg is the manifest's declared permissions, which a user can read
 * and the host enforces regardless of who signed what.
 *
 * Adapted from `dazacode/swayve-plugins`, whose packaging design this reuses
 * rather than re-derives.
 */

import { createHash, sign as signBytes, createPrivateKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { basename, join, relative } from 'node:path';

import { validatePlugin, type Manifest } from './validate';

/** Every archive entry carries this timestamp. See the file header. */
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x2100; // 1 Jan 1980, the ZIP epoch.

export interface PackageResult {
	readonly archivePath: string;
	readonly digest: string;
	readonly signed: boolean;
	readonly files: readonly string[];
}

/**
 * Builds a plugin's TypeScript into the single ES module the host loads.
 *
 * One file, no imports left to resolve, ES2020: the sandbox has no module
 * loader and no filesystem, and the three engines this runs on do not agree
 * about anything newer. `@kuro/plugin-sdk` is bundled in rather than treated as
 * external, because "external" would mean the host shipping a copy and the
 * plugin silently getting a different version than it compiled against.
 */
export async function bundlePlugin(directory: string): Promise<string> {
	const entry = join(directory, 'src', 'index.ts');
	const result = await Bun.build({
		entrypoints: [entry],
		target: 'browser',
		format: 'esm',
		minify: false,
		// Readable output is the point: a reviewer, and a user, can read what
		// they are about to run. Minifying would save bytes nobody is short of
		// and cost the only meaningful audit a third-party plugin ever gets.
		sourcemap: 'none'
	});

	if (!result.success) {
		const messages = result.logs.map((log: { message: string }) => log.message).join('\n');
		throw new Error(`Bundling failed:\n${messages}`);
	}
	const [artifact] = result.outputs;
	if (artifact === undefined) throw new Error('Bundling produced no output.');
	return artifact.text();
}

/**
 * Validates, bundles and writes `<entrypoint>-<version>.kuroplugin`.
 *
 * Validation runs first and there is no `--force`. A flag to package a plugin
 * that fails its own rules is a flag that will be used, and the rules exist
 * because each one names a way a plugin breaks after install rather than
 * before.
 */
export async function packagePlugin(
	directory: string,
	outputDirectory: string,
	privateKeyPem?: string
): Promise<PackageResult> {
	const diagnostics = validatePlugin(directory);
	const errors = diagnostics.filter((d) => d.severity === 'error');
	if (errors.length > 0) {
		throw new Error(
			`Refusing to package: ${errors.length} validation error(s).\n` +
				errors.map((d) => `  [${d.id}] ${d.message}`).join('\n')
		);
	}

	const manifestBytes = readFileSync(join(directory, 'plugin.json'));
	const manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest;
	const bundle = await bundlePlugin(directory);

	// `plugin.json` goes in byte-identical to the source file — not
	// re-serialised — so a reader can diff the archive's manifest against the
	// repository's and get an empty diff.
	const files = new Map<string, Buffer>([
		['plugin.json', manifestBytes],
		[`payload/${manifest.entrypoint}.js`, Buffer.from(bundle, 'utf8')],
		['payload/README.md', readFileSync(join(directory, 'README.md'))]
	]);

	for (const directoryName of ['licenses', 'assets', 'cassettes']) {
		const from = join(directory, directoryName);
		if (!existsSync(from)) continue;
		for (const file of walk(from)) {
			files.set(
				`${directoryName}/${relative(from, file).split('\\').join('/')}`,
				readFileSync(file)
			);
		}
	}

	// The canonical digest: every path and its hash, sorted, newline-joined,
	// hashed. Sorted because a map's iteration order is not a property anyone
	// should have to reason about, and the digest has to be reproducible from
	// the archive alone.
	const hashes: Record<string, string> = {};
	for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
		hashes[path] = createHash('sha256').update(bytes).digest('hex');
	}
	const digest = createHash('sha256')
		.update(
			Object.entries(hashes)
				.map(([path, hash]) => `${path}:${hash}`)
				.join('\n')
		)
		.digest('hex');

	files.set(
		'integrity.json',
		Buffer.from(`${JSON.stringify({ algorithm: 'sha256', files: hashes, digest }, null, 2)}\n`)
	);

	// Always present, even unsigned: an absent signature file is ambiguous —
	// it could mean unsigned, or stripped — while `{"signed": false}` is a
	// statement the verifier can act on.
	const signature =
		privateKeyPem === undefined
			? { signed: false as const }
			: {
					signed: true as const,
					algorithm: 'ed25519',
					digest,
					signature: signBytes(
						null,
						Buffer.from(digest, 'hex'),
						createPrivateKey(privateKeyPem)
					).toString('base64')
				};
	files.set('signature.json', Buffer.from(`${JSON.stringify(signature, null, 2)}\n`));

	mkdirSync(outputDirectory, { recursive: true });
	const archivePath = join(
		outputDirectory,
		`${manifest.entrypoint}-${manifest.version}.kuroplugin`
	);
	writeFileSync(archivePath, buildZip(files));

	// A sibling checksum in `sha256sum` format, so `sha256sum -c` works with no
	// tooling of ours involved at all.
	writeFileSync(
		`${archivePath}.sha256`,
		`${createHash('sha256').update(readFileSync(archivePath)).digest('hex')}  ${basename(archivePath)}\n`
	);

	return { archivePath, digest, signed: signature.signed, files: [...files.keys()].sort() };
}

/**
 * A minimal, deterministic ZIP writer.
 *
 * Written rather than taken from a dependency because determinism is the whole
 * requirement and every general-purpose zip library writes the current time
 * into every entry by default. Store-vs-deflate is chosen per file on whether
 * compression actually helps, so a small already-compressed asset does not grow.
 */
function buildZip(files: Map<string, Buffer>): Buffer {
	const entries = [...files].sort(([a], [b]) => (a < b ? -1 : 1));
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const [path, content] of entries) {
		const name = Buffer.from(path, 'utf8');
		const crc = crc32(content);
		const deflated = deflateRawSync(content, { level: 9 });
		const useDeflate = deflated.length < content.length;
		const stored = useDeflate ? deflated : content;
		const method = useDeflate ? 8 : 0;

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(FIXED_DOS_TIME, 10);
		local.writeUInt16LE(FIXED_DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(stored.length, 18);
		local.writeUInt32LE(content.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, stored);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(FIXED_DOS_TIME, 12);
		central.writeUInt16LE(FIXED_DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(stored.length, 20);
		central.writeUInt32LE(content.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.length + name.length + stored.length;
	}

	const centralDirectory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);

	return Buffer.concat([...locals, centralDirectory, end]);
}

let CRC_TABLE: Uint32Array | null = null;

function crc32(data: Buffer): number {
	if (CRC_TABLE === null) {
		CRC_TABLE = new Uint32Array(256);
		for (let i = 0; i < 256; i += 1) {
			let value = i;
			for (let bit = 0; bit < 8; bit += 1) {
				value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
			}
			CRC_TABLE[i] = value >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function* walk(directory: string): Generator<string> {
	for (const name of readdirSync(directory).sort()) {
		// Dotfiles never travel: `.DS_Store`, editor state and lockfiles are
		// noise that would change the digest without changing the plugin.
		if (name.startsWith('.')) continue;
		const path = join(directory, name);
		if (statSync(path).isDirectory()) yield* walk(path);
		else yield path;
	}
}
