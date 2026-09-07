/**
 * A `SourceContext` for tests: cassette-backed, permission-enforcing, offline.
 *
 * Two properties matter more than convenience here.
 *
 * **It enforces `network.hosts` exactly as the host does.** A plugin that
 * reaches a host its manifest does not declare fails in its own test suite,
 * on the author's machine, instead of on a user's phone after install. This is
 * the same class of bug as a missing Android permission and it deserves the
 * same treatment: caught at build time, by the thing that knows the manifest.
 *
 * **It refuses the network in replay mode.** Not "falls back to real HTTP" —
 * refuses, loudly, naming the request. A harness that silently reaches the
 * internet when a tape is missing produces a suite that passes in the author's
 * terminal and fails in CI, which is worse than no suite.
 */

import type {
	ByteCodecs,
	HttpClient,
	HttpRequest,
	HttpResponse,
	KeyValueStore,
	Logger,
	SettingsView,
	SourceContext,
	TextCodecs
} from '../context';
import { NetworkError, PermissionDeniedError } from '../errors';
import { toBase64 } from '../pipeline';
import { Cassette } from './cassette';

export interface FakeContextOptions {
	/** The plugin's manifest, so host rules are enforced from the real source. */
	readonly manifest: {
		readonly network?: { readonly hosts: readonly string[] };
		readonly settings?: readonly { readonly id: string; readonly default?: unknown }[];
	};
	readonly cassette: Cassette;
	/** Overrides for manifest defaults, as a user would have set them. */
	readonly settings?: Readonly<Record<string, string | boolean | readonly string[]>>;
	readonly locale?: string;
	readonly storage?: Map<string, string>;
	/** Collected rather than printed, so a test can assert on a warning. */
	readonly logs?: string[];
}

/**
 * Matches a host against one manifest pattern.
 *
 * A single leading `*.` wildcard matches exactly one or more leading labels —
 * `*.cdn.example.com` covers `a.cdn.example.com` and `a.b.cdn.example.com` but
 * **not** `cdn.example.com` itself, and never `evilcdn.example.com`. The
 * schema makes a bare `*` inexpressible, so "this plugin may talk to anything"
 * is not a thing a manifest can say.
 */
export function hostMatches(host: string, pattern: string): boolean {
	const target = host.toLowerCase();
	const rule = pattern.toLowerCase();
	if (!rule.startsWith('*.')) return target === rule;
	const suffix = rule.slice(1); // ".cdn.example.com"
	return target.endsWith(suffix) && target.length > suffix.length;
}

class CassetteHttpClient implements HttpClient {
	constructor(
		private readonly cassette: Cassette,
		private readonly allowed: readonly string[],
		private readonly log: (line: string) => void
	) {}

	async send(url: string, request: HttpRequest = {}): Promise<HttpResponse> {
		const method = request.method ?? 'GET';
		const host = hostOf(url);
		if (!this.allowed.some((pattern) => hostMatches(host, pattern))) {
			throw new PermissionDeniedError(
				`network:${host}`,
				`This plugin requested ${host}, which its manifest does not declare. ` +
					`Add it to network.hosts (currently: ${this.allowed.join(', ') || 'none'}).`
			);
		}

		const key = Cassette.key(method, url, request.body);
		const recorded = this.cassette.find(key);
		if (recorded !== null) return toResponse(recorded);

		if (this.cassette.mode === 'replay') {
			throw new Error(
				`No cassette entry for:\n  ${key}\n\n` +
					'Re-record with --record and commit the updated tape. If this request ' +
					'is new, that is exactly the diff a reviewer wants to see.'
			);
		}

		this.log(`recording ${key}`);
		// Built conditionally rather than with `undefined` values: under
		// `exactOptionalPropertyTypes` an explicit `body: undefined` is not the
		// same as an absent one, and `fetch` treats them differently for GET.
		const init: RequestInit = { method };
		if (request.headers !== undefined) init.headers = { ...request.headers };
		if (request.body !== undefined) init.body = request.body;
		const response = await fetch(url, init);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const headers: Record<string, string> = {};
		response.headers.forEach((value, name) => {
			headers[name] = value;
		});
		const textual = isTextual(headers['content-type']);
		this.cassette.record({
			key,
			method,
			url,
			status: response.status,
			headers,
			...(textual
				? { body: new TextDecoder().decode(bytes) }
				: { bodyBase64: toBase64(bytes) })
		});
		return toResponse(this.cassette.find(key)!);
	}

