/**
 * Attractions.io v1 API Integration (Merlin/Legoland parks)
 *
 * Supports 16 parks from the Merlin Entertainments and Legoland group using
 * the Attractions.io v1 API. Provides entity lists, real-time live data, and
 * operating-hour schedules.
 *
 * Authentication flow:
 *   POST {baseURL}installation  →  installation token (cached ~11 months)
 *   All subsequent requests carry:  Authorization: Attractions-Io api-key="…", installation-token="…"
 *
 * Entity data:
 *   GET {baseURL}data  →  202 (still generating) | 303 (redirect to ZIP)
 *   ZIP contains manifest.json (version info) and records.json (all POI data)
 *
 * Live data:
 *   GET https://live-data.attractions.io/{apiKey}.json  (public, no auth)
 *
 * Schedules:
 *   GET {calendarURL}  →  standard calendar JSON
 *
 * @module attractionsio/v1
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import {CacheLib, database} from '../../cache.js';
import {getHttpInstanceId, makeHttpRequest} from '../../httpProxy.js';
import {tracing} from '../../tracing.js';
import {constructDateTime, addDays, formatInTimezone, formatDate, shiftDateString} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';
import type {Entity, LiveData, EntitySchedule, LiveTimeSlot} from '@themeparks/typelib';
import AdmZip from 'adm-zip';
import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Language priority order for name extraction
// ─────────────────────────────────────────────────────────────────────────────

const LANG_PRIORITY = ['en-GB', 'en-US', 'en-AU', 'en-CA', 'es-419', 'de-DE', 'it'] as const;

/**
 * Extract a plain string from a name field that may be a string or a
 * multi-language object (e.g. { "en-GB": "Alton Towers", "de-DE": "…" }).
 */
function extractName(name: string | Record<string, string> | undefined): string {
  if (!name) return '';
  if (typeof name === 'string') return name.trim();

  for (const lang of LANG_PRIORITY) {
    if (name[lang]) return name[lang].trim();
  }

  const first = Object.values(name)[0];
  return first ? first.trim() : '';
}

/**
 * Leading circled map numbers some parks prefix to item names: LEGOLAND Japan
 * started publishing "⑰Driving School" and "㉒Merlin's Challenge" in September
 * 2026, keying names to its park-map legend. The number is not part of the
 * name, and changing it would rename the entity whenever the map is redrawn.
 * Covers ①-⑳ (U+2460-2473), ㉑-㉟ (U+3251-325F) and ㊱-㊿ (U+32B1-32BF).
 */
const CIRCLED_NUMBER_PREFIX = /^[\u2460-\u2473\u3251-\u325F\u32B1-\u32BF]+\s*/u;

export function stripMapNumberPrefix(name: string): string {
  return name.replace(CIRCLED_NUMBER_PREFIX, '');
}

/**
 * A German age rating typed onto the end of a name, with the park's own quotes
 * around it: Heide Park publishes "Mission Meeresgrund “Halloween Edition ab
 * 10 Jahren“" ("ab 10 Jahren" is "from 10 years"). The rating is not part of
 * the title, and the quotes are unbalanced, as both are the same opening mark.
 * The group captures a closing mark after the rating, if there is one.
 */
