import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {ParcAsterix, showBillAuthority, type POIEntry} from '../parcasterix.js';
import {CacheLib} from '../../../cache.js';

/**
 * `paxSchedules` is a same-day bill: it carries one entry per show performing
 * today and nothing at all for the rest. A show that is dark today therefore
 * has no live row to key off, and the collector is upsert-only — so the wiki
 * kept serving whichever showtimes the show last performed to, still reading
 * OPERATING. Three Parc Asterix shows were sitting on 11-day-old times when a
 * user reported it.
 *
 * Absence is not ambiguous here, so it does not need a multi-day window to
 * interpret: a show missing from a bill that lists every performance today has
 * no performances today, which is exactly what CLOSED says.
 */
const show = (drupalId: number, title = `Show ${drupalId}`): POIEntry => ({
  drupal_id: drupalId,
  title,
  titles: {en: title},
  latitude: 49.13675,
  longitude: 2.573816,
  _type: 'show',
});

const attraction = (drupalId: number): POIEntry => ({
  ...show(drupalId, `Attraction ${drupalId}`),
  _type: 'attraction',
});

const restaurant = (drupalId: number): POIEntry => ({
  ...show(drupalId, `Restaurant ${drupalId}`),
  _type: 'restaurant',
});

const latency = (drupalId: string, isOpen = true, latencyValue: number | null = 10) => ({
  drupalId,
  latency: latencyValue,
  isOpen,
  message: null,
  openingTime: null,
  closingTime: null,
});

const performance = (drupalId: string, times = [{at: '14:00:00', startAt: null, endAt: null}]) => ({
  drupalId,
  times,
});

const ATTRACTION_IDS = Array.from({length: 20}, (_, i) => 31303 + i);
const ATTRACTIONS = ATTRACTION_IDS.map((id) => latency(String(id)));
/** The package rows behind ATTRACTIONS, so the corroboration check has a denominator. */
const ATTRACTION_POI = ATTRACTION_IDS.map(attraction);

/** Mid-afternoon in Europe/Paris — park open, bill already rewritten for today. */
const DAYTIME = new Date('2026-09-09T12:00:00Z');

/**
 * An ordinary 10:00-18:00 operating day for whenever the clock currently says
 * it is. Absence is only read as darkness once the park has opened, so a test
 * that wants the bill believed has to be standing on an open day inside its
 * hours — an empty calendar means "say nothing", which is the correct answer
 * and a silent way to make an assertion vacuous.
 */
const openDay = (date: string) => ({
  date,
  type: 'OPERATING',
  openingTime: `${date}T10:00:00+02:00`,
  closingTime: `${date}T18:00:00+02:00`,
});

const openToday = () => [openDay(new Date().toISOString().slice(0, 10))];

/**
 * A real closed day: the calendar is populated, today simply is not in it,
 * because a day with no hours never reaches the calendar at all. An *empty*
 * calendar is a different thing — a package that failed to parse — and must
 * not be read as a park-wide closure.
 */
const closedToday = () => [openDay('2026-09-06'), openDay('2026-09-12')];

function stubbedPark(
  latencies: ReturnType<typeof latency>[],
  schedules: ReturnType<typeof performance>[],
  poi: POIEntry[],
  calendar: () => any[] = openToday,
): ParcAsterix {
  const park = new ParcAsterix();
  vi.spyOn(park as any, 'getPolling').mockResolvedValue({latencies, schedules});
  vi.spyOn(park as any, 'getPOIData').mockImplementation(async () => ({
    poi,
    calendar: calendar(),
  }));
  return park;
}

