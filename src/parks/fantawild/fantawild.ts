/**
 * Fantawild (方特 / Fang Te) — shared base class for all Fantawild theme parks.
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
 *       /UploadFiles/Launch/CityPark/{cityParkVersion}.json
 *         Master park list. {version} is a release pointer, not a parkId.
 *       /UploadFiles/Launch/BusinessTime/{businessTimeVersion}/{parkId}.json
 *         Per-park daily opening hours, keyed by the small parkId.
 *       /UploadFiles/Launch/Announcement/{businessTimeVersion}/{parkId}.json
 *         Per-park announcements.
 *
 *   - JSON API: `leyou.fangte.com`
 *       /project/api/ParkItem/GetItemBusinessList?parkId=…&selectedDate=…
 *         Full ride + show list with live `waitTime`, `itemOpened` flag,
 *         `statusStr` (e.g. `项目维护` = under maintenance), per-ride
 *         lat/lng, and `showTimeList` of operating-hours range or discrete
 *         show times.
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import config from '../../config.js';
import type {Entity, LiveData, EntitySchedule, ScheduleEntry} from '@themeparks/typelib';
import {constructDateTime, formatInTimezone} from '../../datetime.js';

// ── API types ───────────────────────────────────────────────────────────────

export interface FantawildBusinessTimeEntry {
  /** "YYYY-MM-DD HH:MM:SS" wall-clock in the park timezone */
  currentDate: string;
  /** "HH:MM" — empty string when closed */
  startTime: string;
  /** "HH:MM" — empty string when closed */
  endTime: string;
  isNight: boolean;
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

export interface FantawildCityParkEntry {
  parkName: string;
  parkTypeName?: string;
  picUrl?: string;
  logoPicUrl?: string;
  id: number;
  poiId?: string;
  poiCode?: number;
  poiCategory?: number;
  lngLong?: Array<{latitude: number; longitude: number; sort: number}>;
  waitTimeAreaLngLong?: Array<{latitude: number; longitude: number; sort: number}>;
  onLineChannelList?: number[];
}

export interface FantawildCityEntry {
  id: number;
  cityName: string;
  cityNameSpell?: string;
  cityCode?: string;
  parkList: FantawildCityParkEntry[];
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

/** Trailing star-rating glyphs Fantawild bakes into itemName (e.g. `孟姜女⭐⭐⭐⭐`). */
const STAR_RE = /[⭐⭐️]+\s*$/u;

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
  const allDiscrete = times.every(t => /^\d{1,2}:\d{2}$/.test(t.trim()));
  return allDiscrete && times.length >= 1;
}

// ── Schedule parser ─────────────────────────────────────────────────────────

