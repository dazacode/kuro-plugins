/**
 * `@kuro/plugin-sdk/testing` — the offline harness.
 *
 * A plugin's suite runs with no network, no account and no source availability,
 * because a suite that needs any of those is a suite that is red for reasons
 * that are nobody's fault and gets ignored within a fortnight.
 */

export { Cassette, type CassetteMode, type Tape, type TapeEntry } from './cassette';
export { fakeContext, hostMatches, type FakeContextOptions } from './fake-context';
export { runSegmentOps, SegmentAssertionError } from './segment-executor';
export { pluginTest, type PluginTestKit } from './kit';
