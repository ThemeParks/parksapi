/**
 * Ocean Park Hong Kong
 *
 * The official mobile app (and its API at sop.oceanpark.com.hk) was suspended
 * along with the app itself — every endpoint now returns a permanent 502 from
 * Ocean Park's own gateway. All data is instead scraped from the public website
 * (www.oceanpark.com.hk), which server-renders attraction/dining data —
 * including live wait times — as an embedded React Server Component (RSC) JSON
 * payload. No auth, no token, same page anyone gets in a browser.
 *
 * Entity IDs changed as a result: the app's numeric IDs don't exist in the
 * website's data at all, so entities are keyed on the website's own stable
 * identifiers (CMS node UUIDs for attractions, URL slugs elsewhere).
 *
 * Coordinate data: unchanged — map.oceanpark.com.hk still exposes pixel
 * positions via reference_points.json + per-category JSON files. Each map
 * entry now carries a `url` field pointing at the canonical website page, so
 * entities are joined to coordinates by URL slug instead of the old numeric
 * extEntityCode.
 *
 * Known gaps vs. the old app-based implementation (the website simply doesn't
 * expose these): FastPass/paid-return-time flags, pregnancy/wet-ride warnings,
 * and per-attraction "Summit closes early" special hours. Shopping and food
 * kiosk locations are also left out — no entity-type precedent for them and
 * the site gives them no numeric ID or UUID, only a title.
 *
 * Scraping resilience: this is a screen-scrape of a third-party site that can
 * change structure without notice, so every extraction point is defensive —
 * malformed individual items are dropped (and logged) rather than crashing
 * the whole build, and independent upstream sources (attractions, dining,
 * shows, schedule, coordinates) each fail in isolation so one flaky endpoint
 * degrades rather than zeroes out the destination's output.
 *
 * WAF: www.oceanpark.com.hk (attractions page, dining page, and both
 * /api/main/* schedule routes) 403s every request with no/generic
 * User-Agent, serving a "System Maintenance" page instead of the real SSR
 * content — Node's http client sends no default UA. That 403 propagates
 * through getAttractionItems()/getDailyScheduleItems() as a rejected
 * promise, which buildEntityList/buildLiveData's per-source .catch()
 * quietly downgrades to "no attractions/shows this cycle" — so without a
 * browser-like UA this destination silently reports zero attractions and
 * zero shows on every single sync, not just an occasional flaky one.
 * map.oceanpark.com.hk (coordinates) isn't behind the same WAF and works
 * with no UA at all. See Nigloland for the same pattern.
 */

import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import {formatInTimezone, formatDate, constructDateTime, hostnameFromUrl} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';
import type {Entity, LiveData, EntitySchedule, ScheduleEntry} from '@themeparks/typelib';
import {AttractionTypeEnum} from '@themeparks/typelib';

// ── Constants ───────────────────────────────────────────────────────────────

const TIMEZONE = 'Asia/Hong_Kong';
const DESTINATION_ID = 'oceanparkresort';
const PARK_ID = 'oceanpark';
const DEFAULT_LAT = 22.2465;
const DEFAULT_LNG = 114.1748;

/** The website reports "no restriction" as max height 300cm / min height 0cm. */
const HEIGHT_NO_LIMIT_CM = 300;

/** Map category slugs that contain entity pixel positions */
const MAP_CATEGORIES = ['attractions', 'animals', 'dining', 'transportations', 'shows', 'shops'] as const;

/** How many days ahead to probe for published park hours. */
const SCHEDULE_DAYS = 60;

/**
 * Real RSC payloads for these pages run a few hundred KB. Anything wildly
 * larger is either a bug upstream, a WAF/CDN interstitial swapped in for the
 * real page, or a truncated response — bail out before attempting to scan it
 * rather than risk pathological scan cost on adversarial/corrupted input.
 */
const MAX_SCRAPE_HTML_LENGTH = 2_000_000;

