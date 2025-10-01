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
    // ISO 8601 format
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date).reduce((acc, part) => {
      if (part.type === 'year') return `${part.value}-`;
      if (part.type === 'month') return `${acc}${part.value}-`;
      if (part.type === 'day') return `${acc}${part.value}T`;
      if (part.type === 'hour') return `${acc}${part.value}:`;
      if (part.type === 'minute') return `${acc}${part.value}:`;
      if (part.type === 'second') return `${acc}${part.value}`;
      return acc;
    }, '');
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
 * Check if a date is before another date
 * @param date1 First date
 * @param date2 Second date
 * @returns True if date1 is before date2
 */
export function isBefore(date1: Date, date2: Date): boolean {
  return date1.getTime() < date2.getTime();
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
