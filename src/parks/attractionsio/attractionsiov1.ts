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
import {makeHttpRequest} from '../../httpProxy.js';
import {constructDateTime, addDays, formatInTimezone, formatDate} from '../../datetime.js';
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
 * Parse a raw "openingHours" string such as "9:30am - 7pm" or "10:00 - 17:00"
 * into a pair of HH:mm strings.  Returns null when the format is unrecognised.
 */
function parseOpeningHours(raw: string): TimeParseResult {
  // Format 1: 9:30am - 7pm
  const fmt1 = /^(\d{1,2}):(\d{2})([ap]m)\s*-\s*(\d{1,2})([ap]m)$/i.exec(raw.trim());
  if (fmt1) {
    let openH = parseInt(fmt1[1], 10);
    const openM = parseInt(fmt1[2], 10);
    let closeH = parseInt(fmt1[4], 10);
    const amPmOpen = fmt1[3].toLowerCase();
    const amPmClose = fmt1[5].toLowerCase();
    if (amPmOpen === 'pm' && openH !== 12) openH += 12;
    if (amPmClose === 'pm' && closeH !== 12) closeH += 12;
    if (amPmOpen === 'am' && openH === 12) openH = 0;
    if (amPmClose === 'am' && closeH === 12) closeH = 0;
    return {
      openTime: `${String(openH).padStart(2, '0')}:${String(openM).padStart(2, '0')}`,
      closeTime: `${String(closeH).padStart(2, '0')}:00`,
    };
  }

  // Format 2: 10am - 5pm
  const fmt2 = /^(\d{1,2})([ap]m)\s*-\s*(\d{1,2})([ap]m)$/i.exec(raw.trim());
  if (fmt2) {
    let openH = parseInt(fmt2[1], 10);
    let closeH = parseInt(fmt2[3], 10);
    const amPmOpen = fmt2[2].toLowerCase();
    const amPmClose = fmt2[4].toLowerCase();
    if (amPmOpen === 'pm' && openH !== 12) openH += 12;
    if (amPmClose === 'pm' && closeH !== 12) closeH += 12;
    if (amPmOpen === 'am' && openH === 12) openH = 0;
    if (amPmClose === 'am' && closeH === 12) closeH = 0;
    return {
      openTime: `${String(openH).padStart(2, '0')}:00`,
      closeTime: `${String(closeH).padStart(2, '0')}:00`,
    };
  }

  // Format 3: 10:00 - 17:00
  const fmt3 = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (fmt3) {
    const openH = parseInt(fmt3[1], 10);
    const openM = parseInt(fmt3[2], 10);
    const closeH = parseInt(fmt3[3], 10);
    const closeM = parseInt(fmt3[4], 10);
    return {
      openTime: `${String(openH).padStart(2, '0')}:${String(openM).padStart(2, '0')}`,
      closeTime: `${String(closeH).padStart(2, '0')}:${String(closeM).padStart(2, '0')}`,
    };
  }

  return null;
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
   * Download and extract the asset ZIP file from the given URL.
   */
  private async downloadAssetPack(url: string): Promise<{
    manifestData: {version: string};
    recordsData: RecordsData;
  }> {
    const response = await makeHttpRequest({
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

    const response = await makeHttpRequest({
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

    const data = await this.getPOIData();
    return data.Item.filter(item => item.Category !== undefined && allCatIds.includes(item.Category));
  }

  /**
   * Category names treated as SHOW entities. Overridable by subclasses whose
   * park files its shows under a different category name.
   */
  protected getShowCategories(): string[] {
    return SHOW_CATEGORIES;
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
    const data = await this.getPOIData();

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

    // Restaurants
    const restaurantItems = await this.getItemsForCategories(RESTAURANT_CATEGORIES);
    const restaurantEntities = restaurantItems.map(item =>
      buildItemEntity(item, this.parkId, this.destinationId, this.timezone, 'RESTAURANT')
    );

    return [
      ...await this.getDestinations(),
      parkEntity,
      ...attractionEntities,
      ...showEntities,
      ...restaurantEntities,
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
    const attractionIds = new Set(
      entities.filter(e => e.entityType === 'ATTRACTION').map(e => e.id),
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
      const poi = await this.getPOIData();
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

    for (const day of days) {
      const dateStr = parseYYYYMMDD(day.key); // "20260330" → "2026-03-30"
      if (!dateStr) continue;

      const times = parseOpeningHours(day.openingHours);
      if (!times) continue;

      schedule.push({
        date: dateStr,
        type: 'OPERATING',
        openingTime: constructDateTime(dateStr, times.openTime, this.timezone),
        closingTime: constructDateTime(dateStr, times.closeTime, this.timezone),
      });
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
    name: extractName(item.Name),
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

@config
class DjursSommerlandBase extends AttractionsIOV1 {
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

    const schedule: Array<{
      date: string;
      type: string;
      openingTime: string;
      closingTime: string;
      description?: string;
    }> = [];

    const currentYear = new Date().getFullYear();

    for (const event of calendarData.parkEvents) {
      const {type, start, end, days} = event;
      if (!start || !end || !days?.ranges) continue;

      const startMatch = start.match(/^(\d{1,2}):(\d{2})/);
      const endMatch = end.match(/^(\d{1,2}):(\d{2})/);
      if (!startMatch || !endMatch) continue;

      const openHour = parseInt(startMatch[1], 10);
      const openMinute = parseInt(startMatch[2], 10);
      const closeHour = parseInt(endMatch[1], 10);
      const closeMinute = parseInt(endMatch[2], 10);

      const openTime = `${String(openHour).padStart(2, '0')}:${String(openMinute).padStart(2, '0')}`;
      const closeTime = `${String(closeHour).padStart(2, '0')}:${String(closeMinute).padStart(2, '0')}`;

      // type 1 = Regular, type 2 = Water park, type 4 = Magical Halloween
      const isWaterPark = type === 2;
      const isSpecialEvent = type === 4;
      const scheduleType = (isWaterPark || isSpecialEvent) ? 'INFO' : 'OPERATING';
      const description = isWaterPark
        ? 'Water Park'
        : isSpecialEvent
          ? (event.description || 'Magical Halloween')
          : undefined;

      for (const dayIndex of days.ranges) {
        // dayIndex encoding: monthIndex * 31 + (dayOfMonth - 1), monthIndex 0-based
        const month = Math.floor(dayIndex / 31);
        const day = (dayIndex % 31) + 1;

        // Validate day makes sense for the month
        const testDate = new Date(currentYear, month, day);
        if (testDate.getMonth() !== month || testDate.getDate() !== day) continue;

        const dateStr = `${currentYear}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

        const entry: {
          date: string;
          type: string;
          openingTime: string;
          closingTime: string;
          description?: string;
        } = {
          date: dateStr,
          type: scheduleType,
          openingTime: constructDateTime(dateStr, openTime, this.timezone),
          closingTime: constructDateTime(dateStr, closeTime, this.timezone),
        };

        if (description) entry.description = description;

        schedule.push(entry);
      }
    }

    // Sort by date then opening time
    schedule.sort((a, b) => {
      const dc = a.date.localeCompare(b.date);
      return dc !== 0 ? dc : a.openingTime.localeCompare(b.openingTime);
    });

    return [{id: this.parkId, schedule: schedule as any}];
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