const AGE_RATING_SUFFIX = /\s+ab\s+\d+\s+Jahren?\b\s*([\u201C\u201D\u201E\u201F"])?$/i;
const DOUBLE_QUOTE_MARKS = new Set(['\u201C', '\u201D', '\u201E', '\u201F', '"']);

/**
 * Remove a trailing "ab N Jahren" age rating from a name, and the quotes it
 * sat in. Nothing is touched unless the name ends in the rating, so quotes
 * that belong to a title are safe: `Hot Dog “Freestyle” ab 6 Jahren` keeps its
 * pair. When the rating was inside a quote that was never closed (an odd
 * number of marks before it) the mark that opened it goes as well, and so does
 * a mark closing the rating. A name that is only the rating is kept as it is.
 */
export function stripAgeRatingTag(name: string): string {
  const match = AGE_RATING_SUFFIX.exec(name.trimEnd());
  if (!match) return name;
  let head = name.slice(0, match.index);
  let marks = 0;
  let lastMark = -1;
  for (let i = 0; i < head.length; i++) {
    if (DOUBLE_QUOTE_MARKS.has(head[i])) {
      marks++;
      lastMark = i;
    }
  }
  if (marks % 2 === 1) head = head.slice(0, lastMark) + head.slice(lastMark + 1);
  return head.replace(/\s{2,}/g, ' ').trim() || name;
}

/**
 * A category or item name reduced for comparison: runs of whitespace of any
 * kind (including no-break spaces) become one space, the ends are trimmed and
 * the case is folded. The parks type these names by hand, and some already pad
 * them ("Summer ", "Howl’o’ween ").
 */
function normaliseName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The text of a name or summary field in every language it carries.
 * extractName() picks one by priority; a match that must not depend on which
 * language the park lists first reads them all.
 */
function textInAllLanguages(field: string | Record<string, string> | undefined): string[] {
  if (!field) return [];
  if (typeof field === 'string') return [field];
  return Object.values(field).filter((text): text is string => typeof text === 'string');
}

// ─────────────────────────────────────────────────────────────────────────────
// Category names used for entity classification
// ─────────────────────────────────────────────────────────────────────────────

const ATTRACTION_CATEGORIES = [
  'Attractions',
  'Rides',
  'Water Rides',
  'Thrill Rides',
  'Coasters',
  'Intense Thrills',
  'Rides & Shows',
  'Thrills & Mini-Thrills',
  'RIDES',
  'Rides & Attractions',
];

const SHOW_CATEGORIES = ['Shows', 'Show', 'Live Shows', 'Entertainment', 'Shows & 4D Movies', '4D Movies'];

const RESTAURANT_CATEGORIES = [
  'Restaurants',
  'Restaurant',
  'Fast Food',
  'Fast food',
  'Snacks',
  'Snacks & Sweets',
  'Healthy Food',
  'Food',
  'Dining',
  'Food & Drink',
  'Food & Drinks',
  'Food & drinks',
  'Food on to go',
  'Café & Snacks',
  'Beverages',
  'Buffet',
  'Restaurants & buffets',
  'Slush ice',
  'Ice cream, coffee & treats',
  'Barbecue & food from home',
];

/**
 * How long after the last asset pack that contained it an item can stay
 * published while the live feed still schedules or runs it (see
 * getPackDropGraceItems).
 *
 * The asset pack is a content export, and it is occasionally republished
 * without rides that are still running: a seasonal re-theme of the app can
 * drop most of a park's ride list while the live feed keeps scheduling every
 * one of them for the day. Fourteen days covers two full weekly content cycles
 * for the operator to republish the pack, and is short enough that a genuine
 * retirement the live feed keeps carrying (it does not prune old records)
 * stops being published within two weeks of leaving the pack.
 */
export const PACK_DROP_GRACE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const PACK_DROP_GRACE_MS = PACK_DROP_GRACE_DAYS * DAY_MS;

/**
 * The park-local dates, relative to today, a live-feed OpeningTimes range may
 * fall in for a dropped item to count as scheduled. The feed carries a single
 * day and rolls over to the next operating day during the evening, and on a
 * closed day it shows the next open one, so "today" alone would drop kept
 * rides every night and on every closed day. The pack window above is what
 * keeps long-retired items out, not this range.
 */
const PACK_DROP_SCHEDULE_FROM_DAYS = -1;
const PACK_DROP_SCHEDULE_TO_DAYS = 7;

/** How long one evaluation of the grace set is reused within a build. */
const PACK_DROP_GRACE_MEMO_MS = 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// API response types
// ─────────────────────────────────────────────────────────────────────────────

type RecordItem = {
  _id: number;
  Name: string | Record<string, string>;
  Category?: number;
  DirectionsLocation?: string;
  Location?: string;
  MinimumHeightRequirement?: number;
  MinimumUnaccompaniedHeightRequirement?: number | null;
  /** Recurring schedule tree (stringified JSON) for shows/animations. */
  ShowTimes?: string | null;
  /** Free text about the record; a plain string or one string per language. */
  Summary?: string | Record<string, string>;
  /** Whether the app draws the record on its map. */
  VisibleOnMap?: boolean;
  /** Whether the app will route a guest to the record. */
  WayfindingEnabled?: boolean;
};

type CategoryRecord = {
  _id: number;
  Name: string | Record<string, string>;
  Parent?: number;
};

type ResortRecord = {
  _id: number;
  Name: string | Record<string, string>;
  DirectionsLocation?: string;
  Location?: string;
};

type RecordsData = {
  Resort: ResortRecord[];
  Item: RecordItem[];
  Category: CategoryRecord[];
};

type LiveDataRecord = {
  _id: number;
  IsOperational?: boolean;
  IsOpen?: boolean;
  QueueTime?: number | null;
  /**
   * A stringified {"type":"range",start,end} blob of today's opening window.
   * Present on venue records (restaurants/shops); most feeds leave it null on
   * rides, but Djurs Sommerland populates it on attractions too.
   * `IsOperational` flags *queue-metered running rides*, so it is always
   * false for dining/retail venues — and, on feeds like Djurs Sommerland,
   * for open-but-unmetered attractions as well. An explicit `IsOpen` boolean
   * is the authoritative open/closed signal wherever it is present.
   */
  OpeningTimes?: string | null;
};

type LiveDataResponse = {
  entities: {
    Item: {
      records: LiveDataRecord[];
    };
  };
};

type CalendarDay = {
  key: string;
  openingHours: string;
};

type CalendarLocation = {
  days: CalendarDay[];
};

type CalendarResponse = {
  Locations?: CalendarLocation[];
  locations?: CalendarLocation[];
};

type InstallationResponse = {
  token: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Schedule time-format patterns
// ─────────────────────────────────────────────────────────────────────────────

type TimeParseResult = {openTime: string; closeTime: string} | null;

/**
 * Parse one side of an opening-hours range ("10am", "4:30pm", "17:00", "9:30")
 * into minutes-since-midnight.  Returns null when the token is unrecognised or
 * out of range.
 *
 * A token without a meridiem is read as 24-hour clock time.
 */
function parseTimeToken(raw: string): {hour: number; minute: number} | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?$/i.exec(raw.trim());
  if (!m) return null;

  let hour = parseInt(m[1], 10);
  const minute = m[2] === undefined ? 0 : parseInt(m[2], 10);
  const meridiem = m[3]?.toLowerCase();

  if (minute > 59) return null;

  if (meridiem) {
    // 12-hour clock: only 1-12 are meaningful, so "0pm"/"13pm" are rejected
    // rather than silently wrapped into a plausible-looking time.
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'p' && hour !== 12) hour += 12;
    if (meridiem === 'a' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  return {hour, minute};
}

/**
 * Parse a raw "openingHours" string such as "9:30am - 7pm", "10am - 4:30pm" or
 * "10:00 - 17:00" into a pair of HH:mm strings.  Returns null when the format
 * is unrecognised.
 *
 * Each side of the range is parsed independently, so every combination of
 * 12-hour/24-hour and with/without minutes is accepted. Feeds mix these
 * freely: LEGOLAND Windsor publishes "10am - 4:30pm" for term-time days and
 * "10am - 6pm" for weekends, in the same calendar.
 *
 * The range is never reordered - a closing time earlier than the opening time
 * is a legitimate past-midnight close.
 */
export function parseOpeningHours(raw: string): TimeParseResult {
  // Hyphen, en dash or em dash, and exactly two sides.
  const parts = raw.trim().split(/\s*[-\u2013\u2014]\s*/);
  if (parts.length !== 2) return null;

  const open = parseTimeToken(parts[0]);
  const close = parseTimeToken(parts[1]);
  if (!open || !close) return null;

  const fmt = (t: {hour: number; minute: number}) =>
    `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;

  return {openTime: fmt(open), closeTime: fmt(close)};
}

// ─────────────────────────────────────────────────────────────────────────────
// Live-data opening-hours parsing
// ─────────────────────────────────────────────────────────────────────────────

/** Split "YYYY-MM-DD HH:MM[:SS]" into {date, time}; null if malformed. */
function splitLiveDateTime(raw: string): {date: string; time: string} | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(raw.trim());
  return m ? {date: m[1], time: m[2]} : null;
}

/**
 * Parse an Attractions.io live-data `OpeningTimes` value into schema
 * LiveTimeSlot entries.
 *
 * The field is a *stringified* JSON blob, e.g.
 *   `{"type":"range","start":"2026-07-08 10:00:00","end":"2026-07-08 18:00:00"}`
 * (a single object, or defensively an array of them). Start/end are park-local
 * wall-clock times without an offset, so they are normalised to ISO+offset via
 * constructDateTime. Returns [] for null/blank/unparseable/non-range values.
 */
export function parseLiveOpeningTimes(raw: string | null | undefined, timezone: string): LiveTimeSlot[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const ranges = Array.isArray(parsed) ? parsed : [parsed];
  const slots: LiveTimeSlot[] = [];

  for (const r of ranges) {
    if (
      !r || typeof r !== 'object' ||
      (r as any).type !== 'range' ||
      typeof (r as any).start !== 'string' ||
      typeof (r as any).end !== 'string'
    ) continue;

    const start = splitLiveDateTime((r as any).start);
    const end = splitLiveDateTime((r as any).end);
    if (!start || !end) continue;

    slots.push({
      type: 'OPERATING',
      startTime: constructDateTime(start.date, start.time, timezone),
      endTime: constructDateTime(end.date, end.time, timezone),
    });
  }

  return slots;
}

/**
 * Whether `nowMs` sits inside any of the given opening-hour slots, under
 * half-open [start, end) containment. Slots whose bounds are missing or
 * unparseable are ignored. Drives the restaurant live-status fallback.
 */
function isOpenNow(hours: LiveTimeSlot[], nowMs: number): boolean {
  return hours.some(h => {
    const s = h.startTime ? Date.parse(h.startTime) : NaN;
    const e = h.endTime ? Date.parse(h.endTime) : NaN;
    return Number.isFinite(s) && Number.isFinite(e) && s <= nowMs && nowMs < e;
  });
}

/**
 * Whether a live-feed `OpeningTimes` value schedules the item on `date`
 * (park-local YYYY-MM-DD): some range starts on or before that date and ends
 * on or after it. Slot bounds are park-local ISO strings, so their date part is
 * the park's calendar date.
 */
export function isScheduledOnDate(raw: string | null | undefined, timezone: string, date: string): boolean {
  return isScheduledBetween(raw, timezone, date, date);
}

/**
 * Whether a live-feed `OpeningTimes` value has a range overlapping the
 * park-local dates `from`..`to` (YYYY-MM-DD, inclusive).
 */
export function isScheduledBetween(
  raw: string | null | undefined,
  timezone: string,
  from: string,
  to: string,
): boolean {
  return parseLiveOpeningTimes(raw, timezone).some(slot => {
    const start = slot.startTime?.slice(0, 10);
    const end = slot.endTime?.slice(0, 10);
    return !!start && !!end && start <= to && from <= end;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Show schedules (`ShowTimes` recurring-schedule algebra)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attractions.io encodes a show/animation's recurring schedule in the records
 * `ShowTimes` field as a nested set-algebra tree. Evaluating that tree against a
 * single day yields the concrete performance windows for that day.
 *
 * Node grammar (each node is a set of instants):
 *   - range         — a continuous span [start, end)
 *   - period        — a repeating window: from `offset_date`, every
 *                     `period_length`, a window `range_length` long is "on".
 *                     Daily period (offset 12:00 / range 30min) → "every day
 *                     12:00–12:30". Weekly period (period_length 7 days) with
 *                     range_length N days selects N consecutive weekdays;
 *                     offset_date's weekday picks the start day.
 *   - union         — set union of children
 *   - intersection  — set intersection of children
 *   - difference    — children[0] minus the union of the rest
 *   - complement    — the evaluation window minus its child
 *
 * Timestamps are naive park-local wall-clock; evaluation happens in that naive
 * space (so daily periods stay fixed across DST), then concrete date + time are
 * handed to constructDateTime for correctly-offset ISO output.
 */
type ShowTimeDuration = {
  week?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
};

export type ShowTimeNode =
  | {type: 'range'; start: string; end: string}
  | {type: 'period'; offset_date: string; period_length: ShowTimeDuration; range_length: ShowTimeDuration}
  | {type: 'union' | 'intersection' | 'difference' | 'complement'; children: ShowTimeNode[]};

/** A half-open interval [start, end) in naive-local milliseconds. */
type ShowTimeInterval = [number, number];

const SHOWTIME_DAY_MS = 24 * 60 * 60 * 1000;

/** Guard against pathological period definitions producing unbounded loops. */
const SHOWTIME_MAX_ITERATIONS = 100_000;

/**
 * Parse a naive "YYYY-MM-DD HH:MM:SS" (or ISO) wall-clock string to ms, treating
 * it as UTC so UTC getters reproduce the wall clock. NaN for bad input.
 */
function parseNaiveMs(raw: string): number {
  // Records data is external and only loosely typed, so a node's start/end/
  // offset_date can arrive null, missing or non-string. Guard before .trim()
  // so bad input yields NaN (which the callers already treat as "drop") rather
  // than throwing.
  if (typeof raw !== 'string') return NaN;
  return Date.parse(raw.trim().replace(' ', 'T') + 'Z');
}

function showTimeDurationMs(d: ShowTimeDuration | undefined): number {
  if (!d || typeof d !== 'object') return 0;
  return (
    (d.week || 0) * 7 * SHOWTIME_DAY_MS +
    (d.day || 0) * SHOWTIME_DAY_MS +
    (d.hour || 0) * 60 * 60 * 1000 +
    (d.minute || 0) * 60 * 1000 +
    (d.second || 0) * 1000
  );
}

/** Sort and merge overlapping/adjacent intervals into a normalised set. */
function normaliseIntervals(list: ShowTimeInterval[]): ShowTimeInterval[] {
  // Keep zero-length points (s === e); drop only malformed s > e intervals.
  const sorted = list.filter(([s, e]) => s <= e).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: ShowTimeInterval[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function intersectIntervals(a: ShowTimeInterval[], b: ShowTimeInterval[]): ShowTimeInterval[] {
  const out: ShowTimeInterval[] = [];
  for (const [as, ae] of a) {
    for (const [bs, be] of b) {
      const s = Math.max(as, bs);
      const e = Math.min(ae, be);
      if (s < e) {
        out.push([s, e]);
      } else if (s === e) {
        // A zero-length point [p, p] survives only when it lies within BOTH
        // operands under half-open [start, end) containment, so a point on a
        // span's exclusive end is dropped while an interior one is kept.
        const p = s;
        const inA = as === ae ? as === p : as <= p && p < ae;
        const inB = bs === be ? bs === p : bs <= p && p < be;
        if (inA && inB) out.push([p, p]);
      }
    }
  }
  return normaliseIntervals(out);
}

/** Remove every part of `b` from `a`. */
function subtractIntervals(a: ShowTimeInterval[], b: ShowTimeInterval[]): ShowTimeInterval[] {
  let current = normaliseIntervals(a);
  for (const [bs, be] of normaliseIntervals(b)) {
    const next: ShowTimeInterval[] = [];
    for (const [as, ae] of current) {
      // A zero-length point is removed only when [bs, be) covers it under
      // half-open containment (bs <= p < be); the generic overlap test below
      // assumes a positive-width interval.
      if (as === ae) {
        if (!(bs <= as && as < be)) next.push([as, ae]);
        continue;
      }
      if (be <= as || bs >= ae) {
        next.push([as, ae]); // no overlap
        continue;
      }
      if (as < bs) next.push([as, bs]); // left remainder
      if (be < ae) next.push([be, ae]); // right remainder
    }
    current = next;
  }
  return normaliseIntervals(current);
}

/**
 * Safely parse a raw `ShowTimes` field value into a node, or null when
 * absent/blank/unparseable.
 */
export function parseShowTimes(raw: string | null | undefined): ShowTimeNode | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && typeof parsed.type === 'string'
      ? (parsed as ShowTimeNode)
      : null;
  } catch {
    return null;
  }
}

/**
 * Shortest daily window that still reads as opening hours rather than a
 * performance. Only consulted inside a park's walk-through categories (see
 * getWalkThroughCategories), where the alternative is a keeper talk or feed:
 * those run in short slots, while an animal area open for the day publishes
 * one multi-hour window. Elsewhere long windows are normal for real shows
 * (hotel entertainment, all-afternoon programmes), so this is not a general
 * show/attraction test.
 */
const OPENING_WINDOW_MIN_MS = 2 * 60 * 60 * 1000;

/**
 * True when a ShowTimes tree describes opening hours, not performances: it has
 * at least one daily `period` (period_length of exactly one day) and every
 * daily period's window is at least {@link OPENING_WINDOW_MIN_MS} long. A
 * point-in-time period (no range_length) or a short slot is a performance.
 * Weekly periods and ranges only pick which days apply, so they are ignored.
 */
export function isOpeningWindowSchedule(node: ShowTimeNode | null): boolean {
  if (!node) return false;
  const dailyWindows: number[] = [];
  const walk = (n: ShowTimeNode): void => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'period') {
      if (showTimeDurationMs(n.period_length) === SHOWTIME_DAY_MS) {
        dailyWindows.push(showTimeDurationMs(n.range_length));
      }
      return;
    }
    if ('children' in n && Array.isArray(n.children)) n.children.forEach(walk);
  };
  walk(node);
  return dailyWindows.length > 0 && dailyWindows.every(ms => ms >= OPENING_WINDOW_MIN_MS);
}

/**
 * Evaluate a ShowTimes node against the window [winStart, winEnd) and return the
 * normalised set of active intervals within that window (naive-local ms).
 */
export function evaluateShowTimeNode(
  node: ShowTimeNode,
  winStart: number,
  winEnd: number,
): ShowTimeInterval[] {
  switch (node.type) {
    case 'range': {
      const s = Math.max(parseNaiveMs(node.start), winStart);
      const e = Math.min(parseNaiveMs(node.end), winEnd);
      return Number.isFinite(s) && Number.isFinite(e) && s < e ? [[s, e]] : [];
    }

    case 'period': {
      const offset = parseNaiveMs(node.offset_date);
      const periodMs = showTimeDurationMs(node.period_length);
      const rangeMs = showTimeDurationMs(node.range_length);
      // periodMs/rangeMs come from unvalidated external duration fields. A NaN
      // slips past `<= 0` / `< 0` (both false for NaN) and would then spin the
      // loop the full SHOWTIME_MAX_ITERATIONS doing nothing — guard explicitly.
      if (
        !Number.isFinite(offset) ||
        !Number.isFinite(periodMs) || periodMs <= 0 ||
        !Number.isFinite(rangeMs) || rangeMs < 0
      ) return [];

      // A period without a range_length marks point-in-time occurrences: a show
      // start time with no encoded duration. Emit those as zero-length
      // intervals [s, s] so they survive intersection with the season/weekday
      // windows and surface as start-only slots.
      const isPoint = rangeMs === 0;

      const out: ShowTimeInterval[] = [];
      let n = Math.floor((winStart - offset - rangeMs) / periodMs);
      for (let i = 0; i < SHOWTIME_MAX_ITERATIONS; i++, n++) {
        const s = offset + n * periodMs;
        if (s >= winEnd) break;
        if (isPoint) {
          if (s >= winStart) out.push([s, s]);
          continue;
        }
        const cs = Math.max(s, winStart);
        const ce = Math.min(s + rangeMs, winEnd);
        if (cs < ce) out.push([cs, ce]);
      }
      return normaliseIntervals(out);
    }

    case 'union':
      return normaliseIntervals((node.children || []).flatMap(c => evaluateShowTimeNode(c, winStart, winEnd)));

    case 'intersection': {
      const children = node.children || [];
      if (children.length === 0) return [];
      return children
        .map(c => evaluateShowTimeNode(c, winStart, winEnd))
        .reduce((acc, cur) => intersectIntervals(acc, cur));
    }

    case 'difference': {
      const children = node.children || [];
      if (children.length === 0) return [];
      const [first, ...rest] = children.map(c => evaluateShowTimeNode(c, winStart, winEnd));
      return rest.reduce((acc, cur) => subtractIntervals(acc, cur), first);
    }

    case 'complement': {
      const inner = normaliseIntervals(
        (node.children || []).flatMap(c => evaluateShowTimeNode(c, winStart, winEnd)),
      );
      return subtractIntervals([[winStart, winEnd]], inner);
    }

    default:
      return [];
  }
}

/**
 * Evaluate a raw `ShowTimes` value for a single calendar day and return
 * schema-ready LiveTimeSlot entries with timezone-correct ISO times.
 *
 * @param raw   Stringified ShowTimes JSON (or null/undefined).
 * @param date  Target day "YYYY-MM-DD" in the park's local timezone.
 * @param timezone  IANA timezone (e.g. "Europe/Berlin").
 * @param type  Value for each slot's `type` field (defaults to "Showtime").
 */
export function showTimesForDate(
  raw: string | null | undefined,
  date: string,
  timezone: string,
  type: string = 'Showtime',
): LiveTimeSlot[] {
  const node = parseShowTimes(raw);
  if (!node) return [];

  const winStart = parseNaiveMs(`${date} 00:00:00`);
  if (!Number.isFinite(winStart)) return [];
  const winEnd = winStart + SHOWTIME_DAY_MS;

  return evaluateShowTimeNode(node, winStart, winEnd).map(([s, e]) => {
    // s/e are naive-local ms; read back the wall clock via UTC getters.
    const startIso = new Date(s).toISOString();
    const slot: LiveTimeSlot = {
      type,
      startTime: constructDateTime(startIso.slice(0, 10), startIso.slice(11, 19), timezone),
    };
    // A point occurrence (s === e) is a start time with no encoded duration —
    // leave endTime unset. Otherwise attach the concrete end.
    if (e > s) {
      const endIso = new Date(e).toISOString();
      slot.endTime = constructDateTime(endIso.slice(0, 10), endIso.slice(11, 19), timezone);
    }
    return slot;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Base class
// ─────────────────────────────────────────────────────────────────────────────

@config
class AttractionsIOV1 extends Destination {
  // ── @config properties (loaded from env with ATTRACTIONSIO_ prefix) ──────

  @config
  apiKey: string = '';

  @config
  baseURL: string = '';

  @config
  calendarURL: string = '';

  @config
  appBuild: number = 0;

  @config
  appVersion: string = '';

  @config
  deviceIdentifier: string = '123';

  // ── Instance properties set by subclass constructors ─────────────────────

  /** Destination-level entity ID (e.g. "altontowersresort") */
  destinationId: string = '';

  /** Park-level entity ID (e.g. "altontowers") */
  parkId: string = '';

  /** IANA timezone string */
  timezone: string = 'Europe/London';

  constructor(options?: DestinationConstructor) {
    super(options);

    // Pick up identity fields from constructor config
    if (options?.config) {
      const cfg = options.config;
      if (cfg.destinationId) {
        this.destinationId = Array.isArray(cfg.destinationId)
          ? cfg.destinationId[0]
          : cfg.destinationId;
      }
      if (cfg.parkId) {
        this.parkId = Array.isArray(cfg.parkId) ? cfg.parkId[0] : cfg.parkId;
      }
      if (cfg.timezone) {
        this.timezone = Array.isArray(cfg.timezone) ? cfg.timezone[0] : cfg.timezone;
      }
    }

    // Allow all Attractions.io parks to share a single env-var prefix
    this.addConfigPrefix('ATTRACTIONSIO');
  }

  /**
   * Use parkId as cache key prefix to prevent cross-park cache collisions when
   * multiple instances of AttractionsIOV1 exist simultaneously.
   */
  getCacheKeyPrefix(): string {
    return `attractionsiov1:${this.destinationId}`;
  }

  // ── Authentication ────────────────────────────────────────────────────────

  /**
   * Inject the Attractions-Io auth header onto every request going to the
   * base API hostname.  Requests tagged 'skipAuth' skip the token injection
   * (used for the initial installation call).
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: AttractionsIOV1) {
      if (!this.baseURL) return '';
      try {
        return new URL(this.baseURL).hostname;
      } catch {
        return '';
      }
    },
    tags: {$nin: ['skipAuth']},
  })
  async injectAuth(requestObj: HTTPObj): Promise<void> {
    const token = await this.getInstallationToken();
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    requestObj.headers = {
      ...requestObj.headers,
      'date': now,
      'authorization': `Attractions-Io api-key="${this.apiKey}", installation-token="${token}"`,
      'user-agent': 'okhttp/4.11.0',
    };
  }

  /**
   * Inject the api-key-only header for the skipAuth installation request.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: AttractionsIOV1) {
      if (!this.baseURL) return '';
      try {
        return new URL(this.baseURL).hostname;
      } catch {
        return '';
      }
    },
    tags: {$in: ['skipAuth']},
  })
  async injectApiKeyOnly(requestObj: HTTPObj): Promise<void> {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    requestObj.headers = {
      ...requestObj.headers,
      'date': now,
      'authorization': `Attractions-Io api-key="${this.apiKey}"`,
      'user-agent': 'okhttp/4.11.0',
    };
  }

  /**
   * POST to the installation endpoint to obtain a session token.
   * Cached for ~11 months (481,801 seconds).
   */
  @cache({ttlSeconds: 481801})
  async getInstallationToken(): Promise<string> {
    const resp = await this.fetchInstallation();
    const data: InstallationResponse = await resp.json();
    return data.token;
  }

  /**
   * HTTP method for the installation POST.
   * Tagged 'skipAuth' so only the api-key header is injected (no token yet).
   */
  @http()
  async fetchInstallation(): Promise<HTTPObj> {
    const deviceId = crypto.randomUUID();
    // The API expects application/x-www-form-urlencoded (needle's default for
    // object bodies). Sending as JSON causes 400 "App Build must be an integer"
    // because form-encoding stringifies numbers while JSON preserves them.
    const params = new URLSearchParams({
      user_identifier: deviceId,
      app_build: String(this.appBuild),
      app_version: this.appVersion,
      device_identifier: this.deviceIdentifier,
    });
    return {
      method: 'POST',
      url: `${this.baseURL}installation`,
      body: params.toString(),
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      options: {json: false},
      tags: ['skipAuth'],
    } as any as HTTPObj;
  }

  // ── Entity / POI data (SQLite-backed persistent store) ───────────────────

  /**
   * A request outside the @http queue, reported to tracing like one.
   *
   * The two asset-pack requests need the raw response: /data answers 303 with
   * the ZIP's Location, which the queue path treats as a failure, and the ZIP
   * is binary. A tracing listener sees start and complete, or start and error,
   * with the same fields the queue emits. No body is attached: one response is
   * a redirect with an empty body, the other a ZIP.
   */
  private async tracedRequest(
    methodName: string,
    options: Parameters<typeof makeHttpRequest>[0],
  ): Promise<Response> {
    const startTime = Date.now();
    const origin = {
      url: options.url,
      method: options.method,
      headers: options.headers,
      className: this.constructor.name,
      methodName,
    };
    tracing.emitHttpEvent({eventType: 'http.request.start', retryCount: 0, ...origin});
    try {
      const response = await makeHttpRequest(options, {
        className: this.constructor.name,
        methodName,
        instanceId: getHttpInstanceId(this),
        retryCount: 0,
      });
      tracing.emitHttpEvent({
        eventType: 'http.request.complete',
        status: response.status,
        duration: Date.now() - startTime,
        cacheHit: false,
        ...origin,
      });
      return response;
    } catch (error) {
      tracing.emitHttpEvent({
        eventType: 'http.request.error',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error : new Error(String(error)),
        retryCount: 0,
        ...origin,
      });
      throw error;
    }
  }

  /**
   * Download and extract the asset ZIP file from the given URL.
   */
  private async downloadAssetPack(url: string): Promise<{
    manifestData: {version: string};
    recordsData: RecordsData;
  }> {
    const response = await this.tracedRequest('downloadAssetPack', {
      method: 'GET',
      url,
      headers: {
        'accept-encoding': 'identity', // raw ZIP bytes, no gzip
        'user-agent': 'okhttp/4.11.0',
      },
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const zip = new AdmZip(buffer);

    const manifestEntry = zip.getEntry('manifest.json');
    const recordsEntry = zip.getEntry('records.json');
    if (!manifestEntry) throw new Error('No manifest.json found in ZIP');
    if (!recordsEntry) throw new Error('No records.json found in ZIP');

    return {
      manifestData: JSON.parse(zip.readAsText(manifestEntry)),
      recordsData: JSON.parse(zip.readAsText(recordsEntry)),
    };
  }

  /**
   * Return the full POI dataset for this park.
   *
   * Data is stored in the `attractionsio_entities` SQLite table (one row per
   * record), not as a giant JSON blob. The @cache decorator memoises the
   * reconstructed RecordsData for 12 hours so we don't re-read from SQLite
   * on every call within that window. When the cache expires, _syncFromAPI()
   * checks for a new ZIP and applies deltas.
   */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getPOIData(): Promise<RecordsData> {
    await this._syncFromAPI();
    return this._readEntitiesFromDB();
  }

  /**
   * Sync entity data from the Attractions.io API into the local SQLite store.
   *
   * Always fetches the /data endpoint without a version parameter so we get
   * the full ZIP (matching the mobile app pattern). If the manifest version
   * matches what we already have, we skip parsing. Otherwise we diff/upsert
   * every record: new items are inserted, existing items are updated, and
   * items missing from the new data are soft-deleted (removedAt set).
   */
  private async _syncFromAPI(depth = 0): Promise<void> {
    // Build auth headers
    const token = await this.getInstallationToken();
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const authHeaders: Record<string, string> = {
      'date': now,
      'authorization': `Attractions-Io api-key="${this.apiKey}", installation-token="${token}"`,
      'accept-encoding': 'identity',
      'user-agent': 'okhttp/4.11.0',
    };

    const response = await this.tracedRequest('_syncFromAPI', {
      method: 'GET',
      url: `${this.baseURL}data`,
      headers: authHeaders,
    });

    if (response.status === 202) {
      if (depth >= 5) {
        throw new Error('AttractionsIO data generation still in progress after 5 attempts');
      }
      const waitSeconds = 10 * (depth + 1);
      console.log(
        `[AttractionsIOV1] 202 received for ${this.destinationId}, ` +
        `waiting ${waitSeconds}s (attempt ${depth + 1}/5)…`,
      );
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      return this._syncFromAPI(depth + 1);
    }

    if (response.status !== 303) {
      // 200/304/etc. — no new data. If we already have data in the DB, that's fine.
      const hasData = this._hasStoredEntities();
      if (!hasData) {
        throw new Error(
          `AttractionsIO returned ${response.status} but no stored data exists for ${this.destinationId}`,
        );
      }
      return;
    }

    // 303 — redirect to ZIP
    const zipUrl = response.headers.get('location');
    if (!zipUrl) {
      throw new Error('AttractionsIO 303 response missing Location header');
    }

    const {manifestData, recordsData} = await this.downloadAssetPack(zipUrl);

    // Check version — skip if we already have this exact version
    const storedVersion = this._getStoredVersion();
    if (storedVersion === manifestData.version) {
      return;
    }

    // Diff and upsert into SQLite
    this._diffAndUpsert(recordsData, manifestData.version);
  }

  // ── SQLite helpers ──────────────────────────────────────────────────────

  private _getStoredVersion(): string | null {
    const row = database
      .prepare('SELECT version FROM attractionsio_versions WHERE park_id = ?')
      .get(this.destinationId) as {version: string} | undefined;
    return row?.version ?? null;
  }

  private _hasStoredEntities(): boolean {
    const row = database
      .prepare(
        'SELECT COUNT(*) as cnt FROM attractionsio_entities WHERE park_id = ? AND removed_at IS NULL',
      )
      .get(this.destinationId) as {cnt: number};
    return row.cnt > 0;
  }

  /**
   * Read all active entities from SQLite and reconstruct the RecordsData shape.
   */
  private _readEntitiesFromDB(): RecordsData {
    const rows = database
      .prepare(
        'SELECT record_type, data FROM attractionsio_entities WHERE park_id = ? AND removed_at IS NULL',
      )
      .all(this.destinationId) as {record_type: string; data: string}[];

    const result: RecordsData = {Resort: [], Item: [], Category: []};
    for (const row of rows) {
      const parsed = JSON.parse(row.data);
      if (row.record_type === 'Resort') result.Resort.push(parsed);
      else if (row.record_type === 'Item') result.Item.push(parsed);
      else if (row.record_type === 'Category') result.Category.push(parsed);
    }
    return result;
  }

  /**
   * Item records soft-deleted from the store whose last containing pack is no
   * older than `sinceMs`, as they were last published.
   *
   * `last_version` is the manifest version of the newest pack that still held
   * the item: an upstream timestamp. `removed_at` is only when this store
   * noticed, which for a store that has not synced in weeks is long after the
   * item really left, so the window is measured from the pack, not from it.
   * An unparseable version never qualifies.
   */
  private _readItemsDroppedFromPacksSince(sinceMs: number): RecordItem[] {
    const rows = database
      .prepare(
        "SELECT data, last_version FROM attractionsio_entities WHERE park_id = ? AND record_type = 'Item' " +
        'AND removed_at IS NOT NULL',
      )
      .all(this.destinationId) as {data: string; last_version: string}[];
    const items: RecordItem[] = [];
    for (const row of rows) {
      const packAt = Date.parse(row.last_version);
      if (!Number.isFinite(packAt) || packAt < sinceMs) continue;
      try {
        items.push(JSON.parse(row.data));
      } catch {
        // A corrupt stored row is skipped, not fatal.
      }
    }
    return items;
  }

  /** Memo of the last grace evaluation: {at, items}. */
  private _packDropGraceMemo: {at: number; items: Promise<RecordItem[]>} | null = null;

  /**
   * Items the asset pack dropped recently that the live feed still runs.
   *
   * An item qualifies only when both hold:
   *   - the last pack that contained it is within PACK_DROP_GRACE_DAYS of now
   *     (its manifest version, an upstream timestamp), and
   *   - the live feed either carries it with an OpeningTimes range between
   *     yesterday and a week ahead, park-local, or reports it
   *     IsOperational: true.
   *
   * Neither condition is enough alone. The live feed keeps records for items
   * retired long ago, some still with a daily OpeningTimes, so the feed cannot
   * vouch for an item by itself; and an item the feed neither schedules nor
   * runs has no evidence it is still running. Items that never reached the
   * store, or whose last pack is older than the window, are never revived,
   * however recently this store noticed them missing. Once the window passes
   * or the feed stops carrying the item as scheduled or running, it drops out
   * as any other removal does.
   */
  protected async getPackDropGraceItems(): Promise<RecordItem[]> {
    // A build classifies items many times over; evaluate the grace set once
    // per short window instead of re-reading the store and the feed each time.
    const now = Date.now();
    const memo = this._packDropGraceMemo;
    if (memo && now >= memo.at && now - memo.at < PACK_DROP_GRACE_MEMO_MS) return memo.items;
    const items = this._evaluatePackDropGraceItems(now);
    this._packDropGraceMemo = {at: now, items};
    return items;
  }

  /**
   * One evaluation of the grace set. Never throws: the window is a best-effort
   * addition to the pack, so a store or feed failure leaves the entity list
   * equal to the pack rather than failing the build.
   */
  private async _evaluatePackDropGraceItems(now: number): Promise<RecordItem[]> {
    try {
      const dropped = this._readItemsDroppedFromPacksSince(now - PACK_DROP_GRACE_MS);
      if (dropped.length === 0) return [];

      const resp = await this.fetchLiveData();
      const raw: LiveDataResponse = await resp.json();
      const records: LiveDataRecord[] = raw?.entities?.Item?.records ?? [];
      const from = formatDate(new Date(now + PACK_DROP_SCHEDULE_FROM_DAYS * DAY_MS), this.timezone);
      const to = formatDate(new Date(now + PACK_DROP_SCHEDULE_TO_DAYS * DAY_MS), this.timezone);
      const running = new Set(
        records
          .filter(r => r.IsOperational === true || isScheduledBetween(r.OpeningTimes, this.timezone, from, to))
          .map(r => r._id),
      );
      return dropped.filter(item => running.has(item._id));
    } catch (error) {
      console.warn(
        `[AttractionsIOV1] ${this.destinationId}: pack-drop grace window skipped, publishing the pack as-is: ` +
        (error instanceof Error ? error.message : String(error)),
      );
      return [];
    }
  }

  /**
   * The records entities are built from: the current pack, plus any item kept
   * by the pack-drop grace window (getPackDropGraceItems). Categories and the
   * resort come from the current pack only.
   */
  protected async getCatalogue(): Promise<RecordsData> {
    const data = await this.getPOIData();
    const grace = await this.getPackDropGraceItems();
    if (grace.length === 0) return data;
    const current = new Set(data.Item.map(item => item._id));
    return {...data, Item: [...data.Item, ...grace.filter(item => !current.has(item._id))]};
  }

  /**
   * Diff incoming records against the SQLite store and apply changes.
   * New records are inserted, existing records are updated (and un-deleted
   * if they were previously soft-deleted), and records not present in the
   * new data are soft-deleted.
   */
  private _diffAndUpsert(data: RecordsData, version: string): void {
    const now = Date.now();

    // Read all existing entities for this park (including soft-deleted)
    const existing = database
      .prepare(
        'SELECT record_type, entity_id, removed_at FROM attractionsio_entities WHERE park_id = ?',
      )
      .all(this.destinationId) as {
      record_type: string;
      entity_id: string;
      removed_at: number | null;
    }[];
    const existingKeys = new Set(existing.map(e => `${e.record_type}:${e.entity_id}`));
    const existingRemoved = new Map(
      existing.filter(e => e.removed_at !== null).map(e => [`${e.record_type}:${e.entity_id}`, true]),
    );

    const seenKeys = new Set<string>();

    // Prepare statements
    const upsertStmt = database.prepare(`
      INSERT INTO attractionsio_entities (park_id, record_type, entity_id, data, last_version, removed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT (park_id, record_type, entity_id) DO UPDATE SET
        data = excluded.data,
        last_version = excluded.last_version,
        removed_at = NULL,
        updated_at = excluded.updated_at
    `);

    const softDeleteStmt = database.prepare(`
      UPDATE attractionsio_entities SET removed_at = ?, updated_at = ?
      WHERE park_id = ? AND record_type = ? AND entity_id = ? AND removed_at IS NULL
    `);

    const versionStmt = database.prepare(`
      INSERT OR REPLACE INTO attractionsio_versions (park_id, version, updated_at)
      VALUES (?, ?, ?)
    `);

    // Wrap in a transaction for atomicity
    database.exec('BEGIN');
    try {
      const recordTypes: Array<{type: keyof RecordsData; name: string}> = [
        {type: 'Resort', name: 'Resort'},
        {type: 'Category', name: 'Category'},
        {type: 'Item', name: 'Item'},
      ];

      for (const {type, name} of recordTypes) {
        const records = data[type] || [];
        for (const record of records) {
          const entityId = String(record._id);
          const key = `${name}:${entityId}`;
          seenKeys.add(key);
          upsertStmt.run(
            this.destinationId,
            name,
            entityId,
            JSON.stringify(record),
            version,
            now,
          );
        }
      }

      // Soft-delete records not in the new data
      for (const key of existingKeys) {
        if (!seenKeys.has(key) && !existingRemoved.has(key)) {
          const [recordType, entityId] = key.split(':');
          softDeleteStmt.run(now, now, this.destinationId, recordType, entityId);
        }
      }

      // Update stored version
      versionStmt.run(this.destinationId, version, now);

      database.exec('COMMIT');
    } catch (e) {
      database.exec('ROLLBACK');
      throw e;
    }
  }

  // ── Category helpers ──────────────────────────────────────────────────────

  /**
   * Return all category _ids matching a given category name, including
   * immediate child categories.
   */
  @cache({ttlSeconds: 60 * 60 * 2})
  async getCategoryIDs(categoryName: string): Promise<number[]> {
    const data = await this.getPOIData();
    const ids: number[] = [];

    const parents = data.Category.filter(
      c => extractName(c.Name) === categoryName
    );
    if (parents.length === 0) return [];

    for (const parent of parents) {
      ids.push(parent._id);
      // Add children
      data.Category.filter(c => c.Parent === parent._id).forEach(c => ids.push(c._id));
    }

    return ids;
  }

  /**
   * Collect all items belonging to any of the given category names.
   */
  private async getItemsForCategories(categoryNames: string[]): Promise<RecordItem[]> {
    const allCatIds: number[] = [];
    for (const name of categoryNames) {
      const ids = await this.getCategoryIDs(name);
      allCatIds.push(...ids);
    }

    const data = await this.getCatalogue();
    return data.Item.filter(item =>
      item.Category !== undefined &&
      allCatIds.includes(item.Category) &&
      !this.isPaidProductListing(item),
    );
  }

  /**
   * Whether a record is a paid product the park files among its places, such
   * as a queue-skip package listed beside the rides it sells. Such a record
   * is not a place, so it is published as nothing, whichever category holds
   * it. False for every park unless it names the product.
   *
   * The record's other fields do not make a safe rule here. A package and the
   * rides that sell it carry the same "Buy ..." call-to-actions. At Alton
   * Towers the packages are the only published attractions that are off the
   * map (VisibleOnMap and WayfindingEnabled false) with no classifications,
   * but real rides in other Merlin parks share that combination (LEGOLAND
   * Billund's pirate boats, Djurs Sommerland's fireworks show). A park that
   * lists packages therefore matches them by the name its own feed gives the
   * product, never by the flags, the call-to-actions or the summary.
   */
  protected isPaidProductListing(_item: RecordItem): boolean {
    return false;
  }

  /**
   * Whether a record filed under a restaurant category is not somewhere a
   * guest can eat: an information page about the park's food, or a kiosk that
   * only the queue of a ride can reach. Such a record is published as nothing
   * (no entity, no live row), the way a seasonal menu special is. False for
   * every park unless it names the signal its own feed gives.
   *
   * Only records the restaurant lists would publish are asked, so a ride or a
   * show is never affected, and a park names a signal that holds for its own
   * restaurant records rather than for every record in the pack: the same
   * flags mark real rides as unroutable in other parks.
   */
  protected isNonVenueRestaurantListing(_item: RecordItem): boolean {
    return false;
  }

  /**
   * Names of seasonal event categories whose restaurant sub-categories list
   * the event's menu specials rather than outlets. Empty unless a park names
   * the container its own feed uses.
   *
   * A restaurant category nested under any other parent is not affected: a
   * hotel's "Dining" is a list of real restaurants. Only the named parent
   * says that what sits below it is food sold at an outlet that is already
   * listed on its own.
   *
   * A parent is matched on its whole name, ignoring case and the amount or
   * kind of whitespace (see normaliseName), so a category the park
   * re-types as "BRICK OR TREAT" still counts and "Brick or Treat Hotel" does
   * not.
   */
  protected getSeasonalMenuParentCategories(): string[] {
    return [];
  }

  /**
   * The items whose category sits below one of the seasonal parents named by
   * getSeasonalMenuParentCategories(), at any depth, whatever kind of item
   * they are: the same parent holds the season's shows, meet and greets and
   * rides. Walks the parent links with a cycle guard, since the records are
   * external data.
   */
  private async getItemIdsBelowSeasonalParents(): Promise<Set<number>> {
    const parents = new Set(this.getSeasonalMenuParentCategories().map(normaliseName));
    if (parents.size === 0) return new Set();

    const data = await this.getCatalogue();
    const byId = new Map(data.Category.map(category => [category._id, category]));
    const sitsBelowSeasonalParent = (categoryId: number | undefined): boolean => {
      const seen = new Set<number>();
      let current = categoryId === undefined ? undefined : byId.get(categoryId);
      while (current && !seen.has(current._id)) {
        seen.add(current._id);
        const parent: CategoryRecord | undefined =
          current.Parent === undefined || current.Parent === null ? undefined : byId.get(current.Parent);
        if (parent && parents.has(normaliseName(extractName(parent.Name)))) return true;
        current = parent;
      }
      return false;
    };

    return new Set(data.Item.filter(item => sitsBelowSeasonalParent(item.Category)).map(item => item._id));
  }

  /**
   * Category names treated as SHOW entities. Overridable by subclasses whose
   * park files its shows under a different category name.
   */
  protected getShowCategories(): string[] {
    return SHOW_CATEGORIES;
  }

  /**
   * Category names (matched with their immediate children, as for the other
   * lists) whose scheduled items are walk-through areas when their schedule is
   * an opening window rather than performances. Empty by default; a park opts
   * in with the category its own feed uses.
   */
  protected getWalkThroughCategories(): string[] {
    return [];
  }

  /**
   * Items published as walk-through ATTRACTIONs: filed under one of this
   * park's walk-through categories, not claimed by the attraction, show or
   * restaurant lists, and carrying a ShowTimes schedule that is an opening
   * window (see isOpeningWindowSchedule). A scheduled keeper talk in the same
   * category has short slots and stays a SHOW.
   */
  private async getWalkThroughItems(): Promise<RecordItem[]> {
    const categories = this.getWalkThroughCategories();
    if (categories.length === 0) return [];
    const listed = new Set(
      (await this.getItemsForCategories([
        ...ATTRACTION_CATEGORIES,
        ...this.getShowCategories(),
        ...RESTAURANT_CATEGORIES,
      ])).map(item => item._id),
    );
    const items = await this.getItemsForCategories(categories);
    return items.filter(item =>
      !listed.has(item._id) && isOpeningWindowSchedule(parseShowTimes(item.ShowTimes)),
    );
  }

  // ── Live data ─────────────────────────────────────────────────────────────

  /**
   * Fetch the public live-data JSON (no auth required).
   * Cached for 1 minute.
   */
  @http({cacheSeconds: 60})
  async fetchLiveData(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `https://live-data.attractions.io/${this.apiKey}.json`,
      options: {json: true},
      tags: ['liveData'],
    } as any as HTTPObj;
  }

  // ── Schedule ──────────────────────────────────────────────────────────────

  /**
   * Fetch the calendar JSON from the configured calendarURL.
   * Cached for 2 hours.
   */
  @http({cacheSeconds: 60 * 60 * 2})
  async fetchCalendar(): Promise<HTTPObj> {
    // Calendar URLs are park websites (altontowers.com, gardaland.it, etc.)
    // which block non-browser User-Agents. Use a browser-like UA.
    return {
      method: 'GET',
      url: this.calendarURL,
      headers: {
        'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
      },
      options: {json: true},
      tags: ['calendar'],
    } as any as HTTPObj;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Template Method implementations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Return the single destination entity for this park.
   */
  async getDestinations(): Promise<Entity[]> {
    const data = await this.getPOIData();
    if (!data.Resort || data.Resort.length === 0) {
      throw new Error(`No resort data for ${this.destinationId}`);
    }

    const resort = data.Resort[0];
    const entity: Entity = {
      id: this.destinationId,
      name: extractName(resort.Name),
      entityType: 'DESTINATION',
      timezone: this.timezone,
    } as Entity;

    const loc = parseLocation(resort.DirectionsLocation || resort.Location);
    if (loc) entity.location = loc;

    return [entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const data = await this.getCatalogue();

    if (!data.Resort || data.Resort.length === 0) {
      throw new Error(`No resort data for ${this.destinationId}`);
    }

    const resort = data.Resort[0];

    // Park entity — strip trailing " Resort" from name
    let parkName = extractName(resort.Name).replace(/\s*Resort$/, '');
    const parkEntity: Entity = {
      id: this.parkId,
      name: parkName,
      entityType: 'PARK',
      parentId: this.destinationId,
      destinationId: this.destinationId,
      timezone: this.timezone,
    } as Entity;

    const parkLoc = parseLocation(resort.DirectionsLocation || resort.Location);
    if (parkLoc) parkEntity.location = parkLoc;

    // Attractions
    const attractionItems = await this.getItemsForCategories(ATTRACTION_CATEGORIES);
    const attractionEntities = attractionItems.map(item =>
      buildItemEntity(item, this.parkId, this.destinationId, this.timezone, 'ATTRACTION')
    );

    // Shows
    const showItems = await this.getItemsForCategories(this.getShowCategories());
    const showEntities = showItems.map(item =>
      buildItemEntity(item, this.parkId, this.destinationId, this.timezone, 'SHOW')
    );

    // Restaurants, less a seasonal event's menu specials (see
    // getSeasonalMenuParentCategories) and the records that are no venue (see
    // isNonVenueRestaurantListing). Only the restaurant-listed items under the
    // seasonal parent are specials; the rest of what sits there is classified
    // as usual.
    const belowSeasonalParent = await this.getItemIdsBelowSeasonalParents();
    const restaurantCandidates = await this.getItemsForCategories(RESTAURANT_CATEGORIES);
    const isNotVenue = (item: RecordItem) =>
      belowSeasonalParent.has(item._id) || this.isNonVenueRestaurantListing(item);
    const nonVenueItems = restaurantCandidates.filter(isNotVenue);
    const restaurantItems = restaurantCandidates.filter(item => !isNotVenue(item));
    const restaurantEntities = restaurantItems.map(item =>
      buildItemEntity(item, this.parkId, this.destinationId, this.timezone, 'RESTAURANT')
    );

    // Scheduled performances under a category none of the lists name. Seasonal
    // content lives in categories no fixed list can anticipate (Chessington's
    // top-level "Howl’o’ween " / "Summer ", Legoland Korea's "Season Content",
    // Legoland California's "Brick or Treat" > "SHOWS"), but the item's own
    // ShowTimes schedule marks it as a performance. There is no equivalent
    // signal for rides: a height requirement also sits on Thorpe Park's
    // per-ride "Ride Access Pass" duplicates, so unlisted items without a
    // schedule stay unclassified.
    // The records that are no venue count as classified although they are not
    // published: left out of this set, one that carried a schedule would come
    // back from the fallback below as a SHOW.
    const classified = new Set(
      [...attractionItems, ...showItems, ...restaurantItems, ...nonVenueItems].map(item => item._id),
    );

    // Walk-through areas the park files in a category of their own with an
    // opening-hours schedule. Taken before the scheduled-show fallback, which
    // would otherwise read that schedule as performances. attractionType is
    // explicit: RIDE is what every other walk-through in this library carries,
    // and the base class would otherwise default to it silently.
    const walkThroughItems = await this.getWalkThroughItems();
    const walkThroughEntities = walkThroughItems.map(item => {
      const entity = buildItemEntity(item, this.parkId, this.destinationId, this.timezone, 'ATTRACTION');
      (entity as Entity & {attractionType?: string}).attractionType = 'RIDE';
      return entity;
    });
    for (const item of walkThroughItems) classified.add(item._id);

    const scheduledShowEntities = data.Item
      .filter(item =>
        !classified.has(item._id) &&
        !this.isPaidProductListing(item) &&
        parseShowTimes(item.ShowTimes) !== null,
      )
      .map(item => buildItemEntity(item, this.parkId, this.destinationId, this.timezone, 'SHOW'));

    return [
      ...await this.getDestinations(),
      parkEntity,
      ...attractionEntities,
      ...walkThroughEntities,
      ...showEntities,
      ...restaurantEntities,
      ...scheduledShowEntities,
    ];
  }

  /**
   * Build live data for every entity type the API exposes:
   *   - attractions — operating status + standby wait time (live feed)
   *   - restaurants — open/closed status + today's opening hours (live feed)
   *   - shows — today's performance times, evaluated from each show's recurring
   *     ShowTimes schedule in the records data (there is no live show feed)
   *
   * Each block is driven by the entity IDs that actually exist for the park, so
   * a park that has no restaurants/shows (or whose live feed omits the venue
   * fields) simply contributes nothing for those blocks.
   */
  protected async buildLiveData(): Promise<LiveData[]> {
    const entities = await this.getEntities();
    // Walk-through areas publish their hours as a schedule, and the live feed
    // carries no usable signal for them (Chessington's Wanyama Village sits in
    // it at IsOperational:false with no OpeningTimes, whatever the time of
    // day). Their status comes from that schedule instead, as it did while
    // they were published as shows, so they are kept out of the ride branch.
    const walkThroughItems = await this.getWalkThroughItems();
    const walkThroughIds = new Set(walkThroughItems.map(item => String(item._id)));
    const attractionIds = new Set(
      entities
        .filter(e => e.entityType === 'ATTRACTION' && !walkThroughIds.has(e.id))
        .map(e => e.id),
    );
    const restaurantIds = new Set(
      entities.filter(e => e.entityType === 'RESTAURANT').map(e => e.id),
    );
    const showIds = new Set(
      entities.filter(e => e.entityType === 'SHOW').map(e => e.id),
    );

    const resp = await this.fetchLiveData();
    const raw: LiveDataResponse = await resp.json();

    const records: LiveDataRecord[] = raw?.entities?.Item?.records ?? [];

    const liveData: LiveData[] = [];

    for (const record of records) {
      const id = String(record._id);

      // Attractions: operating status + standby wait time
      if (attractionIds.has(id)) {
        // An explicit boolean IsOpen is the authoritative live signal, as in
        // the dining branch below: some feeds (e.g. Djurs Sommerland) set
        // IsOperational only on their queue-metered rides, leaving every
        // unmetered-but-open attraction at IsOperational:false. Fall back to
        // IsOperational when IsOpen is absent (Merlin feeds omit it on
        // non-operating rides).
        const isOpen = typeof record.IsOpen === 'boolean'
          ? record.IsOpen
          : !!record.IsOperational;
        const status: 'OPERATING' | 'CLOSED' = isOpen ? 'OPERATING' : 'CLOSED';

        const entry: LiveData = {
          id,
          status,
        };

        // Wait time (in seconds from API – convert to minutes)
        if (record.QueueTime !== undefined && record.QueueTime !== null) {
          if (typeof record.QueueTime === 'number' && Number.isFinite(record.QueueTime)) {
            entry.queue = {
              STANDBY: {waitTime: Math.floor(record.QueueTime / 60)},
            };
          }
        } else if (record.QueueTime === null) {
          entry.queue = {
            STANDBY: {waitTime: undefined},
          };
        }

        liveData.push(entry);
        continue;
      }

      // Restaurants: open/closed status + today's opening hours. Dining venues
      // report IsOperational:false unconditionally (it flags running rides), so
      // IsOpen is the real signal here.
      if (restaurantIds.has(id)) {
        const hours = parseLiveOpeningTimes(record.OpeningTimes, this.timezone);

        // IsOpen is the live open/closed signal for dining venues. Some feeds
        // omit it for a subset of venues; there, fall back to whether "now"
        // sits inside today's opening window rather than asserting CLOSED with
        // no evidence.
        let status: 'OPERATING' | 'CLOSED';
        if (typeof record.IsOpen === 'boolean') {
          status = record.IsOpen ? 'OPERATING' : 'CLOSED';
        } else {
          status = isOpenNow(hours, Date.now()) ? 'OPERATING' : 'CLOSED';
        }

        const entry: LiveData = {id, status};
        if (hours.length > 0) entry.operatingHours = hours;

        liveData.push(entry);
        continue;
      }
    }

    // Shows: today's performance times, evaluated from each show's recurring
    // ShowTimes schedule in the records data (not the live feed)
    if (showIds.size > 0) {
      const today = formatDate(new Date(), this.timezone);
      const poi = await this.getCatalogue();
      for (const item of poi.Item) {
        const id = String(item._id);
        if (!showIds.has(id)) continue;
        // An item classified into more than one type (e.g. a show-named category
        // nested under an attraction one) must not emit a second, conflicting
        // live-data entry — keep the earlier classification.
        if (attractionIds.has(id) || restaurantIds.has(id)) continue;

        // A single malformed ShowTimes record must not take down live data for
        // the whole park (attraction/restaurant entries are already on the
        // array). Contain the failure to this one show and keep the rest.
        let showtimes: LiveTimeSlot[];
        try {
          showtimes = showTimesForDate(item.ShowTimes, today, this.timezone);
        } catch {
          continue;
        }

        // Status derives from the schedule (there is no live "running now" feed):
        // OPERATING only while a performance is still upcoming or ongoing, then
        // CLOSED once the day's last performance has ended. The full day's
        // schedule stays published in `showtimes`.
        const nowMs = Date.now();
        const hasUpcoming = showtimes.some(s => {
          const end = s.endTime ?? s.startTime;
          return end != null && Date.parse(end) > nowMs;
        });

        const entry: LiveData = {
          id,
          status: hasUpcoming ? 'OPERATING' : 'CLOSED',
        };
        if (showtimes.length > 0) entry.showtimes = showtimes;
        liveData.push(entry);
      }
    }

    // Walk-throughs: OPERATING while "now" sits inside one of today's opening
    // windows, CLOSED otherwise; today's windows are published as
    // operatingHours. Only ids that made it into the entity list are emitted.
    if (walkThroughIds.size > 0) {
      const today = formatDate(new Date(), this.timezone);
      const nowMs = Date.now();
      for (const item of walkThroughItems) {
        const id = String(item._id);
        if (!entities.some(e => e.id === id && e.entityType === 'ATTRACTION')) continue;
        let hours: LiveTimeSlot[];
        try {
          hours = showTimesForDate(item.ShowTimes, today, this.timezone, 'OPERATING');
        } catch {
          continue;
        }
        const entry: LiveData = {id, status: isOpenNow(hours, nowMs) ? 'OPERATING' : 'CLOSED'};
        if (hours.length > 0) entry.operatingHours = hours;
        liveData.push(entry);
      }
    }

    return liveData;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    return this._buildCalendarSchedules();
  }

  /**
   * Parse the standard calendar API response into EntitySchedule[].
   * Shared by most parks; overridden by HeidePark and DjursSommerland.
   */
  protected async _buildCalendarSchedules(): Promise<EntitySchedule[]> {
    let calData: CalendarResponse;
    try {
      const resp = await this.fetchCalendar();
      calData = await resp.json();
    } catch {
      return [{id: this.parkId, schedule: []}];
    }

    const locations = calData?.Locations ?? calData?.locations ?? [];
    if (!locations.length) {
      return [{id: this.parkId, schedule: []}];
    }

    // Use the location with the most days (mirrors JS logic)
    let days: CalendarDay[] = locations[0].days ?? [];
    if (days.length === 0) {
      for (const loc of locations) {
        if ((loc.days?.length ?? 0) > days.length) {
          days = loc.days;
        }
      }
    }

    const schedule: Array<{
      date: string;
      type: 'OPERATING';
      openingTime: string;
      closingTime: string;
    }> = [];

    // An unparseable day is dropped, which silently removes a real operating
    // day from the schedule. Collect the offending formats and warn once, so a
    // new upstream wording is visible instead of just quietly shrinking the
    // calendar.
    const unparsed = new Map<string, number>();

    for (const day of days) {
      const dateStr = parseYYYYMMDD(day.key); // "20260330" → "2026-03-30"
      if (!dateStr) continue;

      const times = parseOpeningHours(day.openingHours);
      if (!times) {
        const raw = String(day.openingHours ?? '');
        unparsed.set(raw, (unparsed.get(raw) ?? 0) + 1);
        continue;
      }

      schedule.push({
        date: dateStr,
        type: 'OPERATING',
        openingTime: constructDateTime(dateStr, times.openTime, this.timezone),
        closingTime: constructDateTime(dateStr, times.closeTime, this.timezone),
      });
    }

    if (unparsed.size) {
      const summary = [...unparsed.entries()]
        .map(([raw, count]) => `${count}x ${JSON.stringify(raw)}`)
        .join(', ');
      console.warn(
        `[${this.constructor.name}] dropped ${[...unparsed.values()].reduce((a, b) => a + b, 0)} ` +
        `calendar day(s) with unrecognised openingHours: ${summary}`,
      );
    }

    return [{id: this.parkId, schedule}];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers (module-level, not class members)
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "lat,lng" string into a location object, or return undefined. */
function parseLocation(raw?: string): {latitude: number; longitude: number} | undefined {
  if (!raw) return undefined;
  try {
    const parts = raw.split(',').map(Number);
    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return {latitude: parts[0], longitude: parts[1]};
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Convert "YYYYMMDD" to "YYYY-MM-DD". Returns null on invalid input. */
function parseYYYYMMDD(raw: string): string | null {
  if (!/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

/** Build a full Entity from a records.json Item. */
function buildItemEntity(
  item: RecordItem,
  parkId: string,
  destinationId: string,
  timezone: string,
  entityType: 'ATTRACTION' | 'SHOW' | 'RESTAURANT'
): Entity {
  const entity: Entity = {
    id: String(item._id),
    name: stripMapNumberPrefix(extractName(item.Name)),
    entityType,
    parentId: parkId,
    parkId,
    destinationId,
    timezone,
  } as Entity;

  // Location — prefer DirectionsLocation, fall back to Location
  const loc = parseLocation(item.DirectionsLocation || item.Location);
  if (loc) entity.location = loc;

  // Tags
  const tags = [];

  if (typeof item.MinimumHeightRequirement === 'number') {
    const heightCm = Math.floor(item.MinimumHeightRequirement * 100);
    tags.push(TagBuilder.minimumHeight(heightCm, 'cm'));
  }

  if (
    item.MinimumUnaccompaniedHeightRequirement !== undefined &&
    item.MinimumUnaccompaniedHeightRequirement !== null &&
    typeof item.MinimumUnaccompaniedHeightRequirement === 'number'
  ) {
    const heightCm = Math.floor(item.MinimumUnaccompaniedHeightRequirement * 100);
    // Only add if different from the supervised minimum height
    if (
      typeof item.MinimumHeightRequirement !== 'number' ||
      Math.floor(item.MinimumUnaccompaniedHeightRequirement * 100) !==
        Math.floor(item.MinimumHeightRequirement * 100)
    ) {
      tags.push(TagBuilder.minimumHeightUnaccompanied(heightCm, 'cm'));
    }
  }

  if (tags.length > 0) {
    entity.tags = tags;
  }

  return entity;
}

// ─────────────────────────────────────────────────────────────────────────────
// Park subclasses
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alton Towers Resort, Staffordshire, UK
 */
@destinationController({category: ['Merlin', 'Alton Towers']})
export class AltonTowers extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'altontowersresort',
        parkId: 'altontowers',
        timezone: 'Europe/London',
        appBuild: 293 as any,
        appVersion: '5.3',
        ...options?.config,
      },
    });
  }

  /**
   * Alton Towers lists its paid queue-skip packages as items of its
   * "Attractions" categories: "Fastrack Packages" under Thrills, "CBeebies
   * Land Fastrack" under CBeebies Land and "Thrills Combi Fastrack". Fastrack
   * is the name of the product, and no ride at the park carries it, so the
   * name is what separates a package from the rides that sell one.
   */
  protected isPaidProductListing(item: RecordItem): boolean {
    return /\bFastrack\b/i.test(extractName(item.Name));
  }
}

/**
 * Thorpe Park Resort, Surrey, UK
 */
@destinationController({category: ['Merlin', 'Thorpe Park']})
export class ThorpePark extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'thorpeparkresort',
        parkId: 'thorpepark',
        timezone: 'Europe/London',
        appBuild: 299 as any,
        appVersion: '1.4',
        ...options?.config,
      },
    });
  }

  /**
   * Thorpe Park files two information pages ("Allergies & Intolerances",
   * "Food & Drink Information") and three kiosks inside a ride's queue
   * ("Q-line Kiosk" for Colossus, The Swarm and SAW - The Ride) among its
   * restaurants. The app does not route a guest to any of them
   * (WayfindingEnabled is false). Every other restaurant record in the pack
   * is routable, including the two Q-line kiosks at a ride's entrance, so the
   * flag separates the five where the name does not.
   */
  protected isNonVenueRestaurantListing(item: RecordItem): boolean {
    return item.WayfindingEnabled === false;
  }
}