describe('Parc Asterix shows dark today', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ParcAsterix', {includePersistent: true});
    vi.useFakeTimers();
    vi.setSystemTime(DAYTIME);
  });

  afterEach(() => vi.useRealTimers());

  it('closes a show that is not on today’s bill', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31483')],
      [...ATTRACTION_POI, show(31483), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31483')).toEqual({
      id: '31483',
      status: 'OPERATING',
      showtimes: [
        {
          type: 'Performance Time',
          startTime: '2026-09-09T14:00:00+02:00',
          endTime: '2026-09-09T14:00:00+02:00',
        },
      ],
    });
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  it('publishes a closed row, not the last showtimes it saw', async () => {
    const poi = [...ATTRACTION_POI, show(31513)];
    const performing = await stubbedPark(ATTRACTIONS, [performance('31513')], poi).getLiveData();
    expect(performing.find((l) => l.id === '31513')?.showtimes).toHaveLength(1);

    const dark = await stubbedPark(ATTRACTIONS, [], poi).getLiveData();
    // Not `?.showtimes` — an optional chain here cannot tell a closed row with
    // no showtimes from no row at all, which is the whole point of the test.
    expect(dark.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  it('closes a show whose run ended before this gate ever saw it perform', async () => {
    // The retirement gate can only close ids it has watched go absent, so a
    // show that stopped performing before the code shipped is invisible to it.
    // Reading the bill directly needs no such history.
    const live = await stubbedPark(
      ATTRACTIONS,
      [],
      [...ATTRACTION_POI, show(31509), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31509')).toEqual({id: '31509', status: 'CLOSED'});
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  it('reopens the show the day it is back on the bill', async () => {
    const poi = [...ATTRACTION_POI, show(31513)];
    const dark = await stubbedPark(ATTRACTIONS, [], poi).getLiveData();
    expect(dark.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});

    const live = await stubbedPark(ATTRACTIONS, [performance('31513')], poi).getLiveData();
    expect(live.find((l) => l.id === '31513')).toMatchObject({status: 'OPERATING'});
  });

  it('closes only shows, never an attraction or a restaurant', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [],
      [...ATTRACTION_POI, attraction(99991), restaurant(99992), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '99991')).toBeUndefined();
    expect(live.find((l) => l.id === '99992')).toBeUndefined();
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  it('never publishes a row for a show with no usable id', async () => {
    const live = await stubbedPark(ATTRACTIONS, [], [
      ...ATTRACTION_POI,
      {...show(0), drupal_id: 0},
      {...show(1), drupal_id: undefined as unknown as number},
      show(31513),
    ]).getLiveData();

    for (const bad of ['0', 'undefined', 'NaN', 'null', '']) {
      expect(live.find((l) => l.id === bad)).toBeUndefined();
    }
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  // A show on the bill with no performances left is already closed by the
  // showtime pass. It must not also collect a dark row.
  it('emits one row for a show on the bill with no times', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31513', [])],
      [...ATTRACTION_POI, show(31513)],
    ).getLiveData();

    expect(live.filter((l) => l.id === '31513')).toEqual([{id: '31513', status: 'CLOSED'}]);
  });

  // The two bills have always been disjoint, but if an id ever appeared in
  // both, the observation has to beat the inference — otherwise the build
  // carries OPERATING and CLOSED for one id and array order decides.
  it('lets a live observation win over an inferred closure', async () => {
    const live = await stubbedPark(
      [...ATTRACTIONS, latency('31513')],
      [],
      [...ATTRACTION_POI, show(31513)],
    ).getLiveData();

    expect(live.filter((l) => l.id === '31513')).toEqual([
      {id: '31513', status: 'OPERATING', queue: {STANDBY: {waitTime: 10}}},
    ]);
  });

  it('emits at most one row per id', async () => {
    const live = await stubbedPark(
      [...ATTRACTIONS, latency('31513')],
      [performance('31483'), performance('31513')],
      [...ATTRACTION_POI, show(31483), show(31513), show(31509)],
    ).getLiveData();

    const ids = live.map((l) => l.id);
    expect(ids).toHaveLength(new Set(ids).size);
  });
});

describe('Parc Asterix dark-show guards', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ParcAsterix', {includePersistent: true});
    vi.useFakeTimers();
    vi.setSystemTime(DAYTIME);
  });

  afterEach(() => vi.useRealTimers());

  // A gutted response reaching buildLiveData by any route must not be read as
  // a park where every show is dark.
  // A package that failed to parse leaves no calendar. That is not a closure.
  it('says nothing about shows when the calendar is empty', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [],
      [...ATTRACTION_POI, show(31513)],
      () => [],
    ).getLiveData();

    expect(live.filter((l) => l.status === 'CLOSED' && !l.queue)).toEqual([]);
  });

  it('says nothing when the whole polling feed comes back empty', async () => {
    const live = await stubbedPark([], [], [...ATTRACTION_POI, show(31483), show(31513)]).getLiveData();

    expect(live).toHaveLength(0);
  });

  // The real shape of an upstream wobble is partial, not empty. One attraction
  // out of twenty is not a feed that can speak for what is dark.
  it('says nothing when the attraction bill comes back a fraction of itself', async () => {
    const live = await stubbedPark(
      ATTRACTIONS.slice(0, 1),
      [],
      [...ATTRACTION_POI, show(31483), show(31513)],
    ).getLiveData();

    expect(live.filter((l) => l.status === 'CLOSED' && !l.queue)).toEqual([]);
  });

  it('closes shows once the attraction bill is back over half', async () => {
    const live = await stubbedPark(
      ATTRACTIONS.slice(0, 10),
      [],
      [...ATTRACTION_POI, show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  // Winter closure: every show leaves the bill at once while paxLatencies keeps
  // listing the attractions as shut. That is a real closure, not a broken feed.
  it('closes every show across a seasonal shutdown', async () => {
    const shut = ATTRACTIONS.map((a) => latency(a.drupalId, false, null));
    const live = await stubbedPark(
      shut,
      [],
      [...ATTRACTION_POI, show(31483), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31483')).toEqual({id: '31483', status: 'CLOSED'});
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  // The bill rolls at local midnight while a Halloween night still has an hour
  // to run, and a show physically mid-performance would otherwise be absent
  // from a bill for a day that has not started.
  it('closes nothing in the after-midnight tail of an event night', async () => {
    vi.setSystemTime(new Date('2026-10-17T23:30:00Z')); // 01:30 Europe/Paris
    const live = await stubbedPark(
      ATTRACTIONS,
      [],
      [...ATTRACTION_POI, show(31483), show(31513)],
    ).getLiveData();

    expect(live.filter((l) => l.status === 'CLOSED' && !l.queue)).toEqual([]);
  });

  // The bill served overnight is the last open day's and is not rewritten for
  // today until the morning, so being past the small hours is not enough.
  // Before opening the bill is still the last open day's, so republishing its
  // performances would assert a passed day's programme as today's — which is
  // how the wiki came to serve a 19:00-close day's showtimes on an 18:00 day.
  it('publishes nothing about shows before the park opens', async () => {
    vi.setSystemTime(new Date('2026-09-09T05:30:00Z')); // 07:30 Europe/Paris
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31483')],
      [...ATTRACTION_POI, show(31483), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31483')).toBeUndefined();
    expect(live.find((l) => l.id === '31513')).toBeUndefined();
    expect(live).toHaveLength(ATTRACTIONS.length);
  });

  // The small hours are different: an event night's bill is still that night's
  // and still correct, so its performances must keep publishing.
  it('keeps publishing performances in the after-midnight tail', async () => {
    vi.setSystemTime(new Date('2026-10-17T23:30:00Z')); // 01:30 Europe/Paris
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31483', [{at: '00:45:00', startAt: null, endAt: null}])],
      [...ATTRACTION_POI, show(31483), show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31483')).toMatchObject({status: 'OPERATING'});
    expect(live.find((l) => l.id === '31513')).toBeUndefined();
  });

  it('resumes closing once the park has opened', async () => {
    vi.setSystemTime(new Date('2026-09-09T08:30:00Z')); // 10:30 Europe/Paris
    const live = await stubbedPark(
      ATTRACTIONS,
      [],
      [...ATTRACTION_POI, show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });

  // Closed days never reach the calendar, and the bill keeps serving the last
  // open day's programme straight through them — so a closed day is exactly
  // when a stale bill looks most like a live one.
  it('closes every show, bill included, on a day the park does not operate', async () => {
    const shut = ATTRACTIONS.map((a) => latency(a.drupalId, false, null));
    const live = await stubbedPark(
      shut,
      [performance('31483')],
      [...ATTRACTION_POI, show(31483), show(31513)],
      closedToday,
    ).getLiveData();

    expect(live.find((l) => l.id === '31483')).toEqual({id: '31483', status: 'CLOSED'});
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
    expect(live.find((l) => l.id === '31483')?.showtimes).toBeUndefined();
  });

  it('publishes nothing about shows when a closed calendar meets open rides', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31483')],
      [...ATTRACTION_POI, show(31483), show(31513)],
      closedToday,
    ).getLiveData();

    expect(live.find((l) => l.id === '31483')).toMatchObject({status: 'OPERATING'});
    expect(live.find((l) => l.id === '31513')).toBeUndefined();
  });

  // The live path never used to touch the offline package. Putting a 23MB ZIP
  // between the bill and the wait times must not cost the wait times.
  it('keeps publishing wait times when the offline package is unreachable', async () => {
    const park = new ParcAsterix();
    vi.spyOn(park as any, 'getPolling').mockResolvedValue({
      latencies: ATTRACTIONS,
      schedules: [performance('31483')],
    });
    vi.spyOn(park as any, 'getPOIData').mockRejectedValue(new Error('package 503'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const live = await park.getLiveData();

    expect(live.find((l) => l.id === '31303')).toEqual({
      id: '31303',
      status: 'OPERATING',
      queue: {STANDBY: {waitTime: 10}},
    });
    expect(live.find((l) => l.id === '31483')).toMatchObject({status: 'OPERATING'});
    expect(live.filter((l) => l.status === 'CLOSED' && !l.queue)).toEqual([]);
  });

  // A show that is only in the bill and in no package database still publishes
  // its performances; the POI list only supplies the ids that can be closed.
  it('keeps a scheduled show that has no POI row', async () => {
    const live = await stubbedPark(
      ATTRACTIONS,
      [performance('31497')],
      [...ATTRACTION_POI, show(31513)],
    ).getLiveData();

    expect(live.find((l) => l.id === '31497')).toMatchObject({status: 'OPERATING'});
    expect(live.find((l) => l.id === '31513')).toEqual({id: '31513', status: 'CLOSED'});
  });
});

describe('Parc Asterix polling response', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    CacheLib.clearByClassName('ParcAsterix', {includePersistent: true});
  });

  const withResponse = (body: unknown) => {
    const park = new ParcAsterix();
    vi.spyOn(park as any, 'fetchPolling').mockResolvedValue({json: async () => body});
    return park;
  };

  it('throws rather than reading a GraphQL error as an empty park', async () => {
    await expect(
      withResponse({errors: [{message: 'Internal server error'}]})['getPolling'](),
    ).rejects.toThrow(/Internal server error/);
  });

  // The dangerous shape: structurally valid, a full attraction bill, and an
  // empty show bill only because the resolver failed. Every guard downstream
  // reads that as a park where every show is dark.
  it('throws on a partial failure that still carried data', async () => {
    await expect(
      withResponse({
        data: {paxLatencies: [{drupalId: '31303'}], paxSchedules: []},
        errors: [{message: 'schedules resolver timed out'}],
      })['getPolling'](),
    ).rejects.toThrow(/schedules resolver timed out/);
  });

  it('throws when either bill is missing, naming the one that is', async () => {
    await expect(
      withResponse({data: {paxLatencies: []}})['getPolling'](),
    ).rejects.toThrow(/paxSchedules/);
    await expect(
      withResponse({data: {paxSchedules: []}})['getPolling'](),
    ).rejects.toThrow(/paxLatencies/);
    await expect(withResponse({data: {}})['getPolling']()).rejects.toThrow(
      /paxLatencies or paxSchedules/,
    );
  });

  // What an upstream schema change actually delivers: present, truthy, wrong.
  it('throws when a bill is not an array', async () => {
    await expect(
      withResponse({data: {paxLatencies: {}, paxSchedules: []}})['getPolling'](),
    ).rejects.toThrow(/paxLatencies/);
  });

  it('accepts a legitimately empty bill', async () => {
    await expect(
      withResponse({data: {paxLatencies: [], paxSchedules: []}})['getPolling'](),
    ).resolves.toEqual({latencies: [], schedules: []});
  });

  it('accepts an empty errors array beside good data', async () => {
    await expect(
      withResponse({data: {paxLatencies: [], paxSchedules: []}, errors: []})['getPolling'](),
    ).resolves.toEqual({latencies: [], schedules: []});
  });
});

describe('showBillAuthority', () => {
  const hours = (date: string, open: string, close: string) => ({
    date,
    type: 'OPERATING',
    openingTime: `${date}T${open}+02:00`,
    closingTime: `${date}T${close}+02:00`,
  });
  const TODAY = hours('2026-09-09', '10:00:00', '18:00:00');
  const at = (iso: string) => new Date(iso);

  it('reads the bill once the park has opened', () => {
    expect(showBillAuthority(at('2026-09-09T08:30:00Z'), 'Europe/Paris', [TODAY], true))
      .toBe('read-bill'); // 10:30 local
  });

  // The hole the 06:00 guard alone left open: the bill served between midnight
  // and the morning rewrite is the last open day's, so absence from it means
  // "was not on that day", not "is not on today".
  it('calls the bill stale between the small hours and opening', () => {
    for (const utc of ['2026-09-09T04:30:00Z', '2026-09-09T06:00:00Z', '2026-09-09T07:28:00Z']) {
      expect(showBillAuthority(at(utc), 'Europe/Paris', [TODAY], false)).toBe('stale');
    }
  });

  // The sharp one: a Halloween night runs 19:00 to 01:00 into a day the park
  // does not operate. Without the night guard the closed-day branch fires at
  // 00:30 and closes every show while the night is still running.
  it('stays silent past midnight when the next day is a closed day', () => {
    const night = {
      date: '2026-10-17',
      type: 'TICKETED_EVENT',
      openingTime: '2026-10-17T19:00:00+02:00',
      closingTime: '2026-10-18T01:00:00+02:00',
    };
    expect(showBillAuthority(at('2026-10-17T22:30:00Z'), 'Europe/Paris', [night], false))
      .toBe('unknown'); // 00:30 local on the 18th, which carries no hours
  });

  it('stays silent in the after-midnight tail of an event night', () => {
    const night = {
      date: '2026-10-17',
      type: 'TICKETED_EVENT',
      openingTime: '2026-10-17T19:00:00+02:00',
      closingTime: '2026-10-18T01:00:00+02:00',
    };
    expect(showBillAuthority(at('2026-10-17T23:30:00Z'), 'Europe/Paris', [night], true))
      .toBe('unknown'); // 01:30 local on the 18th
  });

  // Closed days carry no hours, so they never reach the calendar. The bill
  // keeps serving the last open day's programme straight through them.
  it('calls every show dark on a day the park does not operate', () => {
    expect(showBillAuthority(at('2026-09-10T10:00:00Z'), 'Europe/Paris', [TODAY], false))
      .toBe('all-dark');
  });

  // A calendar that says closed while the rides say open is a calendar to
  // distrust, not a park to close.
  it('defers to the live feed when it contradicts a closed calendar', () => {
    expect(showBillAuthority(at('2026-09-10T10:00:00Z'), 'Europe/Paris', [TODAY], true))
      .toBe('unknown');
  });

  it('admits it cannot tell with no calendar at all', () => {
    expect(showBillAuthority(at('2026-09-09T10:00:00Z'), 'Europe/Paris', [], false))
      .toBe('unknown');
  });

  /**
   * The window a fixed 06:00 cutoff left open. Between local midnight and 06:00
   * the bill is still the last open day's, and treating that as authoritative
   * republished a passed day's programme under tonight's date — which is what
   * the wiki was serving at 00:20 on 2026-09-09, times and all.
   *
   * The park's own hours answer it exactly: nothing is running, so there is
   * nothing to say.
   */
  it('calls the bill stale in the small hours of an ordinary open day', () => {
    // 00:30 and 03:00 local on the 9th, a day that opens at 10:00.
    for (const utc of ['2026-09-08T22:30:00Z', '2026-09-09T01:00:00Z']) {
      expect(showBillAuthority(at(utc), 'Europe/Paris', [TODAY], false)).toBe('stale');
    }
  });

  /**
   * The same hours on a closed day. The bill is retained across closures, so
   * before this the small hours published the last open day's performances
   * re-dated onto a day the park never opens.
   */
  it('calls every show dark from midnight on a closed day', () => {
    // 00:30 local on the 10th; the calendar has the 9th and stops.
    expect(showBillAuthority(at('2026-09-09T22:30:00Z'), 'Europe/Paris', [TODAY], false))
      .toBe('all-dark');
  });

  it('still lets the live feed veto a closed calendar in the small hours', () => {
    expect(showBillAuthority(at('2026-09-09T22:30:00Z'), 'Europe/Paris', [TODAY], true))
      .toBe('unknown');
  });

  /**
   * A finished day is not a running one. Yesterday's row is in the calendar
   * now, so the mid-session test has to key off its closing time rather than
   * its mere presence.
   */
  it('does not treat a day that has already closed as still running', () => {
    const yesterday = hours('2026-09-08', '10:00:00', '18:00:00');
    expect(showBillAuthority(at('2026-09-08T22:30:00Z'), 'Europe/Paris', [yesterday, TODAY], false))
      .toBe('stale'); // 00:30 on the 9th, the 8th shut six hours ago
  });

  /**
   * The other end of the same window, and a live regression: on 2026-09-09 the
   * feed reverted to its default programme at 18:50, fifty minutes after the
   * 18:00 close. Read as authoritative, it reopened three shows that had not
   * performed all day — 31497, 31508 and 31519, all correctly closed at 11:51 —
   * and republished their elapsed times on a shut park.
   */
  it('calls the bill stale once the park has closed', () => {
    // 18:30, 20:00 and 23:45 local on a day that shuts at 18:00.
    for (const utc of ['2026-09-09T16:30:00Z', '2026-09-09T18:00:00Z', '2026-09-09T21:45:00Z']) {
      expect(showBillAuthority(at(utc), 'Europe/Paris', [TODAY], true)).toBe('stale');
    }
  });

  it('still reads the bill right up to closing', () => {
    expect(showBillAuthority(at('2026-09-09T15:59:00Z'), 'Europe/Paris', [TODAY], true))
      .toBe('read-bill'); // 17:59 local, one minute before the 18:00 close
    expect(showBillAuthority(at('2026-09-09T16:01:00Z'), 'Europe/Paris', [TODAY], true))
      .toBe('stale');     // 18:01 local
  });

  /**
   * A day with two sessions is bounded by the outermost pair, not by whichever
   * range happens to sort first.
   */
  it('spans a split day from its first opening to its last close', () => {
    const morning = hours('2026-09-09', '10:00:00', '13:00:00');
    const evening = hours('2026-09-09', '17:00:00', '22:00:00');
    const split = [morning, evening];
    expect(showBillAuthority(at('2026-09-09T13:00:00Z'), 'Europe/Paris', split, true))
      .toBe('read-bill'); // 15:00 local, between the two sessions but inside the day
    expect(showBillAuthority(at('2026-09-09T20:30:00Z'), 'Europe/Paris', split, true))
      .toBe('stale');     // 22:30 local, past the last close
  });

  /**
   * An event night's close is already rolled to the next day, so the upper
   * bound must not cut it off at midnight.
   */
  it('keeps reading the bill through an event night, past midnight', () => {
    const night = {
      date: '2026-10-17',
      type: 'TICKETED_EVENT',
      openingTime: '2026-10-17T19:00:00+02:00',
      closingTime: '2026-10-18T01:00:00+02:00',
    };
    expect(showBillAuthority(at('2026-10-17T21:00:00Z'), 'Europe/Paris', [night], true))
      .toBe('read-bill'); // 23:00 local on the 17th, the night is running
  });

  /** The boundary: the session's own closing minute is the last one it owns. */
  it('stops trusting the bill the moment the night closes', () => {
    const night = {
      date: '2026-10-17',
      type: 'TICKETED_EVENT',
      openingTime: '2026-10-17T19:00:00+02:00',
      closingTime: '2026-10-18T01:00:00+02:00',
    };
    const nextDayOpen = hours('2026-10-18', '10:00:00', '18:00:00');
    expect(showBillAuthority(at('2026-10-17T22:59:00Z'), 'Europe/Paris', [night, nextDayOpen], false))
      .toBe('unknown'); // 00:59 local, one minute of the night left
    expect(showBillAuthority(at('2026-10-17T23:01:00Z'), 'Europe/Paris', [night, nextDayOpen], false))
      .toBe('stale');   // 01:01 local, the night is over and the 18th opens at 10:00
  });
});
