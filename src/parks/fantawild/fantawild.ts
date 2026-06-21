/**
 * Fantawild (方特 / Fang Te) — single registered destination class that
 * emits one DESTINATION/PARK pair per real-world Fantawild park, plus
 * the chain's attractions and shows.
 *
 * The Fantawild chain operates ~50 parks across China under several brand
 * lines (Dreamland 梦幻王国, Oriental Heritage 东方神画, Adventure 欢乐世界,
 * Boonie Bears 熊出没, Water Park 水上乐园, etc.). All parks share a common
 * mobile app (`方特旅游`, package `com.hytch.ftthemepark`).
 *
 * Two backends, both anonymous-callable in practice (the app sends bearer +
 * HMAC headers, but neither is enforced server-side):
 *
 *   - Static CDN: `image.fangte.com`
 *       /UploadFiles/Launch/BusinessTime/{businessTimeVersion}/{parkId}.json
 *         Per-park daily opening hours, keyed by the small parkId.
 *
 *   - JSON API: `leyou.fangte.com`
 *       /project/api/ParkItem/GetItemBusinessList?parkId=…&selectedDate=…
 *         Full ride + show list with live `waitTime`, `itemOpened` flag,
 *         `statusStr` (e.g. `项目维护` = under maintenance), per-ride
 *         lat/lng, and `showTimeList` of operating-hours range or discrete
 *         show times.
 *
 * Pattern follows SixFlags: one `@destinationController` class that loops
 * the FANTAWILD_PARKS array inside getDestinations/buildEntityList/etc.
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import {http, type HTTPObj} from '../../http.js';
import {cache, CacheLib} from '../../cache.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {reusable} from '../../promiseReuse.js';
import type {Entity, LiveData, EntitySchedule, ScheduleEntry} from '@themeparks/typelib';
import {constructDateTime, formatInTimezone, formatDate} from '../../datetime.js';

// ── Curated park list ───────────────────────────────────────────────────────

/**
 * One Fantawild theme park.
 *
 * `hasLiveWaitTimes` is a per-park flag: when `true`, `buildLiveData`
 * surfaces the API's `waitTime` field as a STANDBY queue; when `false`,
 * we still emit OPERATING/CLOSED/REFURBISHMENT status but skip waitTime
 * entirely. This avoids fabricating `waitTime: 0` for parks that don't
 * actually broadcast live queue data — every ride at such a park would
 * otherwise report a permanent zero-minute queue.
 *
 * `hasLiveWaitTimes` was set from a single weekday-afternoon probe of
 * the live API (2026-06-21 ~15:00 China time). Parks that returned at
 * least one ride with `waitTime > 0` in that probe are marked true.
 * Flip new entries to true as evidence appears.
 */
export interface FantawildParkConfig {
  /** Numeric Fantawild parkId (from CityPark) — keyed in BusinessTime + API URLs. */
  parkId: number;
  /** English display name for the destination. Used for DESTINATION + PARK entities. */
  name: string;
  /** IANA timezone (almost always `Asia/Shanghai` for mainland China). */
  timezone: string;
  /** Park-level geographic centroid (lat/lng). */
  location: {latitude: number; longitude: number};
  /** Whether the live API broadcasts real waitTime values for this park. */
  hasLiveWaitTimes: boolean;
}

/**
 * Every Fantawild park we ship to TP.wiki. Curated from CityPark master list
 * (50 parks across 30 cities, 49 of which return ride data). Excluded:
 * `Boonie Cubs 熊熊乐园` Shenzhen (parkId 133) — returns no items, app
 * placeholder for an unfinished sub-park. Names are English where Fantawild
 * provides one; otherwise translated from the Chinese brand line + city.
 *
 * Adding a park: append one entry. No new class file needed.
 *
 * `EXCLUDED_PARK_IDS` are CityPark entries we deliberately drop (currently
 * only parkId 133 — `Boonie Cubs 熊熊乐园` Shenzhen, an app placeholder
 * with 0 items and a (0,0) location).
 */
export const EXCLUDED_PARK_IDS: ReadonlySet<number> = new Set([133]);

