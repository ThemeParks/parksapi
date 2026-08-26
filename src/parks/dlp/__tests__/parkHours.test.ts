import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {DisneylandParis} from '../disneylandparis.js';
import {CacheLib} from '../../../cache.js';
import {formatInTimezone} from '../../../datetime.js';

/**
 * Walkthrough attractions (La Cabane des Robinson, La Tanière du Dragon, …) never
 * appear in the wait feed, so their live status falls back to park hours.
 *
 * Those hours come from each park's own row in the schedule feed. They used to
 * be derived from the attraction estate — earliest start and latest end across
 * queue-bearing rides — which one outlying ride could move by hours, which
 * conflated P1 and P2 into a single window, and which read POI schedules that
 * only ever carry the date they were fetched.
 *
 * The clock is pinned throughout. These windows are wall-clock relative, so on
 * a live clock the suite went red between 22:30 and 01:30 Paris, when a
 * +90-minute window wraps past midnight.
 */
const TZ = 'Europe/Paris';

/** Midday in Paris, well inside any plausible park day. */
const NOON = new Date('2026-08-13T12:00:00+02:00');

function parkToday(): string {
  const [mm, dd, yyyy] = formatInTimezone(new Date(), TZ, 'date').split('/');
  return `${yyyy}-${mm}-${dd}`;
}

/** A time `offsetMinutes` from the pinned now, in the park's wall clock. */
function parkClock(offsetMinutes: number): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  return formatInTimezone(at, TZ, 'iso').slice(11, 19);
}

function stubbedPark(opts: {
  parkSchedules?: any[];
  walkthroughPark?: string;
  extraAttractions?: any[];
  waitTimes?: any[];
  /** Per-entity rows in the schedule feed. Defaults to just the canary. */
  entitySchedules?: any[];
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
        id: 'P1AA01',
        name: 'La Cabane des Robinson',
        type: 'Attraction',
        location: {id: opts.walkthroughPark ?? 'P1'},
        // No `schedules` — this is the whole point: it must fall back.
      },
      {
        // Canary. Carries its own window in the schedule feed, so it resolves
        // without park hours and must read OPERATING in every test. Without
        // it, a test that only asserts CLOSED would pass just as happily
        // against a dead pipeline.
        //
        // No `schedules` here either. The POI blob is never the source for
        // own-hours: it carries only the date it was fetched and is cached
        // 12h, so past park-local midnight it is empty for the current date.
        id: 'P1NA12',
        name: 'La Tanière du Dragon',
        type: 'Attraction',
        location: {id: 'P1'},
      },
      ...(opts.extraAttractions ?? []),
    ],
  });

  vi.spyOn(park as any, 'getWaitTimes').mockResolvedValue(opts.waitTimes ?? []);
  vi.spyOn(park as any, 'getPremierAccess').mockResolvedValue([]);
  vi.spyOn(park as any, 'getVirtualQueueData').mockResolvedValue([]);
  // The canary's own window rides along with every stub. Narrow around now:
  // wide enough to always contain it, narrow enough never to straddle
  // midnight at any pinned clock.
  const canaryRow = {
    id: 'P1NA12',
    name: 'La Tanière du Dragon',
    schedules: [{
      startTime: parkClock(-5),
      endTime: parkClock(5),
      status: 'OPERATING',
      closed: false,
    }],
  };

  vi.spyOn(park as any, 'getScheduleForDate').mockResolvedValue(
    [...(opts.parkSchedules ?? []), ...(opts.entitySchedules ?? [canaryRow])].map((s) => ({
      ...s,
      schedules: s.schedules.map((r: any) => ({...r, date: today})),
    })),
  );

  return park;
}

/**
 * The walkthrough's published status, having first checked the canary is
 * alive so an assertion of CLOSED cannot be satisfied by an empty pipeline.
 */
async function walkthroughStatus(park: DisneylandParis): Promise<string | undefined> {
  const live = await park.getLiveData();
  expect(live.find((l) => l.id === 'P1NA12')?.status).toBe('OPERATING');
  return live.find((l) => l.id === 'P1AA01')?.status;
}

function parkRow(id: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    schedules: [{startTime, endTime, status: 'OPERATING', closed: false, ...extra}],
  };
}

/** Open right now: from 90 minutes ago to 90 minutes ahead. */
const openNow = (id: string) => parkRow(id, parkClock(-90), parkClock(90));
/** Shut: the window ended two hours ago. */
const closedNow = (id: string) => parkRow(id, parkClock(-180), parkClock(-120));

