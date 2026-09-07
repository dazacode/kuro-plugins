/**
 * The shapes the source's API returns.
 *
 * Declared rather than inferred, and kept in their own file, because these are
 * the *contract with somebody else's server* — the part most likely to change
 * without warning, and the part a maintainer reads first when it does. Mixing
 * them into the logic makes a shape change look like a logic change.
 *
 * Field names are the server's, `snake_case` and all, rather than being
 * renamed to house style at the type level. Renaming here would mean a
 * recorded cassette and its type no longer read the same, and diffing a tape
 * against a type is the fastest way to see what a source altered.
 *
 * Ported from the Aniyomi Kotlin extension's `Dto.kt`.
 */

export interface SearchResponse {
	readonly limit: number;
	readonly offset: number;
	readonly total: number;
	readonly results: readonly AnimeDto[];
}

export interface LatestResponse {
	readonly data: readonly AnimeDto[];
	readonly has_more?: boolean;
	readonly next_cursor?: string | null;
}

export interface TitleDto {
	readonly english?: string | null;
	readonly native?: string | null;
	readonly romaji?: string | null;
}

export interface CoverDto {
	/** snake_case on the wire. Spelling it `extraLarge` reads fine and silently
	 *  yields undefined, which is a poster that never loads. */
	readonly extra_large?: string | null;
	readonly large?: string | null;
	readonly medium?: string | null;
}

export interface AnimeDto {
	readonly anime_id: string;
	readonly title?: TitleDto | null;
	readonly cover_image?: CoverDto | null;
	readonly description?: string | null;
	readonly status?: string | null;
	readonly genres?: readonly string[] | null;
}

export interface AnimeDetailDto extends AnimeDto {
	readonly anilist_id?: number | null;
	readonly mal_id?: number | null;
	/** Highest episode number available subtitled. */
	readonly subbed?: number | null;
	/** Highest episode number available dubbed. */
	readonly dubbed?: number | null;
	readonly season?: string | null;
	readonly season_year?: number | null;
	readonly format?: string | null;
	/**
	 * Alternative names, and the single most valuable field on this type.
	 *
	 * The matcher compares a canonical show's titles against a source's, and
	 * this is what lets "Sousou no Frieren" find an entry listed under
	 * "Frieren: Beyond Journey's End". Without it, matching falls back to one
	 * title against one title and declines far more often than it should.
	 */
	readonly synonyms?: readonly string[] | null;
	readonly tags?: readonly { readonly name?: string | null }[] | null;
	readonly duration?: number | null;
	readonly average_score?: number | null;
	readonly banner_image?: string | null;
}

/**
 * There is deliberately no `episodes` field.
 *
 * The API does not carry a total; it carries `subbed` and `dubbed`, each the
 * highest episode number available in that audio. The count a matcher should
 * compare against is the larger of the two — that is what the source actually
 * has — and inventing an `episodes` field that is always undefined would make
 * every episode-count check silently pass.
 */
export function availableEpisodes(detail: AnimeDetailDto): number | undefined {
	const subbed = detail.subbed ?? 0;
	const dubbed = detail.dubbed ?? 0;
	const most = Math.max(subbed, dubbed);
	return most > 0 ? most : undefined;
}

export interface EpisodeListDto {
	readonly data: readonly EpisodeDto[];
}

export interface EpisodeDto {
	readonly episodeId?: string | null;
	readonly episode_number: number;
	readonly title?: string;
	readonly title_japanese?: string | null;
	readonly title_romanji?: string | null;
	readonly aired?: string | null;
	readonly is_filler?: boolean;
	readonly is_recap?: boolean;
}

export interface VideoResponse {
	readonly success: boolean;
	readonly servers?: readonly VideoServerDto[] | null;
}

export interface VideoServerDto {
	readonly serverName?: string | null;
	readonly dataLink?: string | null;
	/** `sub` or `dub`. */
	readonly dataType?: string | null;
	readonly softsub?: boolean;
}

/** The embed page's inline payload, after JSON5 normalisation. */
export interface EmbedDataDto {
	readonly subtitles?: readonly { readonly url: string; readonly language?: string }[] | null;
	readonly intro_chapter?: ChapterDto | null;
	readonly outro_chapter?: ChapterDto | null;
	/** Everything else the signing endpoint needs, passed through untouched. */
	readonly [key: string]: unknown;
}

export interface ChapterDto {
	readonly start?: number | null;
	readonly end?: number | null;
}

export interface TokenResponse {
	readonly status: number;
	readonly result?: { readonly token: string; readonly context: unknown } | null;
}

export interface StreamResponse {
	readonly status: number;
	readonly result?: {
		readonly stream: string;
		readonly context: Record<string, unknown>;
	} | null;
}
