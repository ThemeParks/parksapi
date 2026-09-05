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
 * the feed every single night of the season. The timings asserted below are
 * therefore absolute HHN durations, not multiples of whatever the constant
 * happens to be — the value is the whole point of the override.
 */

const HOUSE_ID = 'uor.usf.rides.hhn_haunted_house_stranger_things_5';
const RIDE_ID = 'uor.usf.rides.revenge_of_the_mummy';

const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;

/** Gap between two polls while the day park is shut, per the collector. */
const CLOSED_PARK_POLL_GAP = 45 * MINUTES;
/** Event close (01:00-02:00) to the next night's doors (18:30). */
const DAYTIME_ABSENCE = 16 * HOURS;

/** Real row shape from wait-time-attraction-list.json. */
const waitRow = (id: string, status: string, wait?: number) => ({
  wait_time_attraction_id: id,
  has_single_rider: false,
  queues: [{queue_type: 'STANDBY', status, ...(wait === undefined ? {} : {display_wait_time: wait})}],
});

function stubbedPark<T extends UniversalOrlando | UniversalStudios>(park: T, waitTimes: any[]): T {
  const p = park as any;
  p.getWaitTimes = async () => waitTimes;
  p.getVirtualQueueStates = async () => [];
  // buildLiveData reads the place list to fold express-queue POIs onto their
  // maze; no express variants in these fixtures, so an empty list is exact.
  p.getPlaces = async () => [];
  p.getShowList = async () => [];
  p.getExpressNowOffers = async () => ({});
  return park;
}

const orlando = (waitTimes: any[]) => stubbedPark(new UniversalOrlando(), waitTimes);
const hollywood = (waitTimes: any[]) => stubbedPark(new UniversalStudios(), waitTimes);

/**
 * The gate requires the absence to repeat across consecutive successful
 * builds, so a realistic run of polls is what actually retires an entity.
 */
