import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {EuropaPark} from '../europapark.js';
import type {WithRaw} from '../../../destination.js';

/**
 * With `includeRaw` on, every element carries the upstream pieces it was built
 * from: the POI entry for an entity, the waiting-times row for a live row (plus
 * the virtual-queue dummy row when one hands it a return time), the show-times
 * entry for a show, and the ETAs of the trains serving an EP-Express station.
 * A season is one object standing behind every day it covers, and today's day
 * adds the live calendar when it overrode the season's hours. A station no
 * train reported for, and the destination built from constants, carry nothing.
 * Off, nothing carries anything.
 */
const NOW = new Date('2026-09-21T10:00:00Z');

const parkPoi = {
  id: 493, name: 'Europa-Park', type: 'park', scopes: ['europapark'],
  latitude: 48.266, longitude: 7.7225,
};
const ridePoi = {
  id: 36, name: 'Voletarium', type: 'attraction', scopes: ['europapark'],
  code: 36, latitude: 48.267, longitude: 7.723, minHeight: 100,
};
const closedRidePoi = {
  id: 37, name: 'Silver Star', type: 'attraction', scopes: ['europapark'],
  code: 37, latitude: 48.264, longitude: 7.721,
};
const stationPoi = {
  id: 60, name: 'EP-Express Alexanderplatz', type: 'attraction',
  scopes: ['europapark'], latitude: 48.269, longitude: 7.720,
};
const vQueuePoi = {
  id: 900, name: 'Virtual Line Voletarium', type: 'attraction',
  scopes: ['europapark'], code: 900, queueing: true,
};
const nestedShow = {id: 12, name: 'Der Schluessel zur Freiheit', duration: 30};
const showLocationPoi = {
  id: 747, name: 'Europa-Park Arena', type: 'showlocation',
  scopes: ['europapark'], latitude: 48.265, longitude: 7.740, shows: [nestedShow],
};
const gastronomyPoi = {
  id: 500, name: 'Food Loop', type: 'gastronomy', scopes: ['europapark'],
  code: 91, latitude: 48.268, longitude: 7.724,
};

const pois = [
  parkPoi, ridePoi, closedRidePoi, stationPoi, vQueuePoi, showLocationPoi, gastronomyPoi,
];

const rideWait = {code: 36, time: 45, startAt: null, endAt: null};
const vQueueWait = {
  code: 900, time: 666,
  startAt: '2026-09-21T14:00:00+02:00', endAt: '2026-09-21T15:00:00+02:00',
};
const gastronomyWait = {code: 91, time: 0, startAt: null, endAt: null};

const showEntry = {showId: 12, today: ['2026-09-21T14:00:00+02:00']};

const nearTrain = {station: 1, vehicle: 3, waitingMinutes: 2};
const farTrain = {station: 1, vehicle: 1, waitingMinutes: 13};

const season = {
  startAt: '2026-03-28T09:00:00+01:00',
  endAt: '2026-09-23T18:00:00+02:00',
  scopes: ['europapark'],
  status: 'live',
  closed: false,
  hotelStartAt: '2026-03-28T08:00:00+01:00',
  hotelEndAt: '2026-03-28T09:00:00+01:00',
};
const liveCalendar = {
  today: {
    date: '2026-09-21',
    start: '2026-09-21T10:00:00+02:00',
    end: '2026-09-21T19:00:00+02:00',
  },
};

function stubbedPark(includeRaw: boolean): EuropaPark {
  const park = new EuropaPark({config: {hotelAppBase: 'https://hotelapp.example/'}});
  park.includeRaw = includeRaw;

  vi.spyOn(park as any, 'getPOIs').mockResolvedValue(pois);
  vi.spyOn(park as any, 'getWaitingTimes').mockResolvedValue(
    [rideWait, vQueueWait, gastronomyWait],
  );
  vi.spyOn(park as any, 'getShowTimes').mockResolvedValue([showEntry]);
  vi.spyOn(park as any, 'getExpressWaitTimes').mockResolvedValue([farTrain, nearTrain]);
  vi.spyOn(park as any, 'getSeasons').mockResolvedValue([season]);
  vi.spyOn(park as any, 'getLiveCalendar').mockResolvedValue(liveCalendar);

  return park;
}

const rawOf = (element: object) => (element as WithRaw<object>).raw;

