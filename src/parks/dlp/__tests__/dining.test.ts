import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';
import {constructDateTime} from '../../../datetime.js';

/**
 * Restaurants have no live feed, so their status is derived from today's
 * window in the activity-schedule feed (the POI blob's schedules only carry
 * the fetch day, so they go stale at midnight). Anything Disney gives no
 * hours for stays absent instead of being reported as closed all day.
 */

/** Today in the park's timezone, as the park code computes it. */
function parkToday(): string {
  const [mm, dd, yy] = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris', month: '2-digit', day: '2-digit', year: 'numeric',
  }).format(new Date()).split('/');
  return `${yy}-${mm}-${dd}`;
}

/** The park's UTC offset for a date, derived rather than hardcoded so the
 * suite survives DST transitions. */
function tzOffset(date: string): string {
  return constructDateTime(date, '12:00:00', 'Europe/Paris').slice(19);
}

function stubbedPark(
  hours: unknown,
  date: string,
  {poiSchedules}: {poiSchedules?: unknown} = {},
): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Restaurant: [{
      id: 'P1RR01',
      name: 'Casa de Coco',
      type: 'Restaurant',
      location: {id: 'P1'},
      schedules: poiSchedules,
    }],
  });
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue([]);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
  vi.spyOn(park as any, 'getScheduleForDate').mockResolvedValue(
    hours === undefined ? [] : [{id: 'P1RR01', schedules: [{date, ...(hours as object)}]}],
  );

  return park;
}

async function rowAt(clock: string, hours: unknown): Promise<any> {
  const date = parkToday();
  vi.setSystemTime(new Date(`${date}T${clock}${tzOffset(date)}`));
  const live = await stubbedPark(hours, date).getLiveData();
  return live.find((l) => l.id === 'P1RR01');
}

async function statusAt(clock: string, hours: unknown): Promise<string | undefined> {
  return (await rowAt(clock, hours))?.status;
}

