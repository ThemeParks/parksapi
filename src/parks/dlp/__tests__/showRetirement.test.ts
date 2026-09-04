import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';
import {CacheLib} from '../../../cache.js';

/**
 * parksapi #74: a DLP show ("Angel's Pop Star Party") ran its last
 * performance, left the POI/schedule feeds entirely, and its live row froze
 * OPERATING with a 7-week-old showtime — dropping a row achieves nothing,
 * the collector is upsert-only. DLP opts into the shared retirement gate
 * (destination.ts) to force-close a show once it's been gone this long.
 */
function stubbedPark(entertainment: Array<Record<string, unknown>>, schedule: unknown[]): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Entertainment: entertainment,
  });
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue([]);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
  vi.spyOn(park as any, 'getScheduleForDate').mockImplementation(async () => schedule);

  return park;
}

const SHOW = {
  id: 'P1GS42', name: "Angel's Pop Star Party", type: 'Entertainment',
  subType: 'Stage Show', location: {id: 'P1'},
};

describe('DLP show retirement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('DisneylandParis');
  });

  afterEach(() => vi.useRealTimers());

  it('is enabled', () => {
    expect(new DisneylandParis()['retireMissingLiveEntities']).toBe(true);
  });

  it('force-closes a show that has been gone from the feed past the retirement window', async () => {
    vi.useFakeTimers();

    await stubbedPark(
      [SHOW],
      [{id: 'P1GS42', schedules: [{date: '2026-06-28', startTime: '11:00:00', endTime: '11:00:00', status: 'PERFORMANCE_TIME'}]}],
    ).getLiveData();

    // The run ended: gone from the POI feed and the schedule feed alike.
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    // The gate wants the absence corroborated across consecutive polls.
    await stubbedPark([], []).getLiveData();
    await stubbedPark([], []).getLiveData();
    const live = await stubbedPark([], []).getLiveData();

    expect(live.find((l) => l.id === 'P1GS42')).toEqual({id: 'P1GS42', status: 'CLOSED'});
  });

  it('does not force-close a show missing for only a few days', async () => {
    vi.useFakeTimers();

    await stubbedPark(
      [SHOW],
      [{id: 'P1GS42', schedules: [{date: '2026-06-28', startTime: '11:00:00', endTime: '11:00:00', status: 'PERFORMANCE_TIME'}]}],
    ).getLiveData();

    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const live = await stubbedPark([], []).getLiveData();

    expect(live.find((l) => l.id === 'P1GS42')).toBeUndefined();
  });
});