export const FANTAWILD_PARKS: readonly FantawildParkConfig[] = [
  {parkId: 17,  name: "Fantawild Adventure Tai'an",                timezone: 'Asia/Shanghai', location: {latitude: 36.2387, longitude: 117.1933}, hasLiveWaitTimes: false},
  {parkId: 19,  name: 'Fantawild Dreamland Wuhu',                  timezone: 'Asia/Shanghai', location: {latitude: 31.3599, longitude: 118.4582}, hasLiveWaitTimes: false},
  {parkId: 21,  name: 'Fantawild Dreamland Qingdao',               timezone: 'Asia/Shanghai', location: {latitude: 36.2103, longitude: 120.2820}, hasLiveWaitTimes: true},
  {parkId: 23,  name: 'Fantawild Adventure Zhuzhou',               timezone: 'Asia/Shanghai', location: {latitude: 27.9900, longitude: 113.1932}, hasLiveWaitTimes: false},
  {parkId: 25,  name: 'Fantawild Adventure Shenyang',              timezone: 'Asia/Shanghai', location: {latitude: 41.9648, longitude: 123.4195}, hasLiveWaitTimes: true},
  {parkId: 27,  name: 'Fantawild Adventure Zhengzhou',             timezone: 'Asia/Shanghai', location: {latitude: 34.7666, longitude: 113.9324}, hasLiveWaitTimes: false},
  {parkId: 31,  name: 'Fantawild Dreamland Xiamen',                timezone: 'Asia/Shanghai', location: {latitude: 24.6799, longitude: 118.1737}, hasLiveWaitTimes: false},
  {parkId: 33,  name: 'Fantawild Water Park Wuhu',                 timezone: 'Asia/Shanghai', location: {latitude: 31.3594, longitude: 118.4618}, hasLiveWaitTimes: false},
  {parkId: 37,  name: 'Fantawild Water Park Zhengzhou',            timezone: 'Asia/Shanghai', location: {latitude: 34.7663, longitude: 113.9364}, hasLiveWaitTimes: false},
  {parkId: 39,  name: 'Fantawild Adventure Tianjin',               timezone: 'Asia/Shanghai', location: {latitude: 39.1555, longitude: 117.7395}, hasLiveWaitTimes: false},
  {parkId: 43,  name: 'Fantawild Oriental Heritage Jinan',         timezone: 'Asia/Shanghai', location: {latitude: 36.7065, longitude: 116.8781}, hasLiveWaitTimes: false},
  {parkId: 45,  name: 'Fantawild Adventure Jiayuguan',             timezone: 'Asia/Shanghai', location: {latitude: 39.7560, longitude:  98.3450}, hasLiveWaitTimes: false},
  {parkId: 47,  name: 'Fantawild Adventure Datong',                timezone: 'Asia/Shanghai', location: {latitude: 40.0599, longitude: 113.3676}, hasLiveWaitTimes: true},
  {parkId: 49,  name: 'Fantawild Oriental Heritage Wuhu',          timezone: 'Asia/Shanghai', location: {latitude: 31.3591, longitude: 118.4687}, hasLiveWaitTimes: false},
  {parkId: 51,  name: 'Fantawild Dreamland Zhengzhou',             timezone: 'Asia/Shanghai', location: {latitude: 34.7661, longitude: 113.9261}, hasLiveWaitTimes: false},
  {parkId: 53,  name: 'Fantawild Oriental Heritage Ningbo',        timezone: 'Asia/Shanghai', location: {latitude: 30.3199, longitude: 121.1824}, hasLiveWaitTimes: false},
  {parkId: 55,  name: 'Fantawild Silk Road Heritage Jiayuguan',    timezone: 'Asia/Shanghai', location: {latitude: 39.8030, longitude:  98.2454}, hasLiveWaitTimes: false},
  {parkId: 57,  name: 'Fantawild Dreamland Zhuzhou',               timezone: 'Asia/Shanghai', location: {latitude: 27.9844, longitude: 113.1917}, hasLiveWaitTimes: false},
  {parkId: 61,  name: 'Fantawild Oriental Heritage Changsha',      timezone: 'Asia/Shanghai', location: {latitude: 28.2021, longitude: 112.5932}, hasLiveWaitTimes: true},
  {parkId: 63,  name: 'Fantawild Oriental Heritage Jingzhou',      timezone: 'Asia/Shanghai', location: {latitude: 30.3901, longitude: 112.2400}, hasLiveWaitTimes: false},
  {parkId: 67,  name: 'Fantawild Glory of Kungfu Handan',          timezone: 'Asia/Shanghai', location: {latitude: 36.2856, longitude: 114.3927}, hasLiveWaitTimes: false},
  {parkId: 69,  name: 'Fantawild Oriental Heritage Mianyang',      timezone: 'Asia/Shanghai', location: {latitude: 31.7305, longitude: 104.7071}, hasLiveWaitTimes: false},
  {parkId: 71,  name: 'Fantawild Oriental Heritage Xiamen',        timezone: 'Asia/Shanghai', location: {latitude: 24.6801, longitude: 118.1722}, hasLiveWaitTimes: false},
  {parkId: 73,  name: 'Fantawild Oriental Heritage Taiyuan',       timezone: 'Asia/Shanghai', location: {latitude: 38.0467, longitude: 112.6505}, hasLiveWaitTimes: true},
  {parkId: 75,  name: 'Fantawild Water Park Xiamen',               timezone: 'Asia/Shanghai', location: {latitude: 24.6796, longitude: 118.1743}, hasLiveWaitTimes: false},
  {parkId: 77,  name: "Fantawild Glorious Orient Ganzhou",         timezone: 'Asia/Shanghai', location: {latitude: 25.9066, longitude: 114.9340}, hasLiveWaitTimes: true},
  {parkId: 79,  name: 'Fantawild ASEAN Heritage Nanning',          timezone: 'Asia/Shanghai', location: {latitude: 22.7638, longitude: 108.4160}, hasLiveWaitTimes: true},
  {parkId: 81,  name: 'Fantawild Dinosaur Kingdom Zigong',         timezone: 'Asia/Shanghai', location: {latitude: 29.4030, longitude: 104.8257}, hasLiveWaitTimes: false},
  {parkId: 83,  name: 'Fantawild FT Wild Land Taizhou',            timezone: 'Asia/Shanghai', location: {latitude: 28.5516, longitude: 121.5746}, hasLiveWaitTimes: false},
  {parkId: 85,  name: "Fantawild Glorious Orient Huai'an",         timezone: 'Asia/Shanghai', location: {latitude: 33.2680, longitude: 118.8390}, hasLiveWaitTimes: false},
  {parkId: 87,  name: 'Fantawild Glorious Orient Jining',          timezone: 'Asia/Shanghai', location: {latitude: 35.3352, longitude: 116.6941}, hasLiveWaitTimes: false},
  {parkId: 89,  name: 'Fantawild Glorious Orient Ningbo',          timezone: 'Asia/Shanghai', location: {latitude: 30.3258, longitude: 121.1794}, hasLiveWaitTimes: false},
  {parkId: 93,  name: 'Fantawild Water Park Tianjin',              timezone: 'Asia/Shanghai', location: {latitude: 39.1570, longitude: 117.7404}, hasLiveWaitTimes: false},
  {parkId: 95,  name: "Boonie Bears Park Huai'an",                 timezone: 'Asia/Shanghai', location: {latitude: 33.2763, longitude: 118.8404}, hasLiveWaitTimes: true},
  {parkId: 97,  name: 'Fantawild Oriental Heritage Yingtan',       timezone: 'Asia/Shanghai', location: {latitude: 28.2888, longitude: 117.0340}, hasLiveWaitTimes: false},
  {parkId: 101, name: 'Boonie Bears Adventure Park Linhai',        timezone: 'Asia/Shanghai', location: {latitude: 28.8602, longitude: 121.1950}, hasLiveWaitTimes: false},
  {parkId: 105, name: 'Fantawild Park Xuzhou',                     timezone: 'Asia/Shanghai', location: {latitude: 34.1480, longitude: 117.3605}, hasLiveWaitTimes: false},
  {parkId: 109, name: 'Boonie Bears Happy Harbor Ningbo',          timezone: 'Asia/Shanghai', location: {latitude: 30.3211, longitude: 121.1717}, hasLiveWaitTimes: false},
  {parkId: 113, name: 'Fantawild Water Park Taizhou',              timezone: 'Asia/Shanghai', location: {latitude: 28.5447, longitude: 121.5809}, hasLiveWaitTimes: false},
  {parkId: 115, name: 'Fantawild Water Park Xuzhou',               timezone: 'Asia/Shanghai', location: {latitude: 34.1488, longitude: 117.3568}, hasLiveWaitTimes: false},
  {parkId: 117, name: 'Fantawild Water Park Yingtan',              timezone: 'Asia/Shanghai', location: {latitude: 28.2872, longitude: 117.0302}, hasLiveWaitTimes: false},
  {parkId: 119, name: 'Boonie Bears Park Yichun',                  timezone: 'Asia/Shanghai', location: {latitude: 27.8186, longitude: 114.3378}, hasLiveWaitTimes: true},
  {parkId: 121, name: 'Fantawild Water Park Yichun',               timezone: 'Asia/Shanghai', location: {latitude: 27.8248, longitude: 114.3387}, hasLiveWaitTimes: false},
  {parkId: 127, name: 'Fantawild Glory of Kungfu Ziyang',          timezone: 'Asia/Shanghai', location: {latitude: 30.1904, longitude: 104.5763}, hasLiveWaitTimes: false},
  {parkId: 129, name: 'Fantawild FT Wild Land Xiaogan',            timezone: 'Asia/Shanghai', location: {latitude: 30.8198, longitude: 114.1074}, hasLiveWaitTimes: true},
  {parkId: 131, name: 'Boonie Bears Water Park Linhai',            timezone: 'Asia/Shanghai', location: {latitude: 28.8601, longitude: 121.1962}, hasLiveWaitTimes: false},
  {parkId: 135, name: 'Fantawild Water Park Ganzhou',              timezone: 'Asia/Shanghai', location: {latitude: 25.9100, longitude: 114.9334}, hasLiveWaitTimes: false},
  {parkId: 137, name: 'Fantawild Water World Ziyang',              timezone: 'Asia/Shanghai', location: {latitude: 30.1886, longitude: 104.5732}, hasLiveWaitTimes: false},
  {parkId: 139, name: 'Fantawild Water Park Xiaogan',              timezone: 'Asia/Shanghai', location: {latitude: 30.8182, longitude: 114.1067}, hasLiveWaitTimes: false},
] as const;

