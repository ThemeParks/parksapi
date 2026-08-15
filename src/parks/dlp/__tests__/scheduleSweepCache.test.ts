import {describe, it, expect, vi, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';
import {CacheLib} from '../../../cache.js';

/**
 * The 60-day sweep behind the meet & greet gate is reached from all three
 * public entry points, so it has to survive in the cache — including when the
 * schedule feed is down, which is when re-running it is most expensive.
 *
 * CacheLib reads a cached null back as a miss, so the outage cannot be
 * signalled by returning null; it travels as `answered: false` alongside the
 * ids instead. These tests count calls into getScheduleForDate, which is what
 * a real outage would turn into failed upstream requests.
 */
describe('DLP schedule sweep caching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearAll();
  });

  const sweepingPark = (rows: unknown[]) => {
    CacheLib.clearAll();
    const park = new DisneylandParis();
    const fetch = vi.spyOn(park as any, 'getScheduleForDate').mockResolvedValue(rows);
    return {park, fetch};
  };

  it('sweeps once across repeated calls while the feed is down', async () => {
    const {park, fetch} = sweepingPark([]);

    const first = await (park as any).getScheduledActivityIds();
    const perSweep = fetch.mock.calls.length;
    expect(perSweep).toBeGreaterThan(0);

    await (park as any).getScheduledActivityIds();
    await (park as any).getScheduledActivityIds();

    // The assertion that matters: three calls, one sweep. A null return here
    // would read back as a cache miss and make it three.
    expect(fetch.mock.calls.length).toBe(perSweep);
    expect(first).toEqual({answered: false, ids: []});
  });

  it('sweeps once across repeated calls while the feed is healthy', async () => {
    const {park, fetch} = sweepingPark([
      {id: 'P1MG05', schedules: [{startTime: '10:00:00', endTime: '10:30:00'}]},
      {id: 'P1MG99', schedules: []},
    ]);

    const first = await (park as any).getScheduledActivityIds();
    const perSweep = fetch.mock.calls.length;

    await (park as any).getScheduledActivityIds();

    expect(fetch.mock.calls.length).toBe(perSweep);
    expect(first.answered).toBe(true);
    // A row with no performances is not a reason to publish the entity.
    expect(first.ids).toEqual(['P1MG05']);
    expect(fetch.mock.calls.length).toBe(perSweep);
  });

  it('reports the outage rather than an empty estate', async () => {
    const {park} = sweepingPark([]);
    const withData = await (park as any).getMeetAndGreetIdsWithData();
    // null is the caller's "publish all of them"; an empty Set would unpublish
    // every meet & greet for the 12h the sweep is cached.
    expect(withData).toBeNull();
  });
});
