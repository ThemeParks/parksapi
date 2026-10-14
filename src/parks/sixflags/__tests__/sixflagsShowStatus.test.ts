import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';
import type {LiveData} from '@themeparks/typelib';

/**
 * A show's status is its own venue-status row, not a constant.
 *
 * Shows used to publish OPERATING whatever venue-status said. Observed on one
 * poll at 14:49 local: for two parks every venue (1 to 4, rides and shows)
 * read "Not Scheduled", the operating-hours feed still listed normal hours,
 * the rides correctly read CLOSED, and 9 and 13 show rows (one count per
 * park) stayed OPERATING, unchanged from the night before. A third park on
 * the same poll had 43 rides "Opened".
 *
 * What the feed does with shows, sampled 2026-10-14 with every park shut: 325
 * show rows read "Not Scheduled" and none of them had a time in its park-local
 * day's listing; 10 read "On Time", nine with times listed that day and one
 * (a park closed that day) with none. "On Time" stays OPERATING. The status is
 * the vendor's reading for the day, not a statement that a show is on stage.
 *
 * The status strings are matched the way the vendor's own mobile app reads
 * this feed: lower-cased, not trimmed, "not scheduled" is closed, "temp
 * closed" and "temp closed due weather" are temporarily closed, and anything
 * else is open.
 */

const DORNEY = 8;
const AGAWAM = 935;
const GREAT_ADVENTURE = 905;

const DORNEY_LOCATION = {latitude: '40.58', longitude: '-75.53'};
const AGAWAM_LOCATION = {latitude: '42.04', longitude: '-72.62'};
const JACKSON_LOCATION = {latitude: '40.14', longitude: '-74.44'};

/** 14:49 Eastern on Saturday 26 September 2026. */
const NOW = new Date('2026-09-26T18:49:00Z');
const FRESH = 'Sep 26, 2026 14:49:00';
/** The snapshot an unrefreshed host kept serving for days. */
const FROZEN = 'Sep 21, 2026 13:03:00';

type Feed = {parkDateTime?: string; venues: Array<{venueId: number; details: Array<Record<string, unknown>>}>};

const idOf = (parkId: number, kind: string, n: number) =>
  `${kind}-${String(parkId).padStart(3, '0')}-${String(n).padStart(5, '0')}`;

/**
 * A venue-status feed with `rides` rides, `shows` shows, a maze and a
 * restaurant, every row carrying the given status per venue.
 */
function venueStatus(
  parkId: number,
  stamp: string,
  status: {rides: string; shows: string; mazes?: string; restaurants?: string},
  counts: {rides?: number; shows?: number} = {},
): Feed {
  const {rides = 3, shows = 4} = counts;
  const rows = (kind: string, n: number, s: string) =>
    Array.from({length: n}, (_, i) => ({id: i + 1, name: `${kind} ${i + 1}`, fimsId: idOf(parkId, kind, i + 1), status: s}));
  return {
    parkDateTime: stamp,
    venues: [
      {venueId: 1, details: rows('RIDE', rides, status.rides)},
      {venueId: 2, details: rows('SHOW', shows, status.shows)},
      {venueId: 3, details: rows('MAZE', 1, status.mazes ?? status.rides)},
      {venueId: 4, details: rows('DINING', 1, status.restaurants ?? status.rides)},
    ],
  };
}

/** The wait-times feed serves a roster of zeros whatever the park is doing. */
function zeroWaits(parkId: number, stamp: string, rides = 3): Feed {
  return {
    parkDateTime: stamp,
    venues: [{
      venueId: 1,
      details: Array.from({length: rides}, (_, i) => ({fimsId: idOf(parkId, 'RIDE', i + 1), regularWaittime: {waitTime: 0}})),
    }],
  };
}

/** An operating-hours day with normal park hours and a performance for each show. */
function normalDay(iso: string, parkId: number, shows: number) {
  return {
    date: `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`,
    isParkClosed: false,
    venues: [],
    operatings: [{operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: '11:00', timeTo: '23:00'}]}],
    shows: Array.from({length: shows}, (_, i) => ({
      showId: i + 1,
      extLocationID: idOf(parkId, 'SHOW', i + 1),
      showName: `Show ${i + 1}`,
      items: [{assignmentLocation: '', assignmentDescription: '', times: '03:00 PM, 06:30 PM'}],
    })),
  };
}