// ── API types ───────────────────────────────────────────────────────────────

export interface FantawildBusinessTimeEntry {
  /** "YYYY-MM-DD HH:MM:SS" wall-clock in the park timezone */
  currentDate: string;
  /** "HH:MM" — empty string when closed */
  startTime: string;
  /** "HH:MM" — empty string when closed */
  endTime: string;
  isNight: boolean;
  /**
   * Field name suggests "is the next day," but its exact semantics have not
   * been confirmed against a real cross-midnight fixture — every observed
   * entry has `isMorrow: false`. We detect midnight-crossing closing times
   * directly from the wall-clock values (close < open → roll) rather than
   * trusting this flag, which is strictly safer either way.
   */
  isMorrow: boolean;
  nightStartTime: string;
  nightEndTime: string;
  activated: boolean;
  statusTips: string;
  parkCloseDesc: string | null;
  closeRemarkUrl: string | null;
  remarkUrl: string | null;
  /** Last entry time, "HH:MM" or empty */
  stopIntoPark: string;
}

export interface FantawildBusinessTimeResponse {
  key: string;
  value: FantawildBusinessTimeEntry[];
  version?: string;
}

/** One ride/show entry from the `GetItemBusinessList` endpoint. */
export interface FantawildItem {
  parkId: number;
  /** Numeric id stable across days; used to derive entity IDs. */
  id: number;
  /** Display name. May contain trailing star-rating glyphs (⭐) that we strip. */
  itemName: string;
  /** Live wait time in minutes. 0 when the park is closed or there's no queue. */
  waitTime: number;
  /** Open/closed flag set by the app's data ops team. */
  itemOpened: boolean;
  /** Free-form status string (e.g. `项目维护，暂停开放` = "under maintenance"). */
  statusStr: string | null;
  longitude?: number;
  latitude?: number;
  /**
   * Mixed-purpose. For attractions, typically a single "HH:MM-HH:MM" range of
   * operating hours. For shows, a list of discrete "HH:MM" start times. We use
   * this both to classify entity type and to surface SHOWTIMES.
   */
  showTimeList?: string[];
  nextShowTimeList?: string[];
  heightStr?: string;
  featureList?: string[];
  mainPic?: string;
  recommendType?: number;
  distanceStr?: string;
}

