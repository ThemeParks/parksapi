/**
 * Universal Studios Hollywood's place feed carries a land's signage as a Ride:
 * `ush.lower_lot.rides.snw.park.signage`, named "Super Nintendo World" after
 * the land that also exists as a Land place. It is a walk-through marker, not
 * an attraction, and nothing in its attributes says so: it has the same type,
 * categories (kid-friendly, walk-thru-attraction) and `is_event=true` as
 * `ush.lower_lot.rides.bowser.jr.challenge`, a real walk-through attraction
 * inside the same land. The place's own id is the only thing that names it:
 * the last segment is `signage`.
 *
 * Fixture places keep the live ids, names, types and attributes.
 */
import {describe, test, expect, afterEach, beforeEach, vi} from 'vitest';
import {UniversalStudios, isSignagePlace, type UniversalPlace} from '../universal.js';
import {CacheLib} from '../../../cache.js';

const attrs = (isEvent: boolean) => [
  {name: 'express_pass', value: 'false'},
  {name: 'is_event', value: String(isEvent)},
  {name: 'is_kid_friendly', value: 'true'},
  {name: 'has_single_rider', value: 'false'},
];

const PARK: UniversalPlace = {
  place_id: 'ush.ush',
  name: 'Universal Studios Hollywood',
  resort_area_code: 'ush',
  venue_id: 'ush.ush',
  place_type: {type: 'Park', attributes: []},
  geometry: {locations: [{location_type: 'map', lat_lng: {lat: 34.1, lng: -118.3}}]},
};

const SIGNAGE: UniversalPlace = {
  place_id: 'ush.lower_lot.rides.snw.park.signage',
  name: 'Super Nintendo World',
  resort_area_code: 'ush',
  venue_id: 'ush.lower_lot',
  land_id: 'ush.lower_lot.super_nintendo_world',
  place_type: {type: 'Ride', categories: ['kid-friendly', 'walk-thru-attraction'], attributes: attrs(true)},
};

// The real walk-through in the same land: identical type, categories and flag.
const BOWSER_JR: UniversalPlace = {
  place_id: 'ush.lower_lot.rides.bowser.jr.challenge',
  name: 'Bowser Jr. Challenge',
  resort_area_code: 'ush',
  venue_id: 'ush.lower_lot',
  land_id: 'ush.lower_lot.super_nintendo_world',
  place_type: {type: 'Ride', categories: ['kid-friendly', 'walk-thru-attraction'], attributes: attrs(true)},
};

const MARIO_KART: UniversalPlace = {
  place_id: 'ush.upper_lot.rides.mario_kart_bowsers_challenge',
  name: 'Mario Kart™: Bowser’s Challenge',
  resort_area_code: 'ush',
  venue_id: 'ush.upper_lot',
  place_type: {type: 'Ride', categories: ['3D-4D-experience'], attributes: attrs(false)},
};

const LAND: UniversalPlace = {
  place_id: 'ush.lower_lot.super_nintendo_world',
  name: 'SUPER NINTENDO WORLD™',
  resort_area_code: 'ush',
  venue_id: 'ush.lower_lot',
  place_type: {type: 'Land', attributes: []},
};

const place = (place_id: string, name: string, type = 'Ride'): UniversalPlace => ({
  place_id, name, resort_area_code: 'ush', venue_id: 'ush.lower_lot',
  place_type: {type, attributes: attrs(false)},
});

describe('isSignagePlace', () => {
  test('the Super Nintendo World signage is signage', () => {
    expect(isSignagePlace(SIGNAGE)).toBe(true);
  });

  test('a Show or Dining place whose id ends in signage is signage too', () => {
    expect(isSignagePlace(place('ush.upper_lot.shows.wizarding.signage', 'Hogsmeade', 'Show'))).toBe(true);
    expect(isSignagePlace(place('ush.dining.some.sign.signage', 'Entrance', 'Dining'))).toBe(true);
  });

  test('the case of the segment does not matter', () => {
    expect(isSignagePlace(place('ush.lower_lot.rides.snw.park.Signage', 'Super Nintendo World'))).toBe(true);
  });

  test.each([
    ['the walk-through in the same land, with identical flags', BOWSER_JR],
    ['a ride that shares the land\'s name', place('ush.lower_lot.rides.super_nintendo_world', 'Super Nintendo World')],
    ['a ride', MARIO_KART],
    ['a land', LAND],
    ['a place whose NAME says signage', place('ush.lower_lot.rides.snw.entry', 'Park Signage Tour')],
    ['an id that only starts a segment with signage', place('ush.lower_lot.rides.signage_walk', 'Signage Walk')],
    ['an id that carries signage mid-path', place('ush.signage.rides.snw_gate', 'Gate')],
    ['an id that ends in a longer word', place('ush.lower_lot.rides.snw.nosignage', 'Gate')],
  ])('%s is not signage', (_label, p) => {
    expect(isSignagePlace(p)).toBe(false);
  });

  test('tolerates a place with no id', () => {
    expect(isSignagePlace({...SIGNAGE, place_id: undefined as unknown as string})).toBe(false);
  });
});