describe('Europa-Park raw upstream pieces', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('attaches the waiting-times row, the virtual-queue row with it', async () => {
    const live = await stubbedPark(true).getLiveData();
    const ride = live.find((l) => l.id === 'pois_36')!;

    // The ride's own row and the dummy row that carries its return time.
    expect(rawOf(ride)).toEqual({waitingTimes: [rideWait, vQueueWait]});
    const rows = rawOf(ride)!.waitingTimes as unknown[];
    expect(rows[0]).toBe(rideWait);
    expect(rows[1]).toBe(vQueueWait);
    expect(ride.queue?.STANDBY).toEqual({waitTime: 45});
    expect(ride.queue?.RETURN_TIME?.state).toBe('TEMP_FULL');

    // A restaurant is fed by the same feed and has no virtual queue.
    const restaurant = live.find((l) => l.id === 'gastronomy_500')!;
    expect(rawOf(restaurant)).toEqual({waitingTimes: gastronomyWait});
    expect(rawOf(restaurant)!.waitingTimes).toBe(gastronomyWait);
  });

  it('attaches the show-times entry to a show', async () => {
    const live = await stubbedPark(true).getLiveData();
    const show = live.find((l) => l.id === 'shows_12')!;

    expect(rawOf(show)).toEqual({showTimes: showEntry});
    expect(rawOf(show)!.showTimes).toBe(showEntry);
    // The show runs 30 minutes, from the POI entry behind the entity.
    expect(show.showtimes).toEqual([{
      startTime: '2026-09-21T14:00:00+02:00',
      endTime: '2026-09-21T14:30:00+02:00',
      type: 'Performance',
    }]);
  });

  it('attaches every train that reported for a station, nothing to a silent one', async () => {
    const live = await stubbedPark(true).getLiveData();

    const served = live.find((l) => l.id === 'pois_60')!;
    expect(served.status).toBe('OPERATING');
    expect(served.queue?.STANDBY).toEqual({waitTime: 2});
    expect(rawOf(served)).toEqual({expressWaitTimes: [farTrain, nearTrain]});
    const rows = rawOf(served)!.expressWaitTimes as unknown[];
    expect(rows[0]).toBe(farTrain);
    expect(rows[1]).toBe(nearTrain);

    // No train reported for the other three stations, so their CLOSED has no
    // upstream row behind it.
    const silent = live.find((l) => l.id === 'pois_62')!;
    expect(silent.status).toBe('CLOSED');
    expect(rawOf(silent)).toBeUndefined();
  });

  it('attaches the POI entry to each entity, nothing to the destination', async () => {
    const entities = await stubbedPark(true).getEntities();
    expect(entities.map((e) => e.id)).toEqual([
      'europapark', 'park_493', 'pois_36', 'pois_37', 'pois_60', 'shows_12', 'gastronomy_500',
    ]);

    expect(rawOf(entities[0])).toBeUndefined();

    expect(rawOf(entities[1])).toEqual({pois: parkPoi});
    expect(rawOf(entities[1])!.pois).toBe(parkPoi);

    expect(rawOf(entities[2])).toEqual({pois: ridePoi});
    expect(rawOf(entities[2])!.pois).toBe(ridePoi);
    expect(entities[2].name).toBe('Voletarium');

    // A show comes from the entry nested in its showlocation, not from the
    // showlocation itself.
    expect(rawOf(entities[5])).toEqual({pois: nestedShow});
    expect(rawOf(entities[5])!.pois).toBe(nestedShow);

    expect(rawOf(entities[6])).toEqual({pois: gastronomyPoi});
    expect(rawOf(entities[6])!.pois).toBe(gastronomyPoi);
  });

  it('attaches the season to every day it covers and the live calendar to today', async () => {
    const schedules = await stubbedPark(true).getSchedules();
    const main = schedules.find((s) => s.id === 'park_493')!;

    expect(main.schedule.map((e) => `${e.date} ${e.type}`)).toEqual([
      '2026-09-21 OPERATING', '2026-09-21 EXTRA_HOURS',
      '2026-09-22 OPERATING', '2026-09-22 EXTRA_HOURS',
      '2026-09-23 OPERATING', '2026-09-23 EXTRA_HOURS',
    ]);

    // One season object stands behind all six entries.
    for (const entry of main.schedule) expect(rawOf(entry)!.seasons).toBe(season);

    // Today's operating hours were overridden by the live calendar.
    expect(rawOf(main.schedule[0])).toEqual({seasons: season, liveCalendar: liveCalendar.today});
    expect(rawOf(main.schedule[0])!.liveCalendar).toBe(liveCalendar.today);
    expect(main.schedule[0].openingTime).toBe('2026-09-21T10:00:00+02:00');
    expect(main.schedule[0].closingTime).toBe('2026-09-21T19:00:00+02:00');

    // The hotel hours of the same day were not, and neither was tomorrow.
    expect(rawOf(main.schedule[1])).toEqual({seasons: season});
    expect(rawOf(main.schedule[2])).toEqual({seasons: season});
    expect(main.schedule[2].openingTime).toBe('2026-09-22T09:00:00+02:00');
  });

  it('carries nothing when includeRaw is off', async () => {
    const park = stubbedPark(false);
    for (const element of await park.getLiveData()) expect(rawOf(element)).toBeUndefined();
    for (const element of await park.getEntities()) expect(rawOf(element)).toBeUndefined();
    for (const entity of await park.getSchedules()) {
      for (const element of entity.schedule) expect(rawOf(element)).toBeUndefined();
    }
  });
});