export interface FantawildItemListResponse {
  data?: FantawildItem[];
}

// ── Parsers ─────────────────────────────────────────────────────────────────

/**
 * Trailing star-rating glyphs Fantawild bakes into itemName (e.g. `孟姜女⭐⭐⭐⭐`).
 * Matches U+2B50 ⭐ with an optional U+FE0F variation selector after each.
 */
const STAR_RE = /(?:⭐️?)+\s*$/u;

/** Strip trailing star-rating glyphs from a Fantawild item name. */
export function stripFantawildStars(name: string): string {
  return name.replace(STAR_RE, '').trim();
}

/** Classify an item as SHOW vs RIDE based on showTimeList shape + feature tags. */
export function isFantawildShow(item: FantawildItem): boolean {
  const features = item.featureList ?? [];
  // Explicit live-performance / parade feature flags.
  if (features.includes('真人表演') || features.includes('巡游')) return true;
  const times = item.showTimeList ?? [];
  if (times.length === 0) return false;
  // If every entry is a single time (no dash range) it's a discrete-showtime SHOW.
  // A single "HH:MM-HH:MM" range is the operating-hours pattern used for attractions.
  return times.every(t => /^\d{1,2}:\d{2}$/.test(t.trim()));
}

/**
 * Parse "HH:MM" to minutes-from-midnight. Returns NaN if malformed.
 *
 * Strict hour range 0-23 — `24:30` would slip past a `>24` check, then
 * `constructDateTime` would emit NaN-of-Date and produce garbage. Use
 * `00:00` next-day instead if you need the end-of-day boundary.
 */
