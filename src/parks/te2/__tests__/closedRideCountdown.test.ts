import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {WarnerBrosMovieWorld, SeaWorldGoldCoast} from '../te2.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * The POI status feed carries both `isOpen` and `operationalStatus`. The
 * park's own app reads only `operationalStatus`: it shows a wait when that is
 * "OPEN", shows the ride as down for "DOWN" and closed for "CLOSED", and
 * ignores `isOpen`.
 *
 * While a ride is closed its `waitTime` holds a countdown to opening (342,
 * then 341, then 298 over the night), and a ride that goes down keeps its
 * last wait. Neither is a queue, and the app shows neither, so a standby wait
 * is published only for an OPEN ride.
 */

const RIDE = 'ride-superman-escape';
const OTHER = 'ride-scooby-doo';
const THIRD = 'ride-doomsday-destroyer';

function stubbed<T extends WarnerBrosMovieWorld | SeaWorldGoldCoast>(park: T, opts: {poiStatus?: any[]; rideStatus?: any[]}): T {
  const p: any = park;
  p.getEntities = async () => [
    {id: RIDE, name: 'Superman Escape', entityType: 'ATTRACTION'},
    {id: OTHER, name: 'Scooby-Doo Spooky Coaster', entityType: 'ATTRACTION'},
    {id: THIRD, name: 'Doomsday Destroyer', entityType: 'ATTRACTION'},
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

/** A row shaped like GET /rest/venue/{venueId}/poi/all/status. */
function poiStatus(id: string, operationalStatus: string | undefined, waitTime: number, isOpen: boolean) {
  return {id, status: {isOpen, waitTime, operationalStatus}};
}

async function liveFor(rows: any[]) {
  return stubbed(new WarnerBrosMovieWorld(), {poiStatus: rows}).getLiveData();
}

describe('TE2 live status follows operationalStatus', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test.each([342, 341, 298])('a CLOSED ride counting down (%i) publishes CLOSED with no standby queue', async (value) => {
    const live = await liveFor([poiStatus(RIDE, 'CLOSED', value, false)]);
    const ride = live.find(l => l.id === RIDE)!;

    expect(ride.status).toBe('CLOSED');
    expect(ride.queue?.STANDBY).toBeUndefined();
  });

  test('a CLOSED ride is closed even when isOpen says true', async () => {
    const live = await liveFor([poiStatus(RIDE, 'CLOSED', 342, true)]);
    const ride = live.find(l => l.id === RIDE)!;

    expect(ride.status).toBe('CLOSED');
    expect(ride.queue?.STANDBY).toBeUndefined();
  });

  test('a DOWN ride carrying a stale wait publishes DOWN with no standby queue', async () => {
    const live = await liveFor([poiStatus(RIDE, 'DOWN', 25, false)]);
    const ride = live.find(l => l.id === RIDE)!;

    expect(ride.status).toBe('DOWN');
    expect(ride.queue?.STANDBY).toBeUndefined();
  });

  test('an OPEN ride publishes its wait, whatever isOpen says and in any case', async () => {
    const live = await liveFor([
      poiStatus(RIDE, 'OPEN', 15, true),
      poiStatus(OTHER, 'Open', 0, false),
      poiStatus(THIRD, 'open', 40, true),
    ]);

    for (const [id, wait] of [[RIDE, 15], [OTHER, 0], [THIRD, 40]] as const) {
      const ride = live.find(l => l.id === id)!;
      expect(ride.status).toBe('OPERATING');
      expect(ride.queue?.STANDBY?.waitTime).toBe(wait);
    }
  });

  test('a row with no operationalStatus is not shown as open', async () => {
    const live = await liveFor([poiStatus(RIDE, undefined, 10, true)]);
    const ride = live.find(l => l.id === RIDE)!;

    expect(ride.status).toBe('CLOSED');
    expect(ride.queue?.STANDBY).toBeUndefined();
  });
});

describe('TE2 ride status feed', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('is read as before: open state from the queue, wait passed through', async () => {
    const park = stubbed(new SeaWorldGoldCoast(), {
      rideStatus: [
        {tags: [`te2_rideid:${RIDE}`], queues: [{isPrimary: true, isOpen: false, waitTimeMins: 5}]},
        {tags: [`te2_rideid:${OTHER}`], queues: [{isPrimary: true, isOpen: true, waitTimeMins: 20}]},
      ],
    });
    const live = await park.getLiveData();

    expect(live.find(l => l.id === RIDE)).toMatchObject({status: 'CLOSED', queue: {STANDBY: {waitTime: 5}}});
    expect(live.find(l => l.id === OTHER)).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: 20}}});
  });
});
