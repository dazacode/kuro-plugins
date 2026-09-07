/**
 * `StreamPipeline` — what a plugin declares instead of running a proxy server.
 *
 * The whole design is in ADR-0002; the one-paragraph version is that the
 * prevailing extension contract ends at a URL, so any source whose CDN serves
 * obfuscated bytes forces the *extension* to become an HTTP server on
 * localhost. That cannot exist in a browser, it means a plugin holds a
 * listening socket (so it is not sandboxed), and it gets reimplemented subtly
 * differently by every extension that needs it.
 *
 * Here the plugin describes the transform as **data**, computed once during
 * `resolve()`, and the host executes it natively — Dart on the five Flutter
 * targets, a `shaka-player` response filter in the browser. Both executors are
 * pinned to `contract/fixtures/stream_pipeline.json`, so "the same bytes on
 * every platform" is a test rather than a hope.
 *
 * Why not a `transformSegment(bytes)` callback, which would obviously be more
 * flexible: on Android and Windows the host's JS engine is QuickJS behind a
 * Dart FFI boundary whose documented weakness is exactly large buffer
 * transfer, and an episode is several hundred multi-megabyte segments. That
 * cost is invisible on a developer's laptop — where the engine is
 * JavaScriptCore or the browser's — and ruinous on a phone. An escape hatch is
 * specified (`permissions: ["segment-transform-js"]`) and deliberately not
 * implemented; a host that sees it refuses to load the plugin rather than
 * quietly ignoring it.
 */

/** A guard on one early byte: "is it already this value?". */
export interface ByteCheck {
	/** Offset, `0..15`. Must fit in the host's 16-byte lookahead. */
	readonly at: number;
	readonly equals: number;
}

/** One case of `drop-magic-prefix`. `magic` is base64. */
export interface MagicCase {
	readonly magic: string;
	readonly drop: number;
}

/** One declarative operation on a segment's bytes. */
export type SegmentOp =
	| { readonly kind: 'drop-magic-prefix'; readonly cases: readonly MagicCase[] }
	| { readonly kind: 'drop-bytes'; readonly count: number }
	| { readonly kind: 'xor-repeating'; readonly key: string; readonly unlessByte?: ByteCheck }
	| {
			readonly kind: 'assert-byte';
			readonly at: number;
			readonly equals: number;
			readonly because: string;
	  };

/** A named repair applied to a manifest before the player parses it. */
export type ManifestFix =
	| { readonly kind: 'absolutise' }
	| { readonly kind: 'rebase-from-query'; readonly param: string }
	| { readonly kind: 'repair-bandwidth'; readonly minBps: number; readonly scale: number };

export interface StreamPipeline {
	/** Applied to manifest, segment, subtitle and key requests alike. */
	readonly headers?: Readonly<Record<string, string>>;
	/**
	 * Per-host overrides, merged over `headers` for a matching request.
	 *
	 * A real stream routinely spans two or three hosts that each want something
	 * different: an API that checks its own `Referer`, a CDN that checks a
	 * different one, and a signing endpoint that wants neither. One flat map
	 * forces a plugin to pick whichever host it cares about most and hope the
	 * rest tolerate it — which they do, until one does not, and the symptom is
	 * a 403 on some segments and not others.
	 *
	 * Keys are the same host patterns `network.hosts` uses. Most specific wins.
	 */
	readonly headersByHost?: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** Query names copied from the manifest URL onto child URLs that lack them. */
	readonly propagateQuery?: readonly string[];
	readonly manifest?: readonly ManifestFix[];
	readonly segment?: readonly SegmentOp[];
}

/** The MPEG-TS sync byte. Every 188-byte packet starts with it. */
export const TS_SYNC_BYTE = 0x47;

/**
 * Builders, so a plugin declares intent rather than hand-writing base64.
 *
 * These exist because the failure mode of hand-written ops is silent: a
 * mistyped key produces bytes, not an error, and every layer above buffers
 * them happily. A builder that takes `Uint8Array` and encodes it is one place
 * that cannot be got wrong.
 */
