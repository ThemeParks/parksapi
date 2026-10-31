/**
 * Universal's wait-time feed reports a ride with nobody queuing as
 * `status: "NO_WAIT"` (the app prints "No wait"). The STANDBY branch only knew
 * OPEN and RIDE_NOW, so a NO_WAIT ride fell through to CLOSED, and Studio Tour
 * read Closed on the wiki while the park app showed it running. NO_WAIT is an
 * open queue with a walk-on wait. The feed's `display_wait_time` beside it is
 * a placeholder (CLOSED rows carry the same 5), so the published wait is 0.
 */
import {describe, test, expect, afterEach, vi} from 'vitest';
import {UniversalStudios} from '../universal.js';

const PARK = {
  place_id: 'ush.ush',
  name: 'Universal Studios Hollywood',
  venue_id: 'ush.ush',
  place_type: {type: 'Park', attributes: []},
  geometry: {locations: [{location_type: 'map', lat_lng: {lat: 34.1, lng: -118.3}}]},
};
const TOUR = {
  place_id: 'ush.upper_lot.rides.studio_tour',
  name: 'Studio Tour',
  venue_id: 'ush.upper_lot',
  place_type: {type: 'Ride', attributes: []},
};
const MUMMY = {
  place_id: 'ush.lower_lot.rides.revenge_of_the_mummy',
  name: 'Revenge of the Mummy',
  venue_id: 'ush.lower_lot',
  place_type: {type: 'Ride', attributes: []},
};

function stub(waits: any[]): any {
  const park: any = new UniversalStudios();
  park._init = async () => undefined;
  park.getPlaces = async () => [PARK, TOUR, MUMMY];
  park.getWaitTimes = async () => waits;
  park.getShowList = async () => [];
  park.getVirtualQueueStates = async () => [];
  park.getVenueSchedule = async () => [];
  park.getExpressNowOffers = async () => ({});
  park.retireMissingLiveEntities = false;
  return park;
}

function waitRow(id: string, status: string, wait: number | undefined) {
  return {
    wait_time_attraction_id: id,
    queues: [{queue_type: 'STANDBY', status, display_wait_time: wait}],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Universal NO_WAIT standby status', () => {
  test('a NO_WAIT standby queue is OPERATING with a zero wait, not CLOSED', async () => {
    const rows = await stub([waitRow(TOUR.place_id, 'NO_WAIT', 5)]).getLiveData();
    const ride = rows.find((r: any) => r.id === TOUR.place_id);

    expect(ride.status).toBe('OPERATING');
    expect(ride.queue.STANDBY.waitTime).toBe(0);
  });

  test('NO_WAIT with no display reading still publishes a zero wait', async () => {
    const rows = await stub([waitRow(TOUR.place_id, 'NO_WAIT', undefined)]).getLiveData();
    const ride = rows.find((r: any) => r.id === TOUR.place_id);

    expect(ride.status).toBe('OPERATING');
    expect(ride.queue.STANDBY.waitTime).toBe(0);
  });

  test('NO_WAIT reading 995 ("not available") still publishes a zero wait', async () => {
    const rows = await stub([waitRow(TOUR.place_id, 'NO_WAIT', 995)]).getLiveData();
    const ride = rows.find((r: any) => r.id === TOUR.place_id);

    expect(ride.status).toBe('OPERATING');
    expect(ride.queue.STANDBY.waitTime).toBe(0);
  });

  test('a CLOSED queue still reads CLOSED with no wait, and OPEN keeps its reading', async () => {
    const rows = await stub([
      waitRow(TOUR.place_id, 'CLOSED', 5),
      waitRow(MUMMY.place_id, 'OPEN', 10),
    ]).getLiveData();

    const tour = rows.find((r: any) => r.id === TOUR.place_id);
    expect(tour.status).toBe('CLOSED');
    expect(tour.queue?.STANDBY).toBeUndefined();
    expect(rows.find((r: any) => r.id === MUMMY.place_id).queue.STANDBY.waitTime).toBe(10);
  });
});
