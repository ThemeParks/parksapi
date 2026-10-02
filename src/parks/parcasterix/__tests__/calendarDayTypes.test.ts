import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ParcAsterix} from '../parcasterix.js';

/**
 * In September 2026 the offline package stopped writing a legend key into
 * `calendar_items.type`. Every row now carries a free-text French sentence
 * instead, identical in every culture's database, and the sentence is not any
 * legend label's value either: the legend reads "10h - 19h" (fr) or
 * "10:00 a.m. - 7:00 p.m." (en) while the day reads "Parc ouvert de 10h à 19h".
 *
 * Looked up as a key, none of those sentences matched, so every day was
 * classed as unreadable and the park published no schedule at all.
 *
 * The strings below are verbatim from the live package on 2026-09-25.
 */
const LIVE_DAY_TYPES = [
  'Parc fermé',
  'Parc ouvert de 10h à 18h',
  'Parc ouvert de 10h à 19h',
  'Parc ouvert de 10h à 22h',
  'Été Gaulois - 10h à 22h',
  'Peur sur le Parc - 9h à 18h',
  'Peur sur le Parc : journée 9h - 18h et nocturne 19h - 01h',
  'Nocturne Peur sur le Parc : 19h à 01h',
  'Noël Gaulois 11h à 20h',
  'Noël Gaulois 11h à 19h',
];

/** The English legend the same package ships, keyed the old way. */
const LIVE_EN_LEGEND: Record<string, string> = {
  A: '10:00 a.m. to 6:00 p.m.',
  B: '10:00 a.m. - 7:00 p.m. Peur sur le Parc',
  D: 'Theme Park closed',
  H: '10:00 a.m. - 7:00 p.m.',
  J: 'Daytime 9:00 a.m. - 6:00 p.m. and Evening 7:00 p.m. - 1:00 a.m. Peur sur le Parc',
  M: '7pm - 01am',
};

/**
 * Build a package database with the live schema. Only the calendar tables
 * carry data; the POI tables exist because the loader queries them.
 */
