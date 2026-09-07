/**
 * The errors a plugin throws, and why they are typed rather than strings.
 *
 * The host maps each of these onto the `KuroFailure` taxonomy both clients
 * already share, so the screen says the same thing on a phone and in a
 * browser. A plugin that throws a bare `Error` gets mapped to "something went
 * wrong", which is true and useless.
 *
 * `SourceChangedError` is the one that earns its keep. Scrapers do not fail
 * loudly when a site changes — a selector returns nothing, a regex misses, and
 * the plugin returns an empty list that looks exactly like "no episodes yet".
 * Throwing this instead turns a silent wrong answer into a report that names
 * the URL and what was expected, which is the difference between an issue that
 * can be fixed in ten minutes and one that starts with "it doesn't work".
 */

export abstract class KuroPluginError extends Error {
	protected constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

/** The show or episode is not in this source. Not an error worth retrying. */
export class NotFoundError extends KuroPluginError {
	constructor(message = 'Not found in this source.') {
		super(message);
	}
}

/** Transport failed. The host may retry or fall through to another mirror. */
export class NetworkError extends KuroPluginError {
	constructor(
		message: string,
		readonly status?: number
	) {
		super(message);
	}
}

/**
 * The source's shape changed: something the plugin expected is gone.
 *
 * Always pass the URL and say what was being looked for. This message reaches
 * the user *and* the log, and it is the plugin author's only chance to make a
 * breakage self-describing.
 */
export class SourceChangedError extends KuroPluginError {
	constructor(
		readonly expected: string,
		readonly url: string
	) {
		super(`Could not find ${expected} at ${url}. This source has probably changed.`);
	}
}

/** This surface cannot do what the source needs — no WebView, say. */
export class UnsupportedError extends KuroPluginError {
	constructor(message: string) {
		super(message);
	}
}

/** The source is rate-limiting. The host backs off. */
export class RateLimitedError extends KuroPluginError {
	constructor(
		message = 'This source is rate-limiting requests.',
		readonly retryAfterSeconds?: number
	) {
		super(message);
	}
}

/**
 * The host refused a request to a host the manifest did not declare.
 *
 * Thrown by the *host*, not by plugin code, and exported here so a plugin's
 * tests can assert that its `network.hosts` really does cover everything it
 * reaches — which is a test worth writing, because the failure otherwise shows
 * up only on a user's device after install.
 */
export class PermissionDeniedError extends KuroPluginError {
	constructor(
		readonly what: string,
		message: string
	) {
		super(message);
	}
}
