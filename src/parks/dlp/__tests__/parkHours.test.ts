import {describe, it, expect, vi, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';
import {CacheLib} from '../../../cache.js';
import {formatInTimezone} from '../../../datetime.js';

/**
 * Walkthrough attractions (Discovery Arcade, Sleeping Beauty Castle, …) never
 * appear in the wait feed, so their live status falls back to park hours.
 *
 * Those hours come from each park's own row in the schedule feed. They used to
 * be derived from the attraction estate — earliest start and latest end across
 * queue-bearing rides — which one outlying ride could move by hours, which
 * conflated P1 and P2 into a single window, and which read POI schedules that
 * only ever carry the date they were fetched.
 */
const TZ = 'Europe/Paris';

function parkToday(): string {
  const [mm, dd, yyyy] = formatInTimezone(new Date(), TZ, 'date').split('/');
  return `${yyyy}-${mm}-${dd}`;
}

/** A time `offsetMinutes` from now, in the park's wall clock, as `HH:MM:SS`. */
function parkClock(offsetMinutes: number): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  return formatInTimezone(at, TZ, 'iso').slice(11, 19);
}

/**
 * A park with one walkthrough attraction that publishes no schedule of its
 * own, so it can only resolve through the park-hours fallback.
 */
function stubbedPark(opts: {
  parkSchedules?: any[];
  walkthroughPark?: string;
  extraAttractions?: any[];
  waitTimes?: any[];
}): DisneylandParis {
  const park = new DisneylandParis();
  const today = parkToday();

  vi.spyOn(park as any, 'getPOIData').mockResolvedValue({
    ThemePark: [
      {id: 'P1', name: 'Disneyland Park', type: 'ThemePark'},
      {id: 'P2', name: 'Disney Adventure World', type: 'ThemePark'},
    ],
    Attraction: [
      {
        id: 'P1MA00',
        name: 'Discovery Arcade',
        type: 'Attraction',
        location: {id: opts.walkthroughPark ?? 'P1'},
        // No `schedules` — this is the whole point: it must fall back.
      },
      ...(opts.extraAttractions ?? []),
    ],
  });

  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue(opts.waitTimes ?? []);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
  vi.spyOn(park as any, 'getScheduleForDate').mockResolvedValue(
    (opts.parkSchedules ?? []).map((s) => ({
      ...s,
      schedules: s.schedules.map((r: any) => ({...r, date: today})),
    })),
  );

  return park;
}

async function walkthroughStatus(park: DisneylandParis): Promise<string | undefined> {
  const live = await park.getLiveData();
  return live.find((l) => l.id === 'P1MA00')?.status;
}

/** A park row that is open right now, from 90 minutes ago to 90 minutes ahead. */
function openNow(id: string) {
  return {
    id,
    name: id,
    schedules: [
      {startTime: parkClock(-90), endTime: parkClock(90), status: 'OPERATING', closed: false},
    ],
  };
}

/** A park row whose operating window has already ended. */
function closedNow(id: string) {
  return {
    id,
    name: id,
    schedules: [
      {startTime: parkClock(-180), endTime: parkClock(-120), status: 'OPERATING', closed: false},
    ],
  };
}