/**
 * Chessington World of Adventures Resort, Surrey, UK
 */
@destinationController({category: ['Merlin', 'Chessington']})
export class ChessingtonWorldOfAdventures extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'chessingtonworldofadventuresresort',
        parkId: 'chessingtonworldofadventures',
        timezone: 'Europe/London',
        appBuild: 178 as any,
        appVersion: '3.3',
        ...options?.config,
      },
    });
  }

  /**
   * Chessington files its zoo in a top-level "Zoo Encounters" category that
   * mixes walk-through animal areas (Wanyama Village, Trail of the Kings, the
   * aquarium) with keeper talks. Its "Zoo Areas" and "Animal Talks" child
   * categories exist but are empty; every item sits on the parent. The areas
   * that carry a schedule publish one multi-hour daily window, which is what
   * separates them from a talk.
   */
  protected getWalkThroughCategories(): string[] {
    return ['Zoo Encounters'];
  }
}

/**
 * LEGOLAND Windsor Resort, Berkshire, UK
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandWindsor extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandwindsorresort',
        parkId: 'legolandwindsor',
        timezone: 'Europe/London',
        appBuild: 113 as any,
        appVersion: '2.4',
        ...options?.config,
      },
    });
  }
}

/**
 * A sentence of a menu item's summary that names the outlet selling it:
 * "Served at <Outlet>", "Pick yours up (now) at the <Outlet>". The outlet's
 * name starts with a capital, which leaves out a time ("served at 7 a.m.") and
 * a place described in lower case ("pick yours up at the window").
 */
