/**
 * The reference plugin. Read this before writing your own.
 *
 * It talks to `api.example.com`, which does not exist. Every response it needs
 * is a committed cassette, so this plugin's test suite is deterministic
 * forever, runs with no network, and can never break because somebody else's
 * website changed. That is deliberate: a reference that depended on a live
 * service would be red half the time and would teach you nothing on those days.
 *
 * The fictional API is shaped like the awkward ones on purpose — cursor-ish
 * pagination, a separate call for playable servers, an embed page with its
 * configuration wedged into a `<script>` tag as not-quite-JSON, and a CDN that
 * disguises its segments. If you can follow this file you can port a real
 * source, because the real ones are this with different names.
 *
 * The four things worth taking away:
 *
 * 1. **You never send a request.** `ctx.http` does, and only to hosts your
 *    manifest declared. There is no other way out.
 * 2. **You never draw UI.** `manifest.settings` is rendered by the host, on
 *    all six platforms, in its own design tokens. You read values.
 * 3. **You never touch a segment.** When a stream is not playable as served,
 *    you *describe* the fix with `ops` and the host executes it natively. See
 *    `resolve` below, and ADR-0002 §2.1 for why this is not negotiable.
 * 4. **Missing data is an event, not a value.** `matchOne` throws
 *    `SourceChangedError` naming what it wanted and where. Returning an empty
 *    list instead is how a broken plugin looks exactly like a show with no
 *    episodes.
 */

import {
	defineSource,
	mapConcurrent,
	matchOne,
	NotFoundError,
	ops,
	parseJson5,
	stripHtml,
	manifest as manifestFix,
	type CatalogPage,
	type PlaybackSource,
	type SourceCatalogEntry,
	type SourceContext,
	type SourceEpisode,
	type SubtitleTrack
} from '@kuro/plugin-sdk';

const API = 'https://api.example.com/v1';
const CDN = 'https://media.cdn.example.com';
const PER_PAGE = 24;

/** The shapes the fictional API returns. Declared, not inferred, so a change
 *  in the source shows up as a type error next to the parsing rather than as
 *  `undefined` three functions away. */
interface SearchResponse {
	readonly results: readonly ApiAnime[];
	readonly total: number;
	readonly page: number;
}

interface ApiAnime {
	readonly id: string;
	readonly title: string;
	readonly titles?: { readonly english?: string; readonly romaji?: string };
	readonly year?: number;
	readonly episodes?: number;
	readonly poster?: string;
	readonly synopsis?: string;
	readonly genres?: readonly string[];
	readonly status?: string;
}

interface EpisodeResponse {
	readonly episodes: readonly ApiEpisode[];
}

interface ApiEpisode {
	readonly n: number;
	readonly id: string;
	readonly title?: string;
	readonly aired?: string;
	readonly filler?: boolean;
	readonly recap?: boolean;
	readonly audio?: readonly string[];
}

interface ServerResponse {
	readonly servers: readonly ApiServer[];
}

interface ApiServer {
	readonly name: string;
	readonly embed: string;
	readonly type: 'sub' | 'dub';
}

/** The embed page's inline configuration, after `parseJson5`. */
interface EmbedConfig {
	readonly stream: string;
	/** Hex, because that is how the fictional site writes it. Sites do this. */
	readonly mask: string;
	readonly subtitles?: readonly { readonly url: string; readonly lang: string }[];
	readonly intro?: readonly [number, number];
	readonly outro?: readonly [number, number];
}

/** Headers the fictional API wants. Built once per call rather than inlined,
 *  because the day one of them changes you want one place to change it. */
function apiHeaders(referer: string): Record<string, string> {
	return {
		Accept: 'application/json',
		Referer: referer
	};
}

function toEntry(anime: ApiAnime): SourceCatalogEntry {
	const alternatives = [anime.titles?.english, anime.titles?.romaji].filter(
		(value): value is string => typeof value === 'string' && value.length > 0
	);
	return {
		sourceMediaId: anime.id,
		title: anime.title,
		...(alternatives.length > 0 ? { alternativeTitles: alternatives } : {}),
		...(anime.poster === undefined ? {} : { posterImageUrl: anime.poster }),
		// The host renders this as text; HTML from a source is a rendering bug
		// waiting for a screen that trusts it.
		...(anime.synopsis === undefined ? {} : { description: stripHtml(anime.synopsis) }),
		...(anime.year === undefined ? {} : { year: anime.year }),
		...(anime.episodes === undefined ? {} : { episodeCount: anime.episodes }),
		...(anime.genres === undefined ? {} : { genres: anime.genres }),
		status:
			anime.status === 'finished' ? 'completed' : anime.status === 'airing' ? 'ongoing' : 'unknown'
	};
}

