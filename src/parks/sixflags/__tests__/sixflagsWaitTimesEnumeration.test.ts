import {describe, test, expect, beforeEach} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';
import type {LiveData} from '@themeparks/typelib';

/**
 * Regression coverage for rides that appear in /wait-times but not in
 * /venue-status.
 *
 * buildParkLiveData() enumerates rides from the venue-status response and
 * treats wait-times purely as a secondary lookup. A ride the vendor omits
 * from venue-status is therefore never iterated, and its live wait time is
 * discarded even though the library already fetched it.
 *
 * Confirmed live on 2026-07-23 for Canada's Wonderland (park 40): "The
 * Daredeviler" (RIDE-040-00072) was serving a 60 minute standby wait in
 * /wait-times/park/40, was absent from /venue-status/park/40 (79 rides) and
 * absent from /poi/park/40. Because parksapi emitted no record for it, the
 * hosted collector never wrote an update and themeparks.wiki kept serving a
 * CLOSED record frozen at 2026-04-20 for three months, while the ride was
 * physically operating.
 *
 * Rides genuinely removed from the park (Time Warp, Speed City Raceway) are
 * absent from wait-times too, so enumerating the union of both feeds
 * resurrects only rides the vendor is still publishing live data for.
 */

/** Park 40 = Canada's Wonderland. */
const PARK_ID = 40;

/** Shapes mirror the real Six Flags API responses. */
const VENUE_STATUS = {
  parkName: "Canada's Wonderland",
  lat: '43.843',
  lng: '-79.539',
  venues: [
    {
      venueId: 1,
      details: [
        {fimsId: 'RIDE-040-00199', name: 'Alpen Fury', status: 'Opened'},
        {fimsId: 'RIDE-040-00076', name: 'Antique Carrousel', status: 'Opened'},
      ],
    },
  ],
};

const WAIT_TIMES = {
  venues: [
    {
      venueId: 1,
      details: [
        {
          fimsId: 'RIDE-040-00199',
          name: 'Alpen Fury',
          regularWaittime: {waitTime: 25},
        },
        {
          // Present in wait-times, ABSENT from venue-status. The bug.
          fimsId: 'RIDE-040-00072',
          name: 'The Daredeviler',
          isFastLane: true,
          regularWaittime: {waitTime: 60},
          fastlaneWaittime: {waitTime: 10},
        },
      ],
    },
  ],
};

class Probe extends SixFlags {
  override async getParkData(): Promise<any> {
    return [{parkId: PARK_ID, code: 'CW', name: "Canada's Wonderland", waterParks: []}];
  }

  override async getVenueStatus(): Promise<any> {
    return VENUE_STATUS;
  }

  override async getWaitTimes(): Promise<any> {
    return WAIT_TIMES;
  }

  /** Expose the protected template method for direct assertion. */
  public buildLiveDataForTest(): Promise<LiveData[]> {
    return (this as any).buildLiveData();
  }
}

describe('SixFlags live data enumeration across venue-status and wait-times', () => {
  beforeEach(() => {
    CacheLib.clearByClassName('Probe');
  });

  test('emits a ride present in wait-times but absent from venue-status', async () => {
    const live = await new Probe().buildLiveDataForTest();
    const ids = live.map(l => l.id);

    expect(ids).toContain('RIDE-040-00072');
  });

  test('reports that ride as OPERATING with its standby wait, not CLOSED', async () => {
    const live = await new Probe().buildLiveDataForTest();
    const deviler = live.find(l => l.id === 'RIDE-040-00072');

    expect(deviler?.status).toBe('OPERATING');
    expect(deviler?.queue?.STANDBY?.waitTime).toBe(60);
  });

  test('carries the Fast Lane wait through as PAID_STANDBY', async () => {
    const live = await new Probe().buildLiveDataForTest();
    const deviler = live.find(l => l.id === 'RIDE-040-00072');

    expect(deviler?.queue?.PAID_STANDBY?.waitTime).toBe(10);
  });

  test('still emits rides that are only in venue-status', async () => {
    const live = await new Probe().buildLiveDataForTest();

    expect(live.map(l => l.id)).toContain('RIDE-040-00076');
  });

  test('does not duplicate a ride present in both feeds', async () => {
    const live = await new Probe().buildLiveDataForTest();
    const alpen = live.filter(l => l.id === 'RIDE-040-00199');

    expect(alpen).toHaveLength(1);
    expect(alpen[0].queue?.STANDBY?.waitTime).toBe(25);
  });

  test('does not invent rides absent from both feeds', async () => {
    const live = await new Probe().buildLiveDataForTest();
    const names = live.map(l => l.id);

    // Time Warp / Speed City Raceway were removed from the park and appear
    // in neither feed, so nothing should resurrect them.
    expect(names).toHaveLength(3);
  });

  test('emits a wait-times-only ride with no posted wait as CLOSED, no standby time', async () => {
    // The union recovers rides from wait-times, but a wait-times row without
    // a live wait is not evidence the ride is operating. mapStatus('') must
    // fall back to CLOSED, and the record must carry no standby wait. This
    // pins the other half of the mapStatus('') contract the fix relies on.
    class ClosedProbe extends Probe {
      override async getWaitTimes(): Promise<any> {
        return {
          venues: [
            {
              venueId: 1,
              details: [
                {fimsId: 'RIDE-040-00199', name: 'Alpen Fury', regularWaittime: {waitTime: 25}},
                // In wait-times, no regularWaittime, absent from venue-status.
                {fimsId: 'RIDE-040-00500', name: 'Dormant Ride'},
              ],
            },
          ],
        };
      }
    }

    const live = await new ClosedProbe().buildLiveDataForTest();
    const dormant = live.find(l => l.id === 'RIDE-040-00500');

    expect(dormant?.status).toBe('CLOSED');
    expect(dormant?.queue?.STANDBY?.waitTime).toBeUndefined();
  });
});
