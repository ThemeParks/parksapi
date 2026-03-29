import {Destination, DestinationConstructor} from '../../destination.js';
import {readFileSync} from 'fs';
import {join} from 'path';

import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {
  Entity,
  LiveData,
  EntitySchedule,
} from '@themeparks/typelib';
import {formatInTimezone, constructDateTime} from '../../datetime.js';

@destinationController({category: 'PortAventura'})
export class PortAventuraWorld extends Destination {
  @config
  apiBase: string = '';

  @config
  waitTimeUrl: string = '';

  @config
  guestPassword: string = '';

  @config
  timezone: string = 'Europe/Madrid';

  /** Directory containing client SSL certificates (private.pem + cert.pem) */
  @config
  certDir: string = '';

  /** Cached cert contents (loaded once from disk) */
  private _certKey: string | undefined;
  private _certPem: string | undefined;

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('PORTAVENTURAWORLD');
  }

  /**
   * Load client SSL certificates from certDir.
   * Reads private.pem and cert.pem once, caches in memory.
   */
  private loadCerts(): { key: string; cert: string } | undefined {
    if (this._certKey && this._certPem) {
      return { key: this._certKey, cert: this._certPem };
    }
    if (!this.certDir) return undefined;
    try {
      this._certKey = readFileSync(join(this.certDir, 'private.pem'), 'utf8');
      this._certPem = readFileSync(join(this.certDir, 'cert.pem'), 'utf8');
      return { key: this._certKey, cert: this._certPem };
    } catch {
      return undefined;
    }
  }

  // ===== Hostname Helpers =====

  /**
   * Get hostname from apiBase config for use in @inject filters.
   */
  private getApiHostname(): string | undefined {
    if (!this.apiBase) return undefined;
    try { return new URL(this.apiBase).hostname; } catch { return undefined; }
  }

  /**
   * Get hostname from waitTimeUrl config for use in @inject filters.
   */
  private getWaitTimeHostname(): string | undefined {
    if (!this.waitTimeUrl) return undefined;
    try { return new URL(this.waitTimeUrl).hostname; } catch { return undefined; }
  }

  // ===== Header Injection =====

  /**
   * Inject headers into CMS API requests.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function() { return this.getApiHostname(); },
  })
  async injectCmsHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'User-Agent': 'okhttp/4.9.2',
      'X-App-Environment': 'production',
      'X-App-Platform': 'android',
      'X-App-Version': '4.17.0',
    };
    // Inject client SSL certificates for mutual TLS
    const certs = this.loadCerts();
    if (certs) {
      if (!requestObj.options) requestObj.options = {};
      requestObj.options.key = certs.key;
      requestObj.options.cert = certs.cert;
    }
  }

  /**
   * Inject headers into wait time API requests.
   */
  @inject({
    eventName: 'httpRequest',
    hostname: function() { return this.getWaitTimeHostname(); },
  })
  async injectWaitTimeHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'User-Agent': 'okhttp/4.9.2',
    };
    // Inject client SSL certificates for mutual TLS
    const certs = this.loadCerts();
    if (certs) {
      if (!requestObj.options) requestObj.options = {};
      requestObj.options.key = certs.key;
      requestObj.options.cert = certs.cert;
    }
  }

  // ===== HTTP Fetch Methods =====

  /**
   * Fetch parks from CMS API.
   */
  @http({cacheSeconds: 86400}) // 24h
  async fetchParks(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/parks?locale=en&populate[fields][0]=*&populate[rides][fields][0]=*&pagination[start]=0&pagination[limit]=10000`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get parks data (cached 24h).
   */
  @cache({ttlSeconds: 86400})
  async getParks(): Promise<any[]> {
    const resp = await this.fetchParks();
    const data = await resp.json();
    return data?.data || [];
  }

  /**
   * Fetch attractions from CMS API.
   */
  @http({cacheSeconds: 86400}) // 24h
  async fetchAttractions(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `${this.apiBase}/api/attractions?locale=en&populate[fields][0]=*&populate[park][fields][0]=*&pagination[start]=0&pagination[limit]=10000`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get attractions data (cached 24h).
   */
  @cache({ttlSeconds: 86400})
  async getAttractions(): Promise<any[]> {
    const resp = await this.fetchAttractions();
    const data = await resp.json();
    return data?.data || [];
  }

  /**
   * Fetch schedules from CMS API.
   */
  @http({cacheSeconds: 86400}) // 24h
  async fetchSchedules(): Promise<HTTPObj> {
    const today = formatInTimezone(new Date(), this.timezone, 'iso').substring(0, 10);
    return {
      method: 'GET',
      url: `${this.apiBase}/api/schedule-parks?filters[date][$gte]=${today}&populate[fields][0]=*&populate[park][fields][0]=*&pagination[start]=0&pagination[limit]=10000`,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get schedule data (cached 24h).
   */
  @cache({ttlSeconds: 86400})
  async getScheduleData(): Promise<any[]> {
    const resp = await this.fetchSchedules();
    const data = await resp.json();
    return data?.data || [];
  }

  /**
   * Fetch wait times from live API.
   */
  @http({cacheSeconds: 300}) // 5 minutes
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: this.waitTimeUrl,
      options: {json: true},
    } as any as HTTPObj;
  }

  /**
   * Get wait time data (cached 5 minutes).
   * Deduplicates entries by id, preferring entries with non-null queue.
   */
  @cache({ttlSeconds: 300})
  async getWaitTimes(): Promise<Map<string, any>> {
    const resp = await this.fetchWaitTimes();
    const data = await resp.json();
    if (!Array.isArray(data)) return new Map();

    // Deduplicate: group by id, prefer first entry with queue !== null
    const byId = new Map<string, any>();
    for (const entry of data) {
      if (!entry.id) continue;
      const existing = byId.get(entry.id);
      if (!existing) {
        byId.set(entry.id, entry);
      } else if (existing.queue === null && entry.queue !== null) {
        byId.set(entry.id, entry);
      }
    }
    return byId;
  }

  // ===== Data Builder Methods =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'portaventuraworld',
      name: 'PortAventura World',
      entityType: 'DESTINATION',
      timezone: this.timezone,
      location: {latitude: 41.0986786, longitude: 1.151773},
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const parks = await this.getParks();
    const attractions = await this.getAttractions();

    const destinationId = 'portaventuraworld';
    const entities: Entity[] = [];

    // Build park entities
    for (const park of parks) {
      const attrs = park.attributes || park;
      entities.push({
        id: `park_${park.id}`,
        name: attrs.name || `Park ${park.id}`,
        entityType: 'PARK',
        parentId: destinationId,
        destinationId,
        timezone: this.timezone,
        location: {latitude: 41.0986786, longitude: 1.151773},
      } as Entity);
    }

    // Build attraction entities
    const attractionEntries = attractions.filter((a: any) => {
      const attrs = a.attributes || a;
      return attrs.park?.data?.id != null;
    });

    const mappedAttractions = this.mapEntities(attractionEntries, {
      idField: (item: any) => item.id,
      nameField: (item: any) => {
        const attrs = item.attributes || item;
        return attrs.name || `Attraction ${item.id}`;
      },
      entityType: 'ATTRACTION',
      parentIdField: (item: any) => {
        const attrs = item.attributes || item;
        return `park_${attrs.park.data.id}`;
      },
      destinationId,
      timezone: this.timezone,
      locationFields: {
        lat: (item: any) => {
          const attrs = item.attributes || item;
          return attrs.latitude ? parseFloat(attrs.latitude) : undefined;
        },
        lng: (item: any) => {
          const attrs = item.attributes || item;
          return attrs.longitude ? parseFloat(attrs.longitude) : undefined;
        },
      },
    });

    return [...entities, ...mappedAttractions];
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const waitTimes = await this.getWaitTimes();
    const attractions = await this.getAttractions();

    // Build FTPName -> entity numeric ID mapping
    const ftpToEntityId = new Map<string, string>();
    for (const attraction of attractions) {
      const attrs = attraction.attributes || attraction;
      if (attrs.FTPName) {
        ftpToEntityId.set(attrs.FTPName, String(attraction.id));
      }
    }

    const liveData: LiveData[] = [];

    for (const [ftpName, entry] of waitTimes) {
      const entityId = ftpToEntityId.get(ftpName);
      if (!entityId) continue;

      const isClosed = entry.queue === null || entry.closed === true;
      const status = isClosed ? 'CLOSED' : 'OPERATING';

      const ld: LiveData = {id: entityId, status} as LiveData;

      if (status === 'OPERATING' && entry.queue != null) {
        ld.queue = {
          STANDBY: {waitTime: entry.queue},
        };
      }

      liveData.push(ld);
    }

    return liveData;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const scheduleData = await this.getScheduleData();

    // Group schedule entries by park ID
    const byPark = new Map<string, any[]>();
    for (const entry of scheduleData) {
      const attrs = entry.attributes || entry;
      const parkId = attrs.park?.data?.id;
      if (!parkId) continue;

      const parkKey = `park_${parkId}`;
      if (!byPark.has(parkKey)) {
        byPark.set(parkKey, []);
      }
      byPark.get(parkKey)!.push(attrs);
    }

    const schedules: EntitySchedule[] = [];

    for (const [parkKey, entries] of byPark) {
      const scheduleEntries: any[] = [];

      for (const entry of entries) {
        const date = entry.date;
        const openingTime = entry.openingTime;
        const closingTime = entry.closingTime;

        if (!date || !openingTime || !closingTime) continue;

        // Skip invalid times
        if (openingTime === '00:00:00' || closingTime === '00:00:00') continue;
        if (openingTime === closingTime) continue;

        scheduleEntries.push({
          date,
          type: 'OPERATING',
          openingTime: constructDateTime(date, openingTime, this.timezone),
          closingTime: constructDateTime(date, closingTime, this.timezone),
        });
      }

      schedules.push({
        id: parkKey,
        schedule: scheduleEntries,
      } as EntitySchedule);
    }

    return schedules;
  }
}
