/**
 * `@kuro/plugin-sdk` — everything a content-source plugin imports.
 *
 * A plugin's whole dependency list is this package. There is no `okhttp`, no
 * DOM parser, no crypto library and no HTTP client to choose, because there is
 * nothing to choose *between*: the sandbox provides one way to reach the
 * network and one set of codecs, and both arrive on `ctx`.
 *
 * That is a smaller surface than the ecosystem this replaces, on purpose. An
 * extension format where every plugin picks its own HTTP stack is an extension
 * format where every plugin has its own timeout bug.
 */

export { defineSource, type SourceDefinition } from './define';

export type {
	ByteCodecs,
	HttpClient,
	HttpRequest,
	HttpResponse,
	KeyValueStore,
	Logger,
	SegmentExecutor,
	SettingsView,
	SourceContext,
	TextCodecs
} from './context';

export {
	KuroPluginError,
	NetworkError,
	NotFoundError,
	PermissionDeniedError,
	RateLimitedError,
	SourceChangedError,
	UnsupportedError
} from './errors';

export {
	absoluteUrl,
	json5ToJson,
	mapConcurrent,
	matchAll,
	matchOne,
	optionalMatchOne,
	parseJson5,
	stripHtml
} from './extract';

export {
	TS_SYNC_BYTE,
	manifest,
	ops,
	toBase64,
	type ByteCheck,
	type MagicCase,
	type ManifestFix,
	type SegmentOp,
	type StreamPipeline
} from './pipeline';

export type {
	CatalogPage,
	PlaybackSource,
	SkipRange,
	SourceCatalogEntry,
	SourceEpisode,
	SourceStatus,
	StreamContainer,
	SubtitleFormat,
	SubtitleTrack
} from './types';
