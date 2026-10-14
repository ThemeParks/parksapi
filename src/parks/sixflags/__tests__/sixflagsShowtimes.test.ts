import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';
import type {LiveData} from '@themeparks/typelib';

/**
 * The operating-hours `shows` entries are keyed by `extLocationID`, the same
 * string the POI and venue-status rows call `fimsId` ("SHOW-004-00036"). An
 * entry carries no `fimsId` at all: 0 of 8,380 entries across 26 parks and
 * three months of days sampled on 2026-10-14. The module used to match on
 * `fimsId`, so no show ever received times.
 *
 * Knott's Berry Farm also lists shows at "12:00 AM" and "12:30 AM" on its
 * Scary Farm nights (24 entries on 10 nights in that sample, no other park
 * had a time between midnight and 09:00). They belong to the NEXT calendar
 * day: the same listing carries a haunt window that runs 19:00-01:00 or
 * 19:00-02:00.
 *
 * Every fixture below has the shape of that payload, trimmed. The tests that
 * reach the clock pin it, because the shows are read for the park-local day.
 */

const KNOTTS = 4;
const BUENA_PARK = {latitude: '33.84', longitude: '-118.00'};

const THE_HANGING = 'SHOW-004-00001';
const OCCULTUM = 'SHOW-004-00208';
const FIREMANS_DUO = 'SHOW-004-00139';
const SNOOPY = 'SHOW-004-00008';
const UNLISTED = 'SHOW-004-00036';

type Show = {showId: number; extLocationID: string; showName: string; items: Array<Record<string, string>>};

/** A `shows` entry exactly as the vendor serves it. */
function show(extLocationID: string, showName: string, times: string, showId = 1): Show {
  return {showId, extLocationID, showName, items: [{assignmentLocation: '', assignmentDescription: '', times}]};
}

type Day = {date: string; isParkClosed: boolean; venues: unknown[]; operatings: unknown[]; shows: Show[]};

/**
 * One operating-hours day. A haunt window is added the way the vendor serves
 * Scary Farm: an operatingTypeId 25 block beside the regular Park block.
 */
function day(iso: string, shows: Show[], opts: {haunt?: [string, string]; open?: string; close?: string} = {}): Day {
  const {haunt, open = '10:00', close = '17:30'} = opts;
  return {
    date: `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`,
    isParkClosed: false,
    venues: [],
    operatings: [
      {operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: open, timeTo: close}]},
      ...(haunt ? [{operatingTypeId: 25, operatingTypeName: 'Haunt', items: [{timeFrom: haunt[0], timeTo: haunt[1]}]}] : []),
    ],
    shows,
  };
}

const toYmd = (mdy: string) => `${mdy.slice(6, 10)}${mdy.slice(0, 2)}${mdy.slice(3, 5)}`;

class Probe extends SixFlags {
  public calendar: Day[] = [];
  public requests: string[] = [];
  /** Statuses venue-status serves for the show venue; every show is "On Time" unless listed. */
  public showStatus: Record<string, string> = {};

  constructor() {
    // A fallback distinct from the park's real zone, so a silent fallback
    // cannot pass for a correct lookup.
    super({config: {timezone: 'UTC', baseUrl: 'https://vendor.invalid'}});
  }

  override async getParkData(): Promise<any> {
    return [{parkId: KNOTTS, code: 'KB', name: "Knott's Berry Farm", waterParks: []}];
  }

  override async getPOI(): Promise<any> {
    return [{fimsId: 'RIDE-004-00172', name: 'GhostRider', parkId: KNOTTS, venueId: 1, location: BUENA_PARK}];
  }

  override async getVenueStatus(): Promise<any> {
    const ids = [THE_HANGING, OCCULTUM, FIREMANS_DUO, SNOOPY, UNLISTED];
    return {
      venues: [
        {venueId: 1, details: [{fimsId: 'RIDE-004-00172', status: 'Opened'}]},
        {venueId: 2, details: ids.map(id => ({id: 1, name: id, fimsId: id, status: this.showStatus[id] ?? 'On Time'}))},
      ],
    };
  }

  override async getWaitTimes(): Promise<any> {
    return null;
  }

  /** Below the cached getOperatingHours, so the tests see what reaches the vendor. */
  override async fetchOperatingHours(_parkId: number, date: string): Promise<any> {
    this.requests.push(date);
    return {json: async () => ({dates: this.calendar.filter(d => toYmd(d.date) === date)})};
  }

