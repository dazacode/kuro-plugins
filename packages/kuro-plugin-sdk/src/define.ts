/**
 * `defineSource` — the shape of a plugin bundle's default export.
 *
 * Three required methods, mapping one-to-one onto interfaces both clients
 * already have (`SourceRepository.searchCatalog`, `SourceRepository.listEpisodes`,
 * `PlaybackRepository.resolve`). A plugin is an implementation of contracts
 * that predate it, which is why installing one adds no screens and no
 * branches to the host.
 *
 * There are deliberately no lifecycle hooks. No `onInstall`, no background
 * work, no way to run when nobody asked. A plugin is a pure function of its
 * arguments plus `ctx`, which is what makes it testable offline against
 * recorded traffic and what stops it from being a place to hide behaviour.
 */

import type { SourceContext } from './context';
import type { CatalogPage, PlaybackSource, SourceEpisode } from './types';

export interface SourceDefinition {
	/** Must equal `manifest.id`. Checked at load; a mismatch refuses the plugin. */
	readonly id: string;

	/**
	 * Searches the source's own catalogue.
	 *
	 * `page` is 1-based. `cursor` is whatever the previous page returned, for a
	 * cursor-paginated source; absent on the first page.
	 */
	searchCatalog(
		query: string,
		page: number,
		ctx: SourceContext,
		cursor?: string
	): Promise<CatalogPage>;

	/** Every episode this source can play for `sourceMediaId`, ascending. */
	listEpisodes(sourceMediaId: string, ctx: SourceContext): Promise<readonly SourceEpisode[]>;

	/**
	 * Every way this source can currently play one episode, best first.
	 *
	 * Never return an empty list to mean "nothing plays" — throw `NotFoundError`.
	 * The host's fall-through walks this list, and "success, but nothing to
	 * play" is a state every caller would otherwise have to handle.
	 */
	resolve(
		sourceMediaId: string,
		episode: SourceEpisode,
		ctx: SourceContext
	): Promise<readonly PlaybackSource[]>;

	/**
	 * Optional shelves for the explore screen — `popular`, `latest`, or the
	 * source's own names, declared in `manifest.capabilities` as `browse`.
	 */
	browse?(shelf: string, page: number, ctx: SourceContext, cursor?: string): Promise<CatalogPage>;
}

/**
 * Identity, with a type annotation.
 *
 * It does nothing at runtime on purpose. The value is that a plugin's entry
 * point is a *call* rather than a bare object literal, so the SDK can add
 * validation later without every plugin changing shape, and so the type error
 * for a missing method lands on line one of the file rather than somewhere
 * inside the host.
 */
export function defineSource(definition: SourceDefinition): SourceDefinition {
	return definition;
}
