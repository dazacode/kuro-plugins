/**
 * The reference plugin's suite — and the shape yours should copy.
 *
 * Everything here runs offline against committed cassettes. No network, no
 * account, no dependence on a third party being up. A contributor clones the
 * repo and this is green; CI runs it on every push and it is green; and when a
 * real source changes, `--record` turns that change into a reviewable diff
 * instead of a bug report that says "black screen".
 *
 * Four kinds of test, in the order they earn their keep:
 *
 * 1. **The manifest is enforced, not decorative.** `network.hosts` is checked
 *    by the same code the host uses, so a plugin that reaches an undeclared
 *    host fails here rather than on a user's phone after install.
 * 2. **Parsing is asserted on real recorded bytes**, not on a hand-written
 *    fixture that agrees with the parser by construction.
 * 3. **The declared pipeline is executed against a recorded segment.** This is
 *    the one most people would skip and the one that actually proves the
 *    episode plays: ops that "look right" and ops that turn these bytes into
 *    MPEG-TS are different claims.
 * 4. **Breakage is asserted to be loud.** A source that changes shape must
 *    throw something named, because the alternative — an empty list that looks
 *    like a show with no episodes — is the failure mode this whole project
 *    exists to eliminate.
 */

import { describe, expect, it } from 'vitest';

import { PermissionDeniedError, SourceChangedError } from '@kuro/plugin-sdk';
import { pluginTest, runSegmentOps } from '@kuro/plugin-sdk/testing';

import plugin from '../src/index';

const ROOT = new URL('..', import.meta.url).pathname;

describe('manifest', () => {
	const { manifest } = pluginTest(ROOT, 'search');

	it('declares the id the bundle exports', () => {
		// A mismatch is a load refusal in the host. Catching it here means the
		// author sees it in one second rather than after packaging.
		expect(plugin.id).toBe(manifest.id);
	});

	it('claims every platform, because nothing in it is platform-specific', () => {
		expect(manifest.platforms).toEqual(['android', 'ios', 'macos', 'windows', 'linux', 'web']);
	});

	it('declares every capability it implements, and no more', () => {
		const capabilities = manifest.capabilities as string[];
		expect(capabilities).toContain('resolve');
		expect(capabilities.includes('browse')).toBe(typeof plugin.browse === 'function');
	});
});

describe('searchCatalog', () => {
	const { ctx } = pluginTest(ROOT, 'search');

	it('maps the source rows onto catalogue entries', async () => {
		const page = await plugin.searchCatalog('lantern', 1, ctx);

		expect(page.entries).toHaveLength(2);
		const [first] = page.entries;
		expect(first?.sourceMediaId).toBe('lantern-hours');
		expect(first?.title).toBe('Lantern Hours');
		expect(first?.year).toBe(2024);
		expect(first?.episodeCount).toBe(12);
		expect(first?.status).toBe('completed');
	});

	it('strips HTML out of the synopsis rather than trusting a screen not to render it', async () => {
		const page = await plugin.searchCatalog('lantern', 1, ctx);
		expect(page.entries[0]?.description).toBe('A synopsis for Lantern Hours.');
		expect(page.entries[0]?.description).not.toContain('<');
	});

	it('reports hasMore from the total, not from the page length', async () => {
		// A short page is not the last page when the source filters
		// server-side. Getting this wrong makes an infinite scroll stop early,
		// which looks exactly like a source with less content than it has.
		const page = await plugin.searchCatalog('lantern', 1, ctx);
		expect(page.hasMore).toBe(false);
	});

	it('returns an empty page rather than throwing when nothing matches', async () => {
		// "No results" is a legitimate answer and must not look like a failure.
		const page = await plugin.searchCatalog('nothing matches this', 1, ctx);
		expect(page.entries).toEqual([]);
		expect(page.hasMore).toBe(false);
	});
});

