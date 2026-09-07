/**
 * Re:ANIME, ported from the Aniyomi Kotlin extension.
 *
 * This plugin is the proof that the design works, so it is worth being precise
 * about what the port actually cost. The original is **2,218 lines of Kotlin
 * across five files**, and 460 of those are `FlixProxyServer.kt` — a NanoHTTPD
 * HTTP server the extension starts inside the app process, binds to
 * `127.0.0.1`, and hands the player a URL to. It exists because the extension
 * API ends at a URL, and this CDN does not serve anything a player can open:
 *
 * - every HLS segment arrives with a fake `RIFF….WEBP` or PNG header glued on
 * - the payload underneath is XOR-masked with a 16-byte key scraped out of the
 *   site's own `hls.js` bundle at load time
 * - the master manifest is only fetchable through a signing wrapper
 * - `BANDWIDTH` is emitted in Kbps, so any player that believes it throttles
 *   its own buffer into permanent rebuffering
 *
 * Here, none of that is code. `resolve()` does the handshake — which is real
 * work, and is what JavaScript is for — and then *describes* the byte problem
 * as data. The host executes it natively: Dart on Android, iOS, macOS, Windows
 * and Linux; a `shaka-player` response filter in the browser. There is no
 * server, no socket, and nothing per-platform in this file.
 *
 * The ten Android `PreferenceScreen` entries became ten manifest `settings`
 * descriptors the host renders on all six surfaces. That code is gone too.
 *
 * **Third-party dependency, stated plainly:** the stream handshake goes through
 * an external signing service (`enc-dec.app`). That is the source's design, not
 * ours, and this plugin cannot avoid it — but it is somebody else's uptime in
 * the middle of playback, it is declared in `network.hosts` so a user sees it
 * before installing, and it is the first thing to suspect when every mirror
 * fails at once.
 */

import {
	defineSource,
	mapConcurrent,
	manifest as manifestFix,
	matchOne,
	NotFoundError,
	ops,
	optionalMatchOne,
	parseJson5,
	SourceChangedError,
	stripHtml,
	type CatalogPage,
	type PlaybackSource,
	type SkipRange,
	type SourceCatalogEntry,
	type SourceContext,
	type SourceEpisode,
	type SourceStatus,
	type SubtitleTrack
} from '@kuro/plugin-sdk';

import type {
	AnimeDetailDto,
	AnimeDto,
	EmbedDataDto,
	EpisodeListDto,
	LatestResponse,
	SearchResponse,
	StreamResponse,
	TokenResponse,
	VideoResponse,
	VideoServerDto
} from './dto';

const FLIX = 'https://flixcloud.cc';
const DEC_API = 'https://enc-dec.app/api';
const PAGE_SIZE = 36;

/** The MPEG-TS sync byte, and the proof that a segment decoded. */
const SYNC = 0x47;

/**
 * The XOR key to use when the site's bundle cannot be read.
 *
 * The key is normally scraped fresh on every resolve (see `resolveMask`); this
 * is the third fallback, behind the scrape and behind the last value we
 * persisted. Verified 2026-08-01 in the upstream Kotlin extension.
 *
 * To refresh by hand: open a video in a browser, search the loaded scripts for
 * `for(var f=[`, and copy the sixteen decimal numbers.
 */
const FALLBACK_MASK = new Uint8Array([
	157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197
]);

const STORAGE_MASK_KEY = 'flixcloud_xor_mask';

