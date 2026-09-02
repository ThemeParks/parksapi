import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {mapAttractionStatus, TokyoDisneyResort} from '../tokyodisneyresort.js';
import {CacheLib} from '../../../cache.js';

const NOON_JST_UTC = '2026-06-17T03:00:00.000Z'; // 12:00 JST = parks open

const windowAround = (status: string) => ({
  startAt: '2026-06-17T00:00:00.000Z', // 09:00 JST
  endAt:   '2026-06-17T12:00:00.000Z', // 21:00 JST
  operatingStatus: status,
});

describe('mapAttractionStatus (v7)', () => {
  const now = new Date(NOON_JST_UTC);

  test('top-level CANCEL → CLOSED', () => {
    expect(mapAttractionStatus(
      {facilityCode: '101', facilityStatus: 'CANCEL', operatings: []},
      now,
    )).toBe('CLOSED');
  });

  test('top-level CONFIRM_SCHEDULE → CLOSED', () => {
    expect(mapAttractionStatus(
      {facilityCode: '101', facilityStatus: 'CONFIRM_SCHEDULE'},
      now,
    )).toBe('CLOSED');
  });

  test('top-level CONFIRM_STATUS → DOWN', () => {
    expect(mapAttractionStatus(
      {facilityCode: '101', facilityStatus: 'CONFIRM_STATUS'},
      now,
    )).toBe('DOWN');
  });

  test('top-level CANCEL beats any operatings entry', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      facilityStatus: 'CANCEL',
      operatings: [windowAround('OPEN_NOTICE')],
    }, now)).toBe('CLOSED');
  });

  test('OPEN_NOTICE window covering now → OPERATING', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('OPEN_NOTICE')],
    }, now)).toBe('OPERATING');
  });

  test('CLOSE_NOTICE window covering now → DOWN', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('CLOSE_NOTICE')],
    }, now)).toBe('DOWN');
  });

  test('PREPARATION window covering now → CLOSED', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('PREPARATION')],
    }, now)).toBe('CLOSED');
  });

  test('no operatings and no facilityStatus → CLOSED', () => {
    expect(mapAttractionStatus({facilityCode: '101'}, now)).toBe('CLOSED');
  });

  test('now outside every window → CLOSED', () => {
    const beforeOpening = new Date('2026-06-16T22:00:00.000Z'); // 07:00 JST
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [windowAround('OPEN_NOTICE')],
    }, beforeOpening)).toBe('CLOSED');
  });

  test('malformed window dates are skipped, next valid one wins', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [
        {startAt: 'not-a-date', endAt: '2026-06-17T12:00:00.000Z', operatingStatus: 'OPEN_NOTICE'},
        windowAround('CLOSE_NOTICE'),
      ],
    }, now)).toBe('DOWN');
  });

  test('first matching window wins when multiple overlap', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [
        windowAround('OPEN_NOTICE'),
        windowAround('CLOSE_NOTICE'),
      ],
    }, now)).toBe('OPERATING');
  });

  test('unknown operatingStatus → CLOSED', () => {
    expect(mapAttractionStatus({
      facilityCode: '101',
      operatings: [{...windowAround('OPEN_NOTICE'), operatingStatus: 'SOMETHING_NEW'}],
    }, now)).toBe('CLOSED');
  });
});

