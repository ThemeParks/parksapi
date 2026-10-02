import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {Bellewaerde, WalibiBelgium, WalibiHolland, WalibiRhoneAlpes} from '../walibi.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * The four parks' apps share one `WaitingTimeStatus` vocabulary for the
 * waitingtimes feed. What the app shows for each value is the reference:
 *
 *   open                                          shown open, with a wait
 *   closed, closed_indefinitely, full_and_closed,
 *   temporary_closed, queue_line_closed,
 *   soon_opened, full                             shown closed
 *   maintenance, not_operational                  shown as maintenance
 *   hidden                                        not shown at all
 *   custom, unknown_status                        no open state, no wait
 *
 * The wait is `Math.round(time / 60)`, with `time` in seconds.
 *
 * Before this fix soon_opened, queue_line_closed and hidden were missing from
 * the map and fell through to a default of OPERATING, so a ride the app shows
 * closed was published open with a wait. `full` was DOWN, `not_operational`
 * was dropped from live data, and the wait was floored.
 */

const RIDE = {
  title: 'Test Ride',
  waitingTimeName: 'ride-1',
  path: '/content/dam/blw/en/attractions/test-ride',
};

function stubbedPark(waitTimes: any[], Park: new () => any = Bellewaerde) {
  const park = new Park();
  park.mergeCultures = [park.culture];
  park.fetchAttractions = (async () => ({json: async () => [RIDE]} as any as HTTPObj)) as any;
  park.getRestaurants = async () => [];
  park.getWaitTimes = async () => waitTimes;
  return park;
}

/** `time: null` omits the field, as the feed does for some rows. */
async function liveFor(status: string, time: number | string | null = 600, Park?: new () => any) {
  const entry: any = {id: RIDE.waitingTimeName, status};
  if (time !== null) entry.time = time;
  const live = await stubbedPark([entry], Park).getLiveData();
  return live.find((l: any) => l.id === RIDE.waitingTimeName);
}

/** Every value of the app's WaitingTimeStatus enum, and what parksapi publishes. */
const EXPECTED: Array<[string, string]> = [
  ['open', 'OPERATING'],
  ['closed', 'CLOSED'],
  ['closed_indefinitely', 'CLOSED'],
  ['full_and_closed', 'CLOSED'],
  ['temporary_closed', 'CLOSED'],
  ['queue_line_closed', 'CLOSED'],
  ['soon_opened', 'CLOSED'],
  ['full', 'CLOSED'],
  ['hidden', 'CLOSED'],
  ['custom', 'CLOSED'],
  ['unknown_status', 'CLOSED'],
  ['maintenance', 'REFURBISHMENT'],
  ['not_operational', 'REFURBISHMENT'],
];

describe('Walibi live status mapping', () => {
  beforeEach(() => {
    CacheLib.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    CacheLib.clear();
    vi.restoreAllMocks();
  });

  test('covers all thirteen values of the app enum', () => {
    expect(new Set(EXPECTED.map(([s]) => s)).size).toBe(13);
  });

  test.each(EXPECTED)('%s publishes %s', async (status, expected) => {
    const ld = await liveFor(status);
    expect(ld).toBeDefined();
    expect(ld!.status).toBe(expected);
  });

  test.each(EXPECTED)('%s is known to the map, so it never logs as unknown', async (status) => {
    await liveFor(status);
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('Unknown status'));
  });

  test.each(EXPECTED.filter(([, s]) => s !== 'OPERATING'))(
    '%s carries no standby wait even when the feed sends a time',
    async (status) => {
      const ld = await liveFor(status, 1800);
      expect(ld!.queue).toBeUndefined();
    },
  );

  test('matches status case-insensitively', async () => {
    expect((await liveFor('Soon_Opened'))!.status).toBe('CLOSED');
    expect((await liveFor('OPEN'))!.status).toBe('OPERATING');
  });

  test('an unrecognised value publishes CLOSED, never OPERATING, and is logged', async () => {
    const ld = await liveFor('some_future_value', 900);
    expect(ld!.status).toBe('CLOSED');
    expect(ld!.queue).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('some_future_value'));
  });

  test.each([
    [0, 0],
    [29, 0],
    [30, 1],
    [89, 1],
    [90, 2],
    [600, 10],
    [629, 10],
    [630, 11],
    [1170, 20],
    ['450', 8],
  ])('open with time %s seconds rounds to %s minutes, as the app does', async (seconds, minutes) => {
    const ld = await liveFor('open', seconds);
    expect(ld).toMatchObject({status: 'OPERATING', queue: {STANDBY: {waitTime: minutes}}});
  });

  test('open with a negative or unparseable time publishes a zero wait', async () => {
    expect((await liveFor('open', -60))!.queue!.STANDBY!.waitTime).toBe(0);
    expect((await liveFor('open', 'n/a'))!.queue!.STANDBY!.waitTime).toBe(0);
  });

  test('open with no time publishes OPERATING without a queue', async () => {
    const ld = await liveFor('open', null);
    expect(ld!.status).toBe('OPERATING');
    expect(ld!.queue).toBeUndefined();
  });

  test.each([
    ['WalibiHolland', WalibiHolland],
    ['WalibiBelgium', WalibiBelgium],
    ['WalibiRhoneAlpes', WalibiRhoneAlpes],
    ['Bellewaerde', Bellewaerde],
  ])('%s shares the mapping', async (_name, Park) => {
    expect((await liveFor('queue_line_closed', 600, Park))!.status).toBe('CLOSED');
    expect((await liveFor('not_operational', 600, Park))!.status).toBe('REFURBISHMENT');
    expect((await liveFor('open', 630, Park))!.queue!.STANDBY!.waitTime).toBe(11);
  });
});
