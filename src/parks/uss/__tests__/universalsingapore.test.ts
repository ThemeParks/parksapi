/**
 * Universal Studios Singapore schedules.
 *
 * Per-day hours come from the operator's park page and are filtered by the
 * availability calendar. These drive the real `buildSchedules()` with the two
 * network-backed accessors stubbed, so nothing leaves the process.
 */

import {describe, test, expect, beforeEach, afterEach, vi} from 'vitest';
import {ScheduleTypeEnum} from '@themeparks/typelib';
import {UniversalSingapore} from '../universalsingapore.js';

const NOW = new Date('2026-10-06T02:00:00Z'); // 10:00 in Singapore

type Hours = [string, {start: string; end: string}][];

function park(hours: Hours, calendar: {Date: string; IsAvailable: boolean}[] = []) {
  const uss = new UniversalSingapore({config: {websiteBase: 'https://park.example'}});
  vi.spyOn(uss as any, 'getHoursMap').mockResolvedValue(hours);
  vi.spyOn(uss as any, 'getCalendar').mockResolvedValue(calendar);
  return uss;
}

async function schedule(uss: UniversalSingapore): Promise<any[]> {
  const out = await (uss as any).buildSchedules();
  expect(out).toHaveLength(1);
  return out[0].schedule;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('UniversalSingapore.buildSchedules', () => {
  test('publishes an open day as OPERATING, a type the schedule definition has', async () => {
    const days = await schedule(park([
      ['2026-10-06', {start: '10:00', end: '20:00'}],
      ['2026-10-07', {start: '10:00', end: '19:00'}],
    ]));

    expect(days.map(d => d.type)).toEqual(['OPERATING', 'OPERATING']);
    for (const d of days) {
      expect(Object.values(ScheduleTypeEnum)).toContain(d.type);
    }
  });

  test('keeps the hours the page states for each day', async () => {
    const days = await schedule(park([
      ['2026-10-06', {start: '10:00', end: '20:00'}],
      ['2026-10-07', {start: '10:00', end: '19:00'}],
    ]));

    expect(days).toEqual([
      {
        date: '2026-10-06',
        type: 'OPERATING',
        openingTime: '2026-10-06T10:00:00+08:00',
        closingTime: '2026-10-06T20:00:00+08:00',
      },
      {
        date: '2026-10-07',
        type: 'OPERATING',
        openingTime: '2026-10-07T10:00:00+08:00',
        closingTime: '2026-10-07T19:00:00+08:00',
      },
    ]);
  });

  test('leaves out a day the availability calendar marks unavailable, keeps one it does not cover', async () => {
    const days = await schedule(park(
      [
        ['2026-10-06', {start: '10:00', end: '20:00'}],
        ['2026-10-07', {start: '10:00', end: '20:00'}],
        ['2026-12-20', {start: '10:00', end: '20:00'}], // beyond the calendar window
      ],
      [
        {Date: '2026-10-06', IsAvailable: true},
        {Date: '2026-10-07', IsAvailable: false},
      ],
    ));

    expect(days.map(d => d.date)).toEqual(['2026-10-06', '2026-12-20']);
    expect(days.every(d => d.type === 'OPERATING')).toBe(true);
  });

  test('publishes nothing when the site base is not configured', async () => {
    const uss = new UniversalSingapore({config: {websiteBase: ''}});
    expect(await (uss as any).buildSchedules()).toEqual([]);
  });
});