/**
 * A normal page has a few dozen flight-payload chunks. Far more
 * self.__next_f.push() occurrences than that means the document is
 * malformed — cap the number of candidates tried so a document packed with
 * unterminated push() tokens can't force many full-document rescans.
 */
const MAX_PUSH_ATTEMPTS = 100;

// ── Website JSON shapes (embedded RSC payloads / Next.js API routes) ────────

interface OceanParkNodeUrl {
  label: string;
  url: string;
}

interface OceanParkTag {
  id?: string;
  label?: string;
}

interface OceanParkQueueTime {
  text?: string | null;
}

/** An attraction card from the /attractions listing page. */
interface OceanParkAttractionItem {
  nodeId: string;
  nodeUrl: OceanParkNodeUrl;
  attractionTypes?: OceanParkTag[];
  height?: {min?: number; max?: number};
  queueTime?: OceanParkQueueTime | null;
}

/** A restaurant card from the "Restaurants" tab's pageItems. */
interface OceanParkRestaurantItem {
  nodeUrl: OceanParkNodeUrl;
}

interface OceanParkDiningTab {
  tab: {id: string; label: string};
  pageItems?: OceanParkRestaurantItem[];
}

interface OceanParkScheduleItem {
  title: string;
  timeSlot?: string[];
}

interface OceanParkDailyScheduleResponse {
  items?: OceanParkScheduleItem[];
}

interface OceanParkParkOpeningHoursResponse {
  parkOpeningHoursValue?: string;
}

interface OceanParkReferencePoint {
  pixelX: number;
  pixelY: number;
  latitude: number;
  longitude: number;
}

interface OceanParkMapEntity {
  url?: string;
  x?: number;
  y?: number;
}

interface AffineCoeffs {
  a: number; b: number; c: number; // lat = a*x + b*y + c
  d: number; e: number; f: number; // lng = d*x + e*y + f
}

/** A group of same-slug schedule entries collapsed to one show identity. */
interface ShowGroup {
  title: string;
  items: OceanParkScheduleItem[];
}

// ── Pure Functions ──────────────────────────────────────────────────────────

/** Stringify `err` for a log line without throwing on non-Error values. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Find the balanced closing bracket matching `str[openIdx]`, honouring JSON
 * string quoting so brackets inside string literals (e.g. `[`/`]` in prose)
 * don't throw off the count.
 */
export function findMatchingBracket(str: string, openIdx: number, openChar: string, closeChar: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIdx; i < str.length; i++) {
    const c = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Locate `"marker":[...]` in `text` and parse the array. */
export function findJsonArray(text: string, marker: string): unknown[] | null {
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) return null;
  let i = markerIdx + marker.length;
  while (text[i] === ' ') i++;
  if (text[i] !== '[') return null;
  const end = findMatchingBracket(text, i, '[', ']');
  if (end === -1) return null;
  try {
    return JSON.parse(text.slice(i, end)) as unknown[];
  } catch {
    return null;
  }
}

/**
 * Extract a JSON array embedded in a Next.js React Server Component "flight"
 * payload: `self.__next_f.push([1,"...escaped string..."])`.
 *
 * The push() argument is itself valid JSON — `[1, "<escaped string>"]` — so
 * parsing it directly yields a correctly unescaped inner string (quotes,
 * unicode, etc. all handled by JSON.parse) rather than hand-rolled backslash
 * stripping. `marker` (e.g. `"items":`) then locates the target array within
 * that unescaped string.
 *
 * `validate` optionally rejects a marker match whose array doesn't look like
 * the expected shape (e.g. a same-named `"items"` array from an unrelated nav
 * widget earlier in the document) and keeps scanning for another push() chunk
 * instead of returning the wrong data.
 *
 * Bounded by MAX_SCRAPE_HTML_LENGTH / MAX_PUSH_ATTEMPTS: an unbounded scan
 * over a malformed or adversarially truncated document (every
 * findMatchingBracket failure re-scans to end-of-string) is quadratic in the
 * number of unterminated push() occurrences — these caps keep worst case
 * bounded instead of blocking the process for tens of seconds on a mangled
 * upstream response.
 */
