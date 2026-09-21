import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {UniversalStudios, parseExpressNowResponse} from '../universal.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream piece it was built
 * from: the queue objects of the wait-time feed for an attraction — a maze
 * carries its express twin's queue alongside its own — the virtual-queue state
 * and its appointment details, the show-list entry for a show, the Express Now
 * prediction for a paid return time, the place for an entity, the venue-hours
 * day for a schedule entry and the parsed event night for a ticketed one. The
 * destination is built from configuration and carries nothing. Off, nothing
 * carries anything.
 */
const NOW = new Date('2026-09-21T20:00:00Z'); // 13:00 in Los Angeles

const parkPlace = {
  place_id: 'ush.ush',
  name: 'Universal Studios Hollywood',
  venue_id: 'ush.ush',
  place_type: {type: 'Park', attributes: []},
  geometry: {locations: [{location_type: 'map', lat_lng: {lat: 34.1381, lng: -118.3534}}]},
};
const ridePlace = {
  place_id: 'ush.upper_lot.rides.the_simpsons_ride',
  name: 'The Simpsons Ride',
  venue_id: 'ush.upper_lot',
  place_type: {type: 'Ride', attributes: [{name: 'minimum_rider_height_inches', value: '40'}]},
  geometry: {locations: [{location_type: 'map', lat_lng: {lat: 34.139, lng: -118.353}}]},
};
const mazePlace = {
  place_id: 'ush.upper_lot.rides.hhn_2026_hellraiser',
  name: 'Hellraiser',
  venue_id: 'ush.upper_lot',
  place_type: {type: 'Ride', attributes: []},
};
// The express line of the maze is its own place; it is never published as an
// attraction of its own, so it never carries a piece either.
const expressPlace = {
  place_id: 'ush.upper_lot.rides.hellraiser_express',
  name: 'Hellraiser - Express',
  venue_id: 'ush.upper_lot',
  place_type: {type: 'Ride', attributes: [{name: 'is_event', value: 'true'}]},
};
const showPlace = {
  place_id: 'ush.upper_lot.shows.waterworld',
  name: 'WaterWorld',
  venue_id: 'ush.upper_lot',
  place_type: {type: 'Show', attributes: []},
};
const places = [parkPlace, ridePlace, mazePlace, expressPlace, showPlace];

const rideStandbyQueue = {queue_type: 'STANDBY', status: 'OPEN', display_wait_time: 30, alternate_ids: []};
const mazeStandbyQueue = {queue_type: 'STANDBY', status: 'OPEN', display_wait_time: 110, alternate_ids: []};
const expressStandbyQueue = {queue_type: 'STANDBY', status: 'OPEN', display_wait_time: 45, alternate_ids: []};
const waitTimes = [
  {
    name: 'The Simpsons Ride',
    wait_time_attraction_id: 'ush.upper_lot.rides.the_simpsons_ride',
    queues: [rideStandbyQueue],
  },
  // Before the maze's own row, so the fold creates the maze's element.
  {
    name: 'Hellraiser - Express',
    wait_time_attraction_id: 'ush.upper_lot.rides.hellraiser_express',
    queues: [expressStandbyQueue],
  },
  {
    name: 'Hellraiser',
    wait_time_attraction_id: 'ush.upper_lot.rides.hhn_2026_hellraiser',
    queues: [mazeStandbyQueue],
  },
];

const vQueueState = {
  Id: 'queue-1',
  IsEnabled: true,
  QueueEntityId: '12345',
  PlaceId: 'ush.upper_lot.rides.the_simpsons_ride',
};
const vQueueDetails = {
  AppointmentTimes: [{StartTime: '2026-09-21T22:00:00.000Z', EndTime: '2026-09-21T23:00:00.000Z'}],
};

const waterworldShow = {
  show_id: 'ush.upper_lot.shows.waterworld',
  resort_area_code: 'ush',
  venue_id: 'ush.upper_lot',
  category: 'general',
  status: 'OPEN',
  show_externally: true,
  show_times: [{show_time_id: 's1', status: 'ENABLED', start_time: '2026-09-21T22:00:00.000Z'}],
};

// Numeric fields arrive as strings on the wire; the parser coerces them and
// carries the prediction through.
const prediction = {
  offer_id: 'offer-1',
  place_id: 'ush.upper_lot.rides.the_simpsons_ride',
  inventory_time_slot: '2026-09-21T15:30:00',
  inventory_time_minutes: '30',
  product_price: '24.99',
  vl_inventory: '12',
};

const scheduleDay = {
  Date: '2026-09-21',
  VenueStatus: 'Open',
  OpenTimeString: '2026-09-21T13:00:00-04:00',   // 10:00 PT
  CloseTimeString: '2026-09-21T21:00:00-04:00',  // 18:00 PT
  EarlyEntryString: '2026-09-21T12:00:00-04:00', // 09:00 PT
};
const eventNight = {
  date: '2026-09-21',
  name: 'Halloween Horror Nights',
  openingTime: '19:00',
  closingTime: '02:00',
  closesNextDay: true,
  earlyAccessTime: '17:30',
};

