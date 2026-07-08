/**
 * Tests for the Attractions.io ShowTimes temporal set-algebra evaluator
 * (parseShowTimes / evaluateShowTimeNode / showTimesForDate), exported from the
 * attractionsiov1 park module.
 *
 * Fixtures are the real `ShowTimes` trees captured from Heide Park records data
 * (Toothless Meet & Greet, Peppa Meet & Greet with multiple daily slots, and
 * the Kinderanimation whose schedule varies by weekday).
 */

import {describe, test, expect} from 'vitest';
import {
  parseShowTimes,
  evaluateShowTimeNode,
  showTimesForDate,
  type ShowTimeNode,
} from '../attractionsiov1.js';

const TZ = 'Europe/Berlin';

// ── Real ShowTimes fixtures ─────────────────────────────────────────────────

// Toothless (15556): every day 12:00–12:30 across three weekly blocks Jun 22 → Jul 13.
const TOOTHLESS =
  '{"type":"union","children":[{"type":"intersection","children":[{"type":"range","start":"2026-06-22 00:00:00","end":"2026-06-29 00:00:00"},{"type":"period","offset_date":"2020-01-01 12:00:00","period_length":{"day":1},"range_length":{"minute":30}}]},{"type":"intersection","children":[{"type":"range","start":"2026-06-29 00:00:00","end":"2026-07-06 00:00:00"},{"type":"period","offset_date":"2020-01-01 12:00:00","period_length":{"day":1},"range_length":{"minute":30}}]},{"type":"intersection","children":[{"type":"range","start":"2026-07-06 00:00:00","end":"2026-07-13 00:00:00"},{"type":"period","offset_date":"2020-01-01 12:00:00","period_length":{"day":1},"range_length":{"minute":30}}]}]}';

// Peppa (15555): in the Jul 6–13 block runs daily 11:15 & 12:15 (20 min) plus Mon–Sat 15:30.
const PEPPA =
  '{"type":"union","children":[{"type":"intersection","children":[{"type":"range","start":"2026-06-22 00:00:00","end":"2026-06-29 00:00:00"},{"type":"union","children":[{"type":"intersection","children":[{"type":"period","offset_date":"2018-01-03 00:00:00","period_length":{"day":7},"range_length":{"day":5}},{"type":"period","offset_date":"2020-01-01 12:15:00","period_length":{"day":1},"range_length":{"minute":10}}]},{"type":"intersection","children":[{"type":"period","offset_date":"2018-01-05 00:00:00","period_length":{"day":7},"range_length":{"day":3}},{"type":"period","offset_date":"2020-01-01 11:15:00","period_length":{"day":1},"range_length":{"minute":10}}]},{"type":"intersection","children":[{"type":"union","children":[{"type":"period","offset_date":"2018-01-05 00:00:00","period_length":{"day":7},"range_length":{"day":1}},{"type":"period","offset_date":"2018-01-07 00:00:00","period_length":{"day":7},"range_length":{"day":1}}]},{"type":"period","offset_date":"2020-01-01 15:30:00","period_length":{"day":1},"range_length":{"minute":10}}]}]}]},{"type":"intersection","children":[{"type":"range","start":"2026-06-29 00:00:00","end":"2026-07-06 00:00:00"},{"type":"union","children":[{"type":"period","offset_date":"2020-01-01 12:15:00","period_length":{"day":1},"range_length":{"minute":20}},{"type":"period","offset_date":"2020-01-01 15:30:00","period_length":{"day":1},"range_length":{"minute":20}},{"type":"intersection","children":[{"type":"period","offset_date":"2018-01-04 00:00:00","period_length":{"day":7},"range_length":{"day":4}},{"type":"period","offset_date":"2020-01-01 11:15:00","period_length":{"day":1},"range_length":{"minute":20}}]}]}]},{"type":"intersection","children":[{"type":"range","start":"2026-07-06 00:00:00","end":"2026-07-13 00:00:00"},{"type":"union","children":[{"type":"period","offset_date":"2020-01-01 11:15:00","period_length":{"day":1},"range_length":{"minute":20}},{"type":"period","offset_date":"2020-01-01 12:15:00","period_length":{"day":1},"range_length":{"minute":20}},{"type":"intersection","children":[{"type":"period","offset_date":"2018-01-08 00:00:00","period_length":{"day":7},"range_length":{"day":6}},{"type":"period","offset_date":"2020-01-01 15:30:00","period_length":{"day":1},"range_length":{"minute":20}}]}]}]}]}';

