import {describe, test, expect} from 'vitest';
import {SixFlags} from '../sixflags.js';

/**
 * The venue-status mapping, asserted against the real `mapStatus`.
 *
 * Replaces a block in the old src/__tests__/parkEdgeCases.test.ts that listed
 * these six statuses in a table and then asserted the table's own values
 * matched a regex. It never called this module.
 *
 * The part that table could not express is the one that matters. `mapStatus`
 * takes TWO arguments, and for an empty status the wait time decides — where
 * a zero is not a walk-on but the absence of a reading. The wait-times feed
 * is not gated on park hours: sampled with every park in the estate shut,
 * all 1,000-plus rows across 26 parks read exactly 0. Treating that as
 * evidence of operation reported 21 rides open in the middle of the night.
 */
describe('Six Flags mapStatus', () => {
  const mapStatus = (status: string, waitTime: number | null = null): string =>
    (new SixFlags() as any).mapStatus(status, waitTime);

  test.each([
    ['open', 'OPERATING'],
    ['opened', 'OPERATING'],
    ['temp closed', 'DOWN'],
    ['temp closed due weather', 'DOWN'],
    ['not scheduled', 'CLOSED'],
  ])('%s -> %s', (status, expected) => {
    expect(mapStatus(status)).toBe(expected);
  });

  test('matching is case-insensitive', () => {
    expect(mapStatus('OPEN')).toBe('OPERATING');
    expect(mapStatus('Temp Closed')).toBe('DOWN');
    expect(mapStatus('Not Scheduled')).toBe('CLOSED');
  });

  describe('an empty status falls back to the wait, and only a positive one', () => {
    test('a zero wait is the absence of a reading, not a walk-on', () => {
      expect(mapStatus('', 0)).toBe('CLOSED');
    });

    test('a null wait is CLOSED', () => {
      expect(mapStatus('', null)).toBe('CLOSED');
    });

    test('a positive wait is the evidence the fallback exists for', () => {
      // Canada's Wonderland's "The Daredeviler" was serving 60 minutes while
      // missing from venue-status. That is the row this recovers.
      expect(mapStatus('', 60)).toBe('OPERATING');
      expect(mapStatus('', 1)).toBe('OPERATING');
    });

    test('a negative wait cannot open a ride', () => {
      expect(mapStatus('', -1)).toBe('CLOSED');
    });
  });

  test('an unrecognised status defaults to OPERATING', () => {
    // Deliberate and worth pinning: an unknown value means the feed said
    // something, and the ride is more likely running than not. Distinct from
    // the empty-status case above, which has no statement at all to go on.
    expect(mapStatus('some new status')).toBe('OPERATING');
    expect(mapStatus('some new status', 0)).toBe('OPERATING');
  });
});