const SOLD_AT_AN_OUTLET = /\b(?:[Ss]erved|[Pp]ick (?:it|yours|them) up(?: now)?) at (?:the )?[A-Z]/;

/**
 * LEGOLAND Florida Resort, Winter Haven, FL
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandOrlando extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandorlandoresort',
        parkId: 'legolandorlando',
        timezone: 'America/New_York',
        appBuild: 115 as any,
        appVersion: '1.6.1',
        ...options?.config,
      },
    });
  }

  /**
   * The Halloween season keeps its own "Dining" category under "Brick or
   * Treat". Its items are the season's menu specials ("Hex Wrap", "Spider
   * Slush", "Franken-slice"), each sold at an outlet that is already a
   * restaurant of its own: the summary says "Served at <outlet>".
   */
  protected getSeasonalMenuParentCategories(): string[] {
    return ['Brick or Treat'];
  }

  /**
   * Menu items also turn up in the top-level "Dining" category, outside the
   * Halloween parent ("NEW! Brick Ice Lolly"). No flag, classification or
   * category sets one apart: real Dining venues have the same empty
   * classifications and the same flags. What does is the summary, which sends
   * the guest to the outlets that sell it ("Pick yours up now at the Pop Cart,
   * Traffic Cart or Beach-N-Bricks Grill", "Served at Kick'n Chicken Co.").
   * A venue's summary describes its own menu and hours.
   *
   * The sentence is matched with an outlet's name after it, so "Breakfast is
   * served at 7 a.m." and "pick yours up at the window" are not.
   */
  protected isNonVenueRestaurantListing(item: RecordItem): boolean {
    return textInAllLanguages(item.Summary).some(text => SOLD_AT_AN_OUTLET.test(text));
  }
}