describe('buildLiveData — standbyTimeDisplayType handling', () => {
  let probe: TokyoDisneyResort;

  beforeEach(() => {
    // Pin "now" to a moment inside the standard test window so the operatings[]
    // entries below all match deterministically.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOON_JST_UTC));
    probe = new TokyoDisneyResort({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const openWindow = () => [{
    startAt: '2026-06-17T00:00:00.000Z',
    endAt:   '2026-06-17T12:00:00.000Z',
    operatingStatus: 'OPEN_NOTICE',
  }];

  test('standbyTimeDisplayType=NORMAL surfaces the wait time', async () => {
    vi.spyOn(probe, 'getConditions').mockResolvedValue({
      attractions: [{
        facilityCode: 'A1',
        standbyTime: 25,
        standbyTimeDisplayType: 'NORMAL',
        operatings: openWindow(),
      }],
    } as any);

    const ld = await (probe as any).buildLiveData();
    expect(ld).toHaveLength(1);
    expect(ld[0].status).toBe('OPERATING');
    expect(ld[0].queue.STANDBY.waitTime).toBe(25);
  });

  test('standbyTimeDisplayType=HIDE suppresses waitTime even when OPERATING', async () => {
    vi.spyOn(probe, 'getConditions').mockResolvedValue({
      attractions: [{
        facilityCode: 'A2',
        standbyTime: 25,
        standbyTimeDisplayType: 'HIDE',
        operatings: openWindow(),
      }],
    } as any);

    const ld = await (probe as any).buildLiveData();
    expect(ld).toHaveLength(1);
    expect(ld[0].status).toBe('OPERATING');
    expect(ld[0].queue.STANDBY.waitTime).toBeUndefined();
  });

  test('standbyTimeDisplayType=FIXED still surfaces the wait time', async () => {
    vi.spyOn(probe, 'getConditions').mockResolvedValue({
      attractions: [{
        facilityCode: 'A3',
        standbyTime: 10,
        standbyTimeDisplayType: 'FIXED',
        operatings: openWindow(),
      }],
    } as any);

    const ld = await (probe as any).buildLiveData();
    expect(ld[0].queue.STANDBY.waitTime).toBe(10);
  });

  test('CLOSED attractions never emit waitTime regardless of displayType', async () => {
    vi.spyOn(probe, 'getConditions').mockResolvedValue({
      attractions: [{
        facilityCode: 'A4',
        facilityStatus: 'CANCEL',
        standbyTime: 25,
        standbyTimeDisplayType: 'NORMAL',
        operatings: [],
      }],
    } as any);

    const ld = await (probe as any).buildLiveData();
    expect(ld[0].status).toBe('CLOSED');
    expect(ld[0].queue.STANDBY.waitTime).toBeUndefined();
  });
});

/**
 * Schedules come from `/rest/v1/parks/calendars`, which returns one row per
 * park per day with a plain `openTime`/`closeTime` pair.
 *
 * Worth stating up front, because it reads like a bug and is not: every
 * announced day in the feed currently opens at 09:00, New Year's Eve
 * included. That is what Tokyo Disney Resort publishes. Checked against
 * tokyodisneyresort.jp across 2026-08 → 2027-02: the site shows
 * "9:00 a.m.-9:00 p.m." on 303 park-days, "9:00 a.m.-6:30 p.m." on 5 and
 * "9:00 a.m.-7:00 p.m." on 2, and the exception dates are the same set the
 * API returns. `spOpenTime`/`spCloseTime` are empty resort-wide because no
 * special-hours event is scheduled, so the EXTRA_HOURS branch is dormant
 * rather than broken. The app has no other park-hours endpoint —
 * `/rest/v3/parks/conditions` carries `earlyEntryFlg` and `allNightDay` as
 * bare booleans with no times attached.
 *
 * Closed days are dropped rather than emitted: `CLOSED` is not a member of
 * typelib's ScheduleType, so absence is how a closure is expressed, the same
 * way every other park in this repo does it.
 */
describe('buildSchedules', () => {
  const calendar = (rows: any[]) => {
    const probe = new TokyoDisneyResort({});
    vi.spyOn(probe, 'getCalendar').mockResolvedValue(rows as any);
    return probe;
  };

  const day = (over: Record<string, any> = {}) => ({
    parkType: 'TDL',
    date: '2026-12-31',
    openTime: '09:00',
    closeTime: '21:00',
    closedDay: false,
    spOpenTime: '',
    spCloseTime: '',
    undecided: false,
    ...over,
  });

  test('an operating day is stamped in JST', async () => {
    const [tdl] = await calendar([day()]).getSchedules();

    expect(tdl.id).toBe('tdl');
    expect(tdl.schedule).toEqual([{
      date: '2026-12-31',
      type: 'OPERATING',
      openingTime: '2026-12-31T09:00:00+09:00',
      closingTime: '2026-12-31T21:00:00+09:00',
    }]);
  });

  test('each park gets its own schedule entry', async () => {
    const out = await calendar([
      day({parkType: 'TDL', closeTime: '21:00'}),
      day({parkType: 'TDS', closeTime: '18:30'}),
    ]).getSchedules();

    expect(out.map((s: any) => s.id).sort()).toEqual(['tdl', 'tds']);
    expect(out.find((s: any) => s.id === 'tds')!.schedule[0].closingTime)
      .toBe('2026-12-31T18:30:00+09:00');
  });

  test('the early-close days keep their real closing time', async () => {
    const [tds] = await calendar([
      day({parkType: 'TDS', date: '2026-09-25', closeTime: '18:30'}),
    ]).getSchedules();

    expect(tds.schedule[0].closingTime).toBe('2026-09-25T18:30:00+09:00');
  });

  test('closed and undecided days are not published', async () => {
    const out = await calendar([
      day({date: '2026-12-30', closedDay: true}),
      day({date: '2026-12-29', undecided: true}),
    ]).getSchedules();

    expect(out).toEqual([]);
  });

  test('a day missing either time is skipped rather than published as Invalid Date', async () => {
    const out = await calendar([
      day({date: '2026-12-28', openTime: '', closeTime: '21:00'}),
      day({date: '2026-12-27', closeTime: undefined}),
    ]).getSchedules();

    expect(out).toEqual([]);
  });

  test('a park the resort does not surface is ignored', async () => {
    const out = await calendar([day({parkType: 'TDR'})]).getSchedules();

    expect(out).toEqual([]);
  });

  /**
   * Dormant today — every row in the live feed sends these empty — but the
   * branch exists, so it is pinned rather than left to rot untested.
   */
  test('special hours are published alongside the operating day', async () => {
    const [tdl] = await calendar([
      day({spOpenTime: '08:15', spCloseTime: '09:00'}),
    ]).getSchedules();

    expect(tdl.schedule).toHaveLength(2);
    expect(tdl.schedule[1]).toMatchObject({
      date: '2026-12-31',
      type: 'EXTRA_HOURS',
      openingTime: '2026-12-31T08:15:00+09:00',
      closingTime: '2026-12-31T09:00:00+09:00',
    });
  });

  test('a half-populated special-hours pair is not published', async () => {
    const [tdl] = await calendar([day({spOpenTime: '08:15'})]).getSchedules();

    expect(tdl.schedule).toHaveLength(1);
    expect(tdl.schedule[0].type).toBe('OPERATING');
  });
});

/**
 * Premier Access and Priority Pass reduce to a single boolean each in the
 * anonymous feed, so the emitted queues are deliberately hollow. Pinned
 * because the shape looks like a gap and gets re-reported as one: the return
 * windows live behind POST endpoints that want registered park tickets and a
 * `cid:ctoken` credential, so null is the honest value for those.
 *
 * The price is a different matter: the API never carries one, but the rate is
 * published on the public guide page, so it is filled in when a webBase is
 * configured and stays null otherwise.
 */
describe('buildLiveData — Premier Access and Priority Pass', () => {
  const conditions = (attraction: Record<string, any>, prices: Record<string, number> = {}) => {
    const probe = new TokyoDisneyResort({});
    vi.spyOn(probe, 'getPremierAccessPrices').mockResolvedValue(prices);
    vi.spyOn(probe, 'getFacilities').mockResolvedValue([
      {facilityCode: 'A1', name: 'Splash Mountain'} as any,
    ]);
    vi.spyOn(probe, 'getConditions').mockResolvedValue({
      attractions: [{
        facilityCode: 'A1',
        standbyTimeDisplayType: 'NORMAL',
        operatings: [{
          startAt: '2026-06-17T00:00:00.000Z',
          endAt: '2026-06-17T12:00:00.000Z',
          operatingStatus: 'OPEN_NOTICE',
        }],
        ...attraction,
      }],
    } as any);
    return probe;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOON_JST_UTC));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('SELLING becomes an available paid queue with no window and no real price', async () => {
    const [row] = await conditions({premierAccessStatus: 'SELLING'}).getLiveData();

    expect(row.queue!.PAID_RETURN_TIME).toEqual({
      state: 'AVAILABLE',
      returnStart: null,
      returnEnd: null,
      // Premier Access pricing sits behind an authenticated purchase flow, so
      // the amount is genuinely unknown rather than zero.
      price: {currency: 'JPY', amount: null},
    });
  });

  test('NOT_SELLING_NOW becomes a finished paid queue', async () => {
    const [row] = await conditions({premierAccessStatus: 'NOT_SELLING_NOW'}).getLiveData();

    expect(row.queue!.PAID_RETURN_TIME!.state).toBe('FINISHED');
  });

  test('TICKETING becomes an available free return queue with no window', async () => {
    const [row] = await conditions({priorityPassStatus: 'TICKETING'}).getLiveData();

    expect(row.queue!.RETURN_TIME).toEqual({
      state: 'AVAILABLE',
      returnStart: null,
      returnEnd: null,
    });
  });

  test('an attraction offering neither emits neither queue', async () => {
    const [row] = await conditions({standbyTime: 30}).getLiveData();

    expect(row.queue!.PAID_RETURN_TIME).toBeUndefined();
    expect(row.queue!.RETURN_TIME).toBeUndefined();
    expect(row.queue!.STANDBY!.waitTime).toBe(30);
  });

  test('both queues can sit on one attraction', async () => {
    const [row] = await conditions({
      premierAccessStatus: 'SELLING',
      priorityPassStatus: 'FINISHED',
    }).getLiveData();

    expect(row.queue!.PAID_RETURN_TIME!.state).toBe('AVAILABLE');
    expect(row.queue!.RETURN_TIME!.state).toBe('FINISHED');
  });

  /**
   * The published rate reaches the wire when it is available. Whole yen: JPY
   * has no minor unit, so the amount is the price rather than a hundredth of
   * it, unlike the cents every other park reports.
   */
  test('a published rate is emitted as the price', async () => {
    const [row] = await conditions(
      {premierAccessStatus: 'SELLING'},
      {'Splash Mountain': 1500},
    ).getLiveData();

    expect(row.queue!.PAID_RETURN_TIME!.price).toEqual({currency: 'JPY', amount: 1500});
  });

  test('an experience with no published rate stays null, not zero', async () => {
    const [row] = await conditions(
      {premierAccessStatus: 'SELLING'},
      {'Some Other Ride': 1500},
    ).getLiveData();

    expect(row.queue!.PAID_RETURN_TIME!.price).toEqual({currency: 'JPY', amount: null});
  });

  /**
   * The guide page is a bonus on top of the queue state. If it cannot be read
   * the queue must still be published — losing a price is acceptable, losing
   * the live data is not.
   */
  test('the queue survives the price lookup failing', async () => {
    const probe = conditions({premierAccessStatus: 'SELLING'});
    vi.spyOn(probe, 'getPremierAccessPrices').mockRejectedValue(new Error('site unavailable'));

    await expect(probe.getLiveData()).resolves.toBeDefined();
  });
});

/**
 * The price lookup caches, and what it caches has to be worth keeping.
 *
 * Two failure modes this guards, both of which cost a real day of prices on
 * 2026-09-02. An unconfigured build must not write an empty map under the key
 * a configured build reads, and a fetch that came back empty must not sit
 * there for half a day.
 */
describe('getPremierAccessPrices caching', () => {
  const priced = (webBase: string, html: string) => {
    const probe = new TokyoDisneyResort({});
    (probe as any).webBase = webBase;
    const fetchSpy = vi.spyOn(probe, 'fetchPremierAccessPrices')
      .mockResolvedValue({text: async () => html} as any);
    return {probe, fetchSpy};
  };

  const page = `
    <div class="listTextArea">
      <p class="heading3">Splash Mountain</p>
      <strong>1,500 yen per access</strong>
    </div>`;

  beforeEach(() => {
    CacheLib.clearByClassName('TokyoDisneyResort');
  });

  afterEach(() => {
    vi.useRealTimers();
    CacheLib.clearByClassName('TokyoDisneyResort');
  });

  test('with no webBase it returns empty without fetching', async () => {
    const {probe, fetchSpy} = priced('', page);

    expect(await probe.getPremierAccessPrices()).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * The regression. The guard used to sit inside the cached method, so the
   * empty map an unconfigured process returned was stored under the key every
   * later call reads — and configuring webBase afterwards changed nothing
   * until the twelve hour TTL ran out.
   */
  test('an unconfigured call does not poison a later configured one', async () => {
    const {probe: unconfigured} = priced('', page);
    expect(await unconfigured.getPremierAccessPrices()).toEqual({});

    const {probe, fetchSpy} = priced('https://example.test', page);

    expect(await probe.getPremierAccessPrices()).toEqual({'Splash Mountain': 1500});
    expect(fetchSpy).toHaveBeenCalled();
  });

  test('a rate card is held for half a day', async () => {
    vi.useFakeTimers();
    const {probe, fetchSpy} = priced('https://example.test', page);

    await probe.getPremierAccessPrices();
    vi.advanceTimersByTime(6 * 60 * 1000);
    expect(await probe.getPremierAccessPrices()).toEqual({'Splash Mountain': 1500});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * An empty page means the fetch failed or the markup moved. Either way it is
   * a state a fix should clear in minutes, not one that outlives the deploy.
   */
  test('an empty result is retried within minutes', async () => {
    vi.useFakeTimers();
    const {probe, fetchSpy} = priced('https://example.test', '<html>nothing</html>');

    expect(await probe.getPremierAccessPrices()).toEqual({});
    vi.advanceTimersByTime(6 * 60 * 1000);
    await probe.getPremierAccessPrices();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('a throwing fetch yields empty rather than losing the live data', async () => {
    const probe = new TokyoDisneyResort({});
    (probe as any).webBase = 'https://example.test';
    vi.spyOn(probe, 'fetchPremierAccessPrices').mockRejectedValue(new Error('handshake'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await probe.getPremierAccessPrices()).toEqual({});
  });
});
