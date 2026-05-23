/**
 * Unit tests for the pure helpers backing the /places migration.
 */
import {describe, test, expect} from 'vitest';
import {placeToEntity, type UniversalPlace} from '../universal.js';

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
