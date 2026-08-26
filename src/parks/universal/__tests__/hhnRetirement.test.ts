import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {UniversalOrlando, UniversalStudios} from '../universal.js';
import {CacheLib} from '../../../cache.js';

/**
 * parksapi #519: every Halloween Horror Nights house was serving OPERATING
 * with a standby wait at 10:51 ET, `lastUpdated` between 10 and 15 hours old.
 *
 * The houses are not stuck OPERATING because the feed says so. Universal
 * *drops* them from `wait-time-attraction-list.json` outside the event: at
 * 11:20 ET on 2026-08-26 the feed carried 65 rows and not one of them was an
 * HHN id, while parksapi still published 34 HHN entities. buildLiveData only
 * creates a row for an attraction the feed actually lists, so the houses got
 * no row at all, and a row that is never sent is not a row that says CLOSED —
 * the wiki simply keeps the last value it was given and freezes.
 *
 * Same drop-vs-CLOSED shape as DLP #74 and SHDR #83, so it takes the same
 * shared gate in destination.ts. What differs is the window: those were
 * end-of-run retirements measured in weeks, whereas HHN leaves and rejoins
 * the feed every single night of the season.
 */

const HOUSE_ID = 'uor.usf.rides.hhn_haunted_house_stranger_things_5';
const RIDE_ID = 'uor.usf.rides.revenge_of_the_mummy';

/** Real row shape from wait-time-attraction-list.json. */
const waitRow = (id: string, status: string, wait?: number) => ({
  wait_time_attraction_id: id,
  has_single_rider: false,
  queues: [{queue_type: 'STANDBY', status, ...(wait === undefined ? {} : {display_wait_time: wait})}],
});

function stubbedPark<T extends UniversalOrlando | UniversalStudios>(park: T, waitTimes: any[]): T {
  const p = park as any;
  p._init = async () => undefined;
  p.getWaitTimes = async () => waitTimes;
  p.getVirtualQueueStates = async () => [];
  p.getShowList = async () => [];
  p.getExpressNowOffers = async () => ({});
  return park;
}

const orlando = (waitTimes: any[]) => stubbedPark(new UniversalOrlando(), waitTimes);

/** The window Universal runs, read off the instance rather than hardcoded. */
const windowMs = (): number => (new UniversalOrlando() as any).liveEntityRetirementMs;

describe('Universal HHN live-entity retirement', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('UniversalOrlando');
    CacheLib.clearByClassName('UniversalStudios');
  });

  afterEach(() => {
    vi.useRealTimers();
    CacheLib.clearByClassName('UniversalOrlando');
    CacheLib.clearByClassName('UniversalStudios');
  });

  it('is enabled at both resorts that run the event', () => {
    expect((new UniversalOrlando() as any).retireMissingLiveEntities).toBe(true);
    expect((new UniversalStudios() as any).retireMissingLiveEntities).toBe(true);
  });

  it('closes the window inside a single overnight gap, not a multi-day one', () => {
    // The houses rejoin the feed each event night, so a week-long default
    // would never fire during the season. It still has to clear any plausible
    // in-event gap between two consecutive samples.
    expect(windowMs()).toBeGreaterThan(60 * 60 * 1000);
    expect(windowMs()).toBeLessThan(12 * 60 * 60 * 1000);
  });

  it('force-closes a house once it has been gone longer than the window', async () => {
    vi.useFakeTimers();

    const open = await orlando([waitRow(HOUSE_ID, 'OPEN', 5)]).getLiveData();
    expect(open.find(l => l.id === HOUSE_ID)).toMatchObject({status: 'OPERATING'});

    // Event ends; the house leaves the feed entirely.
    vi.setSystemTime(Date.now() + windowMs() + 60_000);
    const live = await orlando([waitRow(RIDE_ID, 'OPEN', 15)]).getLiveData();

    expect(live.find(l => l.id === HOUSE_ID)).toEqual({id: HOUSE_ID, status: 'CLOSED'});
  });

  it('leaves a house alone while it is only briefly absent', async () => {
    vi.useFakeTimers();

    await orlando([waitRow(HOUSE_ID, 'OPEN', 5)]).getLiveData();

    vi.setSystemTime(Date.now() + Math.floor(windowMs() / 2));
    const live = await orlando([waitRow(RIDE_ID, 'OPEN', 15)]).getLiveData();

    expect(live.find(l => l.id === HOUSE_ID)).toBeUndefined();
  });

  it('never force-closes an entity that has not been live in the first place', async () => {
    // parksapi publishes 34 HHN entities but the wait-time feed lists a
    // handful of houses at most. Scare zones, HHN dining and the DAAP
    // accessibility variants must not be closed on the strength of never
    // having appeared.
    vi.useFakeTimers();

    await orlando([waitRow(RIDE_ID, 'OPEN', 15)]).getLiveData();

    vi.setSystemTime(Date.now() + windowMs() * 10);
    const live = await orlando([waitRow(RIDE_ID, 'OPEN', 15)]).getLiveData();

    expect(live.map(l => l.id)).toEqual([RIDE_ID]);
  });

  it('reopens the house when the next event night puts it back in the feed', async () => {
    vi.useFakeTimers();

    await orlando([waitRow(HOUSE_ID, 'OPEN', 5)]).getLiveData();

    // Daytime: gone long enough to be closed.
    vi.setSystemTime(Date.now() + windowMs() + 60_000);
    const closed = await orlando([waitRow(RIDE_ID, 'OPEN', 15)]).getLiveData();
    expect(closed.find(l => l.id === HOUSE_ID)).toEqual({id: HOUSE_ID, status: 'CLOSED'});

    // Doors open again that evening.
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
    const reopened = await orlando([waitRow(HOUSE_ID, 'OPEN', 10)]).getLiveData();

    expect(reopened.find(l => l.id === HOUSE_ID)).toMatchObject({
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 10}},
    });
  });
});
