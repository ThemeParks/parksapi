/**
 * Unit tests for the pure helpers backing the /places migration.
 */
import {describe, test, expect} from 'vitest';
import {placeToEntity, parseShowTimes, type UniversalPlace, type UniversalShowListEntry} from '../universal.js';

const DESTINATION = 'universalresort_orlando';
const TZ = 'America/New_York';

const ridePlace: UniversalPlace = {
  place_id: 'uor.usf.rides.despicable_me_minion_mayhem',
  name: 'Despicable Me Minion Mayhem™',
  resort_area_code: 'uor',
  venue_id: 'uor.usf',
  geometry: {locations: [{location_type: 'map', lat_lng: {lat: 28.479, lng: -81.470}}]},
  place_type: {type: 'Ride'},
};

const diningPlace: UniversalPlace = {
  place_id: 'uo.lpbh.dining.sals_market_deli',
  name: "Sal's Market Deli™",
  resort_area_code: 'uor',
  venue_id: 'uor.loews_portofino_bay_hotel',
  geometry: {locations: [{location_type: 'map', lat_lng: {lat: 28.4807, lng: -81.4605}}]},
  place_type: {type: 'Dining', categories: ['quick-service', 'snacks-beverages']},
};

const showPlace: UniversalPlace = {
  place_id: 'uor.ioa.shows.frog_choir',
  name: 'Frog Choir',
  resort_area_code: 'uor',
  venue_id: 'uor.ioa',
  place_type: {type: 'Show'},
};

const parkPlace: UniversalPlace = {
  place_id: 'uor.eu',
  name: 'Universal Epic Universe',
  resort_area_code: 'uor',
  place_type: {type: 'Park'},
};

const shopPlace: UniversalPlace = {
  place_id: 'uor.usf.shops.universal_studios_store',
  name: 'Universal Studios Store',
  resort_area_code: 'uor',
  venue_id: 'uor.usf',
  place_type: {type: 'Shop'},
};

describe('placeToEntity', () => {
  test('Ride → ATTRACTION with venue_id as parent and map location', () => {
    expect(placeToEntity(ridePlace, DESTINATION, TZ)).toEqual({
      id: 'uor.usf.rides.despicable_me_minion_mayhem',
      name: 'Despicable Me Minion Mayhem™',
      entityType: 'ATTRACTION',
      parentId: 'uor.usf',
      destinationId: DESTINATION,
      timezone: TZ,
      location: {latitude: 28.479, longitude: -81.470},
    });
  });

  test('Dining → RESTAURANT (no category filter applied — every Dining emits)', () => {
    const e = placeToEntity(diningPlace, DESTINATION, TZ);
    expect(e?.entityType).toBe('RESTAURANT');
    expect(e?.parentId).toBe('uor.loews_portofino_bay_hotel');
    expect(e?.id).toBe('uo.lpbh.dining.sals_market_deli');
  });

  test('Show → SHOW with venue_id parent', () => {
    const e = placeToEntity(showPlace, DESTINATION, TZ);
    expect(e?.entityType).toBe('SHOW');
    expect(e?.parentId).toBe('uor.ioa');
  });

  test('Shop → null (not in PLACE_TYPE_TO_ENTITY)', () => {
    expect(placeToEntity(shopPlace, DESTINATION, TZ)).toBeNull();
  });

  test('Park → null (parks are emitted separately by buildEntityList)', () => {
    expect(placeToEntity(parkPlace, DESTINATION, TZ)).toBeNull();
  });

  test('Place with no map location → entity emitted without location field', () => {
    const noLoc: UniversalPlace = {...ridePlace, geometry: {locations: []}};
    const e = placeToEntity(noLoc, DESTINATION, TZ);
    expect(e).not.toBeNull();
    expect(e?.location).toBeUndefined();
  });

  test('Place with no venue_id → entity emitted without parentId (orphan; build step warns)', () => {
    const noVenue: UniversalPlace = {...ridePlace, venue_id: undefined};
    const e = placeToEntity(noVenue, DESTINATION, TZ);
    expect(e).not.toBeNull();
    expect((e as any)?.parentId).toBeUndefined();
  });

  test('place_id with disallowed characters is sanitized', () => {
    const weird: UniversalPlace = {...ridePlace, place_id: 'uor.usf.rides:weird*name'};
    expect(placeToEntity(weird, DESTINATION, TZ)?.id).toBe('uor.usf.rides_weird_name');
  });
});

describe('parseShowTimes', () => {
  const baseShow: UniversalShowListEntry = {
    show_id: 'uor.ioa.shows.frog_choir',
    resort_area_code: 'UOR',
    venue_id: 'uor.ioa',
    name: 'Frog Choir',
    show_type: 'SHOW',
    status: 'OPEN',
    show_externally: true,
    show_times: [],
  };

  test('emits one Performance Time per ENABLED show_time, future-only', () => {
    const now = new Date('2026-05-22T17:00:00Z');
    const show: UniversalShowListEntry = {
      ...baseShow,
      show_times: [
        {show_time_id: 'a', status: 'ENABLED', start_time: '2026-05-22T16:00:00.000Z'}, // past
        {show_time_id: 'b', status: 'ENABLED', start_time: '2026-05-22T18:00:00.000Z'},
        {show_time_id: 'c', status: 'ENABLED', start_time: '2026-05-22T19:00:00.000Z'},
      ],
    };
    expect(parseShowTimes(show, now)).toEqual([
      {type: 'Performance Time', startTime: '2026-05-22T18:00:00.000Z', endTime: '2026-05-22T18:00:00.000Z'},
      {type: 'Performance Time', startTime: '2026-05-22T19:00:00.000Z', endTime: '2026-05-22T19:00:00.000Z'},
    ]);
  });

  test('drops non-ENABLED times', () => {
    const now = new Date('2026-05-22T10:00:00Z');
    const show: UniversalShowListEntry = {
      ...baseShow,
      show_times: [
        {show_time_id: 'a', status: 'DISABLED', start_time: '2026-05-22T14:00:00.000Z'},
        {show_time_id: 'b', status: 'ENABLED',  start_time: '2026-05-22T15:00:00.000Z'},
      ],
    };
    expect(parseShowTimes(show, now).map((t) => t.startTime)).toEqual([
      '2026-05-22T15:00:00.000Z',
    ]);
  });

  test('empty / missing show_times → []', () => {
    expect(parseShowTimes({...baseShow, show_times: []}, new Date())).toEqual([]);
    expect(parseShowTimes({...baseShow, show_times: undefined}, new Date())).toEqual([]);
  });
});
