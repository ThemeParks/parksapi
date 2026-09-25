import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {SixFlags, parseParkDateTime, isFrozenSnapshot} from '../sixflags.js';
import {CacheLib} from '../../../cache.js';
import type {LiveData} from '@themeparks/typelib';

/**
 * An API host that stops refreshing keeps answering 200 with its last
 * snapshot. The only tell is the park-local `parkDateTime` stamp both live
 * feeds carry. Observed 2026-09-24: every park served a snapshot stamped
 * "Sep 21, 2026 13:03:00" for three and a half days, so Cedar Point opened
 * for the evening with every ride reading "Not Scheduled" and the module
 * published all of them as CLOSED.
 */

const CEDAR_POINT = 1;
const NY = 'America/New_York';

/** 2026-09-24 22:31 Eastern, while Cedar Point was open. */
const NOW = new Date('2026-09-25T02:31:30Z');

class Probe extends SixFlags {
  public venueStatus: unknown = {venues: []};
  public waitTimes: unknown = {venues: []};

  override async getParkData(): Promise<any> {
    return [{parkId: CEDAR_POINT, code: 'CP', name: 'Cedar Point', waterParks: []}];
  }

  override async getPOI(): Promise<any> {
    // Sandusky, Ohio: drives the timezone lookup to America/New_York.
    return [{fimsId: 'RIDE-001-00325', name: 'Top Thrill 2', parkId: CEDAR_POINT, venueId: 1, location: {latitude: '41.48', longitude: '-82.68'}}];
  }

  override async getVenueStatus(): Promise<any> {
    return this.venueStatus;
  }

  override async getWaitTimes(): Promise<any> {
    return this.waitTimes;
  }

  override async getOperatingHours(): Promise<any> {
    return {dates: []};
  }

  public liveForTest(): Promise<LiveData[]> {
    return this.getLiveData();
  }
}

function feeds(stamp: string | undefined, waitStamp: string | undefined = stamp) {
  return {
    venueStatus: {
      ...(stamp !== undefined ? {parkDateTime: stamp} : {}),
      venues: [{venueId: 1, details: [
        {fimsId: 'RIDE-001-00325', status: 'Opened'},
        {fimsId: 'RIDE-001-00188', status: 'Not Scheduled'},
      ]}],
    },
    waitTimes: {
      ...(waitStamp !== undefined ? {parkDateTime: waitStamp} : {}),
      venues: [{venueId: 1, details: [
        {fimsId: 'RIDE-001-00325', regularWaittime: {waitTime: 60}},
      ]}],
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(NOW);
  CacheLib.clearByClassName('Probe');
  CacheLib.clearByClassName('SixFlags');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseParkDateTime', () => {
  test('reads the vendor stamp as park-local wall clock', () => {
    expect(parseParkDateTime('Sep 24, 2026 22:31:00', NY)).toBe(Date.parse('2026-09-25T02:31:00Z'));
  });

  test('handles a single-digit day and hour', () => {
    expect(parseParkDateTime('Oct 4, 2026 9:05:00', NY)).toBe(Date.parse('2026-10-04T13:05:00Z'));
  });

  test.each([undefined, null, '', 'yesterday', '2026-09-24T22:31:00', 'Foo 24, 2026 22:31:00', 42])(
    'returns null for %j',
    (value) => {
      expect(parseParkDateTime(value, NY)).toBeNull();
    },
  );
});

describe('isFrozenSnapshot', () => {
  test('a stamp from this minute is current', () => {
    expect(isFrozenSnapshot('Sep 24, 2026 22:31:00', NY, NOW)).toBe(false);
  });

  test('a stamp inside the 30 minute allowance is current', () => {
    expect(isFrozenSnapshot('Sep 24, 2026 22:02:00', NY, NOW)).toBe(false);
  });

  test('a stamp past the allowance is frozen', () => {
    expect(isFrozenSnapshot('Sep 24, 2026 22:00:00', NY, NOW)).toBe(true);
  });

  test('the snapshot observed on 2026-09-24 is frozen', () => {
    expect(isFrozenSnapshot('Sep 21, 2026 13:03:00', NY, NOW)).toBe(true);
  });

  test('a missing stamp is not evidence of staleness', () => {
    expect(isFrozenSnapshot(undefined, NY, NOW)).toBe(false);
  });
});

describe('live data from a frozen feed', () => {
  test('publishes current statuses when the snapshot is fresh', async () => {
    const probe = new Probe();
    Object.assign(probe, feeds('Sep 24, 2026 22:31:00'));

    const live = await probe.liveForTest();
    const tt2 = live.find(l => l.id === 'RIDE-001-00325');

    expect(tt2?.status).toBe('OPERATING');
    expect(tt2?.queue?.STANDBY?.waitTime).toBe(60);
    expect(live.find(l => l.id === 'RIDE-001-00188')?.status).toBe('CLOSED');
  });

  test('withholds the whole park when venue-status is frozen', async () => {
    const probe = new Probe();
    Object.assign(probe, feeds('Sep 21, 2026 13:03:00'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const live = await probe.liveForTest();

    expect(live.filter(l => String(l.id).startsWith('RIDE-001-'))).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('frozen'));
    warn.mockRestore();
  });

  test('keeps statuses but drops waits when only wait-times is frozen', async () => {
    const probe = new Probe();
    Object.assign(probe, feeds('Sep 24, 2026 22:31:00', 'Sep 21, 2026 13:02:00'));

    const live = await probe.liveForTest();
    const tt2 = live.find(l => l.id === 'RIDE-001-00325');

    expect(tt2?.status).toBe('OPERATING');
    expect(tt2?.queue?.STANDBY?.waitTime).toBeUndefined();
  });

  test('still publishes when the feed carries no stamp', async () => {
    const probe = new Probe();
    Object.assign(probe, feeds(undefined));

    const live = await probe.liveForTest();

    expect(live.find(l => l.id === 'RIDE-001-00325')?.status).toBe('OPERATING');
  });
});
