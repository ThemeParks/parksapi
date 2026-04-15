import {Destination, DestinationConstructor} from '../../destination.js';
import crypto from 'crypto';

import {cache} from '../../cache.js';
import {http, HTTPObj} from '../../http.js';
import {inject} from '../../injector.js';
import config from '../../config.js';
import {destinationController} from '../../destinationRegistry.js';
import {
  Entity,
  LiveData,
  EntitySchedule,
  LanguageCode,
} from '@themeparks/typelib';
import {formatUTC, parseTimeInTimezone, formatInTimezone, addDays, isBefore, constructDateTime} from '../../datetime.js';
import {TagBuilder} from '../../tags/index.js';

@destinationController({ category: 'Efteling' })
export class Efteling extends Destination {
  @config
  apiKey: string = '';

  @config
  apiVersion: string = '9';

  @config
  appVersion: string = 'v5.18.0';

  @config
  timezone: string = 'Europe/Amsterdam';

  @config
  language: LanguageCode = 'nl';

  deviceId: string;

  /** Maps single rider alternate IDs to parent entity IDs (populated during entity building) */
  private singleRiderMap: Map<string, string> = new Map();

  constructor(options?: DestinationConstructor) {
    super(options);
    this.addConfigPrefix('EFTELING');
    this.deviceId = crypto.randomUUID();
  }

