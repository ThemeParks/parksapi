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

  override async getOperatingHours(): Promise<any> {
    return {dates: []};
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
