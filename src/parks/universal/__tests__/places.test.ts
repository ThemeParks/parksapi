/**
 * Unit tests for the pure helpers backing the /places migration.
 */
import {describe, test, expect} from 'vitest';
import {placeToEntity, isEventVariantAlias, parseShowTimes, mapUniversalShowStatus, type UniversalPlace, type UniversalShowListEntry} from '../universal.js';

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

  // USH Upper/Lower Lot are sub-areas of the single `ush.ush` park (not surfaced
  // as parks themselves), so their children must reparent onto `ush.ush` or they
  // strand in the sync's unresolved-parent queue forever.
  test('USH Upper Lot child → reparented to ush.ush', () => {
    const upperLotDining: UniversalPlace = {
      place_id: 'ush.dining.krusty_burger',
      name: 'Krusty Burger',
      resort_area_code: 'ush',
      venue_id: 'ush.upper_lot',
      place_type: {type: 'Dining'},
    };
    expect(placeToEntity(upperLotDining, DESTINATION, TZ)?.parentId).toBe('ush.ush');
  });

  test('USH Lower Lot child → reparented to ush.ush', () => {
    const lowerLotRide: UniversalPlace = {
      place_id: 'ush.lower_lot.rides.jurassic_world_the_ride',
      name: 'Jurassic World — The Ride',
      resort_area_code: 'ush',
      venue_id: 'ush.lower_lot',
      place_type: {type: 'Ride'},
    };
    expect(placeToEntity(lowerLotRide, DESTINATION, TZ)?.parentId).toBe('ush.ush');
  });

  test('CityWalk child → null (district not surfaced as a park; excluded)', () => {
    const ushCityWalk: UniversalPlace = {
      place_id: 'ush.cw.dining.voodoo_doughnut',
      name: 'Voodoo Doughnut',
      resort_area_code: 'ush',
      venue_id: 'ush.cw',
      place_type: {type: 'Dining'},
    };
    const uorCityWalk: UniversalPlace = {
      place_id: 'uor.cw.dining.voodoo_doughnut',
      name: 'Voodoo Doughnut',
      resort_area_code: 'uor',
      venue_id: 'uor.cw',
      place_type: {type: 'Dining'},
    };
    expect(placeToEntity(ushCityWalk, DESTINATION, TZ)).toBeNull();
    expect(placeToEntity(uorCityWalk, DESTINATION, TZ)).toBeNull();
  });

  test('Surfaced-park venue is left unchanged (no accidental remap)', () => {
    // ridePlace.venue_id === 'uor.usf' (a real park) must pass through as-is.
    expect(placeToEntity(ridePlace, DESTINATION, TZ)?.parentId).toBe('uor.usf');
  });

  // isEventVariantAlias: an event-flagged place is a variant ONLY when its share
  // link targets a DIFFERENT place that EXISTS in the feed. Self-links and links
  // to a non-existent id (sloppy feed data) are kept.
  const evented = (placeId: string, shareTargetId: string, isEvent = 'true'): UniversalPlace => ({
    place_id: placeId,
    name: placeId,
    resort_area_code: 'ush',
    place_type: {
      type: 'Show',
      attributes: [
        {name: 'is_event', value: isEvent},
        {name: 'social_sharing_link', value: `https://x/applinks/poi?id=${shareTargetId}`},
      ],
    },
  });
  const feed = (...ids: string[]) => new Set(ids);

  test('variant → true: share target is a different EXISTING place (Studio Tour - Mandarin → WaterWorld)', () => {
    const p = evented('ush.upper_lot.shows.studio_tour_mandarin', 'ush.upper_lot.shows.waterworld');
    expect(isEventVariantAlias(p, feed(p.place_id, 'ush.upper_lot.shows.waterworld'))).toBe(true);
  });

  test('variant → true: Studio Tour Last Tram and Hogwarts Express First Train (share → canonical that exists)', () => {
    const tram = evented('ush.upper_lot.rides.studio_tour_last_tram', 'ush.upper_lot.rides.studio_tour');
    expect(isEventVariantAlias(tram, feed(tram.place_id, 'ush.upper_lot.rides.studio_tour'))).toBe(true);
    const train = evented('uor.usf.rides.hogwarts_express_first_train', 'uor.usf.rides.hogwarts_express');
    expect(isEventVariantAlias(train, feed(train.place_id, 'uor.usf.rides.hogwarts_express'))).toBe(true);
  });

  test('kept: event place whose share link points at ITSELF (Bowser Jr. Challenge)', () => {
    const p = evented('ush.lower_lot.rides.bowser.jr.challenge', 'ush.lower_lot.rides.bowser.jr.challenge');
    expect(isEventVariantAlias(p, feed(p.place_id))).toBe(false);
  });

  test('kept: event place whose share target does NOT exist in the feed (UOR Meet Donkey Kong false-positive)', () => {
    // Only uor.ueu.show.meet_donkey_kong exists; its share link points at a
    // phantom uor.ueu.entertainment.meet_donkey_kong. Must NOT be dropped.
    const p = evented('uor.ueu.show.meet_donkey_kong', 'uor.ueu.entertainment.meet_donkey_kong');
    expect(isEventVariantAlias(p, feed(p.place_id))).toBe(false);
  });

  test('kept: non-event place is never a variant', () => {
    const p = evented('ush.upper_lot.rides.studio_tour', 'ush.upper_lot.rides.other', 'false');
    expect(isEventVariantAlias(p, feed(p.place_id, 'ush.upper_lot.rides.other'))).toBe(false);
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

describe('mapUniversalShowStatus', () => {
  test('OPEN / RIDE_NOW → OPERATING', () => {
    expect(mapUniversalShowStatus('OPEN')).toBe('OPERATING');
    expect(mapUniversalShowStatus('RIDE_NOW')).toBe('OPERATING');
  });

  // Regression: a show that is merely delayed still runs a full day of
  // performances. The old `=== 'OPEN' ? OPERATING : CLOSED` mapping reported it
  // CLOSED while emitting showtimes — contradictory. BRIEF_DELAY means DOWN.
  test('BRIEF_DELAY / WEATHER_DELAY / AT_CAPACITY → DOWN (delayed, not closed)', () => {
    expect(mapUniversalShowStatus('BRIEF_DELAY')).toBe('DOWN');
    expect(mapUniversalShowStatus('WEATHER_DELAY')).toBe('DOWN');
    expect(mapUniversalShowStatus('AT_CAPACITY')).toBe('DOWN');
  });

  test('genuinely-closed states → CLOSED (no showtimes)', () => {
    expect(mapUniversalShowStatus('CLOSED')).toBe('CLOSED');
    expect(mapUniversalShowStatus('EXTENDED_CLOSURE')).toBe('CLOSED');
    expect(mapUniversalShowStatus('COMING_SOON')).toBe('CLOSED');
  });

  test('unknown / empty / undefined → CLOSED (safe default)', () => {
    expect(mapUniversalShowStatus('SOMETHING_NEW')).toBe('CLOSED');
    expect(mapUniversalShowStatus('')).toBe('CLOSED');
    expect(mapUniversalShowStatus(undefined)).toBe('CLOSED');
  });

  // Structural: a show still advertising future performances is running today,
  // so CLOSED-with-showtimes is unreachable (the reported class of bug). This
  // covers character meet-and-greets that report CLOSED between appearances.
  test('CLOSED / CANCELED / unknown WITH future showtimes → OPERATING', () => {
    expect(mapUniversalShowStatus('CLOSED', true)).toBe('OPERATING');
    expect(mapUniversalShowStatus('CANCELED', true)).toBe('OPERATING');
    expect(mapUniversalShowStatus('SOMETHING_NEW', true)).toBe('OPERATING');
    expect(mapUniversalShowStatus(undefined, true)).toBe('OPERATING');
  });

  test('explicit long-closures stay CLOSED even with showtimes', () => {
    expect(mapUniversalShowStatus('EXTENDED_CLOSURE', true)).toBe('CLOSED');
    expect(mapUniversalShowStatus('COMING_SOON', true)).toBe('CLOSED');
  });

  test('delay states stay DOWN regardless of showtimes', () => {
    expect(mapUniversalShowStatus('BRIEF_DELAY', true)).toBe('DOWN');
    expect(mapUniversalShowStatus('WEATHER_DELAY', true)).toBe('DOWN');
  });

  test('OPEN stays OPERATING regardless of the flag', () => {
    expect(mapUniversalShowStatus('OPEN', false)).toBe('OPERATING');
    expect(mapUniversalShowStatus('OPEN', true)).toBe('OPERATING');
  });

  // Integration of the two halves the buildLiveData show loop combines: the
  // reported bug was a delayed show emitting status + showtimes that
  // contradicted each other. Assert they now coexist coherently on one entry.
  test('delayed show yields DOWN together with its showtimes (contradiction resolved)', () => {
    const now = new Date('2026-08-05T14:00:00Z');
    const show: UniversalShowListEntry = {
      show_id: 'uor.usf.shows.the_bourne_stuntacular',
      resort_area_code: 'UOR',
      name: 'The Bourne Stuntacular',
      status: 'BRIEF_DELAY',
      show_externally: true,
      show_times: [
        {show_time_id: 'a', status: 'ENABLED', start_time: '2026-08-05T15:15:00.000Z'},
        {show_time_id: 'b', status: 'ENABLED', start_time: '2026-08-05T16:00:00.000Z'},
      ],
    };
    const showtimes = parseShowTimes(show, 'America/New_York', now);
    const status = mapUniversalShowStatus(show.status, showtimes.length > 0);
    expect(status).toBe('DOWN'); // was 'CLOSED' before the fix — the contradiction
    expect(showtimes).toHaveLength(2);
  });

  // A character meet-and-greet reports status CLOSED between appearances while
  // still listing today's slots. buildLiveData now promotes it to OPERATING so
  // the feed never shows CLOSED next to a live schedule.
  test('CLOSED meet-and-greet with future showtimes → OPERATING with showtimes', () => {
    const now = new Date('2026-08-05T14:00:00Z');
    const show: UniversalShowListEntry = {
      show_id: 'ush.meet.some_character',
      resort_area_code: 'USH',
      name: 'Character Meet',
      status: 'CLOSED',
      show_externally: true,
      show_times: [
        {show_time_id: 'a', status: 'ENABLED', start_time: '2026-08-05T18:30:00.000Z'},
      ],
    };
    const showtimes = parseShowTimes(show, 'America/Los_Angeles', now);
    const status = mapUniversalShowStatus(show.status, showtimes.length > 0);
    expect(status).toBe('OPERATING'); // was 'CLOSED' — the reported contradiction
    expect(showtimes).toHaveLength(1);
  });

  // Regression for programme#86 / parksapi USH incident: the feed lists the
  // whole day's ENABLED slots from midnight, so hasFutureShowtimes stays true
  // all night once the feed rolls to the next operating day. Without a clock
  // gate a show sampled overnight reads OPERATING straight through the
  // closure and the row never gets rewritten (frozen "current" value).
  test('park closed (parkOperating=false) overrides future showtimes → CLOSED', () => {
    expect(mapUniversalShowStatus('CLOSED', true, false)).toBe('CLOSED');
    expect(mapUniversalShowStatus(undefined, true, false)).toBe('CLOSED');
  });

  test('park open (parkOperating=true) with future showtimes → OPERATING, same as the default', () => {
    expect(mapUniversalShowStatus('CLOSED', true, true)).toBe('OPERATING');
  });

  test('parkOperating defaults to true (ungated) when the caller omits it', () => {
    expect(mapUniversalShowStatus('CLOSED', true)).toBe('OPERATING');
  });

  // Live evidence (programme#86, sampled 03:24 PDT with USH's own schedule
  // confirming the park shut): 25 of 31 externally-shown entries carried
  // `status: "OPEN"` outright, not just a stray future showtime. The status
  // field is not reliably live either, so an explicit OPEN/RIDE_NOW is
  // gated the same as the showtimes fallback — the same stale-reading
  // category already fixed for ride wait times (parksapi #316).
  test('explicit OPEN/RIDE_NOW IS clock-gated: closed park overrides a live-looking status', () => {
    expect(mapUniversalShowStatus('OPEN', false, false)).toBe('CLOSED');
    expect(mapUniversalShowStatus('RIDE_NOW', false, false)).toBe('CLOSED');
  });

  test('delay/long-closure signals are NOT clock-gated — neither claims OPERATING', () => {
    expect(mapUniversalShowStatus('BRIEF_DELAY', true, false)).toBe('DOWN');
    expect(mapUniversalShowStatus('EXTENDED_CLOSURE', true, false)).toBe('CLOSED');
  });
});