export const ops = {
	/**
	 * Drop a prefix chosen by matching magic bytes.
	 *
	 * Cases are tried in order and the first match wins. **No match drops
	 * nothing, and that is not an error** — a source that disguises its
	 * segments usually serves some of them plain, and failing on those would
	 * break playback for the half that were already fine.
	 */
	dropMagicPrefix(cases: readonly { magic: Uint8Array; drop: number }[]): SegmentOp {
		return {
			kind: 'drop-magic-prefix',
			cases: cases.map((entry) => ({ magic: toBase64(entry.magic), drop: entry.drop }))
		};
	},

	/** Drop a fixed-length prefix. */
	dropBytes(count: number): SegmentOp {
		return { kind: 'drop-bytes', count };
	},

	/**
	 * Undo a repeating-key XOR mask.
	 *
	 * `unlessByte` suppresses the op for a segment that is already plaintext,
	 * which is how a source that mixes masked and plain segments is handled
	 * without corrupting the plain ones. When a source is uniformly masked,
	 * leave it off.
	 */
	xorRepeating(key: Uint8Array, unlessByte?: ByteCheck): SegmentOp {
		if (key.length === 0 || key.length > 64) {
			throw new RangeError(`An xor-repeating key is 1..64 bytes, got ${key.length}.`);
		}
		return unlessByte === undefined
			? { kind: 'xor-repeating', key: toBase64(key) }
			: { kind: 'xor-repeating', key: toBase64(key), unlessByte };
	},

	/**
	 * Fail the segment unless a byte has the expected value.
	 *
	 * Put one of these at the end of every transform. It is the difference
	 * between a user reporting "black screen" and the host reporting "this
	 * source rotated its key": a stale mask still produces bytes, they still
	 * buffer, they still reach the demuxer, and nothing anywhere logs a
	 * problem. One comparison per segment converts the worst failure mode this
	 * system has into a sentence.
	 */
	assertByte(at: number, equals: number, because: string): SegmentOp {
		if (at < 0 || at > 15) throw new RangeError(`assert-byte offset is 0..15, got ${at}.`);
		return { kind: 'assert-byte', at, equals, because };
	},

	/** `assertByte(0, TS_SYNC_BYTE, …)` — the check almost every HLS source wants. */
	assertMpegTs(because = 'The stream did not decode. This source may have changed its key.'): SegmentOp {
		return ops.assertByte(0, TS_SYNC_BYTE, because);
	}
} as const;

/** Manifest repairs, as named builders. */
export const manifest = {
	/** Resolve every relative URI against the manifest URL. */
	absolutise(): ManifestFix {
		return { kind: 'absolutise' };
	},

	/**
	 * Resolve relative URIs against a URL carried in the manifest URL's query.
	 *
	 * For the wrapper-endpoint pattern: the manifest is fetched through
	 * `https://wrapper/parse?url=<the real address>` because the real address
	 * needs a signature the player cannot produce. The body it returns still
	 * contains URIs relative to the *real* address, so resolving them against
	 * the wrapper yields URLs on the wrapper's host — which 404 one layer down,
	 * after the master playlist has already loaded and reported success.
	 */
	rebaseFromQuery(param: string): ManifestFix {
		return { kind: 'rebase-from-query', param };
	},

	/**
	 * Repair `BANDWIDTH` values a CDN emitted in Kbps where the spec says bps.
	 *
	 * Absurdly specific, and not: a player that believes a 1.5 Mbps rendition
	 * is 1.5 kbps throttles its own buffer to nothing, and the symptom is
	 * constant rebuffering on a fast connection — which reads to a user as
	 * "this app's player is bad", not "this manifest is wrong".
	 */
	repairBandwidth(minBps = 100_000, scale = 1000): ManifestFix {
		return { kind: 'repair-bandwidth', minBps, scale };
	}
} as const;

/** bytes → base64, without `btoa` (absent in QuickJS; ABI.md §6). */
export function toBase64(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i] as number;
		const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : undefined;
		const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : undefined;
		out += DIGITS[a >> 2];
		out += DIGITS[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
		out += b === undefined ? '=' : DIGITS[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
		out += c === undefined ? '=' : DIGITS[c & 0x3f];
	}
	return out;
}

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