/**
 * LEGOLAND California Resort, Carlsbad, CA
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandCalifornia extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandcaliforniaresort',
        parkId: 'legolandcalifornia',
        timezone: 'America/Los_Angeles',
        appBuild: 800000074 as any,
        appVersion: '8.4.11',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND Billund Resort, Billund, Denmark
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandBillund extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandbillundresort',
        parkId: 'legolandbillund',
        timezone: 'Europe/Copenhagen',
        appBuild: 162 as any,
        appVersion: '3.4.17',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND Deutschland Resort, Günzburg, Germany
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandDeutschland extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolanddeutschlandresort',
        parkId: 'legolanddeutschland',
        timezone: 'Europe/Berlin',
        appBuild: 113 as any,
        appVersion: '1.4.15',
        ...options?.config,
      },
    });
  }
}

/**
 * Gardaland Resort, Castelnuovo del Garda, Italy
 */
@destinationController({category: ['Merlin', 'Gardaland']})
export class Gardaland extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'gardalandresort',
        parkId: 'gardaland',
        timezone: 'Europe/Rome',
        appBuild: 119 as any,
        appVersion: '4.2',
        ...options?.config,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HeidePark — destination (custom v2 opening-times API)
// ─────────────────────────────────────────────────────────────────────────────