function stubbedPark(includeRaw: boolean): UniversalStudios {
  const park = new UniversalStudios();
  park.includeRaw = includeRaw;
  vi.spyOn(park as any, '_init').mockResolvedValue(undefined);
  vi.spyOn(park, 'getPlaces').mockResolvedValue(places as any);
  vi.spyOn(park, 'getWaitTimes').mockResolvedValue(waitTimes as any);
  vi.spyOn(park, 'getVirtualQueueStates').mockResolvedValue([vQueueState] as any);
  vi.spyOn(park, 'getVirtualQueueDetails').mockResolvedValue(vQueueDetails as any);
  vi.spyOn(park, 'getShowList').mockResolvedValue([waterworldShow] as any);
  vi.spyOn(park, 'getVenueSchedule').mockResolvedValue([scheduleDay] as any);
  vi.spyOn(park, 'getEventNights').mockResolvedValue([eventNight]);
  // The real parser runs, so the test also covers the prediction being carried
  // through the reduced offer shape.
  vi.spyOn(park, 'getExpressNowOffers').mockImplementation(
    async () => parseExpressNowResponse({predictions: [prediction]}, park.includeRaw),
  );
  // Retirement force-closes ids that vanish from the feed. It runs after
  // buildLiveData and is a separate concern, so keep it out of these rows.
  (park as any).retireMissingLiveEntities = false;
  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Universal raw upstream pieces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('attaches every feed that fed an attraction row', async () => {
    const live = await stubbedPark(true).getLiveData();
    expect(live.map((l) => l.id)).toEqual([
      'ush.upper_lot.rides.the_simpsons_ride',
      'ush.upper_lot.rides.hhn_2026_hellraiser',
      'ush.upper_lot.shows.waterworld',
    ]);

    // One queue fed this row, so the piece is that queue, not a list of one.
    expect(rawOf(live[0])).toEqual({
      virtualQueueStates: vQueueState,
      virtualQueueDetails: vQueueDetails,
      waitTimes: rideStandbyQueue,
      expressNowOffers: prediction,
    });
    expect(rawOf(live[0])!.virtualQueueStates).toBe(vQueueState);
    expect(rawOf(live[0])!.virtualQueueDetails).toBe(vQueueDetails);
    expect(rawOf(live[0])!.waitTimes).toBe(rideStandbyQueue);
    expect(rawOf(live[0])!.expressNowOffers).toBe(prediction);
    expect(live[0].queue!.STANDBY).toEqual({waitTime: 30});
    expect(live[0].queue!.PAID_RETURN_TIME!.price).toMatchObject({amount: 2499, currency: 'USD'});

    // Two rows of the one wait-time feed built this element: the maze's own
    // queue and the queue of its express line, which is a place of its own.
    expect(rawOf(live[1])).toEqual({waitTimes: [expressStandbyQueue, mazeStandbyQueue]});
    expect((rawOf(live[1])!.waitTimes as unknown[])[0]).toBe(expressStandbyQueue);
    expect((rawOf(live[1])!.waitTimes as unknown[])[1]).toBe(mazeStandbyQueue);
    expect(live[1].queue).toEqual({PAID_STANDBY: {waitTime: 45}, STANDBY: {waitTime: 110}});

    expect(rawOf(live[2])).toEqual({showList: waterworldShow});
    expect(rawOf(live[2])!.showList).toBe(waterworldShow);
    expect(live[2].showtimes).toEqual([
      {type: 'Performance Time', startTime: '2026-09-21T15:00:00-07:00', endTime: '2026-09-21T15:00:00-07:00'},
    ]);
  });

  test('attaches the place to every park and child, nothing to the destination', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'universalresort_hollywood',
      'ush.ush',
      'ush.upper_lot.rides.the_simpsons_ride',
      'ush.upper_lot.rides.hhn_2026_hellraiser',
      'ush.upper_lot.shows.waterworld',
    ]);

    // The destination's name and location come from this module's config.
    expect(rawOf(entities[0])).toBeUndefined();

    expect(rawOf(entities[1])).toEqual({places: parkPlace});
    expect(rawOf(entities[1])!.places).toBe(parkPlace);

    expect(rawOf(entities[2])).toEqual({places: ridePlace});
    expect(rawOf(entities[2])!.places).toBe(ridePlace);
    expect(entities[2].parentId).toBe('ush.ush');
    expect(entities[2].tags).toHaveLength(1);

    expect(rawOf(entities[3])!.places).toBe(mazePlace);
    expect(rawOf(entities[4])).toEqual({places: showPlace});
    expect(rawOf(entities[4])!.places).toBe(showPlace);
    expect(entities[4].name).toBe('WaterWorld');
  });

  test('attaches the venue day to both of its entries and the night to both of its own', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    expect(schedules.map((s) => s.id)).toEqual(['ush.ush']);

    const [operating, early, event, eventEarly] = schedules[0].schedule;
    expect(operating.type).toBe('OPERATING');
    expect(rawOf(operating)).toEqual({venueSchedule: scheduleDay});
    expect(rawOf(operating)!.venueSchedule).toBe(scheduleDay);
    expect(operating.openingTime).toBe('2026-09-21T10:00:00-07:00');

    // The one day row produced the early-entry entry as well.
    expect(early.type).toBe('EXTRA_HOURS');
    expect(rawOf(early)!.venueSchedule).toBe(scheduleDay);
    expect(early.openingTime).toBe('2026-09-21T09:00:00-07:00');

    expect(event.type).toBe('TICKETED_EVENT');
    expect(rawOf(event)).toEqual({eventCalendar: eventNight});
    expect(rawOf(event)!.eventCalendar).toBe(eventNight);
    expect(event.closingTime).toBe('2026-09-22T02:00:00-07:00');

    // Early access is a second entry of the same night.
    expect(eventEarly.type).toBe('INFO');
    expect(rawOf(eventEarly)!.eventCalendar).toBe(eventNight);
    expect(eventEarly.openingTime).toBe('2026-09-21T17:30:00-07:00');
  });

  test('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const schedule of await park.getSchedules()) {
      for (const element of schedule.schedule) expect(rawOf(element)).toBeUndefined();
    }
  });
});
