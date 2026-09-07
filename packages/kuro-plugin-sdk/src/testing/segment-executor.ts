/**
 * A reference `SegmentOp` executor, for plugin tests only.
 *
 * The **host** owns the real executors — `lib/core/plugins/segment_pipeline.dart`
 * and `client-web/src/lib/plugins/segment-pipeline.ts` — and a plugin never
 * calls one at runtime. This exists so a plugin author can assert, offline,
 * that the ops they declared actually decode a segment they recorded:
 *
 * ```ts
 * const [source] = await plugin.resolve(id, episode, ctx);
 * const segment = await ctx.http.send(segmentUrl).then((r) => r.bytes());
 * expect(runSegmentOps(segment, source.pipeline!.segment!)[0]).toBe(0x47);
 * ```
 *
 * That test is the difference between "my ops look right" and "my ops turn
 * these bytes into MPEG-TS".
 *
 * Whole-buffer only, deliberately. The streaming path is a host concern and
 * has host tests; duplicating it here would be a third streaming
 * implementation to keep in step for no benefit to a plugin author. What keeps
 * this one honest is that it runs the same `fixtures/stream_pipeline.json` the
 * two host executors do — see `segment-executor.spec.ts`.
 */

import type { SegmentOp } from '../pipeline';

/** Thrown by `assert-byte`, carrying the plugin author's own message. */
export class SegmentAssertionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SegmentAssertionError';
	}
}

export function runSegmentOps(input: Uint8Array, ops: readonly SegmentOp[]): Uint8Array {
	let bytes = input;
	for (const op of ops) {
		switch (op.kind) {
			case 'drop-bytes':
				bytes = bytes.subarray(Math.min(op.count, bytes.length));
				break;
			case 'drop-magic-prefix': {
				for (const candidate of op.cases) {
					const magic = decode(candidate.magic);
					if (startsWith(bytes, magic)) {
						bytes = bytes.subarray(Math.min(candidate.drop, bytes.length));
						break;
					}
				}
				break;
			}
			case 'xor-repeating': {
				const guard = op.unlessByte;
				if (guard !== undefined && bytes.length > guard.at && bytes[guard.at] === guard.equals) {
					break;
				}
				const key = decode(op.key);
				const out = new Uint8Array(bytes.length);
				for (let i = 0; i < bytes.length; i += 1) {
					out[i] = (bytes[i] as number) ^ (key[i % key.length] as number);
				}
				bytes = out;
				break;
			}
			case 'assert-byte':
				if (bytes.length > op.at && bytes[op.at] !== op.equals) {
					throw new SegmentAssertionError(op.because);
				}
				break;
		}
	}
	return bytes;
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
	if (data.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i += 1) if (data[i] !== prefix[i]) return false;
	return true;
}

function decode(value: string): Uint8Array {
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
}

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
