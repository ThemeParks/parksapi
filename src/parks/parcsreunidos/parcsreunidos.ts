/**
 * Parcs Reunidos (StayApp) Theme Park Framework
 *
 * Provides support for 6 Parcs Reunidos parks using the Stay-App API.
 * Supports real-time wait times, entity data, and calendar schedules
 * parsed from HTML pages.
 *
 * @module parcsreunidos
 */

import {Destination, type DestinationConstructor} from '../../destination.js';
import config from '../../config.js';
import {http, type HTTPObj} from '../../http.js';
import {cache} from '../../cache.js';
import {inject} from '../../injector.js';
import {destinationController} from '../../destinationRegistry.js';
import type {Entity, LiveData, EntitySchedule} from '@themeparks/typelib';
import {formatInTimezone} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

// ============================================================================
// API Response Types
// ============================================================================

/** Park establishment info from the API */
type StayAppEstablishment = {
  data: {
    name: string;
    coordinates?: {
      latitude: number;
      longitude: number;
    };
  };
};

/** Single attraction from the attractions API */
type StayAppAttraction = {
  id: number;
  translatableName?: Record<string, string>;
  place?: {
    point?: {
      latitude: number;
      longitude: number;
    };
  };
  waitingTime?: number;
};

/** Attractions API response */
type StayAppAttractionsResponse = {
  data: StayAppAttraction[];
};

// ============================================================================
// Base Class
// ============================================================================

/**
 * Base class for Parcs Reunidos parks using the Stay-App API.
 *
 * NOT registered as a destination. Subclasses use @destinationController
 * to register individual parks.
 */
@config
class ParcsReunidosDestination extends Destination {
  /** Per-park app ID for establishment endpoint */
  @config
  appId: string = '';

  /** Shared auth token for API requests */
  @config
  authToken: string = '';

  /** Per-park establishment identifier for API header */
  @config
  stayEstablishment: string = '';

  /** Per-park calendar URL for schedule scraping */
  @config
  calendarUrl: string = '';

  /** Shared base URL for the Stay-App API */
  @config
  baseUrl: string = '';