  public liveForTest(): Promise<LiveData[]> {
    return this.getLiveData();
  }
}

const showtimesOf = (live: LiveData[], id: string): string[] =>
  ((live.find(l => l.id === id) as any)?.showtimes ?? []).map((s: {startTime: string}) => s.startTime);

const liveShow = (live: LiveData[], id: string) => live.find(l => l.id === id) as any;

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  CacheLib.clearByClassName('Probe');
  CacheLib.clearByClassName('SixFlags');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('shows are matched on extLocationID', () => {
  // 12:00 Pacific on Tuesday 13 October 2026.
  beforeEach(() => vi.setSystemTime(new Date('2026-10-13T19:00:00Z')));

  test('a listed show receives its times', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-10-13', [
      show(SNOOPY, 'Meet Snoopy in Camp Snoopy', '10:30 AM, 11:00 AM, 05:30 PM', 893),
      show(FIREMANS_DUO, "Fireman's Duo", '12:30 PM, 01:45 PM, 03:15 PM, 04:30 PM', 894),
    ], {open: '10:00', close: '18:00'})];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, SNOOPY)).toEqual([
      '2026-10-13T10:30:00-07:00', '2026-10-13T11:00:00-07:00', '2026-10-13T17:30:00-07:00',
    ]);
    expect(showtimesOf(live, FIREMANS_DUO)).toEqual([
      '2026-10-13T12:30:00-07:00', '2026-10-13T13:45:00-07:00', '2026-10-13T15:15:00-07:00', '2026-10-13T16:30:00-07:00',
    ]);
  });

  test('each showtime runs for the default half hour', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-10-13', [show(SNOOPY, 'Meet Snoopy in Camp Snoopy', '05:30 PM')])];

    const live = await probe.liveForTest();

    expect(liveShow(live, SNOOPY).showtimes).toEqual([
      {startTime: '2026-10-13T17:30:00-07:00', endTime: '2026-10-13T18:00:00-07:00', type: 'Performance Time'},
    ]);
  });

  test('a show listed with an empty times string publishes no showtimes', async () => {
    // Most entries are like this: 8,380 sampled, 1,481 with any time at all.
    const probe = new Probe();
    probe.calendar = [day('2026-10-13', [show(UNLISTED, 'Bob Baker Marionette Theater', '')])];

    const live = await probe.liveForTest();

    expect(liveShow(live, UNLISTED)).toBeDefined();
    expect(liveShow(live, UNLISTED).showtimes).toBeUndefined();
  });

  test('an entry for a show that venue-status does not list is ignored', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-10-13', [show('SHOW-004-00999', 'Not In Venue Status', '02:00 PM')])];

    const live = await probe.liveForTest();

    expect(live.find(l => l.id === 'SHOW-004-00999')).toBeUndefined();
  });

  test('an entry with no extLocationID is skipped without disturbing the others', async () => {
    const probe = new Probe();
    const orphan = {showId: 7, showName: 'No id', items: [{times: '01:00 PM'}]} as unknown as Show;
    probe.calendar = [day('2026-10-13', [orphan, show(SNOOPY, 'Meet Snoopy in Camp Snoopy', '02:00 PM')])];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, SNOOPY)).toEqual(['2026-10-13T14:00:00-07:00']);
  });

  test('a stray fimsId on an entry is not a key', async () => {
    // The vendor never sends one. If it did, the show's identity is still the
    // extLocationID; matching on fimsId is what this module used to do.
    const probe = new Probe();
    const wrong = {...show(UNLISTED, 'Keyed wrongly', '03:00 PM'), extLocationID: undefined, fimsId: SNOOPY} as unknown as Show;
    probe.calendar = [day('2026-10-13', [wrong])];

    const live = await probe.liveForTest();

    expect(liveShow(live, SNOOPY).showtimes).toBeUndefined();
  });

  test('the same show listed twice in one day keeps both lists', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-10-13', [
      show(SNOOPY, 'Meet Snoopy in Camp Snoopy', '10:30 AM', 1),
      show(SNOOPY, 'Meet Snoopy in Camp Snoopy', '04:30 PM', 2),
    ])];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, SNOOPY)).toEqual(['2026-10-13T10:30:00-07:00', '2026-10-13T16:30:00-07:00']);
  });
});

