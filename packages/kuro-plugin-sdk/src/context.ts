/**
 * `ctx` — the whole of a plugin's capability.
 *
 * There is no ambient `fetch`, no `XMLHttpRequest`, no `globalThis.crypto`, no
 * DOM, no filesystem and no socket. The sandbox removes them; what remains is
 * this object. That is what makes AGENTS.md rule 9's "the host grants network
 * per plugin" enforceable rather than aspirational — a plugin cannot route
 * around `ctx.http`, because there is nothing else to route through.
 *
 * `text` and `bytes` look like padding and are not. One bundle runs on three
 * JS engines — QuickJS on Android, Windows and Linux; JavaScriptCore on iOS
 * and macOS; the browser's own on web — and none of the embedded two ship
 * `TextEncoder`, `TextDecoder`, `atob` or `btoa`. A plugin that reaches for a
 * global instead of `ctx` works on the platform its author owns and throws on
 * the others.
 */

import type { SegmentOp } from './pipeline';

export interface HttpRequest {
	readonly method?: 'GET' | 'POST' | 'HEAD';
	readonly headers?: Readonly<Record<string, string>>;
	/** String bodies only. Binary uploads are not a thing a source needs. */
	readonly body?: string;
	/** Overrides the manifest's `timeouts.requestMs` downward only. */
	readonly timeoutMs?: number;
}

export interface HttpResponse {
	readonly status: number;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
	bytes(): Promise<Uint8Array>;
}

export interface HttpClient {
	/**
	 * Performs a request, refusing any host `manifest.network.hosts` does not
	 * match — before a packet leaves, throwing `PermissionDeniedError`.
	 *
	 * A non-2xx response is **returned, not thrown**. Sources use 404 and 403
	 * as ordinary answers, and a client that threw on them would force every
	 * call site into a try/catch that swallows real failures too.
	 */
	send(url: string, request?: HttpRequest): Promise<HttpResponse>;

	/** `send`, then `.text()`, throwing `NetworkError` on a non-2xx. */
	text(url: string, request?: HttpRequest): Promise<string>;
	/** `send`, then `.json()`, throwing `NetworkError` on a non-2xx. */
	json<T = unknown>(url: string, request?: HttpRequest): Promise<T>;
}

/**
 * Values for the settings declared in `manifest.settings`, rendered by the
 * host on every surface.
 *
 * A plugin declares settings and reads them; it never draws them. That is what
 * lets ten Android `PreferenceScreen` entries become ten rows that look native
 * on a phone, a desktop and a browser, in the host's own design tokens — and
 * it is why a plugin needs no UI toolkit and cannot ship a layout bug.
 */
export interface SettingsView {
	string(id: string): string;
	boolean(id: string): boolean;
	/** For `multiselect`. Order is the manifest's, not the user's. */
	list(id: string): readonly string[];
}

/** A small, plugin-private store. Survives restarts; capped at 64 KiB. */
export interface KeyValueStore {
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface Logger {
	debug(message: string, data?: Readonly<Record<string, unknown>>): void;
	warn(message: string, data?: Readonly<Record<string, unknown>>): void;
}

/** Engine-independent text codecs. See the file header for why. */
export interface TextCodecs {
	encode(value: string): Uint8Array;
	decode(bytes: Uint8Array): string;
}

/** Engine-independent binary codecs. */
export interface ByteCodecs {
	fromBase64(value: string): Uint8Array;
	toBase64(bytes: Uint8Array): string;
	fromHex(value: string): Uint8Array;
	toHex(bytes: Uint8Array): string;
}

export interface SourceContext {
	readonly http: HttpClient;
	readonly settings: SettingsView;
	readonly storage: KeyValueStore;
	readonly log: Logger;
	readonly text: TextCodecs;
	readonly bytes: ByteCodecs;
	/** BCP-47-ish. May lack a region; do not assume `en-GB` over `en`. */
	readonly locale: string;
	/**
	 * Aborted when the user navigates away mid-call.
	 *
	 * Worth honouring in a `resolve` that fans out across mirrors: without it,
	 * leaving a page keeps a dozen requests in flight competing with whatever
	 * the user actually asked for next.
	 */
	readonly signal: AbortSignal;
}

/**
 * A convenience the host also implements: run the declared segment ops over
 * bytes, in-process.
 *
 * Exposed to plugins **only** through the testing harness, never on
 * `SourceContext`. A plugin that could transform bytes itself would be back to
 * shipping a codec, and the whole point of `SegmentOp` is that it does not.
 */
export type SegmentExecutor = (bytes: Uint8Array, ops: readonly SegmentOp[]) => Uint8Array;
