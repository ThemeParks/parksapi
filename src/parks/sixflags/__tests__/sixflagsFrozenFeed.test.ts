import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {
  SixFlags, parseParkDateTime, isFrozenSnapshot, isAllNotScheduled, LIVE_FEED_MAX_AGE_MINUTES,
} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';
import type {LiveData} from '@themeparks/typelib';

/**
 * An API host that stops refreshing keeps answering 200 with its last
 * snapshot. The only tell is the park-local `parkDateTime` stamp both live
 * feeds carry. Observed 2026-09-24: every park served a snapshot stamped
 * "Sep 21, 2026 13:03:00" for three and a half days, so Cedar Point opened
 * for the evening with every ride reading "Not Scheduled" and Knott's kept
 * 30 rides published as open through three nights.
 */

const CEDAR_POINT = 1;
const KNOTTS = 4;
const SOAK_CITY = 201;
const NY = 'America/New_York';

/** 2026-09-24 22:31:30 Eastern / 19:31:30 Pacific. */
const NOW = new Date('2026-09-25T02:31:30Z');
const FRESH_ET = 'Sep 24, 2026 22:31:00';
const FRESH_PT = 'Sep 24, 2026 19:31:00';
const MONDAY_ET = 'Sep 21, 2026 13:03:00';
const MONDAY_PT = 'Sep 21, 2026 10:03:00';

const SANDUSKY = {latitude: '41.48', longitude: '-82.68'};
const BUENA_PARK = {latitude: '33.84', longitude: '-118.00'};

type Feed = {parkDateTime?: string; venues: Array<{venueId: number; details: Array<Record<string, unknown>>}>};

class Probe extends SixFlags {
  public parks: any[] = [{parkId: CEDAR_POINT, code: 'CP', name: 'Cedar Point', waterParks: []}];
  public poi: any[] = [{fimsId: 'RIDE-001-00325', name: 'Top Thrill 2', parkId: CEDAR_POINT, venueId: 1, location: SANDUSKY}];
  public venueStatus: Record<number, Feed> = {};
  public waitTimes: Record<number, Feed> = {};
  /**
   * Operating-hours days per park, served the way the vendor does: a
   * `YYYYMMDD` query answers with that one day. null = the fetch failed.
   */
  public schedule: Record<number, any[] | null> = {};
  public hoursRequests: string[] = [];

  constructor() {
    // A fallback distinct from every fixture park's real zone, so a silent
    // fallback cannot pass for a correct lookup.
    super({config: {timezone: 'UTC'}});
  }

  override async getParkData(): Promise<any> {
    return this.parks;
  }

  override async getPOI(): Promise<any> {
    return this.poi;
  }

  override async getVenueStatus(parkId: number): Promise<any> {
    return this.venueStatus[parkId] ?? null;
  }

  override async getWaitTimes(parkId: number): Promise<any> {
    return this.waitTimes[parkId] ?? null;
  }

  override async getOperatingHours(parkId: number, month: string): Promise<any> {
    this.hoursRequests.push(`${parkId}:${month}`);
    const days = this.schedule[parkId];
    if (days === null) return null;
    const mdy = `${month.slice(4, 6)}/${month.slice(6, 8)}/${month.slice(0, 4)}`;
    return {dates: (days ?? []).filter(d => month.length === 8 ? d.date === mdy : d.date.startsWith(`${month.slice(4, 6)}/`))};
  }

  public liveForTest(): Promise<LiveData[]> {
    return this.getLiveData();
  }
}

function venueStatus(stamp: string | undefined, prefix = '001', rideStatus = 'Opened'): Feed {
  return {
    ...(stamp !== undefined ? {parkDateTime: stamp} : {}),
    venues: [
      {venueId: 1, details: [
        {fimsId: `RIDE-${prefix}-00325`, status: rideStatus},
        {fimsId: `RIDE-${prefix}-00188`, status: 'Not Scheduled'},
      ]},
      {venueId: 2, details: [{fimsId: `SHOW-${prefix}-00010`, status: 'Opened'}]},
    ],
  };
}

function waitTimes(stamp: string | undefined, prefix = '001'): Feed {
  return {
    ...(stamp !== undefined ? {parkDateTime: stamp} : {}),
    venues: [{venueId: 1, details: [{fimsId: `RIDE-${prefix}-00325`, regularWaittime: {waitTime: 60}}]}],
  };
}