  /**
   * Inject headers into all HTTP requests for api.efteling.com
   */
  @inject({
    eventName: 'httpRequest',
    hostname: 'api.efteling.com',
  })
  async injectApiHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'x-api-key': this.apiKey,
      'x-api-version': this.apiVersion,
      'x-app-version': this.appVersion,
      'x-app-name': 'Efteling',
      'x-app-id': 'nl.efteling.android',
      'x-app-platform': 'Android',
      'x-app-language': requestObj.headers?.['x-app-language'] || 'en',
      'x-app-timezone': 'Europe/Amsterdam',
      'x-app-deviceid': this.deviceId,
      'user-agent': 'okhttp/5.1.0',
    };
  }

  /**
   * Inject headers into all HTTP requests for www.efteling.com
   */
  @inject({
    eventName: 'httpRequest',
    hostname: 'www.efteling.com',
  })
  async injectCalendarHeaders(requestObj: HTTPObj): Promise<void> {
    requestObj.headers = {
      ...requestObj.headers,
      'X-Requested-With': 'XMLHttpRequest',
      'referer': 'https://www.efteling.com/en/park/opening-hours?app=true',
      'cookie': 'website#lang=en',
    };
  }

  // ===== HTTP Fetch Methods =====

  /**
   * Fetch POI data with English language header
   */
  @http({ cacheSeconds: 43200 })
  async fetchPOIEnglish(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://api.efteling.com/app/poi',
      headers: { 'x-app-language': 'en' },
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Fetch POI data with Dutch language header
   */
  @http({ cacheSeconds: 43200 })
  async fetchPOIDutch(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://api.efteling.com/app/poi',
      headers: { 'x-app-language': 'nl' },
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get POI data (cached), returns array of POI hits
   */
  @cache({ ttlSeconds: 43200 })
  async getPOIData(language: string): Promise<any[]> {
    const resp = language === 'nl' ? await this.fetchPOIDutch() : await this.fetchPOIEnglish();
    const data = await resp.json();
    return data?.hits?.hit || [];
  }

  /**
   * Fetch wait time data from WIS endpoint
   */
  @http({ cacheSeconds: 60 })
  async fetchWaitTimes(): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: 'https://api.efteling.com/app/wis',
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get wait times (cached)
   */
  @cache({ ttlSeconds: 60 })
  async getWaitTimes(): Promise<any[]> {
    const resp = await this.fetchWaitTimes();
    const data = await resp.json();
    return data?.AttractionInfo || [];
  }

  /**
   * Fetch calendar/opening hours data
   */
  @http({ cacheSeconds: 43200, healthCheckArgs: ['{year}', '{month}'] })
  async fetchCalendar(year: number, month: number): Promise<HTTPObj> {
    return {
      method: 'GET',
      url: `https://www.efteling.com/service/cached/getpoiinfo/en/${year}/${month}`,
      options: { json: true },
    } as any as HTTPObj;
  }

  /**
   * Get calendar data (cached), returns opening hours array
   */
  @cache({ ttlSeconds: 43200 })
  async getCalendar(year: number, month: number): Promise<any[]> {
    try {
      const resp = await this.fetchCalendar(year, month);
      const data = await resp.json();
      return data?.OpeningHours || [];
    } catch {
      // Returns 400 for past months
      return [];
    }
  }

  // ===== Data Builder Methods =====

  async getDestinations(): Promise<Entity[]> {
    return [{
      id: 'eftelingresort',
      name: { en: 'Efteling', nl: 'Efteling' },
      entityType: 'DESTINATION',
      timezone: 'Europe/Amsterdam',
      location: { latitude: 51.649515, longitude: 5.043776 },
    } as Entity];
  }

  protected async buildEntityList(): Promise<Entity[]> {
    const enHits = await this.getPOIData('en');
    const nlHits = await this.getPOIData('nl');

    // Index both by fields.id
    const enMap = new Map<string, any>();
    for (const hit of enHits) {
      if (hit.fields?.id) enMap.set(hit.fields.id, hit.fields);
    }
    const nlMap = new Map<string, any>();
    for (const hit of nlHits) {
      if (hit.fields?.id) nlMap.set(hit.fields.id, hit.fields);
    }

    // Merge: English primary, Dutch fills gaps
    const merged: Array<{ id: string; en: any; nl: any }> = [];
    const allIds = new Set([...enMap.keys(), ...nlMap.keys()]);
    for (const id of allIds) {
      const en = enMap.get(id);
      const nl = nlMap.get(id);
      const primary = en || nl;
      if (!primary) continue;
      merged.push({ id, en: en || nl, nl: nl || en });
    }

    // Clear single rider map (rebuilt each time)
    this.singleRiderMap.clear();

    // Collect entities to build
    const poiEntries: any[] = [];

    for (const { id, en, nl } of merged) {
      const category = en.category;

      // Only include attractions, shows, and restaurants
      if (category !== 'attraction' && category !== 'show' && category !== 'restaurant') continue;

      // Skip hidden entries
      if (en.hide_in_app) continue;

      // Store single rider mapping
      if (en.alternatetype === 'singlerider' && en.alternateid) {
        this.singleRiderMap.set(en.alternateid, id);
      }

      // Parse location
      let lat: number | undefined;
      let lng: number | undefined;
      if (en.latlon && en.latlon !== '0.0,0.0') {
        const [latStr, lngStr] = en.latlon.split(',');
        lat = parseFloat(latStr);
        lng = parseFloat(lngStr);
      }

      // Build multi-language name with overrides
      let enName = en.name || '';
      let nlName = nl.name || enName;
      if (id === 'stoomtreinr') { enName += ' - Oost'; nlName += ' - Oost'; }
      if (id === 'stoomtreinm') { enName += ' - Marerijk'; nlName += ' - Marerijk'; }

      poiEntries.push({
        id,
        enName,
        nlName,
        category,
        lat,
        lng,
        properties: en.properties || [],
        hasAlternateSingleRider: en.alternatetype === 'singlerider',
      });
    }

    const destinationId = 'eftelingresort';
    const parkId = 'efteling';

    const parkEntity: Entity = {
      id: parkId,
      name: { en: 'Efteling', nl: 'Efteling' },
      entityType: 'PARK',
      parentId: destinationId,
      destinationId,
      timezone: 'Europe/Amsterdam',
      location: { latitude: 51.649515, longitude: 5.043776 },
    } as Entity;

    const attractions = this.mapEntities(
      poiEntries.filter(e => e.category === 'attraction'),
      {
        idField: 'id',
        nameField: (item) => ({ en: item.enName, nl: item.nlName }),
        entityType: 'ATTRACTION',
        parentIdField: () => parkId,
        destinationId,
        timezone: 'Europe/Amsterdam',
        locationFields: { lat: 'lat', lng: 'lng' },
        transform: (entity, item) => {
          entity.tags = this.buildTags(item);
          return entity;
        },
      }
    );

    const shows = this.mapEntities(
      poiEntries.filter(e => e.category === 'show'),
      {
        idField: 'id',
        nameField: (item) => ({ en: item.enName, nl: item.nlName }),
        entityType: 'SHOW',
        parentIdField: () => parkId,
        destinationId,
        timezone: 'Europe/Amsterdam',
        locationFields: { lat: 'lat', lng: 'lng' },
        transform: (entity, item) => {
          entity.tags = this.buildTags(item);
          return entity;
        },
      }
    );

    const restaurants = this.mapEntities(
      poiEntries.filter(e => e.category === 'restaurant' && e.lat && e.lng),
      {
        idField: 'id',
        nameField: (item) => ({ en: item.enName, nl: item.nlName }),
        entityType: 'RESTAURANT',
        parentIdField: () => parkId,
        destinationId,
        timezone: 'Europe/Amsterdam',
        locationFields: { lat: 'lat', lng: 'lng' },
      }
    );

    return [parkEntity, ...attractions, ...shows, ...restaurants];
  }

  /**
   * Build tags for an entity from its POI properties
   */
  private buildTags(item: any): any[] {
    const tags: any[] = [];

    // Height restrictions from properties
    for (const prop of item.properties) {
      const heightMatch = prop.match(/^minimum(\d+)$/);
      if (heightMatch) {
        tags.push(TagBuilder.minimumHeight(parseInt(heightMatch[1], 10), 'cm'));
      }
    }

    // Other property tags
    if (item.properties.includes('wet')) tags.push(TagBuilder.mayGetWet());
    if (item.properties.includes('pregnantwomen')) tags.push(TagBuilder.unsuitableForPregnantPeople());
    if (item.properties.includes('babyswitch')) tags.push(TagBuilder.childSwap());

    // Single rider
    if (item.hasAlternateSingleRider) tags.push(TagBuilder.singleRider());

    return tags.filter(Boolean);
  }

  /**
   * Map Efteling WIS state strings to standard status values
   */
  private mapState(state: string): string {
    switch (state?.toLowerCase()) {
      case 'open': return 'OPERATING';
      case 'storing':
      case 'tijdelijkbuitenbedrijf': return 'DOWN';
      case 'inonderhoud': return 'REFURBISHMENT';
      case 'buitenbedrijf': return 'CLOSED';
      case 'gesloten':
      case '':
      case 'wachtrijgesloten':
      case 'nognietopen': return 'CLOSED';
      default:
        console.warn(`[Efteling] Unknown state: ${state}`);
        return 'CLOSED';
    }
  }

  /**
   * Build single rider alternate ID mapping from POI data.
   * Rebuilds from cached POI data so buildLiveData() is independent of buildEntityList().
   */
  private buildSingleRiderMap(poiHits: any[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const hit of poiHits) {
      const fields = hit.fields;
      if (fields?.alternatetype === 'singlerider' && fields?.alternateid) {
        map.set(fields.alternateid, fields.id);
      }
    }
    return map;
  }

  protected async buildLiveData(): Promise<LiveData[]> {
    const liveData: LiveData[] = [];
    const liveDataMap = new Map<string, LiveData>();

    const getOrCreate = (id: string): LiveData => {
      let entry = liveDataMap.get(id);
      if (!entry) {
        entry = { id, status: 'CLOSED' } as LiveData;
        liveDataMap.set(id, entry);
        liveData.push(entry);
      }
      return entry;
    };

    // Get POI data for entity ID lookup + single rider mapping
    const poiHits = await this.getPOIData('en');
    const validPoiTypes = new Set(['attraction', 'show', 'restaurant']);
    const poiData = new Map<string, {type: string; hasLocation: boolean}>();
    for (const hit of poiHits) {
      if (hit.fields?.id) {
        poiData.set(hit.fields.id, {
          type: hit.fields.category || '',
          hasLocation: !!(hit.fields.latlon && hit.fields.latlon !== '0.0,0.0'),
        });
      }
    }

    const singleRiderMap = this.buildSingleRiderMap(poiHits);
    const waitTimes = await this.getWaitTimes();

    // First pass: collect single rider data
    // WIS returns separate entries for single rider queues using the alternate ID
    const singleRiderData = new Map<string, number | null>();
    for (const entry of waitTimes) {
      if (!entry.Id) continue;
      // If this ID is NOT a known POI but IS a single rider alternate ID
      if (!poiData.has(entry.Id) && singleRiderMap.has(entry.Id)) {
        const parentId = singleRiderMap.get(entry.Id)!;
        const waitTime = entry.WaitingTime !== undefined ? parseInt(String(entry.WaitingTime), 10) : null;
        singleRiderData.set(parentId, isNaN(waitTime as number) ? null : waitTime);
      }
    }

    // Second pass: build live data for known entities
    for (const entry of waitTimes) {
      if (!entry.Id) continue;

      // Droomvlucht special case: droomvluchtstandby maps to droomvlucht
      let entityId = entry.Id;
      if (entityId === 'droomvluchtstandby') {
        entityId = 'droomvlucht';
      }

      // Skip entries without POI data or location (except droomvluchtstandby)
      if (entry.Id !== 'droomvluchtstandby') {
        const poi = poiData.get(entityId);
        if (!poi?.hasLocation) continue;
        if (!validPoiTypes.has(poi.type)) continue;
      }

      const type = entry.Type;

      if (type === 'Attraction' || type === 'Attracties') {
        const ld = getOrCreate(entityId);
        const status = this.mapState(entry.State);
        ld.status = status as any;

        // Always include standby queue for attractions
        if (!ld.queue) ld.queue = {};
        const waitTime = entry.WaitingTime !== undefined ? parseInt(String(entry.WaitingTime), 10) : NaN;
        ld.queue.STANDBY = {
          waitTime: (status === 'OPERATING' && !isNaN(waitTime)) ? waitTime : undefined,
        };

        // Single rider queue with actual wait time
        if (singleRiderData.has(entityId)) {
          const srTime = singleRiderData.get(entityId)!;
          ld.queue.SINGLE_RIDER = {
            waitTime: (status === 'OPERATING' && srTime !== null && srTime !== undefined) ? srTime : null,
          };
        }

        // Virtual queue
        if (entry.VirtualQueue) {
          const vqState = entry.VirtualQueue.State?.toLowerCase();
          if (vqState === 'enabled' && entry.VirtualQueue.WaitingTime !== undefined) {
            const window = this.calculateReturnWindow(entry.VirtualQueue.WaitingTime, { windowMinutes: 15 });
            ld.queue.RETURN_TIME = this.buildReturnTimeQueue('AVAILABLE', window.start, window.end);
          } else if (vqState === 'full') {
            ld.queue.RETURN_TIME = this.buildReturnTimeQueue('FINISHED', null, null);
          } else if (vqState === 'walkin') {
            ld.queue.RETURN_TIME = this.buildReturnTimeQueue('TEMP_FULL', null, null);
          }
        }
      } else if (type === 'Shows en Entertainment') {
        const ld = getOrCreate(entityId);

        // Combine upcoming and past show times
        const allShowTimes = [...(entry.ShowTimes || []), ...(entry.PastShowTimes || [])];
        ld.status = (allShowTimes.length > 0 ? 'OPERATING' : 'CLOSED') as any;

        if (allShowTimes.length > 0) {
          ld.showtimes = allShowTimes.map((time: any) => ({
            startTime: time.StartDateTime,
            endTime: time.EndDateTime || null,
            type: time.Edition || 'Showtime',
          }));
        }
      } else if (type === 'Eten en Drinken') {
        const ld = getOrCreate(entityId);
        const state = entry.State?.toLowerCase();
        ld.status = (state === 'open' ? 'OPERATING' : 'CLOSED') as any;

        if (entry.OpeningTimes && entry.OpeningTimes.length > 0) {
          (ld as any).operatinghours = entry.OpeningTimes.map((ot: any) => ({
            startTime: ot.HourFrom,
            endTime: ot.HourTo,
            type: 'OPERATING',
          }));
        }
      }
    }

    return liveData;
  }

  protected async buildSchedules(): Promise<EntitySchedule[]> {
    const now = new Date();
    const scheduleEntries: any[] = [];

    // Fetch 4 months of calendar data (current + 3 forward)
    for (let i = 0; i < 4; i++) {
      const date = addDays(now, i * 30); // rough month offset
      const year = date.getFullYear();
      const month = date.getMonth() + 1; // 1-indexed

      const days = await this.getCalendar(year, month);

      for (const day of days) {
        if (!day.Date || !day.OpeningHours || !Array.isArray(day.OpeningHours)) continue;

        // Sort opening hours by Open time
        const hours = [...day.OpeningHours].sort((a: any, b: any) =>
          (a.Open || '').localeCompare(b.Open || '')
        );

        for (let j = 0; j < hours.length; j++) {
          const h = hours[j];
          if (!h.Open || !h.Close) continue;

          // Build ISO datetime strings with correct Amsterdam offset
          // day.Date is "YYYY-MM-DD", h.Open/h.Close are "HH:mm"
          const openingTime = constructDateTime(day.Date, h.Open, this.timezone);
          const closingTime = constructDateTime(day.Date, h.Close, this.timezone);

          scheduleEntries.push({
            date: day.Date,
            type: j === 0 ? 'OPERATING' : 'INFO',
            description: j === 0 ? undefined : 'Evening Hours',
            openingTime,
            closingTime,
          });
        }
      }
    }

    return [{
      id: 'efteling',
      schedule: scheduleEntries,
    } as EntitySchedule];
  }
}
