/**
 * The SDK's test executor, pinned to the same vectors as the two host ones.
 *
 * There are now three implementations of `SegmentOp` in this system — Dart for
 * the five Flutter targets, TypeScript for the browser, and this one so plugin
 * authors can assert offline. Three implementations is three chances to
 * disagree, and a disagreement here would be worse than useless: an author's
 * test would go green while the thing that actually plays the episode
 * produced different bytes.
 *
 * `fixtures/stream_pipeline.json` is a copy of `contract/fixtures/` in the
 * kuro repository, and `schema-sync.spec.ts` is what notices when it drifts.
 */

import { describe, expect, it } from 'vitest';

import vectors from '../../../../fixtures/stream_pipeline.json';
import type { SegmentOp } from '../pipeline';
import { runSegmentOps } from './segment-executor';

interface Vector {
	readonly name: string;
	readonly why: string;
	readonly input: string;
	readonly ops: readonly SegmentOp[];
	readonly output?: string;
	readonly throws?: string;
}

function decode(value: string): Uint8Array {
	return Uint8Array.from(Buffer.from(value, 'base64'));
}

describe('the contract vectors', () => {
	const cases = vectors.cases as readonly Vector[];

	it('are present, so a missing fixture cannot read as a green suite', () => {
		expect(cases.length).toBeGreaterThan(10);
	});

	for (const vector of cases) {
		it(`${vector.name}: ${vector.why}`, () => {
			const input = decode(vector.input);
			if (vector.throws !== undefined) {
				expect(() => runSegmentOps(input, vector.ops)).toThrowError(vector.throws);
				return;
			}
			expect(Array.from(runSegmentOps(input, vector.ops))).toEqual(
				Array.from(decode(vector.output as string))
			);
		});
	}
});
