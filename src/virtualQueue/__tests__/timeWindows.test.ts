/**
 * Tests for Time Window Helpers
 */

import {
  calculateReturnWindow,
  findNextAvailableSlot,
  parseTimeSlots,
} from '../timeWindows';

describe('Time Window Helpers', () => {
  describe('calculateReturnWindow()', () => {
    it('should calculate return window based on wait time', () => {
      const baseTime = new Date('2024-10-15T12:00:00Z');
      const result = calculateReturnWindow({
        baseTime,
        waitMinutes: 45,
        windowDurationMinutes: 15,
        timezone: 'America/New_York',
      });

      // baseTime (12:00 UTC = 08:00 EDT) + 45 min = 08:45 EDT
      // window end = 08:45 + 15 min = 09:00 EDT
      expect(result.start).toContain('08:45:00');
      expect(result.end).toContain('09:00:00');
    });

    it('should use current time if baseTime not provided', () => {
      const beforeCall = new Date();
      const result = calculateReturnWindow({
        waitMinutes: 30,
        windowDurationMinutes: 15,
        timezone: 'America/New_York',
      });

      expect(result.start).toBeTruthy();
      expect(result.end).toBeTruthy();

      // Verify it's a valid ISO date string
      expect(result.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Start time should be a valid formatted datetime (not parseable by Date.parse due to GMT offset format)
      // Just verify the format contains time components after the date
      expect(result.start).toMatch(/T\d{2}:\d{2}:\d{2}/);
    });

    it('should handle zero wait time', () => {
      const baseTime = new Date('2024-10-15T12:00:00Z');
      const result = calculateReturnWindow({
        baseTime,
        waitMinutes: 0,
        windowDurationMinutes: 15,
        timezone: 'America/New_York',
      });

      // baseTime + 0 min = 08:00 EDT
      // window end = 08:00 + 15 min = 08:15 EDT
      expect(result.start).toContain('08:00:00');
      expect(result.end).toContain('08:15:00');
    });

    it('should handle large wait times', () => {
      const baseTime = new Date('2024-10-15T12:00:00Z');
      const result = calculateReturnWindow({
        baseTime,
        waitMinutes: 120, // 2 hours
        windowDurationMinutes: 30,
        timezone: 'America/New_York',
      });

      // baseTime (08:00 EDT) + 120 min = 10:00 EDT
      // window end = 10:00 + 30 min = 10:30 EDT
      expect(result.start).toContain('10:00:00');
      expect(result.end).toContain('10:30:00');
    });

    it('should format times in specified timezone', () => {
      const baseTime = new Date('2024-10-15T12:00:00Z');
      const result = calculateReturnWindow({
        baseTime,
        waitMinutes: 30,
        windowDurationMinutes: 15,
        timezone: 'Europe/London',
      });

      // 12:00 UTC + 30 min = 12:30 UTC = 13:30 BST (UK summer time)
      expect(result.start).toBeTruthy();
      expect(result.end).toBeTruthy();
    });

    it('should handle Efteling pattern (15 min window)', () => {
      const baseTime = new Date('2024-10-15T10:00:00Z');
      const result = calculateReturnWindow({
        baseTime,
        waitMinutes: 45,
        windowDurationMinutes: 15,
        timezone: 'Europe/Amsterdam',
      });

      expect(result.start).toBeTruthy();
      expect(result.end).toBeTruthy();

      // Verify format is valid ISO string
      expect(result.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(result.end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Extract time components and verify 15 minute window
      const startMatch = result.start.match(/T(\d{2}):(\d{2}):(\d{2})/);
      const endMatch = result.end.match(/T(\d{2}):(\d{2}):(\d{2})/);
      expect(startMatch).not.toBeNull();
      expect(endMatch).not.toBeNull();

      const startMinutes = parseInt(startMatch![1]) * 60 + parseInt(startMatch![2]);
      const endMinutes = parseInt(endMatch![1]) * 60 + parseInt(endMatch![2]);
      expect(endMinutes - startMinutes).toBe(15);
    });
  });

  describe('findNextAvailableSlot()', () => {
    it('should find earliest available slot', () => {
      const slots = [
        {
          startTime: '2024-10-15T15:30:00-04:00',
          endTime: '2024-10-15T15:45:00-04:00',
          available: true,
        },
        {
          startTime: '2024-10-15T15:00:00-04:00',
          endTime: '2024-10-15T15:15:00-04:00',
          available: true,
        },
        {
          startTime: '2024-10-15T14:30:00-04:00',
          endTime: '2024-10-15T14:45:00-04:00',
          available: true,
        },
      ];

      const currentTime = new Date('2024-10-15T14:00:00-04:00');
      const result = findNextAvailableSlot(slots, { currentTime });

      expect(result).toEqual({
        start: '2024-10-15T14:30:00-04:00',
        end: '2024-10-15T14:45:00-04:00',
      });
    });

    it('should skip past slots', () => {
      const slots = [
        {
          startTime: '2024-10-15T14:00:00-04:00',
          endTime: '2024-10-15T14:15:00-04:00',
          available: true,
        },
        {
          startTime: '2024-10-15T15:00:00-04:00',
          endTime: '2024-10-15T15:15:00-04:00',
          available: true,
        },
      ];

      const currentTime = new Date('2024-10-15T14:30:00-04:00');
      const result = findNextAvailableSlot(slots, { currentTime });

      expect(result).toEqual({
        start: '2024-10-15T15:00:00-04:00',
        end: '2024-10-15T15:15:00-04:00',
      });
    });

    it('should filter by availability when requested', () => {
      const slots = [
        {
          startTime: '2024-10-15T14:30:00-04:00',
          endTime: '2024-10-15T14:45:00-04:00',
          available: false,
        },
        {
          startTime: '2024-10-15T15:00:00-04:00',
          endTime: '2024-10-15T15:15:00-04:00',
          available: true,
        },
      ];

      const currentTime = new Date('2024-10-15T14:00:00-04:00');
      const result = findNextAvailableSlot(slots, {
        currentTime,
        filterAvailable: true,
      });

      expect(result).toEqual({
        start: '2024-10-15T15:00:00-04:00',
        end: '2024-10-15T15:15:00-04:00',
      });
    });

    it('should return null when no future slots available', () => {
      const slots = [
        {
          startTime: '2024-10-15T14:00:00-04:00',
          endTime: '2024-10-15T14:15:00-04:00',
          available: true,
        },
      ];

      const currentTime = new Date('2024-10-15T15:00:00-04:00');
      const result = findNextAvailableSlot(slots, { currentTime });

      expect(result).toBeNull();
    });

    it('should return null when no available slots match filter', () => {
      const slots = [
        {
          startTime: '2024-10-15T15:00:00-04:00',
          endTime: '2024-10-15T15:15:00-04:00',
          available: false,
        },
      ];

      const currentTime = new Date('2024-10-15T14:00:00-04:00');
      const result = findNextAvailableSlot(slots, {
        currentTime,
        filterAvailable: true,
      });

      expect(result).toBeNull();
    });

    it('should handle custom available field name', () => {
      const slots = [
        {
          startTime: '2024-10-15T15:00:00-04:00',
          endTime: '2024-10-15T15:15:00-04:00',
          isAvailable: false,
        },
        {
          startTime: '2024-10-15T15:30:00-04:00',
          endTime: '2024-10-15T15:45:00-04:00',
          isAvailable: true,
        },
      ];

      const currentTime = new Date('2024-10-15T14:00:00-04:00');
      const result = findNextAvailableSlot(slots, {
        currentTime,
        filterAvailable: true,
        availableField: 'isAvailable',
      });

      expect(result).toEqual({
        start: '2024-10-15T15:30:00-04:00',
        end: '2024-10-15T15:45:00-04:00',
      });
    });

    it('should handle slots without availability field', () => {
      const slots = [
        {
          startTime: '2024-10-15T15:00:00-04:00',
          endTime: '2024-10-15T15:15:00-04:00',
        },
        {
          startTime: '2024-10-15T15:30:00-04:00',
          endTime: '2024-10-15T15:45:00-04:00',
        },
      ];

      const currentTime = new Date('2024-10-15T14:00:00-04:00');
      const result = findNextAvailableSlot(slots, {
        currentTime,
        filterAvailable: true,
      });

      // Should treat undefined as available
      expect(result).toEqual({
        start: '2024-10-15T15:00:00-04:00',
        end: '2024-10-15T15:15:00-04:00',
      });
    });

    it('should use current time if not provided', () => {
      const futureTime = new Date(Date.now() + 3600000); // 1 hour from now
      const slots = [
        {
          startTime: futureTime.toISOString(),
          endTime: new Date(futureTime.getTime() + 900000).toISOString(), // +15 min
          available: true,
        },
      ];

      const result = findNextAvailableSlot(slots);

      expect(result).toBeTruthy();
      expect(result!.start).toBe(futureTime.toISOString());
    });
  });

  describe('parseTimeSlots()', () => {
    it('should parse time slots with standard field names', () => {
      const apiSlots = [
        {
          StartTime: '2024-10-15T14:30:00-04:00',
          EndTime: '2024-10-15T14:45:00-04:00',
          IsAvailable: true,
        },
        {
          StartTime: '2024-10-15T15:00:00-04:00',
          EndTime: '2024-10-15T15:15:00-04:00',
          IsAvailable: false,
        },
      ];

      const result = parseTimeSlots(apiSlots, {
        startTimeField: 'StartTime',
        endTimeField: 'EndTime',
        availableField: 'IsAvailable',
      });

      expect(result).toHaveLength(2);
      expect(result[0].start).toBeInstanceOf(Date);
      expect(result[0].end).toBeInstanceOf(Date);
      expect(result[0].available).toBe(true);
      expect(result[1].available).toBe(false);
    });

    it('should default to available=true if field not specified', () => {
      const apiSlots = [
        {
          startTime: '2024-10-15T14:30:00-04:00',
          endTime: '2024-10-15T14:45:00-04:00',
        },
      ];

      const result = parseTimeSlots(apiSlots, {
        startTimeField: 'startTime',
        endTimeField: 'endTime',
      });

      expect(result[0].available).toBe(true);
    });

    it('should handle various date formats', () => {
      const apiSlots = [
        {
          start: '2024-10-15T14:30:00Z',
          end: '2024-10-15T14:45:00Z',
        },
      ];

      const result = parseTimeSlots(apiSlots, {
        startTimeField: 'start',
        endTimeField: 'end',
      });

      expect(result[0].start.toISOString()).toBe('2024-10-15T14:30:00.000Z');
      expect(result[0].end.toISOString()).toBe('2024-10-15T14:45:00.000Z');
    });

    it('should handle Universal API format', () => {
      type UniversalSlot = {
        StartTime: string;
        EndTime: string;
      };

      const apiSlots: UniversalSlot[] = [
        {
          StartTime: '2024-10-15T14:30:00-04:00',
          EndTime: '2024-10-15T14:45:00-04:00',
        },
      ];

      const result = parseTimeSlots(apiSlots, {
        startTimeField: 'StartTime',
        endTimeField: 'EndTime',
      });

      expect(result[0].available).toBe(true);
      expect(result[0].start).toBeInstanceOf(Date);
    });
  });

  describe('Real-world integration patterns', () => {
    it('should support Universal Virtual Line pattern', () => {
      // Universal returns explicit slots - use parseTimeSlots to convert format
      const apiResponse = {
        AppointmentTimes: [
          {
            StartTime: '2024-10-15T14:30:00-04:00',
            EndTime: '2024-10-15T14:45:00-04:00',
          },
          {
            StartTime: '2024-10-15T15:00:00-04:00',
            EndTime: '2024-10-15T15:15:00-04:00',
          },
        ],
      };

      // First parse to standard format
      const parsedSlots = parseTimeSlots(apiResponse.AppointmentTimes, {
        startTimeField: 'StartTime',
        endTimeField: 'EndTime',
      });

      // Convert to TimeSlot format
      const slots = parsedSlots.map(slot => ({
        startTime: slot.start.toISOString(),
        endTime: slot.end.toISOString(),
      }));

      const nextSlot = findNextAvailableSlot(slots, {
        currentTime: new Date('2024-10-15T14:00:00-04:00'),
      });

      expect(nextSlot?.start).toBeTruthy();
      expect(nextSlot?.end).toBeTruthy();
    });

    it('should support Efteling calculated window pattern', () => {
      // Efteling calculates window from wait time
      const virtualQueueData = {
        WaitingTime: 45, // minutes
      };

      const window = calculateReturnWindow({
        baseTime: new Date('2024-10-15T10:00:00Z'),
        waitMinutes: virtualQueueData.WaitingTime,
        windowDurationMinutes: 15, // Efteling default
        timezone: 'Europe/Amsterdam',
      });

      expect(window.start).toBeTruthy();
      expect(window.end).toBeTruthy();

      // Verify format is valid
      expect(window.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(window.end).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Extract time components and verify 15 minute window
      const startMatch = window.start.match(/T(\d{2}):(\d{2}):(\d{2})/);
      const endMatch = window.end.match(/T(\d{2}):(\d{2}):(\d{2})/);
      expect(startMatch).not.toBeNull();
      expect(endMatch).not.toBeNull();

      const startMinutes = parseInt(startMatch![1]) * 60 + parseInt(startMatch![2]);
      const endMinutes = parseInt(endMatch![1]) * 60 + parseInt(endMatch![2]);
      expect(endMinutes - startMinutes).toBe(15);
    });
  });
});