	async text(url: string, request?: HttpRequest): Promise<string> {
		const response = await this.send(url, request);
		if (response.status < 200 || response.status >= 300) {
			throw new NetworkError(`${response.status} from ${url}`, response.status);
		}
		return response.text();
	}

	async json<T>(url: string, request?: HttpRequest): Promise<T> {
		const response = await this.send(url, request);
		if (response.status < 200 || response.status >= 300) {
			throw new NetworkError(`${response.status} from ${url}`, response.status);
		}
		return response.json<T>();
	}
}

/** Builds a context a plugin cannot tell apart from the host's. */
export function fakeContext(options: FakeContextOptions): SourceContext {
	const logs = options.logs ?? [];
	const store = options.storage ?? new Map<string, string>();
	const declared = options.manifest.network?.hosts ?? [];

	const defaults = new Map<string, unknown>();
	for (const setting of options.manifest.settings ?? []) {
		if (setting.default !== undefined) defaults.set(setting.id, setting.default);
	}
	const overrides = options.settings ?? {};

	const settings: SettingsView = {
		string(id) {
			const value = overrides[id] ?? defaults.get(id);
			return typeof value === 'string' ? value : '';
		},
		boolean(id) {
			const value = overrides[id] ?? defaults.get(id);
			return value === true;
		},
		list(id) {
			const value = overrides[id] ?? defaults.get(id);
			return Array.isArray(value) ? (value as string[]) : [];
		}
	};

	const storage: KeyValueStore = {
		async get(key) {
			return store.get(key) ?? null;
		},
		async set(key, value) {
			store.set(key, value);
		},
		async delete(key) {
			store.delete(key);
		}
	};

	const log: Logger = {
		debug: (message) => logs.push(`debug ${message}`),
		warn: (message) => logs.push(`warn ${message}`)
	};

	return {
		http: new CassetteHttpClient(options.cassette, declared, (line) => logs.push(line)),
		settings,
		storage,
		log,
		text: TEXT,
		bytes: BYTES,
		locale: options.locale ?? 'en',
		signal: new AbortController().signal
	};
}

/**
 * The codecs the embedded engines do not ship.
 *
 * Implemented by hand rather than delegating to Node's globals, so that a
 * plugin's tests exercise the same behaviour the QuickJS host will provide
 * rather than a richer one that happens to be lying around under Node.
 */
const TEXT: TextCodecs = {
	encode: (value) => new TextEncoder().encode(value),
	decode: (bytes) => new TextDecoder().decode(bytes)
};

const BYTES: ByteCodecs = {
	toBase64,
	fromBase64(value) {
		const clean = value.replace(/[=\s]/g, '');
		const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
		let accumulator = 0;
		let bits = 0;
		let index = 0;
		for (const character of clean) {
			const digit = DIGITS.indexOf(character);
			if (digit === -1) throw new Error(`Not base64: ${value}`);
			accumulator = (accumulator << 6) | digit;
			bits += 6;
			if (bits >= 8) {
				bits -= 8;
				out[index] = (accumulator >> bits) & 0xff;
				index += 1;
			}
		}
		return out.subarray(0, index);
	},
	toHex: (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
	fromHex(value) {
		const clean = value.replace(/\s|^0x/g, '');
		if (clean.length % 2 !== 0) throw new Error(`Not hex: ${value}`);
		const out = new Uint8Array(clean.length / 2);
		for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
		return out;
	}
};

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toResponse(entry: {
	status: number;
	url: string;
	headers: Record<string, string>;
	body?: string;
	bodyBase64?: string;
}): HttpResponse {
	const text = entry.body ?? (entry.bodyBase64 === undefined ? '' : null);
	return {
		status: entry.status,
		url: entry.url,
		headers: entry.headers,
		async text() {
			if (text !== null) return text;
			return BYTES.fromBase64(entry.bodyBase64!).reduce(
				(acc, byte) => acc + String.fromCharCode(byte),
				''
			);
		},
		async json<T>() {
			return JSON.parse(await this.text()) as T;
		},
		async bytes() {
			return entry.bodyBase64 === undefined
				? TEXT.encode(entry.body ?? '')
				: BYTES.fromBase64(entry.bodyBase64);
		}
	};
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		throw new NetworkError(`Not a URL: ${url}`);
	}
}

function isTextual(contentType: string | undefined): boolean {
	if (contentType === undefined) return true;
	return /json|text|xml|javascript|mpegurl|x-www-form/i.test(contentType);
}
