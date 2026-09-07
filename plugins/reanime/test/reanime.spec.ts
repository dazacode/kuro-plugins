/**
 * Re:ANIME, offline.
 *
 * **The tapes in `cassettes/` are synthetic.** They were hand-built to the
 * shapes documented in the upstream Kotlin extension's `Dto.kt`, not recorded
 * from the live source, and they are marked as such rather than passed off as
 * real. What they prove is that the parsing, the settings, the failure
 * classification and — most importantly — the declared pipeline are correct
 * against those shapes.
 *
 * What they cannot prove is that the shapes are still current. For that:
 *
 * ```
 * bun run kuro test reanime --record
 * git diff plugins/reanime/cassettes
 * ```
 *
 * which replaces every tape with real traffic and shows exactly where the
 * source differs from what the Kotlin extension documented. That diff is the
 * point of the whole cassette mechanism, and it is a thing only someone with
 * the source reachable from their own network can run.
 */

import { describe, expect, it } from 'vitest';

import { NotFoundError, PermissionDeniedError, SourceChangedError } from '@kuro/plugin-sdk';
import { pluginTest, runSegmentOps } from '@kuro/plugin-sdk/testing';

import plugin from '../src/index';

const ROOT = new URL('..', import.meta.url).pathname;
const MASK = [157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197];

describe('manifest', () => {
	const { manifest } = pluginTest(ROOT, 'search');

	it('exports the id it declares', () => {
		expect(plugin.id).toBe(manifest.id);
	});

	it('declares every host the plugin actually reaches', () => {
		// The sandbox refuses anything else, so an omission here is a plugin
		// that works in development and 403s after install.
		const hosts = (manifest.network as { hosts: string[] }).hosts;
		expect(hosts).toContain('flixcloud.cc');
		expect(hosts).toContain('enc-dec.app');
		expect(hosts.some((h) => h.startsWith('reanime.'))).toBe(true);
	});

	it('replaces the Android preference screen with host-rendered settings', () => {
		// Ten PreferenceScreen entries in the Kotlin original; the same choices
		// here as descriptors, drawn by the host on all six platforms.
		const ids = (manifest.settings as { id: string }[]).map((s) => s.id);
		expect(ids).toEqual([
			'domain',
			'title_language',
			'latest_type',
			'quality',
			'audio',
			'server',
			'excluded_servers',
			'excluded_audio',
			'hide_filler'
		]);
	});
});

describe('searchCatalog', () => {
	it('maps results and reports pagination from the total', async () => {
		const { ctx } = pluginTest(ROOT, 'search');
		const page = await plugin.searchCatalog('lantern', 1, ctx);

		expect(page.entries).toHaveLength(2);
		expect(page.entries[0]?.sourceMediaId).toBe('lantern-hours');
		expect(page.entries[0]?.status).toBe('completed');
		expect(page.entries[1]?.status).toBe('ongoing');
		expect(page.hasMore).toBe(false);
	});

	it('honours the title language setting', async () => {
		const romaji = pluginTest(ROOT, 'search', { title_language: 'romaji' });
		const english = pluginTest(ROOT, 'search', { title_language: 'english' });

		expect((await plugin.searchCatalog('lantern', 1, romaji.ctx)).entries[1]?.title).toBe(
			'Lantern Hours II'
		);
		expect((await plugin.searchCatalog('lantern', 1, english.ctx)).entries[1]?.title).toBe(
			'Lantern Hours 2'
		);
	});

	it('strips HTML from the synopsis', async () => {
		const { ctx } = pluginTest(ROOT, 'search');
		const page = await plugin.searchCatalog('lantern', 1, ctx);
		expect(page.entries[0]?.description).toBe('A synopsis.\nSecond line.');
	});

	it('skips a row with no usable title instead of inventing one', async () => {
		// A titleless row would otherwise become an unnamed card the user
		// cannot identify or match against metadata.
		const { ctx } = pluginTest(ROOT, 'search');
		expect((await plugin.searchCatalog('broken', 1, ctx)).entries).toEqual([]);
	});

	it('returns an empty page for no results rather than throwing', async () => {
		const { ctx } = pluginTest(ROOT, 'search');
		expect((await plugin.searchCatalog('zzzznothing', 1, ctx)).entries).toEqual([]);
	});
});

