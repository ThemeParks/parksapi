/**
 * Universal's wait-time feed uses 995 in `display_wait_time` to mean "not
 * available". The EXPRESS branch and the express-variant fold already skip it,
 * but the STANDBY branch published it as a 995-minute wait. A 995 on a STANDBY
 * queue now publishes no wait, while the ride keeps whatever status its queues
 * give it.
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
const SIMPSONS = {
  place_id: 'ush.upper_lot.rides.the_simpsons_ride',
  name: 'The Simpsons Ride',
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
  park.getPlaces = async () => [PARK, SIMPSONS, MUMMY];
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

describe('Universal STANDBY "not available" sentinel', () => {
  test('an OPEN standby queue reading 995 publishes no wait', async () => {
    const rows = await stub([waitRow(SIMPSONS.place_id, 'OPEN', 995)]).getLiveData();
    const ride = rows.find((r: any) => r.id === SIMPSONS.place_id);

    expect(ride.status).toBe('OPERATING');
    expect(ride.queue?.STANDBY?.waitTime ?? null).toBeNull();
  });

  test('a RIDE_NOW standby queue reading 995 publishes no wait either', async () => {
    const rows = await stub([waitRow(SIMPSONS.place_id, 'RIDE_NOW', 995)]).getLiveData();
    const ride = rows.find((r: any) => r.id === SIMPSONS.place_id);

    expect(ride.queue?.STANDBY?.waitTime ?? null).toBeNull();
  });

  test('ordinary readings are unchanged', async () => {
    const rows = await stub([
      waitRow(SIMPSONS.place_id, 'OPEN', 20),
      waitRow(MUMMY.place_id, 'RIDE_NOW', undefined),
    ]).getLiveData();

    expect(rows.find((r: any) => r.id === SIMPSONS.place_id).queue.STANDBY.waitTime).toBe(20);
    expect(rows.find((r: any) => r.id === MUMMY.place_id).queue.STANDBY.waitTime).toBe(0);
  });
});
