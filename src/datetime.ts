/**
 * DateTime utility for timezone-aware date operations
 * Uses native Intl API instead of moment-timezone to reduce bundle size
 */

/**
 * Format a date in a specific timezone
 * @param date Date to format
 * @param timezone IANA timezone name (e.g., 'America/New_York')
 * @param format Output format
 * @returns Formatted date string
 */
export function formatInTimezone(
  date: Date,
  timezone: string,
  format: 'iso' | 'date' | 'datetime' = 'iso'
): string {
  if (format === 'iso') {
    // ISO 8601 format with timezone offset: YYYY-MM-DDTHH:mm:ss±HH:mm
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'shortOffset',
    }).formatToParts(date);

    const year = parts.find(p => p.type === 'year')?.value;
    const month = parts.find(p => p.type === 'month')?.value;
    const day = parts.find(p => p.type === 'day')?.value;
    const hour = parts.find(p => p.type === 'hour')?.value;
    const minute = parts.find(p => p.type === 'minute')?.value;
    const second = parts.find(p => p.type === 'second')?.value;
    const offset = parts.find(p => p.type === 'timeZoneName')?.value || 'Z';

    return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
  }

  if (format === 'date') {
    // MM/DD/YYYY format
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }

  // datetime format
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * Parse a time string in a specific timezone and return ISO string
 * @param timeString Time string to parse
 * @param timezone IANA timezone name
 * @returns ISO 8601 formatted string
 */
export function parseTimeInTimezone(timeString: string, timezone: string): string {
  // If already in ISO format with timezone, return as-is
  if (timeString.includes('T') && (timeString.includes('Z') || timeString.includes('+'))) {
    return timeString;
  }

  // Parse the date and format it with timezone offset
  const date = new Date(timeString);

  // Get the timezone offset in minutes
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'shortOffset',
  });

  const parts = formatter.formatToParts(date);
  const offset = parts.find(p => p.type === 'timeZoneName')?.value || '+00:00';

  const year = parts.find(p => p.type === 'year')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;
  const hour = parts.find(p => p.type === 'hour')?.value;
  const minute = parts.find(p => p.type === 'minute')?.value;
  const second = parts.find(p => p.type === 'second')?.value;

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

/**
 * Get current date/time in a specific timezone
 * @param timezone IANA timezone name
 * @returns Current date in that timezone
 */
export function nowInTimezone(timezone: string): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
}

/**
 * Format date in UTC with specific format string
 * @param date Date to format
 * @param formatStr Format string (e.g., 'ddd, DD MMM YYYY HH:mm:ss')
 * @returns Formatted date string
 */
export function formatUTC(date: Date, formatStr: string): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const dayName = days[date.getUTCDay()];
  const monthName = months[date.getUTCMonth()];
  const dayNum = String(date.getUTCDate()).padStart(2, '0');
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  // Simple format string replacement
  return formatStr
    .replace('ddd', dayName)
    .replace('MMM', monthName)
    .replace('YYYY', String(year))
    .replace('DD', dayNum)
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds);
}

/**
 * Add days to a date
 * @param date Starting date
 * @param days Number of days to add
 * @returns New date with days added
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * Construct a full ISO 8601 datetime string from separate date, time, and timezone.
 * Replaces the per-park getXxxOffset() helpers that every park reimplemented.
 *
 * @param dateStr Date in YYYY-MM-DD format
 * @param timeStr Time in HH:mm or HH:mm:ss format
 * @param tz IANA timezone name (e.g., 'Europe/Amsterdam', 'America/New_York')
 * @returns ISO 8601 string with correct timezone offset (e.g., '2024-07-15T10:00:00+02:00')
 */
export function constructDateTime(dateStr: string, timeStr: string, tz: string): string {
  // Ensure seconds are present
  const timeParts = timeStr.split(':');
  const fullTime = timeParts.length === 2 ? `${timeStr}:00` : timeStr;

  // Get the correct UTC offset for this date + timezone by probing with formatInTimezone.
  // Use noon UTC as a safe reference point to determine the offset for this date.
  const refDate = new Date(`${dateStr}T12:00:00Z`);
  const formatted = formatInTimezone(refDate, tz, 'iso');

  // Extract offset from the formatted string.
  // formatInTimezone produces either "+HH:MM" or "GMT+N" format.
  let offset: string;
  const stdMatch = formatted.match(/([+-]\d{2}:\d{2})$/);
  if (stdMatch) {
    offset = stdMatch[1];
  } else {
    // Handle GMT+N / GMT-N format from Intl.DateTimeFormat
    const gmtMatch = formatted.match(/GMT([+-])(\d+)$/);
    if (gmtMatch) {
      const sign = gmtMatch[1];
      const hours = gmtMatch[2].padStart(2, '0');
      offset = `${sign}${hours}:00`;
    } else {
      offset = '+00:00'; // UTC fallback
    }
  }

  return `${dateStr}T${fullTime}${offset}`;
}

/**
 * Add minutes to a date
 * @param date Starting date
 * @param minutes Number of minutes to add
 * @returns New date with minutes added
 */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/**
 * Check if a date is before another date
 * @param date1 First date
 * @param date2 Second date
 * @returns True if date1 is before date2
 */
export function isBefore(date1: Date, date2: Date): boolean {
  return date1.getTime() < date2.getTime();
}

/**
 * Format a Date as a YYYY-MM-DD string.
 * Replaces the verbose `getFullYear() + '-' + padStart(getMonth()+1) + ...` pattern
 * that was duplicated across 30+ call sites.
 *
 * @param date Date object (interpreted in UTC unless inTimezone is provided)
 * @param inTimezone Optional IANA timezone — formats the date as seen in that timezone
 */
export function formatDate(date: Date, inTimezone?: string): string {
  if (inTimezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: inTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date); // en-CA gives YYYY-MM-DD natively
    return parts;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Convert a "fake UTC" timestamp to a correctly-offset local ISO string.
 *
 * Many park APIs (SeaWorld, etc.) return timestamps that look like UTC
 * (ending in 'Z' or without offset) but actually represent local times.
 * For example, "2026-04-01T09:00:00Z" really means 09:00 local time.
 *
 * This function strips the Z, extracts the date and time components,
 * and uses constructDateTime() to attach the correct timezone offset.
 *
 * @param fakeUtcStr A UTC-formatted string that actually represents local time
 * @param tz IANA timezone name
 * @returns ISO 8601 string with correct timezone offset
 */
export function localFromFakeUtc(fakeUtcStr: string, tz: string): string {
  // Strip trailing Z, fractional seconds, and any existing offset
  const clean = fakeUtcStr.replace(/Z$/i, '').replace(/\.\d+$/, '');
  // Split into date and time at the 'T'
  const tIdx = clean.indexOf('T');
  if (tIdx === -1) {
    // No time component — treat as midnight
    return constructDateTime(clean, '00:00', tz);
  }
  const dateStr = clean.substring(0, tIdx);
  const timeStr = clean.substring(tIdx + 1);
  return constructDateTime(dateStr, timeStr, tz);
}

/**
 * Extract a hostname from a URL string, returning undefined if invalid.
 * Commonly used in @inject hostname filters for dynamic API base URLs.
 *
 * @param url URL string (e.g., 'https://api.example.com/v1/')
 * @returns hostname string or undefined
 */
export function hostnameFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Timezone decorator - injects timezone property into class
 * Use this on Destination classes to provide timezone context
 */
export function timezone(defaultTimezone: string) {
  return function <T extends { new(...args: any[]): {} }>(constructor: T) {
    return class extends constructor {
      timezone: string = defaultTimezone;
    };
  };
}