// Kinderanimation (47786): in the Jul 6–13 block Wed→16:30, Tue/Thu/Sun→14:00, Mon/Fri/Sat→15:00.
const KINDERANIMATION =
  '{"type":"union","children":[{"type":"intersection","children":[{"type":"range","start":"2026-06-22 00:00:00","end":"2026-06-29 00:00:00"},{"type":"period","offset_date":"2018-01-08 00:00:00","period_length":{"day":7},"range_length":{"day":2}},{"type":"period","offset_date":"2020-01-01 14:00:00","period_length":{"day":1},"range_length":{"minute":30}}]},{"type":"intersection","children":[{"type":"range","start":"2026-06-29 00:00:00","end":"2026-07-06 00:00:00"},{"type":"union","children":[{"type":"intersection","children":[{"type":"period","offset_date":"2018-01-03 00:00:00","period_length":{"day":7},"range_length":{"day":2}},{"type":"period","offset_date":"2020-01-01 14:00:00","period_length":{"day":1},"range_length":{"minute":30}}]},{"type":"intersection","children":[{"type":"period","offset_date":"2018-01-06 00:00:00","period_length":{"day":7},"range_length":{"day":4}},{"type":"period","offset_date":"2020-01-01 15:00:00","period_length":{"day":1},"range_length":{"minute":30}}]}]}]},{"type":"intersection","children":[{"type":"range","start":"2026-07-06 00:00:00","end":"2026-07-13 00:00:00"},{"type":"union","children":[{"type":"intersection","children":[{"type":"union","children":[{"type":"period","offset_date":"2018-01-05 00:00:00","period_length":{"day":7},"range_length":{"day":2}},{"type":"period","offset_date":"2018-01-08 00:00:00","period_length":{"day":7},"range_length":{"day":1}}]},{"type":"period","offset_date":"2020-01-01 15:00:00","period_length":{"day":1},"range_length":{"minute":30}}]},{"type":"intersection","children":[{"type":"union","children":[{"type":"period","offset_date":"2018-01-02 00:00:00","period_length":{"day":7},"range_length":{"day":1}},{"type":"period","offset_date":"2018-01-04 00:00:00","period_length":{"day":7},"range_length":{"day":1}},{"type":"period","offset_date":"2018-01-07 00:00:00","period_length":{"day":7},"range_length":{"day":1}}]},{"type":"period","offset_date":"2020-01-01 14:00:00","period_length":{"day":1},"range_length":{"minute":30}}]},{"type":"intersection","children":[{"type":"period","offset_date":"2018-01-03 00:00:00","period_length":{"day":7},"range_length":{"day":1}},{"type":"period","offset_date":"2020-01-01 16:30:00","period_length":{"day":1},"range_length":{"minute":30}}]}]}]}]}';

// Bing Live (Alton Towers 6208): daily 13:30 start with no encoded duration,
// across two season ranges (the second, Mar 18 → Nov 16, covers summer).
const BING_LIVE =
  '{"type":"union","children":[{"type":"intersection","children":[{"type":"range","start":"2026-03-14 00:00:00","end":"2026-03-16 00:00:00"},{"type":"period","offset_date":"2020-01-01 13:30:00","period_length":{"day":1}}]},{"type":"intersection","children":[{"type":"range","start":"2026-03-18 00:00:00","end":"2026-11-16 00:00:00"},{"type":"period","offset_date":"2020-01-01 13:30:00","period_length":{"day":1}}]}]}';

// Once Upon A Brick (LEGOLAND California 17568): three daily start times, each a
// period with no range_length (no encoded duration).
const ONCE_UPON_A_BRICK =
  '{"type":"union","children":[{"type":"period","offset_date":"2020-01-01 13:00:00","period_length":{"day":1}},{"type":"period","offset_date":"2020-01-01 14:15:00","period_length":{"day":1}},{"type":"period","offset_date":"2020-01-01 15:30:00","period_length":{"day":1}}]}';

const slot = (start: string, end: string, type = 'Showtime') => ({type, startTime: start, endTime: end});

