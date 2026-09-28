import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {SixFlags} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';
import type {EntitySchedule, LiveData} from '@themeparks/typelib';

/**
 * The operating-hours month query (`date=YYYYMM`) only lists the days after
 * the vendor's "today". On 2026-09-28 `date=202609` returned the 29th and
 * 30th for every park, and a past month returns only its last day. The
 * single-day query (`date=YYYYMMDD`) answers for any day, today included.
 *
 * The fake vendor below reproduces that, with a configurable "today" so the
 * tests can also cover a vendor whose day has already rolled over while the
 * park's has not.
 */

const KNOTTS = 4;
const BUENA_PARK = {latitude: '33.84', longitude: '-118.00'};

type Day = {date: string; isParkClosed: boolean; venues: unknown[]; operatings: unknown[]; shows?: unknown[]};

function day(iso: string, opts: {closed?: boolean; open?: string; close?: string; shows?: unknown[]} = {}): Day {
  const {closed = false, open = '10:00', close = '18:00', shows} = opts;
  return {
    date: `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`,
    isParkClosed: closed,
    venues: [],
    operatings: closed ? [] : [{operatingTypeId: 24, operatingTypeName: 'Park', items: [{timeFrom: open, timeTo: close}]}],
    ...(shows ? {shows} : {}),
  };
}

/** Every day from `from` to `to` inclusive, open 10:00-18:00. */
function days(from: string, to: string): Day[] {
  const out: Day[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(day(d.toISOString().slice(0, 10)));
  }
  return out;
}

const toYmd = (mdy: string) => `${mdy.slice(6, 10)}${mdy.slice(0, 2)}${mdy.slice(3, 5)}`;

class Probe extends SixFlags {
  /** The vendor's published calendar. */
  public calendar: Day[] = days('2026-08-01', '2026-12-31');
  /** The vendor's own "today" (YYYYMMDD); month queries list only later days. */
  public vendorToday = '20260928';
  /** Query strings that fail, as a network error would. */
  public failing = new Set<string>();
  public requests: string[] = [];

  constructor() {
    // A fallback distinct from the fixture park's real zone, so a silent
    // fallback cannot pass for a correct lookup.
    super({config: {timezone: 'UTC', baseUrl: 'https://vendor.invalid'}});
  }

  override async getParkData(): Promise<any> {
    return [{parkId: KNOTTS, code: 'KB', name: "Knott's Berry Farm", waterParks: []}];
  }

  override async getPOI(): Promise<any> {
    return [{fimsId: 'RIDE-004-00172', name: 'GhostRider', parkId: KNOTTS, venueId: 1, location: BUENA_PARK}];
  }

  override async getVenueStatus(): Promise<any> {
    return {
      venues: [
        {venueId: 1, details: [{fimsId: 'RIDE-004-00172', status: 'Opened'}]},
        {venueId: 2, details: [
          {fimsId: 'SHOW-004-00010', status: 'Opened'},
          {fimsId: 'SHOW-004-00011', status: 'Opened'},
          {fimsId: 'SHOW-004-00012', status: 'Opened'},
        ]},
      ],
    };
  }

  override async getWaitTimes(): Promise<any> {
    return null;
  }

  /**
   * Stands in for the HTTP layer, below the cached getOperatingHours, so
   * the tests see what reaches the vendor and not what the cache answers.
   */
  override async fetchOperatingHours(_parkId: number, date: string): Promise<any> {
    this.requests.push(date);
    if (this.failing.has(date)) throw new Error(`fetch failed for ${date}`);
    let dates: Day[];
    if (date.length === 8) {
      dates = this.calendar.filter(d => toYmd(d.date) === date);
    } else {
      const inMonth = this.calendar.filter(d => toYmd(d.date).startsWith(date));
      const later = inMonth.filter(d => toYmd(d.date) > this.vendorToday);
      // A month wholly in the past answers with its last day only.
      dates = later.length > 0 ? later : inMonth.slice(-1);
    }
    return {json: async () => ({dates})};
  }

  public schedulesForTest(): Promise<EntitySchedule[]> {
    return this.getSchedules();
  }

  public liveForTest(): Promise<LiveData[]> {
    return this.getLiveData();
  }
}

const scheduleDates = (schedules: EntitySchedule[]) =>
  (schedules.find(s => s.id === 'sixflags_park_KB')?.schedule ?? [])
    .filter(e => e.type === 'OPERATING')
    .map(e => e.date);

