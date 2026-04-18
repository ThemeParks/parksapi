import crypto from 'crypto';
import {Destination, DestinationConstructor} from '../../destination.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {hostnameFromUrl, formatDate, addDays, constructDateTime} from '../../datetime.js';
import {CacheLib} from '../../cache.js';
import {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';

// ─── Constants ────────────────────────────────────────────────────────────────

const DESTINATION_ID = 'universalsingapore';
const PARK_ID = 'uss.uss';
const PARK_DB_ID = 1; // ParkList.Id for USS
const TIMEZONE = 'Asia/Singapore';

// Categories to fetch for entity building and live data
const ENTITY_CATEGORIES = [1, 2, 3] as const; // Rides, Shows, Meet & Greets

// Map category ID → entityType
const CATEGORY_ENTITY_TYPE: Record<number, Entity['entityType']> = {
  1: 'ATTRACTION', // Rides
  2: 'SHOW',       // Shows
  3: 'ATTRACTION', // Meet & Greets
};

// ─── API types ────────────────────────────────────────────────────────────────

type USSAttraction = {
  AttractionId: number;
  AttractionCategoryId: number;
  Title: string;
  /** Live wait time as string: "15" (minutes) when park open, "10:00AM" (opening time) when closed */
  WaitTime: string;
  isWaitTimeEnable: boolean;
  IsAvailable: boolean;
  AvgTime: number;
  LatLng: string; // "103.8215,1.2539" — lng,lat order
  ReasonCode: string;
};

type USSAttractionListResponse = {
  StatusCode: number;
  Result: USSAttraction[];
};

type USSCalendarEntry = {
  Date: string;        // 'YYYY-MM-DD'
  IsAvailable: boolean;
};

type USSCalendarResponse = {
  ThemeParkCalendarList: USSCalendarEntry[];
  ResultCode: number;
  ResultMessage: string;
};

type USSScheduleDay = {
  Number: string;    // day-of-month: "1"
  StartHour: string; // "10:00"
  EndHour: string;   // "20:00"
  Activities: unknown[];
};

type USSScheduleMonth = {
  Value: string;  // month number: "4"
  Name: string;   // "April"
  Year: string;   // "2026"
  Days: USSScheduleDay[];
};

type USSAuthResponse = {
  StatusCode: number;
  Result: {
    Token: string;
  };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build timestamp string in YYYYMMDDHHMMSS format (API cache-buster) */
function nowTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

/**
 * Extract the months schedule block from the RWS website HTML.
 * The page embeds Sitecore JSS state containing:
 * "months":{"Months":[{Value, Name, Year, Days:[{Number, StartHour, EndHour}]}]}
 * Returns a map of "YYYY-MM-DD" → {start, end} for efficient lookup.
 */
function parseMonthsFromHtml(html: string): Map<string, {start: string; end: string}> {
  const map = new Map<string, {start: string; end: string}>();
  const marker = '"months":{"Months":';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return map;

  const bracketIdx = markerIdx + marker.length;
  if (html[bracketIdx] !== '[') return map;

  let depth = 0;
  let end = -1;
  for (let i = bracketIdx; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return map;

  try {
    const months: USSScheduleMonth[] = JSON.parse(html.substring(bracketIdx, end + 1));
    for (const month of months) {
      const mm = String(month.Value).padStart(2, '0');
      for (const day of month.Days) {
        const dd = String(day.Number).padStart(2, '0');
        map.set(`${month.Year}-${mm}-${dd}`, {start: day.StartHour, end: day.EndHour});
      }
    }
  } catch {
    // Malformed JSON — return whatever was parsed so far
  }

  return map;
}

/**
 * Parse wait time from the WaitTime string.
 * Returns minutes as a number when the string starts with a number ("20 mins" → 20, "15" → 15),
 * or null when it's a time-of-day string ("10:00AM" → null).
 */
function parseWaitTime(waitTimeStr: string): number | null {
  const minutes = parseInt(waitTimeStr, 10);
  if (!isNaN(minutes) && minutes >= 0) {
    return minutes;
  }
  return null;
}

/**
 * Parse LatLng string in "lng,lat" order.
 * Returns {latitude, longitude} or undefined if malformed.
 */
function parseLatLng(latlng: string): {latitude: number; longitude: number} | undefined {
  const parts = latlng.split(',').map((s) => parseFloat(s.trim()));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return {latitude: parts[1], longitude: parts[0]};
  }
  return undefined;
}

/**
 * Dart-compatible ISO 8601 string with microseconds (27 chars).
 * Dart's toIso8601String() emits microseconds; JS only has ms, so we pad with 000.
 * e.g. "2026-04-02T20:03:27.372503Z"
 */
function dartIsoString(): string {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, '$1000Z');
}

/** AES-256-CBC encrypt with PKCS7, fixed key+IV, returns base64 ciphertext */
function aesEncrypt(plaintext: string, key: Buffer, iv: Buffer): string {
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

// ─── Implementation ───────────────────────────────────────────────────────────

@destinationController({category: 'Universal'})
export class UniversalSingapore extends Destination {
  @config
  apiBase: string = '';

  @config
  appVersion: string = '2.1.3';

  @config
  appBuild: string = '36';

  @config
  aesKey: string = '';

  @config
  aesIv: string = '';

  /** Pre-provisioned bearer JWT (~12h TTL). When set, skips WithoutLogin entirely.
   *  The `/api/Login/WithoutLogin` endpoint returns a low-privilege token that can't
   *  see attractions; the real token currently has to be captured from the live app. */
  @config
  bearerToken: string = '';

  @config
  websiteBase: string = '';

  @config
  websiteApiKey: string = '';

  timezone = TIMEZONE;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('UNIVERSALSINGAPORE');
  }

  // ─── Initialisation ──────────────────────────────────────────────────────

  /** Pre-warm the auth token so it is cached before buildEntityList /
   *  buildLiveData fire their concurrent fetchAttractionList requests. */
  protected async _init(): Promise<void> {
    await this.getToken();
  }

  // ─── Authentication ──────────────────────────────────────────────────────

  /** Stable device UUID — generated once, cached for 3 months in SQLite */
  @cache({ttlSeconds: 60 * 60 * 24 * 90})
  async getDeviceId(): Promise<string> {
    return crypto.randomUUID();
  }

  @http({tags: ['auth']} as any)
  async fetchToken(): Promise<HTTPObj> {
    const deviceId = await this.getDeviceId();
    return {
      method: 'POST',
      url: `${this.apiBase}/uniapi/api/Login/WithoutLogin`,
      body: JSON.stringify({
        deviceType: '1',
        deviceId,
        appVersion: this.appVersion,
        fcmToken: '',
        isNotificationAlert: true,
        languageId: 1,
        IpAddress: '192.168.1.1',
      }),
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'user-agent': `Universal SG/${this.appVersion}+${this.appBuild} (android)`,
      },
      tags: ['auth'],
    } as any as HTTPObj;
  }

  /** Bearer token cached for 11 hours (token expires in 12h).
   * The @http decorator on fetchToken() provides in-flight deduplication at the
   * framework level — concurrent cold-start calls share a single pending request,
   * preventing the USS API from invalidating earlier tokens when a new one is issued
   * for the same device. */
  @cache({ttlSeconds: 60 * 60 * 11})
  async getToken(): Promise<string> {
    if (this.bearerToken) return this.bearerToken;
    const resp = await this.fetchToken();
    const data: USSAuthResponse = await resp.json();
    if (!data?.Result?.Token) {
      throw new Error('USS: failed to obtain auth token');
    }
    return data.Result.Token;
  }

  @inject({
    eventName: 'httpRequest',
    hostname: function(this: UniversalSingapore) { return hostnameFromUrl(this.apiBase); },
    tags: {$nin: ['auth']},
    priority: 2,
  } as any)
  async injectAuth(req: HTTPObj): Promise<void> {
    const token = await this.getToken();
    req.headers = {
      ...req.headers,
      'Authorization': `Bearer ${token}`,
    };
  }

  /** Inject x-request-id (AES-encrypted timestamp) on every API request. */
  @inject({
    eventName: 'httpRequest',
    hostname: function(this: UniversalSingapore) { return hostnameFromUrl(this.apiBase); },
    priority: 1,
  } as any)
  async injectSigning(req: HTTPObj): Promise<void> {
    const key = Buffer.from(this.aesKey, 'base64');
    const iv = Buffer.from(this.aesIv, 'base64');
    req.headers = {
      ...req.headers,
      'X-Request-Id': aesEncrypt(dartIsoString(), key, iv),
    };
  }

  /**
   * On 401 from an authenticated request, the server-side token was invalidated
   * (USS only allows one active token per device at a time). Clear the cached token
   * and nullify the response so the framework treats it as a retryable network error —
   * the retry will run the inject chain fresh and obtain a new token.
   */
  @inject({
    eventName: 'httpError',
    hostname: function(this: UniversalSingapore) { return hostnameFromUrl(this.apiBase); },
    tags: {$nin: ['auth']},
  } as any)
  async injectTokenRefresh(req: HTTPObj): Promise<void> {
    if (req.response && req.status === 401) {
      // If a static bearer token is configured, don't try to refresh — it's expired
      // and needs to be replaced manually via the env var.
      if (this.bearerToken) {
        throw new Error('USS: UNIVERSALSINGAPORE_BEARERTOKEN has expired — paste a fresh JWT from the live app');
      }
      CacheLib.delete(`${this.constructor.name}:getToken:[]`);
      req.response = undefined as any; // treat as network error so framework retries
    }
  }

  // ─── HTTP fetch methods ──────────────────────────────────────────────────

  /** Fetch 31-day availability calendar from the public RWS website API. */
  @http({retries: 1} as any)
  async fetchCalendarApi(fromDate: string): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.websiteBase}/rwsapi/themeParkCalendarList?validTimeFrom=${fromDate}&themeParkCode=USS&loadCalendarFromBME=true&sc_apikey=${this.websiteApiKey}`,
      headers: {
        'accept': 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  /** Cached calendar entries — refreshed every 12 hours. */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getCalendar(fromDate: string): Promise<USSCalendarEntry[]> {
    const resp = await this.fetchCalendarApi(fromDate);
    const data: USSCalendarResponse = await resp.json();
    return data?.ThemeParkCalendarList || [];
  }

  /** Fetch the USS attraction page — contains per-day schedule hours embedded in HTML. */
  @http({retries: 1} as any)
  async fetchWebsitePage(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.websiteBase}/en/play/universal-studios-singapore`,
      headers: {
        'accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    } as any as HTTPObj;
  }

  /** Hours lookup map from embedded page data — refreshed every 24 hours. */
  @cache({ttlSeconds: 60 * 60 * 24})
  async getHoursMap(): Promise<[string, {start: string; end: string}][]> {
    const resp = await this.fetchWebsitePage();
    const html = await resp.text();
    return Array.from(parseMonthsFromHtml(html).entries());
  }

  /** Fetch attractions for a given category. Timestamp is a cache-buster. */
  @http({retries: 1} as any)
  async fetchAttractionList(categoryId: number): Promise<HTTPObj> {
    const ts = nowTimestamp();
    return {
      method: 'GET',
      url: `${this.apiBase}/uniapi/api/v2/Transaction/GetAttractionList/${PARK_DB_ID}/${categoryId}/${ts}`,
      headers: {
        'user-agent': `Universal SG/${this.appVersion}+${this.appBuild} (android)`,
        'content-type': 'application/json; charset=UTF-8',
      },
      options: {json: true},
    } as any as HTTPObj;
  }

  // ─── Cached accessors ────────────────────────────────────────────────────

  /** Entity data — long TTL since attraction names/IDs rarely change */
  @cache({ttlSeconds: 60 * 60 * 12})
  async getAttractionEntities(categoryId: number): Promise<USSAttraction[]> {
    const resp = await this.fetchAttractionList(categoryId);
    const data: USSAttractionListResponse = await resp.json();
    return data?.Result || [];
  }

  /** Live data — short TTL for up-to-date wait times */
  @cache({ttlSeconds: 60})
  async getAttractionLiveData(categoryId: number): Promise<USSAttraction[]> {
    const resp = await this.fetchAttractionList(categoryId);
    const data: USSAttractionListResponse = await resp.json();
    return data?.Result || [];
  }

  // ─── Destination ─────────────────────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [
      {
        id: DESTINATION_ID,
        name: 'Universal Studios Singapore',
        entityType: 'DESTINATION',
        timezone: TIMEZONE,
        location: {latitude: 1.2540, longitude: 103.8239},
      } as Entity,
    ];
  }

  // ─── Entity list ─────────────────────────────────────────────────────────

  protected async buildEntityList(): Promise<Entity[]> {
    const parkEntity: Entity = {
      id: PARK_ID,
      name: 'Universal Studios Singapore',
      entityType: 'PARK',
      parentId: DESTINATION_ID,
      destinationId: DESTINATION_ID,
      timezone: TIMEZONE,
      location: {latitude: 1.2540, longitude: 103.8239},
    } as Entity;

    const categoryData = await Promise.all(
      ENTITY_CATEGORIES.map((catId) => this.getAttractionEntities(catId)),
    );

    const attractionEntities: Entity[] = [];

    for (let i = 0; i < ENTITY_CATEGORIES.length; i++) {
      const catId = ENTITY_CATEGORIES[i];
      const entityType = CATEGORY_ENTITY_TYPE[catId];

      for (const attr of categoryData[i]) {
        const entity: Entity = {
          id: String(attr.AttractionId),
          name: attr.Title.replace(/^\[(?:Temporarily )?unavailable\]\s*/i, ''),
          entityType,
          parentId: PARK_ID,
          destinationId: DESTINATION_ID,
          timezone: TIMEZONE,
        } as Entity;

        const loc = parseLatLng(attr.LatLng);
        if (loc) entity.location = loc;

        attractionEntities.push(entity);
      }
    }

    return [parkEntity, ...attractionEntities];
  }

  // ─── Live data ────────────────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const categoryData = await Promise.all(
      ENTITY_CATEGORIES.map((catId) => this.getAttractionLiveData(catId)),
    );

    const results: LiveData[] = [];
    const allAttrs = categoryData.flat();

    // Check if any ride has a non-zero wait time (park is operating)
    const parkIsOpen = allAttrs.some(
      (a) => a.isWaitTimeEnable && (parseWaitTime(a.WaitTime) ?? 0) > 0,
    );

    for (const attr of allAttrs) {
      const tempUnavailable = /^\[(?:Temporarily )?unavailable\]/i.test(attr.Title);
      const waitTime = attr.isWaitTimeEnable
        ? (parseWaitTime(attr.WaitTime) ?? attr.AvgTime ?? undefined)
        : undefined;

      let status: string;
      if (tempUnavailable) {
        // Only report DOWN if the park is actually open, otherwise CLOSED
        status = parkIsOpen ? 'DOWN' : 'CLOSED';
      } else if (attr.IsAvailable) {
        status = 'OPERATING';
      } else {
        status = 'CLOSED';
      }

      const ld: LiveData = {id: String(attr.AttractionId), status} as LiveData;

      if (status === 'OPERATING' && attr.isWaitTimeEnable && waitTime != null) {
        ld.queue = {STANDBY: {waitTime: waitTime ?? undefined}};
      }

      results.push(ld);
    }

    return results;
  }

  // ─── Schedules ────────────────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    if (!this.websiteBase) return [];

    const today = formatDate(new Date(), TIMEZONE);
    const future = formatDate(addDays(new Date(), 31), TIMEZONE);

    // Fetch availability calendar (62 days) and per-day hours concurrently.
    // The page HTML covers ~90 days (current month + 2 more) with accurate
    // per-day hours. The calendar API provides explicit open/closed status
    // for the first 62 days — use it only to filter out explicitly-closed days.
    const [window1, window2, hoursEntries] = await Promise.all([
      this.getCalendar(today),
      this.getCalendar(future),
      this.getHoursMap(),
    ]);

    const hoursMap = new Map(hoursEntries);

    // Build availability map from calendar API (undefined = not covered, assume open)
    const availabilityMap = new Map<string, boolean>();
    for (const entry of [...window1, ...window2]) {
      availabilityMap.set(entry.Date, entry.IsAvailable);
    }

    const scheduleEntries: object[] = [];

    for (const [date, hours] of hoursMap) {
      // Skip days explicitly marked unavailable; include days not yet in the API window
      if (availabilityMap.get(date) === false) continue;

      scheduleEntries.push({
        date,
        type: 'PARK_OPEN',
        openingTime: constructDateTime(date, hours.start, TIMEZONE),
        closingTime: constructDateTime(date, hours.end, TIMEZONE),
      });
    }

    // Sort chronologically
    scheduleEntries.sort((a: any, b: any) => a.date.localeCompare(b.date));

    return [{
      id: PARK_ID,
      schedule: scheduleEntries,
    } as unknown as EntitySchedule];
  }
}
