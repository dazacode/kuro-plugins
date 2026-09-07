/**
 * The values that cross the sandbox boundary.
 *
 * Every shape here already exists twice in the host — once in
 * `lib/domain/models/` as freezed Dart, once in
 * `client-web/src/lib/domain/` as TypeScript — and `contract/fixtures/`
 * already holds vectors proving those two agree. This file is a third
 * declaration of the same things, and it is deliberately the *narrowest* of
 * the three: a plugin sees only what a source can legitimately know.
 *
 * The clearest example is `SourceCatalogEntry`. It has no canonical id, and it
 * never will. A source knows its own catalogue and nothing else; deciding that
 * a row *is* a particular show is the matching layer's job, and the user's
 * library keys on the canonical id that comes out of it (AGENTS.md rule 1). A
 * source that could mint canonical ids could damage a library by being wrong,
 * which is exactly the coupling the three-layer split exists to prevent.
 *
 * Everything is plain JSON. No classes, no functions, no `ArrayBuffer`: these
 * values are structurally cloned out of a Worker or serialised across a
 * QuickJS FFI boundary, and a shape that survives one but not the other is a
 * shape that works on some of the six platforms.
 */

/** The transport a stream is delivered over. */
export type StreamContainer = 'mp4' | 'hls' | 'dash';

/** The wire format of a subtitle track. */
export type SubtitleFormat = 'vtt' | 'ass' | 'srt';

/** How complete a source's run of a show is. */
export type SourceStatus = 'ongoing' | 'completed' | 'unknown';

/**
 * A row in the source's own catalogue, before anything has identified it.
 *
 * Everything on this type is here because it improves a match score:
 * `alternativeTitles` to compare against, `year` and `episodeCount` to
 * disqualify a same-named movie or a different season. Adding a field that
 * does not help matching is adding a field the host will ignore.
 */
export interface SourceCatalogEntry {
	/** The source's own id for this show. Opaque to the host; it round-trips. */
	readonly sourceMediaId: string;
	readonly title: string;
	readonly alternativeTitles?: readonly string[];
	readonly posterImageUrl?: string;
	readonly description?: string;
	readonly year?: number;
	readonly episodeCount?: number;
	readonly genres?: readonly string[];
	readonly status?: SourceStatus;
}

/** One page of catalogue rows. */
export interface CatalogPage {
	readonly entries: readonly SourceCatalogEntry[];
	/**
	 * Whether asking for the next page is worth doing.
	 *
	 * Returned rather than inferred from `entries.length` because a source that
	 * filters server-side routinely returns a short page that is not the last
	 * one, and an infinite scroll that stops early looks exactly like a source
	 * with less content than it has.
	 */
	readonly hasMore: boolean;
	/**
	 * Opaque cursor for the next page, when the source is cursor-paginated
	 * rather than offset-paginated. Handed back verbatim in the next call.
	 *
	 * This exists because cursor pagination is otherwise forced into module
	 * state — "remember the cursor from last time" — which breaks the moment
	 * two screens page through the same source at once.
	 */
	readonly cursor?: string;
}

/**
 * One episode this source can offer.
 *
 * Note what this answers: *what can be played*. What episodes **exist** is the
 * metadata layer's question and it is answered elsewhere. The host renders the
 * union of the two, so a show whose source has eleven of twenty-four episodes
 * shows twenty-four rows with eleven of them playable, rather than eleven rows
 * or an empty page.
 */
export interface SourceEpisode {
	/** Whole or decimal; `12.5` is a recap special and sorts where it belongs. */
	readonly number: number;
	/** The source's own id, handed back to `resolve`. */
	readonly sourceEpisodeId: string;
	readonly title?: string;
	/** ISO-8601. The host parses; the plugin does not format for display. */
	readonly airedAt?: string;
	readonly isFiller?: boolean;
	readonly isRecap?: boolean;
	/** `Sub`, `Dub`, `Sub & Dub` — what audio this source has for it. */
	readonly audio?: string;
	readonly thumbnailUrl?: string;
	readonly durationSeconds?: number;
}

/** One subtitle option. Either a sidecar `url`, or `isEmbedded`. */
export interface SubtitleTrack {
	readonly languageCode: string;
	readonly label: string;
	readonly format: SubtitleFormat;
	readonly url?: string;
	readonly isEmbedded?: boolean;
	readonly isDefault?: boolean;
}

/**
 * Where a show's opening and ending sit, so the host can offer to skip them.
 *
 * Carried on the source rather than fetched separately because the only party
 * that knows is whoever served the stream, and asking a second service for it
 * means a second dependency and a second thing that can be wrong.
 */
export interface SkipRange {
	readonly kind: 'intro' | 'outro';
	readonly startSeconds: number;
	readonly endSeconds: number;
}

/**
 * One resolvable way to play one episode.
 *
 * `resolve()` returns a **list** of these, never one (AGENTS.md rule 2). Real
 * sources hand back several mirrors at several qualities and a given mirror is
 * dead a meaningful fraction of the time; with a list, a failed load falls
 * through to the next entry, and with a single stream a failed load is a
 * failed episode.
 *
 * Order them best-first. The host will take the head when nobody is choosing.
 */
export interface PlaybackSource {
	readonly url: string;
	readonly container: StreamContainer;
	/** What the user sees in the server picker. Meaningful alone: `Mirror 2 · 1080p`. */
	readonly label: string;
	readonly quality?: string;
	readonly heightPx?: number;
	/**
	 * Headers the request needs.
	 *
	 * Declared, never sent — the plugin has no socket. The host applies them,
	 * and *how* differs by platform in a way a plugin must not know about:
	 * natively on the five Flutter targets, and through the host's own proxy in
	 * a browser, where `Referer`, `Origin`, `User-Agent` and `Cookie` are
	 * forbidden header names that JavaScript is not allowed to set.
	 */
	readonly headers?: Readonly<Record<string, string>>;
	readonly subtitles?: readonly SubtitleTrack[];
	readonly skips?: readonly SkipRange[];
	/**
	 * The byte pipeline, when the stream is not playable as served.
	 *
	 * Absent means "fetch this URL and play it", which is what a progressive
	 * MP4 needs. See `pipeline.ts`, and ADR-0002 §2.1 for why this field is the
	 * difference between a plugin and a plugin that ships a web server.
	 */
	readonly pipeline?: StreamPipeline;
}

// Re-exported from pipeline.ts to keep this file the single import for shapes.
import type { StreamPipeline } from './pipeline';
export type { StreamPipeline };
