/**
 * Test datetime utilities
 */

import { describe, test, expect } from '@jest/globals';
import {
  formatInTimezone,
  parseTimeInTimezone,
  nowInTimezone,
  formatUTC,
  addDays,
  isBefore,
  timezone
} from '../datetime.js';

describe('DateTime Utilities', () => {
  describe('formatInTimezone()', () => {
    test('should format date in ISO 8601 format with timezone offset', () => {
      const date = new Date('2025-03-15T14:30:00Z');
      const result = formatInTimezone(date, 'America/New_York', 'iso');

      // Should be in format YYYY-MM-DDTHH:mm:ss±HH:mm or GMT±X
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(GMT[+-]\d+|[+-]\d{2}:\d{2}|Z)$/);
      expect(result).toContain('2025-03-15');
      expect(result).toContain('T');
    });

    test('should format date in date format', () => {
      const date = new Date('2025-03-15T14:30:00Z');
      const result = formatInTimezone(date, 'America/New_York', 'date');

      // Should be in format MM/DD/YYYY
      expect(result).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    });

    test('should format date in datetime format', () => {
      const date = new Date('2025-03-15T14:30:00Z');
      const result = formatInTimezone(date, 'America/New_York', 'datetime');

      // Should contain date and time
      expect(result).toContain('/');
      expect(result).toContain(':');
    });

    test('should handle different timezones', () => {
      const date = new Date('2025-03-15T12:00:00Z');

      const nyTime = formatInTimezone(date, 'America/New_York', 'iso');
      const laTime = formatInTimezone(date, 'America/Los_Angeles', 'iso');
      const londonTime = formatInTimezone(date, 'Europe/London', 'iso');

      // All should be different due to timezone offset
      expect(nyTime).not.toBe(laTime);
      expect(nyTime).not.toBe(londonTime);
      expect(laTime).not.toBe(londonTime);
    });

    test('should handle UTC timezone with offset', () => {
      const date = new Date('2025-03-15T14:30:45Z');
      const result = formatInTimezone(date, 'UTC', 'iso');

      expect(result).toContain('2025-03-15');
      expect(result).toContain('T');
      expect(result).toContain('14:30:45');
      // UTC should have Z, +00:00, or GMT
      expect(result).toMatch(/[Z+GMT]/);
    });

    test('should handle Asian timezones with positive offset', () => {
      const date = new Date('2025-03-15T12:00:00Z');
      const tokyoTime = formatInTimezone(date, 'Asia/Tokyo', 'iso');

      expect(tokyoTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Tokyo is GMT+9
      expect(tokyoTime).toMatch(/(\+|GMT\+)/);
    });

    test('should handle Australian timezones with positive offset', () => {
      const date = new Date('2025-03-15T12:00:00Z');
      const sydneyTime = formatInTimezone(date, 'Australia/Sydney', 'iso');

      expect(sydneyTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      // Sydney is GMT+10 or +11 depending on DST
      expect(sydneyTime).toMatch(/(\+|GMT\+)/);
    });

    test('should default to iso format with offset when not specified', () => {
      const date = new Date('2025-03-15T14:30:00Z');
      const result = formatInTimezone(date, 'America/New_York');

      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result).toContain('2025-03-15');
      expect(result).toContain('T');
      // Should have timezone offset (negative for US East Coast)
      expect(result).toMatch(/(-|GMT-)/);
    });
  });

  describe('parseTimeInTimezone()', () => {
    test('should parse date string with timezone', () => {
      const timeString = '2025-03-15T14:30:00';
      const result = parseTimeInTimezone(timeString, 'America/New_York');

      // Should return ISO string with timezone offset (format may be GMT-4 or -04:00)
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(GMT[+-]\d{1,2}|[+-]\d{2}:\d{2})$/);
    });

    test('should return ISO string as-is if already formatted with Z', () => {
      const timeString = '2025-03-15T14:30:00Z';
      const result = parseTimeInTimezone(timeString, 'America/New_York');

      expect(result).toBe(timeString);
    });

    test('should return ISO string as-is if already formatted with offset', () => {
      const timeString = '2025-03-15T14:30:00+05:00';
      const result = parseTimeInTimezone(timeString, 'America/New_York');

      expect(result).toBe(timeString);
    });

    test('should handle UTC timezone', () => {
      const timeString = '2025-03-15T14:30:00';
      const result = parseTimeInTimezone(timeString, 'UTC');

      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    test('should handle different timezones', () => {
      const timeString = '2025-03-15T14:30:00';

      const nyResult = parseTimeInTimezone(timeString, 'America/New_York');
      const laResult = parseTimeInTimezone(timeString, 'America/Los_Angeles');

      // Both should have timezone offsets
      expect(nyResult).toContain('-');
      expect(laResult).toContain('-');
    });
  });

  describe('nowInTimezone()', () => {
    test('should return a Date object', () => {
      const result = nowInTimezone('America/New_York');
      expect(result).toBeInstanceOf(Date);
    });

    test('should return valid date', () => {
      const result = nowInTimezone('America/New_York');
      expect(result.getTime()).toBeGreaterThan(0);
      expect(isNaN(result.getTime())).toBe(false);
    });

    test('should work with different timezones', () => {
      const ny = nowInTimezone('America/New_York');
      const tokyo = nowInTimezone('Asia/Tokyo');
      const london = nowInTimezone('Europe/London');

      // All should be valid dates
      expect(ny).toBeInstanceOf(Date);
      expect(tokyo).toBeInstanceOf(Date);
      expect(london).toBeInstanceOf(Date);
    });

    test('should return current time (roughly)', () => {
      const before = Date.now();
      const result = nowInTimezone('UTC');
      const after = Date.now();

      const resultTime = result.getTime();

      // Should be within a reasonable range of current time
      expect(resultTime).toBeGreaterThanOrEqual(before - 5000);
      expect(resultTime).toBeLessThanOrEqual(after + 5000);
    });
  });

  describe('formatUTC()', () => {
    test('should format with ddd, DD MMM YYYY HH:mm:ss pattern', () => {
      const date = new Date('2025-03-15T14:30:45Z');
      const result = formatUTC(date, 'ddd, DD MMM YYYY HH:mm:ss');

      expect(result).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2}$/);
    });

    test('should format day names correctly', () => {
      // March 15, 2025 is a Saturday
      const date = new Date('2025-03-15T12:00:00Z');
      const result = formatUTC(date, 'ddd');

      expect(result).toBe('Sat');
    });

    test('should format month names correctly', () => {
      const date = new Date('2025-03-15T12:00:00Z');
      const result = formatUTC(date, 'MMM');

      expect(result).toBe('Mar');
    });

    test('should format year correctly', () => {
      const date = new Date('2025-03-15T12:00:00Z');
      const result = formatUTC(date, 'YYYY');

      expect(result).toBe('2025');
    });

    test('should format day with leading zero', () => {
      const date = new Date('2025-03-05T12:00:00Z');
      const result = formatUTC(date, 'DD');

      expect(result).toBe('05');
    });

    test('should format hours with leading zero', () => {
      const date = new Date('2025-03-15T09:00:00Z');
      const result = formatUTC(date, 'HH');

      expect(result).toBe('09');
    });

    test('should format minutes with leading zero', () => {
      const date = new Date('2025-03-15T12:05:00Z');
      const result = formatUTC(date, 'mm');

      expect(result).toBe('05');
    });

    test('should format seconds with leading zero', () => {
      const date = new Date('2025-03-15T12:00:07Z');
      const result = formatUTC(date, 'ss');

      expect(result).toBe('07');
    });

    test('should handle custom format strings', () => {
      const date = new Date('2025-03-15T14:30:45Z');
      const result = formatUTC(date, 'YYYY-MM-DD HH:mm:ss');

      // Note: MM is not replaced (only MMM for month name)
      expect(result).toContain('2025');
      expect(result).toContain('14:30:45');
    });

    test('should handle partial format strings', () => {
      const date = new Date('2025-03-15T14:30:45Z');

      expect(formatUTC(date, 'ddd')).toBe('Sat');
      expect(formatUTC(date, 'MMM YYYY')).toContain('Mar 2025');
      expect(formatUTC(date, 'HH:mm')).toBe('14:30');
    });

    test('should handle all months', () => {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      months.forEach((month, index) => {
        const date = new Date(Date.UTC(2025, index, 15, 12, 0, 0));
        const result = formatUTC(date, 'MMM');
        expect(result).toBe(month);
      });
    });

    test('should handle all days of week', () => {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      // March 16-22, 2025 covers Sun-Sat
      days.forEach((day, index) => {
        const date = new Date(Date.UTC(2025, 2, 16 + index, 12, 0, 0));
        const result = formatUTC(date, 'ddd');
        expect(result).toBe(day);
      });
    });
  });

  describe('addDays()', () => {
    test('should add positive days', () => {
      const date = new Date('2025-03-15T12:00:00Z');
      const result = addDays(date, 5);

      expect(result.getUTCDate()).toBe(20);
      expect(result.getUTCMonth()).toBe(2); // March
      expect(result.getUTCFullYear()).toBe(2025);
    });

    test('should add negative days (subtract)', () => {
      const date = new Date('2025-03-15T12:00:00Z');
      const result = addDays(date, -5);

      expect(result.getUTCDate()).toBe(10);
      expect(result.getUTCMonth()).toBe(2); // March
    });

    test('should handle month rollover', () => {
      const date = new Date('2025-03-30T12:00:00Z');
      const result = addDays(date, 5);

      expect(result.getUTCDate()).toBe(4);
      expect(result.getUTCMonth()).toBe(3); // April
      expect(result.getUTCFullYear()).toBe(2025);
    });

    test('should handle year rollover', () => {
      const date = new Date('2025-12-30T12:00:00Z');
      const result = addDays(date, 5);

      expect(result.getUTCDate()).toBe(4);
      expect(result.getUTCMonth()).toBe(0); // January
      expect(result.getUTCFullYear()).toBe(2026);
    });

    test('should handle adding zero days', () => {
      const date = new Date('2025-03-15T12:00:00Z');
      const result = addDays(date, 0);

      expect(result.getTime()).toBe(date.getTime());
    });

    test('should not modify original date', () => {
      const date = new Date('2025-03-15T12:00:00Z');
      const originalTime = date.getTime();

      addDays(date, 5);

      expect(date.getTime()).toBe(originalTime);
    });

    test('should handle leap year February', () => {
      const date = new Date('2024-02-28T12:00:00Z'); // 2024 is leap year
      const result = addDays(date, 1);

      expect(result.getUTCDate()).toBe(29);
      expect(result.getUTCMonth()).toBe(1); // February
    });

    test('should handle non-leap year February', () => {
      const date = new Date('2025-02-28T12:00:00Z'); // 2025 is not leap year
      const result = addDays(date, 1);

      expect(result.getUTCDate()).toBe(1);
      expect(result.getUTCMonth()).toBe(2); // March
    });
  });

  describe('isBefore()', () => {
    test('should return true when first date is before second', () => {
      const date1 = new Date('2025-03-15T12:00:00Z');
      const date2 = new Date('2025-03-16T12:00:00Z');

      expect(isBefore(date1, date2)).toBe(true);
    });

    test('should return false when first date is after second', () => {
      const date1 = new Date('2025-03-16T12:00:00Z');
      const date2 = new Date('2025-03-15T12:00:00Z');

      expect(isBefore(date1, date2)).toBe(false);
    });

    test('should return false when dates are equal', () => {
      const date1 = new Date('2025-03-15T12:00:00Z');
      const date2 = new Date('2025-03-15T12:00:00Z');

      expect(isBefore(date1, date2)).toBe(false);
    });

    test('should handle millisecond differences', () => {
      const date1 = new Date('2025-03-15T12:00:00.000Z');
      const date2 = new Date('2025-03-15T12:00:00.001Z');

      expect(isBefore(date1, date2)).toBe(true);
    });

    test('should handle large time differences', () => {
      const date1 = new Date('2020-01-01T00:00:00Z');
      const date2 = new Date('2025-12-31T23:59:59Z');

      expect(isBefore(date1, date2)).toBe(true);
    });

    test('should work with different timezones (same absolute time)', () => {
      // Same moment in time, different representations
      const date1 = new Date('2025-03-15T12:00:00Z');
      const date2 = new Date('2025-03-15T08:00:00-04:00'); // Same time, different offset

      expect(isBefore(date1, date2)).toBe(false);
    });
  });

  describe('timezone decorator', () => {
    test('should add timezone property to class', () => {
      @timezone('America/New_York')
      class TestClass {
        name = 'test';
      }

      const instance = new TestClass();
      expect((instance as any).timezone).toBe('America/New_York');
    });

    test('should work with different timezones', () => {
      @timezone('Europe/London')
      class LondonClass {}

      @timezone('Asia/Tokyo')
      class TokyoClass {}

      const london = new LondonClass();
      const tokyo = new TokyoClass();

      expect((london as any).timezone).toBe('Europe/London');
      expect((tokyo as any).timezone).toBe('Asia/Tokyo');
    });

    test('should set timezone from decorator (cannot be overridden in class body)', () => {
      @timezone('America/New_York')
      class TestClass {
        // Decorator sets timezone in extended class
        // Class body property would need to be set after super() in constructor
      }

      const instance = new TestClass();
      // Decorator creates extended class with timezone property
      expect((instance as any).timezone).toBe('America/New_York');
    });

    test('should work with constructor parameters', () => {
      @timezone('America/New_York')
      class TestClass {
        name: string;

        constructor(name: string) {
          this.name = name;
        }
      }

      const instance = new TestClass('test-instance');
      expect(instance.name).toBe('test-instance');
      expect((instance as any).timezone).toBe('America/New_York');
    });

    test('should preserve class methods', () => {
      @timezone('America/New_York')
      class TestClass {
        getValue() {
          return 'test-value';
        }
      }

      const instance = new TestClass();
      expect(instance.getValue()).toBe('test-value');
    });

    test('should work with inheritance', () => {
      @timezone('UTC')
      class BaseClass {
        baseProperty = 'base';
      }

      class DerivedClass extends BaseClass {
        derivedProperty = 'derived';
      }

      const instance = new DerivedClass();
      expect(instance.baseProperty).toBe('base');
      expect(instance.derivedProperty).toBe('derived');
      expect((instance as any).timezone).toBe('UTC');
    });
  });

  describe('Edge Cases and Integration', () => {
    test('should handle DST transitions with correct offsets', () => {
      // March 10, 2024 - DST starts in US
      const beforeDST = new Date('2024-03-10T06:00:00Z'); // 1 AM EST (GMT-5)
      const afterDST = new Date('2024-03-10T07:00:00Z');  // 3 AM EDT (GMT-4) (DST starts)

      const formatted1 = formatInTimezone(beforeDST, 'America/New_York', 'iso');
      const formatted2 = formatInTimezone(afterDST, 'America/New_York', 'iso');

      // Both should format successfully with timezone offset
      expect(formatted1).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(formatted2).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Verify timezone offsets are included
      expect(formatted1).toMatch(/(-5|GMT-5)/); // EST
      expect(formatted2).toMatch(/(-4|GMT-4)/); // EDT
    });

    test('should handle midnight correctly', () => {
      const midnight = new Date('2025-03-15T00:00:00Z');
      const result = formatUTC(midnight, 'HH:mm:ss');

      expect(result).toBe('00:00:00');
    });

    test('should handle end of day correctly', () => {
      const endOfDay = new Date('2025-03-15T23:59:59Z');
      const result = formatUTC(endOfDay, 'HH:mm:ss');

      expect(result).toBe('23:59:59');
    });

    test('should chain datetime operations', () => {
      const start = new Date('2025-03-15T12:00:00Z');
      const plusFiveDays = addDays(start, 5);
      const plusTenDays = addDays(start, 10);

      expect(isBefore(plusFiveDays, plusTenDays)).toBe(true);
      expect(isBefore(start, plusFiveDays)).toBe(true);
    });
  });
});