  /** Park timezone */
  @config
  timezone: string = 'Europe/Berlin';

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('STAYAPP');
  }

  /**
   * Generate cache key prefix to prevent cache collisions between parks.
   * Each park has a unique appId.
   */
  getCacheKeyPrefix(): string {
    return `parcsreunidos:${this.appId}`;
  }

  // ============================================================================
  // Header Injection
  // ============================================================================

  /**
   * Inject Authorization and Stay-Establishment headers for API requests.
   * Uses dynamic hostname matching based on configured baseUrl.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function () {
      if (!this.baseUrl) return undefined;
      try {
        return new URL(this.baseUrl).hostname;
      } catch {
        return undefined;
      }
    },
  })
  async injectHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'Authorization': `Bearer ${this.authToken}`,
      'Stay-Establishment': this.stayEstablishment,
    };
  }

  // ============================================================================
  // HTTP Fetch Methods
  // ============================================================================

  /**
   * Fetch park establishment info (name, coordinates).
   * Cached for 12 hours at HTTP level.
   */
  @http({cacheSeconds: 43200})
  async fetchEstablishment(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/api/v1/establishment/${this.appId}`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch attractions list (entity data + live wait times).
   * Cached for 1 minute at HTTP level.
   */
  @http({cacheSeconds: 60})
  async fetchAttractions(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.baseUrl}/api/v1/service/attraction`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Fetch calendar HTML page for schedule scraping.
   * Cached for 24 hours at HTTP level.
   */
  @http({cacheSeconds: 86400})
  async fetchCalendarHTML(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: this.calendarUrl,
    } as any as HTTPObj;
  }

  // ============================================================================
  // Cached Getter Methods
  // ============================================================================

  /**
   * Get park establishment info (cached 12 hours).
   */
  @cache({ttlSeconds: 43200})
  async getEstablishment(): Promise<StayAppEstablishment['data']> {
    const resp = await this.fetchEstablishment();
    const data: StayAppEstablishment = await resp.json();
    return data?.data || {name: ''};
  }

  /**
   * Get attractions data (cached 1 minute).
   */
  @cache({ttlSeconds: 60})
  async getAttractions(): Promise<StayAppAttraction[]> {
    const resp = await this.fetchAttractions();
    const data: StayAppAttractionsResponse = await resp.json();
    return Array.isArray(data?.data) ? data.data : [];
  }

  // ============================================================================
  // Entity Building
  // ============================================================================

  async getDestinations(): Promise<Entity[]> {
    const establishment = await this.getEstablishment();
    const destinationId = `parquesreunidos_${this.appId}`;

    return [{
      id: destinationId,
      name: establishment.name || destinationId,
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: establishment.coordinates
        ? {latitude: establishment.coordinates.latitude, longitude: establishment.coordinates.longitude}
        : undefined,
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const establishment = await this.getEstablishment();
    const attractions = await this.getAttractions();

    const destinationId = `parquesreunidos_${this.appId}`;
    const parkId = `parquesreunidos_${this.appId}_park`;

    const parkEntity: Entity = {
      id: parkId,
      name: establishment.name || parkId,
      entityType: 'PARK',
      parentId: destinationId,
      destinationId,
      timezone: this.timezone,
      location: establishment.coordinates
        ? {latitude: establishment.coordinates.latitude, longitude: establishment.coordinates.longitude}
        : undefined,
    } as Entity;

    const attractionEntities = this.mapEntities(attractions, {
      idField: (item) => String(item.id),
      nameField: (item) => this.resolveAttractionName(item),
      entityType: 'ATTRACTION',
      parentIdField: () => parkId,
      destinationId,
      timezone: this.timezone,
      locationFields: {
        lat: (item: StayAppAttraction) => item.place?.point?.latitude,
        lng: (item: StayAppAttraction) => item.place?.point?.longitude,
      },
      transform: (entity, item) => {
        const lat = item.place?.point?.latitude;
        const lng = item.place?.point?.longitude;
        if (lat && lng) {
          entity.tags = [TagBuilder.location(lat, lng, typeof entity.name === 'string' ? entity.name : 'Attraction Location')];
        }
        return entity;
      },
    });

    return [parkEntity, ...attractionEntities];
  }

  /**
   * Resolve attraction name from translatableName.
   * Tries 'en' first, then falls back through common languages.
   */
  private resolveAttractionName(item: StayAppAttraction): string {
    const names = item.translatableName;
    if (!names || typeof names !== 'object') return `Attraction ${item.id}`;

    const fallbackOrder = ['en', 'nl', 'de', 'fr', 'es', 'it'];
    for (const lang of fallbackOrder) {
      if (names[lang]) return names[lang];
    }

    // Return any available name
    const values = Object.values(names);
    return values.length > 0 ? values[0] : `Attraction ${item.id}`;
  }

  // ============================================================================
  // Live Data
  // ============================================================================

  protected async buildLiveData(): Promise<LiveData[]> {
    const attractions = await this.getAttractions();
    const liveData: LiveData[] = [];

    for (const attraction of attractions) {
      const waitingTime = attraction.waitingTime;

      // Skip entities with no waitingTime data
      if (waitingTime === undefined || waitingTime === null) continue;

      const entityId = String(attraction.id);
      const ld: LiveData = {id: entityId, status: 'CLOSED'} as LiveData;

      if (waitingTime === -2) {
        // Down / broken
        ld.status = 'DOWN' as any;
      } else if (waitingTime === -3 || waitingTime < 0) {
        // Closed (including other negative values)
        ld.status = 'CLOSED' as any;
      } else {
        // Operating with standby queue
        ld.status = 'OPERATING' as any;
        ld.queue = {
          STANDBY: {waitTime: waitingTime},
        };
      }

      liveData.push(ld);
    }

    return liveData;
  }

  // ============================================================================
  // Schedules (HTML Calendar Parsing)
  // ============================================================================

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    // If no calendar URL is configured, return empty schedules
    if (!this.calendarUrl) {
      return [];
    }

    const scheduleEntries = await this.parseCalendar();
    const parkId = `parquesreunidos_${this.appId}_park`;

    return [{
      id: parkId,
      schedule: scheduleEntries,
    } as EntitySchedule];
  }

  /**
   * Parse calendar HTML to extract schedule entries.
   * Cached for 24 hours.
   */
  @cache({ttlSeconds: 86400})
  async parseCalendar(): Promise<Array<{date: string; type: string; openingTime: string; closingTime: string}>> {
    const resp = await this.fetchCalendarHTML();
    const html = await resp.text();

    // Extract labels JSON from hidden input
    // Handle both value='...' (single quotes) and value="..." (double quotes)
    const labelsMatch = html.match(/id="data-hour-labels"\s+value=["']([^"']*)["']/);
    if (!labelsMatch) return [];

    let labels: Array<Record<string, string>>;
    try {
      // Decode HTML entities (&#34; → ", &amp; → &, etc.) before JSON parsing
      const decoded = labelsMatch[1]
        .replace(/&#34;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
      labels = JSON.parse(decoded);
    } catch {
      console.warn(`[ParcsReunidos:${this.appId}] Failed to parse calendar labels JSON`);
      return [];
    }

    // Build label lookup: single letter key -> time range string
    const labelMap = new Map<string, string>();
    for (const labelObj of labels) {
      for (const [key, value] of Object.entries(labelObj)) {
        labelMap.set(key, value);
      }
    }

    // Extract year data from hidden inputs (handle both quote styles + HTML entities)
    const yearRegex = /id="data-hour-(\d{4})"\s+value=["']([^"']*)["']/g;
    const scheduleEntries: Array<{date: string; type: string; openingTime: string; closingTime: string}> = [];
    let yearMatch;

    while ((yearMatch = yearRegex.exec(html)) !== null) {
      const year = parseInt(yearMatch[1], 10);
      let monthsData: Array<Record<string, string>>;
      try {
        const decoded = yearMatch[2]
          .replace(/&#34;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"');
        monthsData = JSON.parse(decoded);
      } catch {
        console.warn(`[ParcsReunidos:${this.appId}] Failed to parse calendar year ${year} JSON`);
        continue;
      }

      // Process each month (0-indexed in the array)
      for (let monthIdx = 0; monthIdx < monthsData.length; monthIdx++) {
        const monthData = monthsData[monthIdx];
        if (!monthData || typeof monthData !== 'object') continue;

        const month = monthIdx + 1; // 1-indexed

        for (const [dayStr, labelKey] of Object.entries(monthData)) {
          const day = parseInt(dayStr, 10);
          if (isNaN(day) || day < 1 || day > 31) continue;

          const timeLabel = labelMap.get(labelKey);
          if (!timeLabel) continue;

          // Skip "closed" entries
          if (timeLabel.toLowerCase().includes('closed')) continue;

          const hours = this.parseTimeRange(timeLabel);
          if (!hours) continue;

          const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const offset = this.getTimezoneOffset(dateStr);

          scheduleEntries.push({
            date: dateStr,
            type: 'OPERATING',
            openingTime: `${dateStr}T${hours.open}:00${offset}`,
            closingTime: `${dateStr}T${hours.close}:00${offset}`,
          });
        }
      }
    }

    return scheduleEntries;
  }

  /**
   * Parse a time range string into open/close times.
   *
   * Supported formats:
   * 1. "10am - 5pm" (AM/PM)
   * 2. "10:30 - 17:00" (24h)
   * 3. "10 tot 5u" (Dutch)
   * 4. "11 a.m. – 7 p.m." (with dots and en-dash)
   */
  private parseTimeRange(label: string): {open: string; close: string} | null {
    // Format 4: "11 a.m. – 7 p.m." (dots in am/pm, en-dash or hyphen)
    const dotAmPmMatch = label.match(/(\d{1,2}(?::\d{2})?)\s*a\.m\.\s*[–\-]\s*(\d{1,2}(?::\d{2})?)\s*p\.m\./i);
    if (dotAmPmMatch) {
      const open = this.parseAmPmHour(dotAmPmMatch[1], 'am');
      const close = this.parseAmPmHour(dotAmPmMatch[2], 'pm');
      return {open, close};
    }

    // Format 1: "10am - 5pm" or "10:30am - 5:30pm"
    const amPmMatch = label.match(/(\d{1,2}(?::\d{2})?)\s*(am|pm)\s*[–\-]\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)/i);
    if (amPmMatch) {
      const open = this.parseAmPmHour(amPmMatch[1], amPmMatch[2]);
      const close = this.parseAmPmHour(amPmMatch[3], amPmMatch[4]);
      return {open, close};
    }

    // Format 3: "10 tot 5u" (Dutch format)
    const dutchMatch = label.match(/(\d{1,2}(?::\d{2})?)\s*(?:tot|t\/m)\s*(\d{1,2}(?::\d{2})?)u?/i);
    if (dutchMatch) {
      const open = this.normalize24hTime(dutchMatch[1]);
      const close = this.normalize24hTime(dutchMatch[2]);
      return {open, close};
    }

    // Format 2: "10:30 - 17:00" (24h format)
    const h24Match = label.match(/(\d{1,2}(?::\d{2})?)\s*[–\-]\s*(\d{1,2}(?::\d{2})?)/);
    if (h24Match) {
      const open = this.normalize24hTime(h24Match[1]);
      const close = this.normalize24hTime(h24Match[2]);
      return {open, close};
    }

    return null;
  }

  /**
   * Parse an AM/PM hour string to 24h HH:mm format.
   */
  private parseAmPmHour(timeStr: string, meridiem: string): string {
    const parts = timeStr.split(':');
    let hour = parseInt(parts[0], 10);
    const minutes = parts.length > 1 ? parts[1] : '00';

    const isPm = meridiem.toLowerCase().startsWith('p');
    if (isPm && hour !== 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;

    return `${String(hour).padStart(2, '0')}:${minutes}`;
  }

  /**
   * Normalize a time string (possibly without minutes) to HH:mm format.
   */
  private normalize24hTime(timeStr: string): string {
    if (timeStr.includes(':')) {
      const parts = timeStr.split(':');
      return `${parts[0].padStart(2, '0')}:${parts[1]}`;
    }
    return `${timeStr.padStart(2, '0')}:00`;
  }

  /**
   * Get the UTC offset string for a given date in the park's timezone.
   * Returns e.g. "+01:00" (CET winter) or "+02:00" (CEST summer).
   */
  private getTimezoneOffset(dateStr: string): string {
    const refDate = new Date(`${dateStr}T12:00:00Z`);
    const formatted = formatInTimezone(refDate, this.timezone, 'iso');
    const match = formatted.match(/([+-]\d{2}:\d{2})$/);
    return match ? match[1] : '+00:00';
  }
}

// ============================================================================
// Park Subclasses
// ============================================================================

/**
 * Movie Park Germany - Bottrop, Germany
 */
@destinationController({category: ['Parcs Reunidos', 'Movie Park Germany']})
export class MovieParkGermany extends ParcsReunidosDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.timezone = 'Europe/Berlin';
    this.addConfigPrefix('MOVIEPARKGERMANY');
  }
}

