import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {WalibiBelgium, WalibiHolland} from '../walibi.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

/**
 * Walibi Belgium's CMS carries two answers for a day's closing time and they
 * disagree. `closingHour` is the season default; `customOpeningHourToDisplay`
 * is the per-day override the editors maintain, and it is what the calendar
 * widget on every page of walibi.be renders.
 *
 * On 28–31 August 2026 the override, the day's `events` asset
 * (`.../opening-hour-events/open-10-18h`) and that asset's title in the site's
 * own calendar feed ("10:00 - 18:00") all said 18:00, while `closingHour` sat
 * on the stale summer value of 20:00. We published 20:00 — two hours of park
 * that was not there.
 *
 * Only Walibi Belgium populates the override today: Bellewaerde, Walibi
 * Holland and Walibi Rhône-Alpes leave it empty on every open day, so the
 * structured fields have to keep working untouched.
 *
 * Fixtures are the real feed rows.
 */

/** 28 Aug 2026 — override and season default disagree. */
const AUG_28 = {
  dayNumber: 28,
  localizedDay: '28 augustus 2026',
  events: ['/content/dam/wbe/nl/opening-hour-events/open-10-18h'],
  openingHour: '10:00',
  closingHour: '20:00',
  ticket: null,
  customOpeningHourToDisplay: '10:00 - 18:00',
  closed: false,
  soldOut: false,
  crowdy: false,
};

/** 5 Sep 2026 — override and season default agree. */
const SEP_05 = {
  dayNumber: 5,
  events: ['/content/dam/wbe/nl/opening-hour-events/open-10-18h'],
  openingHour: '10:00',
  closingHour: '18:00',
  customOpeningHourToDisplay: '10:00 - 18:00',
  closed: false,
  soldOut: false,
};

/** 21 Dec 2026 — Walibi Winter, no override at all. */
const DEC_21 = {
  dayNumber: 21,
  events: ['/content/dam/wbe/nl/opening-hour-events/open-11--19h'],
  openingHour: '11:00',
  closingHour: '19:00',
  customOpeningHourToDisplay: '',
  closed: false,
  soldOut: false,
};

function calendarOf(entries: Array<{month: number; day: number; data: any}>) {
  const months: any = {};
  for (const {month, day, data} of entries) {
    months[month] ??= {monthNumber: month, days: {}};
    months[month].days[String(day)] = data;
  }
  return {calendar: {2026: {months}}};
}

function stubbedPark<T extends {fetchCalendar: any}>(park: T, calendar: any): T {
  park.fetchCalendar = (async () => ({json: async () => calendar} as any as HTTPObj)) as any;
  return park;
}

async function scheduleFor(park: any, calendar: any) {
  const [entry] = await stubbedPark(park, calendar).getSchedules();
  return entry?.schedule ?? [];
}

describe('Walibi — per-day opening-hour override', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('the override wins over a stale season closingHour', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: AUG_28}]),
    );

    expect(schedule).toHaveLength(1);
    expect(schedule[0].date).toBe('2026-08-28');
    expect(schedule[0].openingTime).toBe('2026-08-28T10:00:00+02:00');
    expect(schedule[0].closingTime).toBe('2026-08-28T18:00:00+02:00');
  });

  test('an override that agrees with the season default changes nothing', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 9, day: 5, data: SEP_05}]),
    );

    expect(schedule[0].openingTime).toBe('2026-09-05T10:00:00+02:00');
    expect(schedule[0].closingTime).toBe('2026-09-05T18:00:00+02:00');
  });

  test('a day with no override keeps the structured hours', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 12, day: 21, data: DEC_21}]),
    );

    expect(schedule[0].openingTime).toBe('2026-12-21T11:00:00+01:00');
    expect(schedule[0].closingTime).toBe('2026-12-21T19:00:00+01:00');
  });

  test('an override in a shape we cannot read falls back to the structured hours', async () => {
    const unreadable = {...AUG_28, customOpeningHourToDisplay: 'Halloween 10:00 - 22:00 (nocturne)'};
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: unreadable}]),
    );

    expect(schedule[0].openingTime).toBe('2026-08-28T10:00:00+02:00');
    expect(schedule[0].closingTime).toBe('2026-08-28T20:00:00+02:00');
  });

  test('the parks that never send an override are unaffected', async () => {
    const schedule = await scheduleFor(
      new WalibiHolland(),
      calendarOf([{
        month: 8,
        day: 28,
        data: {dayNumber: 28, events: [], openingHour: '10:00', closingHour: '19:00', closed: false, soldOut: false},
      }]),
    );

    expect(schedule[0].openingTime).toBe('2026-08-28T10:00:00+02:00');
    expect(schedule[0].closingTime).toBe('2026-08-28T19:00:00+02:00');
  });
});