describe('DLP park-hours fallback for walkthroughs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    CacheLib.clearByClassName('DisneylandParis');
  });

  it('reports OPERATING inside its own park\'s published window', async () => {
    const park = stubbedPark({parkSchedules: [openNow('P1'), closedNow('P2')]});
    expect(await walkthroughStatus(park)).toBe('OPERATING');
  });

  it('reads an entity\'s own hours from the schedule feed, not the POI blob', async () => {
    // The state after park-local midnight: the 12h-cached POI blob still
    // carries yesterday's row and nothing for today, while the schedule feed
    // is fetched per date and is correct. Sourcing own-hours from POI meant a
    // walkthrough with its own shorter window silently inherited full park
    // hours until the cache rolled.
    //
    // Park is open, the entity's own window closed two hours ago. Reading the
    // feed gives CLOSED; reading the POI blob gives OPERATING via the park
    // fallback, because the blob has no row for today at all.
    const park = stubbedPark({
      parkSchedules: [openNow('P1'), openNow('P2')],
      entitySchedules: [
        {
          id: 'P1AA01',
          name: 'La Cabane des Robinson',
          schedules: [{
            startTime: parkClock(-180),
            endTime: parkClock(-120),
            status: 'OPERATING',
            closed: false,
          }],
        },
        // Canary carried explicitly, since the default is replaced.
        {
          id: 'P1NA12',
          name: 'La Tanière du Dragon',
          schedules: [{
            startTime: parkClock(-5),
            endTime: parkClock(5),
            status: 'OPERATING',
            closed: false,
          }],
        },
      ],
    });
    expect(await walkthroughStatus(park)).toBe('CLOSED');
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
    // OPERATING long after the park shut.
    const park = stubbedPark({
      parkSchedules: [closedNow('P1')],
      extraAttractions: [
        {
          id: 'P1DA10',
          name: 'Disneyland Railroad Discoveryland Station',
          type: 'Attraction',
          location: {id: 'P1'},
          schedules: [
            {date: parkToday(), startTime: '00:00:00', endTime: '23:59:00', status: 'OPERATING', closed: false},
          ],
        },
      ],
      waitTimes: [{entityId: 'P1DA10', type: 'Attraction', status: 'OPERATING', postedWaitMinutes: '5'}],
    });
    expect(await walkthroughStatus(park)).toBe('CLOSED');
  });

  it('ignores a queue-bearing ride that opens before the park', async () => {
    // Mirror on the open side: an 08:13 ride start used to become park open,
    // so walkthroughs read OPERATING before guests could get in.
    const park = stubbedPark({
      parkSchedules: [parkRow('P1', parkClock(60), parkClock(180))],
      extraAttractions: [
        {
          id: 'P1RA00',
          name: 'Big Thunder Mountain',
          type: 'Attraction',
          location: {id: 'P1'},
          schedules: [
            {date: parkToday(), startTime: parkClock(-60), endTime: parkClock(180), status: 'OPERATING', closed: false},
          ],
        },
      ],
      waitTimes: [{entityId: 'P1RA00', type: 'Attraction', status: 'OPERATING', postedWaitMinutes: '5'}],
    });
    expect(await walkthroughStatus(park)).toBe('CLOSED');
  });

  it('reports CLOSED for a closed-flagged park row', async () => {
    const park = stubbedPark({
      parkSchedules: [parkRow('P1', parkClock(-90), parkClock(90), {closed: true})],
    });
    expect(await walkthroughStatus(park)).toBe('CLOSED');
  });

  it('counts EXTRA_MAGIC_HOURS as part of the window', async () => {
    // EMH is hotel-guest-only, but guests are in the park and the rides
    // publish windows covering it. Excluding it would report a coaster
    // operating while a walkthrough beside it reads closed.
    const park = stubbedPark({
      parkSchedules: [
        {
          id: 'P1',
          name: 'P1',
          schedules: [
            {startTime: parkClock(-30), endTime: parkClock(30), status: 'EXTRA_MAGIC_HOURS', closed: false},
            {startTime: parkClock(60), endTime: parkClock(180), status: 'OPERATING', closed: false},
          ],
        },
      ],
    });
    expect(await walkthroughStatus(park)).toBe('OPERATING');
  });

  it('spans the whole day when the feed splits it into several windows', async () => {
    // A day broken by a private event publishes two OPERATING rows; taking
    // only the first would report closed for the rest of the day.
    const park = stubbedPark({
      parkSchedules: [
        {
          id: 'P1',
          name: 'P1',
          schedules: [
            {startTime: parkClock(-240), endTime: parkClock(-180), status: 'OPERATING', closed: false},
            {startTime: parkClock(-60), endTime: parkClock(60), status: 'OPERATING', closed: false},
          ],
        },
      ],
    });
    expect(await walkthroughStatus(park)).toBe('OPERATING');
  });

  it('picks the OPERATING row whatever order the feed lists it in', async () => {
    // Observed live: some days EXTRA_MAGIC_HOURS is index 0, some days it isn't.
    const park = stubbedPark({
      parkSchedules: [
        {
          id: 'P1',
          name: 'P1',
          schedules: [
            {startTime: parkClock(-90), endTime: parkClock(90), status: 'OPERATING', closed: false},
            {startTime: parkClock(-240), endTime: parkClock(-180), status: 'EXTRA_MAGIC_HOURS', closed: false},
          ],
        },
      ],
    });
    expect(await walkthroughStatus(park)).toBe('OPERATING');
  });

  describe('a park day that runs past midnight', () => {
    it('is still open before midnight', async () => {
      vi.setSystemTime(new Date('2026-08-13T23:00:00+02:00'));
      const park = stubbedPark({parkSchedules: [parkRow('P1', '09:30:00', '01:00:00')]});
      expect(await walkthroughStatus(park)).toBe('OPERATING');
    });

    it('reads the small hours against the new day, not the one still running', async () => {
      // Known limitation, pinned so it is a decision rather than a surprise.
      // At 00:30 the park is still in the 13th's 09:30-01:00 day, but todayStr
      // has rolled to the 14th and buildLiveData only fetches todayStr — so we
      // judge against the 14th's window, which has not opened yet, and report
      // CLOSED. Resolving this properly needs yesterday's row too.
      vi.setSystemTime(new Date('2026-08-14T00:30:00+02:00'));
      const park = stubbedPark({parkSchedules: [parkRow('P1', '09:30:00', '01:00:00')]});
      expect(await walkthroughStatus(park)).toBe('CLOSED');
    });

    it('is shut in the gap between closing and reopening', async () => {
      vi.setSystemTime(new Date('2026-08-13T08:00:00+02:00'));
      const park = stubbedPark({parkSchedules: [parkRow('P1', '09:30:00', '01:00:00')]});
      expect(await walkthroughStatus(park)).toBe('CLOSED');
    });
  });

  describe('when no hours are published', () => {
    // CLOSED, not silence. The wiki keeps a row until something replaces it,
    // so emitting nothing would leave a walkthrough last seen OPERATING
    // reading OPERATING forever. And since the query only asks for OPERATING
    // and EXTRA_MAGIC_HOURS rows, a park shut all day cannot produce a row at
    // all — absence is what a real closure looks like.
    //
    // The canary in each of these proves the pipeline is alive, so CLOSED is
    // a decision rather than an empty result.

    it('reports CLOSED when the park publishes no hours', async () => {
      const park = stubbedPark({parkSchedules: []});
      expect(await walkthroughStatus(park)).toBe('CLOSED');
    });

    it('reports CLOSED when the feed carries no row for this park', async () => {
      // Real shape: past the publication horizon the feed returns activities
      // but no P1/P2 rows at all.
      const park = stubbedPark({parkSchedules: [openNow('P2')], walkthroughPark: 'P1'});
      expect(await walkthroughStatus(park)).toBe('CLOSED');
    });

    it('reports CLOSED when the schedule feed fails', async () => {
      // The canary cannot apply here. Own-hours come from the same feed as
      // park hours, so a total feed failure leaves every walkthrough without
      // a window by definition. Assert the rows exist and are CLOSED instead,
      // which still fails on a pipeline that emits nothing at all.
      const park = stubbedPark({parkSchedules: []});
      vi.spyOn(park as any, 'getScheduleForDate').mockRejectedValue(new Error('upstream 500'));

      const live = await park.getLiveData();
      for (const id of ['P1AA01', 'P1NA12']) {
        const row = live.find((l) => l.id === id);
        expect(row, `expected a live row for ${id}`).toBeDefined();
        expect(row?.status).toBe('CLOSED');
      }
    });

    it('still honours the walkthrough\'s own schedule when it has one', async () => {
      // No park hours, but the attraction publishes its own window: that is a
      // real observation and must still be used. This is the canary's own
      // case, asserted explicitly rather than only as a precondition.
      const park = stubbedPark({parkSchedules: []});
      const live = await park.getLiveData();
      expect(live.find((l) => l.id === 'P1NA12')?.status).toBe('OPERATING');
      expect(live.find((l) => l.id === 'P1AA01')?.status).toBe('CLOSED');
    });
  });
});
