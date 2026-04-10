/**
 * DateTime utility for timezone-aware date operations
 * Uses native Intl API instead of moment-timezone to reduce bundle size
 */

/**
 * Normalize a `timeZoneName: 'shortOffset'` string from Intl.DateTimeFormat
 * into a standard ISO 8601 offset like "+HH:MM" or "-HH:MM".
 *
 * Handles all formats Node/ICU produces:
 *  - "GMT"          -> "+00:00"
 *  - "GMT+2"        -> "+02:00"
 *  - "GMT-4"        -> "-04:00"
 *  - "GMT+5:30"     -> "+05:30"  (half-hour zones like Asia/Kolkata)
 *  - "GMT+10:30"    -> "+10:30"  (Australia/Lord_Howe)
 *  - "+02:00"       -> "+02:00"  (already ISO)
 */
function normalizeOffset(raw: string | undefined): string {
  if (!raw) return '+00:00';

  // Already in ISO format
  const isoMatch = raw.match(/^([+-])(\d{1,2}):(\d{2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}${isoMatch[2].padStart(2, '0')}:${isoMatch[3]}`;
  }

  // GMT / UTC (+ optional offset + optional minutes)
  const gmtMatch = raw.match(/^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/);
  if (gmtMatch) {
    if (!gmtMatch[1]) return '+00:00'; // bare "GMT" / "UTC"
    const sign = gmtMatch[1];
    const hours = gmtMatch[2].padStart(2, '0');
    const minutes = gmtMatch[3] ?? '00';
    return `${sign}${hours}:${minutes}`;
  }

  return '+00:00'; // unknown format, fall back to UTC
}

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
    let hour = parts.find(p => p.type === 'hour')?.value;
    const minute = parts.find(p => p.type === 'minute')?.value;
    const second = parts.find(p => p.type === 'second')?.value;
    const offset = normalizeOffset(parts.find(p => p.type === 'timeZoneName')?.value);

    // Intl uses 24:00 for midnight in en-US with hour12: false
    if (hour === '24') hour = '00';

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
 * Interpret a naive (offset-less) date/time string as local-to-the-given-timezone
 * and return an ISO 8601 string with the correct offset.
 *
 * If the input already includes an explicit offset or `Z`, it is returned as-is.
 *
 * Supports the following input formats for naive strings:
 *   - "YYYY-MM-DDTHH:mm[:ss]"   (ISO bare)
 *   - "YYYY-MM-DD HH:mm[:ss]"   (ISO bare with space)
 *   - "MM/DD/YYYY HH:mm[:ss]"   (US format, used by Cedar Fair)
 *
 * @param timeString Time string to interpret
 * @param timezone IANA timezone name (e.g. 'America/New_York')
 * @returns ISO 8601 string with timezone offset
 */
export function parseTimeInTimezone(timeString: string, timezone: string): string {
  // Already has explicit timezone info — return as-is
  if (timeString.includes('T') &&
      (timeString.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(timeString))) {
    return timeString;
  }

  // Parse into date + time components, then delegate to constructDateTime
  // which knows how to apply the correct offset for the target timezone.
  const isoMatch = timeString.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (isoMatch) {
    const [, y, m, d, h, mi, s] = isoMatch;
    return constructDateTime(`${y}-${m}-${d}`, `${h.padStart(2, '0')}:${mi}:${s ?? '00'}`, timezone);
  }

  const usMatch = timeString.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (usMatch) {
    const [, mo, d, y, h, mi, s] = usMatch;
    return constructDateTime(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`,
                             `${h.padStart(2, '0')}:${mi}:${s ?? '00'}`,
                             timezone);
  }

  // Unknown format — fall back to Date parsing (system local time interpretation)
  // and at least produce a valid ISO string in the target timezone, rather than crashing.
  const date = new Date(timeString);
  if (isNaN(date.getTime())) return timeString;
  return formatInTimezone(date, timezone, 'iso');
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
  const target = `${dateStr}T${fullTime}`;

  // Format a UTC ms timestamp as a wall-clock string in the target timezone
  // (no offset, just the components).
  const wallClockIn = (ms: number): string => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms));
    const get = (t: string) => parts.find(p => p.type === t)!.value;
    let hour = get('hour');
    if (hour === '24') hour = '00';
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
  };

  // Iterative search: pretend the target wall clock IS UTC, get a candidate
  // moment, see what wall clock that moment maps to in the target tz, and
  // adjust by the difference. Converges in 2 iterations for normal times,
  // 3 iterations for half-hour-offset zones near DST transitions.
  //
  // For DST gap wall clocks (e.g. 02:30 NY on spring-forward day), the loop
  // exhausts iterations and returns whichever side it last landed on. The
  // result is always a valid moment, but its wall clock will not match the
  // (non-existent) input. Park APIs don't report times during gap hours in
  // practice, so this edge case is documented rather than special-cased.
  let ms = new Date(`${target}Z`).getTime();
  for (let i = 0; i < 3; i++) {
    const wc = wallClockIn(ms);
    if (wc === target) break;
    const diff = new Date(`${target}Z`).getTime() - new Date(`${wc}Z`).getTime();
    if (diff === 0) break;
    ms += diff;
  }

  return formatInTimezone(new Date(ms), tz, 'iso');
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
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
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
