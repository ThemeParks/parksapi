import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {ShanghaiDisneylandResort} from '../shanghaidisneyresort.js';
import {CacheLib} from '../../../cache.js';

/**
 * parksapi #83: 4 SHDR shows were found frozen (one 17 days stale, still
 * OPERATING) after their run ended and they left the wait-times/facility
 * feeds entirely. Sibling of DLP #74 — same drop-vs-CLOSED pattern, fixed
 * the same way via the shared retirement gate in destination.ts.
 */
function stubbedPark(facilities: Array<Record<string, unknown>>, waitTimes: Array<Record<string, unknown>>): ShanghaiDisneylandResort {
  const park = new ShanghaiDisneylandResort();
  vi.spyOn(park as any, 'getFacilities').mockResolvedValue(facilities);
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue(waitTimes);
  return park;
}

const SHOW = {id: 'show-birthday-bash', name: '10th Birthday Bash: Summer Beats Celebration', type: 'Entertainment'};
const showWaitEntry = {id: 'show-birthday-bash', waitTime: {status: 'Operating'}};

describe('SHDR show retirement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ShanghaiDisneylandResort');
  });

  afterEach(() => vi.useRealTimers());

  it('is enabled', () => {
    expect(new ShanghaiDisneylandResort()['retireMissingLiveEntities']).toBe(true);
  });

  it('force-closes a show that has been gone from the feed past the retirement window', async () => {
    vi.useFakeTimers();

    await stubbedPark([SHOW], [showWaitEntry]).getLiveData();

    // Run ends: gone from both the facility list and the wait-times feed.
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const live = await stubbedPark([], []).getLiveData();

    expect(live.find((l) => l.id === 'show-birthday-bash')).toEqual({id: 'show-birthday-bash', status: 'CLOSED'});
  });

  it('does not force-close a show missing for only a few days', async () => {
    vi.useFakeTimers();

    await stubbedPark([SHOW], [showWaitEntry]).getLiveData();

    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const live = await stubbedPark([], []).getLiveData();

    expect(live.find((l) => l.id === 'show-birthday-bash')).toBeUndefined();
  });
});