describe('listEpisodes', () => {
	it('returns every episode ascending, with filler and recap flagged', async () => {
		const { ctx } = pluginTest(ROOT, 'episodes');
		const episodes = await plugin.listEpisodes('lantern-hours', ctx);

		expect(episodes).toHaveLength(12);
		expect(episodes.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(episodes.filter((e) => e.isFiller === true).map((e) => e.number)).toEqual([6, 7]);
		expect(episodes.find((e) => e.number === 11)?.isRecap).toBe(true);
	});

	it('derives Sub/Dub from the high-water marks, not per episode', async () => {
		// The API reports "subbed up to 12, dubbed up to 8". Reading that as a
		// per-episode flag is the obvious wrong port and would label every
		// episode identically.
		const { ctx } = pluginTest(ROOT, 'episodes');
		const episodes = await plugin.listEpisodes('lantern-hours', ctx);
		expect(episodes.find((e) => e.number === 3)?.audio).toBe('Sub & Dub');
		expect(episodes.find((e) => e.number === 12)?.audio).toBe('Sub');
	});

	it('honours hide_filler', async () => {
		const { ctx } = pluginTest(ROOT, 'episodes', { hide_filler: true });
		expect(await plugin.listEpisodes('lantern-hours', ctx)).toHaveLength(10);
	});

	it('distinguishes "not aired yet" from "this plugin broke"', async () => {
		// A parsed-but-empty list is NotFound. A list that would not parse is
		// SourceChanged. Collapsing the two is how a breakage hides for weeks
		// behind "that show has no episodes".
		const { ctx } = pluginTest(ROOT, 'episodes');
		await expect(plugin.listEpisodes('unaired-show', ctx)).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe('resolve', () => {
	const episode = { number: 3, sourceEpisodeId: 'ep-3' };

	it('returns a mirror per server', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const sources = await plugin.resolve('lantern-hours', episode, ctx);

		expect(sources).toHaveLength(2);
		expect(sources.map((s) => s.label).sort()).toEqual(['Dub HD-2 · Softsub', 'Sub HD-1']);
	});

	it('points at the signing wrapper, carrying the real manifest URL', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve('lantern-hours', episode, ctx);

		expect(source?.url).toContain('enc-dec.app/api/parse-flixcloud');
		expect(source?.url).toContain(encodeURIComponent('flixcloud.cc/hls/s-abc/master.m3u8'));
		expect(source?.url).toContain('w_payload=wp-1');
	});

	it('carries subtitles and skip ranges', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve('lantern-hours', episode, ctx);

		expect(source?.subtitles?.map((t) => t.languageCode)).toEqual(['en', 'es']);
		expect(source?.subtitles?.[1]?.format).toBe('ass');
		expect(source?.skips).toEqual([
			{ kind: 'intro', startSeconds: 85, endSeconds: 175 },
			{ kind: 'outro', startSeconds: 1320, endSeconds: 1410 }
		]);
	});

	it('respects excluded servers', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve', { excluded_servers: ['HD-2'] });
		const sources = await plugin.resolve('lantern-hours', episode, ctx);
		expect(sources.every((s) => !s.label.includes('HD-2'))).toBe(true);
	});

	it('says so when settings have hidden everything', async () => {
		// Distinct from "no servers": the user did this, and the message has to
		// point at settings rather than at the source.
		const { ctx } = pluginTest(ROOT, 'resolve', { excluded_servers: ['HD-1', 'HD-2'] });
		await expect(plugin.resolve('lantern-hours', episode, ctx)).rejects.toThrowError(/settings/);
	});

	it('throws rather than returning an empty list when there are no servers', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		await expect(
			plugin.resolve('lantern-hours', { number: 99, sourceEpisodeId: 'ep-99' }, ctx)
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe('the pipeline replaces the proxy server', () => {
	const episode = { number: 3, sourceEpisodeId: 'ep-3' };

	it('scrapes the live XOR key out of the site bundle', async () => {
		// The key rotates. Reading it the way the site's own player does is the
		// only durable answer, and it is the reason `resolve` is JavaScript at
		// all rather than more declarations.
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve('lantern-hours', episode, ctx);

		const xor = source?.pipeline?.segment?.find((op) => op.kind === 'xor-repeating');
		expect(xor).toBeDefined();
		const key = Array.from(Buffer.from((xor as { key: string }).key, 'base64'));
		expect(key).toEqual(MASK);
	});

	it('persists the scraped key so a later fetch failure is survivable', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		await plugin.resolve('lantern-hours', episode, ctx);
		expect(await ctx.storage.get('flixcloud_xor_mask')).toBe(MASK.join(','));
	});

	it('declares both disguises, the guarded XOR and the sync-byte assertion', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve('lantern-hours', episode, ctx);
		const segment = source?.pipeline?.segment ?? [];

		expect(segment.map((op) => op.kind)).toEqual([
			'drop-magic-prefix',
			'xor-repeating',
			'assert-byte'
		]);
		expect((segment[0] as unknown as { cases: unknown[] }).cases).toHaveLength(2);
		// Without the guard, the plain segments this CDN mixes in get corrupted.
		expect((segment[1] as unknown as { unlessByte?: unknown }).unlessByte).toEqual({
			at: 0,
			equals: 0x47
		});
	});

	it('repairs the manifest the three ways this CDN needs', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve('lantern-hours', episode, ctx);

		expect(source?.pipeline?.manifest?.map((fix) => fix.kind)).toEqual([
			'rebase-from-query',
			'absolutise',
			'repair-bandwidth'
		]);
		expect(source?.pipeline?.propagateQuery).toEqual(['token']);
	});

	it('gives the signing endpoint its own origin rather than the CDN one', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve('lantern-hours', episode, ctx);

		expect(source?.pipeline?.headers).toMatchObject({ Origin: 'https://flixcloud.cc' });
		expect(source?.pipeline?.headersByHost?.['enc-dec.app']).toEqual({
			Origin: 'https://enc-dec.app',
			Referer: 'https://enc-dec.app/'
		});
	});

	it('actually decodes a segment shaped the way this CDN serves them', async () => {
		// The claim that matters: these ops turn what the CDN sends into what a
		// demuxer accepts. Everything above only proves the ops look right.
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve('lantern-hours', episode, ctx);

		const body = Uint8Array.from({ length: 1128 }, (_, i) =>
			i % 188 === 0 ? 0x47 : (i * 37 + 11) & 0xff
		);
		const masked = body.map((b, i) => b ^ (MASK[i % 16] as number));
		const served = Uint8Array.from([
			...Buffer.from('RIFF'),
			0,
			0,
			0,
			0,
			...Buffer.from('WEBP'),
			...masked
		]);

		const decoded = runSegmentOps(served, source?.pipeline?.segment ?? []);
		expect(Array.from(decoded)).toEqual(Array.from(body));
		for (let at = 0; at < decoded.length; at += 188) expect(decoded[at]).toBe(0x47);
	});

	it('fails with a sentence when the key is stale, not a black screen', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve('lantern-hours', episode, ctx);
		const wrong = (source?.pipeline?.segment ?? []).map((op) =>
			op.kind === 'xor-repeating' ? { ...op, key: Buffer.alloc(16).toString('base64') } : op
		);
		const served = Uint8Array.from([...Buffer.from('RIFF    WEBP'), 1, 2, 3]);

		expect(() => runSegmentOps(served, wrong)).toThrowError(/rotated its key/);
	});
});

describe('the sandbox holds', () => {
	it('refuses a host the manifest never declared', async () => {
		const { ctx } = pluginTest(ROOT, 'search');
		await expect(ctx.http.send('https://cdn.evil.invalid/x')).rejects.toBeInstanceOf(
			PermissionDeniedError
		);
	});

	it('names the URL when a shape it depends on is gone', () => {
		const error = new SourceChangedError('the embed payload', 'https://flixcloud.cc/e/aaa111');
		expect(error.message).toContain('the embed payload');
		expect(error.message).toContain('flixcloud.cc/e/aaa111');
	});
});
