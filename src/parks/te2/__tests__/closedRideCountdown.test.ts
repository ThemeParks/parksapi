import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {WarnerBrosMovieWorld, SeaWorldGoldCoast} from '../te2.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * While a ride is closed, the TE2 status feed keeps a number in `waitTime`
 * that counts down to opening (342, then 341, then 298 over the night), not a
 * queue length. A standby wait is only published when the ride is open.
 */

const RIDE = 'ride-superman-escape';
const OTHER = 'ride-scooby-doo';

function stubbed<T extends WarnerBrosMovieWorld | SeaWorldGoldCoast>(park: T, opts: {poiStatus?: any[]; rideStatus?: any[]}): T {
  const p: any = park;
  p.getEntities = async () => [
    {id: RIDE, name: 'Superman Escape', entityType: 'ATTRACTION'},
    {id: OTHER, name: 'Scooby-Doo Spooky Coaster', entityType: 'ATTRACTION'},
  ];
  p.getEventCalendar = async () => ({events: [], schedules: []});
  if (opts.rideStatus) {
    p.rideStatusUrl = 'https://ride-status.example/rides';
    p.fetchRideStatus = async () => ({json: async () => opts.rideStatus} as any as HTTPObj);
  } else {
    p.rideStatusUrl = '';
    p.fetchPOIStatus = async () => ({json: async () => opts.poiStatus} as any as HTTPObj);
  }
  return park;
}

describe('TE2 closed-ride countdown', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test.each([342, 341, 298])('a closed ride reading %i publishes no standby queue (POI status feed)', async (value) => {
    const park = stubbed(new WarnerBrosMovieWorld(), {
      poiStatus: [{id: RIDE, status: {isOpen: false, waitTime: value}}],
    });
    const live = await park.getLiveData();
    const ride = live.find(l => l.id === RIDE)!;

    expect(ride.status).toBe('CLOSED');
    expect(ride.queue?.STANDBY).toBeUndefined();
  });

  test('an open ride keeps its wait (POI status feed)', async () => {
    const park = stubbed(new SeaWorldGoldCoast(), {
      poiStatus: [
        {id: RIDE, status: {isOpen: true, waitTime: 15}},
        {id: OTHER, status: {isOpen: true, waitTime: 0}},
      ],
    });
    const live = await park.getLiveData();

    expect(live.find(l => l.id === RIDE)?.queue?.STANDBY?.waitTime).toBe(15);
    expect(live.find(l => l.id === OTHER)?.queue?.STANDBY?.waitTime).toBe(0);
  });

  test('a closed ride on the ride status feed publishes no standby queue', async () => {
    const park = stubbed(new WarnerBrosMovieWorld(), {
      rideStatus: [
        {tags: [`te2_rideid:${RIDE}`], queues: [{isPrimary: true, isOpen: false, waitTimeMins: 341}]},
        {tags: [`te2_rideid:${OTHER}`], queues: [{isPrimary: true, isOpen: true, waitTimeMins: 20}]},
      ],
    });
    const live = await park.getLiveData();

    const closed = live.find(l => l.id === RIDE)!;
    expect(closed.status).toBe('CLOSED');
    expect(closed.queue?.STANDBY).toBeUndefined();
    expect(live.find(l => l.id === OTHER)?.queue?.STANDBY?.waitTime).toBe(20);
  });
});
