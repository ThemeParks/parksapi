/**
 * datetime helpers cache their Intl.DateTimeFormat instances. Building one
 * loads ICU zone data; schedule builders call these helpers thousands of times
 * per sync, and per-call construction was a sixth of the CPU time in a long-running process
 * with every park loaded.
 */

import { describe, test, expect, vi, afterEach } from 'vitest';
import { constructDateTime, formatDate, formatInTimezone, localFromFakeUtc } from '../datetime.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('datetime formatter cache', () => {
  test('repeat calls build no new formatters', () => {
    // Warm every formatter shape for this zone.
    const at = new Date('2026-07-15T12:00:00Z');
    const warm = () => {
      constructDateTime('2026-07-15', '10:00', 'Asia/Tokyo');
      formatDate(at, 'Asia/Tokyo');
      formatInTimezone(at, 'Asia/Tokyo', 'iso');
      formatInTimezone(at, 'Asia/Tokyo', 'date');
      formatInTimezone(at, 'Asia/Tokyo', 'datetime');
      localFromFakeUtc('2026-07-15T10:00:00Z', 'Asia/Tokyo');
    };
    warm();

    const spy = vi.spyOn(Intl, 'DateTimeFormat');
    for (let i = 0; i < 50; i++) warm();
    expect(spy).not.toHaveBeenCalled();
  });

  test('cached formatters keep zones apart', () => {
    const at = new Date('2026-07-15T23:30:00Z');
    expect(formatDate(at, 'Asia/Tokyo')).toBe('2026-07-16');
    expect(formatDate(at, 'America/New_York')).toBe('2026-07-15');
    expect(formatDate(at, 'Asia/Tokyo')).toBe('2026-07-16');
    expect(formatInTimezone(at, 'Asia/Tokyo')).toBe('2026-07-16T08:30:00+09:00');
    expect(formatInTimezone(at, 'America/New_York')).toBe('2026-07-15T19:30:00-04:00');
  });

  test('an invalid zone throws every time, not only the first', () => {
    const at = new Date('2026-07-15T12:00:00Z');
    expect(() => formatDate(at, 'Not/AZone')).toThrow(RangeError);
    expect(() => formatDate(at, 'Not/AZone')).toThrow(RangeError);
  });
});
