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
	readonly extraLarge?: string | null;
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
	readonly subbed?: number | null;
	readonly dubbed?: number | null;
	readonly seasonYear?: number | null;
	readonly episodes?: number | null;
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