function stub(places: UniversalPlace[], waits: unknown[] = [], retire = false): any {
  const park: any = new UniversalStudios();
  park._init = async () => undefined;
  park.getPlaces = async () => places;
  park.getWaitTimes = async () => waits;
  park.getShowList = async () => [];
  park.getVirtualQueueStates = async () => [];
  park.getVenueSchedule = async () => [];
  park.getExpressNowOffers = async () => ({});
  park.retireMissingLiveEntities = retire;
  return park;
}

const waitRow = (id: string, wait: number) => ({
  wait_time_attraction_id: id,
  queues: [{queue_type: 'STANDBY', status: 'OPEN', display_wait_time: wait}],
});

afterEach(() => vi.restoreAllMocks());

describe('Universal Hollywood publishes no signage place', () => {
  const PLACES = [PARK, LAND, SIGNAGE, BOWSER_JR, MARIO_KART];

  test('the signage place is not an entity', async () => {
    const entities = await stub(PLACES).getEntities();
    expect(entities.map((e: any) => e.id)).not.toContain('ush.lower_lot.rides.snw.park.signage');
  });

  test('the walk-through beside it and the other rides are', async () => {
    const entities = await stub(PLACES).getEntities();
    const attractions = entities.filter((e: any) => e.entityType === 'ATTRACTION');
    expect(attractions.map((e: any) => e.id).sort()).toEqual([
      'ush.lower_lot.rides.bowser.jr.challenge',
      'ush.upper_lot.rides.mario_kart_bowsers_challenge',
    ]);
    expect(attractions.find((e: any) => e.id === 'ush.lower_lot.rides.bowser.jr.challenge')?.name).toBe('Bowser Jr. Challenge');
  });

  test('a wait-time row for the signage id is not published', async () => {
    const rows = await stub(PLACES, [
      waitRow('ush.lower_lot.rides.snw.park.signage', 0),
      waitRow('ush.upper_lot.rides.mario_kart_bowsers_challenge', 35),
    ]).getLiveData();
    expect(rows.map((r: any) => r.id)).toEqual(['ush.upper_lot.rides.mario_kart_bowsers_challenge']);
  });
});

describe('a signage id that was already live before it was filtered', () => {
  const SIGNAGE_ID = 'ush.lower_lot.rides.snw.park.signage';
  const RIDE_ID = 'ush.upper_lot.rides.mario_kart_bowsers_challenge';
  const PLACES = [PARK, LAND, SIGNAGE, BOWSER_JR, MARIO_KART];
  const T0 = Date.parse('2026-10-14T20:00:00Z');
  const HOUR = 3600_000;

  beforeEach(() => {
    CacheLib.clearByClassName('UniversalStudios', {includePersistent: true});
  });
  afterEach(() => {
    vi.useRealTimers();
    CacheLib.clearByClassName('UniversalStudios', {includePersistent: true});
  });

  // The feed still lists the signage place, as it did while it was published.
  const waits = () => [
    waitRow(SIGNAGE_ID, 0),
    waitRow(RIDE_ID, 35),
    waitRow('ush.lower_lot.rides.bowser.jr.challenge', 5),
  ];

  // The gate's tracker as an earlier build left it: both ids seen five hours ago.
  async function seed() {
    const probe = stub(PLACES, waits(), true);
    const key = await probe.liveEntityRetirementCacheKey();
    CacheLib.set(key, {
      [SIGNAGE_ID]: {seenAt: T0 - 5 * HOUR, misses: 0},
      [RIDE_ID]: {seenAt: T0 - 5 * HOUR, misses: 0},
    }, 400 * 24 * 3600);
  }

  test('the retirement gate closes it once the absence has held, with one CLOSED row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    await seed();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const rowsFor = async () => (await stub(PLACES, waits(), true).getLiveData())
      .filter((r: any) => r.id === SIGNAGE_ID);

    // The build drops the row, so the gate sees an absence. It needs three in
    // a row, 45 minutes apart, on top of the four-hour window.
    vi.setSystemTime(T0 + 45 * 60_000);
    expect(await rowsFor()).toEqual([]);
    vi.setSystemTime(T0 + 90 * 60_000);
    expect(await rowsFor()).toEqual([]);
    vi.setSystemTime(T0 + 135 * 60_000);
    expect(await rowsFor()).toEqual([{id: SIGNAGE_ID, status: 'CLOSED'}]);
  });

  test('every row it does emit while waiting is for a published entity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    await seed();
    vi.setSystemTime(T0 + 45 * 60_000);
    const rows = await stub(PLACES, waits(), true).getLiveData();
    expect(rows.map((r: any) => r.id).sort()).toEqual([
      'ush.lower_lot.rides.bowser.jr.challenge',
      RIDE_ID,
    ].sort());
  });
});