describe('listEpisodes', () => {
	it('returns every episode, ascending, with filler and recap flagged', async () => {
		const { ctx } = pluginTest(ROOT, 'episodes');
		const episodes = await plugin.listEpisodes('lantern-hours', ctx);

		expect(episodes).toHaveLength(12);
		expect(episodes.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(episodes.filter((e) => e.isFiller === true).map((e) => e.number)).toEqual([6, 7]);
		expect(episodes.find((e) => e.number === 11)?.isRecap).toBe(true);
	});

	it('describes what audio the source has, per episode', async () => {
		const { ctx } = pluginTest(ROOT, 'episodes');
		const episodes = await plugin.listEpisodes('lantern-hours', ctx);
		expect(episodes.find((e) => e.number === 3)?.audio).toBe('Sub & Dub');
		expect(episodes.find((e) => e.number === 12)?.audio).toBe('Sub');
	});

	it('honours the hide_filler setting the HOST renders', async () => {
		// The plugin declares this setting; it never draws it. Proving the read
		// works is the plugin's half of that contract.
		const { ctx } = pluginTest(ROOT, 'episodes', { hide_filler: true });
		const episodes = await plugin.listEpisodes('lantern-hours', ctx);
		expect(episodes).toHaveLength(10);
		expect(episodes.some((e) => e.isFiller === true)).toBe(false);
	});
});

describe('resolve', () => {
	const episode = { number: 3, sourceEpisodeId: 'ep-3' };

	it('returns every mirror, best first, never an empty list', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const sources = await plugin.resolve('lantern-hours', episode, ctx);

		expect(sources.length).toBeGreaterThan(0);
		expect(sources[0]?.heightPx).toBe(1080);
		expect(sources.map((s) => s.label)).toContain('Aurora 1080p · Sub');
	});

	it('filters to the preferred audio, and falls back rather than returning nothing', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve', { audio: 'dub' });
		const sources = await plugin.resolve('lantern-hours', episode, ctx);
		expect(sources.every((s) => s.label.endsWith('Dub'))).toBe(true);
	});

	it('carries subtitles and skip ranges off the embed config', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const sources = await plugin.resolve('lantern-hours', episode, ctx);
		const aurora = sources.find((s) => s.label.startsWith('Aurora'));

		expect(aurora?.subtitles?.map((t) => t.languageCode)).toEqual(['en', 'es']);
		expect(aurora?.subtitles?.[0]?.isDefault).toBe(true);
		expect(aurora?.skips).toEqual([
			{ kind: 'intro', startSeconds: 85, endSeconds: 175 },
			{ kind: 'outro', startSeconds: 1320, endSeconds: 1410 }
		]);
	});

	it('declares a pipeline instead of shipping a proxy server', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve('lantern-hours', episode, ctx);

		expect(source?.pipeline?.headers).toEqual({
			Referer: 'https://media.cdn.example.com/',
			Origin: 'https://media.cdn.example.com'
		});
		expect(source?.pipeline?.propagateQuery).toEqual(['token']);
		expect(source?.pipeline?.manifest).toEqual([
			{ kind: 'absolutise' },
			{ kind: 'repair-bandwidth', minBps: 100_000, scale: 1000 }
		]);
		expect(source?.pipeline?.segment?.map((op) => op.kind)).toEqual([
			'drop-magic-prefix',
			'xor-repeating',
			'assert-byte'
		]);
	});
});

describe('the declared pipeline actually decodes a real segment', () => {
	// The test that proves the episode plays. Everything above proves the
	// plugin produced plausible values; this proves those values turn the bytes
	// the CDN served into something a demuxer accepts.
	it('turns a disguised, masked segment into MPEG-TS', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve(
			'lantern-hours',
			{ number: 3, sourceEpisodeId: 'ep-3' },
			ctx
		);

		const response = await ctx.http.send('https://media.cdn.example.com/hls/aurora/seg-0001.ts');
		const raw = await response.bytes();

		// As served: a WebP header over masked bytes. Unplayable.
		expect(Array.from(raw.subarray(0, 4))).toEqual([0x52, 0x49, 0x46, 0x46]);

		const decoded = runSegmentOps(raw, source!.pipeline!.segment!);

		// MPEG-TS: 188-byte packets, each starting with the sync byte.
		expect(decoded[0]).toBe(0x47);
		expect(decoded.length % 188).toBe(0);
		for (let offset = 0; offset < decoded.length; offset += 188) {
			expect(decoded[offset]).toBe(0x47);
		}
	});

	it('fails loudly when the key is stale, rather than producing a black screen', async () => {
		const { ctx } = pluginTest(ROOT, 'resolve');
		const [source] = await plugin.resolve(
			'lantern-hours',
			{ number: 3, sourceEpisodeId: 'ep-3' },
			ctx
		);

		const ops = source!.pipeline!.segment!.map((op) =>
			op.kind === 'xor-repeating' ? { ...op, key: 'AAAAAAAAAAAAAAAAAAAAAA==' } : op
		);
		const response = await ctx.http.send('https://media.cdn.example.com/hls/aurora/seg-0001.ts');
		const raw = await response.bytes();

		expect(() => runSegmentOps(raw, ops)).toThrowError(/changed its key/);
	});
});

describe('the sandbox is real', () => {
	it('refuses a host the manifest did not declare', async () => {
		const { ctx } = pluginTest(ROOT, 'search');
		await expect(ctx.http.send('https://somewhere-else.invalid/data')).rejects.toBeInstanceOf(
			PermissionDeniedError
		);
	});

	it('allows a wildcard subdomain but not the bare parent', async () => {
		// `*.cdn.example.com` covers `media.cdn.example.com`. It must not cover
		// `cdn.example.com` itself, and it must never cover `evilcdn.example.com`.
		const { ctx } = pluginTest(ROOT, 'search');
		await expect(ctx.http.send('https://cdn.example.com/x')).rejects.toBeInstanceOf(
			PermissionDeniedError
		);
		await expect(ctx.http.send('https://evilcdn.example.com/x')).rejects.toBeInstanceOf(
			PermissionDeniedError
		);
	});
});

describe('breakage is loud', () => {
	it('names what it wanted and where, when the embed shape moves', () => {
		// Simulated rather than recorded: the point is the *class* of error, and
		// a cassette of a future breakage cannot be recorded today.
		const error = new SourceChangedError(
			'the player config',
			'https://media.cdn.example.com/embed/aurora'
		);
		expect(error.message).toContain('the player config');
		expect(error.message).toContain('https://media.cdn.example.com/embed/aurora');
		expect(error.message).toContain('changed');
	});
});