// Convert an evaluated naive-ms interval to "HH:mm" for compact assertions.
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

describe('parseShowTimes', () => {
  test('parses a valid tree', () => {
    const node = parseShowTimes(TOOTHLESS);
    expect(node).not.toBeNull();
    expect(node?.type).toBe('union');
  });

  test('returns null for null / blank / non-JSON / typeless input', () => {
    expect(parseShowTimes(null)).toBeNull();
    expect(parseShowTimes(undefined)).toBeNull();
    expect(parseShowTimes('')).toBeNull();
    expect(parseShowTimes('   ')).toBeNull();
    expect(parseShowTimes('not json')).toBeNull();
    expect(parseShowTimes('{"foo":1}')).toBeNull();
  });
});

describe('showTimesForDate — real fixtures', () => {
  test('Toothless: daily 12:00–12:30 on an in-season Wednesday', () => {
    expect(showTimesForDate(TOOTHLESS, '2026-07-08', TZ)).toEqual([
      slot('2026-07-08T12:00:00+02:00', '2026-07-08T12:30:00+02:00'),
    ]);
  });

  test('Toothless: empty after the season ends (past Jul 13)', () => {
    expect(showTimesForDate(TOOTHLESS, '2026-08-01', TZ)).toEqual([]);
  });

  test('Peppa: three ordered slots on the same Wednesday', () => {
    expect(showTimesForDate(PEPPA, '2026-07-08', TZ)).toEqual([
      slot('2026-07-08T11:15:00+02:00', '2026-07-08T11:35:00+02:00'),
      slot('2026-07-08T12:15:00+02:00', '2026-07-08T12:35:00+02:00'),
      slot('2026-07-08T15:30:00+02:00', '2026-07-08T15:50:00+02:00'),
    ]);
  });

  test('Kinderanimation: weekday-specific start time (Wed → 16:30)', () => {
    expect(showTimesForDate(KINDERANIMATION, '2026-07-08', TZ)).toEqual([
      slot('2026-07-08T16:30:00+02:00', '2026-07-08T17:00:00+02:00'),
    ]);
  });

  test('Kinderanimation: different weekday, different time (Thu → 14:00)', () => {
    expect(showTimesForDate(KINDERANIMATION, '2026-07-09', TZ)).toEqual([
      slot('2026-07-09T14:00:00+02:00', '2026-07-09T14:30:00+02:00'),
    ]);
  });

  test('honours a custom slot type', () => {
    const [s] = showTimesForDate(TOOTHLESS, '2026-07-08', TZ, 'Meet & Greet');
    expect(s.type).toBe('Meet & Greet');
  });

  test('returns [] for missing/invalid ShowTimes', () => {
    expect(showTimesForDate(null, '2026-07-08', TZ)).toEqual([]);
    expect(showTimesForDate('nonsense', '2026-07-08', TZ)).toEqual([]);
  });

  test('applies the correct offset across DST (winter → +01:00)', () => {
    const winter = '{"type":"range","start":"2026-01-10 10:00:00","end":"2026-01-10 12:00:00"}';
    expect(showTimesForDate(winter, '2026-01-10', TZ)).toEqual([
      slot('2026-01-10T10:00:00+01:00', '2026-01-10T12:00:00+01:00'),
    ]);
  });

  test('point start times (no range_length) are emitted start-only', () => {
    expect(showTimesForDate(BING_LIVE, '2026-07-08', 'Europe/London')).toEqual([
      {type: 'Showtime', startTime: '2026-07-08T13:30:00+01:00'},
    ]);
  });

  test('a union of point periods yields ordered start-only slots', () => {
    expect(showTimesForDate(ONCE_UPON_A_BRICK, '2026-07-08', 'America/Los_Angeles')).toEqual([
      {type: 'Showtime', startTime: '2026-07-08T13:00:00-07:00'},
      {type: 'Showtime', startTime: '2026-07-08T14:15:00-07:00'},
      {type: 'Showtime', startTime: '2026-07-08T15:30:00-07:00'},
    ]);
  });
});