function packageDb(days: Array<[string, string]>, legend: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'pax-cal-'));
  const file = join(dir, 'pax_en.sqlite');
  try {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE attractions (drupal_id INTEGER, title TEXT, experience TEXT, latitude REAL, longitude REAL, min_age INTEGER, min_size INTEGER, min_size_unaccompanied INTEGER);
      CREATE TABLE restaurants (drupal_id INTEGER, title TEXT, meal_types TEXT, latitude REAL, longitude REAL, menu_url TEXT, mobile_url TEXT);
      CREATE TABLE shows (drupal_id INTEGER, title TEXT, duration TEXT, latitude REAL, longitude REAL);
      CREATE TABLE "calendar_items" ("day" date not null, "time" varchar, "type" varchar not null);
      CREATE TABLE labels (key TEXT, value TEXT);
    `);
    const day = db.prepare('INSERT INTO calendar_items (day, time, type) VALUES (?, NULL, ?)');
    for (const [date, type] of days) day.run(`${date} 00:00:00`, type);
    const label = db.prepare('INSERT INTO labels (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(legend)) label.run(`calendar.dateType.legend.${k}`, v);
    // Non-legend calendar labels live alongside and must be ignored.
    label.run('calendar.dateType.info.H', 'Park open, 10:00 a.m. - 7:00 p.m.');
    db.close();
    return readFileSync(file);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

function load(days: Array<[string, string]>, legend: Record<string, string> = LIVE_EN_LEGEND) {
  const park = new ParcAsterix();
  return (park as any).loadSqliteDatabase(packageDb(days, legend), 'en') as {
    calendar: Array<{date: string; type: string; openingTime: string; closingTime: string}>;
    closedDates: Set<string>;
  };
}

describe('calendar day types written as sentences', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  it('reads the hours of an ordinary open day', () => {
    const {calendar, closedDates} = load([['2026-09-26', 'Parc ouvert de 10h à 19h']]);
    expect(calendar).toEqual([{
      date: '2026-09-26',
      type: 'OPERATING',
      openingTime: '2026-09-26T10:00:00+02:00',
      closingTime: '2026-09-26T19:00:00+02:00',
    }]);
    expect(closedDates.size).toBe(0);
  });

  it('reads every day type the live package carries, and only "Parc fermé" as closed', () => {
    const days = LIVE_DAY_TYPES.map((type, i): [string, string] =>
      [`2026-10-${String(i + 1).padStart(2, '0')}`, type]);
    const {calendar, closedDates} = load(days);

    expect([...closedDates]).toEqual(['2026-10-01']);
    const withHours = new Set(calendar.map((e) => e.date));
    for (const [date, type] of days.slice(1)) {
      expect(withHours.has(date), type).toBe(true);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads "-" as well as "à" between times', () => {
    const {calendar} = load([['2026-10-03', 'Peur sur le Parc - 9h à 18h']]);
    expect(calendar).toHaveLength(1);
    expect(calendar[0].openingTime).toBe('2026-10-03T09:00:00+02:00');
    expect(calendar[0].closingTime).toBe('2026-10-03T18:00:00+02:00');
  });

  it('keeps both sessions of a day-and-night day, the night one past midnight', () => {
    const {calendar} = load([
      ['2026-10-10', 'Peur sur le Parc : journée 9h - 18h et nocturne 19h - 01h'],
    ]);
    expect(calendar).toEqual([
      {
        date: '2026-10-10',
        type: 'OPERATING',
        openingTime: '2026-10-10T09:00:00+02:00',
        closingTime: '2026-10-10T18:00:00+02:00',
      },
      {
        date: '2026-10-10',
        type: 'TICKETED_EVENT',
        openingTime: '2026-10-10T19:00:00+02:00',
        closingTime: '2026-10-11T01:00:00+02:00',
      },
    ]);
  });

  it('carries a night-only session over midnight', () => {
    const {calendar} = load([['2026-10-16', 'Nocturne Peur sur le Parc : 19h à 01h']]);
    expect(calendar).toEqual([{
      date: '2026-10-16',
      type: 'TICKETED_EVENT',
      openingTime: '2026-10-16T19:00:00+02:00',
      closingTime: '2026-10-17T01:00:00+02:00',
    }]);
  });

  it('uses the winter offset once the clocks go back', () => {
    const {calendar} = load([['2026-12-26', 'Noël Gaulois 11h à 20h']]);
    expect(calendar[0].openingTime).toBe('2026-12-26T11:00:00+01:00');
    expect(calendar[0].closingTime).toBe('2026-12-26T20:00:00+01:00');
  });

  /**
   * A sentence that names a time we cannot pair into a range is a parser gap.
   * Closing the park on it would publish CLOSED over a day that is open.
   */
  it('treats a sentence with an unreadable time as unreadable, never closed', () => {
    const {calendar, closedDates} = load([['2026-10-20', 'Parc ouvert à partir de 19h']]);
    expect(calendar).toEqual([]);
    expect(closedDates.size).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  /**
   * A bare code with no legend entry is the old shape with a label missing,
   * not a sentence. It carries no clock time only because it carries no words,
   * so it must not be read as the park saying it is shut.
   */
  it('does not read an unknown bare legend code as closed', () => {
    const {calendar, closedDates} = load([['2026-10-21', 'Z']]);
    expect(calendar).toEqual([]);
    expect(closedDates.size).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('calendar day types written as legend keys', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('still resolves the old key shape through the legend', () => {
    const {calendar, closedDates} = load([
      ['2026-09-26', 'H'],
      ['2026-09-27', 'D'],
      ['2026-10-10', 'J'],
    ]);
    expect([...closedDates]).toEqual(['2026-09-27']);
    expect(calendar.filter((e) => e.date === '2026-09-26')).toEqual([{
      date: '2026-09-26',
      type: 'OPERATING',
      openingTime: '2026-09-26T10:00:00+02:00',
      closingTime: '2026-09-26T19:00:00+02:00',
    }]);
    expect(calendar.filter((e) => e.date === '2026-10-10')).toHaveLength(2);
  });
});
