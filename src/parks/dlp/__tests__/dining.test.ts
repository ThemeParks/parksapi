import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';

/**
 * Restaurants have no live feed, so their status is derived from today's
 * published window. Anything Disney gives no hours for stays absent instead of
 * being reported as closed all day.
 */
const TZ_OFFSET = '+02:00';

function stubbedPark(hours: unknown, date: string): DisneylandParis {
  const park = new DisneylandParis();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark'}],
    Restaurant: [{
      id: 'P1RR01',
      name: 'Casa de Coco',
      type: 'Restaurant',
      location: {id: 'P1'},
      schedules: hours === undefined ? undefined : [{date, ...(hours as object)}],
    }],
  });
  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue([]);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
  vi.spyOn(park as any, 'getScheduleForDate').mockResolvedValue([]);

  return park;
}

/** Today in the park's timezone, as the park code computes it. */
function parkToday(): string {
  const [mm, dd, yy] = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris', month: '2-digit', day: '2-digit', year: 'numeric',
  }).format(new Date()).split('/');
  return `${yy}-${mm}-${dd}`;
}

async function statusAt(clock: string, hours: unknown): Promise<string | undefined> {
  const date = parkToday();
  vi.setSystemTime(new Date(`${date}T${clock}${TZ_OFFSET}`));
  const live = await stubbedPark(hours, date).getLiveData();
  return live.find((l) => l.id === 'P1RR01')?.status;
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

  it('emits no row when no hours are published', async () => {
    expect(await statusAt('13:00:00', undefined)).toBeUndefined();
  });

  it('emits no row when the window has no times', async () => {
    expect(await statusAt('13:00:00', {status: 'OPERATING'})).toBeUndefined();
  });

  it('survives a malformed time instead of failing the whole build', async () => {
    expect(await statusAt('13:00:00', {
      startTime: 'abc', endTime: 'xyz', status: 'OPERATING',
    })).toBe('CLOSED');
  });

  it('rejects a single-digit hour rather than truncating it', async () => {
    // '9:30:00' sliced to HH:MM yields '9:30:', which is not a parseable time.
    expect(await statusAt('13:00:00', {
      startTime: '9:30:00', endTime: '20:00:00', status: 'OPERATING',
    })).toBe('CLOSED');
  });

  it('ignores hours published for another day', async () => {
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T13:00:00${TZ_OFFSET}`));
    const park = stubbedPark(operating, '2020-01-01');
    const live = await park.getLiveData();
    expect(live.find((l) => l.id === 'P1RR01')).toBeUndefined();
  });

  it('publishes today\'s window under operatingHours', async () => {
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T13:00:00${TZ_OFFSET}`));
    const live = await stubbedPark(operating, date).getLiveData();

    expect(live.find((l) => l.id === 'P1RR01')?.operatingHours).toEqual([{
      type: 'OPERATING',
      startTime: `${date}T11:00:00${TZ_OFFSET}`,
      endTime: `${date}T21:30:00${TZ_OFFSET}`,
    }]);
  });

  it('still publishes the window outside opening hours', async () => {
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T23:30:00${TZ_OFFSET}`));
    const live = await stubbedPark(operating, date).getLiveData();
    const entry = live.find((l) => l.id === 'P1RR01');

    expect(entry?.status).toBe('CLOSED');
    expect(entry?.operatingHours).toHaveLength(1);
  });

  it('omits operatingHours for a refurbishment', async () => {
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T13:00:00${TZ_OFFSET}`));
    const live = await stubbedPark({
      startTime: '00:00:00', endTime: '23:59:00', status: 'REFURBISHMENT', closed: true,
    }, date).getLiveData();

    expect(live.find((l) => l.id === 'P1RR01')?.operatingHours).toBeUndefined();
  });

  it('does not attach a queue to dining', async () => {
    const date = parkToday();
    vi.setSystemTime(new Date(`${date}T13:00:00${TZ_OFFSET}`));
    const live = await stubbedPark(operating, date).getLiveData();
    expect(live.find((l) => l.id === 'P1RR01')?.queue).toBeUndefined();
  });
});