function cedarPoint(vsStamp: string | undefined, wtStamp: string | undefined = vsStamp): Probe {
  const probe = new Probe();
  probe.venueStatus[CEDAR_POINT] = venueStatus(vsStamp);
  probe.waitTimes[CEDAR_POINT] = waitTimes(wtStamp);
  return probe;
}

/** Knott's (Pacific) plus its water park, Soak City. */
function knotts(): Probe {
  const probe = new Probe();
  probe.parks = [{parkId: KNOTTS, code: 'KB', name: "Knott's Berry Farm", waterParks: [{parkId: SOAK_CITY, code: 'SC', name: "Knott's Soak City"}]}];
  probe.poi = [
    {fimsId: 'RIDE-004-00172', name: 'GhostRider', parkId: KNOTTS, venueId: 1, location: BUENA_PARK},
    {fimsId: 'RIDE-201-00001', name: 'Pacific Spin', parkId: SOAK_CITY, venueId: 1, location: BUENA_PARK},
  ];
  return probe;
}

/** One operating-hours day. `open`/`close` null = a listed day with no park hours. */
function day(date: string, opts: {closed?: boolean; open?: string; close?: string}) {
  const {closed = false, open, close} = opts;
  return {
    date,
    isParkClosed: closed,
    venues: [],
    operatings: open && close
      ? [{operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: open, timeTo: close}]}]
      : [],
  };
}

/** Cedar Point with a frozen snapshot whose every ride reads Not Scheduled. */
function frozenAllNotScheduled(): Probe {
  const probe = new Probe();
  probe.venueStatus[CEDAR_POINT] = venueStatus(MONDAY_ET, '001', 'Not Scheduled');
  return probe;
}

const idsOf = (live: LiveData[]) => live.map(l => l.id).sort();

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

describe('parseParkDateTime', () => {
  test('reads the vendor stamp as park-local wall clock', () => {
    expect(parseParkDateTime('Sep 24, 2026 22:31:00', NY)).toBe(Date.parse('2026-09-25T02:31:00Z'));
  });

  test('handles a single-digit day and hour', () => {
    expect(parseParkDateTime('Oct 4, 2026 9:05:00', NY)).toBe(Date.parse('2026-10-04T13:05:00Z'));
  });

  test('handles a full month name and trailing whitespace', () => {
    expect(parseParkDateTime('September 24, 2026 22:31:00  ', NY)).toBe(Date.parse('2026-09-25T02:31:00Z'));
  });

  test('reads the same stamp differently in a different zone', () => {
    expect(parseParkDateTime('Sep 24, 2026 22:31:00', 'Europe/Paris')).toBe(Date.parse('2026-09-24T20:31:00Z'));
  });

  test.each([undefined, null, '', 'yesterday', '2026-09-24T22:31:00', 'Foo 24, 2026 22:31:00', '10:31:00 PM', 42])(
    'returns null for %j',
    (value) => {
      expect(parseParkDateTime(value, NY)).toBeNull();
    },
  );
});

describe('isFrozenSnapshot', () => {
  const minutesBefore = (min: number) => new Date(NOW.getTime() - min * 60_000);

  test('the allowance is two hours', () => {
    expect(LIVE_FEED_MAX_AGE_MINUTES).toBe(120);
  });

  test('a stamp from this minute is current', () => {
    expect(isFrozenSnapshot(FRESH_ET, NY, NOW)).toBe(false);
  });

  test('a stamp exactly at the allowance is still current', () => {
    // 22:31:00 stamp, clock 00:31:00: exactly 120 minutes.
    expect(isFrozenSnapshot(FRESH_ET, NY, new Date('2026-09-25T04:31:00Z'))).toBe(false);
  });

  test('one second past the allowance is frozen', () => {
    expect(isFrozenSnapshot(FRESH_ET, NY, new Date('2026-09-25T04:31:01Z'))).toBe(true);
  });

  test('a one-hour zone error does not read as frozen', () => {
    // Hurricane Harbor Oaxtepec stamps in UTC-5 while GPS resolves UTC-6.
    expect(isFrozenSnapshot(FRESH_ET, 'America/Chicago', NOW)).toBe(false);
    expect(isFrozenSnapshot(FRESH_ET, NY, new Date(NOW.getTime() + 60 * 60_000))).toBe(false);
  });

  test('a stamp in the future is never frozen', () => {
    expect(isFrozenSnapshot('Sep 25, 2026 01:31:00', NY, NOW)).toBe(false);
  });

  test('the DST fall-back repeated hour reads 60 minutes old and stays current', () => {
    // 01:30 EST on 2026-11-01 = 06:30Z; the stamp resolves to the EDT reading (05:30Z).
    expect(isFrozenSnapshot('Nov 1, 2026 1:30:00', NY, new Date('2026-11-01T06:30:00Z'))).toBe(false);
  });

  test('the snapshot observed on 2026-09-24 is frozen', () => {
    expect(isFrozenSnapshot(MONDAY_ET, NY, NOW)).toBe(true);
  });

  test('a missing stamp is not evidence of staleness', () => {
    expect(isFrozenSnapshot(undefined, NY, minutesBefore(0))).toBe(false);
  });
});

