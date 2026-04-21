import {Destination, DestinationConstructor} from '../../destination.js';
import crypto from 'crypto';

import {cache} from '../../cache.js';
import {CacheLib} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {
  Entity,
  LiveData,
  EntitySchedule,
} from '@themeparks/typelib';
import {constructDateTime, hostnameFromUrl, formatDate} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';
import {decodeHtmlEntities} from '../../htmlUtils.js';

/**
 * Normalise the Phantasialand API's name-ish fields. The API has at various
 * times returned either a bare string (in the default language) or an object
 * like {en, de, ...}. Accept both without losing data: when only a string is
 * given, use it as both locales so the framework's locale resolution still
 * works downstream.
 */
function pickLocalisedName(raw: unknown): {en: string; de: string} {
  if (!raw) return {en: '', de: ''};
  if (typeof raw === 'string') return {en: raw, de: raw};
  if (typeof raw === 'object') {
    const o = raw as Record<string, string | undefined>;
    const en = o.en || '';
    const de = o.de || en || '';
    return {en: en || de, de};
  }
  return {en: '', de: ''};
}

// Category to entity type mapping
const categoryToEntityType: Record<string, Entity['entityType'] | undefined> = {
  'ATTRACTIONS': 'ATTRACTION',
  'SHOWS': 'SHOW',
  'THE_SIX_DRAGONS': 'SHOW',
  'THEATER': 'SHOW',
  'RESTAURANTS_AND_SNACKS': 'RESTAURANT',
  'PHANTASIALAND_HOTELS_RESTAURANTS': 'RESTAURANT',
};

@destinationController({category: 'Phantasialand'})
export class Phantasialand extends Destination {
  @config
  apiBase: string = '';