describe('shows listed after midnight belong to the next calendar day', () => {
  // The 15 October listing, as Knott's served it: park 10:00-17:30, Scary Farm
  // 19:00-01:00, three shows with a midnight performance.
  const scaryFarmNight = (iso: string, haunt: [string, string] = ['19:00', '01:00']) => day(iso, [
    show(THE_HANGING, 'The Hanging', '12:00 AM, 08:15 PM, 10:15 PM', 844),
    show(OCCULTUM, 'Occultum, Curated by The Magic Castle', '12:30 AM, 08:15 PM, 09:30 PM, 11:15 PM', 900),
  ], {haunt});

  beforeEach(() => vi.setSystemTime(new Date('2026-10-15T19:00:00Z'))); // 12:00 Pacific

  test('12:00 AM is dated the next day, not the start of the park day', async () => {
    const probe = new Probe();
    probe.calendar = [scaryFarmNight('2026-10-15')];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, THE_HANGING)).toEqual([
      '2026-10-15T20:15:00-07:00', '2026-10-15T22:15:00-07:00', '2026-10-16T00:00:00-07:00',
    ]);
  });

  test('12:30 AM is dated the next day', async () => {
    const probe = new Probe();
    probe.calendar = [scaryFarmNight('2026-10-15', ['19:00', '02:00'])];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, OCCULTUM)).toEqual([
      '2026-10-15T20:15:00-07:00', '2026-10-15T21:30:00-07:00', '2026-10-15T23:15:00-07:00', '2026-10-16T00:30:00-07:00',
    ]);
  });

  test('the carried show keeps its half hour', async () => {
    const probe = new Probe();
    probe.calendar = [scaryFarmNight('2026-10-15')];

    const live = await probe.liveForTest();

    expect(liveShow(live, THE_HANGING).showtimes.at(-1)).toEqual({
      startTime: '2026-10-16T00:00:00-07:00', endTime: '2026-10-16T00:30:00-07:00', type: 'Performance Time',
    });
  });

  test('the times come out in chronological order', async () => {
    const probe = new Probe();
    probe.calendar = [scaryFarmNight('2026-10-15')];

    const starts = showtimesOf(await probe.liveForTest(), OCCULTUM).map(t => Date.parse(t));

    expect(starts).toHaveLength(4);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  test('a time is only carried when the day\'s own hours run past midnight', async () => {
    // No haunt window and a park that closes at 17:30: nothing in the listing
    // says a midnight show is anything but a stray entry, so it stays put.
    const probe = new Probe();
    probe.calendar = [day('2026-10-15', [show(THE_HANGING, 'The Hanging', '12:00 AM, 02:00 PM')])];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, THE_HANGING)).toEqual(['2026-10-15T00:00:00-07:00', '2026-10-15T14:00:00-07:00']);
  });

  test('only a time at or before the close is carried: a daytime time keeps its day', async () => {
    const probe = new Probe();
    probe.calendar = [day('2026-10-15', [show(SNOOPY, 'Meet Snoopy', '09:30 AM, 12:00 PM, 01:00 AM')], {haunt: ['19:00', '02:00']})];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, SNOOPY)).toEqual([
      '2026-10-15T09:30:00-07:00', '2026-10-15T12:00:00-07:00', '2026-10-16T01:00:00-07:00',
    ]);
  });

  test('the carry stops at the close: a time later than the haunt closes stays on its own day', async () => {
    // Close is 01:00. 01:00 AM carries (inclusive); 01:01 AM does not.
    const probe = new Probe();
    probe.calendar = [day('2026-10-15', [show(SNOOPY, 'Meet Snoopy', '01:00 AM, 01:01 AM')], {haunt: ['19:00', '01:00']})];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, SNOOPY)).toEqual(['2026-10-15T01:01:00-07:00', '2026-10-16T01:00:00-07:00']);
  });

  test('park hours that run past midnight carry a midnight show too', async () => {
    // Cedar Point-style 11:00-00:00 with a midnight finale, no haunt block.
    const probe = new Probe();
    probe.calendar = [day('2026-10-15', [show(SNOOPY, 'Midnight Finale', '12:00 AM, 09:00 PM')], {open: '11:00', close: '00:00'})];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, SNOOPY)).toEqual(['2026-10-15T21:00:00-07:00', '2026-10-16T00:00:00-07:00']);
  });

  test('a day with no hours at all leaves a midnight time where it was listed', async () => {
    // How one Mexican park-day read in the sample: venues listed, every hour blank.
    const probe = new Probe();
    const blank = {...day('2026-10-15', [show(SNOOPY, 'Boo Kadabra', '12:00 PM, 12:00 AM')]), operatings: []};
    probe.calendar = [blank];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, SNOOPY)).toEqual(['2026-10-15T00:00:00-07:00', '2026-10-15T12:00:00-07:00']);
  });

  describe('across a month boundary', () => {
    test('31 October at 12:30 AM is 1 November', async () => {
      vi.setSystemTime(new Date('2026-10-31T19:00:00Z')); // 12:00 Pacific on Halloween
      const probe = new Probe();
      probe.calendar = [scaryFarmNight('2026-10-31', ['19:00', '02:00'])];

      const live = await probe.liveForTest();

      expect(showtimesOf(live, OCCULTUM).at(-1)).toBe('2026-11-01T00:30:00-07:00');
      expect(showtimesOf(live, THE_HANGING).at(-1)).toBe('2026-11-01T00:00:00-07:00');
    });

    test('31 December at 12:00 AM is 1 January of the next year', async () => {
      vi.setSystemTime(new Date('2026-12-31T20:00:00Z')); // 12:00 Pacific
      const probe = new Probe();
      probe.calendar = [scaryFarmNight('2026-12-31')];

      const live = await probe.liveForTest();

      expect(showtimesOf(live, THE_HANGING).at(-1)).toBe('2027-01-01T00:00:00-08:00');
    });

    test('28 February at 12:00 AM is 1 March in a common year', async () => {
      vi.setSystemTime(new Date('2027-02-28T20:00:00Z'));
      const probe = new Probe();
      probe.calendar = [scaryFarmNight('2027-02-28')];

      const live = await probe.liveForTest();

      expect(showtimesOf(live, THE_HANGING).at(-1)).toBe('2027-03-01T00:00:00-08:00');
    });
  });

  describe('across a DST change, the offset follows the calendar day and not 24 hours', () => {
    test('the night clocks go back (1 November): both the evening show and the carried one read PST', async () => {
      // 2026-11-01 02:00 PDT becomes 01:00 PST. Adding 24 hours to the
      // 00:30 PDT start would land on 23:30 PST on the 1st, an hour early.
      vi.setSystemTime(new Date('2026-11-01T20:00:00Z')); // 12:00 PST
      const probe = new Probe();
      probe.calendar = [day('2026-11-01', [show(OCCULTUM, 'Occultum', '12:30 AM, 08:15 PM')], {haunt: ['19:00', '01:00']})];

      const live = await probe.liveForTest();

      expect(showtimesOf(live, OCCULTUM)).toEqual(['2026-11-01T20:15:00-08:00', '2026-11-02T00:30:00-08:00']);
    });

    test('the night before clocks go back (31 October): the carried show is still PDT', async () => {
      vi.setSystemTime(new Date('2026-10-31T19:00:00Z'));
      const probe = new Probe();
      probe.calendar = [day('2026-10-31', [show(OCCULTUM, 'Occultum', '12:30 AM, 08:15 PM')], {haunt: ['19:00', '02:00']})];

      const live = await probe.liveForTest();

      expect(showtimesOf(live, OCCULTUM)).toEqual(['2026-10-31T20:15:00-07:00', '2026-11-01T00:30:00-07:00']);
    });

    test('the night before clocks go forward (7 March): the carried show is still PST', async () => {
      // 2026-03-08 02:00 PST becomes 03:00 PDT. 00:30 on the 8th is before the gap.
      vi.setSystemTime(new Date('2026-03-07T20:00:00Z'));
      const probe = new Probe();
      probe.calendar = [day('2026-03-07', [show(OCCULTUM, 'Occultum', '12:30 AM, 08:15 PM')], {haunt: ['19:00', '02:00']})];

      const live = await probe.liveForTest();

      expect(showtimesOf(live, OCCULTUM)).toEqual(['2026-03-07T20:15:00-08:00', '2026-03-08T00:30:00-08:00']);
    });

    test('the night clocks go forward (8 March): the evening show and the carried one read PDT', async () => {
      vi.setSystemTime(new Date('2026-03-08T20:00:00Z')); // 13:00 PDT
      const probe = new Probe();
      probe.calendar = [day('2026-03-08', [show(OCCULTUM, 'Occultum', '12:30 AM, 08:15 PM')], {haunt: ['19:00', '02:00']})];

      const live = await probe.liveForTest();

      expect(showtimesOf(live, OCCULTUM)).toEqual(['2026-03-08T20:15:00-07:00', '2026-03-09T00:30:00-07:00']);
    });
  });
});

