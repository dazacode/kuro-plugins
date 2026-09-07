/**
 * The drift alarm between this repository and kuro's `contract/`.
 *
 * `schema/kuro-plugin.schema.json` and `fixtures/stream_pipeline.json` are
 * *copies*. They have to be: the two repositories are deliberately
 * independent — kuro ships no plugins and depends on no plugin repository, so
 * that deleting every plugin still leaves a client that builds (ADR-0002 §6).
 *
 * The cost of independence is that a copy can go stale, and a stale schema is
 * the worst kind: plugins validate green here and are refused by the host. So
 * the copies carry their provenance, and this test asserts the properties that
 * would actually break a plugin if they moved — rather than a byte comparison
 * against a path that only exists on a machine with both repositories checked
 * out.
 *
 * When the host's contract moves: copy both files over, run this, and the
 * failure names what changed.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url).pathname;

const schema = JSON.parse(readFileSync(`${ROOT}schema/kuro-plugin.schema.json`, 'utf8')) as {
	$id: string;
	required: string[];
	$defs: Record<string, { enum?: string[] }>;
};
const vectors = JSON.parse(readFileSync(`${ROOT}fixtures/stream_pipeline.json`, 'utf8')) as {
	lookaheadBytes: number;
	cases: { ops: { kind: string }[] }[];
};

describe('the vendored schema', () => {
	it('is the published contract, not a local invention', () => {
		expect(schema.$id).toBe('https://kuro.app/schema/kuro-plugin.schema.json');
	});

	it('still requires everything the host checks at load', () => {
		// Dropping one of these from the schema would let a plugin package
		// successfully and then be refused on a user's device.
		for (const field of [
			'schemaVersion',
			'id',
			'version',
			'kuroPluginApi',
			'minimumKuroVersion',
			'platforms',
			'capabilities',
			'permissions',
			'entrypoint'
		]) {
			expect(schema.required).toContain(field);
		}
	});

	it('names all six platforms', () => {
		expect(schema.$defs.platform?.enum).toEqual([
			'android',
			'ios',
			'macos',
			'windows',
			'linux',
			'web'
		]);
	});

	it('still specifies the unimplemented JS escape hatch', () => {
		// It must remain expressible and remain unimplemented. A host that
		// silently ignored it would put a JS engine back in the segment path
		// on the platforms least able to afford one (ADR-0002 §2.3).
		expect(schema.$defs.permission?.enum).toContain('segment-transform-js');
	});
});

describe('the vendored vectors', () => {
	it('agree with the SDK about the lookahead', () => {
		expect(vectors.lookaheadBytes).toBe(16);
	});

	it('exercise every op kind the SDK can build', () => {
		// A builder with no vector behind it is a builder whose three
		// implementations have never been compared.
		const covered = new Set(vectors.cases.flatMap((entry) => entry.ops.map((op) => op.kind)));
		expect([...covered].sort()).toEqual([
			'assert-byte',
			'drop-bytes',
			'drop-magic-prefix',
			'xor-repeating'
		]);
	});
});
