import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
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

function calendarOf(entries: Array<{month: number; day: number; data: any; year?: number}>) {
  const years: any = {};
  for (const {month, day, data, year} of entries) {
    const y = year ?? 2026;
    years[y] ??= {months: {}};
    years[y].months[month] ??= {monthNumber: month, days: {}};
    years[y].months[month].days[String(day)] = data;
  }
  return {calendar: years};
}

/** AUG_28 with the override swapped for whatever an editor might have typed. */
const typed = (value: unknown) => ({...AUG_28, customOpeningHourToDisplay: value});

/** 31 Oct 2026 — Halloween, a real nocturne day. Override and default agree. */
const OCT_31 = {
  dayNumber: 31,
  localizedDay: '31 oktober 2026',
  events: ['/content/dam/wbe/nl/opening-hour-events/halloween-nocturnes'],
  openingHour: '10:00',
  closingHour: '22:00',
  ticket: null,
  customOpeningHourToDisplay: '10:00 - 22:00',
  closed: false,
  soldOut: false,
  crowdy: true,
};

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

  /**
   * The override is free text, so an editor can type a window that does not
   * move forwards. `18:00 - 10:00` is a transposition, `18:00 - 18:00` a
   * half-finished edit, and `10:00 - 01:00` a nocturne this schedule shape
   * cannot express — both times are pinned to the same date, so it would
   * publish a close before its own open, and nothing downstream rejects that.
   * The three are indistinguishable from each other in free text, so all
   * three fall back to the season default.
   */
  test.each([
    ['a transposed window', '18:00 - 10:00'],
    ['a zero-length window', '18:00 - 18:00'],
    ['a window ending on the midnight hour', '10:00 - 00:00'],
  ])('an override with %s falls back to the structured hours', async (_label, value) => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: typed(value)}]),
    );

    expect(schedule[0].openingTime).toBe('2026-08-28T10:00:00+02:00');
    expect(schedule[0].closingTime).toBe('2026-08-28T20:00:00+02:00');
  });

  test('an after-midnight override falls back rather than closing before it opened', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 10, day: 31, data: {...OCT_31, customOpeningHourToDisplay: '10:00 - 01:00'}}]),
    );

    expect(schedule[0].openingTime).toBe('2026-10-31T10:00:00+01:00');
    expect(schedule[0].closingTime).toBe('2026-10-31T22:00:00+01:00');
  });

  /**
   * The ordering guard compares minutes, not hours. A late same-day close and
   * a window opening on the midnight hour both move forwards and must survive
   * it — `00:00` is a time, not a falsy.
   */
  test('a late but same-day override still wins', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 10, day: 31, data: {...OCT_31, customOpeningHourToDisplay: '10:00 - 23:30'}}]),
    );

    expect(schedule[0].closingTime).toBe('2026-10-31T23:30:00+01:00');
  });

  test('an override opening at midnight still wins', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{
        month: 8,
        day: 28,
        data: {...AUG_28, openingHour: '00:00', closingHour: '05:00', customOpeningHourToDisplay: '00:00 - 06:00'},
      }]),
    );

    expect(schedule[0].openingTime).toBe('2026-08-28T00:00:00+02:00');
    expect(schedule[0].closingTime).toBe('2026-08-28T06:00:00+02:00');
  });

  test('an override running backwards inside the same hour falls back', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: typed('10:30 - 10:15')}]),
    );

    expect(schedule[0].closingTime).toBe('2026-08-28T20:00:00+02:00');
  });

  /**
   * The override carries both times, so it stands on its own: a day whose
   * structured pair the CMS left empty is still published from it. Before the
   * hours were resolved ahead of the guard, that day was dropped silently.
   */
  test('a valid override carries a day whose structured hours are missing', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: {...AUG_28, openingHour: '', closingHour: null}}]),
    );

    expect(schedule).toHaveLength(1);
    expect(schedule[0].openingTime).toBe('2026-08-28T10:00:00+02:00');
    expect(schedule[0].closingTime).toBe('2026-08-28T18:00:00+02:00');
  });

  test('a day with neither structured hours nor a readable override is not published', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: {...AUG_28, openingHour: '', closingHour: null, customOpeningHourToDisplay: 'gesloten'}}]),
    );

    expect(schedule).toHaveLength(0);
  });

  test('a closed or sold-out day is not resurrected by its override', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([
        {month: 8, day: 28, data: {...AUG_28, closed: true}},
        {month: 8, day: 29, data: {...AUG_28, dayNumber: 29, soldOut: true}},
      ]),
    );

    expect(schedule).toHaveLength(0);
  });

  /**
   * The separator and the padding are where the regex earns its keep. The CMS
   * stores the field verbatim, so whatever the editor's keyboard or paste
   * produced survives into the feed — including the non-breaking space a
   * paste from Word leaves behind, and a dash that is not the ASCII one.
   */
  test.each([
    ['no spaces', '10:00-18:00'],
    ['an en dash', '10:00 – 18:00'],
    ['an em dash', '10:00 — 18:00'],
    ['a non-breaking hyphen', '10:00 ‑ 18:00'],
    ['a minus sign', '10:00 − 18:00'],
    ['a non-breaking space', '10:00 - 18:00'],
    ['padding either side', '  10:00 - 18:00  '],
    ['a trailing newline', '10:00 - 18:00\n'],
  ])('an override written with %s is still read', async (_label, value) => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: typed(value)}]),
    );

    expect(schedule[0].closingTime).toBe('2026-08-28T18:00:00+02:00');
  });

  test('a single-digit hour is padded, not published as 9:30', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: typed('9:30 - 18:00')}]),
    );

    expect(schedule[0].openingTime).toBe('2026-08-28T09:30:00+02:00');
  });

  /**
   * Everything else falls back. Editors do type prose into this field —
   * Walibi Holland's 31 October row carries a sold-out notice in it — and the
   * sibling feeds show the other shapes free text takes.
   */
  test.each([
    ['dot separated', '10.00 - 18.00'],
    ['a Dutch suffix', '10:00 - 18:00 uur'],
    ['French hour marks', '10h00 - 18h00'],
    ['event wording', 'Halloween 10:00 - 22:00'],
    ['a sold-out notice', 'Early bird tickets uitverkocht - binnenkort komen de reguliere tickets beschikbaar'],
    ['a third time', '10:00 - 18:00 - 22:00'],
    ['nothing but whitespace', '   '],
    ['an hour no clock holds', '10:00 - 24:00'],
    ['a minute no clock holds', '10:00 - 18:60'],
  ])('an override written with %s leaves the structured hours in place', async (_label, value) => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: typed(value)}]),
    );

    expect(schedule[0].openingTime).toBe('2026-08-28T10:00:00+02:00');
    expect(schedule[0].closingTime).toBe('2026-08-28T20:00:00+02:00');
  });

  /** The field is whatever the CMS serialises, and that is not always a string. */
  test.each([
    ['null', null],
    ['a number', 1018],
    ['an array', ['10:00 - 18:00']],
    ['an object', {from: '10:00', to: '18:00'}],
  ])('an override sent as %s leaves the structured hours in place', async (_label, value) => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: typed(value)}]),
    );

    expect(schedule[0].closingTime).toBe('2026-08-28T20:00:00+02:00');
  });

  test('a day that omits the field entirely keeps the structured hours', async () => {
    const {customOpeningHourToDisplay: _omitted, ...noField} = AUG_28;
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: noField}]),
    );

    expect(schedule[0].closingTime).toBe('2026-08-28T20:00:00+02:00');
  });

  /**
   * An unreadable override reverts us to `closingHour` — the field this whole
   * method exists because it goes stale — so it says so, once per distinct
   * string rather than once per poll.
   */
  test('an unreadable override is logged once per distinct value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await scheduleFor(
        new WalibiBelgium(),
        calendarOf([
          {month: 8, day: 28, data: typed('10:00 tot 18:00')},
          {month: 8, day: 29, data: {...typed('10:00 tot 18:00'), dayNumber: 29}},
          {month: 8, day: 30, data: {...typed('11u - 19u'), dayNumber: 30}},
        ]),
      );

      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.filter((m) => m.includes('10:00 tot 18:00'))).toHaveLength(1);
      expect(messages.filter((m) => m.includes('11u - 19u'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('an empty override is not treated as unreadable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await scheduleFor(new WalibiBelgium(), calendarOf([{month: 12, day: 21, data: DEC_21}]));
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('customOpeningHourToDisplay'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The override is read per day inside three nested loops, and the real feed
   * carries ten months across two years at a time. What matters is that one
   * day's override stays on that day.
   */
  test('each day in a full calendar gets its own answer', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([
        {month: 8, day: 28, data: AUG_28},
        {month: 8, day: 30, data: {...AUG_28, dayNumber: 30, closed: true}},
        {month: 9, day: 5, data: SEP_05},
        {month: 12, day: 21, data: DEC_21},
        {month: 1, day: 2, year: 2027, data: {...DEC_21, dayNumber: 2, customOpeningHourToDisplay: '11:00 - 17:00'}},
      ]),
    );

    expect(schedule.map((s: any) => [s.date, s.closingTime])).toEqual([
      ['2026-08-28', '2026-08-28T18:00:00+02:00'],
      ['2026-09-05', '2026-09-05T18:00:00+02:00'],
      ['2026-12-21', '2026-12-21T19:00:00+01:00'],
      ['2027-01-02', '2027-01-02T17:00:00+01:00'],
    ]);
  });

  /** The date comes from `monthNumber`, not the key the month is filed under. */
  test('the override lands on the date the feed means, not the key', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      {calendar: {2026: {months: {'0': {monthNumber: 8, days: {'28': AUG_28}}}}}},
    );

    expect(schedule[0].date).toBe('2026-08-28');
    expect(schedule[0].closingTime).toBe('2026-08-28T18:00:00+02:00');
  });

  /**
   * Both offsets, on the override path. The Walibi Winter case above takes the
   * fallback path, so without these an override has only ever been proved in
   * summer time — and 25 October is the day Brussels changes.
   */
  test('an override on the day the clocks go back is stamped +01:00', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{
        month: 10,
        day: 25,
        data: {...AUG_28, dayNumber: 25, closingHour: '20:00', customOpeningHourToDisplay: '10:00 - 18:00'},
      }]),
    );

    expect(schedule[0].openingTime).toBe('2026-10-25T10:00:00+01:00');
    expect(schedule[0].closingTime).toBe('2026-10-25T18:00:00+01:00');
  });

  test('an override on the day the clocks go forward is stamped +02:00', async () => {
    const schedule = await scheduleFor(
      new WalibiBelgium(),
      calendarOf([{
        month: 3,
        day: 29,
        data: {...AUG_28, dayNumber: 29, closingHour: '20:00', customOpeningHourToDisplay: '10:00 - 18:00'},
      }]),
    );

    expect(schedule[0].openingTime).toBe('2026-03-29T10:00:00+02:00');
    expect(schedule[0].closingTime).toBe('2026-03-29T18:00:00+02:00');
  });

  /** The override changes the hours, never which entity or which day type. */
  test('the schedule still belongs to the park entity and stays OPERATING', async () => {
    const [entry] = await stubbedPark(
      new WalibiBelgium(),
      calendarOf([{month: 8, day: 28, data: AUG_28}]),
    ).getSchedules();

    expect(entry.id).toBe('walibibelgiumpark');
    expect((entry.schedule as any)[0].type).toBe('OPERATING');
  });
});