type HeideParkOpeningTime = {
  date: string;
  status: string;
  openingTimes?: {
    open?: string;
    close?: string;
  };
};

type HeideParkScheduleResponse = {
  openingTimes?: HeideParkOpeningTime[];
};

@config
class HeideParkBase extends AttractionsIOV1 {
  /**
   * Heide Park types a German age rating onto the end of an event's name (see
   * stripAgeRatingTag). No other park of the family names an age this way, so
   * the rule is applied here and not to every attractions.io park.
   */
  protected async buildEntityList(): Promise<Entity[]> {
    const entities = await super.buildEntityList();
    for (const entity of entities) {
      if (typeof entity.name === 'string') entity.name = stripAgeRatingTag(entity.name);
    }
    return entities;
  }

  /**
   * Fetch the v2 resort-opening-times endpoint (specific to HeidePark).
   * Cached for 2 hours.
   */
  @http({cacheSeconds: 60 * 60 * 2})
  async fetchHeideParkSchedule(startDate: string, endDate: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `https://api.attractions.io/v2/resort-opening-times?startDate=${startDate}&endDate=${endDate}`,
      options: {json: true},
      tags: ['calendar'],
    } as any as HTTPObj;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const now = new Date();
    const threeMonthsLater = addDays(now, 90);

    // formatInTimezone 'date' returns MM/DD/YYYY — convert to YYYY-MM-DD
    const startDate = formatInTimezone(now, this.timezone, 'date')
      .replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2');
    const endDate = formatInTimezone(threeMonthsLater, this.timezone, 'date')
      .replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2');