async function page(url: string, referer: string, ctx: SourceContext): Promise<CatalogPage> {
	const body = await ctx.http.json<SearchResponse>(url, { headers: apiHeaders(referer) });
	return {
		entries: body.results.map(toEntry),
		// Computed from the total rather than from `results.length`: a source
		// that filters server-side returns short pages that are not the last
		// one, and an infinite scroll that stops early looks exactly like a
		// source with less content than it has.
		hasMore: body.page * PER_PAGE < body.total
	};
}

export default defineSource({
	id: 'app.kuro.plugins.example',

	async searchCatalog(query, pageNumber, ctx) {
		const url = `${API}/search?q=${encodeURIComponent(query)}&page=${pageNumber}`;
		return page(url, 'https://example.com/search', ctx);
	},

	async browse(shelf, pageNumber, ctx) {
		// Shelf names are the host's vocabulary, not the source's. A plugin
		// that only knows its own names gets no shelf at all.
		const sort = shelf === 'latest' ? 'recent' : 'popular';
		return page(`${API}/browse?sort=${sort}&page=${pageNumber}`, 'https://example.com/', ctx);
	},

	async listEpisodes(sourceMediaId, ctx) {
		const url = `${API}/anime/${encodeURIComponent(sourceMediaId)}/episodes`;
		const body = await ctx.http.json<EpisodeResponse>(url, {
			headers: apiHeaders(`https://example.com/anime/${sourceMediaId}`)
		});

		const hideFiller = ctx.settings.boolean('hide_filler');
		const episodes: SourceEpisode[] = [];
		for (const episode of body.episodes) {
			if (hideFiller && episode.filler === true) continue;
			episodes.push({
				number: episode.n,
				sourceEpisodeId: episode.id,
				...(episode.title === undefined ? {} : { title: episode.title }),
				...(episode.aired === undefined ? {} : { airedAt: episode.aired }),
				...(episode.filler === undefined ? {} : { isFiller: episode.filler }),
				...(episode.recap === undefined ? {} : { isRecap: episode.recap }),
				...(episode.audio === undefined ? {} : { audio: describeAudio(episode.audio) })
			});
		}

		// Ascending, always. The host sorts nothing.
		episodes.sort((a, b) => a.number - b.number);
		return episodes;
	},

	async resolve(sourceMediaId, episode, ctx) {
		const watchUrl = `${API}/watch/${encodeURIComponent(sourceMediaId)}/${encodeURIComponent(
			episode.sourceEpisodeId
		)}`;
		const referer = `https://example.com/watch/${sourceMediaId}?ep=${episode.number}`;
		const { servers } = await ctx.http.json<ServerResponse>(watchUrl, {
			headers: apiHeaders(referer)
		});

		const preferredAudio = ctx.settings.string('audio');
		const candidates = servers.filter((server) => server.type === preferredAudio);
		// Falling back to everything rather than to nothing: a viewer who
		// prefers dubs and hits a sub-only episode wants to watch it, not to
		// be told the episode does not exist.
		const chosen = candidates.length > 0 ? candidates : servers;

		// Mirrors are independent and each needs its own round trip, so they go
		// in parallel with a cap. Serially this is one second per mirror before
		// the player opens; unbounded it is how a plugin gets itself
		// rate-limited on the first click. A mirror that throws is dropped —
		// one dead mirror out of six must not cost the other five.
		const sources = await mapConcurrent(chosen, 4, (server) => resolveServer(server, referer, ctx));

		if (sources.length === 0) {
			// Never an empty list. The host's fall-through walks this, and
			// "success, but nothing to play" is a state every caller would
			// otherwise have to handle.
			throw new NotFoundError(`No working mirror for episode ${episode.number}.`);
		}

		const preferred = ctx.settings.string('quality');
		return sources.sort(
			(a, b) =>
				Number(b.quality === preferred) - Number(a.quality === preferred) ||
				(b.heightPx ?? 0) - (a.heightPx ?? 0)
		);
	}
});