describe('isAllNotScheduled', () => {
  test('true when every ride and maze reads Not Scheduled, whatever shows say', () => {
    expect(isAllNotScheduled([
      {venueId: 1, details: [{status: 'Not Scheduled'}, {status: 'not scheduled'}]},
      {venueId: 3, details: [{status: 'Not Scheduled'}]},
      {venueId: 2, details: [{status: 'Opened'}]},
    ])).toBe(true);
  });

  test('false when any ride reads anything else', () => {
    expect(isAllNotScheduled([{venueId: 1, details: [{status: 'Not Scheduled'}, {status: 'Temp Closed'}]}])).toBe(false);
    expect(isAllNotScheduled([{venueId: 1, details: [{status: 'Not Scheduled'}, {}]}])).toBe(false);
  });

  test('false for a snapshot with no rides', () => {
    expect(isAllNotScheduled([{venueId: 2, details: [{status: 'Not Scheduled'}]}])).toBe(false);
    expect(isAllNotScheduled([])).toBe(false);
  });
});

describe('live data from a frozen feed', () => {
  test('publishes rides and shows when the snapshot is fresh', async () => {
    const live = await cedarPoint(FRESH_ET).liveForTest();
    const tt2 = live.find(l => l.id === 'RIDE-001-00325');

    expect(tt2?.status).toBe('OPERATING');
    expect(tt2?.queue?.STANDBY?.waitTime).toBe(60);
    expect(live.find(l => l.id === 'RIDE-001-00188')?.status).toBe('CLOSED');
    expect(idsOf(live)).toContain('SHOW-001-00010');
    expect(warn).not.toHaveBeenCalled();
  });

  test('withholds rides and shows when venue-status is frozen', async () => {
    const live = await cedarPoint(MONDAY_ET).liveForTest();

    expect(live).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('park 1 venue-status is frozen'));
  });

  test('keeps statuses but drops waits when only wait-times is frozen', async () => {
    const live = await cedarPoint(FRESH_ET, MONDAY_ET).liveForTest();
    const tt2 = live.find(l => l.id === 'RIDE-001-00325');

    expect(tt2?.status).toBe('OPERATING');
    expect(tt2?.queue?.STANDBY?.waitTime).toBeUndefined();
  });

  test('drops frozen waits even when venue-status carries no stamp', async () => {
    const live = await cedarPoint(undefined, MONDAY_ET).liveForTest();
    const tt2 = live.find(l => l.id === 'RIDE-001-00325');

    expect(tt2?.status).toBe('OPERATING');
    expect(tt2?.queue?.STANDBY?.waitTime).toBeUndefined();
  });

  test('still publishes when the feed carries no stamp', async () => {
    const live = await cedarPoint(undefined).liveForTest();

    expect(live.find(l => l.id === 'RIDE-001-00325')?.queue?.STANDBY?.waitTime).toBe(60);
  });

  test('publishes a stale snapshot whose rides all read Not Scheduled', async () => {
    const probe = new Probe();
    probe.venueStatus[CEDAR_POINT] = venueStatus(MONDAY_ET, '001', 'Not Scheduled');

    const live = await probe.liveForTest();

    expect(live.find(l => l.id === 'RIDE-001-00325')?.status).toBe('CLOSED');
    expect(warn).not.toHaveBeenCalled();
  });

  test('warns once, not every poll, about an unparseable stamp, and still publishes', async () => {
    const probe = cedarPoint('10:31:00 PM');

    const first = await probe.liveForTest();
    CacheLib.clearByClassName('Probe');
    await probe.liveForTest();

    expect(first.find(l => l.id === 'RIDE-001-00325')?.status).toBe('OPERATING');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not in the expected format'));
  });
});

