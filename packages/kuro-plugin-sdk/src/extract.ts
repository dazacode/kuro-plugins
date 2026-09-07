/**
 * Scraping helpers, shaped around the one thing scrapers get wrong.
 *
 * A scraper's characteristic failure is not a crash. It is a regex that stops
 * matching, a function that returns `null`, a caller that treats `null` as
 * "empty", and a user who sees a blank page. Nothing logs, nothing throws, and
 * the bug report says "it doesn't work".
 *
 * So every extractor here **throws `SourceChangedError` by default** and names
 * what it was looking for and where. Getting nothing back is an event, not a
 * value. Where a plugin genuinely wants "absent is fine", it says so
 * explicitly with the `optional` variants — which is one word, and it is one
 * word the author has to actually mean.
 *
 * Regex rather than a DOM parser, deliberately: none of the three engines this
 * runs on has a DOM, shipping one into a QuickJS sandbox is hundreds of
 * kilobytes per plugin, and the sources worth writing plugins for are mostly
 * JSON APIs anyway. `json5ToJson` exists because the ones that are not tend to
 * embed near-JSON in a `<script>` tag.
 *
 * No lookbehind anywhere. QuickJS builds do not reliably support it (ABI.md §6).
 */

import { SourceChangedError } from './errors';

/**
 * First capture group of the first match, or a named failure.
 *
 * `what` is the message a user and a maintainer both read, so write it as a
 * noun phrase: `the episode list payload`, not `regex 3`.
 */
export function matchOne(pattern: RegExp, text: string, what: string, url: string): string {
	const found = optionalMatchOne(pattern, text);
	if (found === null) throw new SourceChangedError(what, url);
	return found;
}

/** `matchOne`, but absence is a legitimate answer. */
export function optionalMatchOne(pattern: RegExp, text: string): string | null {
	const match = pattern.exec(text);
	if (match === null) return null;
	return match[1] ?? match[0];
}

/** Every first-capture-group across all matches. Empty is legitimate here. */
export function matchAll(pattern: RegExp, text: string): string[] {
	const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
	const out: string[] = [];
	let match = global.exec(text);
	while (match !== null) {
		out.push(match[1] ?? match[0]);
		match = global.exec(text);
	}
	return out;
}

/**
 * Converts the JSON5-ish payload sites embed in `<script>` into real JSON.
 *
 * Handles the three things a framework's serialiser routinely emits that
 * `JSON.parse` refuses: unquoted keys, trailing commas, and `undefined`. It is
 * a normaliser, not a parser — it does not handle single-quoted strings or
 * comments, because a payload containing either is a payload worth extracting
 * differently rather than patching this function until it is a JSON5 parser
 * nobody tested.
 *
 * Quoting only rewrites a key that follows `{` or `,`, so a colon inside a
 * string value is left alone.
 */
export function json5ToJson(source: string): string {
	return source
		.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3')
		.replace(/,(\s*[}\]])/g, '$1')
		.replace(/:\s*undefined\b/g, ': null');
}

/** `json5ToJson` then `JSON.parse`, with a named failure instead of a SyntaxError. */
export function parseJson5<T>(source: string, what: string, url: string): T {
	try {
		return JSON.parse(json5ToJson(source)) as T;
	} catch {
		throw new SourceChangedError(`parseable ${what}`, url);
	}
}

/**
 * Resolves `href` against `base`, the way a browser would.
 *
 * `URL` is present in all three engines. Written as a helper anyway so that a
 * malformed href from a source becomes a named failure rather than a raw
 * `TypeError` from deep inside a loop.
 */
export function absoluteUrl(href: string, base: string): string {
	try {
		return new URL(href, base).toString();
	} catch {
		throw new SourceChangedError(`a valid URL (got "${href}")`, base);
	}
}

/** Strips HTML tags and unescapes the five entities that actually appear. */
export function stripHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0?39;|&apos;/g, "'")
		.trim();
}

/**
 * Runs `work` over `items` with a concurrency cap, keeping successes.
 *
 * Every real source fans out — a dozen mirrors per episode, each needing its
 * own handshake — and doing that serially is the difference between a player
 * that opens in one second and one that opens in twelve. Doing it *unbounded*
 * is how a plugin gets itself rate-limited on the first click.
 *
 * Rejections are dropped rather than propagated, because one dead mirror out
 * of twelve is a normal Tuesday and must not cost the other eleven. That is
 * also why this cannot be `Promise.all`.
 */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	work: (item: T, index: number) => Promise<R | readonly R[]>
): Promise<R[]> {
	const out: R[] = [];
	let cursor = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			if (index >= items.length) return;
			try {
				const produced = await work(items[index] as T, index);
				if (Array.isArray(produced)) out.push(...(produced as R[]));
				else out.push(produced as R);
			} catch {
				// One dead mirror must not cost the others. See the doc comment.
			}
		}
	});
	await Promise.all(workers);
	return out;
}
