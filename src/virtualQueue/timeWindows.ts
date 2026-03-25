/**
 * Time Window Helpers
 *
 * Utilities for calculating return time windows and finding available slots
 * for virtual queue systems.
 */

import { formatInTimezone, parseTimeInTimezone, addMinutes, isBefore } from '../datetime.js';

/**
 * Options for calculating a return window
 */
export interface CalculateReturnWindowOptions {
  /** Base time to calculate from (defaults to current time) */
  baseTime?: Date;
  /** Wait time in minutes to add to base time */
  waitMinutes: number;
  /** Duration of the return window in minutes */
  windowDurationMinutes: number;
  /** Timezone for formatting output */
  timezone: string;
}

/**
 * Calculate a return time window based on current wait time
 *
 * Common pattern for parks like Efteling where virtual queue window
 * is calculated as: now + waitTime to now + waitTime + windowDuration
 *
 * @example
 * ```typescript
 * const window = calculateReturnWindow({
 *   baseTime: new Date(),
 *   waitMinutes: 45,
 *   windowDurationMinutes: 15,
 *   timezone: 'America/New_York'
 * });
 * // Returns: {
 * //   start: '2024-10-15T14:45:00-04:00',
 * //   end: '2024-10-15T15:00:00-04:00'
 * // }
 * ```
 */
export function calculateReturnWindow(
  options: CalculateReturnWindowOptions
): { start: string; end: string } {
  const baseTime = options.baseTime || new Date();

  // Calculate return start time (baseTime + waitMinutes)
  const startTime = addMinutes(baseTime, options.waitMinutes);

  // Calculate return end time (startTime + windowDurationMinutes)
  const endTime = addMinutes(startTime, options.windowDurationMinutes);

  // Format in park timezone
  return {
    start: formatInTimezone(startTime, options.timezone, 'iso'),
    end: formatInTimezone(endTime, options.timezone, 'iso'),
  };
}

/**
 * Time slot with start and end times
 */
export interface TimeSlot {
  startTime: string;
  endTime: string;
  [key: string]: any; // Allow additional fields
}

/**
 * Options for finding the next available slot
 */
export interface FindNextAvailableSlotOptions {
  /** Current time to compare against (defaults to now) */
  currentTime?: Date;
  /** Filter to only available slots */
  filterAvailable?: boolean;
  /** Field name that indicates availability (defaults to 'available') */
  availableField?: string;
}

/**
 * Find the next available time slot from an array of slots
 *
 * Common pattern for parks like Universal where API returns explicit
 * time slots and you need to find the earliest available one.
 *
 * @example
 * ```typescript
 * const slots = [
 *   { startTime: '2024-10-15T14:30:00-04:00', endTime: '2024-10-15T14:45:00-04:00', available: false },
 *   { startTime: '2024-10-15T15:00:00-04:00', endTime: '2024-10-15T15:15:00-04:00', available: true },
 *   { startTime: '2024-10-15T15:30:00-04:00', endTime: '2024-10-15T15:45:00-04:00', available: true },
 * ];
 *
 * const nextSlot = findNextAvailableSlot(slots, {
 *   currentTime: new Date(),
 *   filterAvailable: true
 * });
 * // Returns: { start: '2024-10-15T15:00:00-04:00', end: '2024-10-15T15:15:00-04:00' }
 * ```
 */
export function findNextAvailableSlot<T extends TimeSlot>(
  slots: T[],
  options: FindNextAvailableSlotOptions = {}
): { start: string; end: string } | null {
  const currentTime = options.currentTime || new Date();
  const filterAvailable = options.filterAvailable ?? false;
  const availableField = options.availableField || 'available';

  // Filter and sort slots
  let filteredSlots = slots;

  // Filter by availability if requested
  if (filterAvailable) {
    filteredSlots = slots.filter(slot => {
      const isAvailable = slot[availableField];
      return isAvailable === true || isAvailable === undefined;
    });
  }

  // Find the earliest slot that's in the future or current
  let earliestSlot: T | null = null;
  let earliestTime: Date | null = null;

  for (const slot of filteredSlots) {
    const slotStartTime = new Date(slot.startTime);

    // Skip slots in the past
    if (isBefore(slotStartTime, currentTime)) {
      continue;
    }

    // Check if this is the earliest slot we've seen
    if (!earliestTime || isBefore(slotStartTime, earliestTime)) {
      earliestSlot = slot;
      earliestTime = slotStartTime;
    }
  }

  if (!earliestSlot) {
    return null;
  }

  return {
    start: earliestSlot.startTime,
    end: earliestSlot.endTime,
  };
}

/**
 * Parsed time slot with Date objects
 */
export interface ParsedTimeSlot {
  start: Date;
  end: Date;
  available: boolean;
}

/**
 * Mapping configuration for parsing time slots
 */
export interface TimeSlotMapping<T> {
  /** Field name containing start time */
  startTimeField: keyof T;
  /** Field name containing end time */
  endTimeField: keyof T;
  /** Field name indicating availability (optional) */
  availableField?: keyof T;
}

/**
 * Parse time slots from API response into standardized format
 *
 * Useful when API returns slots with non-standard field names.
 *
 * @example
 * ```typescript
 * const apiSlots = [
 *   { StartTime: '2024-10-15T14:30:00-04:00', EndTime: '2024-10-15T14:45:00-04:00', IsAvailable: true },
 *   { StartTime: '2024-10-15T15:00:00-04:00', EndTime: '2024-10-15T15:15:00-04:00', IsAvailable: false },
 * ];
 *
 * const parsed = parseTimeSlots(apiSlots, {
 *   startTimeField: 'StartTime',
 *   endTimeField: 'EndTime',
 *   availableField: 'IsAvailable'
 * });
 * // Returns array of { start: Date, end: Date, available: boolean }
 * ```
 */
export function parseTimeSlots<T>(
  slots: T[],
  mapping: TimeSlotMapping<T>
): ParsedTimeSlot[] {
  return slots.map(slot => {
    const startTime = slot[mapping.startTimeField] as string;
    const endTime = slot[mapping.endTimeField] as string;
    const available = mapping.availableField
      ? Boolean(slot[mapping.availableField])
      : true;

    return {
      start: new Date(startTime),
      end: new Date(endTime),
      available,
    };
  });
}