describe('evaluateShowTimeNode — set algebra', () => {
  const day = Date.parse('2026-07-08T00:00:00Z');
  const dayEnd = day + 24 * 60 * 60 * 1000;
  const range = (start: string, end: string): ShowTimeNode => ({type: 'range', start, end});

  test('union merges overlapping intervals', () => {
    const node: ShowTimeNode = {
      type: 'union',
      children: [range('2026-07-08 10:00:00', '2026-07-08 12:00:00'), range('2026-07-08 11:00:00', '2026-07-08 13:00:00')],
    };
    expect(evaluateShowTimeNode(node, day, dayEnd).map(([s, e]) => [hhmm(s), hhmm(e)])).toEqual([['10:00', '13:00']]);
  });

  test('intersection keeps only the overlap', () => {
    const node: ShowTimeNode = {
      type: 'intersection',
      children: [range('2026-07-08 10:00:00', '2026-07-08 14:00:00'), range('2026-07-08 12:00:00', '2026-07-08 18:00:00')],
    };
    expect(evaluateShowTimeNode(node, day, dayEnd).map(([s, e]) => [hhmm(s), hhmm(e)])).toEqual([['12:00', '14:00']]);
  });

  test('difference removes the subtracted span, leaving both remainders', () => {
    const node: ShowTimeNode = {
      type: 'difference',
      children: [range('2026-07-08 10:00:00', '2026-07-08 18:00:00'), range('2026-07-08 12:00:00', '2026-07-08 13:00:00')],
    };
    expect(evaluateShowTimeNode(node, day, dayEnd).map(([s, e]) => [hhmm(s), hhmm(e)])).toEqual([
      ['10:00', '12:00'],
      ['13:00', '18:00'],
    ]);
  });

  test('complement returns the window minus the child', () => {
    const node: ShowTimeNode = {
      type: 'complement',
      children: [range('2026-07-08 10:00:00', '2026-07-08 12:00:00')],
    };
    expect(evaluateShowTimeNode(node, day, dayEnd).map(([s, e]) => [hhmm(s), hhmm(e)])).toEqual([
      ['00:00', '10:00'],
      ['12:00', '00:00'], // 12:00 → next midnight (clipped to window end)
    ]);
  });

  test('a period without range_length yields a point start time', () => {
    const node: ShowTimeNode = {
      type: 'period',
      offset_date: '2020-01-01 12:00:00',
      period_length: {day: 1},
      range_length: {},
    };
    expect(evaluateShowTimeNode(node, day, dayEnd).map(([s, e]) => [hhmm(s), hhmm(e)])).toEqual([
      ['12:00', '12:00'],
    ]);
  });

  test('a point period survives intersection with a containing span', () => {
    const node: ShowTimeNode = {
      type: 'intersection',
      children: [
        range('2026-07-08 00:00:00', '2026-07-09 00:00:00'),
        {type: 'period', offset_date: '2020-01-01 13:30:00', period_length: {day: 1}, range_length: {}},
      ],
    };
    expect(evaluateShowTimeNode(node, day, dayEnd).map(([s, e]) => [hhmm(s), hhmm(e)])).toEqual([
      ['13:30', '13:30'],
    ]);
  });

  test('a point period outside a span is dropped by intersection', () => {
    const node: ShowTimeNode = {
      type: 'intersection',
      children: [
        range('2026-07-08 10:00:00', '2026-07-08 12:00:00'),
        {type: 'period', offset_date: '2020-01-01 13:30:00', period_length: {day: 1}, range_length: {}},
      ],
    };
    expect(evaluateShowTimeNode(node, day, dayEnd)).toEqual([]);
  });

  test('union keeps distinct points and merges a point into a covering interval', () => {
    const node: ShowTimeNode = {
      type: 'union',
      children: [
        range('2026-07-08 10:00:00', '2026-07-08 12:00:00'),
        {type: 'period', offset_date: '2020-01-01 11:00:00', period_length: {day: 1}, range_length: {}},
        {type: 'period', offset_date: '2020-01-01 15:30:00', period_length: {day: 1}, range_length: {}},
      ],
    };
    // 11:00 falls inside 10:00–12:00 (absorbed); 15:30 stands alone as a point.
    expect(evaluateShowTimeNode(node, day, dayEnd).map(([s, e]) => [hhmm(s), hhmm(e)])).toEqual([
      ['10:00', '12:00'],
      ['15:30', '15:30'],
    ]);
  });
});