/**
 * Convert a Fantawild BusinessTime response to ScheduleEntry[].
 *
 * Pure module-level function so it can be unit-tested without the destination
 * harness. Skips entries that aren't `activated`, that have no `startTime`,
 * or whose date can't be parsed. Adds an EXTRA_HOURS entry when `isNight`
 * is true and night times are populated — the park's day session has its
 * own startTime/endTime, and the night session (e.g. fireworks/dark-ride
 * event) is layered on top.
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
    if (ev.startTime && ev.endTime) {
      out.push({
        date,
        type: 'OPERATING' as const,
        openingTime: constructDateTime(date, ev.startTime, timezone),
        closingTime: constructDateTime(date, ev.endTime, timezone),
      });
    }
    if (ev.isNight && ev.nightStartTime && ev.nightEndTime) {
      out.push({
        date,
        type: 'EXTRA_HOURS' as const,
        openingTime: constructDateTime(date, ev.nightStartTime, timezone),
        closingTime: constructDateTime(date, ev.nightEndTime, timezone),
      });
    }
  }
  return out;
}

// ── Base class ──────────────────────────────────────────────────────────────

class Fantawild extends Destination {
  /** Static-asset CDN root, e.g. `https://image.fangte.com` (no trailing slash). */
  @config baseUrl: string = '';
  /** Authenticated API root, e.g. `https://leyou.fangte.com` (no trailing slash). */
  @config apiBaseUrl: string = '';
  /** Top-level destination id, e.g. `fantawild_wuhudreamland` */
  @config destinationId: string = '';
  /** Display name for the DESTINATION entity */
  @config destinationName: string = '';
  /** The small numeric parkId Fantawild assigns (17, 19, 21, …) — keyed in BusinessTime URL. */
  @config parkId: number = 0;
  /** IANA timezone for the destination. Defaults to Asia/Shanghai (mainland China). */
  @config timezone: string = 'Asia/Shanghai';

  /** Destination-level geographic location (lat/lng). */
  destinationLocation?: {latitude: number; longitude: number};

  /**
   * Route-prefix constants for the static CDN paths. These are baked into
   * the app and only change when Fantawild ships new versioned route maps.
   * Override per-subclass if a future app rev splits parks across cohorts.
   */
  protected businessTimeVersion: string = '50418';
  protected announcementVersion: string = '50418';
  protected cityParkVersion: string = '50622';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('FANTAWILD');
    const cfg = (options?.config ?? {}) as Partial<Fantawild>;
    if (cfg.destinationLocation) this.destinationLocation = cfg.destinationLocation;
  }

  /** Cache-key prefix so per-park caches don't collide on shared method keys. */
  getCacheKeyPrefix(): string {
    return `fantawild:${this.parkId}`;
  }

  protected async _init(): Promise<void> {
    if (!this.baseUrl) {
      throw new Error(
        `${this.constructor.name} requires baseUrl to be configured ` +
        `(set FANTAWILD_BASEURL in .env, e.g. https://image.fangte.com)`,
      );
    }
    if (!this.apiBaseUrl) {
      throw new Error(
        `${this.constructor.name} requires apiBaseUrl to be configured ` +
        `(set FANTAWILD_APIBASEURL in .env, e.g. https://leyou.fangte.com)`,
      );
    }
    if (!this.parkId) {
      throw new Error(`${this.constructor.name} requires a numeric parkId to be configured`);
    }
    if (!this.destinationId) {
      throw new Error(`${this.constructor.name} requires destinationId to be configured`);
    }
  }

  // ===== HTTP =====

  /** Master park list (all 50 Fantawild parks across all cities). Shared across destinations; cache aggressively. */
  @http({cacheSeconds: 60 * 60 * 6, retries: 2})
  async fetchCityPark(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/UploadFiles/Launch/CityPark/${this.cityParkVersion}.json`,
      options: {json: true},
    } as unknown as HTTPObj;
  }

  /** Per-park daily opening hours. */
  @http({cacheSeconds: 60 * 15, retries: 2})
  async fetchBusinessTime(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/UploadFiles/Launch/BusinessTime/${this.businessTimeVersion}/${this.parkId}.json`,
      options: {json: true},
    } as unknown as HTTPObj;
  }

  /** Per-park announcements. Phase 1 doesn't surface them, but kept for future use. */
  @http({cacheSeconds: 60 * 30, retries: 2})
  async fetchAnnouncements(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/UploadFiles/Launch/Announcement/${this.announcementVersion}/${this.parkId}.json`,
      options: {json: true},
    } as unknown as HTTPObj;
  }

  /**
   * Per-park ride + show list with live wait times. This endpoint is on the
   * separate authenticated host `leyou.fangte.com` rather than the CDN; the
   * `selectedDate` query param is required by the server (controls which
   * day's show times are reported) but the auth headers we observed in the
   * mobile app are NOT enforced — anonymous GETs return the same payload.
   *
   * Cache 60s — short enough for live-wait freshness, long enough to throttle.
   */
  @http({cacheSeconds: 60, retries: 2})
  async fetchItemBusinessList(): Promise<HTTPObj> {
    // Wall-clock in the park's local timezone, formatted the way the app does:
    // `YYYY-MM-DD HH:MM:SS.ffffff`. The server reads only the date portion in
    // practice, but mirroring the app's format keeps us in the same code path
    // on the server side.
    const now = formatInTimezone(new Date(), this.timezone, 'iso').slice(0, 19).replace('T', ' ');
    const selectedDate = `${now}.000000`;
    const params = new URLSearchParams({
      sortType: '1',
      SuitablePeopleTag: '',
      ItemCharacteristicTag: '',
      ItemProperties: '',
      PayProperties: '',
      FunctionType: '',
      height: '0.0',
      parkId: String(this.parkId),
      selectedDate,
    });
    return {
      method: 'GET',
      url: `${this.apiBaseUrl}/project/api/ParkItem/GetItemBusinessList?${params.toString()}`,
      options: {json: true},
    } as unknown as HTTPObj;
  }

  // ===== Schedule scraping =====

  /**
   * Fetch + parse the next ~7 days of opening hours. Returns [] on any
   * fetch/parse failure so an outage on one park doesn't take out a multi-
   * park sweep.
   */
  @cache({ttlSeconds: 60 * 10})
  async scrapeSchedule(): Promise<ScheduleEntry[]> {
    try {
      const resp = await this.fetchBusinessTime();
      const json = await resp.json() as FantawildBusinessTimeResponse;
      return parseBusinessTime(json, this.timezone);
    } catch {
      return [];
    }
  }

  /**
   * Fetch + return the raw item list. Returns [] on any failure.
   *
   * Cached 60s. `fetchItemBusinessList()` bakes the wall-clock into the
   * `selectedDate` query string, so its underlying `@http` cache key
   * changes every second and wouldn't dedupe the calls fired by
   * `buildEntityList()` and `buildLiveData()` in the same tick. The
   * argless `@cache` here keys on class + method only, so both builders
   * share one payload per parkId per 60s window.
   */
  @cache({ttlSeconds: 60})
  async fetchItems(): Promise<FantawildItem[]> {
    try {
      const resp = await this.fetchItemBusinessList();
      const json = await resp.json() as FantawildItemListResponse;
      return json?.data ?? [];
    } catch {
      return [];
    }
  }

  /** Build a stable attraction id from a Fantawild ride id. */
  protected attractionId(itemId: number): string {
    return `fantawild_attraction_${this.parkId}_${itemId}`;
  }

  // ===== Public-API overrides =====

  async getDestinations(): Promise<Entity[]> {
    const dest: Entity = {
      id: this.destinationId,
      name: this.destinationName,
      entityType: 'DESTINATION',
      timezone: this.timezone,
    } as Entity;
    if (this.destinationLocation) {
      (dest as Entity & {location?: {latitude: number; longitude: number}}).location = this.destinationLocation;
    }
    return [dest];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const parkId = `fantawild_park_${this.parkId}`;
    const parkEntity: Entity = {
      id: parkId,
      name: this.destinationName,
      entityType: 'PARK',
      parentId: this.destinationId,
      destinationId: this.destinationId,
      timezone: this.timezone,
    } as Entity;
    if (this.destinationLocation) {
      (parkEntity as Entity & {location?: {latitude: number; longitude: number}}).location = this.destinationLocation;
    }

    const out: Entity[] = [parkEntity];
    const items = await this.fetchItems();
    for (const item of items) {
      // Skip entries with no usable id or name.
      if (!item.id) continue;
      const cleanName = stripFantawildStars(item.itemName || '');
      if (!cleanName) continue;
      const entityType = isFantawildShow(item) ? 'SHOW' : 'ATTRACTION';
      const entity: Entity = {
        id: this.attractionId(item.id),
        name: cleanName,
        entityType,
        parentId: parkId,
        parkId,
        destinationId: this.destinationId,
        timezone: this.timezone,
      } as Entity;
      if (Number.isFinite(item.latitude) && Number.isFinite(item.longitude)) {
        (entity as Entity & {location?: {latitude: number; longitude: number}}).location = {
          latitude: item.latitude!,
          longitude: item.longitude!,
        };
      }
      out.push(entity);
    }
    return out;
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const items = await this.fetchItems();
    const out: LiveData[] = [];
    for (const item of items) {
      if (!item.id) continue;
      const isOpen = item.itemOpened === true;
      // `项目维护` ("under maintenance") explicitly flags a planned closure
      // distinct from "closed because the park's closed" — surface as REFURBISHMENT.
      const isMaintenance = !!item.statusStr && /维护/.test(item.statusStr);
      const status = isMaintenance ? 'REFURBISHMENT' : (isOpen ? 'OPERATING' : 'CLOSED');
      const ld: LiveData = {
        id: this.attractionId(item.id),
        status,
      } as LiveData;
      // Only attach a STANDBY wait time when the ride is OPERATING and the
      // API returned a finite, non-negative value. Avoid emitting waitTime=0
      // for closed rides — `0` should mean "no queue right now," not "park
      // closed so we don't actually know."
      if (status === 'OPERATING' && Number.isFinite(item.waitTime) && item.waitTime >= 0) {
        (ld as LiveData & {queue?: Record<string, {waitTime: number}>}).queue = {
          STANDBY: {waitTime: item.waitTime},
        };
      }
      out.push(ld);
    }
    return out;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const schedule = await this.scrapeSchedule();
    return [{id: `fantawild_park_${this.parkId}`, schedule} as EntitySchedule];
  }
}

export {Fantawild};
