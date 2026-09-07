/**
 * Cassettes: record a source's real traffic once, replay it forever.
 *
 * This is the answer to the single worst property of every scraper ecosystem —
 * that a source changing produces **no signal**. A selector stops matching, a
 * payload gains a field, an endpoint moves, and the plugin keeps returning
 * plausible-looking nothing. Nobody finds out until a user reports a black
 * screen, weeks later, with no detail, and the maintainer starts from zero.
 *
 * With a cassette the same change is a **failing test with a diff**:
 *
 * ```
 * bun run kuro test reanime            # replays; offline; deterministic; CI
 * bun run kuro test reanime --record   # hits the real source, rewrites tapes
 * git diff plugins/reanime/cassettes   # ← exactly what the source changed
 * ```
 *
 * The recorded tapes are committed. That is the point: they are the plugin's
 * evidence that it once worked, they make the suite runnable by a contributor
 * with no account and no network, and they turn "the site changed" into a
 * reviewable patch rather than an archaeology exercise.
 *
 * **Recording redacts.** Tapes are committed to a public repository, so
 * `Set-Cookie`, `Authorization` and anything the manifest declares as a secret
 * setting are replaced before a tape is written. A tape that leaked a session
 * token would be a tape nobody could ever safely commit, and a workflow whose
 * artefacts cannot be committed is the workflow we already have.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TapeEntry {
	readonly key: string;
	readonly method: string;
	readonly url: string;
	readonly status: number;
	readonly headers: Record<string, string>;
	/** Text bodies inline; anything else base64 in `bodyBase64`. */
	readonly body?: string;
	readonly bodyBase64?: string;
}

export interface Tape {
	readonly recordedAt: string;
	readonly entries: TapeEntry[];
}

export type CassetteMode = 'replay' | 'record';

/** Header names never written to a tape, whatever the source sent. */
const REDACTED = new Set([
	'set-cookie',
	'cookie',
	'authorization',
	'proxy-authorization',
	'www-authenticate',
	'x-api-key'
]);

/**
 * Response headers worth keeping.
 *
 * An allowlist rather than a denylist, because the interesting ones are few
 * and a denylist means every new tracking header a CDN invents lands in a diff
 * and makes a real change harder to see.
 */
const KEPT = new Set(['content-type', 'content-length', 'location', 'retry-after']);

export class Cassette {
	private readonly entries = new Map<string, TapeEntry>();
	private readonly recorded: TapeEntry[] = [];

	private constructor(
		private readonly path: string,
		readonly mode: CassetteMode
	) {}

	/** Loads a tape, or starts an empty one when recording. */
	static open(path: string, mode: CassetteMode = defaultMode()): Cassette {
		const cassette = new Cassette(path, mode);
		if (existsSync(path)) {
			const tape = JSON.parse(readFileSync(path, 'utf8')) as Tape;
			for (const entry of tape.entries) cassette.entries.set(entry.key, entry);
		} else if (mode === 'replay') {
			throw new Error(
				`No cassette at ${path}. Record one with --record, then commit it.\n` +
					'A plugin without committed tapes has no offline test suite and no ' +
					'evidence it ever worked.'
			);
		}
		return cassette;
	}

	/**
	 * The identity of a request.
	 *
	 * Method, URL and a hash of the body — not the headers. Headers carry
	 * timestamps, nonces and a `User-Agent` that changes with the host, and
	 * including them would mean a tape that only ever replays on the machine
	 * that recorded it.
	 */
	static key(method: string, url: string, body?: string): string {
		const digest = createHash('sha256')
			.update(body ?? '')
			.digest('hex')
			.slice(0, 12);
		return `${method.toUpperCase()} ${url} #${digest}`;
	}

	/** Looks up a recorded response, or `null` when the tape has no such request. */
	find(key: string): TapeEntry | null {
		return this.entries.get(key) ?? null;
	}

	/** Records a response, redacting before it can ever reach a commit. */
	record(entry: Omit<TapeEntry, 'headers'> & { headers: Record<string, string> }): void {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(entry.headers)) {
			const lower = name.toLowerCase();
			if (REDACTED.has(lower)) continue;
			if (!KEPT.has(lower)) continue;
			headers[lower] = value;
		}
		const clean: TapeEntry = { ...entry, headers };
		this.entries.set(clean.key, clean);
		this.recorded.push(clean);
	}

	/**
	 * Writes the tape.
	 *
	 * Sorted by key and indented, so re-recording an unchanged source produces
	 * an empty diff and re-recording a changed one produces a diff that is
	 * only the change. A tape that reordered itself on every run would make
	 * `git diff` useless, which is the feature.
	 */
	save(): void {
		if (this.mode !== 'record') return;
		mkdirSync(dirname(this.path), { recursive: true });
		const entries = [...this.entries.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
		const tape: Tape = { recordedAt: new Date().toISOString().slice(0, 10), entries };
		writeFileSync(this.path, `${JSON.stringify(tape, null, 2)}\n`);
	}

	/** How many requests this run actually recorded. */
	get recordedCount(): number {
		return this.recorded.length;
	}
}

function defaultMode(): CassetteMode {
	return process.env.KURO_CASSETTE === 'record' ? 'record' : 'replay';
}