class Probe extends SixFlags {
  public parks = [
    {parkId: DORNEY, code: 'DP', name: 'Dorney Park', waterParks: []},
    {parkId: AGAWAM, code: 'SFNE', name: 'Six Flags New England', waterParks: []},
    {parkId: GREAT_ADVENTURE, code: 'SFGADV', name: 'Six Flags Great Adventure', waterParks: []},
  ];
  public venueStatusByPark: Record<number, Feed> = {};
  public waitTimesByPark: Record<number, Feed> = {};
  /** Operating-hours days per park, served the way the vendor does for a `YYYYMMDD` query. */
  public hours: Record<number, any[]> = {};

  constructor() {
    // A fallback distinct from every fixture park's real zone, so a silent
    // fallback cannot pass for a correct lookup.
    super({config: {timezone: 'UTC', baseUrl: 'https://vendor.invalid'}});
  }

  override async getParkData(): Promise<any> {
    return this.parks;
  }

  override async getPOI(): Promise<any> {
    const at = (parkId: number, location: {latitude: string; longitude: string}) =>
      ({fimsId: idOf(parkId, 'RIDE', 1), name: 'Ride', parkId, venueId: 1, location});
    return [at(DORNEY, DORNEY_LOCATION), at(AGAWAM, AGAWAM_LOCATION), at(GREAT_ADVENTURE, JACKSON_LOCATION)];
  }

  override async getVenueStatus(parkId: number): Promise<any> {
    return this.venueStatusByPark[parkId] ?? null;
  }

  override async getWaitTimes(parkId: number): Promise<any> {
    return this.waitTimesByPark[parkId] ?? null;
  }

  override async getOperatingHours(parkId: number, key: string): Promise<any> {
    const mdy = `${key.slice(4, 6)}/${key.slice(6, 8)}/${key.slice(0, 4)}`;
    return {dates: (this.hours[parkId] ?? []).filter(d => d.date === mdy)};
  }

  public liveForTest(): Promise<LiveData[]> {
    return this.getLiveData();
  }
}

/** The poll from the report: Dorney and New England shut, Great Adventure open. */
function theNoOperationPoll(stamp = FRESH): Probe {
  const probe = new Probe();
  const shut = {rides: 'Not Scheduled', shows: 'Not Scheduled'};
  probe.venueStatusByPark[DORNEY] = venueStatus(DORNEY, stamp, shut, {rides: 4, shows: 13});
  probe.venueStatusByPark[AGAWAM] = venueStatus(AGAWAM, stamp, shut, {rides: 4, shows: 9});
  probe.venueStatusByPark[GREAT_ADVENTURE] = venueStatus(GREAT_ADVENTURE, stamp, {rides: 'Opened', shows: 'On Time'}, {rides: 4, shows: 5});
  probe.waitTimesByPark[DORNEY] = zeroWaits(DORNEY, stamp, 4);
  probe.waitTimesByPark[AGAWAM] = zeroWaits(AGAWAM, stamp, 4);
  probe.waitTimesByPark[GREAT_ADVENTURE] = {
    parkDateTime: stamp,
    venues: [{venueId: 1, details: [1, 2, 3, 4].map(n => ({fimsId: idOf(GREAT_ADVENTURE, 'RIDE', n), regularWaittime: {waitTime: 10 * n}}))}],
  };
  // The hours feed still lists a normal day, with performances, for all three.
  probe.hours[DORNEY] = [normalDay('2026-09-26', DORNEY, 13)];
  probe.hours[AGAWAM] = [normalDay('2026-09-26', AGAWAM, 9)];
  probe.hours[GREAT_ADVENTURE] = [normalDay('2026-09-26', GREAT_ADVENTURE, 5)];
  return probe;
}

const rowsOf = (live: LiveData[], kind: string, parkId: number) =>
  live.filter(l => String(l.id).startsWith(`${kind}-${String(parkId).padStart(3, '0')}-`));

const statuses = (rows: LiveData[]) => [...new Set(rows.map(r => r.status))];

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(NOW);
  CacheLib.clearByClassName('Probe');
  CacheLib.clearByClassName('SixFlags');
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.useRealTimers();
});