describe('DLP park-hours fallback for walkthroughs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('DisneylandParis');
  });

  it('reports OPERATING inside its own park\'s published window', async () => {
    const park = stubbedPark({parkSchedules: [openNow('P1'), closedNow('P2')]});
    expect(await walkthroughStatus(park)).toBe('OPERATING');
  });

  it('reports CLOSED outside its own park\'s published window', async () => {
    const park = stubbedPark({parkSchedules: [closedNow('P1'), openNow('P2')]});
    expect(await walkthroughStatus(park)).toBe('CLOSED');
  });

  it('does not borrow the other park\'s hours', async () => {
    // P2 is open, P1 is shut. A walkthrough in P1 must not read OPERATING.
    const park = stubbedPark({
      parkSchedules: [closedNow('P1'), openNow('P2')],
      walkthroughPark: 'P1',
    });
    expect(await walkthroughStatus(park)).toBe('CLOSED');

    // …and the mirror case, so this isn't just "always CLOSED".
    const other = stubbedPark({
      parkSchedules: [closedNow('P1'), openNow('P2')],
      walkthroughPark: 'P2',
    });
    expect(await walkthroughStatus(other)).toBe('OPERATING');
  });

  it('ignores a queue-bearing ride that runs past park close', async () => {
    // The regression this fixes: park close was the latest endTime across
    // queue-bearing rides, so one ride publishing 23:59 kept every walkthrough
    // OPERATING long after the park shut. The station below is exactly that
    // shape, and the park's own row says it closed two hours ago.
    const park = stubbedPark({
      parkSchedules: [closedNow('P1')],
      extraAttractions: [
        {
          id: 'P1DA10',
          name: 'Disneyland Railroad Discoveryland Station',
          type: 'Attraction',
          location: {id: 'P1'},
          schedules: [
            {
              date: parkToday(),
              startTime: '00:00:00',
              endTime: '23:59:00',
              status: 'OPERATING',
              closed: false,
            },
          ],
        },
      ],
      // Present in the wait feed, so it counts as queue-bearing.
      waitTimes: [{entityId: 'P1DA10', type: 'Attraction', status: 'OPERATING', postedWaitMinutes: '5'}],
    });
    expect(await walkthroughStatus(park)).toBe('CLOSED');
  });

  it('ignores a queue-bearing ride that opens before the park', async () => {
    // Mirror of the above on the open side: an 08:13 ride start used to become
    // park open, so walkthroughs read OPERATING before guests could get in.
    const park = stubbedPark({
      parkSchedules: [
        {
          id: 'P1',
          name: 'P1',
          schedules: [
            {startTime: parkClock(60), endTime: parkClock(180), status: 'OPERATING', closed: false},
          ],
        },
      ],
      extraAttractions: [
        {
          id: 'P1RA00',
          name: 'Big Thunder Mountain',
          type: 'Attraction',
          location: {id: 'P1'},
          schedules: [
            {
              date: parkToday(),
              startTime: parkClock(-60),
              endTime: parkClock(180),
              status: 'OPERATING',
              closed: false,
            },
          ],
        },
      ],
      waitTimes: [{entityId: 'P1RA00', type: 'Attraction', status: 'OPERATING', postedWaitMinutes: '5'}],
    });
    expect(await walkthroughStatus(park)).toBe('CLOSED');
  });

  it('reports CLOSED rather than throwing when the park publishes no hours', async () => {
    const park = stubbedPark({parkSchedules: []});
    expect(await walkthroughStatus(park)).toBe('CLOSED');
  });

  it('ignores a closed-flagged park row', async () => {
    const park = stubbedPark({
      parkSchedules: [
        {
          id: 'P1',
          name: 'P1',
          schedules: [
            {startTime: parkClock(-90), endTime: parkClock(90), status: 'OPERATING', closed: true},
          ],
        },
      ],
    });
    expect(await walkthroughStatus(park)).toBe('CLOSED');
  });

  it('ignores EXTRA_MAGIC_HOURS when choosing the window', async () => {
    // EMH is a hotel-guest preview, not general park opening.
    const park = stubbedPark({
      parkSchedules: [
        {
          id: 'P1',
          name: 'P1',
          schedules: [
            {startTime: parkClock(-30), endTime: parkClock(30), status: 'EXTRA_MAGIC_HOURS', closed: false},
            {startTime: parkClock(-180), endTime: parkClock(-120), status: 'OPERATING', closed: false},
          ],
        },
      ],
    });
    expect(await walkthroughStatus(park)).toBe('CLOSED');
  });

  it('survives a schedule-feed failure', async () => {
    const park = stubbedPark({parkSchedules: []});
    vi.spyOn(park as any, 'getScheduleForDate').mockRejectedValue(new Error('upstream 500'));
    expect(await walkthroughStatus(park)).toBe('CLOSED');
  });
});