describe('frozen-feed timezone handling', () => {
  test('reads a Pacific park in Pacific time, not the fallback', async () => {
    const probe = knotts();
    probe.venueStatus[KNOTTS] = venueStatus(FRESH_PT, '004');

    const live = await probe.liveForTest();

    // Read as UTC (the fallback) this stamp would be 7 hours old and withheld.
    expect(live.find(l => l.id === 'RIDE-004-00325')?.status).toBe('OPERATING');
    expect(warn).not.toHaveBeenCalled();
  });

  test('withholds a frozen Pacific park', async () => {
    const probe = knotts();
    probe.venueStatus[KNOTTS] = venueStatus(MONDAY_PT, '004');

    expect(await probe.liveForTest()).toEqual([]);
  });

  test('skips the check when the zone came from the fallback', async () => {
    // getPOI swallows fetch errors and caches []: the park has no coordinates.
    const probe = cedarPoint(MONDAY_ET);
    probe.poi = [];

    const live = await probe.liveForTest();

    expect(live.find(l => l.id === 'RIDE-001-00325')?.status).toBe('OPERATING');
    expect(warn).not.toHaveBeenCalled();
  });

  test('judges a water park on its own stamp', async () => {
    const probe = knotts();
    probe.venueStatus[KNOTTS] = venueStatus(FRESH_PT, '004');
    probe.venueStatus[SOAK_CITY] = venueStatus(MONDAY_PT, '201');

    const live = await probe.liveForTest();

    expect(live.some(l => String(l.id).includes('-004-'))).toBe(true);
    expect(live.some(l => String(l.id).includes('-201-'))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('park 201 venue-status is frozen'));
  });
});

