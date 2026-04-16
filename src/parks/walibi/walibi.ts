/**
 * Walibi / Bellewaerde / Compagnie des Alpes parks
 *
 * 4 parks sharing the same API pattern: each park has its own domain,
 * API shortcode, and API key. Entity IDs are slugified from names
 * (attr_xxx, dining_xxx) since the API provides no stable IDs.
 *
 * Wait times are in seconds (divided by 60 for minutes).
 */

import {Destination, DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {constructDateTime, hostnameFromUrl} from '../../datetime.js';
import {createStatusMap} from '../../statusMap.js';

const mapStatus = createStatusMap({
  OPERATING: ['open', 'Open'],
  CLOSED: ['closed', 'Closed', 'closed_indefinitely', 'temporary_closed', 'full_and_closed', 'custom', 'unknown_status', 'not_operational'],
  DOWN: ['full', 'Full', 'Down'],
  REFURBISHMENT: ['maintenance', 'Maintenance'],
}, {parkName: 'Walibi', defaultStatus: 'OPERATING'});

/** Statuses that should be excluded from live data entirely */
const SKIP_STATUSES = new Set(['not_operational']);

// ── Types ──────────────────────────────────────────────────────

interface AttractionPOI {
  title: string;
  latitude?: number;
  longitude?: number;
  waitingTimeName?: string;
  path?: string;
}

interface WaitTimeEntry {
  id: string;
  status: string;
  time?: number | string;
}

// ── Base class ─────────────────────────────────────────────────

@config
class WalibiBase extends Destination {
  @config apiKey: string = '';
  @config baseURL: string = '';

  /** API shortcode (e.g., 'who', 'blw', 'wra', 'wbe') */
  apiShortcode: string = '';
  /** Culture/language code for API requests */
  culture: string = 'en';
  /** Destination-level entity ID */
  destinationSlug: string = '';
  /** Park-level entity ID */
  parkSlug: string = '';
  /** Park display name */
  parkName: string = '';
  /** Park coordinates */
  parkLat: number = 0;
  parkLng: number = 0;

  constructor(options?: DestinationConstructor) {
    super(options);
  }

  getCacheKeyPrefix(): string {
    return `walibi:${this.destinationSlug}`;
  }

  /** Extract the last path segment from a CMS path as a stable slug */
  private pathSlug(path: string | undefined): string | null {
    if (!path) return null;
    return path.split('/').pop() || null;
  }

  // ── Header injection ─────────────────────────────────────────

  @inject({
    eventName: 'httpRequest',
    hostname: function (this: WalibiBase) { return hostnameFromUrl(this.baseURL); },
  })
  async injectHeaders(req: HTTPObj): Promise<void> {
    req.headers = {
      ...req.headers,
      'x-api-key': this.apiKey,
    };
  }

  // ── HTTP Methods ─────────────────────────────────────────────

  @http({cacheSeconds: 86400})
  async fetchAttractions(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}api/${this.apiShortcode}/${this.culture}/attractions.v1.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 86400})
  async fetchRestaurants(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}api/${this.apiShortcode}/${this.culture}/restaurants.v1.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 60})
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}api/${this.apiShortcode}/waitingtimes.v1.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  @http({cacheSeconds: 86400})
  async fetchCalendar(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseURL}api/${this.apiShortcode}/nl/openinghours.v1.json`,
      options: {json: true},
    } as any as HTTPObj;
  }

  // ── Cached Data ──────────────────────────────────────────────

  @cache({ttlSeconds: 86400})
  async getAttractions(): Promise<AttractionPOI[]> {
    const resp = await this.fetchAttractions();
    return await resp.json() || [];
  }

  @cache({ttlSeconds: 86400})
  async getRestaurants(): Promise<AttractionPOI[]> {
    const resp = await this.fetchRestaurants();
    return await resp.json() || [];
  }

  @cache({ttlSeconds: 60})
  async getWaitTimes(): Promise<WaitTimeEntry[]> {
    const resp = await this.fetchWaitTimes();
    return await resp.json() || [];
  }

  // ── Entity Building ──────────────────────────────────────────

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: this.destinationSlug,
      name: this.parkName,
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: this.parkLat, longitude: this.parkLng},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const [attractions, restaurants] = await Promise.all([
      this.getAttractions(),
      this.getRestaurants(),
    ]);

    const parkEntity: Entity = {
      id: this.parkSlug,
      name: this.parkName,
      entityType: 'PARK',
      parentId: this.destinationSlug,
      destinationId: this.destinationSlug,
      timezone: this.timezone,
      location: {latitude: this.parkLat, longitude: this.parkLng},
    } as Entity;

    // Attractions use waitingTimeName (UUID) as entity ID
    const attrEntities = attractions
      .filter(a => a.waitingTimeName)
      .map(a => {
        const entity: Entity = {
          id: a.waitingTimeName!,
          name: a.title,
          entityType: 'ATTRACTION',
          parentId: this.parkSlug,
          destinationId: this.destinationSlug,
          timezone: this.timezone,
        } as Entity;
        if (a.latitude && a.longitude) {
          (entity as any).location = {
            latitude: Number(a.latitude),
            longitude: Number(a.longitude),
          };
        }
        return entity;
      });

    // Restaurants use CMS path slug as entity ID (no UUID available)
    const diningEntities = restaurants
      .filter(r => this.pathSlug(r.path))
      .map(r => {
        const entity: Entity = {
          id: `dining_${this.pathSlug(r.path)}`,
          name: r.title,
          entityType: 'RESTAURANT',
          parentId: this.parkSlug,
          destinationId: this.destinationSlug,
          timezone: this.timezone,
        } as Entity;
        if (r.latitude && r.longitude) {
          (entity as any).location = {
            latitude: Number(r.latitude),
            longitude: Number(r.longitude),
          };
        }
        return entity;
      });

    return [parkEntity, ...attrEntities, ...diningEntities];
  }

  // ── Live Data ────────────────────────────────────────────────

  protected async buildLiveData(): Promise<LiveData[]> {
    const [attractions, waitTimes] = await Promise.all([
      this.getAttractions(),
      this.getWaitTimes(),
    ]);

    return waitTimes
      .map(entry => {
        // Match wait time entry to attraction via waitingTimeName
        const attraction = attractions.find(a => a.waitingTimeName === entry.id);
        if (!attraction) return null;

        if (SKIP_STATUSES.has(entry.status)) return null;
        const status = mapStatus(entry.status);

        const ld: LiveData = {
          id: entry.id, // UUID from waitingTimeName — matches entity ID directly
          status,
        } as LiveData;

        if (status === 'OPERATING' && entry.time !== undefined) {
          const seconds = Number(entry.time || 0);
          ld.queue = {
            STANDBY: {waitTime: seconds > 0 ? Math.floor(seconds / 60) : 0},
          };
        }

        return ld;
      })
      .filter((x): x is LiveData => x !== null);
  }

  // ── Schedules ────────────────────────────────────────────────

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    let calData: any;
    try {
      const resp = await this.fetchCalendar();
      calData = await resp.json();
    } catch {
      return [];
    }

    if (!calData?.calendar) return [];

    const schedule: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];

    for (const year of Object.keys(calData.calendar)) {
      const yearData = calData.calendar[year];
      if (!yearData?.months) continue;

      for (const monthKey of Object.keys(yearData.months)) {
        const month = yearData.months[monthKey];
        const monthNum = month.monthNumber;
        if (!month.days) continue;

        for (const dayKey of Object.keys(month.days)) {
          const day = month.days[dayKey];
          if (day.closed || day.soldOut) continue;
          if (!day.openingHour || !day.closingHour) continue;

          const dateStr = `${year}-${String(monthNum).padStart(2, '0')}-${String(dayKey).padStart(2, '0')}`;

          schedule.push({
            date: dateStr,
            type: 'OPERATING',
            openingTime: constructDateTime(dateStr, day.openingHour, this.timezone),
            closingTime: constructDateTime(dateStr, day.closingHour, this.timezone),
          });
        }
      }
    }

    return [{id: this.parkSlug, schedule} as EntitySchedule];
  }
}

// ── Park subclasses ────────────────────────────────────────────

@destinationController({category: ['Compagnie des Alpes', 'Walibi']})
export class WalibiHolland extends WalibiBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('WALIBIHOLLAND');
    this.baseURL = this.baseURL || 'https://www.walibi.nl/';
    this.apiShortcode = 'who';
    this.culture = 'en';
    this.destinationSlug = 'walibiholland';
    this.parkSlug = 'walibihollandpark';
    this.parkName = 'Walibi Holland';
    this.timezone = 'Europe/Amsterdam';
    this.parkLat = 52.44014;
    this.parkLng = 5.76749;
  }
}

@destinationController({category: ['Compagnie des Alpes', 'Bellewaerde']})
export class Bellewaerde extends WalibiBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('BELLEWAERDE');
    this.baseURL = this.baseURL || 'https://www.bellewaerde.be/';
    this.apiShortcode = 'blw';
    this.culture = 'nl';
    this.destinationSlug = 'bellewaerde';
    this.parkSlug = 'bellewaerdepark';
    this.parkName = 'Bellewaerde';
    this.timezone = 'Europe/Brussels';
    this.parkLat = 50.84647412354691;
    this.parkLng = 2.9502020602188184;
  }
}

@destinationController({category: ['Compagnie des Alpes', 'Walibi']})
export class WalibiRhoneAlpes extends WalibiBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('WALIBIRHONEALPES');
    this.baseURL = this.baseURL || 'https://www.walibi.fr/';
    this.apiShortcode = 'wra';
    this.culture = 'fr';
    this.destinationSlug = 'walibirhonealpes';
    this.parkSlug = 'walibirhonealpespark';
    this.parkName = 'Walibi Rhône-Alpes';
    this.timezone = 'Europe/Paris';
    this.parkLat = 45.620003;
    this.parkLng = 5.568677;
  }
}

@destinationController({category: ['Compagnie des Alpes', 'Walibi']})
export class WalibiBelgium extends WalibiBase {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('WALIBIBELGIUM');
    this.baseURL = this.baseURL || 'https://www.walibi.be/';
    this.apiShortcode = 'wbe';
    this.culture = 'nl';
    this.destinationSlug = 'walibibelgium';
    this.parkSlug = 'walibibelgiumpark';
    this.parkName = 'Walibi Belgium';
    this.timezone = 'Europe/Brussels';
    this.parkLat = 50.701895;
    this.parkLng = 4.5914887;
  }
}