    let schedData: HeideParkScheduleResponse;
    try {
      const resp = await this.fetchHeideParkSchedule(startDate, endDate);
      schedData = await resp.json();
    } catch {
      return [{id: this.parkId, schedule: []}];
    }

    if (!schedData?.openingTimes || !Array.isArray(schedData.openingTimes)) {
      return [{id: this.parkId, schedule: []}];
    }

    const schedule: Array<{
      date: string;
      type: 'OPERATING';
      openingTime: string;
      closingTime: string;
    }> = [];

    for (const entry of schedData.openingTimes) {
      // Only include open days; skip days without valid times
      if (entry.status !== 'open') continue;
      if (!entry.openingTimes?.open || !entry.openingTimes?.close) continue;

      schedule.push({
        date: entry.date,
        type: 'OPERATING',
        openingTime: constructDateTime(entry.date, entry.openingTimes.open, this.timezone),
        closingTime: constructDateTime(entry.date, entry.openingTimes.close, this.timezone),
      });
    }

    return [{id: this.parkId, schedule}];
  }
}

/**
 * Heide Park Resort, Soltau, Germany
 */
@destinationController({category: ['Merlin', 'Heide Park']})
export class HeidePark extends HeideParkBase {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'heideparkresort',
        parkId: 'heidepark',
        timezone: 'Europe/Berlin',
        appBuild: 302101 as any,
        appVersion: '4.2.6',
        ...options?.config,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Knoebels — no schedule API
// ─────────────────────────────────────────────────────────────────────────────

@config
class KnoebelsBase extends AttractionsIOV1 {
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    // Knoebels has no machine-readable schedule API
    return [];
  }
}