const monthRequests = (probe: Probe) => probe.requests.filter(r => r.length === 6);
const dayRequests = (probe: Probe) => probe.requests.filter(r => r.length === 8);

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  // 12:00 Pacific on Monday 28 September.
  vi.setSystemTime(new Date('2026-09-28T19:00:00Z'));
  CacheLib.clearByClassName('Probe');
  CacheLib.clearByClassName('SixFlags');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('schedules when the month query leaves out today', () => {
  test('today is in the schedule', async () => {
    const probe = new Probe();

    const dates = scheduleDates(await probe.schedulesForTest());

    expect(dates).toContain('2026-09-28');
    expect(dates.slice(0, 3)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
  });

  test('keeps today\'s own hours from the single-day answer', async () => {
    const probe = new Probe();
    probe.calendar = probe.calendar.map(d =>
      d.date === '09/28/2026' ? day('2026-09-28', {open: '11:00', close: '20:00'}) : d);

    const schedule = (await probe.schedulesForTest())[0].schedule;
    const today = schedule.find(e => e.date === '2026-09-28');

    expect(today?.openingTime).toBe('2026-09-28T11:00:00-07:00');
    expect(today?.closingTime).toBe('2026-09-28T20:00:00-07:00');
  });

  test('a day both queries return appears once', async () => {
    // A month answer cached from yesterday still lists today.
    const probe = new Probe();
    probe.vendorToday = '20260927';

    const dates = scheduleDates(await probe.schedulesForTest());

    expect(dates.filter(d => d === '2026-09-28')).toHaveLength(1);
    expect(new Set(dates).size).toBe(dates.length);
  });

  test('does not ask for today on its own when the month answer already has it', async () => {
    const probe = new Probe();
    probe.vendorToday = '20260927';

    await probe.schedulesForTest();

    expect(dayRequests(probe)).toEqual([]);
  });

  test('a closed today stays out of the schedule', async () => {
    const probe = new Probe();
    probe.calendar = probe.calendar.map(d => d.date === '09/28/2026' ? day('2026-09-28', {closed: true}) : d);

    const dates = scheduleDates(await probe.schedulesForTest());

    expect(dates).not.toContain('2026-09-28');
    expect(dates[0]).toBe('2026-09-29');
  });

  test('today survives a failed month query', async () => {
    const probe = new Probe();
    probe.failing.add('202609');

    const dates = scheduleDates(await probe.schedulesForTest());

    // Today and tomorrow come from single-day queries; the rest of the
    // month is lost with the month answer.
    expect(dates.slice(0, 3)).toEqual(['2026-09-28', '2026-09-29', '2026-10-01']);
  });

  test('the month answer survives a failed single-day query', async () => {
    const probe = new Probe();
    probe.failing.add('20260928');

    const dates = scheduleDates(await probe.schedulesForTest());

    expect(dates.slice(0, 2)).toEqual(['2026-09-29', '2026-09-30']);
  });

  test('fills tomorrow too when the vendor\'s day has already rolled over', async () => {
    // 18:00 Pacific on the 28th is 01:00 UTC on the 29th. A vendor counting
    // days in UTC would leave the 29th out of the month answer as well.
    vi.setSystemTime(new Date('2026-09-29T01:00:00Z'));
    const probe = new Probe();
    probe.vendorToday = '20260929';

    const dates = scheduleDates(await probe.schedulesForTest());

    expect(dates.slice(0, 3)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30']);
  });
});

describe('the months follow the park\'s calendar, not the machine clock', () => {
  // 23:30 Pacific on Wednesday 30 September is 06:30 UTC on 1 October.
  const LAST_NIGHT_OF_SEPTEMBER = new Date('2026-10-01T06:30:00Z');

  test('asks for the park-local month and the two after it', async () => {
    vi.setSystemTime(LAST_NIGHT_OF_SEPTEMBER);
    const probe = new Probe();
    probe.vendorToday = '20261001';

    await probe.schedulesForTest();

    expect(monthRequests(probe)).toEqual(['202609', '202610', '202611']);
  });

  test('the last day of the month is in the schedule, and so is tomorrow', async () => {
    vi.setSystemTime(LAST_NIGHT_OF_SEPTEMBER);
    const probe = new Probe();
    probe.vendorToday = '20261001';

    const dates = scheduleDates(await probe.schedulesForTest());

    expect(dates.slice(0, 3)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

describe('showtimes when the month query leaves out today', () => {
  const shows = [
    {fimsId: 'SHOW-004-00010', items: [{times: '02:00 PM, 05:15 PM'}]},
    {fimsId: 'SHOW-004-00011', items: [{times: '11:30 AM'}]},
  ];

  const showtimesOf = (live: LiveData[], id: string) =>
    ((live.find(l => l.id === id) as any)?.showtimes ?? []).map((s: {startTime: string}) => s.startTime);

  test('today\'s showtimes are published', async () => {
    const probe = new Probe();
    probe.calendar = probe.calendar.map(d => d.date === '09/28/2026' ? day('2026-09-28', {shows}) : d);

    const live = await probe.liveForTest();

    expect(showtimesOf(live, 'SHOW-004-00010')).toEqual(['2026-09-28T14:00:00-07:00', '2026-09-28T17:15:00-07:00']);
    expect(showtimesOf(live, 'SHOW-004-00011')).toEqual(['2026-09-28T11:30:00-07:00']);
  });

  test('reads the park-local day at 23:30 on the last night of the month', async () => {
    vi.setSystemTime(new Date('2026-10-01T06:30:00Z'));
    const probe = new Probe();
    probe.vendorToday = '20261001';
    probe.calendar = probe.calendar.map(d => {
      if (d.date === '09/30/2026') return day('2026-09-30', {shows: [{fimsId: 'SHOW-004-00010', items: [{times: '11:00 PM'}]}]});
      if (d.date === '10/01/2026') return day('2026-10-01', {shows: [{fimsId: 'SHOW-004-00010', items: [{times: '01:00 PM'}]}]});
      return d;
    });

    const live = await probe.liveForTest();

    expect(showtimesOf(live, 'SHOW-004-00010')).toEqual(['2026-09-30T23:00:00-07:00']);
  });

  test('one request per park, not per show, and none again while cached', async () => {
    const probe = new Probe();
    probe.calendar = probe.calendar.map(d => d.date === '09/28/2026' ? day('2026-09-28', {shows}) : d);

    await probe.liveForTest();
    expect(probe.requests).toEqual(['20260928']);

    await probe.liveForTest();
    expect(probe.requests).toEqual(['20260928']);
  });

  test('schedules and showtimes share the one single-day request', async () => {
    const probe = new Probe();

    await probe.liveForTest();
    await probe.schedulesForTest();

    expect(dayRequests(probe)).toEqual(['20260928']);
  });
});
