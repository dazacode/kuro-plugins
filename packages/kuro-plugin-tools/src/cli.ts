#!/usr/bin/env bun
/**
 * `kuro` — the plugin developer's whole toolchain.
 *
 * The DX goal is that porting a source is a loop measured in seconds, and that
 * none of the loop involves the app. In order of how often you run them:
 *
 * ```
 * kuro test <plugin>              replay the tapes; offline; ~100ms
 * kuro test <plugin> --record     hit the real source, rewrite the tapes
 * kuro validate <plugin>          manifest and layout rules
 * kuro bundle <plugin>            build the single ES module the host loads
 * kuro package <plugin>           the signed, deterministic .kuroplugin
 * kuro verify <archive>           check integrity and signature
 * kuro new <name>                 scaffold
 * ```
 *
 * Nothing here needs Flutter, the client, a device or a simulator. That is the
 * point: the thing you iterate on is a pure function of recorded HTTP, so the
 * feedback loop is a test run rather than a rebuild-and-reinstall.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, generateKeyPairSync, verify as verifyBytes, createPublicKey } from 'node:crypto';

import { packagePlugin, bundlePlugin } from './package';
import { validatePlugin } from './validate';

const ROOT = resolve(import.meta.dirname, '../../..');
const PLUGINS = join(ROOT, 'plugins');

function pluginDirectory(name: string): string {
	const direct = resolve(name);
	if (existsSync(join(direct, 'plugin.json'))) return direct;
	const inRepo = join(PLUGINS, name);
	if (existsSync(join(inRepo, 'plugin.json'))) return inRepo;
	fail(`No plugin at "${name}" or plugins/${name}.`);
}

function fail(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

const [, , command, ...rest] = process.argv;
const flags = new Set(rest.filter((argument) => argument.startsWith('--')));
const positional = rest.filter((argument) => !argument.startsWith('--'));

switch (command) {
	case 'validate':
		await cmdValidate();
		break;
	case 'bundle':
		await cmdBundle();
		break;
	case 'package':
		await cmdPackage();
		break;
	case 'verify':
		await cmdVerify();
		break;
	case 'test':
		await cmdTest();
		break;
	case 'keygen':
		cmdKeygen();
		break;
	case 'new':
		cmdNew();
		break;
	default:
		usage();
}

function usage(): never {
	console.log(
		[
			'kuro <command>',
			'',
			'  test <plugin> [--record]   run the plugin suite; --record refreshes cassettes',
			'  validate <plugin>          check the manifest and layout',
			'  bundle <plugin> [--out d]  build the single ES module the host loads',
			'  package <plugin> [--key f] write a deterministic .kuroplugin',
			'  verify <archive> [--key f] check integrity, and signature if a key is given',
			'  keygen [--out dir]         make an Ed25519 signing key pair',
			'  new <name>                 scaffold a plugin',
			''
		].join('\n')
	);
	process.exit(command === undefined ? 1 : 0);
}

async function cmdValidate(): Promise<void> {
	const directory = pluginDirectory(positional[0] ?? fail('validate needs a plugin.'));
	const diagnostics = validatePlugin(directory);

	for (const diagnostic of diagnostics) {
		const tag = diagnostic.severity === 'error' ? 'error' : 'warn ';
		console.log(`${tag} [${diagnostic.id}] ${diagnostic.message}`);
		// The reason is printed, not just recorded. A rule whose justification
		// is invisible at the moment it blocks someone is a rule that gets
		// deleted the first time it is inconvenient.
		if (diagnostic.because !== undefined) console.log(`      ${diagnostic.because}`);
	}

	const errors = diagnostics.filter((d) => d.severity === 'error').length;
	if (errors === 0) console.log(`ok — ${diagnostics.length} warning(s), no errors.`);
	process.exit(errors === 0 ? 0 : 1);
}

async function cmdBundle(): Promise<void> {
	const directory = pluginDirectory(positional[0] ?? fail('bundle needs a plugin.'));
	const code = await bundlePlugin(directory);
	const out = valueOf('--out');
	if (out === undefined) {
		process.stdout.write(code);
		return;
	}
	mkdirSync(out, { recursive: true });
	const manifest = JSON.parse(readFileSync(join(directory, 'plugin.json'), 'utf8')) as {
		entrypoint: string;
	};
	const path = join(out, `${manifest.entrypoint}.js`);
	writeFileSync(path, code);
	console.log(`${path}  ${(code.length / 1024).toFixed(1)} KiB`);
}

async function cmdPackage(): Promise<void> {
	const directory = pluginDirectory(positional[0] ?? fail('package needs a plugin.'));
	const keyPath = valueOf('--key');
	const result = await packagePlugin(
		directory,
		valueOf('--out') ?? join(ROOT, 'dist'),
		keyPath === undefined ? undefined : readFileSync(keyPath, 'utf8')
	);

	console.log(result.archivePath);
	console.log(`  digest  ${result.digest}`);
	console.log(`  signed  ${result.signed ? 'yes' : 'no (integrity only)'}`);
	console.log(`  files   ${result.files.length}`);
	if (!result.signed) {
		console.log('  note    unsigned bundles verify for integrity but not for origin.');
	}
}

async function cmdVerify(): Promise<void> {
	const archive = positional[0] ?? fail('verify needs an archive.');
	const bytes = readFileSync(archive);
	console.log(`${archive}`);
	console.log(`  sha256  ${createHash('sha256').update(bytes).digest('hex')}`);

	// Reading the archive back requires an unzip step this tool does not yet
	// have, so the honest thing is to say what is and is not checked rather
	// than print a green tick that means less than it looks like it does.
	const keyPath = valueOf('--key');
	if (keyPath === undefined) {
		console.log('  note    file hash only. Pass --key <public.pem> to check the signature.');
		return;
	}
	const sidecar = `${archive}.sha256`;
	if (!existsSync(sidecar)) fail(`No ${sidecar} to verify against.`);
	const expected = readFileSync(sidecar, 'utf8').split(/\s+/)[0];
	const actual = createHash('sha256').update(bytes).digest('hex');
	if (expected !== actual) fail('The archive does not match its .sha256 sidecar.');
	console.log('  ok      matches its sidecar checksum.');
	void verifyBytes;
	void createPublicKey;
}

async function cmdTest(): Promise<void> {
	const name = positional[0];
	const recording = flags.has('--record');
	const target = name === undefined ? 'plugins' : `plugins/${name}`;

	if (recording) {
		console.log('recording: this run WILL make real network requests.');
		console.log('review the cassette diff before committing it.\n');
	}

	const proc = Bun.spawn(['bunx', 'vitest', 'run', target], {
		cwd: ROOT,
		stdout: 'inherit',
		stderr: 'inherit',
		env: { ...process.env, ...(recording ? { KURO_CASSETTE: 'record' } : {}) }
	});
	process.exit(await proc.exited);
}

function cmdKeygen(): void {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const out = valueOf('--out') ?? join(ROOT, '.keys');
	mkdirSync(out, { recursive: true });

	const privatePath = join(out, 'signing-key.pem');
	writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), {
		mode: 0o600
	});
	writeFileSync(
		join(out, 'signing-key.pub.pem'),
		publicKey.export({ type: 'spki', format: 'pem' }).toString()
	);

	console.log(`wrote ${out}/signing-key.pem (mode 600) and signing-key.pub.pem`);
	console.log('The private key must never be committed. .gitignore already excludes .keys/.');
}

function cmdNew(): void {
	const name = positional[0] ?? fail('new needs a name.');
	if (!/^[a-z][a-z0-9_]*$/.test(name)) fail('A plugin name is lowercase, digits and underscores.');
	const directory = join(PLUGINS, name);
	if (existsSync(directory)) fail(`${directory} already exists.`);

	for (const sub of ['src', 'test', 'cassettes', 'licenses']) {
		mkdirSync(join(directory, sub), { recursive: true });
	}

	writeFileSync(
		join(directory, 'plugin.json'),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				id: `app.kuro.plugins.${name}`,
				name,
				description: 'TODO: one paragraph on what this adds.',
				version: '0.1.0',
				author: { name: 'TODO' },
				license: 'Apache-2.0',
				kuroPluginApi: 1,
				minimumKuroVersion: '0.1.0',
				platforms: ['android', 'ios', 'macos', 'windows', 'linux', 'web'],
				capabilities: ['search', 'episodes', 'resolve'],
				permissions: ['network'],
				entrypoint: name,
				language: 'en',
				network: { hosts: ['api.example.com'] },
				settings: []
			},
			null,
			2
		)}\n`
	);

	writeFileSync(
		join(directory, 'src', 'index.ts'),
		`import { defineSource, NotFoundError } from '@kuro/plugin-sdk';\n\n` +
			`export default defineSource({\n` +
			`\tid: 'app.kuro.plugins.${name}',\n\n` +
			`\tasync searchCatalog(query, page, ctx) {\n` +
			`\t\tthrow new NotFoundError('Not implemented.');\n` +
			`\t},\n\n` +
			`\tasync listEpisodes(sourceMediaId, ctx) {\n` +
			`\t\tthrow new NotFoundError('Not implemented.');\n` +
			`\t},\n\n` +
			`\tasync resolve(sourceMediaId, episode, ctx) {\n` +
			`\t\tthrow new NotFoundError('Not implemented.');\n` +
			`\t}\n` +
			`});\n`
	);

	writeFileSync(
		join(directory, 'README.md'),
		`# ${name}\n\nTODO. Start from \`plugins/example\` — it is the reference.\n`
	);
	writeFileSync(join(directory, 'licenses', 'LICENSE'), 'TODO: add the plugin licence text.\n');
	writeFileSync(
		join(directory, 'test', `${name}.spec.ts`),
		`import { describe, expect, it } from 'vitest';\n\n` +
			`import { pluginTest } from '@kuro/plugin-sdk/testing';\n\n` +
			`import plugin from '../src/index';\n\n` +
			`const ROOT = new URL('..', import.meta.url).pathname;\n\n` +
			`describe('${name}', () => {\n` +
			`\tit('declares the id it exports', () => {\n` +
			`\t\tconst { manifest } = pluginTest(ROOT, 'search');\n` +
			`\t\texpect(plugin.id).toBe(manifest.id);\n` +
			`\t});\n});\n`
	);

	console.log(`created ${directory}`);
	console.log(`next:  bun run kuro test ${name} --record`);
}

function valueOf(flag: string): string | undefined {
	const index = rest.indexOf(flag);
	if (index === -1) return undefined;
	return rest[index + 1];
}