// Regexes are hoisted so a maintainer chasing a breakage finds every
// site-shaped assumption in one place rather than scattered through the logic.
// No lookbehind anywhere: QuickJS builds do not reliably support it, and this
// bundle runs on QuickJS on Android, Windows and Linux (ABI.md §6).
const EMBED_DATA = /type:\s*"data",\s*data:\s*(\{[\s\S]*?\})\s*,\s*uses:/;
const HLS_SCRIPT = /href="([^"]*hls\.js[^"]*)/;
const XOR_MASK = /for\(var f=\[(\d{1,3}(?:,\d{1,3}){15})\]/;

/** PNG's eight-byte signature, one of the two disguises this CDN uses. */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function baseUrl(ctx: SourceContext): string {
	return ctx.settings.string('domain') || 'https://reanime.to';
}

function apiUrl(ctx: SourceContext): string {
	return `${baseUrl(ctx)}/api/v1`;
}

/**
 * The headers the site's API expects.
 *
 * The `Sec-Fetch-*` trio is not decoration: the API rejects requests that do
 * not look like they came from its own page, and omitting them is the
 * difference between a working plugin and a 403 that looks like an IP ban.
 * They are forbidden header names in a browser, which is precisely why the
 * host — never this plugin — is the one that sends them.
 */
function apiHeaders(ctx: SourceContext, referer: string): Record<string, string> {
	return {
		Accept: 'application/json, text/plain, */*',
		'Accept-Language': 'en-US,en;q=0.9',
		Referer: referer,
		'Sec-Fetch-Dest': 'empty',
		'Sec-Fetch-Mode': 'cors',
		'Sec-Fetch-Site': 'same-origin'
	};
}

function parseStatus(status: string | null | undefined): SourceStatus {
	switch (status?.toUpperCase()) {
		case 'RELEASING':
			return 'ongoing';
		case 'FINISHED':
			return 'completed';
		default:
			return 'unknown';
	}
}

function preferredTitle(anime: AnimeDto, language: string): string | null {
	const titles = anime.title;
	if (titles == null) return null;
	const preferred =
		language === 'english' ? titles.english : language === 'native' ? titles.native : titles.romaji;
	return preferred || titles.romaji || titles.english || titles.native || null;
}

/**
 * Picks a poster, avoiding one particular metadata provider's `extraLarge`.
 *
 * That provider's "extra large" images are frequently *upscales* of a smaller
 * original, so the largest URL is the blurriest render. Preferring `large`
 * only for that host is inherited from the upstream extension and is exactly
 * the kind of knowledge that is invisible until someone notices the grid looks
 * soft on one row of shows.
 */
function poster(anime: AnimeDto): string | undefined {
	const cover = anime.cover_image;
	if (cover == null) return undefined;
	const upscaled = cover.extraLarge?.includes('tmdb.org') === true;
	const chosen = upscaled
		? (cover.large ?? cover.medium ?? cover.extraLarge)
		: (cover.extraLarge ?? cover.large ?? cover.medium);
	return chosen ?? undefined;
}

function toEntry(anime: AnimeDto, language: string): SourceCatalogEntry | null {
	const title = preferredTitle(anime, language);
	if (title === null) return null;

	const alternatives = [anime.title?.romaji, anime.title?.english, anime.title?.native].filter(
		(value): value is string => typeof value === 'string' && value.length > 0 && value !== title
	);

	const description = anime.description == null ? undefined : stripHtml(anime.description);
	const artwork = poster(anime);
	const detail = anime as AnimeDetailDto;

	return {
		sourceMediaId: anime.anime_id,
		title,
		...(alternatives.length > 0 ? { alternativeTitles: alternatives } : {}),
		...(artwork === undefined ? {} : { posterImageUrl: artwork }),
		...(description ? { description } : {}),
		...(anime.genres == null ? {} : { genres: anime.genres }),
		...(detail.seasonYear == null ? {} : { year: detail.seasonYear }),
		...(detail.episodes == null ? {} : { episodeCount: detail.episodes }),
		status: parseStatus(anime.status)
	};
}

/** The anilist id and audio counts this source keys its playback API on. */
interface AnimeMeta {
	readonly anilistId: number;
	readonly subbed: number;
	readonly dubbed: number;
}

/**
 * Fetches, and caches for the session, the metadata `resolve` needs.
 *
 * The playback endpoint is keyed on an *AniList* id, not the source's own
 * slug, so every resolve needs this lookup first. Caching it in `ctx.storage`
 * rather than in a module variable is deliberate: module state does not
 * survive the sandbox being torn down between calls, and two screens resolving
 * at once would each pay for their own fetch.
 */
async function animeMeta(sourceMediaId: string, ctx: SourceContext): Promise<AnimeMeta> {
	const cacheKey = `meta:${sourceMediaId}`;
	const cached = await ctx.storage.get(cacheKey);
	if (cached !== null) {
		try {
			return JSON.parse(cached) as AnimeMeta;
		} catch {
			// A corrupt cache entry is not worth a failed episode.
		}
	}

	const base = baseUrl(ctx);
	const url = `${apiUrl(ctx)}/anime/${encodeURIComponent(sourceMediaId)}`;
	const detail = await ctx.http.json<AnimeDetailDto>(url, {
		headers: apiHeaders(ctx, `${base}/anime/${sourceMediaId}`)
	});

	const anilistId = detail.anilist_id ?? 0;
	if (anilistId <= 0) {
		// Named, not silent. Without an AniList id there is no playback endpoint
		// to call, and returning an empty mirror list here would present as
		// "this episode has no servers" — which sends the user hunting through
		// settings for a problem that is upstream.
		throw new SourceChangedError('an anilist_id for this show', url);
	}

	const meta: AnimeMeta = {
		anilistId,
		subbed: detail.subbed ?? 0,
		dubbed: detail.dubbed ?? 0
	};
	await ctx.storage.set(cacheKey, JSON.stringify(meta));
	return meta;
}

function catalogPage(body: SearchResponse, language: string): CatalogPage {
	const entries: SourceCatalogEntry[] = [];
	for (const anime of body.results) {
		const entry = toEntry(anime, language);
		if (entry !== null) entries.push(entry);
	}
	return { entries, hasMore: body.offset + body.limit < body.total };
}

export default defineSource({
	id: 'app.kuro.plugins.reanime',

	async searchCatalog(query, page, ctx) {
		const base = baseUrl(ctx);
		const parameters = new URLSearchParams({
			limit: String(PAGE_SIZE),
			offset: String((page - 1) * PAGE_SIZE)
		});
		if (query.trim().length > 0) parameters.set('q', query);
		else parameters.set('sort', 'popularity_desc');

		const body = await ctx.http.json<SearchResponse>(`${apiUrl(ctx)}/search?${parameters}`, {
			headers: apiHeaders(ctx, `${base}/search`)
		});
		return catalogPage(body, ctx.settings.string('title_language'));
	},

	async browse(shelf, page, ctx, cursor) {
		const base = baseUrl(ctx);
		const language = ctx.settings.string('title_language');

		if (shelf !== 'latest') {
			const parameters = new URLSearchParams({
				sort: 'popularity_desc',
				limit: String(PAGE_SIZE),
				offset: String((page - 1) * PAGE_SIZE)
			});
			const body = await ctx.http.json<SearchResponse>(`${apiUrl(ctx)}/search?${parameters}`, {
				headers: apiHeaders(ctx, `${base}/search`)
			});
			return catalogPage(body, language);
		}

		// The latest shelf is cursor-paginated. The cursor travels through the
		// host on `CatalogPage.cursor` rather than living in a module variable,
		// which is what lets two screens page through this source at once
		// without stealing each other's position.
		const parameters = new URLSearchParams({
			limit: '12',
			lang: ctx.settings.string('latest_type')
		});
		if (page > 1 && cursor !== undefined) parameters.set('cursor', cursor);

		const body = await ctx.http.json<LatestResponse>(
			`${apiUrl(ctx)}/home/latest-aired?${parameters}`,
			{ headers: apiHeaders(ctx, `${base}/home`) }
		);

		const entries: SourceCatalogEntry[] = [];
		for (const anime of body.data) {
			const entry = toEntry(anime, language);
			if (entry !== null) entries.push(entry);
		}
		return {
			entries,
			hasMore: body.has_more === true,
			...(body.next_cursor == null ? {} : { cursor: body.next_cursor })
		};
	},

	async listEpisodes(sourceMediaId, ctx) {
		const base = baseUrl(ctx);
		const url = `${apiUrl(ctx)}/anime/${encodeURIComponent(sourceMediaId)}/episodes?limit=2000`;
		const body = await ctx.http.json<EpisodeListDto>(url, {
			headers: apiHeaders(ctx, `${base}/anime/${sourceMediaId}`)
		});

		if (!Array.isArray(body.data)) throw new SourceChangedError('an episode list', url);

		// Audio availability is a per-show high-water mark, not a per-episode
		// flag: the API says "dubbed up to episode 8", so an episode is dubbed
		// if its number is at or below that. Fetched best-effort — a missing
		// meta lookup costs the Sub/Dub label, not the episode.
		let meta: AnimeMeta | null = null;
		try {
			meta = await animeMeta(sourceMediaId, ctx);
		} catch {
			ctx.log.warn('audio counts unavailable; episode rows will not show Sub/Dub');
		}

		const hideFiller = ctx.settings.boolean('hide_filler');
		const language = ctx.settings.string('title_language');

		const episodes: SourceEpisode[] = [];
		for (const episode of body.data) {
			if (hideFiller && episode.is_filler === true) continue;

			const number = episode.episode_number;
			const title =
				(language === 'native'
					? episode.title_japanese
					: language === 'romaji'
						? episode.title_romanji
						: episode.title) ||
				episode.title ||
				undefined;

			const hasSub = meta !== null && number <= meta.subbed;
			const hasDub = meta !== null && number <= meta.dubbed;
			const audio =
				hasSub && hasDub ? 'Sub & Dub' : hasDub ? 'Dub' : hasSub ? 'Sub' : undefined;

			episodes.push({
				number,
				sourceEpisodeId: episode.episodeId ?? `ep-${Math.trunc(number)}`,
				...(title === undefined ? {} : { title }),
				...(episode.aired == null ? {} : { airedAt: episode.aired }),
				...(episode.is_filler === true ? { isFiller: true } : {}),
				...(episode.is_recap === true ? { isRecap: true } : {}),
				...(audio === undefined ? {} : { audio })
			});
		}

		if (episodes.length === 0) {
			// Distinguishable from a breakage: the request parsed, the list was
			// simply empty, which is what an unaired show looks like.
			throw new NotFoundError('This show has no episodes on this source yet.');
		}

		episodes.sort((a, b) => a.number - b.number);
		return episodes;
	},

	async resolve(sourceMediaId, episode, ctx) {
		const base = baseUrl(ctx);
		const meta = await animeMeta(sourceMediaId, ctx);
		const referer = `${base}/watch/${sourceMediaId}?ep=${episode.number}`;

		const body = await ctx.http.json<VideoResponse>(
			`${base}/api/flix/${meta.anilistId}/${episode.number}`,
			{ headers: apiHeaders(ctx, referer) }
		);

		if (!body.success || body.servers == null || body.servers.length === 0) {
			throw new NotFoundError(`No servers for episode ${episode.number}.`);
		}

		const excludedServers = new Set(ctx.settings.list('excluded_servers'));
		const excludedAudio = new Set(ctx.settings.list('excluded_audio'));
		const candidates = body.servers.filter((server) => {
			if (server.dataLink == null) return false;
			if (server.serverName != null && excludedServers.has(server.serverName)) return false;
			if (server.dataType != null && excludedAudio.has(server.dataType)) return false;
			return true;
		});

		if (candidates.length === 0) {
			throw new NotFoundError(
				'Every server for this episode is hidden by your settings for this source.'
			);
		}

		// The mask is scraped once per resolve and shared by every mirror. Doing
		// it per mirror would multiply an identical request by the number of
		// servers, on the click that the user is waiting on.
		const mask = await resolveMask(candidates, ctx);

		// Mirrors are independent, each needs its own multi-step handshake, and
		// a meaningful fraction are dead at any moment. Serially this is several
		// seconds before the player opens; unbounded it is a rate-limit on the
		// first click. A mirror that throws is dropped rather than fatal.
		const sources = await mapConcurrent(candidates, 3, (server) =>
			resolveServer(server, mask, referer, ctx)
		);

		if (sources.length === 0) {
			throw new NotFoundError(
				'No mirror for this episode could be opened. The source may be having trouble.'
			);
		}

		const preferredQuality = ctx.settings.string('quality');
		const preferredServer = ctx.settings.string('server');
		const preferredAudio = ctx.settings.string('audio');

		return sources.sort(
			(a, b) =>
				Number(b.quality === `${preferredQuality}p`) -
					Number(a.quality === `${preferredQuality}p`) ||
				Number(b.label.includes(preferredServer)) - Number(a.label.includes(preferredServer)) ||
				Number(b.label.toLowerCase().includes(preferredAudio)) -
					Number(a.label.toLowerCase().includes(preferredAudio)) ||
				(b.heightPx ?? 0) - (a.heightPx ?? 0)
		);
	}
});

/**
 * Finds the current segment mask, with two fallbacks.
 *
 * The site rotates this key and ships it inside its own `hls.js` bundle, so
 * the only durable way to have the right one is to read it the way the site's
 * player does. Three tiers, in order:
 *
 * 1. **Scrape it** from the bundle the embed page references, and persist it.
 * 2. **The last one we persisted**, if the scrape fails — a rotated key is
 *    rare, and a transient fetch failure is not, so the previous value is
 *    right far more often than it is wrong.
 * 3. **A compiled-in value**, so a first run with a flaky network still plays.
 *
 * When all three are stale the stream does not silently produce noise: the
 * `assert-byte` op at the end of the pipeline fails with a sentence.
 */
async function resolveMask(
	servers: readonly VideoServerDto[],
	ctx: SourceContext
): Promise<Uint8Array> {
	const probe = servers[0]?.dataLink;
	if (probe !== undefined && probe !== null) {
		try {
			const html = await ctx.http.text(probe, flixHeaders());
			const scriptPath = optionalMatchOne(HLS_SCRIPT, html);
			if (scriptPath !== null) {
				const scriptUrl = scriptPath.startsWith('http') ? scriptPath : `${FLIX}${scriptPath}`;
				const script = await ctx.http.text(scriptUrl, flixHeaders());
				const digits = optionalMatchOne(XOR_MASK, script);
				if (digits !== null) {
					const mask = Uint8Array.from(digits.split(',').map((value) => Number(value.trim()) & 0xff));
					if (mask.length === 16) {
						await ctx.storage.set(STORAGE_MASK_KEY, digits);
						return mask;
					}
				}
			}
		} catch {
			// Fall through. A failed scrape is a normal Tuesday.
		}
	}

	const saved = await ctx.storage.get(STORAGE_MASK_KEY);
	if (saved !== null) {
		const mask = Uint8Array.from(saved.split(',').map((value) => Number(value.trim()) & 0xff));
		if (mask.length === 16) {
			ctx.log.warn('using the previously saved segment key; the scrape failed');
			return mask;
		}
	}

	ctx.log.warn('using the compiled-in segment key; it may be stale');
	return FALLBACK_MASK;
}

function flixHeaders(): { headers: Record<string, string> } {
	return { headers: { Accept: '*/*', Origin: FLIX, Referer: `${FLIX}/` } };
}

/**
 * One mirror: embed page → signed token → decrypted stream URL → pipeline.
 *
 * This is the function that, in the original, ends by starting a web server.
 * Here it ends by returning a value.
 */
async function resolveServer(
	server: VideoServerDto,
	mask: Uint8Array,
	referer: string,
	ctx: SourceContext
): Promise<PlaybackSource> {
	const embedUrl = server.dataLink!;
	const html = await ctx.http.text(embedUrl, flixHeaders());

	// The player's configuration is embedded as near-JSON in the page. Missing
	// means the page's shape moved, which is a named, reportable failure rather
	// than an empty result that reads as "this mirror has nothing".
	const raw = matchOne(EMBED_DATA, html, 'the embed payload', embedUrl);
	const embed = parseJson5<EmbedDataDto>(raw, 'embed payload', embedUrl);

	const subtitles: SubtitleTrack[] = (embed.subtitles ?? []).map((track, index) => ({
		languageCode: track.language ?? 'und',
		label: track.language ?? 'Unknown',
		format: track.url.endsWith('.ass') ? 'ass' : track.url.endsWith('.srt') ? 'srt' : 'vtt',
		url: track.url,
		isDefault: index === 0
	}));

	const skips: SkipRange[] = [];
	if (embed.intro_chapter?.start != null && embed.intro_chapter.end != null) {
		skips.push({
			kind: 'intro',
			startSeconds: embed.intro_chapter.start,
			endSeconds: embed.intro_chapter.end
		});
	}
	if (embed.outro_chapter?.start != null && embed.outro_chapter.end != null) {
		skips.push({
			kind: 'outro',
			startSeconds: embed.outro_chapter.start,
			endSeconds: embed.outro_chapter.end
		});
	}

	// The signing service wants the payload without the presentation fields.
	// Sending them is not an error, but it changes the signed bytes, and the
	// upstream extension found the endpoint fussier than documented.
	const { subtitles: _s, intro_chapter: _i, outro_chapter: _o, ...signable } = embed;

	const token = await ctx.http.json<TokenResponse>(`${DEC_API}/dec-flixcloud?type=token`, {
		method: 'POST',
		headers: { Accept: '*/*', 'Content-Type': 'application/json' },
		body: JSON.stringify({ data: signable })
	});
	if (token.status !== 200 || token.result == null) {
		throw new SourceChangedError('a signing token', `${DEC_API}/dec-flixcloud?type=token`);
	}

	const streamResponse = await ctx.http.json<unknown>(
		`${FLIX}/api/m3u8/${token.result.token}`,
		flixHeaders()
	);

	const stream = await ctx.http.json<StreamResponse>(`${DEC_API}/dec-flixcloud?type=stream`, {
		method: 'POST',
		headers: { Accept: '*/*', 'Content-Type': 'application/json' },
		body: JSON.stringify({
			data: { context: token.result.context, stream_response: streamResponse }
		})
	});
	if (stream.status !== 200 || stream.result == null) {
		throw new SourceChangedError('a decrypted stream URL', `${DEC_API}/dec-flixcloud?type=stream`);
	}

	const payload = stream.result.context['w_payload'];
	if (typeof payload !== 'string') {
		throw new SourceChangedError('a w_payload in the stream context', embedUrl);
	}

	// The master manifest is only fetchable through the signing wrapper. Its
	// body still contains URIs relative to the *real* address, which is what
	// `rebaseFromQuery` below exists for.
	const master =
		`${DEC_API}/parse-flixcloud` +
		`?url=${encodeURIComponent(stream.result.stream)}` +
		`&w_payload=${encodeURIComponent(payload)}`;

	const label = [
		server.dataType === 'dub' ? 'Dub' : 'Sub',
		server.serverName ?? 'Mirror',
		server.softsub === true ? '· Softsub' : ''
	]
		.filter((part) => part.length > 0)
		.join(' ');

	return {
		url: master,
		container: 'hls',
		label,
		subtitles,
		...(skips.length > 0 ? { skips } : {}),

		// Four declarations, one 460-line NanoHTTPD server deleted.
		pipeline: {
			headers: { Accept: '*/*', Origin: FLIX, Referer: `${FLIX}/` },
			// The signing endpoint wants its own origin, not the CDN's. One flat
			// header map would have to pick one and hope the other tolerates it.
			headersByHost: {
				'enc-dec.app': { Origin: 'https://enc-dec.app', Referer: 'https://enc-dec.app/' }
			},
			// Segment URLs inherit the manifest's token when they lack one.
			propagateQuery: ['token'],
			manifest: [
				manifestFix.rebaseFromQuery('url'),
				manifestFix.absolutise(),
				manifestFix.repairBandwidth()
			],
			segment: [
				ops.dropMagicPrefix([
					{ magic: ctx.text.encode('RIFF'), drop: 12 },
					{ magic: PNG_MAGIC, drop: 8 }
				]),
				// `unlessByte` matters here: this CDN mixes disguised and plain
				// segments, and an unconditional XOR would corrupt the plain ones.
				ops.xorRepeating(mask, { at: 0, equals: SYNC }),
				ops.assertMpegTs(
					'This mirror stopped decoding — the source has probably rotated its key. Try another server.'
				)
			]
		}
	};
}