function hhmmToMinutes(t: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return NaN;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

/** Time string is parseable as "HH:MM". Avoids feeding garbage to constructDateTime. */
function isValidHHMM(t: string): boolean {
  return Number.isFinite(hhmmToMinutes(t));
}

/**
 * If a window's closing time is at or before its opening time, the window
 * crosses midnight — return tomorrow's date for use as the close date. Else
 * return the same date. Times are wall-clock "HH:MM" in the park's timezone.
 *
 * Mirrors the post-midnight fix Europa-Park needed for Sommernächte (PR #224).
 * We don't trust the upstream `isMorrow` flag — its semantics aren't pinned
 * down by a real fixture — but wall-clock ordering is unambiguous.
 */
function closeDateAcrossMidnight(date: string, openTime: string, closeTime: string): string {
  const opens = hhmmToMinutes(openTime);
  const closes = hhmmToMinutes(closeTime);
  if (!Number.isFinite(opens) || !Number.isFinite(closes)) return date;
  // `closes > opens` would leave the equality case (e.g. 09:00-09:00) folded
  // into a zero-length same-day window; downstream consumers prefer the
  // 24-hour-window interpretation, so equal times also roll to next day.
  if (closes > opens) return date;
  // YYYY-MM-DD → next day. Date.UTC handles month/year rollover correctly.
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, (m - 1), d + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Convert a Fantawild BusinessTime response to ScheduleEntry[].
 *
 * Pure module-level function so it can be unit-tested without the destination
 * harness. Skips entries that aren't `activated`, that have no `startTime`,
 * or whose date can't be parsed. Adds an EXTRA_HOURS entry when `isNight`
 * is true and night times are populated — the park's day session has its
 * own startTime/endTime, and the night session (e.g. fireworks/dark-ride
 * event) is layered on top. Closing times at or before opening (e.g.
 * 18:00–00:30 or 22:00–01:00) roll the close date to the next day.
 */
export function parseBusinessTime(
  json: FantawildBusinessTimeResponse | null | undefined,
  timezone: string,
): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  for (const ev of json?.value ?? []) {
    if (!ev.activated) continue;
    // Date arrives as "YYYY-MM-DD HH:MM:SS" — take the YYYY-MM-DD prefix.
    const date = ev.currentDate?.split(' ')[0];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    // Validate time strings BEFORE handing them to constructDateTime — a single
    // malformed entry would otherwise throw and abort the whole sweep.
    if (ev.startTime && ev.endTime && isValidHHMM(ev.startTime) && isValidHHMM(ev.endTime)) {
      const closeDate = closeDateAcrossMidnight(date, ev.startTime, ev.endTime);
      out.push({
        date,
        type: 'OPERATING' as const,
        openingTime: constructDateTime(date, ev.startTime, timezone),
        closingTime: constructDateTime(closeDate, ev.endTime, timezone),
      });
    }
    if (ev.isNight && ev.nightStartTime && ev.nightEndTime
        && isValidHHMM(ev.nightStartTime) && isValidHHMM(ev.nightEndTime)) {
      const nightCloseDate = closeDateAcrossMidnight(date, ev.nightStartTime, ev.nightEndTime);
      out.push({
        date,
        type: 'EXTRA_HOURS' as const,
        openingTime: constructDateTime(date, ev.nightStartTime, timezone),
        closingTime: constructDateTime(nightCloseDate, ev.nightEndTime, timezone),
      });
    }
  }
  return out;
}

// ── Destination class ───────────────────────────────────────────────────────

@destinationController({category: 'Fantawild'})
export class Fantawild extends Destination {
  /** Static-asset CDN root, e.g. `https://image.fangte.com` (no trailing slash). */
  @config baseUrl: string = '';
  /** Authenticated API root, e.g. `https://leyou.fangte.com` (no trailing slash). */
  @config apiBaseUrl: string = '';

  /**
   * Route-prefix constant for the BusinessTime CDN path. Baked into the
   * app and only changes when Fantawild ships a new versioned route map.
   */
  protected businessTimeVersion: string = '50418';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('FANTAWILD');
  }

  /** All caches keyed methods take parkId as an argument, so the prefix is constant. */
  getCacheKeyPrefix(): string {
    return 'fantawild';
  }

  protected async _init(): Promise<void> {
    if (!this.baseUrl) {
      throw new Error(
        'Fantawild requires baseUrl to be configured ' +
        '(set FANTAWILD_BASEURL in .env, e.g. https://image.fangte.com)',
      );
    }
    if (!this.apiBaseUrl) {
      throw new Error(
        'Fantawild requires apiBaseUrl to be configured ' +
        '(set FANTAWILD_APIBASEURL in .env, e.g. https://leyou.fangte.com)',
      );
    }
  }

  // ── ID derivation (matches SixFlags pattern) ──────────────────────────────

  protected destinationIdFor(parkId: number): string  { return `fantawild_destination_${parkId}`; }
  protected parkIdFor(parkId: number): string         { return `fantawild_park_${parkId}`; }
  protected attractionIdFor(parkId: number, itemId: number): string {
    return `fantawild_attraction_${parkId}_${itemId}`;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  /** Per-park daily opening hours. parkId in the argument keys the @http cache per park. */
  @http({cacheSeconds: 60 * 15, retries: 2})
  async fetchBusinessTime(parkId: number): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/UploadFiles/Launch/BusinessTime/${this.businessTimeVersion}/${parkId}.json`,
      options: {json: true},
    } as unknown as HTTPObj;
  }

  /**
   * Per-park ride + show list with live wait times. This endpoint is on the
   * separate API host `leyou.fangte.com` rather than the CDN; the
   * `selectedDate` query param is required by the server (controls which
   * day's show times are reported) but the auth headers we observed in the
   * mobile app are NOT enforced — anonymous GETs return the same payload.
   *
   * Cache 60s — short enough for live-wait freshness, long enough to throttle.
   * The selectedDate baked into the URL changes per second; the wrapping
   * `@cache` on `getItems()` provides the cross-call dedup.
   */
  @http({cacheSeconds: 60, retries: 2})
  async fetchItemBusinessList(parkId: number, timezone: string): Promise<HTTPObj> {
    // Wall-clock in the park's local timezone, formatted the way the app does:
    // `YYYY-MM-DD HH:MM:SS.ffffff`. Round to the minute so the @http cache
    // key stays stable for ~60s — otherwise every call shifts the URL and
    // every request misses the upstream cache. Server reads only the date
    // portion in practice; rounding is safe.
    const minuteBoundary = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const stamp = formatInTimezone(minuteBoundary, timezone, 'iso').slice(0, 19).replace('T', ' ');
    const selectedDate = `${stamp}.000000`;
    const params = new URLSearchParams({
      sortType: '1',
      SuitablePeopleTag: '',
      ItemCharacteristicTag: '',
      ItemProperties: '',
      PayProperties: '',
      FunctionType: '',
      height: '0.0',
      parkId: String(parkId),
      selectedDate,
    });
    return {
      method: 'GET',
      url: `${this.apiBaseUrl}/project/api/ParkItem/GetItemBusinessList?${params.toString()}`,
      options: {json: true},
    } as unknown as HTTPObj;
  }

  // ── Cached parsed data ────────────────────────────────────────────────────

  /**
   * Fetch + return the parsed item list for one park. Returns [] on failure
   * so an outage on one park doesn't take out the whole 50-park sweep.
   *
   * Cached 60s by `parkId` — `buildEntityList` and `buildLiveData` both
   * call this for every park on the same tick; the @cache wrap dedupes
   * even though `fetchItemBusinessList`'s @http cache key shifts per
   * minute due to the rounded `selectedDate`.
   *
   * `cacheVersion: 1` is set explicitly so future shape changes (new fields
   * surfaced, status mapping rewrites) can bump it and silently invalidate
   * stale entries across deploys without manual flushes.
   */
  @cache({ttlSeconds: 60, cacheVersion: 1})
  async getItems(parkId: number, timezone: string): Promise<FantawildItem[]> {
    try {
      const resp = await this.fetchItemBusinessList(parkId, timezone);
      const json = await resp.json() as FantawildItemListResponse;
      return json?.data ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch + parse the next ~7-10 days of opening hours for one park.
   *
   * Dynamic cache TTL: 6h for a populated result (BusinessTime is a
   * forward-looking calendar that rarely changes intra-day, so a long TTL
   * cuts wasted parse work and CDN traffic across a 50-park sweep);
   * 60s if the result is empty — a transient CDN/parse failure shouldn't
   * stick around as a fabricated zero-day schedule for hours.
   */
  @cache({
    callback: (result: ScheduleEntry[]) => result.length === 0 ? 60 : 60 * 60 * 6,
    cacheVersion: 1,
  })
  async getSchedule(parkId: number, timezone: string): Promise<ScheduleEntry[]> {
    try {
      const resp = await this.fetchBusinessTime(parkId);
      const json = await resp.json() as FantawildBusinessTimeResponse;
      return parseBusinessTime(json, timezone);
    } catch {
      return [];
    }
  }

  /**
   * Permissive write-once flag tracking whether a park has EVER returned a
   * `waitTime > 0` in production. Combined with the static `hasLiveWaitTimes`
   * config flag via OR: once we observe a real queue, we mark the park as
   * live-wait-broadcasting forever (or until the SQLite cache file is
   * deleted). New Fantawild parks that roll out live waits after this PR
   * ships will self-correct without manual flag flips.
   *
   * Per the `feedback_cache_only_true.md` rule: only ever write TRUE to
   * this cache, never FALSE — a single quiet observation must not lock
   * the park into "no live waits" until cache expiry.
   *
   * Returns true if any item has `waitTime > 0`, and persists that fact
   * for 90 days (the cache file outlives any individual deploy).
   */
  protected async recordLiveWaitObservation(parkId: number, items: FantawildItem[]): Promise<boolean> {
    const key = `${this.getCacheKeyPrefix()}:liveWaitsObserved:v1:${parkId}`;
    if (CacheLib.get(key) === true) return true;
    const observed = items.some(i => Number.isFinite(i.waitTime) && i.waitTime > 0);
    if (observed) {
      CacheLib.set(key, true, 60 * 60 * 24 * 90);
      return true;
    }
    return false;
  }

  /**
   * Is the park currently open per its BusinessTime schedule?
   *
   * The live API's `itemOpened` flag is set by the operator's data-ops
   * team and tracks "in-season ride availability," not "is the gate open
   * right now" — at 5 AM China time we observed every ride at Wuhu
   * Dreamland reporting `itemOpened: true` even though the park was
   * closed for the night. Cross-checking against BusinessTime turns that
   * into the correct CLOSED status.
   */
  protected parkIsOpenNow(schedule: readonly ScheduleEntry[], timezone: string): boolean {
    const now = new Date();
    const today = formatDate(now, timezone);
    const nowMs = now.getTime();
    // Pick today's OPERATING window. The schedule may also contain
    // EXTRA_HOURS (night events); both qualify as "park open."
    for (const entry of schedule) {
      if (entry.date !== today) continue;
      if (entry.type !== 'OPERATING' && entry.type !== 'EXTRA_HOURS') continue;
      const open = Date.parse(entry.openingTime);
      const close = Date.parse(entry.closingTime);
      if (Number.isFinite(open) && Number.isFinite(close) && nowMs >= open && nowMs < close) {
        return true;
      }
    }
    return false;
  }

  // ── Public-API overrides (loop FANTAWILD_PARKS, mirror SixFlags shape) ────

  async getDestinations(): Promise<Entity[]> {
    // Force env-validation BEFORE returning destinations. Otherwise 49 ghost
    // destinations get registered with the wiki and every subsequent live-data
    // poll fails with the same misleading "request failed" error. The base
    // getEntities()/getLiveData()/getSchedules() already call init(); mirror
    // that here so getDestinations() fails the same way.
    await this.init();
    return FANTAWILD_PARKS.map(park => ({
      id: this.destinationIdFor(park.parkId),
      name: park.name,
      entityType: 'DESTINATION',
      timezone: park.timezone,
      location: park.location,
    } as Entity));
  }

  /**
   * Fan out: 49 parks × ~30 items each ≈ 1500 entities. Parallel fetch
   * works against the public API (observed comfortably with 50 concurrent
   * probes during discovery), but the shared @http queue throttles to
   * one request per 100ms anyway — so this is closer to staggered than
   * truly parallel. @reusable() coalesces in-flight calls so a collector
   * burst doesn't multiply work.
   */
  @reusable()
  protected async buildEntityList(): Promise<Entity[]> {
    const perPark = await Promise.all(FANTAWILD_PARKS.map(async park => {
      const destinationId = this.destinationIdFor(park.parkId);
      const parkEntityId = this.parkIdFor(park.parkId);
      const entities: Entity[] = [];

      entities.push({
        id: destinationId,
        name: park.name,
        entityType: 'DESTINATION',
        timezone: park.timezone,
        location: park.location,
      } as Entity);

      entities.push({
        id: parkEntityId,
        name: park.name,
        entityType: 'PARK',
        parentId: destinationId,
        destinationId,
        timezone: park.timezone,
        location: park.location,
      } as Entity);

      const items = await this.getItems(park.parkId, park.timezone);
      for (const item of items) {
        if (!item.id) continue;
        const cleanName = stripFantawildStars(item.itemName || '');
        if (!cleanName) continue;
        const isShow = isFantawildShow(item);
        const entity: Entity = {
          id: this.attractionIdFor(park.parkId, item.id),
          name: cleanName,
          entityType: isShow ? 'SHOW' : 'ATTRACTION',
          parentId: parkEntityId,
          parkId: parkEntityId,
          destinationId,
          timezone: park.timezone,
        } as Entity;
        // Subtype the ATTRACTION entities for consumers that distinguish
        // RIDE vs other attraction kinds (matches the SixFlags pattern).
        if (!isShow) {
          (entity as Entity & {attractionType?: string}).attractionType = 'RIDE';
        }
        if (Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) {
          (entity as Entity & {location?: {latitude: number; longitude: number}}).location = {
            latitude: item.latitude!,
            longitude: item.longitude!,
          };
        }
        entities.push(entity);
      }
      return entities;
    }));
    return perPark.flat();
  }

  @reusable()
  protected async buildLiveData(): Promise<LiveData[]> {
    const perPark = await Promise.all(FANTAWILD_PARKS.map(async park => {
      // Fetch items + schedule in parallel for this park, then cross-check.
      const [items, schedule] = await Promise.all([
        this.getItems(park.parkId, park.timezone),
        this.getSchedule(park.parkId, park.timezone),
      ]);
      const parkOpen = this.parkIsOpenNow(schedule, park.timezone);
      // Pick up runtime evidence that this park does broadcast live waits,
      // OR'd with the curated static flag. New parks light up automatically.
      const liveWaitsOn = park.hasLiveWaitTimes
        || await this.recordLiveWaitObservation(park.parkId, items);
      const out: LiveData[] = [];
      for (const item of items) {
        if (!item.id) continue;
        const isOpen = item.itemOpened === true;
        // `项目维护` ("under maintenance") explicitly flags a planned closure
        // distinct from "closed because the park's closed" — surface as REFURBISHMENT.
        const isMaintenance = !!item.statusStr && /维护/.test(item.statusStr);
        // Park-closed wins: even if itemOpened is true, the gate isn't open
        // — emit CLOSED rather than report ghost-OPERATING status all night.
        const status = !parkOpen
          ? 'CLOSED'
          : (isMaintenance ? 'REFURBISHMENT' : (isOpen ? 'OPERATING' : 'CLOSED'));
        const ld: LiveData = {
          id: this.attractionIdFor(park.parkId, item.id),
          status,
        } as LiveData;
        // Only emit STANDBY queue for parks that broadcast live wait times
        // (per curated config OR runtime observation). Otherwise `waitTime: 0`
        // would lie — every ride at a non-live park would report a permanent
        // zero-minute queue.
        if (liveWaitsOn
            && status === 'OPERATING'
            && Number.isFinite(item.waitTime)
            && item.waitTime >= 0) {
          (ld as LiveData & {queue?: Record<string, {waitTime: number}>}).queue = {
            STANDBY: {waitTime: item.waitTime},
          };
        }
        out.push(ld);
      }
      return out;
    }));
    return perPark.flat();
  }

  @reusable()
  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const out = await Promise.all(FANTAWILD_PARKS.map(async park => {
      const schedule = await this.getSchedule(park.parkId, park.timezone);
      return {id: this.parkIdFor(park.parkId), schedule} as EntitySchedule;
    }));
    return out;
  }
}
