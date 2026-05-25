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

  test('Ride with minimum_rider_height_inches attribute → emits minimumHeight tag', () => {
    const withHeight: UniversalPlace = {
      ...ridePlace,
      place_type: {
        type: 'Ride',
        attributes: [{name: 'minimum_rider_height_inches', value: '40'}],
      },
    };
    const e = placeToEntity(withHeight, DESTINATION, TZ);
    expect(e?.tags).toEqual([
      expect.objectContaining({tag: 'MINIMUM_HEIGHT', value: expect.objectContaining({height: 40, unit: 'in'})}),
    ]);
  });

  test('Ride with has_child_swap="true" attribute → emits childSwap tag', () => {
    const withSwap: UniversalPlace = {
      ...ridePlace,
      place_type: {
        type: 'Ride',
        attributes: [{name: 'has_child_swap', value: 'true'}],
      },
    };
    const e = placeToEntity(withSwap, DESTINATION, TZ);
    expect(e?.tags).toEqual([expect.objectContaining({tag: 'CHILD_SWAP'})]);
  });

  test('Ride with both attributes → emits both tags; unrelated attributes ignored', () => {
    const both: UniversalPlace = {
      ...ridePlace,
      place_type: {
        type: 'Ride',
        attributes: [
          {name: 'has_child_swap', value: 'true'},
          {name: 'minimum_rider_height_inches', value: '48'},
          {name: 'express_pass', value: 'true'},        // not in legacy surface — must NOT emit a tag
          {name: 'mfdo_enabled', value: 'true'},        // ditto
        ],
      },
    };
    const tags = placeToEntity(both, DESTINATION, TZ)?.tags ?? [];
    expect(tags).toHaveLength(2);
    expect(tags).toEqual(expect.arrayContaining([
      expect.objectContaining({tag: 'CHILD_SWAP'}),
      expect.objectContaining({tag: 'MINIMUM_HEIGHT', value: expect.objectContaining({height: 48, unit: 'in'})}),
    ]));
    // Defensive: ensure neither express_pass nor mfdo_enabled snuck in.
    const tagNames = tags.map((t: any) => t.tag);
    expect(tagNames).not.toContain('EXPRESS_PASS');
    expect(tagNames).not.toContain('MFDO_ENABLED');
  });

  test('has_child_swap="false" or missing → no childSwap tag', () => {
    const falsy: UniversalPlace = {
      ...ridePlace,
      place_type: {type: 'Ride', attributes: [{name: 'has_child_swap', value: 'false'}]},
    };
    const e = placeToEntity(falsy, DESTINATION, TZ);
    expect((e?.tags ?? []).some(t => (t as any).tag === 'CHILD_SWAP')).toBe(false);
  });

  test('minimum_rider_height_inches="0" or non-finite → no minimumHeight tag', () => {
    const zero: UniversalPlace = {
      ...ridePlace,
      place_type: {type: 'Ride', attributes: [{name: 'minimum_rider_height_inches', value: '0'}]},
    };
    const garbage: UniversalPlace = {
      ...ridePlace,
      place_type: {type: 'Ride', attributes: [{name: 'minimum_rider_height_inches', value: 'tall'}]},
    };
    expect(placeToEntity(zero, DESTINATION, TZ)?.tags ?? []).toEqual([]);
    expect(placeToEntity(garbage, DESTINATION, TZ)?.tags ?? []).toEqual([]);
  });

  test('Non-Ride entities (Show / Dining) do NOT receive height/child-swap tags', () => {
    const showWithAttrs: UniversalPlace = {
      ...showPlace,
      place_type: {
        type: 'Show',
        attributes: [
          {name: 'minimum_rider_height_inches', value: '36'},
          {name: 'has_child_swap', value: 'true'},
        ],
      },
    };
    const diningWithAttrs: UniversalPlace = {
      ...diningPlace,
      place_type: {
        type: 'Dining',
        attributes: [
          {name: 'minimum_rider_height_inches', value: '36'},
          {name: 'has_child_swap', value: 'true'},
        ],
      },
    };
    expect(placeToEntity(showWithAttrs, DESTINATION, TZ)?.tags ?? []).toEqual([]);
    expect(placeToEntity(diningWithAttrs, DESTINATION, TZ)?.tags ?? []).toEqual([]);
  });
});

describe('parseShowTimes', () => {
  const UOR_TZ = 'America/New_York';
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

  test('emits one Performance Time per ENABLED show_time, future-only, in park-local timezone with offset', () => {
    const now = new Date('2026-05-22T17:00:00Z');
    const show: UniversalShowListEntry = {
      ...baseShow,
      show_times: [
        {show_time_id: 'a', status: 'ENABLED', start_time: '2026-05-22T16:00:00.000Z'}, // past
        {show_time_id: 'b', status: 'ENABLED', start_time: '2026-05-22T18:00:00.000Z'},
        {show_time_id: 'c', status: 'ENABLED', start_time: '2026-05-22T19:00:00.000Z'},
      ],
    };
    // 18:00 UTC + EDT (-04:00 in May) = 14:00 local. 19:00 UTC = 15:00 local.
    expect(parseShowTimes(show, UOR_TZ, now)).toEqual([
      {type: 'Performance Time', startTime: '2026-05-22T14:00:00-04:00', endTime: '2026-05-22T14:00:00-04:00'},
      {type: 'Performance Time', startTime: '2026-05-22T15:00:00-04:00', endTime: '2026-05-22T15:00:00-04:00'},
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
    // 15:00 UTC + EDT (-04:00) = 11:00 local
    expect(parseShowTimes(show, UOR_TZ, now).map((t) => t.startTime)).toEqual([
      '2026-05-22T11:00:00-04:00',
    ]);
  });

  test('Hollywood timezone (Pacific) projection', () => {
    const now = new Date('2026-05-22T10:00:00Z');
    const show: UniversalShowListEntry = {
      ...baseShow,
      show_times: [
        {show_time_id: 'a', status: 'ENABLED', start_time: '2026-05-22T23:30:00.000Z'},
      ],
    };
    // 23:30 UTC + PDT (-07:00 in May) = 16:30 Pacific local
    expect(parseShowTimes(show, 'America/Los_Angeles', now).map((t) => t.startTime)).toEqual([
      '2026-05-22T16:30:00-07:00',
    ]);
  });

  test('empty / missing show_times → []', () => {
    expect(parseShowTimes({...baseShow, show_times: []}, UOR_TZ, new Date())).toEqual([]);
    expect(parseShowTimes({...baseShow, show_times: undefined}, UOR_TZ, new Date())).toEqual([]);
  });
});