/**
 * Knoebels Amusement Resort, Elysburg, PA
 */
@destinationController({category: ['Knoebels']})
export class Knoebels extends KnoebelsBase {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'knoebels',
        parkId: 'knoebelspark',
        timezone: 'America/New_York',
        appBuild: 48 as any,
        appVersion: '1.1.2',
        ...options?.config,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DjursSommerland — HTML calendar scraping
// ─────────────────────────────────────────────────────────────────────────────

type DjursParkEvent = {
  type: number;
  start: string;
  end: string;
  description?: string;
  days?: {
    ranges: number[];
  };
};

type DjursCalendarModel = {
  parkEvents?: DjursParkEvent[];
};

/**
 * The names Djurs Sommerland gives its bookable barbecue packages, in English
 * and in Danish, as compared by normaliseName().
 */
const BARBECUE_PACKAGE_NAMES = new Set(['barbecue packages', 'grillpakker']);

@config
class DjursSommerlandBase extends AttractionsIOV1 {
  /**
   * Djurs files its bookable barbecue packages ("Barbecue packages",
   * "Grillpakker", sold on the park's webshop) among the restaurants, in
   * "Barbecue & food from home" beside "Bring your own barbecue food", the
   * grill area itself. Nothing on the two records separates them (same
   * category, same flags, no classifications, a call-to-action each), so the
   * package is matched by the name its own feed gives it, whole and in either
   * language. The park's restaurants, buffets and the grill area do not carry
   * it.
   */
  protected isPaidProductListing(item: RecordItem): boolean {
    return textInAllLanguages(item.Name).some(name => BARBECUE_PACKAGE_NAMES.has(normaliseName(name)));
  }

  /**
   * Fetch the opening-hours page HTML.
   * Cached for 2 hours.
   */
  @http({cacheSeconds: 60 * 60 * 2})
  async fetchCalendarHTML(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://djurssommerland.dk/en/plan-your-trip/opening-hours/',
      tags: ['calendar'],
    } as any as HTTPObj;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    let html: string;
    try {
      const resp = await this.fetchCalendarHTML();
      html = await resp.text();
    } catch {
      return [{id: this.parkId, schedule: []}];
    }

    // Extract data-model attribute from <body> tag
    const bodyMatch = html.match(/<body[^>]*\sdata-model=['"]([^'"]*)['"]/i);
    if (!bodyMatch) {
      return [{id: this.parkId, schedule: []}];
    }

    let calendarData: DjursCalendarModel;
    try {
      // The attribute value is HTML-entity encoded — decode basic entities
      const decoded = bodyMatch[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      calendarData = JSON.parse(decoded);
    } catch {
      return [{id: this.parkId, schedule: []}];
    }

    if (!calendarData.parkEvents || !Array.isArray(calendarData.parkEvents)) {
      return [{id: this.parkId, schedule: []}];
    }

    const schedule: EntitySchedule['schedule'] = [];

    const currentYear = new Date().getFullYear();

    // The page lists three kinds of hours, by event code: 1 "Park opening
    // hours", 2 "Water park opening hours" and 4 "Magical Halloween opening
    // hours". It lays each day out from the events that cover it, the first
    // event of a code winning: a Halloween window if there is one (and then only
    // that window), otherwise the park hours with the water park beside them,
    // otherwise closed. A Halloween day usually has no code-1 event at all (the
    // "Open today" banner reads the Halloween window on those days), so the
    // Halloween window is what says the park itself is open. The water park is
    // a part of the park and never does. Any other code is not read.
    type Row = {kind: 'regular' | 'waterPark' | 'halloween'; date: string; openTime: string; closeTime: string; description?: string};
    const rows: Row[] = [];
    const unknownCodes = new Set<string>();

    for (const event of calendarData.parkEvents) {
      const {type, start, end, days} = event;
      if (!start || !end || !days?.ranges) continue;

      const kind = type === 1 ? 'regular' : type === 2 ? 'waterPark' : type === 4 ? 'halloween' : undefined;
      if (!kind) {
        unknownCodes.add(String(JSON.stringify(type)));
        continue;
      }

      const startMatch = start.match(/^(\d{1,2}):(\d{2})/);
      const endMatch = end.match(/^(\d{1,2}):(\d{2})/);
      if (!startMatch || !endMatch) continue;

      const openHour = parseInt(startMatch[1], 10);
      const openMinute = parseInt(startMatch[2], 10);
      const closeHour = parseInt(endMatch[1], 10);
      const closeMinute = parseInt(endMatch[2], 10);

      const openTime = `${String(openHour).padStart(2, '0')}:${String(openMinute).padStart(2, '0')}`;
      const closeTime = `${String(closeHour).padStart(2, '0')}:${String(closeMinute).padStart(2, '0')}`;

      const description = kind === 'waterPark'
        ? 'Water Park'
        : kind === 'halloween'
          ? (event.description || 'Magical Halloween')
          : undefined;

      for (const dayIndex of days.ranges) {
        // dayIndex encoding: monthIndex * 31 + (dayOfMonth - 1), monthIndex 0-based
        const month = Math.floor(dayIndex / 31);
        const day = (dayIndex % 31) + 1;

        // Validate day makes sense for the month
        const testDate = new Date(currentYear, month, day);
        if (testDate.getMonth() !== month || testDate.getDate() !== day) continue;

        const date = `${currentYear}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        rows.push({kind, date, openTime, closeTime, description});
      }
    }

    if (unknownCodes.size) {
      console.warn(
        `[${this.constructor.name}] skipped calendar events with a type code the page does not use: ${[...unknownCodes].join(', ')}`,
      );
    }

    // The window the page shows for a Halloween date: the first one in the feed.
    const halloweenWindow = new Map<string, Row>();
    for (const r of rows) {
      if (r.kind === 'halloween' && !halloweenWindow.has(r.date)) halloweenWindow.set(r.date, r);
    }

    const entry = (r: Row, scheduleType: 'OPERATING' | 'INFO', description?: string) => {
      // A window running past midnight closes on the next calendar day.
      const closeDate = r.closeTime < r.openTime ? shiftDateString(r.date, 1) : r.date;
      const out: EntitySchedule['schedule'][number] = {
        date: r.date,
        type: scheduleType,
        openingTime: constructDateTime(r.date, r.openTime, this.timezone),
        closingTime: constructDateTime(closeDate, r.closeTime, this.timezone),
      };
      if (description) out.description = description;
      return out;
    };

    for (const r of rows) {
      if (r.kind === 'regular') {
        // On a Halloween date the page shows the Halloween window only.
        if (!halloweenWindow.has(r.date)) schedule.push(entry(r, 'OPERATING'));
      } else if (r.kind === 'waterPark') {
        schedule.push(entry(r, 'INFO', r.description));
      } else if (halloweenWindow.get(r.date) === r) {
        // The park's own hours on a Halloween day, with the event kept as its
        // own INFO entry beside it.
        schedule.push(entry(r, 'OPERATING'));
        schedule.push(entry(r, 'INFO', r.description));
      }
    }

    // Sort by date, then opening time, the park's own hours before an event
    // that starts at the same minute.
    schedule.sort((a, b) => {
      const dc = a.date.localeCompare(b.date);
      if (dc !== 0) return dc;
      const oc = a.openingTime.localeCompare(b.openingTime);
      if (oc !== 0) return oc;
      return Number(b.type === 'OPERATING') - Number(a.type === 'OPERATING');
    });

    return [{id: this.parkId, schedule}];
  }
}

/**
 * Djurs Sommerland, Nimtofte, Denmark
 */
@destinationController({category: ['Djurs Sommerland']})
export class DjursSommerland extends DjursSommerlandBase {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'djurs-sommerland-destination',
        parkId: 'djurs-sommerland',
        timezone: 'Europe/Copenhagen',
        appBuild: 169 as any,
        appVersion: '2.5.1',
        ...options?.config,
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Remaining standard parks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LEGOLAND Japan Resort, Nagoya, Japan
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandJapan extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandjapanresort',
        parkId: 'legolandjapan',
        timezone: 'Asia/Tokyo',
        appBuild: 186 as any,
        appVersion: '1.4.24',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND New York Resort, Goshen, NY
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandNewYork extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandnewyorkdestination',
        parkId: 'legolandnewyork',
        timezone: 'America/New_York',
        appBuild: 217 as any,
        appVersion: '1.4.4',
        ...options?.config,
      },
    });
  }
}

/**
 * LEGOLAND Korea Resort, Chuncheon, South Korea
 */
@destinationController({category: ['Merlin', 'Legoland']})
export class LegolandKorea extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'legolandkoreadestination',
        parkId: 'legolandkorea',
        timezone: 'Asia/Seoul',
        appBuild: 183 as any,
        appVersion: '1.2.3',
        ...options?.config,
      },
    });
  }
}

/**
 * Peppa Pig Theme Park Florida, Winter Haven, FL
 */
@destinationController({category: ['Merlin', 'Peppa Pig Theme Park']})
export class PeppaPigThemeParkFlorida extends AttractionsIOV1 {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'peppapigthemeparkfloridadestination',
        parkId: 'peppapigthemeparkflorida',
        timezone: 'America/New_York',
        appBuild: 63 as any,
        appVersion: '1.0.16',
        ...options?.config,
      },
    });
  }
}

export {AttractionsIOV1};
