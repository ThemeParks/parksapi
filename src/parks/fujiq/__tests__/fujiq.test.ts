import {describe, test, expect, vi, beforeEach, afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {FujiQHighland} from '../fujiq.js';
import {CacheLib} from '../../../cache.js';
import type {HTTPObj} from '../../../http.js';

const here = dirname(fileURLToPath(import.meta.url));
// The park's own December 2026 schedule table, as published.
const december = readFileSync(resolve(here, 'fixtures/schedule-202612.html'), 'utf8');

function stubbedPark(pages: Record<string, string>) {
  const park = new FujiQHighland({config: {apiBase: 'https://api.invalid', websiteBase: 'https://web.invalid'}});
  const fetch = vi.fn(async (year: number, month: number) => {
    const html = pages[`${year}${String(month).padStart(2, '0')}`] ?? '';
    return {text: async () => html} as any as HTTPObj;
  });
  park.fetchScheduleHtml = fetch as any;
  return {park, fetch};
}

describe('Fuji-Q Highland schedules', () => {
  beforeEach(() => {
    CacheLib.clearAll();
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-12-01T03:00:00Z')); // 12:00 in Tokyo
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('a late close past midnight ("9:00 - 25:00" on the 31st) ends at 01:00 on the 1st', async () => {
    const {park} = stubbedPark({'202612': december});
    const [schedule] = await park.getSchedules();
    const days = schedule.schedule!;

    // 31 days in December, the 10th is a closed day ("-").
    expect(days).toHaveLength(30);
    expect(days.find((d) => d.date === '2026-12-10')).toBeUndefined();

    const nye = days.find((d) => d.date === '2026-12-31')!;
    expect(nye.openingTime).toBe('2026-12-31T09:00:00+09:00');
    expect(nye.closingTime).toBe('2027-01-01T01:00:00+09:00');

    const ordinary = days.find((d) => d.date === '2026-12-05')!;
    expect(ordinary.openingTime).toBe('2026-12-05T09:00:00+09:00');
    expect(ordinary.closingTime).toBe('2026-12-05T18:00:00+09:00');
  });

  test('one unreadable day is dropped and named; every other day survives', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = december.replace('<td>9:00 - 25:00</td>', '<td>9:00 - 99:00</td>');
    expect(broken).not.toBe(december);
    const {park} = stubbedPark({'202612': broken});

    const [schedule] = await park.getSchedules();
    const dates = schedule.schedule!.map((d) => d.date);

    expect(dates).toHaveLength(29);
    expect(dates).not.toContain('2026-12-31');
    expect(dates).toContain('2026-12-30');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[FUJIQ\] Skipping schedule day 2026-12-31 \(09:00:00 - 99:00:00\)/));
  });
});