describe('a park whose venue-status reads Not Scheduled for every venue', () => {
  test('rides read CLOSED, as before', async () => {
    const live = await theNoOperationPoll().liveForTest();

    expect(rowsOf(live, 'RIDE', DORNEY)).toHaveLength(4);
    expect(statuses(rowsOf(live, 'RIDE', DORNEY))).toEqual(['CLOSED']);
    expect(statuses(rowsOf(live, 'RIDE', AGAWAM))).toEqual(['CLOSED']);
  });

  test('every show reads CLOSED: 13 at one park, 9 at the other', async () => {
    const live = await theNoOperationPoll().liveForTest();

    expect(rowsOf(live, 'SHOW', DORNEY)).toHaveLength(13);
    expect(statuses(rowsOf(live, 'SHOW', DORNEY))).toEqual(['CLOSED']);
    expect(rowsOf(live, 'SHOW', AGAWAM)).toHaveLength(9);
    expect(statuses(rowsOf(live, 'SHOW', AGAWAM))).toEqual(['CLOSED']);
  });

  test('a closed show carries no showtimes, though the hours feed lists performances', async () => {
    const live = await theNoOperationPoll().liveForTest();

    for (const show of rowsOf(live, 'SHOW', DORNEY)) {
      expect((show as any).showtimes).toBeUndefined();
    }
  });

  test('the zero waits the feed serves are not data', async () => {
    const live = await theNoOperationPoll().liveForTest();

    for (const ride of rowsOf(live, 'RIDE', DORNEY)) {
      expect(ride.status).toBe('CLOSED');
      expect(ride.queue?.STANDBY?.waitTime).toBeUndefined();
    }
  });

  test('a park on the same poll that is open keeps its rides and shows OPERATING', async () => {
    const live = await theNoOperationPoll().liveForTest();

    expect(statuses(rowsOf(live, 'RIDE', GREAT_ADVENTURE))).toEqual(['OPERATING']);
    expect(statuses(rowsOf(live, 'SHOW', GREAT_ADVENTURE))).toEqual(['OPERATING']);
    expect(rowsOf(live, 'RIDE', GREAT_ADVENTURE).map(r => r.queue?.STANDBY?.waitTime)).toEqual([10, 20, 30, 40]);
  });

  test('the open park\'s shows still publish their times', async () => {
    const live = await theNoOperationPoll().liveForTest();
    const first = rowsOf(live, 'SHOW', GREAT_ADVENTURE)[0] as any;

    expect(first.showtimes.map((s: {startTime: string}) => s.startTime)).toEqual([
      '2026-09-26T15:00:00-04:00', '2026-09-26T18:30:00-04:00',
    ]);
  });

  test('a fresh snapshot never consults the schedule to decide', async () => {
    const probe = theNoOperationPoll();
    const scheduleCheck = vi.spyOn(probe, 'scheduleSaysOpen');

    await probe.liveForTest();

    expect(scheduleCheck).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('show status follows the show\'s own row', () => {
  const liveWith = async (showStatuses: Array<string | undefined>) => {
    const probe = new Probe();
    probe.parks = [probe.parks[2]];
    probe.venueStatusByPark[GREAT_ADVENTURE] = {
      parkDateTime: FRESH,
      venues: [
        {venueId: 1, details: [{fimsId: idOf(GREAT_ADVENTURE, 'RIDE', 1), status: 'Opened'}]},
        {venueId: 2, details: showStatuses.map((status, i) =>
          ({fimsId: idOf(GREAT_ADVENTURE, 'SHOW', i + 1), ...(status === undefined ? {} : {status})}))},
      ],
    };
    probe.hours[GREAT_ADVENTURE] = [normalDay('2026-09-26', GREAT_ADVENTURE, showStatuses.length)];
    return rowsOf(await probe.liveForTest(), 'SHOW', GREAT_ADVENTURE);
  };

  test('one show not scheduled among shows that are', async () => {
    const shows = await liveWith(['On Time', 'Not Scheduled', 'On Time']);

    expect(shows.map(s => s.status)).toEqual(['OPERATING', 'CLOSED', 'OPERATING']);
    expect((shows[0] as any).showtimes).toHaveLength(2);
    expect((shows[1] as any).showtimes).toBeUndefined();
    expect((shows[2] as any).showtimes).toHaveLength(2);
  });

  test('a temp-closed show is DOWN and keeps its listed showtimes; a not-scheduled one loses them', async () => {
    const shows = await liveWith(['Temp Closed', 'Temp Closed Due Weather', 'Not Scheduled', 'On Time']);

    expect(shows.map(s => s.status)).toEqual(['DOWN', 'DOWN', 'CLOSED', 'OPERATING']);
    expect((shows[0] as any).showtimes).toHaveLength(2);
    expect((shows[1] as any).showtimes).toHaveLength(2);
    expect((shows[2] as any).showtimes).toBeUndefined();
    expect((shows[3] as any).showtimes).toHaveLength(2);
  });

  test.each([
    ['Not Scheduled', 'CLOSED'],
    ['not scheduled', 'CLOSED'],
    ['NOT SCHEDULED', 'CLOSED'],
    ['Temp Closed', 'DOWN'],
    ['temp closed', 'DOWN'],
    ['Temp Closed Due Weather', 'DOWN'],
    ['TEMP CLOSED DUE WEATHER', 'DOWN'],
    // Exact match, no trimming and no substring match, as the app does it.
    [' Not Scheduled', 'OPERATING'],
    ['Not Scheduled ', 'OPERATING'],
    ['Temp Closed ', 'OPERATING'],
    ['Notice', 'OPERATING'],
    ['Not Yet Open', 'OPERATING'],
    ['Temp Closed Due To Weather', 'OPERATING'],
    ['On Time', 'OPERATING'],
    ['Opened', 'OPERATING'],
    ['Open', 'OPERATING'],
    // No statement at all is not a statement that the show is off: this is
    // what a show with a missing or blank status published before, and a show
    // posts no wait that could stand in for it.
    ['', 'OPERATING'],
    [undefined, 'OPERATING'],
    // A status this module has not seen keeps the default the rides use.
    ['Delayed', 'OPERATING'],
  ])('status %j publishes %s', async (status, expected) => {
    const [show] = await liveWith([status]);

    expect(show.status).toBe(expected);
  });
});

describe('the all-Not-Scheduled snapshot that is frozen', () => {
  // The frozen-feed guard decides on the rides. Shows follow whatever it lets through.

  test('on a day the schedule says the park is open, rides and shows are both withheld', async () => {
    const probe = theNoOperationPoll(FROZEN);

    const live = await probe.liveForTest();

    // Great Adventure's snapshot is frozen too and is not all Not Scheduled.
    expect(live).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`park ${DORNEY} venue-status is frozen`));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`park ${AGAWAM} venue-status is frozen`));
  });

  test('on a day the schedule says the park is shut, rides and shows publish CLOSED', async () => {
    const probe = theNoOperationPoll(FROZEN);
    // The off-season shape: listed, closed, nothing to run.
    probe.hours[DORNEY] = [{...normalDay('2026-09-26', DORNEY, 0), isParkClosed: true, operatings: []}];
    probe.hours[AGAWAM] = [{...normalDay('2026-09-26', AGAWAM, 0), isParkClosed: true, operatings: []}];

    const live = await probe.liveForTest();

    expect(rowsOf(live, 'RIDE', DORNEY).length).toBe(4);
    expect(statuses(rowsOf(live, 'RIDE', DORNEY))).toEqual(['CLOSED']);
    expect(rowsOf(live, 'SHOW', DORNEY).length).toBe(13);
    expect(statuses(rowsOf(live, 'SHOW', DORNEY))).toEqual(['CLOSED']);
    expect(statuses(rowsOf(live, 'SHOW', AGAWAM))).toEqual(['CLOSED']);
  });

  test('an unreadable schedule fails open: the park publishes, shows CLOSED', async () => {
    const probe = theNoOperationPoll(FROZEN);
    probe.hours[DORNEY] = [];
    probe.hours[AGAWAM] = [];

    const live = await probe.liveForTest();

    expect(statuses(rowsOf(live, 'SHOW', DORNEY))).toEqual(['CLOSED']);
    expect(statuses(rowsOf(live, 'RIDE', DORNEY))).toEqual(['CLOSED']);
  });
});
