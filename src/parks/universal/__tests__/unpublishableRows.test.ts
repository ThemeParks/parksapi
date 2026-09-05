/**
 * Universal's live feeds and its place feed disagree about what exists.
 * show-list and the wait-time feed emit readings for things buildEntityList
 * has no entity for, in four ways seen live at Hollywood:
 *
 *   - ids the PLACE feed has never heard of (`ush.mms.minion.dance.party`;
 *     `ush.upper.lot.shows.meet_james.henry` is dotted where every other id is
 *     underscored, an older id shape leaking in)
 *   - event-variant aliases dropped as duplicates (Studio Tour Last Tram, and
 *     the Mandarin/Spanish variants whose share links point at WaterWorld)
 *   - children of a venue with no wiki representation (CityWalk)
 *   - a place whose type placeToEntity does not map (an `Events`-typed ride)
 *
 * Those rows cannot be resolved by any consumer, so they are built, pushed and
 * then dropped downstream. buildLiveData now filters them.
 *
 * The filter is derived from buildEntityList rather than by re-testing the
 * predicates, so the risk moves to its INPUT: getPlaces coerces a malformed
 * 200 to [] and caches it for 12h, which would otherwise blank every wait time
 * for half a day. Both bail-outs are pinned here.
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
const RIDE = {
  place_id: 'ush.upper_lot.rides.the_simpsons_ride',
  name: 'The Simpsons Ride',
  venue_id: 'ush.upper_lot',
  place_type: {type: 'Ride', attributes: []},
};
const CITYWALK_SHOW = {
  place_id: 'ush.cw.entertainment.street_performers',
  name: 'Street Performers',
  venue_id: 'ush.cw',
  place_type: {type: 'Show', attributes: []},
};

function stub(places: any[], waits: any[], shows: any[] = []): any {
  const park: any = new UniversalStudios();
  park._init = async () => undefined;
  park.getPlaces = async () => places;
  park.getWaitTimes = async () => waits;
  park.getShowList = async () => shows;
  park.getVirtualQueueStates = async () => [];
  park.getVenueSchedule = async () => [];
  park.getExpressNowOffers = async () => ({});
  // Retirement force-closes ids that vanish from the feed; it runs after
  // buildLiveData and is a separate concern, so keep it out of these numbers.
  park.retireMissingLiveEntities = false;
  return park;
}

function waitRow(id: string, wait: number) {
  return {
    wait_time_attraction_id: id,
    queues: [{queue_type: 'STANDBY', status: 'OPEN', display_wait_time: wait}],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Universal buildLiveData — rows for entities that are never published', () => {
  test('a row whose id the place feed has never heard of is dropped', async () => {
    const rows = await stub(
      [PARK, RIDE],
      [waitRow('ush.upper_lot.rides.the_simpsons_ride', 20), waitRow('ush.mms.minion.dance.party', 5)],
    ).getLiveData();
    expect(rows.map((r: any) => r.id)).toEqual(['ush.upper_lot.rides.the_simpsons_ride']);
  });

  test("a row for a dropped venue's child is dropped", async () => {
    // CityWalk is not a park on the wiki, so its children are never emitted.
    const park = stub([PARK, RIDE, CITYWALK_SHOW], [waitRow('ush.upper_lot.rides.the_simpsons_ride', 20)], [{
      show_id: 'ush.cw.entertainment.street_performers',
      venue_id: 'ush.cw',
      name: 'Street Performers',
      status: 'OPEN',
      show_externally: true,
    }]);
    const rows = await park.getLiveData();
    expect(rows.some((r: any) => r.id === 'ush.cw.entertainment.street_performers')).toBe(false);
    expect(rows.some((r: any) => r.id === 'ush.upper_lot.rides.the_simpsons_ride')).toBe(true);
  });

  test('rows for entities that ARE published survive untouched', async () => {
    const rows = await stub([PARK, RIDE], [waitRow('ush.upper_lot.rides.the_simpsons_ride', 20)]).getLiveData();
    expect(rows).toHaveLength(1);
    expect(rows[0].queue.STANDBY.waitTime).toBe(20);
    expect(rows[0].status).toBe('OPERATING');
  });

  test('an unusable entity list publishes every row rather than blanking the feed', async () => {
    // getPlaces coerces a malformed 200 to [] and caches it for 12h. Filtering
    // on that would silently drop every wait time for half a day — far worse
    // than the unresolvable rows this filter exists to remove.
    const park = stub([], [
      waitRow('ush.upper_lot.rides.the_simpsons_ride', 20),
      waitRow('ush.upper_lot.rides.revenge_of_the_mummy', 35),
    ]);
    const rows = await park.getLiveData();
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.queue.STANDBY.waitTime).sort()).toEqual([20, 35]);
  });

  test('a failing entity list publishes every row rather than throwing', async () => {
    // buildEntityList is allowed to fail loudly; buildLiveData is not.
    const park = stub([PARK, RIDE], [waitRow('ush.upper_lot.rides.the_simpsons_ride', 20)]);
    park.buildEntityList = async () => { throw new Error('places 500'); };
    const rows = await park.getLiveData();
    expect(rows).toHaveLength(1);
    expect(rows[0].queue.STANDBY.waitTime).toBe(20);
  });

  test('a minority of unpublishable rows is still filtered', async () => {
    // The guard must not be so blunt it disables the fix: one bad row among
    // several good ones is the real-world shape (10 of 57 at Hollywood).
    const places = [PARK, RIDE,
      {...RIDE, place_id: 'ush.upper_lot.rides.revenge_of_the_mummy', name: 'Revenge of the Mummy'},
      {...RIDE, place_id: 'ush.upper_lot.rides.transformers', name: 'Transformers'}];
    const rows = await stub(places, [
      waitRow('ush.upper_lot.rides.the_simpsons_ride', 20),
      waitRow('ush.upper_lot.rides.revenge_of_the_mummy', 35),
      waitRow('ush.upper_lot.rides.transformers', 15),
      waitRow('ush.mms.minion.dance.party', 5),
    ]).getLiveData();
    expect(rows).toHaveLength(3);
    expect(rows.some((r: any) => r.id === 'ush.mms.minion.dance.party')).toBe(false);
  });
});