describe('DLP dining hours', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const operating = {startTime: '11:00:00', endTime: '21:30:00', status: 'OPERATING'};

  it('reports OPERATING inside the published window', async () => {
    expect(await statusAt('13:00:00', operating)).toBe('OPERATING');
  });

  it('reports CLOSED before opening', async () => {
    expect(await statusAt('09:00:00', operating)).toBe('CLOSED');
  });

  it('reports CLOSED after closing', async () => {
    expect(await statusAt('23:30:00', operating)).toBe('CLOSED');
  });

  it('treats the window as half-open: opening minute in, closing minute out', async () => {
    expect(await statusAt('11:00:00', operating)).toBe('OPERATING');
    expect(await statusAt('21:30:00', operating)).toBe('CLOSED');
  });

  it('publishes dining even when the POI blob has no row for today', async () => {
    // After local midnight the 12h-cached POI blob only carries yesterday.
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T13:00:00${tzOffset(date)}`));
    const park = stubbedPark(operating, date, {
      poiSchedules: [{date: '2020-01-01', ...operating}],
    });
    const live = await park.getLiveData();
    expect(live.find((l) => l.id === 'P1RR01')?.status).toBe('OPERATING');
  });

  it('reports REFURBISHMENT for a multi-day closure', async () => {
    expect(await statusAt('13:00:00', {
      startTime: '00:00:00', endTime: '23:59:00', status: 'REFURBISHMENT', closed: true,
    })).toBe('REFURBISHMENT');
  });

  it('reports REFURBISHMENT regardless of the time of day', async () => {
    const hours = {startTime: '00:00:00', endTime: '23:59:00', status: 'REFURBISHMENT', closed: true};
    expect(await statusAt('03:00:00', hours)).toBe('REFURBISHMENT');
    expect(await statusAt('23:30:00', hours)).toBe('REFURBISHMENT');
  });

  it('reports CLOSED for a status token it does not recognise', async () => {
    expect(await statusAt('13:00:00', {...operating, status: 'DOWN'})).toBe('CLOSED');
    expect(await statusAt('13:00:00', {...operating, status: 'SOMETHING_NEW'})).toBe('CLOSED');
  });

  it('reports CLOSED for an OPERATING row flagged closed', async () => {
    expect(await statusAt('13:00:00', {...operating, closed: true})).toBe('CLOSED');
  });

  it('emits no row when no hours are published', async () => {
    expect(await statusAt('13:00:00', undefined)).toBeUndefined();
  });

  it('emits no row when the window has no times', async () => {
    expect(await statusAt('13:00:00', {status: 'OPERATING'})).toBeUndefined();
  });

  it.each([
    ['not times at all', {startTime: 'abc', endTime: 'xyz'}],
    ['a single-digit hour', {startTime: '9:30:00', endTime: '20:00:00'}],
    ['an out-of-range hour', {startTime: '25:00:00', endTime: '26:00:00'}],
    ['out-of-range everything', {startTime: '99:99:99', endTime: '99:99:99'}],
    ['an out-of-range minute', {startTime: '12:60:00', endTime: '20:00:00'}],
  ])('survives %s instead of failing the whole build', async (_label, times) => {
    const row = await rowAt('13:00:00', {...times, status: 'OPERATING'});
    expect(row).toBeDefined();
    expect(row.status).toBe('CLOSED');
    expect(row.operatingHours).toBeUndefined();
  });

  it('accepts a 24:00 midnight close', async () => {
    const hours = {startTime: '11:00:00', endTime: '24:00:00', status: 'OPERATING'};
    expect(await statusAt('23:30:00', hours)).toBe('OPERATING');
  });

  it('rolls a past-midnight close into the next day', async () => {
    const hours = {startTime: '19:00:00', endTime: '01:00:00', status: 'OPERATING'};
    expect(await statusAt('23:30:00', hours)).toBe('OPERATING');
    expect(await statusAt('13:00:00', hours)).toBe('CLOSED');
  });

  it('rolls the midnight crossing forward whatever timezone the host runs in', async () => {
    // `new Date(`${todayStr}T00:00:00`)` parses in the host's zone, so
    // "add a day, reformat in Europe/Paris" silently fails to advance on
    // any host east of Paris — Pacific/Kiritimati (UTC+14) is the sharpest
    // case. shiftDateString (already used a few lines up for the
    // walkthrough path) anchors at noon UTC instead, so no offset can push
    // it across a date boundary.
    const hours = {startTime: '19:00:00', endTime: '01:00:00', status: 'OPERATING'};
    const original = process.env.TZ;
    try {
      for (const tz of ['UTC', 'Pacific/Kiritimati', 'Pacific/Auckland', 'Asia/Tokyo', 'America/Los_Angeles']) {
        process.env.TZ = tz;
        expect(await statusAt('23:30:00', hours), tz).toBe('OPERATING');
        expect(await statusAt('13:00:00', hours), tz).toBe('CLOSED');
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('ignores hours published for another day', async () => {
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T13:00:00${tzOffset(date)}`));
    const park = stubbedPark(operating, '2020-01-01');
    const live = await park.getLiveData();
    expect(live.find((l) => l.id === 'P1RR01')).toBeUndefined();
  });

  it('publishes today\'s window under operatingHours', async () => {
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T13:00:00${tzOffset(date)}`));
    const live = await stubbedPark(operating, date).getLiveData();

    expect(live.find((l) => l.id === 'P1RR01')?.operatingHours).toEqual([{
      type: 'OPERATING',
      startTime: `${date}T11:00:00${tzOffset(date)}`,
      endTime: `${date}T21:30:00${tzOffset(date)}`,
    }]);
  });

  it('still publishes the window outside opening hours', async () => {
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T23:30:00${tzOffset(date)}`));
    const live = await stubbedPark(operating, date).getLiveData();
    const entry = live.find((l) => l.id === 'P1RR01');

    expect(entry?.status).toBe('CLOSED');
    expect(entry?.operatingHours).toHaveLength(1);
  });

  it('omits operatingHours for a refurbishment', async () => {
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T13:00:00${tzOffset(date)}`));
    const live = await stubbedPark({
      startTime: '00:00:00', endTime: '23:59:00', status: 'REFURBISHMENT', closed: true,
    }, date).getLiveData();
    const entry = live.find((l) => l.id === 'P1RR01');

    expect(entry).toBeDefined();
    expect(entry?.operatingHours).toBeUndefined();
  });

  it('does not attach a queue to dining', async () => {
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T13:00:00${tzOffset(date)}`));
    const live = await stubbedPark(operating, date).getLiveData();
    const entry = live.find((l) => l.id === 'P1RR01');

    expect(entry).toBeDefined();
    expect(entry?.queue).toBeUndefined();
  });
});
