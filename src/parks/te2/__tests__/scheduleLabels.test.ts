import {describe, test, expect, beforeEach, afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {
  WarnerBrosMovieWorld,
  SeaWorldGoldCoast,
  WetNWildGoldCoast,
  ParadiseCountry,
  TE2Destination,
} from '../te2.js';
import {CacheLib} from '../../../cache.js';

/**
 * The venue-hours feed returns, per day, a list of labelled hour windows. The
 * label that carries the park's gate hours is not the same at every venue:
 *
 *  - Sea World, Wet'n'Wild and Paradise Country label it "Gate".
 *  - Movie World labelled it "Gate" until mid 2026, then renamed it to
 *    "Gate Hours". The rename left Movie World with no OPERATING window.
 *
 * "Attractions" (and "Exhibits" at Paradise Country) is the ride hours. It is
 * informational while a gate window exists, and is used as the operating
 * window only on a day that carries no gate window at all.
 *
 * Fixtures are trimmed captures of the real feed for each venue.
 */

type Row = {date: string; type: string; description?: string; openingTime: string; closingTime: string};

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}-venue-hours.json`, import.meta.url), 'utf8'));

async function scheduleFor(park: TE2Destination, data: any): Promise<Row[]> {
  (park as any).getScheduleData = async () => data;
  const out = await (park as any).buildSchedules();
  return out.length ? out[0].schedule : [];
}

const brief = (rows: Row[]) =>
  rows.map(r => [r.date, r.type, r.description ?? null, r.openingTime.slice(11, 16), r.closingTime.slice(11, 16)]);

const operatingByDate = (rows: Row[]) => {
  const map: Record<string, Row[]> = {};
  for (const r of rows.filter(r => r.type === 'OPERATING')) (map[r.date] ||= []).push(r);
  return map;
};

/** A Movie World day (real shape) with its hour list replaced. */
function movieWorldDay(hours: (all: any[]) => any[]) {
  const day = structuredClone(fixture('movieworld').days[0]);
  day.hours = hours(day.hours);
  return {days: [day]};
}

describe('TE2 schedule labels', () => {
  beforeEach(() => CacheLib.clear());
  afterEach(() => CacheLib.clear());

  test('Movie World "Gate Hours" is the operating window', async () => {
    const rows = await scheduleFor(new WarnerBrosMovieWorld(), fixture('movieworld'));

    expect(brief(rows)).toEqual([
      ['2026-09-26', 'OPERATING', 'Gate Hours', '10:00', '17:00'],
      ['2026-09-26', 'INFO', 'Attractions', '10:00', '17:00'],
      ['2026-09-27', 'OPERATING', 'Gate Hours', '10:00', '17:00'],
      ['2026-09-27', 'INFO', 'Attractions', '10:00', '17:00'],
      ['2026-10-11', 'OPERATING', 'Gate Hours', '10:00', '17:00'],
      ['2026-10-11', 'INFO', 'Attractions', '10:00', '17:00'],
    ]);
  });

  test('Sea World "Gate" is still the operating window (old label)', async () => {
    const rows = await scheduleFor(new SeaWorldGoldCoast(), fixture('seaworld'));

    expect(brief(rows)).toEqual([
      ['2026-09-26', 'OPERATING', 'Gate', '10:00', '17:00'],
      ['2026-09-26', 'INFO', 'Attractions', '10:00', '17:00'],
      ['2026-09-27', 'OPERATING', 'Gate', '10:00', '17:00'],
      ['2026-09-27', 'INFO', 'Attractions', '10:00', '17:00'],
      ['2026-10-11', 'OPERATING', 'Gate', '10:00', '17:00'],
      ['2026-10-11', 'INFO', 'Attractions', '10:00', '17:00'],
    ]);
  });

  test('Wet\'n\'Wild output is unchanged, including a gate-only day', async () => {
    const rows = await scheduleFor(new WetNWildGoldCoast(), fixture('wetnwild'));

    expect(brief(rows)).toEqual([
      ['2026-09-26', 'OPERATING', 'Gate', '10:00', '17:00'],
      ['2026-09-26', 'INFO', 'Attractions', '10:00', '17:00'],
      ['2026-10-11', 'OPERATING', 'Gate', '10:00', '17:00'],
      ['2026-10-11', 'INFO', 'Attractions', '10:00', '17:00'],
      ['2026-10-12', 'OPERATING', 'Gate', '10:00', '17:00'],
    ]);
  });

  test('Paradise Country output is unchanged ("Exhibits" stays INFO)', async () => {
    const rows = await scheduleFor(new ParadiseCountry(), fixture('paradisecountry'));

    expect(rows.map(r => [r.date, r.type, r.description ?? null])).toEqual([
      ['2026-09-26', 'OPERATING', 'Gate'],
      ['2026-09-26', 'INFO', 'Exhibits'],
      ['2026-09-27', 'OPERATING', 'Gate'],
      ['2026-09-27', 'INFO', 'Exhibits'],
    ]);
  });

  test('every open day at every venue has exactly one OPERATING window', async () => {
    for (const [name, park] of [
      ['movieworld', new WarnerBrosMovieWorld()],
      ['seaworld', new SeaWorldGoldCoast()],
      ['wetnwild', new WetNWildGoldCoast()],
      ['paradisecountry', new ParadiseCountry()],
    ] as const) {
      const rows = await scheduleFor(park, fixture(name));
      const dates = new Set(rows.map(r => r.date));
      const op = operatingByDate(rows);
      for (const date of dates) expect([name, date, op[date]?.length]).toEqual([name, date, 1]);
    }
  });

  test('a day carrying both "Gate" and "Gate Hours" emits one OPERATING window', async () => {
    const data = movieWorldDay(hours => [{...structuredClone(hours[0]), label: 'Gate'}, ...hours]);
    const rows = await scheduleFor(new WarnerBrosMovieWorld(), data);

    expect(brief(rows)).toEqual([
      ['2026-09-26', 'OPERATING', 'Gate', '10:00', '17:00'],
      ['2026-09-26', 'INFO', 'Attractions', '10:00', '17:00'],
    ]);
  });

  test('a day with only "Attractions" uses it as the operating window', async () => {
    const data = movieWorldDay(hours => hours.filter(h => h.label === 'Attractions'));
    const rows = await scheduleFor(new WarnerBrosMovieWorld(), data);

    expect(brief(rows)).toEqual([
      ['2026-09-26', 'OPERATING', 'Attractions', '10:00', '17:00'],
    ]);
  });

  test('a gate label wins over "Attractions" even when their windows differ', async () => {
    const data = movieWorldDay(hours => hours.map(h => h.label === 'Attractions'
      ? {...h, schedule: {start: '2026-09-26T10:30:00+10:00', end: '2026-09-26T16:30:00+10:00'}}
      : h));
    const rows = await scheduleFor(new WarnerBrosMovieWorld(), data);

    expect(brief(rows)).toEqual([
      ['2026-09-26', 'OPERATING', 'Gate Hours', '10:00', '17:00'],
      ['2026-09-26', 'INFO', 'Attractions', '10:30', '16:30'],
    ]);
  });

  test('a CLOSED gate window does not make "Attractions" the operating window', async () => {
    const data = movieWorldDay(hours => hours.map(h => h.label === 'Gate Hours' ? {...h, status: 'CLOSED'} : h));
    const rows = await scheduleFor(new WarnerBrosMovieWorld(), data);

    expect(brief(rows)).toEqual([
      ['2026-09-26', 'INFO', 'Attractions', '10:00', '17:00'],
    ]);
  });

  test('gate labels match case- and whitespace-insensitively', async () => {
    const data = movieWorldDay(hours => hours.map(h => h.label === 'Gate Hours' ? {...h, label: '  GATE HOURS '} : h));
    const rows = await scheduleFor(new WarnerBrosMovieWorld(), data);

    expect(rows.filter(r => r.type === 'OPERATING').map(r => r.description)).toEqual(['GATE HOURS']);
  });
});