describe('a frozen all-Not-Scheduled snapshot, judged against the park schedule', () => {
  // The frozen snapshot observed on 2026-09-24 was taken on a Monday the
  // park was shut, so every ride read "Not Scheduled". Publishing it showed
  // open parks as closed all day. The schedule tells an off-season park
  // (publish) from an open one (withhold).

  test('withholds when the schedule says the park is open today', async () => {
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = [day('09/24/2026', {open: '11:00', close: '22:00'})];

    expect(await probe.liveForTest()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('park 1 venue-status is frozen'));
  });

  test('withholds before opening time on an open day, not only during hours', async () => {
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z')); // 08:00 Eastern
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = [day('09/24/2026', {open: '11:00', close: '22:00'})];

    expect(await probe.liveForTest()).toEqual([]);
  });

  test('publishes CLOSED when the schedule says the park is closed today', async () => {
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = [day('09/24/2026', {closed: true})];

    const live = await probe.liveForTest();

    expect(live.find(l => l.id === 'RIDE-001-00325')?.status).toBe('CLOSED');
    expect(warn).not.toHaveBeenCalled();
  });

  test('a listed day with no park hours counts as closed', async () => {
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = [day('09/24/2026', {})];

    expect((await probe.liveForTest()).find(l => l.id === 'RIDE-001-00325')?.status).toBe('CLOSED');
  });

  test('publishes CLOSED when the schedule has no entry for today', async () => {
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = [day('09/23/2026', {open: '11:00', close: '22:00'})];

    expect((await probe.liveForTest()).find(l => l.id === 'RIDE-001-00325')?.status).toBe('CLOSED');
    expect(warn).not.toHaveBeenCalled();
  });

  test('publishes CLOSED when the schedule could not be fetched', async () => {
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = null;

    expect((await probe.liveForTest()).find(l => l.id === 'RIDE-001-00325')?.status).toBe('CLOSED');
  });

  test('another open day in the month does not count', async () => {
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = [
      day('09/24/2026', {closed: true}),
      day('09/25/2026', {open: '11:00', close: '22:00'}),
    ];

    expect((await probe.liveForTest()).find(l => l.id === 'RIDE-001-00325')?.status).toBe('CLOSED');
  });

  test('reads today in the park zone, not UTC', async () => {
    // 02:31Z on the 25th is still the evening of the 24th in Sandusky.
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = [
      day('09/24/2026', {open: '11:00', close: '22:00'}),
      day('09/25/2026', {closed: true}),
    ];

    expect(await probe.liveForTest()).toEqual([]);
  });

  test('asks for the park-local date at a month boundary', async () => {
    vi.setSystemTime(new Date('2026-10-01T02:00:00Z')); // 22:00 Eastern, Sep 30
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = [day('09/30/2026', {open: '11:00', close: '23:00'})];

    expect(await probe.liveForTest()).toEqual([]);
    expect(probe.hoursRequests[0]).toBe(`${CEDAR_POINT}:20260930`);
  });

  test('withholds after midnight while last night\'s hours are still running', async () => {
    vi.setSystemTime(new Date('2026-09-25T04:30:00Z')); // 00:30 Eastern on the 25th
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = [
      day('09/24/2026', {open: '11:00', close: '01:00'}),
      day('09/25/2026', {closed: true}),
    ];

    expect(await probe.liveForTest()).toEqual([]);
  });

  test('publishes CLOSED after midnight once last night\'s hours have ended', async () => {
    vi.setSystemTime(new Date('2026-09-25T05:30:00Z')); // 01:30 Eastern on the 25th
    const probe = frozenAllNotScheduled();
    probe.schedule[CEDAR_POINT] = [
      day('09/24/2026', {open: '11:00', close: '01:00'}),
      day('09/25/2026', {closed: true}),
    ];

    expect((await probe.liveForTest()).find(l => l.id === 'RIDE-001-00325')?.status).toBe('CLOSED');
  });

  test('withholds after midnight while last night\'s haunt event is still running', async () => {
    vi.setSystemTime(new Date('2026-09-25T08:00:00Z')); // 01:00 Pacific on the 25th
    const probe = knotts();
    probe.venueStatus[KNOTTS] = venueStatus(MONDAY_PT, '004', 'Not Scheduled');
    probe.schedule[KNOTTS] = [
      {...day('09/24/2026', {open: '10:00', close: '17:30'}),
        operatings: [
          {operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: '10:00', timeTo: '17:30'}]},
          {operatingTypeId: 25, operatingTypeName: 'Haunt', items: [{timeFrom: '19:00', timeTo: '02:00'}]},
        ]},
      day('09/25/2026', {closed: true}),
    ];

    const live = await probe.liveForTest();

    expect(live.some(l => String(l.id).includes('-004-'))).toBe(false);
  });

  test('never reads the schedule for a fresh snapshot', async () => {
    const probe = new Probe();
    probe.venueStatus[CEDAR_POINT] = venueStatus(FRESH_ET, '001', 'Not Scheduled');
    probe.schedule[CEDAR_POINT] = [day('09/24/2026', {open: '11:00', close: '22:00'})];

    const scheduleCheck = vi.spyOn(probe, 'scheduleSaysOpen');

    const live = await probe.liveForTest();

    expect(live.find(l => l.id === 'RIDE-001-00325')?.status).toBe('CLOSED');
    // The guard's schedule lookup must not run for a fresh snapshot. Assert on
    // the guard itself, not on request shapes: other live-build paths (such as
    // showtimes) may legitimately read the day's hours.
    expect(scheduleCheck).not.toHaveBeenCalled();
  });

  test('judges a water park on its own schedule', async () => {
    const probe = knotts();
    probe.venueStatus[KNOTTS] = venueStatus(MONDAY_PT, '004', 'Not Scheduled');
    probe.venueStatus[SOAK_CITY] = venueStatus(MONDAY_PT, '201', 'Not Scheduled');
    probe.schedule[KNOTTS] = [day('09/24/2026', {open: '10:00', close: '22:00'})];
    probe.schedule[SOAK_CITY] = [day('09/24/2026', {closed: true})];

    const live = await probe.liveForTest();

    expect(live.some(l => String(l.id).includes('-004-'))).toBe(false);
    expect(live.find(l => l.id === 'RIDE-201-00325')?.status).toBe('CLOSED');
  });
});