async function poll(make: () => UniversalOrlando | UniversalStudios, times = 3) {
  let live: Awaited<ReturnType<UniversalOrlando['getLiveData']>> = [];
  for (let i = 0; i < times; i++) live = await make().getLiveData();
  return live;
}

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
    expect(new UniversalOrlando()['retireMissingLiveEntities']).toBe(true);
    expect(new UniversalStudios()['retireMissingLiveEntities']).toBe(true);
  });

  it('fires inside the nightly gap between events, which the shared default would not', async () => {
    vi.useFakeTimers();
    await orlando([waitRow(HOUSE_ID, 'OPEN', 5)]).getLiveData();

    // Morning after an event night, well short of the shared 7-day default.
    vi.setSystemTime(Date.now() + 10 * HOURS);
    const live = await poll(() => orlando([waitRow(RIDE_ID, 'OPEN', 15)]));

    expect(live.find(l => l.id === HOUSE_ID)).toEqual({id: HOUSE_ID, status: 'CLOSED'});
  });

  it('does not fire across a single gap between two polls of a closed park', async () => {
    vi.useFakeTimers();
    await orlando([waitRow(HOUSE_ID, 'OPEN', 5)]).getLiveData();

    // A house missing from one 45-minute-spaced sample is not a retirement.
    vi.setSystemTime(Date.now() + CLOSED_PARK_POLL_GAP);
    const live = await poll(() => orlando([waitRow(RIDE_ID, 'OPEN', 15)]));

    expect(live.find(l => l.id === HOUSE_ID)).toBeUndefined();
  });

  it('still leaves margin before the next night’s doors open', async () => {
    // Whatever the window is, it has to fire strictly inside the daytime
    // absence or the house is never closed between events at all.
    expect(new UniversalOrlando()['liveEntityRetirementMs']).toBeLessThan(DAYTIME_ABSENCE);
    // And it has to outlast a normal closed-park polling gap by a margin.
    expect(new UniversalOrlando()['liveEntityRetirementMs']).toBeGreaterThan(2 * CLOSED_PARK_POLL_GAP);
  });

  it('retires exactly at the window boundary, not a poll later', async () => {
    vi.useFakeTimers();
    const park = new UniversalOrlando();
    const windowMs = park['liveEntityRetirementMs'];

    await orlando([waitRow(HOUSE_ID, 'OPEN', 5)]).getLiveData();
    vi.setSystemTime(Date.now() + windowMs);
    const live = await poll(() => orlando([waitRow(RIDE_ID, 'OPEN', 15)]));

    expect(live.find(l => l.id === HOUSE_ID)).toEqual({id: HOUSE_ID, status: 'CLOSED'});
  });

  it('closes a Hollywood house on the same terms', async () => {
    vi.useFakeTimers();
    const ushHouse = 'ush.usf.rides.hhn_haunted_house_terror_tram';
    await hollywood([waitRow(ushHouse, 'OPEN', 5)]).getLiveData();

    vi.setSystemTime(Date.now() + 10 * HOURS);
    const live = await poll(() => hollywood([waitRow('ush.usf.rides.jurassic_world', 'OPEN', 20)]));

    expect(live.find(l => l.id === ushHouse)).toEqual({id: ushHouse, status: 'CLOSED'});
  });

  it('keeps the two resorts’ tracking apart', async () => {
    vi.useFakeTimers();
    await orlando([waitRow(HOUSE_ID, 'OPEN', 5)]).getLiveData();

    // Hollywood has never seen the Orlando house and must not close it.
    vi.setSystemTime(Date.now() + 10 * HOURS);
    const live = await poll(() => hollywood([waitRow('ush.usf.rides.jurassic_world', 'OPEN', 20)]));

    expect(live.map(l => l.id)).toEqual(['ush.usf.rides.jurassic_world']);
  });

  it('never force-closes an entity that has not been live in the first place', async () => {
    // parksapi publishes 34 HHN entities but the wait-time feed lists a
    // handful of houses at most. Scare zones, HHN dining and the DAAP
    // accessibility variants must not be closed on the strength of never
    // having appeared.
    vi.useFakeTimers();
    await orlando([waitRow(RIDE_ID, 'OPEN', 15)]).getLiveData();

    vi.setSystemTime(Date.now() + 40 * HOURS);
    const live = await poll(() => orlando([waitRow(RIDE_ID, 'OPEN', 15)]));

    expect(live.map(l => l.id)).toEqual([RIDE_ID]);
  });

  it('reopens the house when the next event night puts it back in the feed', async () => {
    vi.useFakeTimers();
    await orlando([waitRow(HOUSE_ID, 'OPEN', 5)]).getLiveData();

    vi.setSystemTime(Date.now() + 10 * HOURS);
    const closed = await poll(() => orlando([waitRow(RIDE_ID, 'OPEN', 15)]));
    expect(closed.find(l => l.id === HOUSE_ID)).toEqual({id: HOUSE_ID, status: 'CLOSED'});

    // Doors open again that evening.
    vi.setSystemTime(Date.now() + 8 * HOURS);
    const reopened = await orlando([waitRow(HOUSE_ID, 'OPEN', 10)]).getLiveData();

    expect(reopened.find(l => l.id === HOUSE_ID)).toMatchObject({
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 10}},
    });
  });

  /**
   * The shortened window is what makes a degraded feed reachable: the CDN
   * serving a valid but gutted array parses cleanly and never throws, so
   * without a guard every ride at the resort publishes CLOSED while the park
   * is open.
   */
  it('withholds every close when the whole wait-time feed empties', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rides = Array.from({length: 10}, (_, i) => waitRow(`uor.usf.rides.ride_${i}`, 'OPEN', 10));

    await orlando(rides).getLiveData();

    vi.setSystemTime(Date.now() + 10 * HOURS);
    const live = await poll(() => orlando([]));

    expect(live).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('feed looks degraded'));
    warn.mockRestore();
  });

  it('rejects a show feed that is not an array rather than closing every show', async () => {
    const park = new UniversalOrlando() as any;
    park.fetchShowList = async () => ({json: async () => ({error: 'nope'})});

    await expect(park.getShowList()).rejects.toThrow(/expected an array/);
  });
});