export function extractRscArray(
  html: string,
  marker: string,
  validate?: (arr: unknown[]) => boolean,
): unknown[] | null {
  if (html.length > MAX_SCRAPE_HTML_LENGTH) return null;

  const pushToken = 'self.__next_f.push(';
  let searchFrom = 0;
  let attempts = 0;

  for (;;) {
    if (++attempts > MAX_PUSH_ATTEMPTS) return null;
    const pushIdx = html.indexOf(pushToken, searchFrom);
    if (pushIdx === -1) return null;
    const argStart = pushIdx + pushToken.length;

    if (html[argStart] !== '[') { searchFrom = argStart + 1; continue; }
    const argEnd = findMatchingBracket(html, argStart, '[', ']');
    if (argEnd === -1) { searchFrom = argStart + 1; continue; }
    searchFrom = argEnd;

    let payload: unknown;
    try {
      payload = JSON.parse(html.slice(argStart, argEnd));
    } catch {
      continue;
    }
    if (!Array.isArray(payload) || typeof payload[1] !== 'string') continue;

    const arr = findJsonArray(payload[1], marker);
    if (arr && (!validate || validate(arr))) return arr;
  }
}

/** First element looks like an object with `key` — a cheap shape check to reject a same-named array from the wrong widget. */
function firstItemHasKey(key: string): (arr: unknown[]) => boolean {
  return (arr) => arr.length === 0 || (typeof arr[0] === 'object' && arr[0] !== null && key in (arr[0] as object));
}

/**
 * An attraction item needs a stable identity (nodeId) and a name/slug source
 * (nodeUrl) to be usable — both are dereferenced unguarded downstream, so a
 * card missing either must be dropped here rather than crash the whole
 * entity list or live-data build, or collide with another item on the
 * fallback id "attraction_undefined".
 */
function isValidAttractionItem(item: OceanParkAttractionItem): boolean {
  const ok = !!item?.nodeId && !!item?.nodeUrl?.url && !!item?.nodeUrl?.label;
  if (!ok) console.warn(`[OceanPark] skipping malformed attraction item: ${JSON.stringify(item).slice(0, 200)}`);
  return ok;
}

