import {describe, test, expect, vi} from 'vitest';
import {Efteling} from '../efteling.js';

/**
 * The WIS state mapping, asserted against the real `mapState`.
 *
 * This replaces a block in the old src/__tests__/parkEdgeCases.test.ts which
 * wrote the same nine states into a table and then asserted that the table's
 * own values matched a regex of the four valid statuses. It imported nothing
 * from this module, so it passed whatever mapState did — and it would have
 * gone on passing if mapState had been deleted outright.
 *
 * The table there happened to be correct, which is why every case below
 * matches it. That was luck, not coverage: the sibling block for another park
 * asserted the opposite of its park's shipped behaviour for as long as it
 * existed.
 */
describe('Efteling mapState', () => {
  const mapState = (state: string): string =>
    (new Efteling() as any).mapState(state);

  test.each([
    ['open', 'OPERATING'],
    ['storing', 'DOWN'],
    ['tijdelijkbuitenbedrijf', 'DOWN'],
    ['inonderhoud', 'REFURBISHMENT'],
    ['buitenbedrijf', 'CLOSED'],
    ['gesloten', 'CLOSED'],
    ['', 'CLOSED'],
    ['wachtrijgesloten', 'CLOSED'],
    ['nognietopen', 'CLOSED'],
  ])('%s -> %s', (state, expected) => {
    expect(mapState(state)).toBe(expected);
  });

  test('the match is case-insensitive, as the feed is not consistent', () => {
    expect(mapState('OPEN')).toBe('OPERATING');
    expect(mapState('Storing')).toBe('DOWN');
  });

  test('an unknown state warns and fails safe to CLOSED', () => {
    // The branch the old table could not reach at all. Failing safe matters:
    // a new Dutch state string must not read as OPERATING by default.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapState('eenNieuweStatus')).toBe('CLOSED');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('eenNieuweStatus'));
    warn.mockRestore();
  });

  test('a null/undefined state does not throw', () => {
    // mapState takes `state?.toLowerCase()`, so the optional chain is load
    // bearing for a row whose state field is missing entirely.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapState(undefined as any)).toBe('CLOSED');
    expect(mapState(null as any)).toBe('CLOSED');
    warn.mockRestore();
  });
});