/**
 * Bobbejaanland - Lichtaart, Belgium
 */
@destinationController({category: ['Parcs Reunidos', 'Bobbejaanland']})
export class Bobbejaanland extends ParcsReunidosDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.timezone = 'Europe/Brussels';
    this.addConfigPrefix('BOBBEJAANLAND');
  }
}

/**
 * Mirabilandia - Ravenna, Italy
 */
@destinationController({category: ['Parcs Reunidos', 'Mirabilandia']})
export class Mirabilandia extends ParcsReunidosDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.timezone = 'Europe/Rome';
    this.addConfigPrefix('MIRABILANDIA');
  }
}

/**
 * Parque de Atracciones Madrid - Madrid, Spain
 */
@destinationController({category: ['Parcs Reunidos', 'Parque de Atracciones Madrid']})
export class ParqueDeAtraccionesMadrid extends ParcsReunidosDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.timezone = 'Europe/Madrid';
    this.addConfigPrefix('PARQUEDEATRACCIONESMADRID');
  }
}

/**
 * Parque Warner Madrid - Madrid, Spain
 */
@destinationController({category: ['Parcs Reunidos', 'Parque Warner Madrid']})
export class ParqueWarnerMadrid extends ParcsReunidosDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.timezone = 'Europe/Madrid';
    this.addConfigPrefix('PARQUEWARNERMADRID');
  }
}

/**
 * Kennywood - West Mifflin, Pennsylvania, USA
 */
@destinationController({category: ['Parcs Reunidos', 'Kennywood']})
export class Kennywood extends ParcsReunidosDestination {
  constructor(options?: DestinationConstructor) {
    super(options);
    this.timezone = 'America/New_York';
    this.addConfigPrefix('KENNYWOOD');
  }
}

export {ParcsReunidosDestination};