describe('after park-local midnight, last night\'s late shows are still published', () => {
  const lateShow = (iso: string, haunt: [string, string] = ['19:00', '02:00']) => day(iso, [
    show(OCCULTUM, 'Occultum', '12:30 AM, 08:15 PM', 900),
  ], {haunt});

  test('00:10 on the 16th keeps the 16th\'s 12:30 AM from the 15th\'s listing', async () => {
    vi.setSystemTime(new Date('2026-10-16T07:10:00Z')); // 00:10 PDT
    const probe = new Probe();
    probe.calendar = [lateShow('2026-10-15'), lateShow('2026-10-16')];

    const live = await probe.liveForTest();

    // From the 15th: its carried 12:30 AM, now today. From the 16th: its own
    // evening show and its carried 12:30 AM on the 17th. Not the 15th's 8:15 PM.
    expect(showtimesOf(live, OCCULTUM)).toEqual([
      '2026-10-16T00:30:00-07:00', '2026-10-16T20:15:00-07:00', '2026-10-17T00:30:00-07:00',
    ]);
  });

  test('00:10 on 1 November reaches back into October', async () => {
    vi.setSystemTime(new Date('2026-11-01T07:10:00Z')); // 00:10 PDT, clocks go back at 02:00
    const probe = new Probe();
    probe.calendar = [lateShow('2026-10-31'), day('2026-11-01', [show(OCCULTUM, 'Occultum', '02:00 PM')])];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, OCCULTUM)).toEqual(['2026-11-01T00:30:00-07:00', '2026-11-01T14:00:00-08:00']);
  });

  test('a yesterday with no late shows adds nothing', async () => {
    vi.setSystemTime(new Date('2026-10-16T07:10:00Z'));
    const probe = new Probe();
    probe.calendar = [
      day('2026-10-15', [show(OCCULTUM, 'Occultum', '08:15 PM')], {haunt: ['19:00', '02:00']}),
      day('2026-10-16', [show(OCCULTUM, 'Occultum', '02:00 PM')]),
    ];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, OCCULTUM)).toEqual(['2026-10-16T14:00:00-07:00']);
  });

  test('a performance both listings place at the same instant is published once', async () => {
    // Yesterday's haunt carries its 12:00 AM onto today. Today has no late
    // window, so its own 12:00 AM stays at the start of today: the same instant.
    vi.setSystemTime(new Date('2026-10-16T07:10:00Z'));
    const probe = new Probe();
    probe.calendar = [
      day('2026-10-15', [show(OCCULTUM, 'Occultum', '12:00 AM')], {haunt: ['19:00', '02:00']}),
      day('2026-10-16', [show(OCCULTUM, 'Occultum', '12:00 AM, 02:00 PM')]),
    ];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, OCCULTUM)).toEqual(['2026-10-16T00:00:00-07:00', '2026-10-16T14:00:00-07:00']);
  });

  test('a yesterday the vendor does not answer for does not break today', async () => {
    vi.setSystemTime(new Date('2026-10-16T07:10:00Z'));
    const probe = new Probe();
    probe.calendar = [day('2026-10-16', [show(OCCULTUM, 'Occultum', '02:00 PM')])];

    const live = await probe.liveForTest();

    expect(showtimesOf(live, OCCULTUM)).toEqual(['2026-10-16T14:00:00-07:00']);
  });

  test('asks for the park-local yesterday and today, once each', async () => {
    vi.setSystemTime(new Date('2026-11-01T07:10:00Z')); // 00:10 PDT on 1 November
    const probe = new Probe();
    probe.calendar = [lateShow('2026-10-31')];

    await probe.liveForTest();
    await probe.liveForTest();

    expect(probe.requests).toEqual(['20261101', '20261031']);
  });
});