/** Last non-empty path segment of a URL (query string/fragment stripped) — Ocean Park's canonical entity slug. */
export function slugFromUrl(url: string): string {
  const clean = url.split('?')[0].split('#')[0];
  const parts = clean.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** Deterministic slug for entities the website gives no id/URL for (shows). */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Group schedule items by slug rather than by raw title. slugify() collapses
 * differently-punctuated titles (e.g. "Whiskers & Friends" / "Whiskers,
 * Friends") onto the same id, so grouping by title alone would let two
 * distinct shows silently share one entity/live-data id and clobber each
 * other. The first title seen for a slug wins; a different title landing on
 * an already-claimed slug is dropped (logged) rather than silently merged.
 * A title that normalizes to an empty slug is dropped the same way.
 *
 * Used by both buildEntityList and buildLiveData so the two always agree on
 * exactly which id each show maps to.
 */
export function groupShowsBySlug(scheduleItems: OceanParkScheduleItem[]): Map<string, ShowGroup> {
  const bySlug = new Map<string, ShowGroup>();

  for (const item of scheduleItems) {
    const slug = slugify(item.title);
    if (!slug) {
      console.warn(`[OceanPark] skipping show with empty slug after normalisation: "${item.title}"`);
      continue;
    }

    const existing = bySlug.get(slug);
    if (!existing) {
      bySlug.set(slug, {title: item.title, items: [item]});
    } else if (existing.title === item.title) {
      existing.items.push(item);
    } else {
      console.warn(
        `[OceanPark] show "${item.title}" collides on slug "${slug}" with already-seen "${existing.title}"; dropping the later one to avoid a duplicate entity id`,
      );
    }
  }

  return bySlug;
}

/**
 * Parse "10 mins" / " 0  mins" style queue text into minutes. Requires the
 * number to actually be adjacent to "min" so incidental digits elsewhere in
 * a status string (e.g. a future "Reopens at 5pm") can't be misread as a
 * wait time.
 *
 * Returns null for missing/unparseable text — the website uses an explicit
 * `null` queueTime for attractions with no queue mechanic (walkthroughs,
 * animal exhibits), which we can't distinguish from "currently closed"
 * without a live signal, so both cases fall through to null here.
 */
export function parseQueueMinutes(text: string | null | undefined): number | null {
  if (text == null) return null;
  const m = text.match(/(\d+)\s*min/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Parse a "10:00 am - 7:00 pm" style range into 24h HH:mm strings. */
export function parseHourRange(text: string): {open: string; close: string} | null {
  const m = text.match(/(\d{1,2}):(\d{2})\s*([ap]m)\s*-\s*(\d{1,2}):(\d{2})\s*([ap]m)/i);
  if (!m) return null;

  const to24h = (hourStr: string, ampm: string): string => {
    let hour = parseInt(hourStr, 10) % 12;
    if (ampm.toLowerCase() === 'pm') hour += 12;
    return String(hour).padStart(2, '0');
  };

  return {
    open: `${to24h(m[1], m[3])}:${m[2]}`,
    close: `${to24h(m[4], m[6])}:${m[5]}`,
  };
}

/**
 * Add `days` to a YYYY-MM-DD calendar date string via pure calendar
 * arithmetic (Date.UTC normalises month/day overflow), with no dependency on
 * the host process's local timezone. Deliberately not the shared
 * addDays()+formatDate(tz) pattern used elsewhere in the codebase — that
 * pattern steps the day-of-month in the *host's* local timezone before
 * converting to the target timezone, which can misfire by a day around a
 * host-timezone DST transition. Building 60 schedule dates makes that a much
 * bigger surface here than a single-date adjustment.
 */
export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  // utc-date-ok: built from a parsed YYYY-MM-DD via Date.UTC, so this shifts a
  // supplied calendar day rather than reading one off the clock.
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Compute affine transform coefficients from a set of reference points.
 * Solves lat = a*x + b*y + c and lng = d*x + e*y + f using least-squares
 * normal equations (Cramer's rule on the 3×3 system).
 */
export function computeAffineTransform(refPoints: OceanParkReferencePoint[]): AffineCoeffs | null {
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, sumYY = 0;
  let sumLat = 0, sumXLat = 0, sumYLat = 0;
  let sumLng = 0, sumXLng = 0, sumYLng = 0;
  const n = refPoints.length;

  for (const p of refPoints) {
    const {pixelX: x, pixelY: y, latitude: lat, longitude: lng} = p;
    sumX += x; sumY += y;
    sumXX += x * x; sumXY += x * y; sumYY += y * y;
    sumLat += lat; sumXLat += x * lat; sumYLat += y * lat;
    sumLng += lng; sumXLng += x * lng; sumYLng += y * lng;
  }

  const M: [number, number, number][] = [
    [sumXX, sumXY, sumX],
    [sumXY, sumYY, sumY],
    [sumX,  sumY,  n],
  ];

  const det = (m: [number, number, number][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);

  const D = det(M);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-10) return null;

  const cramer = (rhs: number[]): [number, number, number] => {
    const M0: [number, number, number][] = [[rhs[0], M[0][1], M[0][2]], [rhs[1], M[1][1], M[1][2]], [rhs[2], M[2][1], M[2][2]]];
    const M1: [number, number, number][] = [[M[0][0], rhs[0], M[0][2]], [M[1][0], rhs[1], M[1][2]], [M[2][0], rhs[2], M[2][2]]];
    const M2: [number, number, number][] = [[M[0][0], M[0][1], rhs[0]], [M[1][0], M[1][1], rhs[1]], [M[2][0], M[2][1], rhs[2]]];
    return [det(M0) / D, det(M1) / D, det(M2) / D];
  };

  const [a, b, c] = cramer([sumXLat, sumYLat, sumLat]);
  const [d, e, f] = cramer([sumXLng, sumYLng, sumLng]);
  return {a, b, c, d, e, f};
}

// ── Implementation ──────────────────────────────────────────────────────────

@destinationController({category: 'Ocean Park'})
export class OceanParkHongKong extends Destination {
  @config baseURL: string = '';
  @config mapURL: string = '';
  @config userAgent: string = '';

  timezone = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('OCEANPARK');
  }

  getCacheKeyPrefix(): string {
    return 'oceanpark';
  }

  // ── Auth / WAF ────────────────────────────────────────────────────────────

  /**
   * www.oceanpark.com.hk 403s any request without a browser-like User-Agent
   * (see file header). map.oceanpark.com.hk is unaffected, so this is scoped
   * to baseURL's host only.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function (this: OceanParkHongKong) {
      return hostnameFromUrl(this.baseURL);
    },
  })
  async injectUserAgent(req: HTTPObj): Promise<void> {
    if (!this.userAgent) {
      throw new Error(
        'OceanParkHongKong requires OCEANPARK_USERAGENT to be set (browser-like UA — www.oceanpark.com.hk WAF-blocks default clients)',
      );
    }
    req.headers = {
      ...req.headers,
      'user-agent': this.userAgent,
    };
  }

  // ── HTTP Fetch Methods ────────────────────────────────────────────────────

  /** SSR attractions listing — embeds live queue times. Short cache since wait times refresh often. */
  @http({cacheSeconds: 60})
  async fetchAttractionsPage(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/en/a-day-at-the-park/attractions`,
      options: {json: false},
    } as any as HTTPObj;
  }

  /** SSR dining/shopping listing (Restaurants / Food Kiosks / Shopping tabs). Static-ish, long cache. */
  @http({cacheSeconds: 3600})
  async fetchDiningPage(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/en/a-day-at-the-park/dining-shopping/restaurants`,
      options: {json: false},
    } as any as HTTPObj;
  }

  /** Today's stage/animal programme times. Same-origin Next.js API route, no auth. */
  @http({cacheSeconds: 1800})
  async fetchDailySchedule(date: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/api/main/daily-schedule?date=${encodeURIComponent(date)}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Park open/close hours for a single date, as free text (e.g. "10:00 am - 7:00 pm"). */
  @http({cacheSeconds: 3600})
  async fetchParkOpeningHours(date: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}/api/main/park-opening-hours?date=${encodeURIComponent(date)}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Fetch reference points (pixel → lat/lng anchors) from the map subdomain. */
  @http({cacheSeconds: 86400})
  async fetchReferencePoints(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.mapURL}/assets/data/reference_points.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Fetch entity pixel positions for a given map category. */
  @http({cacheSeconds: 86400})
  async fetchMapCategoryData(category: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.mapURL}/assets/data/${category}.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Parsed Accessors ──────────────────────────────────────────────────────

  /**
   * @cache here (matching fetchAttractionsPage's 60s TTL) avoids redoing the
   * RSC bracket-scan + JSON.parse on every buildLiveData() poll when the
   * underlying HTML is already an HTTP-layer cache hit.
   *
   * Returns the raw parsed list, not yet validated per-item — buildEntityList
   * and buildLiveData each filter with isValidAttractionItem() at their own
   * consumption point (matching the restaurant-item pattern below) so a
   * malformed card can't crash either builder's .map()/loop.
   */
  @cache({ttlSeconds: 60})
  async getAttractionItems(): Promise<OceanParkAttractionItem[]> {
    const resp = await this.fetchAttractionsPage();
    const html = await resp.text();
    const items = extractRscArray(html, '"items":', firstItemHasKey('nodeId')) as OceanParkAttractionItem[] | null;
    if (!items) {
      console.warn('[OceanPark] attractions page RSC data not found; entity list and wait times will be empty this cycle');
      return [];
    }
    return items;
  }

  /** See getAttractionItems() — same caching/dropped-item rationale, restaurant items validated where they're flattened out of tabs in buildEntityList. */
  @cache({ttlSeconds: 3600})
  async getDiningTabs(): Promise<OceanParkDiningTab[]> {
    const resp = await this.fetchDiningPage();
    const html = await resp.text();
    const tabs = extractRscArray(html, '"items":', firstItemHasKey('tab')) as OceanParkDiningTab[] | null;
    if (!tabs) {
      console.warn('[OceanPark] dining page RSC data not found; restaurant list will be empty this cycle');
      return [];
    }
    return tabs;
  }

  async getDailyScheduleItems(date: string): Promise<OceanParkScheduleItem[]> {
    const resp = await this.fetchDailySchedule(date);
    const body: OceanParkDailyScheduleResponse = await resp.json();
    return body?.items ?? [];
  }

  async getParkOpeningHoursValue(date: string): Promise<string | null> {
    const resp = await this.fetchParkOpeningHours(date);
    const body: OceanParkParkOpeningHoursResponse = await resp.json();
    return body?.parkOpeningHoursValue ?? null;
  }

  /**
   * Build a serialisable map from URL slug → {latitude, longitude} by:
   * 1. Fetching reference points and computing an affine pixel→geo transform.
   * 2. Fetching each map category and projecting each entity's pixel position.
   *
   * Returned as an array of [key, value] pairs.
   *
   * No @cache here — degenerate input must throw so the underlying @http
   * fetchers (24h TTL each) keep retrying instead of pinning every entity
   * to its default location for a day. Callers are expected to catch and
   * fall back to no-coords on transient failure.
   */
  async getCoordinateMapEntries(): Promise<[string, {latitude: number; longitude: number}][]> {
    const refResp = await this.fetchReferencePoints();
    const refPoints: OceanParkReferencePoint[] = await refResp.json();
    if (!Array.isArray(refPoints) || refPoints.length < 3) {
      throw new Error(
        `OceanPark: reference points payload invalid (got ${Array.isArray(refPoints) ? `${refPoints.length} entries` : typeof refPoints})`,
      );
    }

    const coeffs = computeAffineTransform(refPoints);
    if (!coeffs) {
      throw new Error('OceanPark: affine transform degenerate (collinear or duplicate reference points)');
    }
    const entries: [string, {latitude: number; longitude: number}][] = [];

    const categoryResponses = await Promise.all(
      MAP_CATEGORIES.map((category) => this.fetchMapCategoryData(category)),
    );
    for (const resp of categoryResponses) {
      const entities: OceanParkMapEntity[] = await resp.json();
      if (!Array.isArray(entities)) continue;

      for (const e of entities) {
        if (e.url && e.x != null && e.y != null) {
          entries.push([
            slugFromUrl(e.url),
            {
              latitude:  coeffs.a * e.x + coeffs.b * e.y + coeffs.c,
              longitude: coeffs.d * e.x + coeffs.e * e.y + coeffs.f,
            },
          ]);
        }
      }
    }

    return entries;
  }

  // ── Destination ───────────────────────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: DESTINATION_ID,
      name: 'Ocean Park Hong Kong',
      entityType: 'DESTINATION',
      timezone: TIMEZONE,
      location: {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
    } as Entity];
  }

  // ── Entity List ───────────────────────────────────────────────────────────

  protected async buildEntityList(): Promise<Entity[]> {
    const today = formatDate(new Date(), TIMEZONE);

    // Four independent upstream sources (SSR attractions page, SSR dining
    // page, the daily-schedule API route, and the map subdomain) — each
    // isolated with its own .catch() so one flaky source degrades that
    // category to empty rather than throwing away the whole entity list.
    const [attractionItems, diningTabs, scheduleItems, coordEntries] = await Promise.all([
      this.getAttractionItems().catch((err: unknown) => {
        console.warn(`[OceanPark] attractions fetch failed (${errMsg(err)}); no attractions this cycle`);
        return [] as OceanParkAttractionItem[];
      }),
      this.getDiningTabs().catch((err: unknown) => {
        console.warn(`[OceanPark] dining fetch failed (${errMsg(err)}); no restaurants this cycle`);
        return [] as OceanParkDiningTab[];
      }),
      this.getDailyScheduleItems(today).catch((err: unknown) => {
        console.warn(`[OceanPark] daily schedule fetch failed (${errMsg(err)}); no shows this cycle`);
        return [] as OceanParkScheduleItem[];
      }),
      this.getCoordinateMapEntries().catch((err: unknown) => {
        console.warn(`[OceanPark] coordinate map unavailable (${errMsg(err)}); entities will use default location`);
        return [] as [string, {latitude: number; longitude: number}][];
      }),
    ]);

    const coordMap = new Map(coordEntries);

    const park: Entity = {
      id: PARK_ID,
      name: 'Ocean Park',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: TIMEZONE,
      location: {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
    } as Entity;

    const attractionEntities: Entity[] = attractionItems.filter(isValidAttractionItem).map(item => {
      const isTransport = (item.attractionTypes ?? []).some(t => t.id === 'in-park-transportation');
      const coords = coordMap.get(slugFromUrl(item.nodeUrl.url));

      const tags = [];
      const minHeight = item.height?.min ?? 0;
      const maxHeight = item.height?.max ?? HEIGHT_NO_LIMIT_CM;
      if (minHeight > 0) tags.push(TagBuilder.minimumHeight(minHeight, 'cm'));
      if (maxHeight < HEIGHT_NO_LIMIT_CM) tags.push(TagBuilder.maximumHeight(maxHeight, 'cm'));

      const built: Entity = {
        id: `attraction_${item.nodeId}`,
        name: item.nodeUrl.label,
        entityType: 'ATTRACTION',
        attractionType: isTransport ? AttractionTypeEnum.TRANSPORT : AttractionTypeEnum.RIDE,
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
        location: coords ?? {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
      } as Entity;

      if (tags.length > 0) built.tags = tags;
      return built;
    });

    const restaurantEntities: Entity[] = diningTabs
      .filter(tab => tab.tab?.id === 'restaurants')
      .flatMap(tab => tab.pageItems ?? [])
      .filter(item => {
        const ok = !!item?.nodeUrl?.url && !!item?.nodeUrl?.label;
        if (!ok) console.warn(`[OceanPark] skipping malformed restaurant item: ${JSON.stringify(item).slice(0, 200)}`);
        return ok;
      })
      .map(item => {
        const slug = slugFromUrl(item.nodeUrl.url);
        const coords = coordMap.get(slug);
        return {
          id: `restaurant_${slug}`,
          name: item.nodeUrl.label,
          entityType: 'RESTAURANT',
          parentId: PARK_ID,
          destinationId: DESTINATION_ID,
          timezone: TIMEZONE,
          location: coords ?? {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
        } as Entity;
      });

    // Shows have no id/URL from the website at all — only a title, via the
    // daily-schedule endpoint. groupShowsBySlug() resolves slug collisions
    // once, consistently with buildLiveData, and best-effort matches each
    // slug against the map's show slugs for coordinates.
    const showGroups = groupShowsBySlug(scheduleItems);
    const showEntities: Entity[] = [...showGroups.entries()].map(([slug, group]) => {
      const coords = coordMap.get(slug);
      return {
        id: `show_${slug}`,
        name: group.title,
        entityType: 'SHOW',
        parentId: PARK_ID,
        destinationId: DESTINATION_ID,
        timezone: TIMEZONE,
        location: coords ?? {latitude: DEFAULT_LAT, longitude: DEFAULT_LNG},
      } as Entity;
    });

    return [park, ...attractionEntities, ...restaurantEntities, ...showEntities];
  }

  // ── Live Data ─────────────────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const today = formatDate(new Date(), TIMEZONE);

    // Two independent sources (SSR attractions page vs. the daily-schedule
    // API route) — isolated so one going down doesn't wipe out live data
    // that came from the other, healthy one.
    const [attractionItems, scheduleItems] = await Promise.all([
      this.getAttractionItems().catch((err: unknown) => {
        console.warn(`[OceanPark] attractions fetch failed (${errMsg(err)}); no attraction wait times this cycle`);
        return [] as OceanParkAttractionItem[];
      }),
      this.getDailyScheduleItems(today).catch((err: unknown) => {
        console.warn(`[OceanPark] daily schedule fetch failed (${errMsg(err)}); no show live data this cycle`);
        return [] as OceanParkScheduleItem[];
      }),
    ]);

    const liveData: LiveData[] = [];

    for (const item of attractionItems.filter(isValidAttractionItem)) {
      const wt = parseQueueMinutes(item.queueTime?.text);

      const ld: LiveData = {
        id: `attraction_${item.nodeId}`,
        // The website gives no explicit open/closed flag — queueTime is the
        // only live signal. No signal (null) means either "no queue
        // mechanic" or "currently closed" and we can't tell which, so it
        // falls through to CLOSED rather than fabricating an OPERATING
        // status with no evidence behind it.
        status: wt !== null ? 'OPERATING' : 'CLOSED',
      } as LiveData;

      if (wt !== null) ld.queue = {STANDBY: {waitTime: wt}};
      liveData.push(ld);
    }

    // Shows — group today's programme entries by slug (same grouping
    // buildEntityList uses, so ids always agree) and emit remaining
    // showtimes. No explicit end time is published, only a start.
    const showGroups = groupShowsBySlug(scheduleItems);
    const now = Date.now();
    for (const [slug, group] of showGroups) {
      const showtimes = group.items
        .flatMap(entry => entry.timeSlot ?? [])
        .map(t => formatInTimezone(new Date(constructDateTime(today, t, TIMEZONE)), TIMEZONE, 'iso'))
        .filter(iso => new Date(iso).getTime() >= now)
        .map(iso => ({type: 'Performance Time', startTime: iso}));

      const ld: LiveData = {
        id: `show_${slug}`,
        status: showtimes.length > 0 ? 'OPERATING' : 'CLOSED',
      } as LiveData;
      if (showtimes.length > 0) ld.showtimes = showtimes;

      liveData.push(ld);
    }

    return liveData;
  }

  // ── Schedules ─────────────────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const today = formatDate(new Date(), TIMEZONE);
    const dates = Array.from({length: SCHEDULE_DAYS}, (_, i) => addDaysToDateString(today, i));

    // Promise.allSettled, not Promise.all — 60 independent per-date
    // requests means one transient failure (a single 5xx, a malformed
    // response) must degrade to "one fewer day" rather than reject the
    // entire schedule down to zero days.
    const results = await Promise.allSettled(dates.map(d => this.getParkOpeningHoursValue(d)));

    const scheduleEntries: ScheduleEntry[] = [];
    let failedCount = 0;

    for (let i = 0; i < dates.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        failedCount++;
        continue;
      }

      const hoursText = result.value;
      const range = parseHourRange(hoursText ?? '');
      if (!range) {
        // Empty text means "closed / beyond the published window" — expected
        // and not logged. Non-empty-but-unparseable means the site's hours
        // format changed underneath us; that's worth a log line so it's not
        // silently indistinguishable from a real closure.
        if (hoursText) {
          console.warn(`[OceanPark] unrecognised opening-hours text for ${dates[i]}: "${hoursText}"`);
        }
        continue;
      }

      // A close time numerically "before" the open time on a 24h clock (e.g.
      // "6:00 pm - 12:30 am") means the park closes after midnight the
      // following calendar day, not before it opened the same day.
      const closeDate = range.close <= range.open ? addDaysToDateString(dates[i], 1) : dates[i];

      scheduleEntries.push({
        date: dates[i],
        type: 'OPERATING',
        openingTime: constructDateTime(dates[i], range.open, TIMEZONE),
        closingTime: constructDateTime(closeDate, range.close, TIMEZONE),
      });
    }

    if (failedCount > 0) {
      console.warn(`[OceanPark] ${failedCount}/${dates.length} schedule date requests failed; schedule may have gaps`);
    }

    return [{
      id: PARK_ID,
      schedule: scheduleEntries,
    }];
  }
}