  @config
  timezone: string = 'Europe/Berlin';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('PHANTASIALAND');
  }

  // ===== Authentication =====

  /**
   * Create an anonymous user for API access.
   * Returns email and password credentials, cached for 11 months.
   */
  @cache({ttlSeconds: 28908060})
  async createUser(): Promise<{email: string; password: string}> {
    const email = `${crypto.randomUUID()}@android.com`;
    const password = crypto.randomUUID();

    const resp = await this.fetchCreateUser(email, password);
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`Failed to create Phantasialand user: ${resp.status} ${JSON.stringify(data)}`);
    }

    return {email, password};
  }

  @http({})
  async fetchCreateUser(email: string, password: string): Promise<HTTPObj> {

    return {
      method: 'POST',
      url: `${this.apiBase}/app-users`,
      body: {
        email,
        password,
        language: 'en',
        platform: 'android',
      },
      options: {json: true},
      tags: ['auth'],
    } as any as HTTPObj;
  }

  /**
   * Login with credentials to get an access token.
   * Cached for 11 months.
   */
  @cache({
    ttlSeconds: 28908060,
    key: 'phantasialand:accessToken',
  })
  async getAccessToken(): Promise<string> {
    const {email, password} = await this.createUser();

    const resp = await this.fetchLogin(email, password);
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`Failed to login to Phantasialand: ${resp.status} ${JSON.stringify(data)}`);
    }

    return data.id;
  }

  @http({})
  async fetchLogin(email: string, password: string): Promise<HTTPObj> {
    return {
      method: 'POST',
      url: `${this.apiBase}/app-users/login`,
      body: {
        email,
        password,
        ttl: 31556926,
      },
      options: {json: true},
      tags: ['auth'],
    } as any as HTTPObj;
  }

  /**
   * Handle 401/403 responses by clearing cached access token and nullifying the
   * response so the HTTP framework treats it as a retryable network error —
   * the retry will then obtain a fresh token. Skipped for auth requests
   * themselves to avoid infinite loops.
   */
  @inject({
    eventName: 'httpError',
    hostname: function() { return hostnameFromUrl(this.apiBase); },
    tags: {$nin: ['auth']},
  } as any)
  async handleUnauthorized(requestObj: HTTPObj): Promise<void> {
    const status = requestObj.response?.status;
    if (status === 401 || status === 403) {
      // Clear both token AND user — if the anonymous account was pruned server-side,
      // re-login will keep succeeding but every issued token will 403. Forcing a
      // new createUser on retry is the only recovery path.
      CacheLib.delete('phantasialand:accessToken');
      CacheLib.delete(`${this.constructor.name}:createUser:[]`);
      requestObj.response = undefined as any;
    }
  }

  // ===== Header & Token Injection =====

  /**
   * Inject user-agent into all API requests
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function() { return hostnameFromUrl(this.apiBase); },
  })
  async injectHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'user-agent': 'okhttp/3.12.1',
    };
  }

  /**
   * Inject access_token query parameter into GET requests.
   * Excludes auth-related requests (those with app-users in URL).
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function() { return hostnameFromUrl(this.apiBase); },
    tags: {$nin: ['auth']},
  })
  async injectAccessToken(requestObj: HTTPObj): Promise<void> {
    // Only inject for GET requests that are not auth-related
    if (requestObj.method !== 'GET') return;
    if (requestObj.url.includes('app-users')) return;

    const token = await this.getAccessToken();

    // Append access_token as query parameter
    const url = new URL(requestObj.url);
    url.searchParams.set('access_token', token);
    requestObj.url = url.toString();
  }

  // ===== HTTP Fetch Methods =====

  /**
   * Fetch POI data (entity list)
   */
  @http({cacheSeconds: 21600, retries: 2}) // 6 hours
  async fetchPOI(): Promise<HTTPObj> {

    return {
      method: 'GET',
      url: `${this.apiBase}/pois?filter[where][seasons][like]=%&compact=true`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get POI data (cached 6 hours)
   */
  @cache({ttlSeconds: 21600})
  async getPOI(): Promise<any[]> {

    const resp = await this.fetchPOI();
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  /**
   * Fetch signage/wait time data.
   * Requires random coordinates within park bounds.
   */
  @http({cacheSeconds: 60, retries: 2}) // 1 minute
  async fetchSignage(): Promise<HTTPObj> {
    // Generate random coordinates within park bounds
    const lat = 50.799683077 + (Math.random() * (50.800659529 - 50.799683077));
    const lng = 6.877570152 + (Math.random() * (6.878342628 - 6.877570152));
    return {
      method: 'GET',
      url: `${this.apiBase}/signage-snapshots?loc=${lat},${lng}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get signage data (cached 1 minute)
   */
  @cache({ttlSeconds: 60})
  async getSignage(): Promise<any[]> {
    const resp = await this.fetchSignage();
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  }

  /**
   * Fetch live park info (isOpen, closing time) from API
   */
  @http({cacheSeconds: 300, retries: 2}) // 5 min
  async fetchParkInfos(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/park-infos`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @cache({ttlSeconds: 300})
  async getParkInfos(): Promise<any> {
    try {
      const resp = await this.fetchParkInfos();
      const data = await resp.json();
      return Array.isArray(data) ? data[0] : data;
    } catch {
      return null;
    }
  }

  /**
   * Fetch schedule HTML page
   */
  @http({cacheSeconds: 21600}) // 6 hours
  async fetchScheduleHTML(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://www.phantasialand.de/en/theme-park/opening-hours/',
    } as any as HTTPObj;
  }

  /**
   * Parse calendar JSON from schedule HTML page (cached 6 hours)
   */
  @cache({ttlSeconds: 21600})
  async getCalendarJSON(): Promise<any[]> {
    const resp = await this.fetchScheduleHTML();
    const html = await resp.text();

    // Find data-calendar attribute
    const match = html.match(/data-calendar='(\[.*?\])'/s);
    if (!match) return [];

    // Clean HTML entities
    const jsonStr = decodeHtmlEntities(match[1]);

    try {
      return JSON.parse(jsonStr);
    } catch {
      console.warn('[Phantasialand] Failed to parse calendar JSON');
      return [];
    }
  }

  // ===== Data Builder Methods =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'phantasialanddest',
      name: {en: 'Phantasialand', de: 'Phantasialand'},
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 50.798995255201866, longitude: 6.879291227409914},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const pois = await this.getPOI();

    const destinationId = 'phantasialanddest';
    const parkId = 'phantasialand';

    const parkEntity: Entity = {
      id: parkId,
      name: {en: 'Phantasialand', de: 'Phantasialand'},
      entityType: 'PARK',
      parentId: destinationId,
      destinationId,
      timezone: this.timezone,
      location: {latitude: 50.798995255201866, longitude: 6.879291227409914},
    } as Entity;

    // Filter and map POIs
    const poiEntries: Array<{
      id: string;
      enName: string;
      deName: string;
      entityType: Entity['entityType'];
      lat?: number;
      lng?: number;
      apiTags: string[];
      minSize?: number;
      maxSize?: number;
    }> = [];

    for (const poi of pois) {
      // Skip admin-only entries
      if (poi.adminOnly) continue;

      // Skip entries without seasons
      if (!poi.seasons || !Array.isArray(poi.seasons) || poi.seasons.length === 0) continue;

      const category = poi.category;
      let entityType = categoryToEntityType[category];

      // For hotel restaurant category, only include if tagged as RESTAURANT
      if (category === 'PHANTASIALAND_HOTELS_RESTAURANTS') {
        if (!Array.isArray(poi.tags) || !poi.tags.includes('RESTAURANT')) continue;
      }

      if (!entityType) continue;

      // Build multi-language name. The API ships two shapes:
      //   - Legacy / full:   title = {en, de}
      //   - compact=true:    title is a bare string in the API's default
      //                      language (German) with a separate tagline
      // Accept either; fall back to the tagline/name fields if title's empty.
      const {en: enName, de: deName} = pickLocalisedName(
        poi.title ?? poi._title ?? poi.name,
      );
      if (!enName && !deName) continue;

      // Parse location
      let lat: number | undefined;
      let lng: number | undefined;
      const entrance = poi.entrance || poi._entrance;
      if (entrance?.world?.lat && entrance?.world?.lng) {
        lat = Number(entrance.world.lat);
        lng = Number(entrance.world.lng);
      }

      poiEntries.push({
        id: String(poi.id),
        enName: enName || deName,
        deName: deName || enName,
        entityType,
        lat,
        lng,
        apiTags: Array.isArray(poi.tags) ? poi.tags : [],
        minSize: poi.minSize,
        maxSize: poi.maxSize,
      });
    }

    const entities = this.mapEntities(poiEntries, {
      idField: 'id',
      nameField: (item) => ({en: item.enName, de: item.deName}),
      entityType: 'ATTRACTION', // overridden by transform
      parentIdField: () => parkId,
      destinationId,
      timezone: this.timezone,
      locationFields: {lat: 'lat', lng: 'lng'},
      transform: (entity, item) => {
        entity.entityType = item.entityType;
        const tags = [];
        // API tags
        if (item.apiTags.includes('ATTRACTION_TYPE_WATER')) tags.push(TagBuilder.mayGetWet());
        if (item.apiTags.includes('ATTRACTION_TYPE_SINGLE_RIDER_LINE')) tags.push(TagBuilder.singleRider());
        if (item.apiTags.includes('ATTRACTION_TYPE_PICTURES')) tags.push(TagBuilder.onRidePhoto());
        if (item.apiTags.includes('ATTRACTION_TYPE_QUICK_PASS') || item.apiTags.includes('ATTRACTION_TYPE_QUICK_PASS_PLUS')) {
          tags.push(TagBuilder.paidReturnTime());
        }
        // Height restrictions
        if (item.minSize) tags.push(TagBuilder.minimumHeight(item.minSize, 'cm'));
        if (item.maxSize) tags.push(TagBuilder.maximumHeight(item.maxSize, 'cm'));
        if (tags.length > 0) entity.tags = tags;
        return entity;
      },
    });

    return [parkEntity, ...entities];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const signage = await this.getSignage();
    const liveData: LiveData[] = [];

    for (const entry of signage) {
      if (!entry.poiId) continue;

      const entityId = String(entry.poiId);
      const ld: LiveData = {id: entityId, status: 'CLOSED'} as LiveData;

      if (entry.showTimes !== null && entry.showTimes !== undefined) {
        // Show entity
        if (Array.isArray(entry.showTimes) && entry.showTimes.length > 0) {
          ld.status = 'OPERATING' as any;
          ld.showtimes = entry.showTimes.map((time: string) => {
            // Show times are in "YYYY-MM-DD HH:mm:ss" format in Europe/Berlin
            return {
              startTime: this.formatShowTime(time),
              endTime: null,
              type: 'Showtime',
            };
          });
        } else {
          ld.status = 'CLOSED' as any;
        }
      } else if (entry.waitTime !== null && entry.waitTime !== undefined) {
        // Attraction with wait time
        ld.status = (entry.open ? 'OPERATING' : 'CLOSED') as any;
        if (entry.open) {
          ld.queue = {
            STANDBY: {waitTime: typeof entry.waitTime === 'number' ? entry.waitTime : null},
          };
        }
      } else if (entry.open !== null && entry.open !== undefined) {
        // Entity with just open/closed status
        ld.status = (entry.open ? 'OPERATING' : 'CLOSED') as any;
      }

      liveData.push(ld);
    }

    return liveData;
  }

  /**
   * Format a show time string ("YYYY-MM-DD HH:mm:ss") from Europe/Berlin
   * into an ISO 8601 string with correct timezone offset.
   */
  private formatShowTime(timeStr: string): string {
    // timeStr is "YYYY-MM-DD HH:mm:ss" in Europe/Berlin local time
    const dateStr = timeStr.substring(0, 10); // "YYYY-MM-DD"
    const timePart = timeStr.substring(11);   // "HH:mm:ss"
    return constructDateTime(dateStr, timePart, this.timezone);
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const [calendar, parkInfos] = await Promise.all([
      this.getCalendarJSON(),
      this.getParkInfos(),
    ]);
    const scheduleEntries: any[] = [];

    for (const event of calendar) {
      const title = event.title || '';

      // Skip "closed" entries
      if (title.toLowerCase().includes('closed')) continue;

      // Parse hours from title
      const hours = this.parseHours(title);
      if (!hours) continue;

      // Calendar may have days_selected array or a single date field
      const dates: string[] = [];
      if (event.days_selected && Array.isArray(event.days_selected)) {
        dates.push(...event.days_selected.filter(Boolean));
      } else if (event.date) {
        dates.push(event.date);
      }

      for (const dateStr of dates) {
        const openingTime = constructDateTime(dateStr, hours.open, this.timezone);
        const closingTime = constructDateTime(dateStr, hours.close, this.timezone);

        scheduleEntries.push({
          date: dateStr,
          type: 'OPERATING',
          openingTime,
          closingTime,
        });
      }
    }

    // Apply live override for today's closing time from park-infos API
    if (parkInfos?.close) {
      const today = formatDate(new Date(), this.timezone);
      const todayIdx = scheduleEntries.findIndex((e: any) => e.date === today);
      if (todayIdx >= 0) {
        // parkInfos.close is "YYYY-MM-DD HH:mm:ss" in local time
        const closeParts = parkInfos.close.split(' ');
        if (closeParts.length === 2 && closeParts[0] === today) {
          const liveClose = constructDateTime(today, closeParts[1], this.timezone);
          // Only override if live closing is after the calendar opening
          if (liveClose > scheduleEntries[todayIdx].openingTime) {
            scheduleEntries[todayIdx].closingTime = liveClose;
          }
        }
      }
    }

    return [{
      id: 'phantasialand',
      schedule: scheduleEntries,
    } as EntitySchedule];
  }

  /**
   * Parse opening hours from a title string.
   * Supports two formats:
   * - AM/PM: "09 a.m. until 06 p.m."
   * - 24h: "11:00 – 20:00" (or with regular dash)
   */
  private parseHours(title: string): {open: string; close: string} | null {
    // Try AM/PM format: "09 a.m. until 06 p.m."
    const ampmMatch = title.match(/(\d{1,2})\s*a\.m\.\s*until\s*(\d{1,2})\s*p\.m\./i);
    if (ampmMatch) {
      const openHour = parseInt(ampmMatch[1], 10);
      const closeHour = parseInt(ampmMatch[2], 10) + 12;
      return {
        open: String(openHour).padStart(2, '0') + ':00',
        close: String(closeHour).padStart(2, '0') + ':00',
      };
    }

    // Try AM/AM format: "09 a.m. until 11 a.m."
    const amamMatch = title.match(/(\d{1,2})\s*a\.m\.\s*until\s*(\d{1,2})\s*a\.m\./i);
    if (amamMatch) {
      const openHour = parseInt(amamMatch[1], 10);
      const closeHour = parseInt(amamMatch[2], 10);
      return {
        open: String(openHour).padStart(2, '0') + ':00',
        close: String(closeHour).padStart(2, '0') + ':00',
      };
    }

    // Try PM/PM format: "12 p.m. until 08 p.m."
    const pmpmMatch = title.match(/(\d{1,2})\s*p\.m\.\s*until\s*(\d{1,2})\s*p\.m\./i);
    if (pmpmMatch) {
      let openHour = parseInt(pmpmMatch[1], 10);
      let closeHour = parseInt(pmpmMatch[2], 10);
      if (openHour !== 12) openHour += 12;
      if (closeHour !== 12) closeHour += 12;
      return {
        open: String(openHour).padStart(2, '0') + ':00',
        close: String(closeHour).padStart(2, '0') + ':00',
      };
    }

    // Try 24h format: "11:00 – 20:00" (en-dash or regular dash)
    const h24Match = title.match(/(\d{1,2}:\d{2})\s*[–\-]\s*(\d{1,2}:\d{2})/);
    if (h24Match) {
      const openTime = h24Match[1].padStart(5, '0');
      const closeTime = h24Match[2].padStart(5, '0');
      return {open: openTime, close: closeTime};
    }

    return null;
  }
}