/**
 * One mirror, from an embed URL to a playable `PlaybackSource`.
 *
 * This is the function worth studying. It is where a real port spends its
 * time, and it is where the design either helps or produces a proxy server.
 */
async function resolveServer(
	server: ApiServer,
	referer: string,
	ctx: SourceContext
): Promise<PlaybackSource> {
	const html = await ctx.http.text(server.embed, {
		headers: { Accept: '*/*', Referer: referer, Origin: CDN }
	});

	// Sites embed their player configuration as near-JSON in a script tag.
	// `matchOne` throws `SourceChangedError` naming the URL if the shape moved,
	// which is the whole difference between a fixable bug report and "black
	// screen". `parseJson5` copes with unquoted keys and trailing commas.
	const raw = matchOne(
		/window\.__PLAYER__\s*=\s*(\{[\s\S]*?\});/,
		html,
		'the player config',
		server.embed
	);
	const config = parseJson5<EmbedConfig>(raw, 'player config', server.embed);

	const subtitles: SubtitleTrack[] = (config.subtitles ?? []).map((track, index) => ({
		languageCode: track.lang,
		label: track.lang.toUpperCase(),
		format: track.url.endsWith('.ass') ? 'ass' : track.url.endsWith('.srt') ? 'srt' : 'vtt',
		url: track.url,
		isDefault: index === 0
	}));

	// The mask is fetched from the source at resolve time, once, and travels to
	// the host as DATA. This is the split the whole system is built on: JS runs
	// here, where it costs one call per episode, and never on the segment path,
	// where it would cost a QuickJS FFI crossing per megabyte on a phone.
	const mask = ctx.bytes.fromHex(config.mask);

	const height = /(\d{3,4})p/.exec(server.name)?.[1];

	return {
		url: config.stream,
		container: 'hls',
		label: `${server.name} · ${server.type === 'dub' ? 'Dub' : 'Sub'}`,
		...(height === undefined ? {} : { quality: `${height}p`, heightPx: Number(height) }),
		headers: { Referer: `${CDN}/`, Origin: CDN },
		subtitles,
		...(config.intro === undefined && config.outro === undefined
			? {}
			: {
					skips: [
						...(config.intro === undefined
							? []
							: [
									{
										kind: 'intro' as const,
										startSeconds: config.intro[0],
										endSeconds: config.intro[1]
									}
								]),
						...(config.outro === undefined
							? []
							: [
									{
										kind: 'outro' as const,
										startSeconds: config.outro[0],
										endSeconds: config.outro[1]
									}
								])
					]
				}),

		// The pipeline. Four declarations replace a localhost HTTP server:
		pipeline: {
			// Applied to the manifest, every segment, every subtitle and every
			// key. The host works out how — natively on the five Flutter
			// targets, through its own proxy in a browser, where JavaScript is
			// forbidden from setting Referer and Origin at all.
			headers: { Referer: `${CDN}/`, Origin: CDN },

			// Copy `token` from the manifest URL onto child URLs that lack it,
			// instead of hand-rolling "walk up three levels looking for one".
			propagateQuery: ['token'],

			manifest: [
				manifestFix.absolutise(),
				// This CDN emits BANDWIDTH in Kbps. Left alone, every player
				// throttles its buffer to nothing and the viewer sees constant
				// rebuffering on a fast connection.
				manifestFix.repairBandwidth()
			],

			segment: [
				// Segments are disguised as images. Drop the fake header —
				// whichever of the two this CDN used for this segment.
				ops.dropMagicPrefix([
					{ magic: ctx.text.encode('RIFF'), drop: 12 },
					{ magic: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), drop: 8 }
				]),
				// Then unmask. `unlessByte` skips segments that arrived plain —
				// this CDN mixes both, and an unconditional XOR would corrupt
				// the ones that were already fine.
				ops.xorRepeating(mask, { at: 0, equals: 0x47 }),
				// And prove it worked. Without this a rotated key produces
				// bytes that buffer, demux and play as a black screen with
				// nothing in any log.
				ops.assertMpegTs('This mirror changed its key. Try another server.')
			]
		}
	};
}

/** `["sub","dub"]` → `Sub & Dub`, which is what the episode row shows. */
function describeAudio(audio: readonly string[]): string {
	const has = (kind: string) => audio.includes(kind);
	if (has('sub') && has('dub')) return 'Sub & Dub';
	if (has('dub')) return 'Dub';
	return 'Sub';
}
