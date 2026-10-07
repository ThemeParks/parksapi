import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';
import {CacheLib} from '../../../cache.js';

/**
 * The schedule window is a run of Paris calendar dates, one request to the
 * schedule feed each. It has two loops: the sweep behind the meet & greet gate
 * and buildSchedules. Both must step the Paris date itself. Stepping the
 * instant (`addDays(now, i)` is `setDate()` in the host's zone) adds exactly 24
 * hours on a UTC host, and across a Paris clock change that lands on the same
 * Paris date twice, or skips one.
 *
 * A host whose zone changes its clocks with Paris (London, Berlin) never shows
 * it, so these run with the host zone forced to UTC.
 */

const PARIS = 'Europe/Paris';

/** Paris puts its clocks back at 03:00 on 2026-10-25 and forward at 02:00 on 2026-03-29. */
const CLOCKS_BACK = '2026-10-25T01:00:00Z';
const CLOCKS_FORWARD = '2026-03-29T01:00:00Z';

const POI = {
  ThemePark: [{id: 'P1', name: 'Disneyland Park', type: 'ThemePark', location: {id: 'P1'}}],
  Entertainment: [],
};
const PARK_HOURS = {id: 'P1', schedules: [{startTime: '09:30:00', endTime: '22:00:00', status: 'OPERATING'}]};

function parkWithWindow(days: number): {park: DisneylandParis; asked: string[]} {
  const park = new DisneylandParis({config: {scheduleDays: String(days)}});
  vi.spyOn(park as any, 'getPOIData').mockResolvedValue(POI);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
  const asked: string[] = [];
  vi.spyOn(park as any, 'getScheduleForDate').mockImplementation(async (date: unknown) => {
    asked.push(String(date));
    return [PARK_HOURS];
  });
  return {park, asked};
}

/** The dates the meet & greet sweep asks the feed for, in order, repeats kept. */
async function sweptDates(days: number): Promise<string[]> {
  const {park, asked} = parkWithWindow(days);
  await (park as any).getScheduledActivityIds();
  return asked;
}

/** The dates buildSchedules publishes for the park, in order, repeats kept. */
async function publishedDates(days: number): Promise<string[]> {
  const {park} = parkWithWindow(days);
  const schedules = await park.getSchedules();
  return schedules.find((s) => s.id === 'P1')?.schedule.map((day) => day.date) ?? [];
}

/**
 * The Paris dates a window of `days` starting at `now` must have, worked out
 * from Intl and UTC calendar arithmetic alone so that it does not share a
 * helper with the code under test.
 */
function expectedWindow(now: Date, days: number): string[] {
  const parts = new Intl.DateTimeFormat('en-GB', {timeZone: PARIS, year: 'numeric', month: 'numeric', day: 'numeric'})
    .formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return Array.from({length: days}, (_, i) =>
    new Date(Date.UTC(part('year'), part('month') - 1, part('day') + i)).toISOString().slice(0, 10));
}

describe('DLP schedule window across a Paris clock change, on a UTC host', () => {
  let hostZone: string | undefined;

  beforeEach(() => {
    hostZone = process.env.TZ;
    process.env.TZ = 'UTC';
    // A run that is not really in UTC would pass for the wrong reason. Checked
    // in winter and in summer: London reads 0 in winter, and a worker thread
    // does not take a TZ set at run time.
    expect(new Date(2026, 0, 15, 12).getTimezoneOffset()).toBe(0);
    expect(new Date(2026, 6, 15, 12).getTimezoneOffset()).toBe(0);
    vi.useFakeTimers({toFake: ['Date']});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    CacheLib.clearAll();
    if (hostZone === undefined) delete process.env.TZ;
    else process.env.TZ = hostZone;
  });

  it.each([
    {
      name: '00:30 Paris on the night the clocks go back',
      now: '2026-10-24T22:30:00Z',
      window: ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'],
    },
    {
      name: '23:30 Paris on the evening before the clocks go forward',
      now: '2026-03-28T22:30:00Z',
      window: ['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31'],
    },
  ])('has no repeated or missing date at $name', async ({now, window}) => {
    vi.setSystemTime(new Date(now));

    expect(await sweptDates(4)).toEqual(window);
    CacheLib.clearAll();
    expect(await publishedDates(4)).toEqual(window);
  });

  it('stays one date per day at every hour either side of both clock changes', async () => {
    const HOUR = 3600_000;
    for (const change of [CLOCKS_BACK, CLOCKS_FORWARD]) {
      for (let offset = -30; offset <= 30; offset++) {
        const now = new Date(Date.parse(change) + offset * HOUR);
        vi.setSystemTime(now);
        CacheLib.clearAll();

        const expected = expectedWindow(now, 5);
        expect(await sweptDates(5), `sweep at ${now.toISOString()}`).toEqual(expected);
        CacheLib.clearAll();
        expect(await publishedDates(5), `schedules at ${now.toISOString()}`).toEqual(expected);
      }
    }
  });
});
